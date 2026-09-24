// Tests for saving and loading run state. Run from the repo root: npm test

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { STATE_VERSION, loadState, newRunDir, saveState } from "./state.ts";

const dir = () => mkdtempSync(path.join(os.tmpdir(), "pi-wave-state-"));
const plan = { name: "t", cwd: "/p", on_failure: "stop" as const, waves: [], source: "inline", display: "auto" as const, orchestrator: null };

describe("run state", () => {
  it("round-trips and leaves no temp file behind", () => {
    const d = dir();
    const file = path.join(d, "state.json");
    saveState(file, { plan, results: {}, syncs: { 0: { status: "pass", rounds: 1 } } });
    saveState(file, { plan, results: {}, syncs: {} });
    assert.deepEqual(loadState(file), { version: STATE_VERSION, plan, results: {}, syncs: {} });
    assert.deepEqual(readdirSync(d), ["state.json"]);
  });

  it("refuses a state from another version", () => {
    const file = path.join(dir(), "state.json");
    writeFileSync(file, JSON.stringify({ version: 999, plan, results: {}, syncs: {} }));
    assert.throws(() => loadState(file), /unsupported run state version 999/);
  });
});

describe("run dir", () => {
  it("makes a fresh dir per run under PI_WAVE_PROGRESS_DIR and points latest at it", () => {
    const base = dir();
    const saved = process.env.PI_WAVE_PROGRESS_DIR;
    process.env.PI_WAVE_PROGRESS_DIR = base;
    try {
      const a = newRunDir("site");
      const b = newRunDir("site"); // same second, still its own dir
      assert.notEqual(a, b);
      assert.ok(existsSync(a) && existsSync(b));
      assert.ok(path.basename(a).startsWith("site-"));
      const latest = path.join(base, "latest");
      assert.ok(lstatSync(latest).isSymbolicLink());
      assert.equal(realpathSync(latest), realpathSync(b));
    } finally {
      if (saved === undefined) delete process.env.PI_WAVE_PROGRESS_DIR;
      else process.env.PI_WAVE_PROGRESS_DIR = saved;
    }
  });
});
