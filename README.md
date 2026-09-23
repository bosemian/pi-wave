# pi-wave

Wave orchestrator for [pi](https://github.com/earendil-works/pi-mono) coding agents —
a programmatic engine for the delegate-wave protocol.
Instead of an LLM orchestrator typing `herdr` commands, this program spawns waves of
`pi --mode rpc` subagents, reviews results against definitions of done, runs consolidated
fix rounds, and returns one structured summary.

TypeScript on Node ≥ 24 (runs `.ts` directly, no build step), **zero runtime dependencies**.

## Architecture

```
pi agent (your orchestrator thread)
  └─ calls tool: dispatch_wave { plan: {...} | "/abs/plan.json" }
       └─ extension/dispatch-wave.ts  →  engine/ (in the same pi process)
            └─ per assignment: spawn pi --mode rpc --no-session --no-extensions
                 ├─ prompt → agent_settled → get_last_assistant_text
                 ├─ review_cmd exit code? fail → ONE consolidated fix prompt (max N)
                 └─ get_session_stats (tokens/cost) → terminate

terminal:  node engine/cli.ts <plan.json>  →  the same engine/, events as JSONL on stdout
```

The engine emits events (`plan_start`, `wave_start`, `agent_progress`,
`agent_done`, `wave_done`, `summary`); the extension forwards each one as a
tool update and returns the `summary` object as the tool result, and the CLI
prints them as JSONL on stdout.

## Quick start

```bash
# validate a plan without spending tokens — works from any directory.
# A plan with no "cwd" (or "cwd": ".") anchors agents to the directory
# you launch from — not the pi-wave repo.
node ~/labs/pi-wave/engine/cli.ts ~/labs/pi-wave/examples/example-plan.json --dry-run

# run it (spawns real pi agents — costs API tokens)
node ~/labs/pi-wave/engine/cli.ts ~/labs/pi-wave/examples/example-plan.json

# run the same plan on a different model/thinking without editing it
node engine/cli.ts examples/example-plan.json --model anthropic/claude-x --thinking low
# (--model/--provider/--thinking replace that field on EVERY assignment;
#  an unqualified --model needs --provider, same rule as the plan schema)
```

The example plan runs two read-only `gpt-5.6-luna` agents in wave 1 and one
`gpt-5.6-sol` synthesizer in wave 2 (its prompt receives both wave-1 results).

`examples/role-split-plan.json` shows role-splitting with a model per role:
research / frontend run in wave 1, qa / security in wave 2 — two agents per
wave, within the delegate-wave pane cap (see enforced rules below). The
code-writing frontend role runs `kimi-coding/k3` (code changes are k3-only,
never a gpt-5 model), research runs cheap `openai-codex/gpt-5.6-luna`, and
the qa / security roles demonstrate `kind: "omp"` (bare Sonnet id via the
OMP CLI). Inspect it with
`--dry-run`; running it creates the four modules in the plan's `cwd`
(review_cmd checks each one imports cleanly).

## delegate-wave protocol, no skill required

The engine implements the delegate-wave protocol programmatically, and the
`dispatch_wave` tool description carries the whole protocol (plan schema,
model/kind guidance, safety rules) — so a pi agent with just the extension
installed can delegate waves correctly. No skill has to be loaded or edited:

- `kind: "omp"` per assignment — Sonnet (`claude-sonnet-5`, bare id) runs via
  the OMP CLI; everything else is `kind: "pi"` (provider-qualified id).
- Plan-level `"orchestrator": true` (or `{model, thinking}`) spawns the skill's
  orchestrator pane first — wider pane (`ratio 0.4`), default
  `openai-codex/gpt-5.5` at `high`, pinned with a role system prompt so it
  only reviews and synthesizes — it never implements assignments itself.
  It reviews agents that have no
  `review_cmd` against their `done_when` (strict `VERDICT: pass|fail` reply)
  and writes the final `synthesis` in the summary. `review_cmd` still wins
  when present; the name `orchestrator` is reserved.
  It also keeps the agents in sync: after a wave passes its own checks
  (skipped for a lone first wave), it cross-checks the wave's results against
  each other and against earlier waves - shared names, ids/classes,
  interfaces - and verifies any problems the wave's agents report (e.g. a QA
  agent's findings) by reading the files. It replies `SYNC: pass`, or
  `SYNC: fail` with one `AGENT <name>:` block per agent that must change
  something; the engine sends each block as a fix prompt to that agent's
  still-open pane (in this wave or an earlier one), reruns its `review_cmd`,
  and asks again - at most 2 fix rounds. Agents still flagged then fail and
  the wave fails. Agents without a pane (headless) cannot take a fix, so
  their issues stay open. The summary records each synced wave as
  `sync: {status, rounds, issues?}`.
  Set `synthesis_model`/`synthesis_thinking` to hand ONLY the final synthesis
  to a dedicated one-shot `synthesizer` pane (e.g. review on one model,
  synthesis on `gpt-5.6-sol • high`).
- The `dispatch_wave` tool accepts the plan **inline** (an object) or as a
  path - the agent never hand-edits a file.

## Progress dashboard & notifications

Every real run (not `--dry-run`) feeds two side channels from the same
events, while stdout stays pure JSONL for the extension:

- **Live dashboard** — `~/.pi-wave/progress/<plan>-<timestamp>/dashboard.md`
  is rewritten atomically on every event: a per-role table (wave, model,
  status, fix rounds), role notes (owned files, `done_when`, review
  feedback, tokens/cost), the final synthesis, and a recent-event log.
  `~/.pi-wave/progress/latest` always points at the newest run, and
  `events.jsonl` next to it keeps every raw event (including full agent
  texts) for deep dives.
- **macOS notifications** — on `agent_done` (per role: pass/fail/timeout/
  blocked/error), `review_failed` (fix round started), `wave_done`, and
  the final summary. Sounds only for failures and the final ping.

Both sinks are best-effort: a failure (e.g. notifications not permitted)
prints to stderr and never stops the run.

Env overrides: `PI_WAVE_PROGRESS_DIR` moves the dashboards (default
`~/.pi-wave/progress`), `PI_WAVE_PROGRESS=off` disables the files,
`PI_WAVE_NOTIFY=off` disables notifications (default on under macOS).

### Reading the overview from a desktop bot

There is no API to push messages into chat apps like Cursor's Bot, so the
integration is pull-based: ask your bot to read the stable path, e.g.

> Read ~/.pi-wave/progress/latest/dashboard.md and summarize in Thai what
> each role has done so far and what is still running. If I ask for
> details, the full agent reports are in events.jsonl in the same
> directory.

The bot answers with the current state at any moment mid-run — the file
is always up to date. Ready-to-paste prompts for both sides — asking a
bot to read the dashboard, and driving waves from a pi agent — live in
`examples/grok-bot-prompts.md` and `examples/pi-prompts.md`.

### Pushing into a chat app (experimental)

Chat apps like Cursor's Bot expose no API to inject messages, so push mode
drives the app itself: each push activates it, pastes a one-line digest
from the clipboard, and presses Enter (AppleScript via `osascript`).

Per-role digests can land in one chat per role. When a role finishes
(`agent_done`) its push carries a two-line summary — the pass/fail status
plus the role's own last line (agents are prompted to end with a concise
summary of what they did); a failed review goes to the same place. Where it
lands depends on `PI_WAVE_CHAT_ROLE_URL`:

- **set** (e.g. `grok://chat/{role}`) — the push `open`s that per-chat URL to
  focus the role's own chat inside a single app, then pastes. One role, one
  chat. `{role}` is the role name.
- **unset** (default) — the push falls back to a separate app named after the
  role via `PI_WAVE_CHAT_ROLE_APP` (default the bare role name, e.g.
  `research`, `frontend`).

Run-level digests (`plan_start`, `wave_done`, the final `summary`) always go
to `PI_WAVE_CHAT_APP`.

Opt-in because the trade-offs are real:

- **focus steal** — every push activates the chat app (~1s); fine for
  unattended runs, annoying while you type
- **clipboard** — swapped briefly and restored after; a non-text clipboard
  cannot be restored
- **cost** — every landed message is one LLM turn for the bot, so pushes
  stay one-liners and are event-filtered
- **Accessibility** — the process running pi-wave (your terminal, or the
  app hosting pi) needs System Settings > Privacy & Security >
  Accessibility, otherwise every push fails with `not allowed to send
  keystrokes` and a hint on stderr

```bash
PI_WAVE_CHAT_PUSH=on node engine/cli.ts examples/role-split-plan.json
```

| Env | Default | Notes |
|---|---|---|
| `PI_WAVE_CHAT_PUSH` | `off` | `on` enables the sink |
| `PI_WAVE_CHAT_APP` | `Grok Bot` | app for run-level digests (plan/wave/summary), as AppleScript sees it |
| `PI_WAVE_CHAT_ROLE_URL` | *(unset)* | per-chat URL for per-role digests; when set (e.g. `grok://chat/{role}`) each role's push opens its own chat. Overrides `PI_WAVE_CHAT_ROLE_APP` |
| `PI_WAVE_CHAT_ROLE_APP` | `{role}` | fallback when `PI_WAVE_CHAT_ROLE_URL` is unset: app for per-role digests; `{role}` is the role name (e.g. `Grok · {role}`) |
| `PI_WAVE_CHAT_EVENTS` | `plan_start,review_failed,agent_done,wave_done,summary` | comma list; the summary arrives as a multi-line digest |
| `PI_WAVE_CHAT_SEND_KEY` | `return` | use `cmd+return` if Enter only adds a newline in the composer |
| `PI_WAVE_CHAT_DELAY` | `0.8` | seconds to wait after activate before pasting; raise if the app opens slowly |

## Portability

No absolute paths anywhere in the repo. Conventions:

- Plans use `"cwd": "."` (resolved at invocation) or `"~/..."` (expanded by the
  engine) — never `/Users/...`.
- The extension loads the engine relative to itself (`../engine`), so it
  runs from wherever the repo lives. The MCP adapter entry defaults to
  `~/.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts`; override with
  `PI_WAVE_MCP_ADAPTER`.

## Wave plan schema

```jsonc
{
  "name": "my-run",
  "cwd": "/abs/path/to/project",     // optional, default: current dir
  "on_failure": "stop",              // "stop" (default) | "continue"
  "waves": [                          // waves run in order
    [ { /* assignment — agents within one wave run in parallel */ } ]
  ]
}
```

| Assignment field | Required | Default | Notes |
|---|---|---|---|
| `name` | ✔ | | `[a-z][a-z0-9_-]{0,31}`, unique plan-wide |
| `prompt` | ✔ | | self-contained; the agent cannot ask questions |
| `model` | ✔ | | provider-qualified, e.g. `kimi-coding/k3` (pi defaults to google otherwise) |
| `provider` | | | only needed when `model` is not qualified |
| `thinking` | | `high` | `off…max` |
| `files` | | `[]` | exact files the agent may touch; `[]` = read-only assignment |
| `done_when` | | | definition of done, injected into the prompt |
| `review_cmd` | | | shell command; exit 0 = pass, otherwise output becomes the fix-round feedback |
| `max_fix_rounds` | | `2` | consolidated re-prompts to the same agent session |
| `timeout` | | `600` | seconds per prompt round |
| `needs_results` | | `[]` | names of earlier-wave agents whose final texts are injected |
| `load_extensions` | | `false` | keep false — see recursion guard below |
| `display` | plan-level, default `headless` | | `herdr` = run the agent live in a Herdr pane (requires the engine to run inside Herdr) |

## Display backends: `auto` (default), `herdr`, `headless`

`auto` (default): every agent opens a **live Herdr pane** when the engine runs
inside Herdr (`HERDR_ENV=1` — the normal case when dispatched by a pi agent),
and silently falls back to headless outside Herdr.

`herdr` (forced): delegate-wave visual — per assignment the engine splits its
own Herdr pane (`--ratio 0.5`, right), starts interactive pi there
(`herdr agent start --kind pi`), verifies the detected argv contains the
requested model, sends prompts with `herdr agent prompt --wait`, and reads the
pane scrollback for the result. Panes are left open after the run for
inspection; a `blocked` approval dialog is reported as status `blocked` and
never answered. Errors when run outside Herdr.

`headless` (forced): `pi --mode rpc` background processes — structured events,
token/cost stats, machine-grade result text, nothing to look at.

Trade-offs in herdr mode: no token/cost stats, and the result text is pane
scrollback (includes TUI chrome). Everything else (plan validation,
file-conflict rule, fix rounds, review, stop-on-failure, `mcp_config`)
behaves identically in all modes, and you can mix per assignment.

**Boot-stall recovery** — herdr requires a state change within a
hard-coded 5s window after a submission from idle, and a freshly spawned
CLI can take far longer to first respond; the submission may even kick in
late. On `agent_prompt_stalled` the engine watches for a late start — 10s
for pi agents, 60s for OMP — and consumes the original submission if the
agent wakes — surfaced as `prompt_stall_recovery` events in the JSONL and
dashboard. `kind: "pi"` (whose status field is reliable) resends once if
the agent never wakes (max two attempts total) before falling back;
`kind: "omp"` skips the resend and goes straight to the pane-settled
fallback below after its one attempt — see why in the next paragraph.

**Pane-settled fallback** — if herdr's status field never confirms a
wake, the engine falls back to watching the pane's scrollback itself —
`prompt_stall_pane_check` in the JSONL — comparing against a baseline
captured before the first prompt was ever sent, and only raises the
timeout if the pane never differs from that baseline within the watch
window. A pane that differs and has gone quiet is treated as settled,
even if that happened well before the fallback check started (the common
case: by the time a status-based attempt is exhausted, the agent has
often long since finished).

**Bugs found live on 2026-09-14, both fixed**: (1) the status lookup was
reading the wrong JSON key — herdr's `agent get` reports the agent's live
state under `agent_status`, but `wait_late_start`/`wait_settled` were
looking for `status`, which doesn't exist in that shape at all, so every
stall looked permanent regardless of what the agent was actually doing.
`HerdrBackend._agent_status` now reads `agent_status` first, falling back
to `status` for other herdr shapes. (2) even after that fix, `kind: "omp"`
was confirmed live to never report a non-idle `agent_status` at all (a gap
in herdr's own OMP integration, not a timing race) — so the old resend-once
behavior would reliably burn ~2 minutes and run the assignment twice on
every single OMP stall. Fixed by skipping the resend for `kind: "omp"`
(see above).

## Enforced delegate-wave rules

- **Same-wave file conflict rejected at load time** — two agents in one wave may
  never touch the same file; the loader fails fast and names the culprits.
- **Max 4 herdr-display agents per wave** (checked at dispatch) — the
  orchestrator splits right, the assignment row splits down off it and then
  fills to the right, so too many panes in one wave still become unusably
  narrow (observed: the last-split agent stalls or fails to start). Split the
  work into more waves or force `display: "headless"`, which has no panes and
  no cap.
- **Model verified at start** — after spawning, the engine checks `get_state`
  against the requested model and aborts the assignment on mismatch (the RPC
  analogue of delegate-wave's "check the pane footer" rule).
- **Recursion guard, structural not soft** — subagents are spawned with
  `--no-extensions`, so they cannot load `dispatch_wave` and nest waves. The
  prompt-level rule ("never dispatch subagents") is backed by a hard guarantee.
- **Fire-and-forget with consolidated fix rounds** — feedback is batched into one
  re-prompt to the originating agent's session, at most `max_fix_rounds` times.
- **Stop on failure** — with the default `on_failure: "stop"`, a wave that fails
  review halts later waves and the summary reports the state honestly.

## Install the extension (trigger from inside a pi agent)

```bash
# try it in one session
pi -e ~/labs/pi-wave/extension/dispatch-wave.ts
# then ask the agent: "Run dispatch_wave with the plan at ~/labs/pi-wave/examples/example-plan.json"

# install globally: add the repo's extension directory to ~/.pi/agent/settings.json
#   { "extensions": ["~/labs/pi-wave/extension"] }
# (don't copy the file - it imports ../engine)
```

The engine runs inside pi's process. Abort inside pi (Esc) reaches the
engine through the tool's `signal`: child `pi` processes are terminated,
running `herdr` and `review_cmd` commands are killed, and no further waves
start. Herdr panes stay open, as after a normal run.

## Testing

```bash
npm install                    # dev only: typescript + pi/typebox types
npm test && npm run typecheck  # no network, no real pi (a fake pi stands in)
```

## Roadmap

- file-guard extension (`tool_call` block for paths outside `files`) — turns the
  file contract from prompt-level to tool-call-level enforcement
- LLM reviewer assignment instead of / in addition to `review_cmd`
- optional Herdr pane display: run the engine from inside Herdr and mirror
  progress per agent into sibling panes
