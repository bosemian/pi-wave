"""Unit tests for the progress notifier (no network, no pi, no osascript).

Run from the repo root:  python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pi_wave.notify import ChatPusher, Notifier  # noqa: E402
from pi_wave.plan import load_plan  # noqa: E402


class FakeMac:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def notify(self, title, subtitle, body, sound=False):
        self.calls.append((title, subtitle, body, sound))

    def close(self, timeout: float = 5.0) -> None:
        pass


class FakeChat:
    def __init__(self) -> None:
        self.messages: list[str] = []
        self.calls: list[tuple[str, str | None]] = []
        self.urls: list[tuple[str, str | None]] = []

    def push(self, text: str, app: str | None = None,
             url: str | None = None) -> None:
        self.messages.append(text)
        self.calls.append((text, app))
        self.urls.append((text, url))

    def close(self, timeout: float = 10.0) -> None:
        pass


def make_plan(tmp: str) -> object:
    proj = Path(tmp) / "proj"
    proj.mkdir(exist_ok=True)
    plan_file = Path(tmp) / "plan.json"
    plan_file.write_text(json.dumps({
        "name": "t",
        "cwd": str(proj),
        "waves": [[
            {"name": "research", "prompt": "p", "model": "kimi-coding/k3",
             "files": [], "done_when": "notes written"},
            {"name": "qa", "prompt": "p", "model": "kimi-coding/k3",
             "files": ["src/a.py"], "review_cmd": "pytest -q"},
        ]],
    }), encoding="utf-8")
    return load_plan(plan_file)


EVENTS = [
    {"type": "plan_start", "plan": "t", "cwd": "/tmp/proj", "waves": 1, "agents": 2},
    {"type": "wave_start", "wave": 1, "agents": ["research", "qa"]},
    {"type": "agent_start", "agent": "research", "wave": 1,
     "model": "kimi-coding/k3", "display": "headless"},
    {"type": "agent_start", "agent": "qa", "wave": 1,
     "model": "kimi-coding/k3", "display": "headless"},
    {"type": "progress", "agent": "research", "turn": 1},
    {"type": "agent_done", "agent": "research", "status": "pass", "rounds": 1,
     "text": "Explored options.\nCreated research.py with SERVICE_DESIGN and tradeoffs()."},
    {"type": "review_failed", "agent": "qa", "round": 1,
     "review_output_tail": "2 tests failed:\n- test_a\n- test_b"},
    {"type": "progress", "agent": "qa", "turn": 2},
    {"type": "agent_done", "agent": "qa", "status": "pass", "rounds": 2,
     "text": "Fixed the failing checks.\nAll 4 qa checks pass now."},
    {"type": "wave_done", "wave": 1, "passed": True},
    {"type": "summary", "plan": "t", "cwd": "/tmp/proj", "status": "completed",
     "waves": [{"wave": 1, "agents": [
         {"name": "research", "wave": 1, "model": "kimi-coding/k3",
          "status": "pass", "rounds": 1, "text": "did research",
          "display": "headless", "tokens": {"total": 1234}, "cost": 0.05},
         {"name": "qa", "wave": 1, "model": "kimi-coding/k3",
          "status": "pass", "rounds": 2, "text": "qa ok",
          "display": "headless", "tokens": {"total": 999}, "cost": 0.02},
     ]}],
     "synthesis": "All agents passed; notes under docs/."},
]


class TestNotifier(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.plan = make_plan(self.tmp)
        self.run_dir = Path(self.tmp) / "progress" / "t-20260914-100000"
        self.mac = FakeMac()
        self.notifier = Notifier(self.plan, self.run_dir, self.mac)

    def feed(self, events):
        for ev in events:
            self.notifier.handle(ev)
        return self.run_dir.joinpath("dashboard.md").read_text(encoding="utf-8")

    def test_dashboard_full_run(self):
        md = self.feed(EVENTS)
        self.assertIn("# pi-wave · t", md)
        self.assertIn("| 1 | research | kimi-coding/k3 | ✅ pass | 1 |", md)
        self.assertIn("| 1 | qa | kimi-coding/k3 | ✅ pass | 2 |", md)
        self.assertIn("**completed**", md)
        self.assertIn("## Synthesis", md)
        self.assertIn("All agents passed; notes under docs/.", md)
        # role notes carry the plan metadata and summary stats
        self.assertIn("done: notes written", md)
        self.assertIn("`src/a.py`", md)
        self.assertIn("1234 tokens", md)
        # review feedback from the fix round is kept, escaped and truncated
        self.assertIn("review r1:", md)
        self.assertIn("- test_a - test_b", md)
        self.assertIn("## Recent events", md)

    def test_dashboard_working_turn(self):
        md = self.feed(EVENTS[:5])  # up to first progress event
        self.assertIn("🔄 working · turn 1", md)
        self.assertIn("🔄 working", md)  # qa has no turn yet
        self.assertIn("wave 1/1", md)

    def test_events_jsonl_records_every_event(self):
        self.feed(EVENTS)
        lines = (self.run_dir / "events.jsonl").read_text(
            encoding="utf-8").strip().splitlines()
        self.assertEqual(len(lines), len(EVENTS))
        parsed = [json.loads(line) for line in lines]
        self.assertEqual(parsed[-1]["type"], "summary")
        self.assertEqual(parsed[4]["type"], "progress")

    def test_notifications_for_key_events(self):
        self.feed(EVENTS)
        subs = {c[1]: c for c in self.mac.calls}
        self.assertIn("research", subs)
        self.assertEqual(subs["research"][2], "✅ passed · 1 round(s)")
        self.assertFalse(subs["research"][3])
        self.assertIn("qa", subs)
        qa_bodies = [c[2] for c in self.mac.calls if c[1] == "qa"]
        self.assertTrue(any("failed review" in b for b in qa_bodies))
        self.assertIn("wave 1", subs)
        self.assertEqual(subs["wave 1"][2], "✅ all agents passed")
        self.assertIn("run finished", subs)
        self.assertIn("completed · 2/2 agents passed", subs["run finished"][2])
        self.assertTrue(subs["run finished"][3])  # final ping has sound

    def test_failure_notification_has_sound(self):
        self.feed([
            EVENTS[0], EVENTS[1], EVENTS[2],
            {"type": "agent_done", "agent": "research", "status": "fail",
             "rounds": 3},
        ])
        fail = [c for c in self.mac.calls if c[1] == "research"][0]
        self.assertIn("failed after 3 rounds", fail[2])
        self.assertTrue(fail[3])

    def test_latest_symlink_points_at_run_dir(self):
        self.feed(EVENTS[:1])
        latest = self.run_dir.parent / "latest"
        self.assertTrue(latest.is_symlink())
        self.assertEqual(latest.resolve(), self.run_dir.resolve())

    def test_create_reads_env(self):
        env = {"PI_WAVE_PROGRESS_DIR": str(Path(self.tmp) / "env-progress"),
               "PI_WAVE_NOTIFY": "off"}
        with mock.patch.dict(os.environ, env, clear=False):
            n = Notifier.create(self.plan)
            try:
                self.assertIsNotNone(n)
                self.assertIn(str(Path(self.tmp) / "env-progress"),
                              str(n.dashboard_path))
            finally:
                if n is not None:
                    n.close()
        with mock.patch.dict(os.environ, {"PI_WAVE_PROGRESS": "off"}, clear=False):
            self.assertIsNone(Notifier.create(self.plan))

    def test_agent_done_without_start_still_gets_a_row(self):
        # kind=omp headless fails validation: agent_done with no agent_start
        md = self.feed([
            EVENTS[0], EVENTS[1],
            {"type": "agent_done", "agent": "research", "status": "error",
             "rounds": 0},
            {"type": "wave_done", "wave": 1, "passed": False},
            {"type": "summary", "plan": "t", "cwd": "/tmp/proj",
             "status": "stopped",
             "waves": [{"wave": 1, "agents": [
                 {"name": "research", "wave": 1, "model": "kimi-coding/k3",
                  "status": "error", "rounds": 0, "text": "",
                  "error": "kind=omp requires display=herdr",
                  "display": "headless", "tokens": {}, "cost": 0},
             ]}]},
        ])
        self.assertIn("| 1 | research | kimi-coding/k3 | 💥 error | 0 |", md)
        self.assertIn("kind=omp requires display=herdr", md)
        self.assertIn("**stopped** · 0/1 passed", md)

    def test_handle_never_raises_when_dir_deleted(self):
        import shutil
        self.feed(EVENTS[:2])
        shutil.rmtree(self.run_dir.parent)
        self.notifier.handle(EVENTS[2])  # must not raise
        self.notifier.close()


class TestChatPush(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.plan = make_plan(self.tmp)

    def test_default_events_pushed(self):
        chat = FakeChat()
        n = Notifier(self.plan, Path(self.tmp) / "run", None, chat=chat)
        for ev in EVENTS:
            n.handle(ev)
        n.close()
        texts = "\n--\n".join(chat.messages)
        self.assertIn("🚀 pi-wave t started — 1 waves · 2 roles", texts)
        self.assertIn("🔁 qa failed review — fix round 1", texts)
        self.assertIn("research — ✅ passed · 1 round(s) · wave 1", texts)
        # the role digest carries the work summary (agent's last line)
        self.assertIn("Created research.py with SERVICE_DESIGN and tradeoffs().", texts)
        self.assertIn("qa — ✅ passed · 2 round(s) · wave 1", texts)
        self.assertIn("🏁 wave 1/1 — all passed", texts)
        summary = [m for m in chat.messages if m.startswith("📋")][0]
        self.assertIn("completed — 2/2 roles passed", summary)
        self.assertIn("✅ research · 1 round(s)", summary)
        self.assertIn("synthesis: All agents passed", summary)

    def test_per_role_digests_go_to_role_bot(self):
        chat = FakeChat()
        n = Notifier(self.plan, Path(self.tmp) / "run", None, chat=chat)
        for ev in EVENTS:
            n.handle(ev)
        n.close()
        # per-role events (agent_done, review_failed) → a bot named per role
        self.assertEqual({app for _, app in chat.calls if app is not None},
                         {"research", "qa"})
        research = [t for t, a in chat.calls if a == "research"]
        self.assertTrue(any("Created research.py" in t for t in research))
        self.assertTrue(any("failed review" in t
                            for t, a in chat.calls if a == "qa"))
        # run-level digests stay on the default app (app=None here)
        run_level = [t for t, a in chat.calls if a is None]
        self.assertTrue(any(t.startswith("🚀") for t in run_level))
        self.assertTrue(any(t.startswith("📋") for t in run_level))

    def test_role_app_template(self):
        chat = FakeChat()
        n = Notifier(self.plan, Path(self.tmp) / "run", None, chat=chat,
                     role_app_tmpl="Grok · {role}")
        n.handle(EVENTS[5])  # research agent_done
        n.close()
        self.assertIn("Grok · research", [a for _, a in chat.calls])

    def test_role_url_routes_to_per_chat(self):
        chat = FakeChat()
        n = Notifier(self.plan, Path(self.tmp) / "run", None, chat=chat,
                     role_url_tmpl="grok://chat/{role}")
        for ev in EVENTS:
            n.handle(ev)
        n.close()
        # per-role digests open the role's own chat URL, not an app name
        self.assertEqual({url for _, url in chat.urls if url is not None},
                         {"grok://chat/research", "grok://chat/qa"})
        research_urls = [t for t, u in chat.urls if u == "grok://chat/research"]
        self.assertTrue(any("Created research.py" in t for t in research_urls))
        # app-name routing is bypassed for per-role pushes
        self.assertEqual([a for _, a in chat.calls if a is not None], [])
        # run-level digests still carry neither app nor url
        run_level = [t for t, u in chat.urls if u is None]
        self.assertTrue(any(t.startswith("🚀") for t in run_level))

    def test_event_filter_limits_pushes(self):
        chat = FakeChat()
        n = Notifier(self.plan, Path(self.tmp) / "run", None, chat=chat,
                     chat_events={"summary"})
        for ev in EVENTS:
            n.handle(ev)
        n.close()
        self.assertEqual(len(chat.messages), 1)
        self.assertTrue(chat.messages[0].startswith("📋"))

    def test_script_escapes_and_joins_lines(self):
        p = ChatPusher(app='Weird "App"', send_key="cmd+return", delay=1.5)
        script = p._script('line1 "q"\nline2\\x')
        self.assertIn('set the clipboard to "line1 \\"q\\"" & return & "line2\\\\x"',
                      script)
        self.assertIn('tell application "Weird \\"App\\"" to activate', script)
        self.assertIn("delay 1.5", script)
        self.assertIn("keystroke return with command down", script)
        p.close()

    def test_script_opens_url_when_given(self):
        p = ChatPusher()
        script = p._script("hi", url="grok://chat/frontend")
        self.assertIn(
            'do shell script "open " & quoted form of "grok://chat/frontend"',
            script)
        self.assertNotIn("to activate", script)
        p.close()

    def test_create_enables_chat_from_env(self):
        env = {"PI_WAVE_PROGRESS_DIR": str(Path(self.tmp) / "p"),
               "PI_WAVE_NOTIFY": "off",
               "PI_WAVE_CHAT_PUSH": "on",
               "PI_WAVE_CHAT_APP": "TestApp"}
        with mock.patch.dict(os.environ, env, clear=False):
            n = Notifier.create(self.plan)
            try:
                self.assertIsNotNone(n)
                self.assertIsInstance(n._chat, ChatPusher)
                self.assertEqual(n._chat._app, "TestApp")
                self.assertEqual(n._role_app_tmpl, "{role}")
                self.assertEqual(n._role_url_tmpl, "")
            finally:
                if n is not None:
                    n.close()
        with mock.patch.dict(os.environ, {"PI_WAVE_CHAT_PUSH": "off"},
                             clear=False):
            env2 = {"PI_WAVE_PROGRESS_DIR": str(Path(self.tmp) / "p2"),
                    "PI_WAVE_NOTIFY": "off"}
            with mock.patch.dict(os.environ, env2, clear=False):
                n2 = Notifier.create(self.plan)
                if n2 is not None:
                    self.assertIsNone(n2._chat)
                    n2.close()


if __name__ == "__main__":
    unittest.main()
