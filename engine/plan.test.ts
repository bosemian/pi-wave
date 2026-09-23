// Unit tests for plan validation (no network, no pi required).
// Run from the repo root: npm test

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PlanError, applyOverrides, loadPlan, parsePlan, type Plan } from "./plan.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writePlan(tmp: string, plan: Record<string, unknown>): string {
  const f = path.join(tmp, "plan.json");
  writeFileSync(f, JSON.stringify(plan), "utf8");
  return f;
}

function baseAssignment(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "wave-1-code",
    prompt: "do the thing",
    model: "kimi-coding/k3",
    thinking: "high",
    files: ["src/a.py"],
    ...over,
  };
}

function assertPlanError(fn: () => unknown, includes?: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof PlanError, `expected PlanError, got ${String(e)}`);
    if (includes !== undefined) assert.ok(e.message.includes(includes), `'${includes}' not in: ${e.message}`);
    return true;
  });
}

let tmp: string;
let cwd: string;

function setUp(): void {
  tmp = mkdtempSync(path.join(os.tmpdir(), "pi-wave-plan-"));
  cwd = path.join(tmp, "proj");
  mkdirSync(cwd);
}

const load = (plan: Record<string, unknown>) => loadPlan(writePlan(tmp, { cwd, ...plan }));
const planWith = (over: Record<string, unknown> = {}): Plan => load({ waves: [[baseAssignment(over)]] });

describe("plan validation", () => {
  beforeEach(setUp);

  it("valid plan loads", () => {
    const p = load({
      name: "t",
      waves: [
        [baseAssignment(), baseAssignment({ name: "wave-1-review", files: [] })],
        [baseAssignment({ name: "wave-2-docs", files: ["docs/x.md"], needs_results: ["wave-1-code"] })],
      ],
    });
    assert.equal(p.waves.length, 2);
    assert.equal(p.waves[0]![0]!.name, "wave-1-code");
    assert.equal(p.waves[1]![0]!.name, "wave-2-docs");
    // model "kimi-coding/k3" is qualified, so no explicit provider field is needed
    assert.equal(p.waves[0]![0]!.provider, null);
  });

  it("same wave file conflict rejected", () => {
    assertPlanError(
      () => load({ waves: [[baseAssignment(), baseAssignment({ name: "wave-1-other", files: ["src/a.py"] })]] }),
      "file conflict",
    );
  });

  it("same file different waves ok", () => {
    const p = load({ waves: [[baseAssignment()], [baseAssignment({ name: "wave-2-docs", files: ["src/a.py"] })]] });
    assert.equal(p.waves.length, 2);
  });

  it("duplicate names rejected", () => {
    assertPlanError(
      () => load({ waves: [[baseAssignment()], [baseAssignment({ files: [] })]] }),
      "duplicate agent name",
    );
  });

  it("unqualified model without provider rejected", () => {
    assertPlanError(() => planWith({ model: "k3" }), "provider-qualified");
  });

  it("unqualified model with provider ok", () => {
    const p = planWith({ model: "k3", provider: "kimi-coding" });
    assert.equal(p.waves[0]![0]!.provider, "kimi-coding");
  });

  it("bad thinking rejected", () => {
    assertPlanError(() => planWith({ thinking: "ultra" }), "thinking");
  });

  it("needs_results from same wave rejected", () => {
    assertPlanError(
      () =>
        load({
          waves: [[baseAssignment(), baseAssignment({ name: "wave-1-other", files: [], needs_results: ["wave-1-code"] })]],
        }),
      "earlier wave",
    );
  });

  it("needs_results unknown agent rejected", () => {
    assertPlanError(() => planWith({ needs_results: ["ghost"] }), "unknown agent");
  });

  it("bad name rejected", () => {
    assertPlanError(() => planWith({ name: "Bad Name" }));
  });

  it("missing cwd rejected", () => {
    assertPlanError(
      () => loadPlan(writePlan(tmp, { cwd: "/definitely/not/a/real/dir/xyz", waves: [[baseAssignment()]] })),
      "cwd",
    );
  });
});

describe("kind and orchestrator", () => {
  beforeEach(setUp);

  it("kind defaults to pi", () => {
    assert.equal(planWith().waves[0]![0]!.kind, "pi");
  });

  it("bad kind rejected", () => {
    assertPlanError(() => planWith({ kind: "omp2" }), "kind");
  });

  it("omp accepts bare model", () => {
    const a = planWith({ kind: "omp", model: "claude-sonnet-5" }).waves[0]![0]!;
    assert.equal(a.kind, "omp");
    assert.equal(a.model, "claude-sonnet-5");
  });

  it("orchestrator true uses skill defaults", () => {
    const p = load({ orchestrator: true, waves: [[baseAssignment()]] });
    assert.equal(p.orchestrator?.model, "openai-codex/gpt-5.5");
    assert.equal(p.orchestrator?.thinking, "high");
  });

  it("orchestrator object custom", () => {
    const p = load({ orchestrator: { model: "kimi-coding/k3", thinking: "low" }, waves: [[baseAssignment()]] });
    assert.equal(p.orchestrator?.model, "kimi-coding/k3");
    assert.equal(p.orchestrator?.thinking, "low");
  });

  it("orchestrator unqualified model rejected", () => {
    assertPlanError(
      () => load({ orchestrator: { model: "gpt-5.6-sol" }, waves: [[baseAssignment()]] }),
      "provider-qualified",
    );
  });

  it("orchestrator bad thinking rejected", () => {
    assertPlanError(() => load({ orchestrator: { thinking: "ultra" }, waves: [[baseAssignment()]] }), "thinking");
  });

  it("orchestrator name reserved when enabled", () => {
    assertPlanError(
      () => load({ orchestrator: true, waves: [[baseAssignment({ name: "orchestrator" })]] }),
      "reserved",
    );
  });

  it("orchestrator name ok when disabled", () => {
    assert.equal(planWith({ name: "orchestrator" }).waves[0]![0]!.name, "orchestrator");
  });

  it("synthesis fields parse", () => {
    const p = load({
      orchestrator: {
        model: "openai-codex/gpt-5.5",
        synthesis_model: "openai-codex/gpt-5.6-sol",
        synthesis_thinking: "high",
      },
      waves: [[baseAssignment()]],
    });
    assert.equal(p.orchestrator?.model, "openai-codex/gpt-5.5");
    assert.equal(p.orchestrator?.synthesis_model, "openai-codex/gpt-5.6-sol");
    assert.equal(p.orchestrator?.synthesis_thinking, "high");
  });

  it("synthesis fields default empty", () => {
    const p = load({ orchestrator: true, waves: [[baseAssignment()]] });
    assert.equal(p.orchestrator?.synthesis_model, "");
  });

  it("unqualified synthesis model rejected", () => {
    assertPlanError(
      () => load({ orchestrator: { synthesis_model: "gpt-5.6-sol" }, waves: [[baseAssignment()]] }),
      "synthesis_model",
    );
  });

  it("bad synthesis thinking rejected", () => {
    assertPlanError(
      () =>
        load({
          orchestrator: { synthesis_model: "openai-codex/gpt-5.6-sol", synthesis_thinking: "ultra" },
          waves: [[baseAssignment()]],
        }),
      "synthesis_thinking",
    );
  });

  it("synthesizer name reserved when synthesis_model set", () => {
    assertPlanError(
      () =>
        load({
          orchestrator: { synthesis_model: "openai-codex/gpt-5.6-sol" },
          waves: [[baseAssignment({ name: "synthesizer" })]],
        }),
      "synthesizer",
    );
  });

  it("override skips qualification check for omp", () => {
    const p = planWith({ kind: "omp", model: "claude-sonnet-5" });
    applyOverrides(p, { model: "k3" }); // unqualified, but the agent is omp
    assert.equal(p.waves[0]![0]!.model, "k3");
  });
});

describe("overrides", () => {
  beforeEach(setUp);

  it("model override replaces assignment", () => {
    const p = applyOverrides(planWith(), { model: "anthropic/claude-x" });
    assert.equal(p.waves[0]![0]!.model, "anthropic/claude-x");
  });

  it("unqualified model override without provider rejected", () => {
    assertPlanError(() => applyOverrides(planWith(), { model: "k3" }), "provider");
  });

  it("unqualified model override keeps assignment provider", () => {
    const a = applyOverrides(planWith({ model: "k3", provider: "kimi-coding" }), { model: "k3-v2" }).waves[0]![0]!;
    assert.equal(a.model, "k3-v2");
    assert.equal(a.provider, "kimi-coding");
  });

  it("provider override replaces assignment provider", () => {
    const p = applyOverrides(planWith({ model: "k3", provider: "kimi-coding" }), { provider: "other" });
    assert.equal(p.waves[0]![0]!.provider, "other");
  });

  it("thinking override replaces assignment", () => {
    const p = applyOverrides(planWith(), { thinking: "low" });
    assert.equal(p.waves[0]![0]!.thinking, "low");
  });

  it("bad thinking override rejected", () => {
    assertPlanError(() => applyOverrides(planWith(), { thinking: "ultra" }), "thinking");
  });

  it("untouched fields survive override", () => {
    const a = applyOverrides(planWith(), { model: "anthropic/claude-x", thinking: "off" }).waves[0]![0]!;
    assert.equal(a.prompt, "do the thing");
    assert.deepEqual(a.files, ["src/a.py"]);
  });
});

describe("repo examples", () => {
  it("role split respects pane cap", () => {
    // delegate-wave skill: at most 4 herdr-display agents per wave
    const p = loadPlan(path.join(ROOT, "examples", "role-split-plan.json"));
    assert.ok(
      p.waves.every((w) => w.length <= 4),
      `wave sizes: ${JSON.stringify(p.waves.map((w) => w.length))}`,
    );
  });
});

describe("inline plans and baseDir", () => {
  beforeEach(setUp);

  it("parses an inline object without a file", () => {
    const p = parsePlan({ cwd, waves: [[baseAssignment()]] }, "inline");
    assert.equal(p.name, "inline");
    assert.equal(p.source, "inline");
    assert.equal(p.waves[0]![0]!.name, "wave-1-code");
  });

  it("names inline errors by their source", () => {
    assertPlanError(() => parsePlan({ waves: [] }, "inline"), "inline: 'waves' must be a non-empty list");
  });

  it("resolves an omitted or relative cwd against baseDir, not the process cwd", () => {
    mkdirSync(path.join(cwd, "sub"));
    const omitted = parsePlan({ waves: [[baseAssignment()]] }, "inline", cwd);
    const relative = parsePlan({ cwd: "sub", waves: [[baseAssignment()]] }, "inline", cwd);
    assert.equal(omitted.cwd, realpathSync(cwd));
    assert.equal(relative.cwd, realpathSync(path.join(cwd, "sub")));
  });
});

describe("plan paths", () => {
  beforeEach(setUp);

  it("resolves a relative plan path against baseDir", () => {
    writePlan(tmp, { cwd, waves: [[baseAssignment()]] });
    assert.equal(loadPlan("plan.json", tmp).source, path.join(tmp, "plan.json"));
  });

  it("expands ~ instead of joining it onto baseDir", () => {
    writePlan(tmp, { cwd, waves: [[baseAssignment()]] });
    const home = process.env.HOME;
    process.env.HOME = tmp;
    try {
      assert.equal(loadPlan("~/plan.json", cwd).source, path.join(tmp, "plan.json"));
    } finally {
      process.env.HOME = home;
    }
  });
});

describe("wave shape", () => {
  beforeEach(setUp);

  it("tells a caller who flattened waves to nest them", () => {
    // seen live: an LLM caller sent waves: [{...}] instead of [[{...}]]
    assertPlanError(
      () => parsePlan({ cwd, waves: [baseAssignment()] }, "inline"),
      "wave 1 is a single assignment object, but each wave must be a list of assignments - write waves as [[{...}, {...}], [{...}]]",
    );
  });

  it("still rejects an empty wave", () => {
    assertPlanError(() => parsePlan({ cwd, waves: [[]] }, "inline"), "wave 1 must be a non-empty list of assignments");
  });
});
