// End-to-end tests for the CLI: the real entry point in a subprocess, with
// the fake pi first on PATH (no network, no real pi). Run from the repo
// root: npm test

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { writeFakePi } from "./fake-pi.ts";

type Json = Record<string, any>;

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "engine", "cli.ts");
const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-wave-cli-"));
const binDir = path.join(tmp, "bin");
mkdirSync(binDir);
writeFakePi(binDir);

function env(extra: Record<string, string> = {}) {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    PI_WAVE_PROGRESS_DIR: path.join(tmp, "progress"),
    PI_WAVE_NOTIFY: "off",
    ...extra,
  };
  delete e.HERDR_ENV; // auto display must resolve headless
  delete e.PI_WAVE_CHAT_PUSH;
  return e;
}

interface Run {
  code: number | null;
  events: Json[];
  stderr: string;
}

function start(args: string[], extraEnv: Record<string, string> = {}): { proc: ChildProcess; done: Promise<Run> } {
  const proc = spawn(process.execPath, [CLI, ...args], { cwd: tmp, env: env(extraEnv) });
  let out = "";
  let stderr = "";
  proc.stdout!.setEncoding("utf8").on("data", (c: string) => (out += c));
  proc.stderr!.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  const done = new Promise<Run>((resolve) =>
    proc.on("close", (code) => {
      const events = out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
      resolve({ code, events, stderr });
    }),
  );
  return { proc, done };
}

const run = (args: string[], extraEnv: Record<string, string> = {}) => start(args, extraEnv).done;

function writePlan(name: string, plan: Json): string {
  const f = path.join(tmp, `${name}.json`);
  writeFileSync(f, JSON.stringify({ name, ...plan }));
  return f;
}

const agent = (over: Json = {}) => ({ name: "wave-1-smoke", prompt: "say hi", model: "openai-codex/gpt-5.6-luna", files: [], timeout: 20, ...over });

describe("cli dry-run", () => {
  it("refuses a conflicting plan with exit 2", async () => {
    const r = await run([path.join(ROOT, "tests/plans/conflict.json"), "--dry-run"]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("plan error:"));
    assert.ok(r.stderr.includes("file conflict in wave 1: 'README.md'"));
  });

  it("prints the example plan as JSONL", async () => {
    const r = await run([path.join(ROOT, "examples/example-plan.json"), "--dry-run"]);
    assert.equal(r.code, 0);
    assert.equal(r.events[0]!.type, "plan");
    assert.equal(r.events.filter((e) => e.type === "assignment").length, 3);
    assert.ok(r.stderr.includes("dry-run OK"));
  });

  it("shows the display field", async () => {
    const r = await run([writePlan("dry-display", { display: "herdr", waves: [[agent()]] }), "--dry-run"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.events.find((e) => e.type === "assignment")!.display, "herdr");
  });

  it("applies overrides to every assignment", async () => {
    const r = await run([path.join(ROOT, "examples/example-plan.json"), "--dry-run", "--thinking", "low"]);
    assert.equal(r.code, 0);
    assert.ok(r.stderr.includes("overrides applied to every assignment: thinking=low"));
    assert.ok(r.events.filter((e) => e.type === "assignment").every((e) => e.thinking === "low"));
  });

  it("rejects an unqualified model override with exit 2", async () => {
    const r = await run([path.join(ROOT, "examples/example-plan.json"), "--dry-run", "--model", "k3"]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("pass --provider too"));
  });

  it("rejects bad usage with exit 2", async () => {
    assert.equal((await run([])).code, 2);
    assert.equal((await run(["a.json", "--bogus"])).code, 2);
  });
});

describe("cli run", () => {
  it("runs a plan end to end and writes the dashboard", async () => {
    const r = await run([writePlan("smoke", { waves: [[agent()]] })]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.events.map((e) => e.type),
      ["plan_start", "wave_start", "agent_start", "agent_progress", "agent_progress", "agent_done", "wave_done", "summary"],
    );
    const summary = r.events.at(-1)!;
    assert.equal(summary.status, "completed");
    assert.deepEqual(summary.waves[0].agents[0].tokens, { input: 10, output: 5 });
    const dashboard = r.stderr.match(/progress dashboard: (.+)/)![1]!;
    assert.ok(readFileSync(dashboard, "utf8").includes("| 1 | wave-1-smoke | openai-codex/gpt-5.6-luna | ✅ pass | 1 |"));
  });

  it("exits 1 and stops later waves when a review keeps failing", async () => {
    const r = await run([writePlan("fails", {
      waves: [[agent({ review_cmd: "echo nope; exit 1", max_fix_rounds: 1 })], [agent({ name: "wave-2-never" })]],
    })], { PI_WAVE_PROGRESS: "off" });
    assert.equal(r.code, 1);
    assert.equal(r.events.filter((e) => e.type === "review_failed").length, 2);
    assert.equal(r.events.at(-1)!.status, "stopped");
    assert.ok(r.events.at(-1)!.reason.includes("on_failure is 'stop'"));
    assert.ok(!r.events.some((e) => e.agent === "wave-2-never"));
  });

  it("terminates child agents on SIGTERM and exits 130", async () => {
    const pidFile = path.join(tmp, "hang.pid");
    const { proc, done } = start([writePlan("hang", { waves: [[agent({ timeout: 600 })]] })], {
      FAKE_PI_MODE: "hang",
      FAKE_PI_PIDFILE: pidFile,
      PI_WAVE_PROGRESS: "off",
    });
    // wait until the fake pi is up and holding a prompt
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    const piPid = Number(readFileSync(pidFile, "utf8"));
    proc.kill("SIGTERM");
    const r = await done;
    assert.equal(r.code, 130);
    assert.ok(r.stderr.includes("interrupted"));
    assert.throws(() => process.kill(piPid, 0), { code: "ESRCH" }); // no orphaned agent
  });
});
