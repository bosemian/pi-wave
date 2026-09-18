# pi-wave test prompts

Test ladder: free → cheap → machinery → extension. Paste prompts as-is.
Plans live in `tests/plans/`. `R=` repo root `~/labs/pi-wave`.

## Level 0 — free (no agents, no tokens)

```bash
cd ~/labs/pi-wave
python3 run.py tests/plans/conflict.json --dry-run; echo "exit=$?"
```

Expected: `plan error: ... file conflict in wave 1: 'README.md' ...` and `exit=2`.

```bash
python3 run.py examples/example-plan.json --dry-run; echo "exit=$?"
```

Expected: three `assignment` JSONL lines, `dry-run OK`, `exit=0`.

## Level 1 — cheap engine run (1 tiny luna call)

```bash
python3 run.py tests/plans/smoke-1-agent.json; echo "exit=$?"
```

Expected: JSONL `plan_start → wave_start → agent_start → agent_progress →
agent_done (status pass) → wave_done → summary`, final text
`PI-WAVE-SMOKE-OK`, `exit=0`.

## Level 2 — fix rounds + stop-on-failure machinery (~3 tiny luna calls)

`review_cmd` always exits 1 on purpose, so:

```bash
python3 run.py tests/plans/fix-round-always-fails.json; echo "exit=$?"
```

Expected: `review_failed` at rounds 1 and 2, one consolidated FIX prompt per
round, `agent_done` with `status: "fail"` after 3 attempts, **no** wave 2
(`stopped` in summary), `exit=1`.

## Level 3 — extension path (from inside a pi agent)

Start pi with the extension loaded (it is installed globally at
`~/.pi/agent/extensions/dispatch-wave.ts`, so any fresh pi session has it):

```bash
pi -e ~/labs/pi-wave/extension/dispatch-wave.ts   # or just: pi
```

Then paste one of these prompts.

**3a — basic dispatch:**

> เรียกใช้ tool dispatch_wave ด้วย plan ที่ ~/labs/pi-wave/tests/plans/smoke-1-agent.json แล้วสรุปผลจาก summary ที่ได้กลับมา ห้ามทำ assignment เอง และห้ามแก้ไฟล์ plan

**3b — dry-run first, then dispatch (tests both paths in one go):**

> ทดสอบ pi-wave ให้หน่อย: (1) รันคำสั่ง python3 ~/labs/pi-wave/run.py ~/labs/pi-wave/tests/plans/smoke-1-agent.json --dry-run แล้วตรวจว่าผ่าน (2) ถ้าผ่าน ให้เรียก dispatch_wave ด้วย plan เดียวกัน (3) สรุปสถานะของทุก agent จาก summary พร้อม tokens ที่ใช้ ห้ามทำ assignment เอง

**3c — conflict plan must be refused by the engine, not by you:**

> เรียก dispatch_wave ด้วย plan ที่ ~/labs/pi-wave/tests/plans/conflict.json แล้วรายงานว่าเกิดอะไรขึ้น

Expected: the tool result contains the engine's plan error (file conflict,
exit 2) — the *engine* refuses, proving the guardrail is not prompt-level.

**3d — fix-round machinery via extension:**

> เรียก dispatch_wave ด้วย plan ~/labs/pi-wave/tests/plans/fix-round-always-fails.json แล้วสรุปว่า wave 2 ถูก dispatch หรือไม่ เพราะอะไร

Expected: agent reports wave 1 failed after 3 attempts (1 + 2 fix rounds) and
wave 2 was never dispatched.

**3e — abort propagation (manual):** start 3a, then press Esc/Ctrl+C in pi
while the wave runs.

Expected: the engine and its child pi processes die (check `pgrep -f "mode.*rpc"`),
no orphaned agents.

## Level 4 — Herdr panes (agents visible, `display: "herdr"`)

The engine must run **inside** a Herdr pane (HERDR_ENV=1) — run pi in a Herdr
pane and prompt it there; the engine inherits the caller context, splits the
pane per agent (ratio 0.5), starts interactive pi in it, prompts via
`herdr agent prompt --wait`, and reads the pane scrollback. Panes stay open
after the run.

Quick free check from a Herdr pane shell first (must fail with a clear error
outside Herdr, succeed inside):

```bash
python3 ~/labs/pi-wave/run.py ~/labs/pi-wave/tests/plans/smoke-1-agent-herdr.json --dry-run
```

Then, with pi running in a Herdr pane, paste:

> เรียกใช้ tool dispatch_wave ด้วย plan ที่ ~/labs/pi-wave/tests/plans/smoke-1-agent-herdr.json แล้วสรุปผลจาก summary ห้ามทำ assignment เอง

Expected: a new pane appears to the right running pi with
`gpt-5.6-luna`, the prompt lands in it, the agent replies `PI-WAVE-HERDR-OK`
in the pane, and the tool result summary shows `display: "herdr"`, the pane
id, `status: "pass"`. The pane stays open afterwards.

Also verify the outside-Herdr guard: run the same dispatch from a pi session
that is NOT inside Herdr → the agent must report the engine error
`display=herdr requires running inside Herdr (HERDR_ENV=1)`.

## Level 4b — OMP boot-stall + pane-settled fallback (`kind: "omp"`)

Reproduces the real failure seen on the `security` role in
`examples/role-split-plan.json`: a freshly spawned OMP CLI almost always
looks "stalled" to herdr before it actually replies, and — confirmed live,
not rare — herdr's `agent_status` never leaves idle for `kind: "omp"` at
all, so the status-based wake check always exhausts. This exercises the
full recovery chain end-to-end on the OMP CLI itself: one stall →
`prompt_stall_recovery` → status wait exhausts → `prompt_stall_pane_check`
→ `HerdrBackend.wait_pane_settled` catches the real completion from the
pane's own scrollback.

Free check first:

```bash
python3 ~/labs/pi-wave/run.py ~/labs/pi-wave/tests/plans/smoke-1-agent-omp-herdr.json --dry-run
```

Then, with pi running in a Herdr pane, paste:

> เรียกใช้ tool dispatch_wave ด้วย plan ที่ ~/labs/pi-wave/tests/plans/smoke-1-agent-omp-herdr.json แล้วสรุปผลจาก summary รวมถึง events แปลกๆ ระหว่างทาง (เช่น prompt_stall_recovery หรือ prompt_stall_pane_check) ห้ามทำ assignment เอง

Expected: a pane opens running the OMP CLI on `claude-sonnet-5`; boot may
take 30-90s, so `prompt_stall_recovery` (exactly one — `kind: "omp"` no
longer resends) is likely in the JSONL, followed by `prompt_stall_pane_check`.
The pane shows `PI-WAVE-OMP-OK` exactly once (not twice — a duplicate
means the no-resend fix regressed), and the summary reports `status:
"pass"`. `dispatch_wave` in pi will sit quietly for up to ~65s while this
plays out — that's the stall watch window running its course, not a hang;
give it that long before assuming something is stuck. A `status: "timeout"`
result despite the pane visibly containing `PI-WAVE-OMP-OK` would mean the
fallback regressed — report that as a bug, not a flaky run.

## Level 4c — full role-split regression (`examples/role-split-plan.json`)

The exact plan that originally surfaced the whole OMP stall bug: 2 waves,
4 roles (`research`, `frontend` in wave 1; `qa`, `security` in wave 2),
`security` on `kind: "omp"`, plus an `orchestrator` pane reviewing each
result and writing a final synthesis. Real cost (4 agent calls + orchestrator
+ synthesis) — not part of the free/cheap ladder above, run deliberately.

With pi running in a Herdr pane, paste:

> เรียกใช้ tool dispatch_wave ด้วย plan ที่ ~/labs/pi-wave/examples/role-split-plan.json แล้วรอจนได้ summary จริง ๆ (อย่าสรุปจากสถานะที่ยังไม่ completed) จากนั้นบอกผม: (1) สถานะของทั้ง 4 roles (research/frontend/qa/security) พร้อม rounds และ pane id ของแต่ละตัว (2) security เจอ prompt_stall_recovery หรือ prompt_stall_pane_check กี่ครั้ง (3) เช็ค pane ของ security ว่ามีข้อความ/โค้ดซ้ำสองรอบไหม (4) synthesis จาก orchestrator ห้ามทำ assignment เอง ห้ามแก้ไฟล์ plan

Expected: all 4 roles `status: "pass"`, `security` at `rounds: 1` (not 2 —
two would mean the no-resend fix for `kind: "omp"` regressed), at most one
`prompt_stall_recovery` for `security` and no duplicated output in its pane,
overall `status: "completed"`, and a non-empty `synthesis` in the summary.
This run rewrites `research.py`, `frontend.py`, `qa.py`, `security.py` in
the repo root (that's expected — `review_cmd` on each checks they import
cleanly).

## Level 4d — pane grid layout + the 4-per-wave cap (`display: "herdr"`)

Verifies the tiling: the orchestrator splits the engine pane **right**, the
first assignment splits **down** off it to open the row, and every later
assignment fills **right** along that same row — so one wave of 4 agents lays
out as one wide orchestrator on top with a 4-pane row beneath it:

```
+---+--------------------+
| E |         O          |
|   +----+----+----+-----+
|   | g1 | g2 | g3 | g4  |
+---+----+----+----+-----+
```

Free check first (both must load; the cap is a dispatch-time guard, not a
load-time one, so even the 5-agent plan passes `--dry-run`):

```bash
python3 ~/labs/pi-wave/run.py ~/labs/pi-wave/tests/plans/pane-grid-herdr.json --dry-run
python3 ~/labs/pi-wave/run.py ~/labs/pi-wave/tests/plans/pane-grid-over-cap-herdr.json --dry-run
```

**4d-i — the grid (4 agents = the cap, all dispatch).** With pi running in a
Herdr pane, paste:

> เรียกใช้ tool dispatch_wave ด้วย plan ที่ ~/labs/pi-wave/tests/plans/pane-grid-herdr.json แล้วรอจนได้ summary จริง ๆ จากนั้นบอกผม pane id ของ orchestrator กับของ grid-1..grid-4 และ status ของแต่ละตัว ห้ามทำ assignment เอง ห้ามแก้ไฟล์ plan

Expected: 5 panes open with **no** `stopped` event — a wide orchestrator pane
to the right, then `grid-1` directly below it, and `grid-2`/`grid-3`/`grid-4`
added to the right of it on the same row (eyeball the pane layout: the four
`grid-*` panes share one horizontal row under the orchestrator, none stacked
in a second column). Each `grid-N` pane shows `PANE-N-OK`, the summary has
all four at `status: "pass"` (the orchestrator judged the exact-match
`done_when`), overall `status: "completed"`, plus a `synthesis`. This is the
boundary case: 4 herdr agents in one wave is exactly the cap and must run.

**4d-ii — one past the cap (5 agents → stop before dispatch).** Same pane,
paste:

> เรียกใช้ tool dispatch_wave ด้วย plan ที่ ~/labs/pi-wave/tests/plans/pane-grid-over-cap-herdr.json แล้วรายงานว่าเกิดอะไรขึ้น (ดูใน events ว่ามี wave_start ไหม และเหตุผลใน stopped)

Expected: the engine refuses at dispatch — a `stopped` event whose reason says
`4 agents per wave`, **no** `wave_start`, and summary `status: "stopped"`. No
`grid-*` agent is ever prompted (the guardrail is in the engine, not
prompt-level). If instead all 5 panes spawn, the cap regressed.

## Level 5 — wigolo research over MCP (`mcp_config`)

This is the only unproven link: an assignment agent actually starting the
wigolo MCP server through pi-mcp-adapter. The prompt makes failure loud — a
broken MCP shows up as the literal `WEB-TOOLS-UNAVAILABLE`, never as a
plausible-sounding answer from model memory.

Note: `display` defaults to `auto` — run from pi (or any shell) inside Herdr
and every agent opens a live pane; run from a plain terminal and it silently
falls back to headless.

**5a — free check (pinned version + plan validation):**

```bash
npx -y wigolo@0.2.1 --version        # expect: wigolo 0.2.1
python3 ~/labs/pi-wave/run.py ~/labs/pi-wave/tests/plans/research-wigolo.json --dry-run
```

Expected: dry-run prints `"mcp_config": "~/.config/mcp/wigolo.mcp.json"`.

**5b — headless engine run (1 luna call + wigolo, no panes):**

```bash
python3 ~/labs/pi-wave/run.py ~/labs/pi-wave/tests/plans/research-wigolo.json
```

Expected: summary `status: "pass"`, final text contains a wigolo version and
≥2 cited URLs. If the text is exactly `WEB-TOOLS-UNAVAILABLE` → MCP did not
connect: check `npx wigolo doctor`, then the engine spawn flags
(`--no-extensions -e <pi-mcp-adapter>/index.ts --mcp-config ...`).

**5c — Herdr pane run (visible research agent), from pi inside Herdr:**

> เรียกใช้ tool dispatch_wave ด้วย plan ที่ ~/labs/pi-wave/tests/plans/research-wigolo-herdr.json แล้วสรุปผลจาก summary: agent ใช้เว็บจริงหรือไม่ อ้างแหล่งที่มาครบไหม ห้ามทำ assignment เอง

Expected: a pane opens on the right running pi; the pane shows the agent
calling wigolo tools (`search` / `fetch`); summary reports `display: "herdr"`,
`status: "pass"`, cited URLs present.

**5d — negative control (proves the signal works), from pi inside Herdr:**

> เรียก dispatch_wave ด้วย plan ~/labs/pi-wave/tests/plans/research-wigolo.json แต่อย่าทำงานเอง — สรุปว่า agent ตอบว่าอะไร

Expected on a healthy setup: pass with citations (headless — no pane opens).

## Level 6 - Grok Bot chat push (`PI_WAVE_CHAT_PUSH=on`)

Checks that digests really land in Grok Bot, from pi, cheapest first.
Before you start: Grok Bot is open with the chat you want to watch, and the
app hosting pi has Accessibility permission (otherwise stderr shows
`not allowed to send keystrokes`). Don't type while a run is going - every
push steals focus and pastes.

Every level below routes all role digests into the same Grok Bot
(`PI_WAVE_CHAT_ROLE_APP="Grok Bot"`), so you don't need an app per role:

```bash
PI_WAVE_CHAT_PUSH=on PI_WAVE_CHAT_ROLE_APP="Grok Bot" pi
```

**6a - plumbing, 0 tokens (probe errors immediately, no agent spawns).**
Start pi **outside Herdr** for this one: inside Herdr, `display: auto` opens
a real OMP pane, and the probe ends `🚫 blocked on an approval dialog`
instead of `💥 error` (the pane stays open - close it yourself).

> ใช้ dispatch_wave รัน inline plan นี้ตรง ๆ ห้ามแก้ไข: {"name":"push-plumbing-test","cwd":".","on_failure":"continue","waves":[[{"name":"probe","prompt":"noop","model":"claude-sonnet-5","kind":"omp"}]]} มันตั้งใจให้ fail ทันทีเพื่อทดสอบ push เข้า Grok Bot รันแล้วสรุป summary สั้น ๆ ห้ามทำ assignment เอง

Expected in Grok Bot, in order, 4 messages:
`🚀 pi-wave push-plumbing-test started — 1 waves · 1 roles` →
`probe — 💥 error · wave 1` → `🏁 wave 1/1 — FAILED` →
a multi-line `📋 pi-wave push-plumbing-test ... — 0/1 roles passed` with a
`💥 probe` line. A multi-line message that arrives as separate messages
means Enter sends too early - rerun with `PI_WAVE_CHAT_SEND_KEY=cmd+return`.
Messages missing their first word means the paste went in before the app
was ready - raise `PI_WAVE_CHAT_DELAY`.

**6b - role summary line (1 luna call):**

> เรียกใช้ tool dispatch_wave ด้วย plan ที่ ~/labs/pi-wave/tests/plans/smoke-1-agent.json แล้วสรุปผลจาก summary ห้ามทำ assignment เอง (ผมกำลังดูว่า push ใน Grok Bot มีบรรทัดสรุปงานของ role ไหม)

Expected: the `agent_done` push is **2 lines**:
`wave-1-smoke — ✅ passed · 1 round(s) · wave 1` then `PI-WAVE-SMOKE-OK`
(the agent's last line). If only the first line shows up, `_tail_summary`
or the agent's `text` in the event is broken.

**6c - review_failed + stop-on-failure through the bot (~3 luna calls):**

> เรียก dispatch_wave ด้วย plan ~/labs/pi-wave/tests/plans/fix-round-always-fails.json แล้วสรุปว่า wave 2 ถูก dispatch หรือไม่ ห้ามทำ assignment เอง

Expected in Grok Bot: `🔁 wave-1-fixer failed review — fix round 1` and
`... fix round 2`, then `wave-1-fixer — ❌ failed after 3 rounds · wave 1`
followed by `ATTEMPTED`, `🏁 wave 1/2 — FAILED`, and the summary digest.
**No** push mentions `wave-2-never-runs` - if one does, stop-on-failure
regressed.

**6d - event filter + kill switch (1 luna call each):**

```bash
PI_WAVE_CHAT_PUSH=on PI_WAVE_CHAT_ROLE_APP="Grok Bot" PI_WAVE_CHAT_EVENTS=summary pi
```

Run the 6b prompt again → exactly **1** message (the `📋` summary). Then
start pi with no `PI_WAVE_CHAT_PUSH` and run 6b again → **0** messages in
Grok Bot, but `~/.pi-wave/progress/latest/dashboard.md` is still updated.

**6e - the bot reads the dashboard back (pull, 0 pi-wave tokens):** after
6c, paste into Grok Bot (not pi):

> อ่านไฟล์ ~/.pi-wave/progress/latest/dashboard.md แล้วบอกว่า role ไหน fail กี่ round และ feedback จาก review_cmd ว่าอะไร

Expected: the bot says `wave-1-fixer` failed after 3 rounds with
`DELIVERABLE MISSING: this review always fails on purpose`. More pull
prompts: `examples/grok-bot-prompts.md`.

Per-role routing (1 app or 1 chat per role, `PI_WAVE_CHAT_ROLE_URL`) is in
`examples/pi-prompts.md` sections 4-5, and costs a full role-split run.

## Cost notes

- Level 0: free. Level 1: one `gpt-5.6-luna` call, thinking off — minimal.
- Level 2: three tiny `gpt-5.6-luna` calls.
- `examples/example-plan.json` costs more (two luna + one sol/high) — run it
  once when Levels 0–2 are green.
