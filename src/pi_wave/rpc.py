"""Async client for pi's RPC mode (JSONL over stdin/stdout).

Framing per pi docs/rpc.md: records are separated by LF (\n) only. asyncio's
stream readline() splits on \n, which is protocol-compliant.

One PiRpcSession = one assignment agent. The session is short-lived per
assignment (and per fix round we re-prompt the same process, mirroring
delegate-wave's "one consolidated fix prompt to the originating agent").
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any, Callable

EventHook = Callable[[str, dict[str, Any]], None]

# pi's MCP support (--mcp-config) is registered by the pi-mcp-adapter package.
# With --no-extensions, package discovery is off but explicit -e paths still
# load — so we load ONLY the adapter (never dispatch-wave: recursion guard
# stays intact) and hand it the assignment's MCP config.
MCP_ADAPTER_ENTRY = os.environ.get(
    "PI_WAVE_MCP_ADAPTER",
    "~/.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts",
)


def mcp_flags(mcp_config: str) -> list[str]:
    if not mcp_config:
        return []
    entry = Path(MCP_ADAPTER_ENTRY).expanduser()
    if not entry.is_file():
        raise PiRpcError(
            f"mcp_config requires the pi-mcp-adapter package but its entry was not "
            f"found at {entry} (install with: pi install npm:pi-mcp-adapter, or set PI_WAVE_MCP_ADAPTER)"
        )
    return ["--no-extensions", "-e", str(entry), "--mcp-config", str(Path(mcp_config).expanduser())]


class PiRpcError(RuntimeError):
    pass


class PiRpcSession:
    def __init__(
        self,
        *,
        agent_name: str,
        cwd: str,
        model: str,
        provider: str | None = None,
        thinking: str = "high",
        load_extensions: bool = False,
        mcp_config: str = "",
        on_event: EventHook | None = None,
    ) -> None:
        self.agent_name = agent_name
        self._cwd = cwd
        self._model = model
        self._provider = provider
        self._thinking = thinking
        self._load_extensions = load_extensions
        self._mcp_config = mcp_config
        self._on_event = on_event

        self.proc: asyncio.subprocess.Process | None = None
        self._next_id = 0
        self._waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._stderr_tail: list[str] = []
        self._last_text: str | None = None
        self._turns = 0
        self._closed = False

    # -- lifecycle ----------------------------------------------------------

    async def start(self) -> dict[str, Any]:
        argv = [
            "pi", "--mode", "rpc", "--no-session",
            "--model", self._model,
            "--thinking", self._thinking,
        ]
        if self._provider:
            argv += ["--provider", self._provider]
        # Recursion guard: assignment agents must never load dispatch_wave
        # (soft rule in prompts, hard guarantee here).
        if not self._load_extensions:
            argv.append("--no-extensions")
        argv += mcp_flags(self._mcp_config)

        self.proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=self._cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=2**22,
        )
        asyncio.get_running_loop().create_task(self._drain_stderr())
        asyncio.get_running_loop().create_task(self._read_stdout())
        state = await self.request({"type": "get_state"}, timeout=30)
        return state["data"]

    def verify_model(self, state: dict[str, Any]) -> None:
        """Fail fast when pi did not resolve the requested model (the RPC
        analogue of delegate-wave's 'check the pane footer' rule)."""
        got = (state.get("model") or {}).get("id")
        want = self._model.split("/")[-1] if "/" in self._model else self._model
        if got != want:
            raise PiRpcError(
                f"[{self.agent_name}] model mismatch: requested '{self._model}' "
                f"but pi resolved '{got}' — fix the plan's model id "
                f"(check with: pi --list-models {want})"
            )

    async def close(self) -> None:
        if self._closed or self.proc is None:
            return
        self._closed = True
        try:
            await asyncio.wait_for(self.request({"type": "abort"}, timeout=5), timeout=3)
        except Exception:
            pass
        try:
            self.proc.terminate()
            await asyncio.wait_for(self.proc.wait(), timeout=5)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass

    # -- requests / events --------------------------------------------------

    async def request(self, cmd: dict[str, Any], timeout: float = 120.0) -> dict[str, Any]:
        if self.proc is None or self.proc.stdin is None:
            raise PiRpcError(f"[{self.agent_name}] session not started")
        self._next_id += 1
        rid = f"r{self._next_id}"
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._waiters[rid] = fut
        self.proc.stdin.write((json.dumps({**cmd, "id": rid}) + "\n").encode())
        await self.proc.stdin.drain()
        try:
            resp = await asyncio.wait_for(fut, timeout)
        finally:
            self._waiters.pop(rid, None)
        if resp.get("success") is False:
            raise PiRpcError(f"[{self.agent_name}] {cmd.get('type')} failed: {resp.get('error')}")
        return resp

    async def prompt_and_settle(self, message: str, timeout: float) -> None:
        """Send one prompt, then block until agent_settled (no retry,
        compaction retry, or queued continuation remains)."""
        if self.proc is None:
            raise PiRpcError(f"[{self.agent_name}] session not started")
        await self.request({"type": "prompt", "message": message}, timeout=30)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                await self._abort_and_drain()
                raise TimeoutError(
                    f"[{self.agent_name}] prompt did not settle within {timeout:.0f}s"
                )
            ev = await self._next_event(remaining)
            self._absorb_event(ev)
            if ev.get("type") == "agent_settled":
                return

    async def last_text(self) -> str:
        if self._last_text is None:
            resp = await self.request({"type": "get_last_assistant_text"}, timeout=30)
            self._last_text = resp["data"].get("text") or ""
        return self._last_text

    async def stats(self) -> dict[str, Any]:
        try:
            resp = await self.request({"type": "get_session_stats"}, timeout=30)
            return resp["data"]
        except Exception:
            return {}

    # -- internals ------------------------------------------------------------

    def _absorb_event(self, ev: dict[str, Any]) -> None:
        etype = ev.get("type")
        if etype == "message_end":
            msg = ev.get("message") or {}
            if msg.get("role") == "assistant":
                text = "".join(
                    c.get("text", "") for c in msg.get("content", []) if c.get("type") == "text"
                )
                self._last_text = text
        elif etype == "turn_end":
            self._turns += 1
            if self._on_event:
                self._on_event(self.agent_name, {"type": "progress", "turn": self._turns})

    async def _abort_and_drain(self) -> None:
        try:
            await self.request({"type": "abort"}, timeout=5)
            loop = asyncio.get_running_loop()
            deadline = loop.time() + 15
            while loop.time() < deadline:
                ev = await self._next_event(deadline - loop.time())
                if ev.get("type") == "agent_settled":
                    return
        except Exception:
            pass

    async def _next_event(self, timeout: float) -> dict[str, Any]:
        try:
            ev = await asyncio.wait_for(self._events.get(), timeout)
        except asyncio.TimeoutError:
            raise TimeoutError(f"[{self.agent_name}] no event within {timeout:.1f}s") from None
        if ev.get("type") == "__process_exit__":
            raise PiRpcError(
                f"[{self.agent_name}] pi process exited unexpectedly; "
                f"stderr tail: {''.join(self._stderr_tail)[-800:]}"
            )
        return ev

    async def _read_stdout(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        try:
            while True:
                line = await self.proc.stdout.readline()
                if not line:  # EOF
                    break
                text = line.decode("utf-8", errors="replace").rstrip("\n")
                if text.endswith("\r"):
                    text = text[:-1]
                if not text.strip():
                    continue
                try:
                    obj = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") == "response" and "id" in obj:
                    fut = self._waiters.pop(str(obj["id"]), None)
                    if fut and not fut.done():
                        fut.set_result(obj)
                else:
                    await self._events.put(obj)
        finally:
            for fut in self._waiters.values():
                if not fut.done():
                    fut.set_exception(PiRpcError(f"[{self.agent_name}] session ended before response"))
            await self._events.put({"type": "__process_exit__"})

    async def _drain_stderr(self) -> None:
        assert self.proc is not None and self.proc.stderr is not None
        while True:
            line = await self.proc.stderr.readline()
            if not line:
                return
            self._stderr_tail.append(line.decode("utf-8", errors="replace"))
            if len(self._stderr_tail) > 200:
                self._stderr_tail.pop(0)
