"""Tests for orchestrator/synthesizer role pinning (no Herdr needed).

The orchestrator pane must never implement assignments itself: the role
constraint is pinned via --append-system-prompt at agent start and echoed
in the review/synthesis prompts."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pi_wave.herdr_backend import HerdrBackend  # noqa: E402
from pi_wave.orchestrator import (  # noqa: E402
    ORCH_ROLE_SYSTEM_PROMPT,
    SYNTH_ROLE_SYSTEM_PROMPT,
    OrchestratorPane,
)
from pi_wave.plan import OrchestratorSpec  # noqa: E402


class RecordingBackend:
    """Records start_agent calls; enough of HerdrBackend for OrchestratorPane."""

    def __init__(self):
        self.started = []

    async def start_agent(self, name, pane_id, model, provider, thinking,
                          mcp_config: str = "", kind: str = "pi",
                          system_prompt: str = ""):
        self.started.append({"name": name, "model": model, "thinking": thinking,
                             "system_prompt": system_prompt})
        return ["pi", "--model", model, "--thinking", thinking]

    async def prompt(self, name, text, timeout_s: float) -> None:
        return None

    async def read(self, name, lines: int = 240) -> str:
        return "ok"


class FakeLayout:
    def __init__(self, panes):
        self._panes = list(panes)

    async def next_split(self, backend, ratio: float = 0.5) -> str:
        return self._panes.pop(0) if self._panes else "pane-x"


class TestOrchestratorRolePrompt(unittest.IsolatedAsyncioTestCase):
    async def test_start_pins_role_system_prompt(self):
        backend = RecordingBackend()
        orch = OrchestratorPane(backend, OrchestratorSpec(), FakeLayout(["p-orch"]))
        await orch.start()
        self.assertEqual(backend.started[0]["name"], "orchestrator")
        self.assertEqual(backend.started[0]["system_prompt"],
                         ORCH_ROLE_SYSTEM_PROMPT)

    async def test_synthesizer_gets_dedicated_role_prompt(self):
        backend = RecordingBackend()
        orch = OrchestratorPane(
            backend,
            OrchestratorSpec(synthesis_model="openai-codex/gpt-5.5"),
            FakeLayout(["p-orch", "p-synth"]))
        await orch.synthesize({})
        self.assertEqual(backend.started[0]["name"], "synthesizer")
        self.assertEqual(backend.started[0]["system_prompt"],
                         SYNTH_ROLE_SYSTEM_PROMPT)


class StubBackend(HerdrBackend):
    """Captures the herdr command start_agent builds."""

    def __init__(self):
        super().__init__(cwd="/tmp")
        self.cmd = None

    async def _run_json(self, args, timeout: float = 60.0):
        self.cmd = args
        model = args[args.index("--model") + 1]
        return {"result": {"argv": ["pi", "--model", model, "--thinking", "high"]}}


class TestStartAgentSystemPrompt(unittest.IsolatedAsyncioTestCase):
    async def test_system_prompt_reaches_command(self):
        b = StubBackend()
        await b.start_agent("orchestrator", "p1", "openai-codex/gpt-5.5", None,
                            "high", system_prompt="never implement assignments")
        self.assertIn("--append-system-prompt", b.cmd)
        self.assertEqual(b.cmd[b.cmd.index("--append-system-prompt") + 1],
                         "never implement assignments")

    async def test_no_flag_without_system_prompt(self):
        b = StubBackend()
        await b.start_agent("wave-1-code", "p1", "kimi-coding/k3", None, "high")
        self.assertNotIn("--append-system-prompt", b.cmd)


if __name__ == "__main__":
    unittest.main()
