// Tests for the display field, Herdr backend parsing, stall mapping, waits
// and the pane grid (no Herdr needed). Run from the repo root: npm test

import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AgentTimeoutError } from "./errors.ts";
import { HerdrBackend, HerdrBlocked, HerdrPromptStalled, PaneLayout, findKey } from "./herdr.ts";
import { PlanError, loadPlan, resolveDisplay } from "./plan.ts";

type Json = Record<string, any>;

function setup() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-wave-herdr-"));
  const cwd = path.join(tmp, "proj");
  mkdirSync(cwd);
  const plan = (p: Json) => {
    const f = path.join(tmp, "plan.json");
    writeFileSync(f, JSON.stringify({ cwd, ...p }));
    return loadPlan(f);
  };
  return { tmp, cwd, plan };
}

const assignment = (over: Json = {}) => ({
  name: "wave-1-code",
  prompt: "do the thing",
  model: "kimi-coding/k3",
  files: [],
  ...over,
});

describe("auto display", () => {
  const saved = process.env.HERDR_ENV;
  afterEach(() => {
    if (saved === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = saved;
  });

  it("defaults to auto", () => {
    const p = setup().plan({ waves: [[assignment()]] });
    assert.equal(p.display, "auto");
    assert.equal(p.waves[0]![0]!.display, "auto");
  });

  it("resolveDisplay follows HERDR_ENV", () => {
    process.env.HERDR_ENV = "1";
    assert.equal(resolveDisplay("auto"), "herdr");
    delete process.env.HERDR_ENV;
    assert.equal(resolveDisplay("auto"), "headless");
    assert.equal(resolveDisplay("headless"), "headless");
    assert.equal(resolveDisplay("herdr"), "herdr");
  });
});

describe("display field", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));

  it("plan-level display is inherited", () => {
    const p = t.plan({ display: "herdr", waves: [[assignment()]] });
    assert.equal(p.waves[0]![0]!.display, "herdr");
    assert.equal(p.display, "herdr");
  });

  it("assignment display overrides the plan", () => {
    const p = t.plan({
      display: "herdr",
      waves: [[assignment(), assignment({ name: "wave-1-b", display: "headless" })]],
    });
    assert.equal(p.waves[0]![0]!.display, "herdr");
    assert.equal(p.waves[0]![1]!.display, "headless");
  });

  it("rejects a bad assignment display", () => {
    assert.throws(() => t.plan({ waves: [[assignment({ display: "tmux" })]] }), (e: Error) =>
      e instanceof PlanError && e.message.includes("display"));
  });

  it("rejects a bad plan display", () => {
    assert.throws(() => t.plan({ display: "screen", waves: [[assignment()]] }), (e: Error) =>
      e instanceof PlanError && e.message.includes("display"));
  });

  it("rejects a missing mcp_config file", () => {
    assert.throws(() => t.plan({ waves: [[assignment({ mcp_config: "/no/such/file.json" })]] }), (e: Error) =>
      e instanceof PlanError && e.message.includes("mcp_config"));
  });

  it("accepts an existing mcp_config file", () => {
    const cfg = path.join(t.tmp, "wigolo.mcp.json");
    writeFileSync(cfg, "{}");
    const p = t.plan({ waves: [[assignment({ mcp_config: cfg })]] });
    assert.equal(p.waves[0]![0]!.mcp_config, cfg);
  });
});

describe("herdr JSON parsing", () => {
  it("finds a nested pane_id", () => {
    const resp = { result: { pane: { pane_id: "w1:p7", tab_id: "w1:t1" } } };
    assert.equal(findKey(resp.result, "pane_id"), "w1:p7");
  });

  it("finds the argv list", () => {
    const resp = { result: { argv: ["pi", "--model", "kimi-coding/k3", "--thinking", "high"] } };
    assert.ok(findKey(resp.result, "argv").join(" ").includes("kimi-coding/k3"));
  });

  it("returns null for a missing key", () => {
    assert.equal(findKey({ a: { b: 1 } }, "pane_id"), null);
  });
});

/** HerdrBackend with the herdr process replaced by a canned result. */
class CannedBackend extends HerdrBackend {
  private readonly canned: [number, string, string];
  constructor(rc: number, out: string, err = "") {
    super("/tmp");
    this.canned = [rc, out, err];
  }
  protected override async run(): Promise<[number, string, string]> {
    return this.canned;
  }
  json(args: string[]) {
    return this.runJson(args);
  }
}

describe("stall mapping", () => {
  it("maps a stalled code to HerdrPromptStalled, a kind of timeout", async () => {
    const b = new CannedBackend(1, JSON.stringify({ error: { code: "agent_prompt_stalled", message: "no change" } }));
    await assert.rejects(b.json(["agent", "prompt", "x", "--wait"]), (e: Error) =>
      e instanceof HerdrPromptStalled && e instanceof AgentTimeoutError && e.message.includes("no change"));
  });

  it("maps a timeout code to a plain timeout", async () => {
    const b = new CannedBackend(1, JSON.stringify({ error: { code: "timeout", message: "too slow" } }));
    await assert.rejects(b.json(["agent", "prompt", "x", "--wait"]), (e: Error) =>
      e instanceof AgentTimeoutError && !(e instanceof HerdrPromptStalled));
  });

  it("maps herdr 0.9.1's stall, whose message mentions 'blocked', to a stall", async () => {
    // captured live from a kind=omp QA agent: the prose names the states it
    // waited for, so matching "blocked" in the text reported a booting agent
    // as sitting at an approval dialog and skipped stall recovery
    const payload = JSON.stringify({
      error: {
        code: "agent_prompt_stalled",
        message: "agent prompt produced no observed working or blocked state within 5000 ms; current status is idle",
      },
      id: "cli:agent:prompt",
    });
    for (const b of [new CannedBackend(1, payload), new CannedBackend(1, "", payload)]) {
      await assert.rejects(b.json(["agent", "prompt", "x", "--wait"]), HerdrPromptStalled);
    }
  });

  it("still maps code-less output that says blocked to HerdrBlocked", async () => {
    const b = new CannedBackend(1, "", "error: agent is blocked on a permission prompt");
    await assert.rejects(b.json(["agent", "prompt", "x", "--wait"]), HerdrBlocked);
  });

  it("maps a blocked code to HerdrBlocked", async () => {
    const b = new CannedBackend(1, JSON.stringify({ error: { code: "agent_blocked" } }));
    await assert.rejects(b.json(["agent", "prompt", "x", "--wait"]), HerdrBlocked);
  });
});

function backendWithStates(statuses: Json[]): HerdrBackend {
  const b = new HerdrBackend("/tmp");
  let i = 0;
  b.state = async () => statuses[Math.min(i++, statuses.length - 1)]!;
  return b;
}
const st = (status: string) => ({ result: { agent: { status } } });

describe("backend waits", () => {
  it("waitLateStart returns the first non-idle status", async () => {
    const b = backendWithStates([st("idle"), st("idle"), st("working")]);
    assert.equal(await b.waitLateStart("x", 5, 0), "working");
  });

  it("waitLateStart returns null when idle throughout", async () => {
    const b = backendWithStates([st("idle")]);
    assert.equal(await b.waitLateStart("x", 0.05, 0), null);
  });

  it("waitSettled returns on idle", async () => {
    const b = backendWithStates([st("working"), st("working"), st("idle")]);
    await b.waitSettled("x", 5, 0);
  });

  it("waitSettled raises on blocked", async () => {
    const b = backendWithStates([st("blocked")]);
    await assert.rejects(b.waitSettled("x", 5, 0), HerdrBlocked);
  });

  it("waitSettled times out while still working", async () => {
    const b = backendWithStates([st("working")]);
    await assert.rejects(b.waitSettled("x", 0.05, 0), (e: Error) =>
      e instanceof AgentTimeoutError && e.message.includes("last status: working"));
  });

  it("waitLateStart reads the real herdr agent_status shape", async () => {
    // herdr 0.8.2's `agent get` response, captured live: the key is
    // 'agent_status', and there is no 'status' key anywhere in it. A lookup
    // for bare 'status' always misses this shape and reports 'unknown',
    // making every wait see the agent as perpetually idle.
    const b = backendWithStates([
      { result: { agent: { agent: "omp", agent_status: "working", name: "x", pane_id: "w1:p1Q" } } },
    ]);
    assert.equal(await b.waitLateStart("x", 5, 0), "working");
  });

  it("prefers agent_status over status", () => {
    assert.equal(HerdrBackend.agentStatus({ result: { agent: { agent_status: "working", status: "idle" } } }), "working");
  });
});

function backendWithReads(read: () => string): HerdrBackend {
  const b = new HerdrBackend("/tmp");
  b.read = async () => read();
  return b;
}

/** Pane reads that follow `script`, then keep changing forever. */
function scriptedReads(script: string[]): () => string {
  let n = 0;
  return () => script[n++] ?? `working ${n}`;
}

const before = { scrollback: "empty pane", prompts: 0, replies: 0, busy: false };

describe("waitDone without a session file", () => {
  it("returns once the pane changed and then held still for the quiet period", async () => {
    const b = backendWithReads(() => "prompt + PI-WAVE-OMP-OK + idle prompt");
    await b.waitDone("x", before, 5, 5, 0.01, 0.05);
  });

  it("keeps waiting through a quiet 2-3s pause mid-work", async () => {
    // a thinking agent can leave its pane untouched for a few seconds; two
    // identical reads 1s apart used to be called "done" right there
    const b = backendWithReads(scriptedReads(["booted", ...Array(5).fill("thinking")]));
    await assert.rejects(b.waitDone("x", before, 3.5, 60, 0.5), (e: Error) =>
      e instanceof AgentTimeoutError && e.message.includes("still working"));
  });

  it("says it likely never booted when the pane never changed", async () => {
    const b = backendWithReads(() => "empty pane");
    await assert.rejects(b.waitDone("x", before, 5, 0.05, 0.01), (e: Error) =>
      e instanceof AgentTimeoutError && e.message.includes("never changed") && e.message.includes("never finished booting"));
  });

  it("keeps waiting past the boot window while the pane keeps changing", async () => {
    const b = backendWithReads(scriptedReads([]));
    await assert.rejects(b.waitDone("x", before, 0.2, 0.02, 0.01), (e: Error) =>
      e instanceof AgentTimeoutError && e.message.includes("still working") && !e.message.includes("booting"));
  });
});

describe("PaneLayout", () => {
  it("puts the orchestrator right, opens the row down, then fills right", async () => {
    const calls: [string | null, string, number][] = [];
    let id = 0;
    const b = {
      async splitPane(paneId: string | null = null, direction: "right" | "down" = "right", ratio = 0.5) {
        calls.push([paneId, direction, ratio]);
        return `p${++id}`;
      },
    };
    const layout = new PaneLayout();
    const orch = await layout.nextSplit(b, 0.4);
    const a1 = await layout.nextSplit(b);
    const a2 = await layout.nextSplit(b);
    await layout.nextSplit(b);
    // orchestrator: engine's own pane, to the right, wider ratio
    assert.deepEqual(calls[0], [null, "right", 0.4]);
    // first assignment drops down off the orchestrator to open the row
    assert.deepEqual(calls[1], [orch, "down", 0.5]);
    // every later assignment fills right along that same row
    assert.deepEqual(calls[2], [a1, "right", 0.5]);
    assert.deepEqual(calls[3], [a2, "right", 0.5]);
  });

  it("keeps the chain deterministic when a wave splits concurrently", async () => {
    const calls: [string | null, string][] = [];
    let id = 0;
    const b = {
      async splitPane(paneId: string | null = null, direction: "right" | "down" = "right") {
        calls.push([paneId, direction]);
        await new Promise((r) => setTimeout(r, 5 - id)); // later calls finish sooner
        return `p${++id}`;
      },
    };
    const layout = new PaneLayout();
    await Promise.all([layout.nextSplit(b), layout.nextSplit(b), layout.nextSplit(b)]);
    assert.deepEqual(calls, [[null, "right"], ["p1", "down"], ["p2", "right"]]);
  });
});

describe("cancellation", () => {
  it("kills a running herdr command when the signal aborts", async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), "pi-wave-herdr-bin-"));
    writeFileSync(path.join(bin, "herdr"), "#!/bin/sh\nsleep 30\n");
    chmodSync(path.join(bin, "herdr"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    try {
      const controller = new AbortController();
      const b = new HerdrBackend("/tmp", controller.signal);
      const started = performance.now();
      setTimeout(() => controller.abort(), 100);
      await assert.rejects(b.prompt("x", "hi", 600), { name: "AbortError" });
      assert.ok(performance.now() - started < 5_000, "prompt waited out the fake herdr");
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

/** HerdrBackend whose herdr commands all succeed, with a scripted status. */
class SettledBackend extends HerdrBackend {
  private readonly status: string;
  constructor(status: string) {
    super("/tmp");
    this.status = status;
  }
  protected override async runJson(args: string[]) {
    if (args[1] === "get") return { result: { agent: { agent_status: this.status } } };
    return { result: {} };
  }
}

describe("prompt settle state", () => {
  it("reports an agent that settled on an approval dialog as blocked", async () => {
    // `prompt --wait` returns successfully on blocked as well as idle/done,
    // so without a status check a half-done agent would read as finished
    await assert.rejects(new SettledBackend("blocked").prompt("qa", "review", 60), HerdrBlocked);
  });

  it("accepts an agent that settled idle or done", async () => {
    await new SettledBackend("idle").prompt("qa", "review", 60);
    await new SettledBackend("done").prompt("qa", "review", 60);
  });
});

/** HerdrBackend whose herdr process answers from a script, the last
 * reply repeating. */
class ScriptedBackend extends HerdrBackend {
  calls = 0;
  private readonly replies: [number, string, string][];
  constructor(replies: [number, string, string][]) {
    super("/tmp");
    this.replies = replies;
  }
  protected override async run(): Promise<[number, string, string]> {
    return this.replies[Math.min(this.calls++, this.replies.length - 1)]!;
  }
}

// herdr 0.9.1, captured live: `agent start` right after `pane split`
// sometimes lands before the new pane's shell is up, and herdr refuses at
// once instead of waiting; the same start ~0.5s later succeeds
const paneBusy: [number, string, string] = [
  1,
  JSON.stringify({
    error: { code: "agent_pane_busy", message: "agent target pane w1:p11 is not an available shell" },
    id: "cli:agent:start",
  }),
  "",
];
const started: [number, string, string] = [
  0,
  JSON.stringify({ result: { agent: { argv: ["pi", "--model", "openai-codex/gpt-5.5"] } } }),
  "",
];

describe("startAgent on a fresh pane", () => {
  it("retries while the new pane's shell is not up yet", async () => {
    const b = new ScriptedBackend([paneBusy, paneBusy, started]);
    await b.startAgent("design", "w1:p11", "openai-codex/gpt-5.5", null, "high", { pollS: 0 });
    assert.equal(b.calls, 3);
  });

  it("gives up with herdr's error once the pane stays busy", async () => {
    const b = new ScriptedBackend([paneBusy]);
    await assert.rejects(
      b.startAgent("design", "w1:p11", "openai-codex/gpt-5.5", null, "high", { readyS: 0.05, pollS: 0 }),
      (e: Error) => e.message.includes("agent_pane_busy"),
    );
    assert.ok(b.calls > 1);
  });

  it("does not retry other start errors", async () => {
    const taken: [number, string, string] = [1, JSON.stringify({ error: { code: "agent_name_taken" } }), ""];
    const b = new ScriptedBackend([taken, started]);
    await assert.rejects(b.startAgent("design", "w1:p11", "openai-codex/gpt-5.5", null, "high", { pollS: 0 }));
    assert.equal(b.calls, 1);
  });
});

/** HerdrBackend that records the herdr command startAgent builds and
 * serves a fixed pane scrollback. */
class SessionBackend extends HerdrBackend {
  cmd: string[] = [];
  constructor() {
    super("/tmp");
  }
  protected override async runJson(args: string[]) {
    this.cmd = args;
    return { result: { argv: ["pi", "--model", args[args.indexOf("--model") + 1]] } };
  }
  override async read() {
    return "pane scrollback";
  }
  sessionArg(flag = "--session") {
    const i = this.cmd.indexOf(flag);
    return i === -1 ? null : this.cmd[i + 1]!;
  }
}

const assistant = (text: string, stopReason?: string) =>
  JSON.stringify({ type: "message", message: { role: "assistant", stopReason, content: [{ type: "text", text }] } }) + "\n";
const user = (text: string) =>
  JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";

/** Where OMP puts its session inside the --session-dir it was given
 * (captured from omp v18.2.11): a timestamped file plus a hidden lock. */
function ompSession(dir: string, lines: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".2026-09-23T10-11-49-553Z_01a0cdc0.jsonl.lock.os"), "");
  const file = path.join(dir, "2026-09-23T10-11-49-553Z_01a0cdc0.jsonl");
  writeFileSync(file, lines);
  return file;
}

describe("replies from pi session files", () => {
  it("gives each pi agent its own session file and each omp agent its own session dir", async () => {
    // omp has no --session <file>; --session-dir <dir> makes it write
    // <dir>/<timestamp>_<id>.jsonl directly (no per-cwd subfolder)
    const b = new SessionBackend();
    await b.startAgent("orchestrator", "p1", "openai-codex/gpt-5.5", null, "high");
    assert.ok(b.sessionArg()!.endsWith("orchestrator.jsonl"));
    await b.startAgent("qa", "p2", "claude-sonnet-5", null, "high", { kind: "omp" });
    assert.equal(b.sessionArg(), null);
    assert.equal(path.basename(b.sessionArg("--session-dir")!), "qa");
  });

  it("returns only the answer to this prompt, never an earlier one", async () => {
    // the orchestrator pane reviews every agent in one session: reading its
    // scrollback returned the FIRST verdict on screen, i.e. a previous agent's
    const b = new SessionBackend();
    await b.startAgent("orchestrator", "p1", "openai-codex/gpt-5.5", null, "high");
    const file = b.sessionArg()!;
    writeFileSync(file, JSON.stringify({ type: "session" }) + "\n" + assistant("VERDICT: pass"));
    const since = await b.checkpoint("orchestrator");
    assert.equal(since.replies, 1);
    appendFileSync(file, assistant("") + assistant("VERDICT: fail\n- add alt text") + '{"type":"mess');
    assert.equal(await b.reply("orchestrator", since, 0.05, 0), "VERDICT: fail\n- add alt text");
  });

  it("returns nothing when the agent gave no new answer", async () => {
    const b = new SessionBackend();
    await b.startAgent("orchestrator", "p1", "openai-codex/gpt-5.5", null, "high");
    writeFileSync(b.sessionArg()!, assistant("VERDICT: pass"));
    const since = await b.checkpoint("orchestrator");
    assert.equal(await b.reply("orchestrator", since, 0.05, 0), "");
  });

  it("waits briefly for a reply written just after the agent settled", async () => {
    const b = new SessionBackend();
    await b.startAgent("builder", "p1", "kimi-coding/k3", null, "high");
    const since = await b.checkpoint("builder"); // no session file yet
    assert.equal(since.replies, 0);
    setTimeout(() => writeFileSync(b.sessionArg()!, assistant("done")), 50);
    assert.equal(await b.reply("builder", since, 2, 0.01), "done");
  });

  it("presses Enter for a fix round still in omp's editor, not for one it received", async () => {
    // nasa-site-qa-retry-2: qa2 answered its first prompt, then a 140-line
    // FIX ROUND sat in the editor as a collapsed paste (📄 #2)
    const b = new SessionBackend();
    await b.startAgent("qa2", "p2", "claude-sonnet-5", null, "high", { kind: "omp" });
    const file = ompSession(b.sessionArg("--session-dir")!, user("review the site") + assistant("QA: all pass", "stop"));
    const since = await b.checkpoint("qa2");
    assert.equal(since.prompts, 1);
    assert.equal(await b.submitPending("qa2", since), true);
    assert.deepEqual(b.cmd, ["agent", "send-keys", "qa2", "Enter"]);
    appendFileSync(file, user("FIX ROUND 1/2"));
    assert.equal(await b.submitPending("qa2", since), false);
  });

  it("reads an omp agent's reply from its session, not the pane", async () => {
    // reading the pane returned OMP's splash screen as the agent's answer
    const b = new SessionBackend();
    await b.startAgent("qa", "p2", "claude-sonnet-5", null, "high", { kind: "omp" });
    const since = await b.checkpoint("qa"); // omp has not created its file yet
    assert.equal(since.replies, 0);
    ompSession(b.sessionArg("--session-dir")!,
      user("check the site") + assistant("screenshots taken", "toolUse") + assistant("QA: 2 issues found", "stop"));
    assert.equal(await b.reply("qa", since, 0.05, 0), "QA: 2 issues found");
  });

  it("does not count a mid-turn tool-use message as a reply", async () => {
    const b = new SessionBackend();
    await b.startAgent("builder", "p1", "kimi-coding/k3", null, "high");
    writeFileSync(b.sessionArg()!, user("build it") + assistant("let me look first", "toolUse"));
    const since = await b.checkpoint("builder");
    assert.equal(since.replies, 0);
    assert.equal(since.busy, true);
    assert.equal(await b.reply("builder", since, 0.05, 0), "");
  });

  it("is not busy once its last turn finished, even with an error", async () => {
    const b = new SessionBackend();
    await b.startAgent("builder", "p1", "kimi-coding/k3", null, "high");
    writeFileSync(b.sessionArg()!, user("build it") + assistant("", "error"));
    assert.equal((await b.checkpoint("builder")).busy, false);
  });
});

describe("waitDone with a session file", () => {
  it("waits through tool use and quiet pauses until a finished reply lands", async () => {
    const b = new SessionBackend();
    await b.startAgent("qa", "p2", "claude-sonnet-5", null, "high", { kind: "omp" });
    const dir = b.sessionArg("--session-dir")!;
    const since = { scrollback: "shell prompt", prompts: 0, replies: 0, busy: false };
    // the pane ("pane scrollback") never moves again after its first change:
    // a pane-only check would have called this done straight away
    const file = ompSession(dir, user("check the site") + assistant("", "toolUse"));
    setTimeout(() => appendFileSync(file, assistant("QA: all good", "stop")), 150);
    const started = performance.now();
    await b.waitDone("qa", since, 5, 5, 0.01, 0.01);
    assert.ok(performance.now() - started >= 140, "returned before the reply landed");
    assert.equal(await b.reply("qa", since, 0, 0), "QA: all good");
  });

  it("times out as still working while the pane changes but no reply lands", async () => {
    const b = new SessionBackend();
    await b.startAgent("qa", "p2", "claude-sonnet-5", null, "high", { kind: "omp" });
    let n = 0;
    b.read = async () => `working ${n++}`;
    await assert.rejects(b.waitDone("qa", { scrollback: "", prompts: 0, replies: 0, busy: false }, 0.1, 0.02, 0.01), (e: Error) =>
      e instanceof AgentTimeoutError && e.message.includes("still working"));
  });

  it("times out as gone quiet when the pane stopped changing without a reply", async () => {
    const b = new SessionBackend();
    await b.startAgent("qa", "p2", "claude-sonnet-5", null, "high", { kind: "omp" });
    await assert.rejects(b.waitDone("qa", { scrollback: "", prompts: 0, replies: 0, busy: false }, 0.1, 0.02, 0.01, 0.03), (e: Error) =>
      e instanceof AgentTimeoutError && e.message.includes("without finishing a reply"));
  });
});
