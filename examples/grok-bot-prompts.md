# Prompts for testing dashboard reading from a desktop bot (e.g. Grok Bot)

Seed a dashboard first, then paste a prompt into the bot's chat.

```bash
# quick, zero-cost (one role that errors instantly — just to have a live file)
#   (write the one-line plan from README's Testing section or any plan)
# real showcase (4 roles in one wave — costs API tokens):
cd ~/labs/pi-wave && node engine/cli.ts examples/role-split-plan.json
```

Paths below use `~`; if your bot's file tool does not expand it, substitute
the absolute home path (e.g. `/Users/<you>/.pi-wave/progress/latest/dashboard.md`).
The first read may trigger the bot's local-file permission dialog — approve it.

## 1. Full-run overview

```
อ่านไฟล์ ~/.pi-wave/progress/latest/dashboard.md แล้วสรุปเป็นภาษาไทยสั้น ๆ:
สถานะ overall ของ run, แต่ละ role ทำอะไรถึงไหน (ผ่าน/กำลังทำ/พัง),
และถ้ามี role ที่ fail ให้บอกสาเหตุจาก feedback ที่อยู่ใน Role notes ด้วย
```

## 2. Mid-run status (while agents are still working)

```
นี่คือ run ที่กำลังทำงานอยู่ อ่าน ~/.pi-wave/progress/latest/dashboard.md แล้วตอบ:
(1) role ไหนเสร็จแล้วบ้าง (2) role ไหนกำลังทำ อยู่ turn ที่เท่าไหร่
(3) ตอนนี้อยู่ wave ที่เท่าไหร่ และเหลืออีกกี่ wave
```

## 3. Deep dive on one role (uses the raw event log)

```
ในไดเรกทอรีเดียวกับ dashboard.md มีไฟล์ events.jsonl เก็บ event ดิบทั้งหมด
บรรทัดสุดท้ายคือ JSON ของ summary ที่มีรายงานฉบับเต็มของทุก role
อ่านแล้วสรุปให้หน่อยว่า role "frontend" ทำอะไรมาบ้างตั้งแต่ต้นจนจบ
```

## 4. Failure analysis

```
มี role ที่ fail ใน ~/.pi-wave/progress/latest/dashboard.md
อ่านทั้ง dashboard.md และ events.jsonl ในโฟลเดอร์เดียวกัน แล้ววิเคราะห์ว่า
น่าจะพังเพราะอะไร และถ้าจะแก้ plan ควแก้ตรงไหน (prompt, review_cmd,
done_when หรือ timeout)
```

## 5. Watch mode (ask again without repeating yourself)

```
จำสรุปจาก ~/.pi-wave/progress/latest/dashboard.md ที่เพิ่งอ่านไว้
จากนี้เวลาผมพิมพ์ "อัปเดต" ให้อ่านไฟล์ใหม่แล้วรายงานเฉพาะสิ่งที่เปลี่ยน
จากครั้งก่อน (role ที่เพิ่งเสร็จ, fix round ใหม่, สถานะ overall ที่เปลี่ยน)
```
