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

## 4. Per-role bot routing — แต่ละ role สรุปงานเข้า bot ของตัวเอง

เมื่อ role เสร็จ (`agent_done`) push จะเป็น 2 บรรทัด — status + บรรทัด
สุดท้ายของ agent (สรุปงานที่มันทำ) — แล้วส่งเข้า bot ที่ชื่อตาม role
(`PI_WAVE_CHAT_ROLE_APP`, default = ชื่อ role ตรง ๆ). failed review ก็เข้า
bot เดียวกันนั้น ส่วน digest ระดับ run (`plan_start`, `wave_done`,
`summary`) เข้า `PI_WAVE_CHAT_APP`.

### 4a. ทดสอบเนื้อหา — รวมทุก role ลง bot เดียวที่มีอยู่จริง

ไม่ต้องมีแอปชื่อตาม role: ชี้ทุก role ไปที่แอปเดียว (template ไม่มี
`{role}` = ไม่แทนที่) จะเห็นทุก digest ในแอปเดียว แต่ละอันติดชื่อ role +
สรุปงาน — ยืนยันว่า "role สรุปงานของตัวเอง" ทำงานถูก

```bash
PI_WAVE_CHAT_PUSH=on PI_WAVE_CHAT_ROLE_APP="Grok Bot" pi
```

```
ใช้ dispatch_wave รัน plan ที่ ~/labs/pi-wave/examples/role-split-plan.json
ระหว่างรันไม่ต้องรายงานอะไรผม จบแล้วค่อยสรุป synthesis เป็นภาษาไทย
(ผมกำลังดูว่าแต่ละ role push สรุปงานเข้า Grok Bot ครบ 4 อันไหม)
```

คาดหวังใน Grok Bot: `research — ✅ passed · … · wave 1` ตามด้วยบรรทัดสรุป
งานของ research, แล้ว frontend / qa / security ทำนองเดียวกัน

### 4b. ทดสอบ routing เต็ม — 1 แอปต่อ 1 role

ต้องมีแอป macOS ชื่อตรงกับ role จริง (`research`, `frontend`, `qa`,
`security`) — ถ้าไม่มี push จะ fail เงียบ ๆ (hint ที่ stderr, ไม่ล้ม run)
ปล่อย `PI_WAVE_CHAT_ROLE_APP` เป็น default (`{role}`) แล้วรัน plan เดิม:

```bash
PI_WAVE_CHAT_PUSH=on pi
```

```
ใช้ dispatch_wave รัน plan ที่ ~/labs/pi-wave/examples/role-split-plan.json
ระหว่างรันไม่ต้องรายงานอะไรผม — ผมเฝ้าที่ bot ของแต่ละ role เอง
จบแล้วเอา synthesis มาสรุปเป็นภาษาไทย
```

คาดหวัง: สรุปของ research เด้งเข้าแอป `research`, frontend เข้าแอป
`frontend` … ต่อ role; ส่วนภาพรวม run (start / wave done / summary)
เข้า `PI_WAVE_CHAT_APP` (default `Grok Bot`)

ถ้าชื่อแอปมี prefix เช่น `Grok · research` ให้ตั้ง
`PI_WAVE_CHAT_ROLE_APP="Grok · {role}"`

## 5. 1 role = 1 แชท — routing ด้วย URL (`PI_WAVE_CHAT_ROLE_URL`)

แทนที่จะมี 1 แอปต่อ 1 role (section 4) ให้ใช้แอปเดียว (Grok Bot) แต่แต่ละ
role ลงแชทของตัวเอง: ตั้ง `PI_WAVE_CHAT_ROLE_URL` เป็น URL scheme ของแอปที่
เปิดแชทเจาะจง โดยมี `{role}` เป็น placeholder เมื่อ role เสร็จ
(`agent_done`) หรือ review fail push จะ `open` URL นั้นเพื่อโฟกัสแชทของ role
ก่อน แล้วค่อย paste. digest ระดับ run ยังเข้า `PI_WAVE_CHAT_APP` เหมือนเดิม
ถ้าไม่ตั้ง `PI_WAVE_CHAT_ROLE_URL` จะถอยไปใช้ routing ตามชื่อแอปของ section 4

> หมายเหตุ: `grok://chat/{role}` ข้างล่างเป็น placeholder - แทนที่ด้วย URL
> scheme จริงของ Grok Bot ก่อนรัน (ถ้าแชทอ้างด้วย id ไม่ใช่ชื่อ role จะต้อง
> map role -> id เพิ่ม บอกผมได้)

### 5a. เช็ก wiring แบบ 0 token — plumbing test

role เดียว (`probe`) ก็ emit `agent_done` ดังนั้น pi-wave จะรัน
`open grok://chat/probe` ให้เห็นว่า URL เปิดถูก/Grok Bot โฟกัสแชทนั้นไหม
ไม่มีค่า API:

```bash
PI_WAVE_CHAT_PUSH=on PI_WAVE_CHAT_ROLE_URL="grok://chat/{role}" pi
```

```
ใช้ dispatch_wave รัน inline plan นี้ตรง ๆ ห้ามแก้ไข:

{"name":"push-plumbing-test","cwd":".","on_failure":"continue","waves":[[{"name":"probe","prompt":"noop","model":"claude-sonnet-5","kind":"omp"}]]}

มันตั้งใจให้ fail ทันที - ผมกำลังดูว่า push ของ role เปิดแชท
`grok://chat/probe` ถูกไหม จบแล้วสรุป summary สั้น ๆ
```

ถ้า scheme ยังไม่ถูก `open` จะ fail เงียบ ๆ (hint ที่ stderr, ไม่ล้ม run)

### 5b. routing เต็ม — 1 role = 1 แชท ด้วย role-split plan

```bash
PI_WAVE_CHAT_PUSH=on PI_WAVE_CHAT_ROLE_URL="grok://chat/{role}" pi
```

```
ใช้ dispatch_wave รัน plan ที่ ~/labs/pi-wave/examples/role-split-plan.json
ระหว่างรันไม่ต้องรายงานอะไรผม - ผมเฝ้าที่แต่ละแชทของ role เอง
จบแล้วเอา synthesis มาสรุปเป็นภาษาไทย
```

คาดหวัง: สรุปของ research เข้าแชท `grok://chat/research`, frontend เข้า
`grok://chat/frontend`, แล้ว qa / security ทำนองเดียวกัน - แต่ละอันอยู่ใน
แชทของตัวเองภายในแอปเดียว; ส่วนภาพรวม run (start / wave done / summary)
เข้า `PI_WAVE_CHAT_APP` (default `Grok Bot`)
