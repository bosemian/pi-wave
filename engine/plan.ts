// Wave plan loading and validation. The full plan schema is in README.md
// ("Wave plan schema"). Field names stay snake_case so they match the plan
// JSON one to one.
//
// Enforced delegate-wave rules:
// - two assignments in the same wave must not touch the same file;
// - names are unique plan-wide.

import { readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const DISPLAY_MODES = ["auto", "headless", "herdr"] as const;
export const AGENT_KINDS = ["pi", "omp"] as const;
export const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const ORCHESTRATOR_NAME = "orchestrator";
export const SYNTHESIZER_NAME = "synthesizer";

export type Thinking = (typeof THINKING_LEVELS)[number];
export type Display = (typeof DISPLAY_MODES)[number];
export type AgentKind = (typeof AGENT_KINDS)[number];

export class PlanError extends Error {
  override name = "PlanError";
}

export interface Assignment {
  name: string;
  prompt: string;
  model: string;
  provider: string | null;
  kind: AgentKind;
  thinking: Thinking;
  files: string[];
  done_when: string;
  review_cmd: string;
  max_fix_rounds: number;
  timeout: number;
  needs_results: string[];
  load_extensions: boolean;
  display: Display;
  mcp_config: string;
}

/** The delegate-wave orchestrator pane: reviews results against done_when
 * and writes the final synthesis. Defaults follow the skill (gpt-5.5 @ high).
 * synthesis_model/synthesis_thinking, when set, hand ONLY the final
 * synthesis to a dedicated one-shot `synthesizer` pane; the orchestrator
 * pane keeps doing the reviews. */
export interface OrchestratorSpec {
  model: string;
  thinking: string;
  synthesis_model: string;
  synthesis_thinking: string;
}

export interface Plan {
  name: string;
  cwd: string;
  on_failure: "stop" | "continue";
  waves: Assignment[][];
  source: string;
  display: Display;
  orchestrator: OrchestratorSpec | null;
}

/** auto → herdr when running inside Herdr, headless otherwise. */
export function resolveDisplay(display: Display): "herdr" | "headless" {
  if (display === "auto") return process.env.HERDR_ENV === "1" ? "herdr" : "headless";
  return display;
}

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const oneOf = <T extends string>(values: readonly T[], v: string): v is T =>
  (values as readonly string[]).includes(v);

const listing = (values: readonly string[]) =>
  `[${[...values].sort().map((v) => `'${v}'`).join(", ")}]`;

const expandUser = (p: string) =>
  p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;

/** Like Python's Path.is_file/is_dir: any stat error (ENOENT, ENOTDIR,
 * ENAMETOOLONG, ...) means "no". */
const statOrNull = (p: string) => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};
const isFile = (p: string) => statOrNull(p)?.isFile() ?? false;
const isDir = (p: string) => statOrNull(p)?.isDirectory() ?? false;

/** Like Python's os.path.normpath: also drops a trailing separator, so
 * "src/" and "src" count as the same file for conflict detection. */
const normPath = (p: string) => {
  const n = path.normalize(p);
  return n.length > 1 && n.endsWith(path.sep) ? n.slice(0, -1) : n;
};

const str = (v: unknown, fallback = "") => (v === undefined || v === null ? fallback : String(v));

function req(d: Raw, key: string, ctx: string): string {
  const v = str(d[key]);
  if (!v.trim()) throw new PlanError(`${ctx}: missing required field '${key}'`);
  return v;
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseAssignment(d: unknown, waveIdx: number, idx: number, defaultDisplay: Display): Assignment {
  const ctx = `wave ${waveIdx + 1}, agent ${idx + 1}`;
  if (!isObject(d)) throw new PlanError(`${ctx}: assignment must be an object`);

  const name = req(d, "name", ctx);
  if (!NAME_PATTERN.test(name)) {
    throw new PlanError(`${ctx}: name '${name}' must match ${NAME_PATTERN.source}`);
  }
  const prompt = req(d, "prompt", ctx);
  const model = req(d, "model", ctx);
  const provider = d.provider ? String(d.provider).trim() || null : null;
  const kind = str(d.kind, "pi");
  if (!oneOf(AGENT_KINDS, kind)) {
    throw new PlanError(`${ctx}: kind '${kind}' not in ${listing(AGENT_KINDS)}`);
  }
  if (kind === "pi" && !model.includes("/") && !provider) {
    throw new PlanError(
      `${ctx}: model '${model}' is not provider-qualified and no 'provider' ` +
        `field given (pi requires 'provider/model', its default provider is google)`,
    );
  }
  const thinking = str(d.thinking, "high");
  if (!oneOf(THINKING_LEVELS, thinking)) {
    throw new PlanError(`${ctx}: thinking '${thinking}' not in ${listing(THINKING_LEVELS)}`);
  }
  const files = d.files ?? [];
  if (!isStringList(files)) throw new PlanError(`${ctx}: 'files' must be a list of strings`);
  const timeout = Number(d.timeout ?? 600);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new PlanError(`${ctx}: timeout must be > 0`);
  const maxFix = Number(d.max_fix_rounds ?? 2);
  if (!Number.isInteger(maxFix) || maxFix < 0 || maxFix > 5) {
    throw new PlanError(`${ctx}: max_fix_rounds must be 0..5`);
  }
  const display = str(d.display, defaultDisplay);
  if (!oneOf(DISPLAY_MODES, display)) {
    throw new PlanError(`${ctx}: display '${display}' not in ${listing(DISPLAY_MODES)}`);
  }
  const mcpConfig = str(d.mcp_config).trim();
  if (mcpConfig && !isFile(expandUser(mcpConfig))) {
    throw new PlanError(`${ctx}: mcp_config file not found: ${mcpConfig}`);
  }
  const needs = d.needs_results ?? [];
  if (!isStringList(needs)) throw new PlanError(`${ctx}: 'needs_results' must be a list of strings`);
  return {
    name,
    prompt,
    model,
    provider,
    kind,
    thinking,
    files: files.map(normPath),
    done_when: str(d.done_when),
    review_cmd: str(d.review_cmd),
    max_fix_rounds: maxFix,
    timeout,
    needs_results: needs,
    load_extensions: Boolean(d.load_extensions),
    display,
    mcp_config: mcpConfig,
  };
}

/** true → skill defaults; {"model": ..., "thinking": ...} → custom.
 * Falsy values and an empty object disable it, as in the Python engine. */
function parseOrchestrator(v: unknown, p: string): OrchestratorSpec | null {
  if (!v || (isObject(v) && Object.keys(v).length === 0) || (Array.isArray(v) && v.length === 0)) {
    return null;
  }
  const spec: OrchestratorSpec = {
    model: "openai-codex/gpt-5.5",
    thinking: "high",
    synthesis_model: "",
    synthesis_thinking: "",
  };
  if (isObject(v)) {
    for (const key of ["model", "thinking", "synthesis_model", "synthesis_thinking"] as const) {
      if (v[key]) spec[key] = String(v[key]).trim();
    }
  } else if (v !== true) {
    throw new PlanError(`${p}: 'orchestrator' must be true or an object with model/thinking`);
  }
  if (!spec.model.includes("/")) {
    throw new PlanError(
      `${p}: orchestrator model '${spec.model}' is not provider-qualified ` +
        `(the orchestrator runs via pi, which requires 'provider/model')`,
    );
  }
  if (!oneOf(THINKING_LEVELS, spec.thinking)) {
    throw new PlanError(
      `${p}: orchestrator thinking '${spec.thinking}' not in ${listing(THINKING_LEVELS)}`,
    );
  }
  if (spec.synthesis_model && !spec.synthesis_model.includes("/")) {
    throw new PlanError(
      `${p}: synthesis_model '${spec.synthesis_model}' is not provider-qualified ` +
        `(the synthesizer runs via pi, which requires 'provider/model')`,
    );
  }
  if (spec.synthesis_thinking && !oneOf(THINKING_LEVELS, spec.synthesis_thinking)) {
    throw new PlanError(
      `${p}: synthesis_thinking '${spec.synthesis_thinking}' not in ${listing(THINKING_LEVELS)}`,
    );
  }
  return spec;
}

/** Load a plan file. A relative planPath, and a relative or omitted plan
 * `cwd`, resolve against baseDir (the caller's working directory). */
export function loadPlan(planPath: string, baseDir: string = process.cwd()): Plan {
  const p = path.resolve(baseDir, expandUser(planPath));
  if (!isFile(p)) throw new PlanError(`plan file not found: ${p}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new PlanError(`${p}: invalid JSON: ${(e as Error).message}`);
  }
  return parsePlan(raw, p, baseDir);
}

/** Validate an already-parsed plan object. `source` names it in errors
 * (and, without a plan `name`, names the plan); a relative or omitted plan
 * `cwd` resolves against baseDir. */
export function parsePlan(raw: unknown, source: string, baseDir: string = process.cwd()): Plan {
  const p = source;
  if (!isObject(raw)) throw new PlanError(`${p}: top level must be an object`);
  const wavesRaw = raw.waves;
  if (!Array.isArray(wavesRaw) || wavesRaw.length === 0) {
    throw new PlanError(`${p}: 'waves' must be a non-empty list of waves`);
  }

  const name = str(raw.name, path.parse(p).name);
  const cwd = path.resolve(baseDir, expandUser(str(raw.cwd) || "."));
  const onFailure = str(raw.on_failure, "stop");
  const display = str(raw.display, "auto");
  const orchestrator = parseOrchestrator(raw.orchestrator, p);
  if (!oneOf(DISPLAY_MODES, display)) {
    throw new PlanError(`${p}: display must be one of ${listing(DISPLAY_MODES)}`);
  }
  if (onFailure !== "stop" && onFailure !== "continue") {
    throw new PlanError(`${p}: on_failure must be 'stop' or 'continue'`);
  }
  if (!isDir(cwd)) throw new PlanError(`${p}: cwd does not exist: ${cwd}`);

  const plan: Plan = {
    name,
    cwd: realpathSync(cwd),
    on_failure: onFailure,
    waves: [],
    source: p,
    display,
    orchestrator,
  };

  const seenNames = new Set<string>();
  wavesRaw.forEach((waveRaw, wIdx) => {
    if (!Array.isArray(waveRaw) || waveRaw.length === 0) {
      if (isObject(waveRaw)) {
        throw new PlanError(
          `${p}: wave ${wIdx + 1} is a single assignment object, but each wave must be a list of ` +
            `assignments - write waves as [[{...}, {...}], [{...}]]`,
        );
      }
      throw new PlanError(`${p}: wave ${wIdx + 1} must be a non-empty list of assignments`);
    }
    const wave: Assignment[] = [];
    const seenFiles = new Map<string, string>();
    waveRaw.forEach((aRaw, aIdx) => {
      const a = parseAssignment(aRaw, wIdx, aIdx, display);
      if (seenNames.has(a.name)) {
        throw new PlanError(`${p}: duplicate agent name '${a.name}' (names must be unique plan-wide)`);
      }
      if (orchestrator && a.name === ORCHESTRATOR_NAME) {
        throw new PlanError(
          `${p}: assignment name '${ORCHESTRATOR_NAME}' is reserved for the ` +
            `orchestrator pane when plan-level 'orchestrator' is enabled`,
        );
      }
      if (orchestrator?.synthesis_model && a.name === SYNTHESIZER_NAME) {
        throw new PlanError(
          `${p}: assignment name '${SYNTHESIZER_NAME}' is reserved for the ` +
            `synthesis pane when orchestrator synthesis_model is set`,
        );
      }
      seenNames.add(a.name);
      for (const f of a.files) {
        const owner = seenFiles.get(f);
        if (owner !== undefined) {
          throw new PlanError(
            `${p}: file conflict in wave ${wIdx + 1}: '${f}' is touched by both ` +
              `'${owner}' and '${a.name}' - move one to a later wave`,
          );
        }
        seenFiles.set(f, a.name);
      }
      wave.push(a);
    });
    plan.waves.push(wave);
  });

  const seenBefore = new Set<string>();
  for (const wave of plan.waves) {
    for (const a of wave) {
      for (const dep of a.needs_results) {
        if (!seenNames.has(dep)) {
          throw new PlanError(`${p}: '${a.name}' needs results of unknown agent '${dep}'`);
        }
        if (!seenBefore.has(dep)) {
          throw new PlanError(`${p}: '${a.name}' needs results of '${dep}', which is not in an earlier wave`);
        }
      }
    }
    for (const a of wave) seenBefore.add(a.name);
  }
  return plan;
}

export interface Overrides {
  model?: string;
  provider?: string;
  thinking?: string;
}

/** Replace model/provider/thinking on every assignment (CLI overrides).
 *
 * Mutates and returns the same plan. Same qualification rule as
 * parseAssignment: an unqualified model needs a provider - from the
 * override or from the assignment itself (an assignment-level provider
 * survives a --model-only override). */
export function applyOverrides(plan: Plan, { model, provider, thinking }: Overrides = {}): Plan {
  if (model !== undefined && !model.trim()) throw new PlanError("override: model must not be empty");
  if (thinking !== undefined && !oneOf(THINKING_LEVELS, thinking)) {
    throw new PlanError(`override: thinking '${thinking}' not in ${listing(THINKING_LEVELS)}`);
  }
  for (const wave of plan.waves) {
    for (const a of wave) {
      if (model !== undefined) a.model = model.trim();
      if (provider !== undefined) a.provider = provider.trim() || null;
      if (thinking !== undefined) a.thinking = thinking;
      if (a.kind === "pi" && !a.model.includes("/") && !a.provider) {
        throw new PlanError(
          `override: agent '${a.name}' would get unqualified model ` +
            `'${a.model}' and no provider (pi requires 'provider/model'; ` +
            `pass --provider too)`,
        );
      }
    }
  }
  return plan;
}
