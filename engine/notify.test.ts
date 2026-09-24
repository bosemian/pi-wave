// Tests for the progress notifier (no network, no pi, no osascript).
// Run from the repo root: npm test

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { ChatPusher, type ChatSink, type MacSink, Notifier } from "./notify.ts";
import { type Plan, loadPlan } from "./plan.ts";

type Json = Record<string, any>;

class FakeMac implements MacSink {
  calls: [string, string, string, boolean][] = [];
  notify(title: string, subtitle: string, body: string, sound = false) {
    this.calls.push([title, subtitle, body, sound]);
  }
  async close() {}
}

class FakeChat implements ChatSink {
  calls: { text: string; app?: string; url?: string }[] = [];
  push(text: string, target: { app?: string; url?: string } = {}) {
    this.calls.push({ text, ...target });
  }
  async close() {}
  get messages() {
    return this.calls.map((c) => c.text);
  }
}

function makePlan(tmp: string): Plan {
  const proj = path.join(tmp, "proj");
  mkdirSync(proj, { recursive: true });
  const f = path.join(tmp, "plan.json");
  writeFileSync(f, JSON.stringify({
    name: "t",
    cwd: proj,
    waves: [[
      { name: "research", prompt: "p", model: "kimi-coding/k3", files: [], done_when: "notes written" },
      { name: "qa", prompt: "p", model: "kimi-coding/k3", files: ["src/a.py"], review_cmd: "pytest -q" },
    ]],
  }));
  return loadPlan(f);
}

const EVENTS: Json[] = [
  { type: "plan_start", plan: "t", cwd: "/tmp/proj", waves: 1, agents: 2 },
  { type: "wave_start", wave: 1, agents: ["research", "qa"] },
  { type: "agent_start", agent: "research", wave: 1, model: "kimi-coding/k3", display: "headless" },
  { type: "agent_start", agent: "qa", wave: 1, model: "kimi-coding/k3", display: "headless" },
  { type: "progress", agent: "research", turn: 1 },
  {
    type: "agent_done", agent: "research", status: "pass", rounds: 1,
    text: "Explored options.\nCreated research.py with SERVICE_DESIGN and tradeoffs().",
  },
  { type: "review_failed", agent: "qa", round: 1, review_output_tail: "2 tests failed:\n- test_a\n- test_b" },
  { type: "progress", agent: "qa", turn: 2 },
  { type: "agent_done", agent: "qa", status: "pass", rounds: 2, text: "Fixed the failing checks.\nAll 4 qa checks pass now." },
  { type: "wave_done", wave: 1, passed: true },
  {
    type: "summary", plan: "t", cwd: "/tmp/proj", status: "completed",
    waves: [{ wave: 1, agents: [
      { name: "research", wave: 1, model: "kimi-coding/k3", status: "pass", rounds: 1, text: "did research",
        display: "headless", tokens: { total: 1234 }, cost: 0.05 },
      { name: "qa", wave: 1, model: "kimi-coding/k3", status: "pass", rounds: 2, text: "qa ok",
        display: "headless", tokens: { total: 999 }, cost: 0.02 },
    ] }],
    synthesis: "All agents passed; notes under docs/.",
  },
];

/** Run a test body with env overrides, restoring the previous values. */
async function withEnv(env: Record<string, string>, fn: () => Promise<void> | void) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("Notifier", () => {
  let tmp: string;
  let plan: Plan;
  let runDir: string;
  let mac: FakeMac;
  let notifier: Notifier;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "pi-wave-notify-"));
    plan = makePlan(tmp);
    runDir = path.join(tmp, "progress", "t-20260914-100000");
    mac = new FakeMac();
    notifier = new Notifier(plan, runDir, { mac });
  });

  const feed = (events: Json[]) => {
    for (const ev of events) notifier.handle(ev);
    return readFileSync(path.join(runDir, "dashboard.md"), "utf8");
  };

  it("renders the dashboard for a full run", () => {
    const md = feed(EVENTS);
    assert.ok(md.includes("# pi-wave · t"));
    assert.ok(md.includes("| 1 | research | kimi-coding/k3 | ✅ pass | 1 |"));
    assert.ok(md.includes("| 1 | qa | kimi-coding/k3 | ✅ pass | 2 |"));
    assert.ok(md.includes("**completed**"));
    assert.ok(md.includes("## Synthesis"));
    assert.ok(md.includes("All agents passed; notes under docs/."));
    // role notes carry the plan metadata and summary stats
    assert.ok(md.includes("done: notes written"));
    assert.ok(md.includes("`src/a.py`"));
    assert.ok(md.includes("1234 tokens"));
    // review feedback from the fix round is kept, escaped and truncated
    assert.ok(md.includes("review r1:"));
    assert.ok(md.includes("- test_a - test_b"));
    assert.ok(md.includes("## Recent events"));
  });

  it("shows the working turn", () => {
    const md = feed(EVENTS.slice(0, 5)); // up to the first progress event
    assert.ok(md.includes("🔄 working · turn 1"));
    assert.ok(md.includes("| 1 | qa | kimi-coding/k3 | 🔄 working | - |")); // no turn yet
    assert.ok(md.includes("wave 1/1"));
  });

  it("records every event in events.jsonl", () => {
    feed(EVENTS);
    const lines = readFileSync(path.join(runDir, "events.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, EVENTS.length);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.equal(parsed.at(-1).type, "summary");
    assert.equal(parsed[4].type, "progress");
  });

  it("notifies on key events", () => {
    feed(EVENTS);
    const subs = new Map(mac.calls.map((c) => [c[1], c]));
    assert.equal(subs.get("research")![2], "✅ passed · 1 round(s)");
    assert.equal(subs.get("research")![3], false);
    assert.ok(mac.calls.filter((c) => c[1] === "qa").some((c) => c[2].includes("failed review")));
    assert.equal(subs.get("wave 1")![2], "✅ all agents passed");
    assert.ok(subs.get("run finished")![2].includes("completed · 2/2 agents passed"));
    assert.equal(subs.get("run finished")![3], true); // final ping has sound
  });

  it("gives a failure notification sound", () => {
    feed([EVENTS[0]!, EVENTS[1]!, EVENTS[2]!, { type: "agent_done", agent: "research", status: "fail", rounds: 3 }]);
    const fail = mac.calls.find((c) => c[1] === "research")!;
    assert.ok(fail[2].includes("failed after 3 rounds"));
    assert.equal(fail[3], true);
  });

  it("reads its settings from the environment", async () => {
    const dir = path.join(tmp, "env-progress");
    await withEnv({ PI_WAVE_NOTIFY: "off" }, async () => {
      const n = Notifier.create(plan, dir);
      assert.ok(n);
      assert.equal(n.dashboardPath, path.join(dir, "dashboard.md"));
      await n.close();
    });
    await withEnv({ PI_WAVE_PROGRESS: "off" }, () => {
      assert.equal(Notifier.create(plan, dir), null);
    });
  });

  it("gives agent_done without agent_start a row", () => {
    // kind=omp headless fails validation: agent_done with no agent_start
    const md = feed([
      EVENTS[0]!,
      EVENTS[1]!,
      { type: "agent_done", agent: "research", status: "error", rounds: 0 },
      { type: "wave_done", wave: 1, passed: false },
      {
        type: "summary", plan: "t", cwd: "/tmp/proj", status: "stopped",
        waves: [{ wave: 1, agents: [
          { name: "research", wave: 1, model: "kimi-coding/k3", status: "error", rounds: 0, text: "",
            error: "kind=omp requires display=herdr", display: "headless", tokens: {}, cost: 0 },
        ] }],
      },
    ]);
    assert.ok(md.includes("| 1 | research | kimi-coding/k3 | 💥 error | 0 |"));
    assert.ok(md.includes("kind=omp requires display=herdr"));
    assert.ok(md.includes("**stopped** · 0/1 passed"));
  });

  it("never throws when the run dir is deleted, and reports the drop through warn", async () => {
    const warnings: string[] = [];
    notifier = new Notifier(plan, runDir, { mac, warn: (m) => warnings.push(m) });
    feed(EVENTS.slice(0, 2));
    rmSync(path.dirname(runDir), { recursive: true });
    notifier.handle(EVENTS[2]!); // must not throw
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.startsWith("progress notifier: dropped event agent_start"));
    await notifier.close();
  });
});

describe("chat push", () => {
  let tmp: string;
  let plan: Plan;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "pi-wave-chat-"));
    plan = makePlan(tmp);
  });

  const run = (opts: ConstructorParameters<typeof Notifier>[2], events = EVENTS) => {
    const chat = new FakeChat();
    const n = new Notifier(plan, path.join(tmp, "run"), { chat, ...opts });
    for (const ev of events) n.handle(ev);
    return chat;
  };

  it("pushes the default events", () => {
    const chat = run({});
    const texts = chat.messages.join("\n--\n");
    assert.ok(texts.includes("🚀 pi-wave t started - 1 waves · 2 roles"));
    assert.ok(texts.includes("🔁 qa failed review - fix round 1"));
    assert.ok(texts.includes("research - ✅ passed · 1 round(s) · wave 1"));
    // the role digest carries the work summary (agent's last line)
    assert.ok(texts.includes("Created research.py with SERVICE_DESIGN and tradeoffs()."));
    assert.ok(texts.includes("qa - ✅ passed · 2 round(s) · wave 1"));
    assert.ok(texts.includes("🏁 wave 1/1 - all passed"));
    const summary = chat.messages.find((m) => m.startsWith("📋"))!;
    assert.ok(summary.includes("completed - 2/2 roles passed"));
    assert.ok(summary.includes("✅ research · 1 round(s)"));
    assert.ok(summary.includes("synthesis: All agents passed"));
  });

  it("sends per-role digests to the role's bot", () => {
    const chat = run({});
    // per-role events (agent_done, review_failed) → a bot named per role
    assert.deepEqual(new Set(chat.calls.filter((c) => c.app).map((c) => c.app)), new Set(["research", "qa"]));
    assert.ok(chat.calls.some((c) => c.app === "research" && c.text.includes("Created research.py")));
    assert.ok(chat.calls.some((c) => c.app === "qa" && c.text.includes("failed review")));
    // run-level digests stay on the default app
    const runLevel = chat.calls.filter((c) => !c.app && !c.url).map((c) => c.text);
    assert.ok(runLevel.some((t) => t.startsWith("🚀")));
    assert.ok(runLevel.some((t) => t.startsWith("📋")));
  });

  it("applies the role app template", () => {
    const chat = run({ roleAppTmpl: "Grok · {role}" }, [EVENTS[5]!]); // research agent_done
    assert.ok(chat.calls.some((c) => c.app === "Grok · research"));
  });

  it("routes per-role digests to per-chat URLs", () => {
    const chat = run({ roleUrlTmpl: "grok://chat/{role}" });
    // per-role digests open the role's own chat URL, not an app name
    assert.deepEqual(
      new Set(chat.calls.filter((c) => c.url).map((c) => c.url)),
      new Set(["grok://chat/research", "grok://chat/qa"]),
    );
    assert.ok(chat.calls.some((c) => c.url === "grok://chat/research" && c.text.includes("Created research.py")));
    assert.equal(chat.calls.filter((c) => c.app).length, 0);
    assert.ok(chat.calls.some((c) => !c.url && c.text.startsWith("🚀")));
  });

  it("limits pushes to the event filter", () => {
    const chat = run({ chatEvents: ["summary"] });
    assert.equal(chat.messages.length, 1);
    assert.ok(chat.messages[0]!.startsWith("📋"));
  });

  it("escapes the script and joins lines", () => {
    const p = new ChatPusher('Weird "App"', "cmd+return", 1.5);
    const script = p.script('line1 "q"\nline2\\x');
    assert.ok(script.includes('set the clipboard to "line1 \\"q\\"" & return & "line2\\\\x"'));
    assert.ok(script.includes('tell application "Weird \\"App\\"" to activate'));
    assert.ok(script.includes("delay 1.5"));
    assert.ok(script.includes("keystroke return with command down"));
  });

  it("opens the URL when given", () => {
    const script = new ChatPusher().script("hi", { url: "grok://chat/frontend" });
    assert.ok(script.includes('do shell script "open " & quoted form of "grok://chat/frontend"'));
    assert.ok(!script.includes("to activate"));
  });

  it("enables chat from the environment", async () => {
    await withEnv(
      { PI_WAVE_NOTIFY: "off", PI_WAVE_CHAT_PUSH: "on", PI_WAVE_CHAT_APP: "TestApp" },
      async () => {
        const n = Notifier.create(plan, path.join(tmp, "p"))!;
        assert.ok(n.chat instanceof ChatPusher);
        assert.equal(n.chat.app, "TestApp");
        assert.equal(n.roleAppTmpl, "{role}");
        assert.equal(n.roleUrlTmpl, "");
        await n.close();
      },
    );
    await withEnv(
      { PI_WAVE_NOTIFY: "off", PI_WAVE_CHAT_PUSH: "off" },
      async () => {
        const n = Notifier.create(plan, path.join(tmp, "p2"))!;
        assert.equal(n.chat, null);
        await n.close();
      },
    );
  });
});
