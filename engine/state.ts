// Run state: what a run has done so far - its plan, every finished agent's
// result and every wave sync - saved after each agent and wave so a stopped,
// failed or aborted run can resume without redoing (and re-paying for) the
// agents that passed. Written atomically: a crash mid-save leaves the last
// complete state, never a torn one.
//
// Every run gets its own dir, ~/.pi-wave/progress/<plan>-<stamp>/ (moved by
// PI_WAVE_PROGRESS_DIR): state.json, the agents' sessions/, and the
// progress sinks' files. `latest` next to it points at the newest run.

import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentResult, SyncOutcome } from "./orchestrator.ts";
import type { Plan } from "./plan.ts";

export const STATE_VERSION = 1;

export interface RunState {
  version: number;
  plan: Plan;
  results: Record<string, AgentResult>;
  /** Wave syncs by wave index (0-based). */
  syncs: Record<string, SyncOutcome>;
}

export function saveState(file: string, state: Omit<RunState, "version">): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, ...state }));
  renameSync(tmp, file);
}

export function loadState(file: string): RunState {
  const state = JSON.parse(readFileSync(file, "utf8"));
  if (state?.version !== STATE_VERSION) {
    throw new Error(`${file}: unsupported run state version ${state?.version}`);
  }
  return state;
}

const DEFAULT_PROGRESS_DIR = "~/.pi-wave/progress";

const expandUser = (p: string) =>
  p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;

const pad = (n: number) => String(n).padStart(2, "0");
const stampOf = (d: Date) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
  `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** Create a fresh dir for one run of `planName` and point `latest` at it. */
export function newRunDir(planName: string): string {
  const base = expandUser(process.env.PI_WAVE_PROGRESS_DIR ?? DEFAULT_PROGRESS_DIR);
  mkdirSync(base, { recursive: true });
  const stamp = stampOf(new Date());
  for (let n = 1; ; n++) {
    const dir = path.join(base, n === 1 ? `${planName}-${stamp}` : `${planName}-${stamp}-${n}`);
    try {
      mkdirSync(dir); // not recursive: claims the name even against a concurrent run
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    pointLatest(dir);
    return dir;
  }
}

function pointLatest(runDir: string): void {
  const base = path.dirname(runDir);
  const latest = path.join(base, "latest");
  const tmp = path.join(base, `.latest-${process.pid}`);
  try {
    symlinkSync(path.basename(runDir), tmp);
    renameSync(tmp, latest);
  } catch {
    try {
      rmSync(tmp, { force: true });
      writeFileSync(latest, runDir + "\n");
    } catch {
      // best-effort pointer only
    }
  }
}
