# Prompts to run waves from a pi agent (dispatch_wave)

Start pi with the push sink enabled so pi-driven runs push too (the
extension spawns the engine with pi's environment):

```bash
PI_WAVE_CHAT_PUSH=on pi
```

Paste one of the prompts below. While a wave runs, watch progress via the
macOS notifications, the pushed chat lines, or ask a desktop bot to read
~/.pi-wave/progress/latest/dashboard.md (prompts in grok-bot-prompts.md).

## 1. Plumbing test — zero API tokens

Deterministic: one assignment that fails instantly without spawning any
agent, producing the full event sequence (start → done → wave → summary)
and therefore 4 chat pushes + a dashboard. Checks the pipeline only.

```
ใช้ dispatch_wave รัน inline plan นี้ตรง ๆ ห้ามแก้ไข:

{"name":"push-plumbing-test","cwd":".","on_failure":"continue","waves":[[{"name":"probe","prompt":"noop","model":"claude-sonnet-5","kind":"omp"}]]}

มันตั้งใจให้ fail ทันที (kind=omp แบบ headless) เพื่อทดสอบระบบรายงาน
progress — รันแล้วสรุปผลจาก summary ให้ผมสั้น ๆ
```

## 2. Small real run — example plan (~3 agents, small cost)

```
ใช้ dispatch_wave รัน plan ที่ ~/labs/pi-wave/examples/example-plan.json
แล้วสรุปผลจาก summary ว่าแต่ละ agent ได้อะไร
```

Two read-only researchers in wave 1, one synthesizer in wave 2 — expect
start/done pushes per agent plus the final digest.

## 3. Real work — role-split template (fill in your task)

```
ช่วย delegate งานนี้ด้วย dispatch_wave เป็น wave เดียว 4 roles:

งาน: [อธิบายงานที่นี่ เช่น "ทำ URL-shortener service stdlib-only 4 โมดูล"]
target: [โปรเจกต์/โฟลเดอร์]

- research — read-only, สรุป design + tradeoffs
- implement — เขียนโค้ดตามที่ research สรุป (ถ้าต้องใช้ผล research ให้
  ย้ายไป wave 2 พร้อม needs_results)
- qa — เขียน/รันการตรวจสอบ, review_cmd ต้อง exit 0
- security — ตรวจ input validation, review_cmd ต้อง exit 0

กติกา: ทุก role มี done_when ชัด ๆ, ไฟล์ไม่ซ้ำกันใน wave เดียว,
เลือก model + thinking ตามความเหมาะสมของ role, เปิด orchestrator: true
ให้ review กับเขียน synthesis รวม

ระหว่างรันไม่ต้องรายงานอะไรผม — ผมเฝ้าผ่าน dashboard เอง จบแล้วเอา
synthesis มาสรุปให้ผมเป็นภาษาไทย
```
