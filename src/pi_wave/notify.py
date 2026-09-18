"""Progress sinks: a live dashboard file plus macOS notifications.

stdout stays pure JSONL (the dispatch-wave extension forwards it); this
module adds two human-facing side channels fed from the same events:

- a run directory ~/.pi-wave/progress/<plan>-<timestamp>/ with
  dashboard.md (compact, always-current per-role overview, rewritten
  atomically on every event — built for pull-reading, e.g. by a desktop
  bot) and events.jsonl (every raw event, including full agent texts)
- macOS notifications on agent_done / review_failed / wave_done / summary

Both sinks are best-effort: any failure prints to stderr and never stops
the run. Env knobs: PI_WAVE_PROGRESS=off disables the files,
PI_WAVE_PROGRESS_DIR moves them (default ~/.pi-wave/progress),
PI_WAVE_NOTIFY=off disables notifications (default on under darwin).

An optional third sink (opt-in, PI_WAVE_CHAT_PUSH=on) pushes one-line
digests into a chat app such as Cursor's Bot by activating it and pasting
via the clipboard — the only external input channel those apps expose.
Per-role digests (a role finishing, a failed review) can land in one chat
per role: set PI_WAVE_CHAT_ROLE_URL to the app's per-chat URL scheme with a
{role} placeholder (e.g. grok://chat/{role}) and each push opens that URL to
focus the role's chat before pasting. When it is unset, per-role digests
fall back to a bot named after the role (PI_WAVE_CHAT_ROLE_APP, default the
bare role name). Run-level digests go to PI_WAVE_CHAT_APP.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .plan import Assignment, Plan

EMOJI = {"working": "🔄", "pass": "✅", "fail": "❌",
         "timeout": "⏱", "blocked": "🚫", "error": "💥"}
DETAIL_CHARS = 200
LOG_LINES = 60
DEFAULT_PROGRESS_DIR = "~/.pi-wave/progress"


@dataclass
class _RoleRow:
    wave: int | str
    model: str
    status: str = "working"          # working | pass | fail | timeout | blocked | error
    rounds: int = 0
    turn: int = 0
    files: list[str] = field(default_factory=list)
    done_when: str = ""
    detail: list[str] = field(default_factory=list)
    tokens: dict[str, Any] = field(default_factory=dict)
    cost: Any = 0

    def status_cell(self) -> str:
        if self.status == "working":
            turn = f" · turn {self.turn}" if self.turn else ""
            return f"{EMOJI['working']} working{turn}"
        label = self.status if self.status != "pass" else "pass"
        return f"{EMOJI.get(self.status, '❔')} {label}"


class MacNotifier:
    """osascript `display notification` on a worker thread — emit() never
    blocks the asyncio loop. Failures (no permission, non-macOS) vanish."""

    def __init__(self) -> None:
        self._q: queue.Queue = queue.Queue()
        self._t = threading.Thread(target=self._run, daemon=True)
        self._t.start()

    def notify(self, title: str, subtitle: str, body: str, sound: bool = False) -> None:
        self._q.put((title, subtitle, body, sound))

    def _run(self) -> None:
        while True:
            item = self._q.get()
            if item is None:
                return
            title, subtitle, body, sound = item
            script = " ".join(
                [f'display notification "{_applescript(body[:250])}"',
                 f'with title "{_applescript(title)}"']
                + ([f'subtitle "{_applescript(subtitle)}"'] if subtitle else [])
                + (['sound name "Glass"'] if sound else [])
            )
            try:
                subprocess.run(["osascript", "-e", script],
                               capture_output=True, timeout=10)
            except Exception:
                pass  # notification permission denied etc. — never fatal

    def close(self, timeout: float = 5.0) -> None:
        self._q.put(None)
        self._t.join(timeout)


def _applescript(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


DEFAULT_CHAT_EVENTS = {"plan_start", "review_failed", "agent_done",
                       "wave_done", "summary"}


class ChatPusher:
    """Pushes short status lines into a chat app (e.g. Cursor's Bot) by
    activating it and pasting via the clipboard — such apps expose no API,
    deep link, or CLI, so UI automation is the only external input channel.
    `push(text, app=...)` targets a specific app so per-role digests can go
    to a bot named after the role; run-level digests use the default app.
    `push(text, url=...)` instead opens a per-chat URL (via `open`) to focus
    one chat per role before pasting — one role, one chat.

    Trade-offs (why this is opt-in): every push steals focus while the
    script activates the app, briefly replaces the clipboard (restored
    afterwards; a non-text clipboard cannot be restored), and each landed
    message is one LLM turn for the bot. Pushes are therefore one-liners
    filtered by event type.

    Requires Accessibility permission for whatever process runs pi-wave
    (System Events keystroke); without it, osascript fails and we print a
    hint on stderr — the run itself is unaffected."""

    def __init__(self, app: str = "Grok Bot", send_key: str = "return",
                 delay: float = 0.8) -> None:
        self._app = app
        self._send_key = send_key
        self._delay = delay
        self._q: queue.Queue = queue.Queue()
        self._failed = 0
        self._t = threading.Thread(target=self._run, daemon=True)
        self._t.start()

    def push(self, text: str, app: str | None = None,
             url: str | None = None) -> None:
        self._q.put((text, app, url))

    def _script(self, text: str, app: str | None = None,
                url: str | None = None) -> str:
        app = app or self._app
        # AppleScript string literals cannot hold raw newlines — join parts
        literal = " & return & ".join(
            f'"{_applescript(part)}"' for part in text.split("\n"))
        send = ("keystroke return with command down"
                if self._send_key == "cmd+return" else "keystroke return")
        # a per-chat URL focuses one chat (open picks the scheme's handler
        # app); otherwise activate the app by name. `quoted form of` shell-
        # quotes the URL so the role name cannot break out of the command.
        focus = (f"    do shell script \"open \" & quoted form of "
                 f"\"{_applescript(url)}\"\n" if url else
                 f"    tell application \"{_applescript(app)}\" to activate\n")
        return (
            "on run\n"
            "    set saved to missing value\n"
            "    try\n"
            "        set saved to the clipboard\n"
            "    end try\n"
            f"    set the clipboard to {literal}\n"
            f"{focus}"
            f"    delay {self._delay}\n"
            "    tell application \"System Events\"\n"
            "        keystroke \"v\" using command down\n"
            "        delay 0.25\n"
            f"        {send}\n"
            "    end tell\n"
            "    delay 0.2\n"
            "    if saved is not missing value then set the clipboard to saved\n"
            "end run"
        )

    def _run(self) -> None:
        while True:
            item = self._q.get()
            if item is None:
                return
            text, app, url = item
            try:
                r = subprocess.run(
                    ["osascript", "-e", self._script(text, app, url)],
                    capture_output=True, timeout=30)
                if r.returncode != 0 and self._failed < 3:
                    self._failed += 1
                    err = r.stderr.decode("utf-8", errors="replace").strip()
                    print(f"chat push failed: {err}\n"
                          "  hint: grant Accessibility to the app running "
                          "pi-wave (System Settings > Privacy & Security > "
                          "Accessibility), or set PI_WAVE_CHAT_PUSH=off",
                          file=sys.stderr)
            except Exception:
                pass  # best-effort: never take the run down

    def close(self, timeout: float = 10.0) -> None:
        self._q.put(None)
        self._t.join(timeout)


def _md_cell(s: str) -> str:
    return s.replace("|", "\\|").replace("\n", " ")


SUMMARY_CHARS = 280


def _tail_summary(text: str) -> str:
    """The agent is prompted to end its final message with a concise summary
    of what it did, so the work digest is the LAST non-empty line, capped."""
    for line in reversed(text.splitlines()):
        line = line.strip().lstrip("#->*• ").strip()
        if line:
            return line[:SUMMARY_CHARS]
    return ""


class Notifier:
    """Observes engine events and maintains the two side channels."""

    def __init__(self, plan: Plan, run_dir: Path, mac: MacNotifier | None,
                 chat: ChatPusher | None = None,
                 chat_events: set[str] | None = None,
                 role_app_tmpl: str = "{role}",
                 role_url_tmpl: str = "") -> None:
        self._plan = plan
        self._run_dir = run_dir
        self.dashboard_path = run_dir / "dashboard.md"
        self._events_path = run_dir / "events.jsonl"
        self._mac = mac
        self._chat = chat
        self._chat_events = chat_events if chat_events is not None \
            else set(DEFAULT_CHAT_EVENTS)
        self._role_app_tmpl = role_app_tmpl
        self._role_url_tmpl = role_url_tmpl
        self._roles: dict[str, _RoleRow] = {}
        self._orch: _RoleRow | None = None
        self._log: list[str] = []
        self._started = time.time()
        self._status = "running"
        self._wave = 0
        self._synthesis = ""
        self._assign: dict[str, Assignment] = {
            a.name: a for w in plan.waves for a in w
        }
        self._totals = (0, 0)  # (passed, total) once a summary arrived
        run_dir.mkdir(parents=True, exist_ok=True)
        self._point_latest()

    # -- construction ---------------------------------------------------

    @classmethod
    def create(cls, plan: Plan) -> Notifier | None:
        if os.environ.get("PI_WAVE_PROGRESS", "").lower() in {"off", "0", "no", "false"}:
            return None
        base = Path(os.environ.get("PI_WAVE_PROGRESS_DIR", DEFAULT_PROGRESS_DIR)
                    ).expanduser()
        stamp = time.strftime("%Y%m%d-%H%M%S")
        run_dir = base / f"{plan.name}-{stamp}"
        n = 2
        while run_dir.exists():
            run_dir = base / f"{plan.name}-{stamp}-{n}"
            n += 1
        setting = os.environ.get("PI_WAVE_NOTIFY", "auto").lower()
        use_mac = (sys.platform == "darwin") if setting == "auto" \
            else setting not in {"off", "0", "no", "false"}
        chat: ChatPusher | None = None
        chat_events: set[str] | None = None
        if os.environ.get("PI_WAVE_CHAT_PUSH", "off").lower() in {"on", "1", "yes", "true"}:
            chat = ChatPusher(
                app=os.environ.get("PI_WAVE_CHAT_APP", "Grok Bot"),
                send_key=os.environ.get("PI_WAVE_CHAT_SEND_KEY", "return"),
                delay=float(os.environ.get("PI_WAVE_CHAT_DELAY", "0.8")),
            )
            raw = os.environ.get("PI_WAVE_CHAT_EVENTS", "")
            chat_events = ({e.strip() for e in raw.split(",") if e.strip()}
                           if raw else set(DEFAULT_CHAT_EVENTS))
        role_app_tmpl = os.environ.get("PI_WAVE_CHAT_ROLE_APP", "{role}")
        role_url_tmpl = os.environ.get("PI_WAVE_CHAT_ROLE_URL", "")
        return cls(plan, run_dir, MacNotifier() if use_mac else None,
                   chat=chat, chat_events=chat_events,
                   role_app_tmpl=role_app_tmpl, role_url_tmpl=role_url_tmpl)

    # -- event intake ---------------------------------------------------

    def _row_for(self, name: str, wave: int | None = None,
                 model: str = "") -> _RoleRow:
        """Row lookup that self-heals: some engine paths (e.g. a kind=omp
        assignment failing validation) emit agent_done without a prior
        agent_start, so rows are created on demand from plan metadata."""
        row = self._roles.get(name)
        if row is None:
            a = self._assign.get(name)
            if wave is None:
                wave = next(
                    (i + 1 for i, w in enumerate(self._plan.waves)
                     for x in w if x.name == name), 0)
            row = _RoleRow(wave=wave, model=model or (a.model if a else ""),
                           files=list(a.files) if a else [],
                           done_when=a.done_when if a else "")
            self._roles[name] = row
        return row

    def handle(self, event: dict) -> None:
        """Record one engine event. Never raises: a broken sink must not
        take the run down with it."""
        try:
            self._record(event)
        except Exception as e:
            print(f"progress notifier: dropped event {event.get('type')}: {e}",
                  file=sys.stderr)

    def close(self) -> None:
        if self._mac is not None:
            self._mac.close()
        if self._chat is not None:
            self._chat.close()

    def _push(self, etype: str, text: str) -> None:
        if self._chat is not None and etype in self._chat_events:
            self._chat.push(text)

    def _role_app(self, role: str) -> str:
        try:
            return self._role_app_tmpl.format(role=role)
        except (KeyError, IndexError):
            return role

    def _role_url(self, role: str) -> str | None:
        if not self._role_url_tmpl:
            return None
        try:
            return self._role_url_tmpl.format(role=role)
        except (KeyError, IndexError):
            return None

    def _push_role(self, etype: str, role: str, text: str) -> None:
        """Push a per-role digest to the role's own chat: open its per-chat
        URL when PI_WAVE_CHAT_ROLE_URL is set, else the bot named per role."""
        if self._chat is not None and etype in self._chat_events:
            url = self._role_url(role)
            if url is not None:
                self._chat.push(text, url=url)
            else:
                self._chat.push(text, app=self._role_app(role))

    def _record(self, event: dict) -> None:
        with self._events_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
        etype = event.get("type")
        if etype == "plan_start":
            self._log.append(f"plan start · {event.get('waves')} waves · "
                             f"{event.get('agents')} agents")
            self._push("plan_start",
                       f"🚀 pi-wave {event.get('plan')} started — "
                       f"{event.get('waves')} waves · {event.get('agents')} roles")
        elif etype == "wave_start":
            self._wave = int(event.get("wave", self._wave))
            names = ", ".join(event.get("agents", []))
            self._log.append(f"wave {self._wave} start · {names}")
        elif etype == "agent_start":
            name = event.get("agent", "")
            a = self._assign.get(name)
            self._roles[name] = _RoleRow(
                wave=int(event.get("wave", 0)),
                model=str(event.get("model", "")),
                files=list(a.files) if a else [],
                done_when=a.done_when if a else "",
            )
            self._log.append(f"{name} start ({event.get('model')})")
        elif etype in {"progress", "agent_progress"}:
            # "progress" accepted for engines predating the agent_progress fix
            row = self._roles.get(event.get("agent", ""))
            if row is not None:
                row.turn = int(event.get("turn", row.turn))
            self._log.append(f"{event.get('agent')} turn {event.get('turn')}")
        elif etype == "prompt_stall_recovery":
            self._log.append(f"{event.get('agent')} prompt stalled — recovering")
        elif etype == "review_failed":
            name = event.get("agent", "")
            row = self._roles.get(name)
            if row is not None:
                row.rounds = int(event.get("round", row.rounds))
                tail = str(event.get("review_output_tail", "")).strip()
                if tail:
                    row.detail.append(f"review r{row.rounds}: "
                                      + _md_cell(tail[-DETAIL_CHARS:]))
            self._log.append(f"{name} review failed (round {event.get('round')})")
            self._notify(name, f"🔁 failed review · round {event.get('round')}")
            self._push_role("review_failed", name,
                            f"🔁 {name} failed review — fix round {event.get('round')}")
        elif etype == "agent_done":
            name = event.get("agent", "")
            row = self._row_for(name)
            row.status = str(event.get("status", row.status))
            row.rounds = int(event.get("rounds", row.rounds))
            self._log.append(f"{name} {event.get('status')} · "
                             f"{event.get('rounds')} round(s)")
            self._notify_agent_done(name, event)
            head = (f"{name} — "
                    f"{self._status_phrase(str(event.get('status', '')), event.get('rounds', '?'))}"
                    f" · wave {row.wave}")
            work = _tail_summary(str(event.get("text", "")))
            self._push_role("agent_done", name,
                            head + (f"\n{work}" if work else ""))
        elif etype == "wave_done":
            ok = bool(event.get("passed"))
            self._log.append(f"wave {event.get('wave')} "
                             + ("passed" if ok else "FAILED"))
            self._notify(f"wave {event.get('wave')}",
                         "✅ all agents passed" if ok
                         else "❌ wave failed — see dashboard", sound=not ok)
            self._push("wave_done",
                       f"🏁 wave {event.get('wave')}/{len(self._plan.waves)} — "
                       + ("all passed" if ok else "FAILED"))
        elif etype == "stopped":
            self._log.append(f"stopped: {event.get('reason')}")
        elif etype == "orchestrator_start":
            self._orch = _RoleRow(wave="—", model=str(event.get("model", "")))
            self._orch.detail.append(f"thinking: {event.get('thinking')}")
            self._log.append(f"orchestrator start ({event.get('model')})")
        elif etype == "orchestrator_done":
            if self._orch is not None:
                self._orch.status = "pass"
            self._log.append("orchestrator done")
        elif etype == "orchestrator_error":
            if self._orch is None:
                self._orch = _RoleRow(wave="—", model="")
            self._orch.status = "error"
            self._orch.detail.append(_md_cell(str(event.get("error", ""))[:DETAIL_CHARS]))
            self._log.append(f"orchestrator error: {str(event.get('error'))[:80]}")
        elif etype == "summary":
            self._absorb_summary(event)
        self._rewrite_dashboard()

    def _absorb_summary(self, event: dict) -> None:
        self._status = str(event.get("status", self._status))
        passed = total = 0
        for w in event.get("waves", []):
            for ag in w.get("agents", []):
                total += 1
                row = self._row_for(str(ag.get("name", "")),
                                    wave=int(ag.get("wave", 0)) or None,
                                    model=str(ag.get("model", "")))
                row.status = str(ag.get("status", row.status))
                row.rounds = int(ag.get("rounds", row.rounds))
                row.tokens = ag.get("tokens", {})
                row.cost = ag.get("cost", 0)
                if ag.get("error"):
                    row.detail.append("error: " + _md_cell(str(ag["error"])[:DETAIL_CHARS]))
                if ag.get("feedback"):
                    row.detail.append("feedback: "
                                      + _md_cell(str(ag["feedback"])[-DETAIL_CHARS:]))
                if row.status == "pass":
                    passed += 1
        self._totals = (passed, total)
        self._synthesis = str(event.get("synthesis", ""))
        self._log.append(f"summary · {self._status} · {passed}/{total} passed")
        self._notify("run finished",
                     f"{self._status} · {passed}/{total} agents passed",
                     sound=True)
        lines = [f"📋 pi-wave {self._plan.name} {self._status} — "
                 f"{passed}/{total} roles passed"]
        for name, row in self._roles.items():
            lines.append(f"{EMOJI.get(row.status, '❔')} {name} · {row.rounds} round(s)")
        if self._synthesis.strip():
            lines.append("synthesis: " + self._synthesis.strip()[:240])
        self._push("summary", "\n".join(lines))

    # -- notifications --------------------------------------------------

    def _notify(self, subtitle: str, body: str, sound: bool = False) -> None:
        if self._mac is not None:
            self._mac.notify(f"pi-wave · {self._plan.name}", subtitle, body, sound)

    def _status_phrase(self, status: str, rounds) -> str:
        return {"pass": f"✅ passed · {rounds} round(s)",
                "fail": f"❌ failed after {rounds} rounds",
                "timeout": "⏱ timed out",
                "blocked": "🚫 blocked on an approval dialog",
                "error": "💥 error"}.get(status, status)

    def _notify_agent_done(self, name: str, event: dict) -> None:
        status = str(event.get("status", ""))
        body = self._status_phrase(status, event.get("rounds", "?"))
        self._notify(name, body, sound=status in {"fail", "timeout", "blocked", "error"})

    # -- dashboard ------------------------------------------------------

    def _rewrite_dashboard(self) -> None:
        tmp = self.dashboard_path.with_suffix(".md.tmp")
        tmp.write_text(self._render(), encoding="utf-8")
        os.replace(tmp, self.dashboard_path)

    def _point_latest(self) -> None:
        base = self._run_dir.parent
        latest = base / "latest"
        tmp = base / f".latest-{os.getpid()}"
        try:
            os.symlink(self._run_dir.name, tmp)
            os.replace(tmp, latest)
        except OSError:
            try:
                tmp.unlink(missing_ok=True)
                latest.write_text(str(self._run_dir) + "\n", encoding="utf-8")
            except OSError:
                pass  # best-effort pointer only

    def _render(self) -> str:
        now = time.strftime("%H:%M:%S")
        passed, total = self._totals
        head = [
            f"# pi-wave · {self._plan.name}",
            "",
            f"**{self._status}**"
            + (f" · wave {self._wave}/{len(self._plan.waves)}"
               if self._status == "running" and self._wave else "")
            + (f" · {passed}/{total} passed" if total else "")
            + f" · started {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(self._started))}"
            + f" · updated {now}",
            f"cwd: `{self._plan.cwd}`",
            "",
            "| Wave | Role | Model | Status | Rounds |",
            "| --- | --- | --- | --- | --- |",
        ]
        for name, row in self._roles.items():
            rounds = str(row.rounds) if row.status != "working" else "—"
            head.append(f"| {row.wave} | {name} | {_md_cell(row.model)} | "
                        f"{row.status_cell()} | {rounds} |")
        if self._orch is not None:
            head.append(f"| — | orchestrator | {_md_cell(self._orch.model)} | "
                        f"{self._orch.status_cell()} | — |")

        notes = self._render_notes()
        synthesis = (["", "## Synthesis", "", self._synthesis.strip()]
                     if self._synthesis.strip() else [])
        log = ["", "## Recent events", ""] + [
            f"- {line}" for line in reversed(self._log[-LOG_LINES:])
        ]
        return "\n".join(head + notes + synthesis + log) + "\n"

    def _render_notes(self) -> list[str]:
        notes: list[str] = []
        for name, row in self._roles.items():
            bits = []
            if row.files:
                bits.append("files: " + ", ".join(f"`{f}`" for f in row.files))
            if row.done_when:
                bits.append("done: " + _md_cell(row.done_when[:160]))
            if row.status != "working" and (row.tokens or row.cost):
                tok = row.tokens.get("total") if isinstance(row.tokens, dict) else None
                if tok:
                    bits.append(f"{tok} tokens")
                if row.cost:
                    bits.append(f"${row.cost}")
            for d in row.detail:
                bits.append(d)
            if bits:
                notes.append(f"- **{name}** — " + " · ".join(bits))
        if self._orch is not None and self._orch.detail:
            notes.append("- **orchestrator** — " + " · ".join(self._orch.detail))
        return ["", "## Role notes", ""] + notes if notes else []
