"""Herdr display backend — assignment agents run live in Herdr panes.

Used when an assignment has display: "herdr". The engine must itself run
inside a Herdr pane (HERDR_ENV=1): it inherits the caller context, so
`pane split --current` splits the parent agent's pane and every wave agent
stays visible next to it — the delegate-wave visual, driven by a program.

Rules carried over from the herdr/delegate-wave skills:
- equal assignment panes: split --ratio 0.5 each time;
- parse IDs from the JSON responses, never guess them;
- a `blocked` agent is reported, never answered;
- panes are left open after the run for the user to inspect.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path
from typing import Any

READ_LINES = 240


class HerdrError(RuntimeError):
    pass


class HerdrBlocked(HerdrError):
    """The agent is sitting at an approval/question dialog. Never answer it
    programmatically — surface it to the user instead."""


class HerdrPromptStalled(TimeoutError):
    """herdr observed no state change within its hard 5s window after a
    submission from idle — typical for a freshly spawned OMP CLI that is
    still booting. The submission may still kick in late (observed: the
    engine had already failed the assignment while the agent later did
    the work), so callers should watch for a late start before resending."""


def herdr_available() -> str | None:
    if os.environ.get("HERDR_ENV") != "1":
        return "display=herdr requires running inside Herdr (HERDR_ENV=1) — run pi-wave from a Herdr pane"
    if not shutil.which("herdr"):
        return "herdr binary not found in PATH"
    return None


def _find_key(obj: Any, key: str) -> Any:
    """Defensive depth-first search — herdr result shapes vary by version."""
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for v in obj.values():
            found = _find_key(v, key)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = _find_key(v, key)
            if found is not None:
                return found
    return None


class HerdrBackend:
    def __init__(self, cwd: str) -> None:
        self._cwd = cwd

    async def _run(self, args: list[str], timeout: float = 60.0) -> tuple[int, str, str]:
        proc = await asyncio.create_subprocess_exec(
            "herdr", *args,
            cwd=self._cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise HerdrError(f"herdr {' '.join(args[:3])}... timed out after {timeout:.0f}s") from None
        return (
            proc.returncode or 0,
            out.decode("utf-8", errors="replace"),
            err.decode("utf-8", errors="replace"),
        )

    async def _run_json(self, args: list[str], timeout: float = 60.0) -> dict[str, Any]:
        rc, out, err = await self._run(args, timeout)
        payload = None
        for text in (out, err):
            text = text.strip()
            if text.startswith("{"):
                try:
                    payload = json.loads(text)
                    break
                except json.JSONDecodeError:
                    pass
        if rc != 0:
            code = ""
            if payload:
                code = str(_find_key(payload, "code") or "")
            detail = err.strip()[:400] or out.strip()[:400]
            if "blocked" in code or "blocked" in detail.lower():
                raise HerdrBlocked(
                    f"agent is waiting at an approval/question dialog (never answer it "
                    f"programmatically — inspect the pane and ask the user): {detail}"
                )
            if "stalled" in code:
                raise HerdrPromptStalled(
                    f"herdr timed out waiting for the agent: {detail}")
            if "timeout" in code:
                raise TimeoutError(f"herdr timed out waiting for the agent: {detail}")
            raise HerdrError(f"herdr {' '.join(args[:3])}... failed (exit {rc}): {detail}")
        if not isinstance(payload, dict):
            raise HerdrError(f"herdr {' '.join(args[:3])}... returned no JSON: {out.strip()[:200]}")
        return payload

    # -- wave-agent lifecycle -------------------------------------------------

    async def split_pane(self, ratio: float = 0.5) -> str:
        """Split the calling pane to the right and return the new pane id.

        Assignment panes keep the delegate-wave default of equal halves
        (0.5); the orchestrator pane is split first with a lower ratio so it
        ends up wider than any assignment pane."""
        resp = await self._run_json([
            "pane", "split", "--current", "--direction", "right",
            "--cwd", self._cwd, "--no-focus", "--ratio", str(ratio),
        ])
        pane_id = _find_key(resp.get("result", resp), "pane_id")
        if not pane_id:
            raise HerdrError(f"pane split returned no pane_id: {json.dumps(resp)[:300]}")
        return str(pane_id)

    async def start_agent(self, name: str, pane_id: str, model: str,
                          provider: str | None, thinking: str,
                          mcp_config: str = "", kind: str = "pi") -> list[str]:
        """Start an agent in the pane; returns the argv Herdr detected.

        kind "pi" runs the pi agent CLI (model must be provider-qualified);
        kind "omp" runs the OMP CLI with a bare model id (the delegate-wave
        rule: only Sonnet goes through OMP)."""
        if kind == "omp":
            model_arg = model.split("/")[-1]
        else:
            model_arg = model if "/" in model else (f"{provider}/{model}" if provider else model)
        extra: list[str] = ["--model", model_arg, "--thinking", thinking]
        if mcp_config:
            # interactive pi already loads pi-mcp-adapter (user package);
            # only hand it this assignment's config
            extra += ["--mcp-config", str(Path(mcp_config).expanduser())]
        resp = await self._run_json(
            ["agent", "start", name, "--kind", kind, "--pane", pane_id,
             "--timeout", "60000", "--", *extra],
            timeout=90.0,
        )
        argv = _find_key(resp.get("result", resp), "argv")
        if not isinstance(argv, list):
            raise HerdrError(f"agent start returned no argv: {json.dumps(resp)[:300]}")
        want = model_arg.split("/")[-1]
        joined = " ".join(str(x) for x in argv)
        if want not in joined:
            raise HerdrError(
                f"[{name}] model mismatch: argv '{joined}' does not contain '{want}' "
                f"(the RPC analogue of delegate-wave's footer check)"
            )
        return [str(x) for x in argv]

    async def prompt(self, name: str, text: str, timeout_s: float) -> None:
        """Send one prompt and wait for the agent to settle (idle/done/blocked)."""
        await self._run_json(
            ["agent", "prompt", name, text, "--wait", "--timeout", str(int(timeout_s * 1000))],
            timeout=timeout_s + 60,
        )

    SETTLED = ("idle", "done")

    @staticmethod
    def _agent_status(state: dict) -> str:
        """herdr's `agent get` reports the agent's own status under
        'agent_status' (confirmed live on herdr 0.8.2 — the shape has no
        'status' key at all, so a bare lookup for 'status' always misses
        and every wait falls straight through to 'unknown'/idle, making
        every stall look permanent regardless of what the agent is doing).
        'status' is kept as a fallback for other herdr shapes."""
        return str(_find_key(state, "agent_status")
                   or _find_key(state, "status") or "unknown")

    async def wait_late_start(self, name: str, watch_s: float = 10.0,
                              poll_s: float = 0.5) -> str | None:
        """After a stalled submission: return the first non-idle status
        seen within watch_s (the submission kicking in late), or None if
        the agent stays idle the whole time."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + watch_s
        while True:
            status = self._agent_status(await self.state(name))
            if status not in {"idle", "unknown"}:
                return status
            if loop.time() >= deadline:
                return None
            await asyncio.sleep(poll_s)

    async def wait_settled(self, name: str, timeout_s: float,
                           poll_s: float = 0.5) -> None:
        """Poll until the agent is idle/done again, blocked, or out of time."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_s
        while True:
            status = self._agent_status(await self.state(name))
            if status == "blocked":
                raise HerdrBlocked(
                    f"agent '{name}' is waiting at an approval/question dialog")
            if status in self.SETTLED:
                return
            if loop.time() >= deadline:
                raise TimeoutError(
                    f"[{name}] agent did not settle within {timeout_s:.0f}s "
                    f"(last status: {status})")
            await asyncio.sleep(poll_s)

    async def wait_pane_settled(self, name: str, baseline: str, timeout_s: float,
                                poll_s: float = 1.0, stable_polls: int = 2) -> bool:
        """Status-independent fallback for when herdr's own status field
        never confirms a wake. `baseline` must be the pane's scrollback
        captured BEFORE the first (stalled) prompt was sent — not a fresh
        read taken now: by the time every status-based attempt has been
        exhausted, the agent has often already finished and gone quiet, so
        a "watch it change from here" check would see nothing and miss it.
        True once the pane differs from that baseline and has held stable
        for `stable_polls` consecutive reads (whether that stability was
        reached just now or well before this call started); False if the
        pane never differs from the baseline at all within timeout_s
        (genuinely idle, not a false notification)."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_s
        last: str | None = None
        stable = 0
        while True:
            text = await self.read(name)
            if text != baseline:
                stable = stable + 1 if text == last else 1
                if stable >= stable_polls:
                    return True
            else:
                stable = 0
            last = text
            if loop.time() >= deadline:
                return False
            await asyncio.sleep(poll_s)

    async def read(self, name: str, lines: int = READ_LINES) -> str:
        rc, out, err = await self._run(
            ["agent", "read", name, "--source", "recent-unwrapped",
             "--lines", str(lines), "--format", "text"]
        )
        if rc != 0:
            raise HerdrError(f"herdr agent read {name} failed (exit {rc}): {err.strip()[:300]}")
        return out

    async def state(self, name: str) -> dict[str, Any]:
        return await self._run_json(["agent", "get", name])
