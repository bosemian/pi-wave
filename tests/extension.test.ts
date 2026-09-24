// Tests for the dispatch_wave extension running the engine in-process:
// the extension's tool is registered against a stand-in for pi's
// ExtensionAPI and executed the way pi executes it, with the fake pi first
// on PATH for the subagents (no network, no real pi). Run from the repo
// root: npm test

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { writeFakePi } from "../engine/fake-pi.ts";
import register from "../extension/dispatch-wave.ts";

type Json = Record<string, any>;

const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-wave-ext-"));
const binDir = path.join(tmp, "bin");
const cwd = path.join(tmp, "proj");
mkdirSync(binDir);
mkdirSync(cwd);
writeFakePi(binDir);

let tool: Json;
register({ registerTool: (t: Json) => void (tool = t) } as any);

const saved: Record<string, string | undefined> = {};
const ENV = {
  PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
  PI_WAVE_PROGRESS_DIR: path.join(tmp, "progress"),
  PI_WAVE_NOTIFY: "off",
  PI_WAVE_CHAT_PUSH: "off",
};
before(() => {
  for (const k of [...Object.keys(ENV), "HERDR_ENV", "FAKE_PI_MODE", "FAKE_PI_PIDFILE"]) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  delete process.env.HERDR_ENV; // auto display must resolve headless
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const agent = (over: Json = {}) => ({ name: "wave-1-smoke", prompt: "say hi", model: "openai-codex/gpt-5.6-luna", files: [], ...over });

async function execute(params: Json, signal?: AbortSignal) {
  const updates: string[] = [];
  const result = await tool.execute("call-1", params, signal, (u: Json) => updates.push(u.content[0].text), { cwd });
  return { result, updates };
}

describe("dispatch_wave extension", () => {
  it("registers the tool", () => {
    assert.equal(tool.name, "dispatch_wave");
  });

  it("runs an inline plan in-process and returns the summary", async () => {
    process.env.FAKE_PI_MODE = "ok";
    const { result, updates } = await execute({ plan: { waves: [[agent()]] } });
    const summary = JSON.parse(result.content[0].text);
    assert.equal(summary.status, "completed");
    assert.equal(summary.plan, "inline");
    assert.equal(summary.cwd, realpathSync(cwd)); // omitted cwd = the session's cwd
    assert.equal(JSON.parse(updates[0]!).type, "plan_start");
    assert.equal(JSON.parse(updates.at(-1)!).type, "summary");
    assert.ok(readFileSync(result.details.dashboard, "utf8").includes("✅ pass"));
    assert.equal(path.dirname(result.details.dashboard), summary.run_dir);
    assert.ok(existsSync(path.join(summary.run_dir, "state.json")));
  });

  it("resolves a relative plan path and applies overrides", async () => {
    process.env.FAKE_PI_MODE = "ok";
    writeFileSync(path.join(cwd, "plan.json"), JSON.stringify({ name: "from-file", waves: [[agent({ model: "k3", provider: "kimi-coding" })]] }));
    const { result, updates } = await execute({ plan: "plan.json", thinking: "low" });
    assert.equal(JSON.parse(result.content[0].text).plan, "from-file");
    assert.ok(updates.some((u) => JSON.parse(u).type === "agent_done"));
  });

  it("expands ~ in a plan path", async () => {
    process.env.FAKE_PI_MODE = "ok";
    const home = process.env.HOME;
    process.env.HOME = cwd;
    try {
      const { result } = await execute({ plan: "~/plan.json" });
      assert.equal(JSON.parse(result.content[0].text).plan, "from-file");
    } finally {
      process.env.HOME = home;
    }
  });

  it("fails the tool call on a plan error", async () => {
    const conflict = { waves: [[agent({ files: ["a.txt"] }), agent({ name: "wave-1-other", files: ["a.txt"] })]] };
    await assert.rejects(execute({ plan: conflict }), /plan error: .*file conflict in wave 1: 'a.txt'/);
  });

  it("terminates subagents when pi aborts the tool call", async () => {
    const pidFile = path.join(tmp, "hang.pid");
    process.env.FAKE_PI_MODE = "hang";
    process.env.FAKE_PI_PIDFILE = pidFile;
    const controller = new AbortController();
    const run = execute({ plan: { waves: [[agent({ timeout: 600 })], [agent({ name: "wave-2-never" })]] } }, controller.signal);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    const piPid = Number(readFileSync(pidFile, "utf8"));
    const started = performance.now();
    controller.abort();
    await assert.rejects(run, { name: "AbortError" });
    assert.ok(performance.now() - started < 10_000);
    assert.throws(() => process.kill(piPid, 0), { code: "ESRCH" }); // no orphaned agent
    delete process.env.FAKE_PI_PIDFILE;
  });
});
