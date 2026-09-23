// Tests for the wave loop, orchestrator role pinning and herdr stall
// recovery (no Herdr, no pi). Run from the repo root: npm test

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { HerdrBackend, HerdrPromptStalled } from "./herdr.ts";
import {
  type Deps,
  type HerdrLike,
  ORCH_ROLE_SYSTEM_PROMPT,
  OrchestratorPane,
  SYNTH_ROLE_SYSTEM_PROMPT,
  type SessionLike,
  orchestrate,
  buildPrompt,
  parseVerdict,
  runAssignmentHerdr,
  runAssignmentRpc,
  runReview,
} from "./orchestrator.ts";
import { type OrchestratorSpec, loadPlan } from "./plan.ts";

type Json = Record<string, any>;

function writePlan(p: Json) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-wave-orch-"));
  const cwd = path.join(tmp, "proj");
  mkdirSync(cwd);
  const f = path.join(tmp, "plan.json");
  writeFileSync(f, JSON.stringify({ name: "t", cwd, ...p }));
  return loadPlan(f);
}

const spec = (over: Partial<OrchestratorSpec> = {}): OrchestratorSpec => ({
  model: "openai-codex/gpt-5.5",
  thinking: "high",
  synthesis_model: "",
  synthesis_thinking: "",
  ...over,
});

/** Records startAgent calls; enough of HerdrBackend for OrchestratorPane. */
class RecordingBackend {
  started: Json[] = [];
  prompts: string[] = [];
  async startAgent(name: string, _pane: string, model: string, _provider: string | null, thinking: string,
    { systemPrompt = "" }: { systemPrompt?: string } = {}) {
    this.started.push({ name, model, thinking, systemPrompt });
    return ["pi", "--model", model, "--thinking", thinking];
  }
  async prompt(_name: string, text: string) {
    this.prompts.push(text);
  }
  async checkpoint() {
    return { scrollback: "", replies: 0 };
  }
  async reply() {
    return "ok";
  }
}

const fakeLayout = (panes: string[]) => ({ nextSplit: async () => panes.shift() ?? "pane-x" });

describe("orchestrator role prompt", () => {
  it("pins the role system prompt at start", async () => {
    const backend = new RecordingBackend();
    const orch = new OrchestratorPane(backend as unknown as HerdrLike, spec(), fakeLayout(["p-orch"]));
    await orch.start();
    assert.equal(backend.started[0]!.name, "orchestrator");
    assert.equal(backend.started[0]!.systemPrompt, ORCH_ROLE_SYSTEM_PROMPT);
  });

  it("gives the synthesizer its dedicated role prompt", async () => {
    const backend = new RecordingBackend();
    const orch = new OrchestratorPane(
      backend as unknown as HerdrLike,
      spec({ synthesis_model: "openai-codex/gpt-5.5" }),
      fakeLayout(["p-orch", "p-synth"]),
    );
    await orch.synthesize(new Map());
    assert.equal(backend.started[0]!.name, "synthesizer");
    assert.equal(backend.started[0]!.systemPrompt, SYNTH_ROLE_SYSTEM_PROMPT);
  });
});

/** Captures the herdr command startAgent builds. */
class StubBackend extends HerdrBackend {
  cmd: string[] = [];
  constructor() {
    super("/tmp");
  }
  protected override async runJson(args: string[]) {
    this.cmd = args;
    const model = args[args.indexOf("--model") + 1];
    return { result: { argv: ["pi", "--model", model, "--thinking", "high"] } };
  }
}

describe("startAgent system prompt", () => {
  it("passes the system prompt to herdr", async () => {
    const b = new StubBackend();
    await b.startAgent("orchestrator", "p1", "openai-codex/gpt-5.5", null, "high", {
      systemPrompt: "never implement assignments",
    });
    assert.equal(b.cmd[b.cmd.indexOf("--append-system-prompt") + 1], "never implement assignments");
  });

  it("adds no flag without a system prompt", async () => {
    const b = new StubBackend();
    await b.startAgent("wave-1-code", "p1", "kimi-coding/k3", null, "high");
    assert.ok(!b.cmd.includes("--append-system-prompt"));
  });

  it("uses a bare model id for omp and never pins a system prompt there", async () => {
    const b = new StubBackend();
    await b.startAgent("qa", "p1", "anthropic/claude-sonnet-5", null, "high", { kind: "omp", systemPrompt: "x" });
    assert.equal(b.cmd[b.cmd.indexOf("--model") + 1], "claude-sonnet-5");
    assert.ok(!b.cmd.includes("--append-system-prompt"));
  });
});

describe("parseVerdict", () => {
  it("passes on the first VERDICT line", () => {
    assert.deepEqual(parseVerdict("thinking...\nVERDICT: PASS\nnothing"), [true, ""]);
  });
  it("returns the feedback after a fail", () => {
    assert.deepEqual(parseVerdict("VERDICT: fail\n- add tests\n- fix typo"), [false, "- add tests\n- fix typo"]);
  });
  it("fails without a VERDICT line", () => {
    const [ok, feedback] = parseVerdict("looks fine to me");
    assert.equal(ok, false);
    assert.ok(feedback.includes("no VERDICT line"));
  });
});

/** Stands in for HerdrBackend in runAssignmentHerdr.
 *
 * promptCalls: per-attempt outcome for prompt() - an Error to throw (e.g.
 * HerdrPromptStalled) or null for success; attempts past the list succeed.
 * lateStart: what waitLateStart reports (null = agent never woke → resend
 * path; a status string = late wake). */
class FakeHerdrBackend implements HerdrLike {
  promptsSent = 0;
  private readonly promptCalls: (Error | null)[];
  private readonly lateStart: string | null;
  private readonly paneSettled: boolean;

  constructor({ promptCalls = [], lateStart = null, paneSettled = false }:
    { promptCalls?: (Error | null)[]; lateStart?: string | null; paneSettled?: boolean } = {}) {
    this.promptCalls = [...promptCalls];
    this.lateStart = lateStart;
    this.paneSettled = paneSettled;
  }
  async splitPane() {
    return "w1:pF";
  }
  async startAgent(_n: string, _p: string, model: string) {
    return ["fake", "--model", model];
  }
  async prompt() {
    this.promptsSent += 1;
    const outcome = this.promptCalls.shift();
    if (outcome) throw outcome;
  }
  async checkpoint() {
    return { scrollback: "before", replies: 0 };
  }
  async reply() {
    return "all done";
  }
  async waitLateStart() {
    return this.lateStart;
  }
  async waitSettled() {}
  async waitPaneSettled() {
    return this.paneSettled;
  }
}

const noSleep = async () => {};

function fakeDeps(over: Partial<Deps> = {}): Deps {
  return {
    herdrAvailable: () => null,
    herdrBackend: () => new FakeHerdrBackend(),
    rpcSession: () => {
      throw new Error("no pi in tests");
    },
    sleep: noSleep,
    listModels: async () => null,
    ...over,
  };
}

async function runWith(fake: FakeHerdrBackend, kind = "pi") {
  const plan = writePlan({
    waves: [[{
      name: "probe",
      prompt: "do it",
      model: kind === "omp" ? "claude-sonnet-5" : "kimi-coding/k3",
      kind,
      files: [],
      display: "herdr",
    }]],
  });
  const events: Json[] = [];
  await runAssignmentHerdr(plan.waves[0]![0]!, 0, plan, new Map(), (e) => events.push(e), null, null,
    fakeDeps({ herdrBackend: () => fake }));
  return events;
}

const doneOf = (events: Json[]) => events.find((e) => e.type === "agent_done")!;
const count = (events: Json[], type: string) => events.filter((e) => e.type === type).length;
const stalled = () => new HerdrPromptStalled("stalled");

describe("herdr stall recovery", () => {
  it("resends once after a stall and passes", async () => {
    const fake = new FakeHerdrBackend({ promptCalls: [stalled()], lateStart: null });
    const events = await runWith(fake);
    assert.equal(count(events, "prompt_stall_recovery"), 1);
    assert.equal(doneOf(events).status, "pass");
    assert.equal(fake.promptsSent, 2);
  });

  it("does not resend when the stalled submission starts late", async () => {
    const fake = new FakeHerdrBackend({ promptCalls: [stalled()], lateStart: "working" });
    const events = await runWith(fake);
    assert.equal(doneOf(events).status, "pass");
    assert.equal(fake.promptsSent, 1);
  });

  it("times out honestly after a double stall", async () => {
    const fake = new FakeHerdrBackend({ promptCalls: [stalled(), stalled()], lateStart: null });
    const events = await runWith(fake);
    assert.equal(doneOf(events).status, "timeout");
    assert.equal(fake.promptsSent, 2);
    assert.equal(count(events, "prompt_stall_recovery"), 2);
  });

  it("lets the pane-settled fallback save a false timeout", async () => {
    const fake = new FakeHerdrBackend({ promptCalls: [stalled(), stalled()], lateStart: null, paneSettled: true });
    const events = await runWith(fake);
    assert.equal(doneOf(events).status, "pass");
    assert.equal(count(events, "prompt_stall_pane_check"), 1);
  });

  it("omp skips the resend and goes straight to the pane check", async () => {
    // kind=omp never reports a non-idle agent_status at all (confirmed
    // live), so a second blind attempt would just re-submit the same prompt
    // to an agent already working or already done.
    const fake = new FakeHerdrBackend({ promptCalls: [stalled()], lateStart: null, paneSettled: true });
    const events = await runWith(fake, "omp");
    assert.equal(doneOf(events).status, "pass");
    assert.equal(fake.promptsSent, 1); // no resend
    assert.equal(count(events, "prompt_stall_recovery"), 1);
    assert.equal(count(events, "prompt_stall_pane_check"), 1);
  });

  it("omp that stays idle times out after one attempt", async () => {
    const fake = new FakeHerdrBackend({ promptCalls: [stalled()], lateStart: null, paneSettled: false });
    const events = await runWith(fake, "omp");
    assert.equal(doneOf(events).status, "timeout");
    assert.equal(fake.promptsSent, 1);
  });

  it("watches 10s for pi and 60s for omp", async () => {
    const pi = await runWith(new FakeHerdrBackend({ promptCalls: [stalled()], lateStart: "working" }));
    assert.equal(pi.find((e) => e.type === "prompt_stall_recovery")!.watch_s, 10);
    const omp = await runWith(new FakeHerdrBackend({ promptCalls: [stalled()], lateStart: "working" }), "omp");
    assert.equal(omp.find((e) => e.type === "prompt_stall_recovery")!.watch_s, 60);
  });

  it("reports a blocked late start as blocked", async () => {
    const fake = new FakeHerdrBackend({ promptCalls: [stalled()], lateStart: "blocked" });
    assert.equal(doneOf(await runWith(fake)).status, "blocked");
  });
});

/** Scripted SessionLike: every prompt settles with the given text. */
function fakeSession(text: string) {
  const s = {
    closed: false,
    prompts: [] as string[],
    start: async () => ({ model: { id: "k3" } }),
    verifyModel: () => {},
    promptAndSettle: async (m: string) => void s.prompts.push(m),
    lastText: async () => text,
    stats: async () => ({ tokens: { input: 1 }, cost: 0.5 }),
    close: async () => void (s.closed = true),
  };
  return s;
}

describe("headless assignment", () => {
  it("runs one consolidated fix round per failed review, then fails", async () => {
    const plan = writePlan({
      waves: [[{
        name: "fixer",
        prompt: "p",
        model: "kimi-coding/k3",
        files: ["a.txt"],
        review_cmd: "echo DELIVERABLE MISSING; exit 1",
        max_fix_rounds: 2,
      }]],
    });
    const sess = fakeSession("tried");
    const events: Json[] = [];
    const res = await runAssignmentRpc(plan.waves[0]![0]!, 0, plan, new Map(), (e) => events.push(e),
      fakeDeps({ rpcSession: () => sess as unknown as SessionLike }));
    assert.equal(res.status, "fail");
    assert.equal(res.rounds, 3);
    assert.ok(res.feedback.includes("DELIVERABLE MISSING"));
    assert.equal(count(events, "review_failed"), 3);
    assert.ok(sess.prompts[1]!.startsWith("FIX ROUND 1/2"));
    assert.ok(sess.prompts[2]!.startsWith("FIX ROUND 2/2"));
    assert.ok(sess.closed);
  });

  it("refuses kind=omp without a pane", async () => {
    const plan = writePlan({
      waves: [[{ name: "qa", prompt: "p", model: "claude-sonnet-5", kind: "omp", display: "headless" }]],
    });
    const res = await runAssignmentRpc(plan.waves[0]![0]!, 0, plan, new Map(), () => {}, fakeDeps());
    assert.equal(res.status, "error");
    assert.ok(res.error.includes("kind=omp requires display=herdr"));
  });
});

function wavePlan(n: number, display: string) {
  return writePlan({
    name: "guard",
    waves: [Array.from({ length: n }, (_, i) => ({
      name: `agent-${i}`,
      prompt: "p",
      model: "kimi-coding/k3",
      files: [],
      display,
    }))],
  });
}

async function runOrchestrate(plan: ReturnType<typeof wavePlan>) {
  const events: Json[] = [];
  const summary = await orchestrate(plan, (e) => events.push(e),
    fakeDeps({ rpcSession: () => fakeSession("done") as unknown as SessionLike }));
  return { events, summary };
}

describe("wave guard", () => {
  const saved = process.env.HERDR_ENV;
  afterEach(() => {
    if (saved === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = saved;
  });

  it("stops five herdr agents before dispatch", async () => {
    const { events, summary } = await runOrchestrate(wavePlan(5, "herdr"));
    // fail fast: the wave never started, so nothing was spawned
    assert.equal(count(events, "wave_start"), 0);
    assert.ok(events.find((e) => e.type === "stopped")!.reason.includes("4 agents per wave"));
    assert.equal(summary.status, "stopped");
    assert.ok(summary.reason.includes("4 agents per wave"));
  });

  it("dispatches four herdr agents", async () => {
    const { events, summary } = await runOrchestrate(wavePlan(4, "herdr"));
    assert.equal(count(events, "wave_start"), 1);
    assert.equal(summary.status, "completed");
    assert.equal(summary.reason, undefined);
  });

  it("puts no cap on headless waves", async () => {
    delete process.env.HERDR_ENV;
    const { summary } = await runOrchestrate(wavePlan(5, "auto")); // resolves headless
    assert.equal(summary.status, "completed");
    assert.equal(summary.waves[0].agents.length, 5);
    assert.deepEqual(summary.waves[0].agents[0].tokens, { input: 1 });
  });
});

describe("runReview", () => {
  it("passes on exit 0 and merges stdout with stderr", async () => {
    const [ok, out] = await runReview("echo out; echo err >&2", os.tmpdir(), "a");
    assert.equal(ok, true);
    assert.ok(out.includes("out") && out.includes("err"));
  });

  it("exposes the agent name to the command", async () => {
    const [, out] = await runReview("echo $PI_WAVE_AGENT", os.tmpdir(), "wave-1-code");
    assert.equal(out.trim(), "wave-1-code");
  });

  it("stops a long review when the run is aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = performance.now();
    const [ok] = await runReview("sleep 30", os.tmpdir(), "a", controller.signal);
    assert.equal(ok, false);
    assert.ok(performance.now() - started < 5_000);
  });
});

describe("model preflight", () => {
  const known = async () => new Set(["kimi-coding/k3", "openai-codex/gpt-5.5", "openai-codex/gpt-5.6-luna"]);

  it("stops before dispatch when pi cannot run a model the plan names", async () => {
    const plan = writePlan({
      waves: [
        [{ name: "ok", prompt: "p", model: "kimi-coding/k3", files: [] }],
        [{ name: "typo", prompt: "p", model: "k33", provider: "kimi-coding", files: [] }],
      ],
    });
    const events: Json[] = [];
    let spawned = 0;
    const summary = await orchestrate(plan, (e) => events.push(e), fakeDeps({
      listModels: known,
      rpcSession: () => (spawned++, fakeSession("x") as unknown as SessionLike),
    }));
    assert.equal(spawned, 0); // wave 1 was valid but nothing ran
    assert.equal(count(events, "wave_start"), 0);
    const reason = events.find((e) => e.type === "stopped")!.reason;
    assert.ok(reason.includes("kimi-coding/k33 (typo)"), reason);
    assert.equal(summary.status, "stopped");
    assert.equal(summary.reason, reason); // a tool caller only sees the summary
  });

  it("checks orchestrator and synthesizer models, never omp ones", async () => {
    const plan = writePlan({
      orchestrator: { model: "openai-codex/gpt-9", synthesis_model: "openai-codex/gpt-5.5" },
      waves: [[{ name: "qa", prompt: "p", model: "claude-sonnet-5", kind: "omp", display: "herdr" }]],
    });
    const { unknownModels } = await import("./orchestrator.ts");
    assert.deepEqual(await unknownModels(plan, fakeDeps({ listModels: known })), ["openai-codex/gpt-9 (orchestrator)"]);
  });

  it("runs when every model is known, and skips the check without a list", async () => {
    const plan = writePlan({ waves: [[{ name: "ok", prompt: "p", model: "kimi-coding/k3" }]] });
    const run = (listModels: Deps["listModels"]) =>
      orchestrate(plan, () => {}, fakeDeps({ listModels, rpcSession: () => fakeSession("x") as unknown as SessionLike }));
    assert.equal((await run(known)).status, "completed");
    assert.equal((await run(async () => null)).status, "completed");
  });
});

describe("long agent reports", () => {
  // seen live: a 14,804-char design spec reached the orchestrator cut to
  // 6,000 chars with no sign it was cut, so it failed review three times for
  // being "truncated" - a defect the agent could never fix
  const longSpec = "# Shared spec\n" + "- item\n".repeat(2400) + "## Responsive rules down to 375px"; // ~16.8K chars
  const plan = () => writePlan({ waves: [[{ name: "design", prompt: "p", model: "kimi-coding/k3" }], [{ name: "html", prompt: "p", model: "kimi-coding/k3", needs_results: ["design"] }]] });
  const result = (text: string) => ({ name: "design", wave: 1, model: "m", status: "pass" as const, rounds: 1, text, feedback: "", error: "", stats: {}, display: "headless" as const, pane: "" });

  it("reviews the whole report", async () => {
    const backend = new RecordingBackend();
    const orch = new OrchestratorPane(backend as unknown as HerdrLike, spec(), fakeLayout(["p"]));
    await orch.review(plan().waves[0]![0]!, longSpec);
    assert.ok(backend.prompts[0]!.includes("## Responsive rules down to 375px"));
  });

  it("hands the whole report to later waves", () => {
    const p = plan();
    const prompt = buildPrompt(p.waves[1]![0]!, new Map([["design", result(longSpec)]]));
    assert.ok(prompt.includes("## Responsive rules down to 375px"));
  });

  it("says so when a report is too long to pass on whole", async () => {
    const huge = "x".repeat(250_000);
    const backend = new RecordingBackend();
    const orch = new OrchestratorPane(backend as unknown as HerdrLike, spec(), fakeLayout(["p"]));
    await orch.review(plan().waves[0]![0]!, huge);
    assert.match(backend.prompts[0]!, /cut by the engine .* 250000 chars.* do not fail/s);
    const prompt = buildPrompt(plan().waves[1]![0]!, new Map([["design", result(huge)]]));
    assert.match(prompt, /cut by the engine .* 250000 chars/s);
  });
});
