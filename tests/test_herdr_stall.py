"""Unit tests for herdr prompt-stall recovery (no network, no herdr).

Run from the repo root:  python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import itertools
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pi_wave import orchestrator  # noqa: E402
from pi_wave.herdr_backend import (  # noqa: E402
    HerdrBackend, HerdrBlocked, HerdrPromptStalled,
)
from pi_wave.plan import load_plan  # noqa: E402


def make_herdr_plan(tmp: str, kind: str = "pi"):
    """One-wave plan with a single display=herdr assignment, no review."""
    proj = Path(tmp) / "proj"
    proj.mkdir(exist_ok=True)
    f = Path(tmp) / "plan.json"
    f.write_text(json.dumps({
        "name": "t",
        "cwd": str(proj),
        "waves": [[{
            "name": "probe",
            "prompt": "do it",
            "model": "claude-sonnet-5" if kind == "omp" else "kimi-coding/k3",
            "kind": kind,
            "files": [],
            "display": "herdr",
        }]],
    }), encoding="utf-8")
    return load_plan(f)


class FakeHerdrBackend:
    """Stands in for HerdrBackend in _run_assignment_herdr.

    prompt_calls: per-attempt outcome for prompt() — an exception instance
    to raise (e.g. HerdrPromptStalled) or None for success; attempts past
    the list succeed. late_start: what wait_late_start reports (None =
    agent never woke → resend path; a status string = late wake)."""

    def __init__(self, prompt_calls=None, late_start=None, pane_settled=False):
        self._prompt_calls = list(prompt_calls or [])
        self._late_start = late_start
        self._pane_settled = pane_settled
        self.prompts_sent = 0

    async def split_pane(self, ratio: float = 0.5) -> str:
        return "w1:pF"

    async def start_agent(self, name, pane_id, model, provider, thinking,
                          mcp_config: str = "", kind: str = "pi"):
        return ["fake", "--model", model]

    async def prompt(self, name, text, timeout_s: float) -> None:
        self.prompts_sent += 1
        if self._prompt_calls:
            outcome = self._prompt_calls.pop(0)
            if isinstance(outcome, BaseException):
                raise outcome

    async def read(self, name, lines: int = 240) -> str:
        return "all done"

    async def wait_late_start(self, name, watch_s: float = 10.0,
                              poll_s: float = 0.5):
        return self._late_start

    async def wait_settled(self, name, timeout_s: float,
                           poll_s: float = 0.5) -> None:
        return None

    async def wait_pane_settled(self, name, baseline, timeout_s: float,
                                poll_s: float = 1.0, stable_polls: int = 2) -> bool:
        return self._pane_settled


async def _nosleep(_s):
    return None


def run_with(fake: FakeHerdrBackend, tmp: str, kind: str = "pi") -> list[dict]:
    plan = make_herdr_plan(tmp, kind=kind)
    events: list[dict] = []
    with mock.patch.object(orchestrator, "herdr_available", lambda: None), \
         mock.patch.object(orchestrator, "HerdrBackend", lambda cwd: fake), \
         mock.patch("asyncio.sleep", _nosleep):
        asyncio.run(orchestrator._run_assignment_herdr(
            plan.waves[0][0], 0, plan, {}, events.append, None))
    return events


class TestStallMapping(unittest.TestCase):
    def _backend_with(self, rc: int, payload: str) -> HerdrBackend:
        b = HerdrBackend(cwd="/tmp")

        async def fake_run(args, timeout=60.0):
            return rc, payload, ""
        b._run = fake_run  # instance-level override
        return b

    def test_stalled_code_raises_prompt_stalled(self):
        b = self._backend_with(1, json.dumps(
            {"error": {"code": "agent_prompt_stalled", "message": "no change"}}))
        with self.assertRaises(HerdrPromptStalled) as cm:
            asyncio.run(b._run_json(["agent", "prompt", "x", "--wait"]))
        self.assertIn("no change", str(cm.exception))
        self.assertIsInstance(cm.exception, TimeoutError)

    def test_timeout_code_raises_plain_timeout(self):
        b = self._backend_with(1, json.dumps(
            {"error": {"code": "timeout", "message": "too slow"}}))
        with self.assertRaises(TimeoutError) as cm:
            asyncio.run(b._run_json(["agent", "prompt", "x", "--wait"]))
        self.assertNotIsInstance(cm.exception, HerdrPromptStalled)


class TestBackendWaits(unittest.TestCase):
    def _backend_with_states(self, statuses) -> HerdrBackend:
        b = HerdrBackend(cwd="/tmp")
        it = iter(statuses)

        async def fake_state(name):
            return {"result": {"agent": {"status": next(it)}}}
        b.state = fake_state
        return b

    def test_wait_late_start_returns_first_non_idle(self):
        b = self._backend_with_states(["idle", "idle", "working"])
        status = asyncio.run(b.wait_late_start("x", watch_s=5, poll_s=0))
        self.assertEqual(status, "working")

    def test_wait_late_start_returns_none_when_idle_throughout(self):
        b = HerdrBackend(cwd="/tmp")

        async def always_idle(name):
            return {"result": {"agent": {"status": "idle"}}}
        b.state = always_idle
        status = asyncio.run(b.wait_late_start("x", watch_s=0.05, poll_s=0))
        self.assertIsNone(status)

    def test_wait_settled_returns_on_idle(self):
        b = self._backend_with_states(["working", "working", "idle"])
        asyncio.run(b.wait_settled("x", timeout_s=5, poll_s=0))

    def test_wait_settled_raises_blocked(self):
        b = self._backend_with_states(["blocked"])
        with self.assertRaises(HerdrBlocked):
            asyncio.run(b.wait_settled("x", timeout_s=5, poll_s=0))

    def test_wait_late_start_reads_real_herdr_agent_status_shape(self):
        # herdr 0.8.2's `agent get` response, captured live: the key is
        # 'agent_status', and there is no 'status' key anywhere in it. A
        # lookup for bare 'status' always misses this shape and reports
        # 'unknown', making every wait see the agent as perpetually idle.
        b = self._backend_with_states(["irrelevant"])

        async def fake_state(name):
            return {"result": {"agent": {
                "agent": "omp", "agent_status": "working",
                "name": name, "pane_id": "w1:p1Q",
            }}}
        b.state = fake_state
        status = asyncio.run(b.wait_late_start("x", watch_s=5, poll_s=0))
        self.assertEqual(status, "working")

    def test_agent_status_key_preferred_over_status(self):
        b = HerdrBackend(cwd="/tmp")
        self.assertEqual(
            b._agent_status({"result": {"agent": {
                "agent_status": "working", "status": "idle"}}}),
            "working")


class TestPaneSettled(unittest.TestCase):
    def test_already_changed_and_stable_before_first_poll(self):
        # the common real case: by the time status-based recovery gives
        # up (two attempts x up to 60s each), the agent has often long
        # since finished and gone quiet — the pane must already differ
        # from the pre-send baseline and be stable, with no further
        # waiting needed.
        b = HerdrBackend(cwd="/tmp")

        async def fake_read(name, lines: int = 240):
            return "prompt + PI-WAVE-OMP-OK + idle prompt"
        b.read = fake_read
        settled = asyncio.run(b.wait_pane_settled(
            "x", baseline="empty pane", timeout_s=5, poll_s=0))
        self.assertTrue(settled)

    def test_never_differs_from_baseline_returns_false(self):
        b = HerdrBackend(cwd="/tmp")

        async def fake_read(name, lines: int = 240):
            return "same as baseline"
        b.read = fake_read
        settled = asyncio.run(b.wait_pane_settled(
            "x", baseline="same as baseline", timeout_s=0.05, poll_s=0))
        self.assertFalse(settled)

    def test_still_changing_returns_false_until_timeout(self):
        b = HerdrBackend(cwd="/tmp")
        counter = itertools.count()

        async def fake_read(name, lines: int = 240):
            return f"typing {next(counter)}"  # never repeats → never stable
        b.read = fake_read
        settled = asyncio.run(b.wait_pane_settled(
            "x", baseline="empty pane", timeout_s=0.05, poll_s=0))
        self.assertFalse(settled)


class TestOrchestratorRecovery(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def test_stall_then_resend_passes(self):
        fake = FakeHerdrBackend(
            prompt_calls=[HerdrPromptStalled("stalled")],
            late_start=None)  # agent never woke → resend once
        events = run_with(fake, self.tmp)
        types = [e["type"] for e in events]
        self.assertIn("prompt_stall_recovery", types)
        done = [e for e in events if e["type"] == "agent_done"][0]
        self.assertEqual(done["status"], "pass")
        self.assertEqual(fake.prompts_sent, 2)

    def test_stall_then_late_start_no_resend(self):
        fake = FakeHerdrBackend(
            prompt_calls=[HerdrPromptStalled("stalled")],
            late_start="working")  # original submission kicked in late
        events = run_with(fake, self.tmp)
        done = [e for e in events if e["type"] == "agent_done"][0]
        self.assertEqual(done["status"], "pass")
        self.assertEqual(fake.prompts_sent, 1)

    def test_double_stall_times_out_honestly(self):
        fake = FakeHerdrBackend(
            prompt_calls=[HerdrPromptStalled("stalled"),
                          HerdrPromptStalled("stalled")],
            late_start=None)  # never woke, even for the resend
        events = run_with(fake, self.tmp)
        done = [e for e in events if e["type"] == "agent_done"][0]
        self.assertEqual(done["status"], "timeout")
        self.assertEqual(fake.prompts_sent, 2)
        recoveries = [e for e in events if e["type"] == "prompt_stall_recovery"]
        self.assertEqual(len(recoveries), 2)

    def test_pane_settled_fallback_saves_a_false_timeout(self):
        fake = FakeHerdrBackend(
            prompt_calls=[HerdrPromptStalled("stalled"),
                          HerdrPromptStalled("stalled")],
            late_start=None,      # herdr's status field never confirms a wake
            pane_settled=True)    # ...but the pane itself shows it worked
        events = run_with(fake, self.tmp)
        done = [e for e in events if e["type"] == "agent_done"][0]
        self.assertEqual(done["status"], "pass")
        self.assertIn("prompt_stall_pane_check", [e["type"] for e in events])

    def test_omp_skips_resend_and_goes_straight_to_pane_check(self):
        # kind=omp never reports a non-idle agent_status at all (confirmed
        # live), so a second blind attempt would just re-submit the same
        # prompt to an agent already working or already done.
        fake = FakeHerdrBackend(
            prompt_calls=[HerdrPromptStalled("stalled")],
            late_start=None,
            pane_settled=True)
        events = run_with(fake, self.tmp, kind="omp")
        done = [e for e in events if e["type"] == "agent_done"][0]
        self.assertEqual(done["status"], "pass")
        self.assertEqual(fake.prompts_sent, 1)  # no resend
        recoveries = [e for e in events if e["type"] == "prompt_stall_recovery"]
        self.assertEqual(len(recoveries), 1)
        self.assertIn("prompt_stall_pane_check", [e["type"] for e in events])

    def test_omp_genuinely_idle_times_out_after_one_attempt(self):
        fake = FakeHerdrBackend(
            prompt_calls=[HerdrPromptStalled("stalled")],
            late_start=None,
            pane_settled=False)
        events = run_with(fake, self.tmp, kind="omp")
        done = [e for e in events if e["type"] == "agent_done"][0]
        self.assertEqual(done["status"], "timeout")
        self.assertEqual(fake.prompts_sent, 1)

    def test_omp_gets_longer_watch(self):
        fake = FakeHerdrBackend(
            prompt_calls=[HerdrPromptStalled("stalled")],
            late_start="working")
        events = run_with(fake, self.tmp)
        # plan's assignment is kind pi → 10s watch; emit records it
        recovery = [e for e in events if e["type"] == "prompt_stall_recovery"][0]
        self.assertEqual(recovery["watch_s"], 10.0)


def make_wave_plan(tmp: str, n: int, display: str):
    proj = Path(tmp) / "proj"
    proj.mkdir(exist_ok=True)
    f = Path(tmp) / "plan.json"
    f.write_text(json.dumps({
        "name": "guard",
        "cwd": str(proj),
        "waves": [[{
            "name": f"agent-{i}",
            "prompt": "p",
            "model": "kimi-coding/k3",
            "files": [],
            "display": display,
        } for i in range(n)]],
    }), encoding="utf-8")
    return load_plan(f)


async def _fake_run_assignment(a, wave_idx, plan, results, emit, orch=None):
    from pi_wave.orchestrator import AgentResult
    return AgentResult(name=a.name, wave=wave_idx + 1, model=a.model,
                       status="pass", rounds=1)


class TestWaveGuard(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def _orchestrate(self, plan):
        from pi_wave.orchestrator import orchestrate
        events: list[dict] = []
        asyncio.run(orchestrate(plan, events.append))
        return events

    def test_three_herdr_agents_stops_before_dispatch(self):
        plan = make_wave_plan(self.tmp, 3, display="herdr")
        with mock.patch.dict(os.environ, {"HERDR_ENV": "1"}, clear=False), \
             mock.patch.object(orchestrator, "run_assignment",
                               _fake_run_assignment):
            events = self._orchestrate(plan)
        # fail fast: the wave never started, so nothing was spawned
        types = [e["type"] for e in events]
        self.assertNotIn("wave_start", types)
        stopped = [e for e in events if e["type"] == "stopped"][0]
        self.assertIn("2 agents per wave", stopped["reason"])
        summary = [e for e in events if e["type"] == "summary"][0]
        self.assertEqual(summary["status"], "stopped")

    def test_two_herdr_agents_dispatch(self):
        plan = make_wave_plan(self.tmp, 2, display="herdr")
        with mock.patch.dict(os.environ, {"HERDR_ENV": "1"}, clear=False), \
             mock.patch.object(orchestrator, "run_assignment",
                               _fake_run_assignment):
            events = self._orchestrate(plan)
        types = [e["type"] for e in events]
        self.assertIn("wave_start", types)
        summary = [e for e in events if e["type"] == "summary"][0]
        self.assertEqual(summary["status"], "completed")

    def test_headless_wave_has_no_cap(self):
        plan = make_wave_plan(self.tmp, 4, display="auto")  # resolves headless
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(orchestrator, "run_assignment",
                               _fake_run_assignment):
            events = self._orchestrate(plan)
        summary = [e for e in events if e["type"] == "summary"][0]
        self.assertEqual(summary["status"], "completed")


if __name__ == "__main__":
    unittest.main()
