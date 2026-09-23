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

describe("pane settled", () => {
  it("is already changed and stable before the first poll", async () => {
    // the common real case: by the time status-based recovery gives up
    // (two attempts x up to 60s each), the agent has often long since
    // finished and gone quiet - the pane must already differ from the
    // pre-send baseline and be stable, with no further waiting needed.
    const b = backendWithReads(() => "prompt + PI-WAVE-OMP-OK + idle prompt");
    assert.equal(await b.waitPaneSettled("x", "empty pane", 5, 0), true);
  });

  it("returns false when the pane never differs from the baseline", async () => {
    const b = backendWithReads(() => "same as baseline");
    assert.equal(await b.waitPaneSettled("x", "same as baseline", 0.05, 0), false);
  });

  it("returns false while the pane keeps changing", async () => {
    let n = 0;
    const b = backendWithReads(() => `typing ${n++}`); // never repeats → never stable
    assert.equal(await b.waitPaneSettled("x", "empty pane", 0.05, 0), false);
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
  sessionArg() {
    const i = this.cmd.indexOf("--session");
    return i === -1 ? null : this.cmd[i + 1]!;
  }
}

const assistant = (text: string) =>
  JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";

describe("replies from pi session files", () => {
  it("gives each pi agent its own session file and omp none", async () => {
    const b = new SessionBackend();
    await b.startAgent("orchestrator", "p1", "openai-codex/gpt-5.5", null, "high");
    assert.ok(b.sessionArg()!.endsWith("orchestrator.jsonl"));
    await b.startAgent("qa", "p2", "claude-sonnet-5", null, "high", { kind: "omp" });
    assert.equal(b.sessionArg(), null);
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

  it("falls back to the pane scrollback for omp agents", async () => {
    const b = new SessionBackend();
    await b.startAgent("qa", "p2", "claude-sonnet-5", null, "high", { kind: "omp" });
    assert.equal(await b.reply("qa", await b.checkpoint("qa")), "pane scrollback");
  });
});
