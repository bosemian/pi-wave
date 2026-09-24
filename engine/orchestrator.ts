// Wave execution loop - the programmatic delegate-wave orchestrator.
//
// For each wave: dispatch every assignment in parallel, wait for all to
// settle, review each result against its definition of done, send at most
// max_fix_rounds consolidated fix prompts, then move on. Default on_failure
// is "stop": an assignment that exhausts its fix rounds halts later waves
// and the state is reported honestly in the summary.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { AgentBlockedError, AgentTimeoutError } from "./errors.ts";
import {
  type Checkpoint,
  HerdrBackend,
  HerdrBlocked,
  HerdrError,
  HerdrPromptStalled,
  Mutex,
  PaneLayout,
  herdrAvailable,
  sleep,
} from "./herdr.ts";
import { type Assignment, type OrchestratorSpec, type Plan, resolveDisplay } from "./plan.ts";
import { PiRpcSession, type PiRpcSessionOptions, listPiModels } from "./rpc.ts";
import { type RunState, saveState } from "./state.ts";

type Json = Record<string, any>;
export type Emitter = (ev: Json) => void;

const promptTemplate = (name: string, files: string, doneWhen: string, prompt: string) =>
  `You are assignment agent "${name}" in a delegated wave. Work autonomously and answer ` +
  `directly: do NOT dispatch subagents, do NOT delegate further, do NOT invoke ` +
  `delegate-wave or dispatch_wave.

FILES YOU MAY TOUCH: ${files}
DEFINITION OF DONE: ${doneWhen}

ASSIGNMENT:
${prompt}

When finished, end your final message with a concise summary of exactly what you did.`;

const fixTemplate = (round: number, max: number, files: string, doneWhen: string, prompt: string, feedback: string) =>
  `FIX ROUND ${round}/${max}: your previous result failed review. Address ALL of the ` +
  `feedback below in one pass, then end with a concise summary of what you changed.

FILES YOU MAY TOUCH: ${files}
DEFINITION OF DONE: ${doneWhen}

ORIGINAL ASSIGNMENT:
${prompt}

REVIEW FEEDBACK:
${feedback}`;

const orchReviewTemplate = (name: string, doneWhen: string, prompt: string, text: string) =>
  `You are the wave orchestrator reviewing assignment agent "${name}".
Review only - never edit files or do the assignment's work yourself; your ` +
  `entire reply must be the VERDICT block.

DEFINITION OF DONE: ${doneWhen}
ORIGINAL ASSIGNMENT:
${prompt}

AGENT'S FINAL REPORT:
${text}

Judge the result against the definition of done, not effort expended. Reply in ` +
  `EXACTLY this format:
Line 1: VERDICT: pass
or:    VERDICT: fail
If fail, lines 2+ are ONE consolidated list of everything the agent must fix.`;

const orchSynthTemplate = (outcomes: string) =>
  `All waves are done. Synthesize ONE final summary for the user: what changed, ` +
  `what was verified, and what remains. Do not repeat each agent's report ` +
  `verbatim. Text only - do not modify any files.

PER-AGENT OUTCOMES:
${outcomes}`;

const orchSyncTemplate = (wave: number, reports: string, owners: string, fixes: string) =>
  `You are the wave orchestrator syncing wave ${wave}. Every agent in it passed its own ` +
  `check; your job is to make the agents' results fit together. Review only - never edit ` +
  `files yourself; you may read files in the project to verify.

THIS WAVE'S AGENTS:
${reports}

ALL AGENTS SO FAR (route each issue to the agent that owns the file that must change):
${owners}
${fixes ? `\nFIXES SINCE YOUR LAST CHECK:\n${fixes}\n` : ""}
Check (1) that this wave's results agree with each other and with earlier waves' ` +
  `contracts - shared names, ids and classes, interfaces, data formats - and (2) that every ` +
  `problem this wave's agents report about files (e.g. a QA agent's findings) is real and still ` +
  `open; verify it by reading the file. Ignore style preferences and never ask for new features.

Reply in EXACTLY this format:
Line 1: SYNC: pass
or:    SYNC: fail
If fail, then one block per agent that must change something:
AGENT <name>:
- <specific fix, with file and line when you can>
Only name agents from ALL AGENTS SO FAR, and only for work they own.`;

const syncFixTemplate = (round: number, max: number, files: string, issues: string) =>
  `SYNC FIX ${round}/${max} from the wave orchestrator: a cross-check of the agents' results ` +
  `found issues in your work that other agents depend on. Address ALL of them in one pass, ` +
  `touching only your files, then end with a concise summary of what you changed.

FILES YOU MAY TOUCH: ${files}

ISSUES:
${issues}`;

// Role constraints pinned into the panes' system prompts (via
// --append-system-prompt, see HerdrBackend.startAgent): the orchestrator
// only reviews and synthesizes - it never implements assignments itself.
// The soft version of this rule also lives in the templates above; a hard
// guard (like assignment agents' --no-extensions) is not possible here
// because the pane needs its tools to read the repo while reviewing.
export const ORCH_ROLE_SYSTEM_PROMPT =
  "You are the delegate-wave orchestrator pane. The engine dispatches every " +
  "assignment to other panes - your pane never implements anything. NEVER edit, " +
  "create, or run code to do an assignment's work yourself. When asked to " +
  "review, reply with ONLY the VERDICT block the prompt specifies; when asked " +
  "to synthesize, reply with the summary text only.";

export const SYNTH_ROLE_SYSTEM_PROMPT =
  "You are the synthesizer pane of a delegated wave run. Your only job is " +
  "writing the final summary text when asked. Never edit, create, or run code; " +
  "never implement assignments.";

/** How much of one agent's report the orchestrator's review and later
 * waves' prompts receive: whole reports in practice (a full design spec
 * runs 15K chars), capped only so a runaway report cannot fill a context
 * window. The synthesis takes a shorter excerpt per agent, since it reads
 * every agent at once. */
export const MAX_RESULT_CHARS = 100_000;
export const MAX_SYNTH_RESULT_CHARS = 6000;
/** A failed review_cmd's output as fix prompts and the summary receive it:
 * a test run can print megabytes, but the first error and the final tally
 * are what an agent acts on, so the middle is cut. */
export const MAX_REVIEW_OUTPUT_CHARS = 8000;
export const ORCH_INTERACT_TIMEOUT = 300;
export const MAX_HERDR_AGENTS_PER_WAVE = 4;
export const STALL_WATCH_S = 10; // pi agents boot fast; a stall usually means lost input
export const STALL_WATCH_S_OMP = 60; // the OMP CLI can take 30-90s to first respond
export const MAX_PROMPT_ATTEMPTS = 2;
/** Cross-agent fix rounds per wave before its remaining issues fail it. */
export const MAX_SYNC_ROUNDS = 2;

/** The parts of HerdrBackend the engine drives (tests pass fakes). */
export type HerdrLike = Pick<
  HerdrBackend,
  "splitPane" | "startAgent" | "prompt" | "checkpoint" | "reply" | "waitLateStart" | "waitSettled" | "waitDone" | "submitPending"
  | "sessionFile"
>;
/** The parts of PiRpcSession the engine drives (tests pass fakes). */
export type SessionLike = Pick<
  PiRpcSession,
  "start" | "verifyModel" | "promptAndSettle" | "lastText" | "stats" | "close"
>;

/** Process-level collaborators, injectable so tests need no Herdr or pi,
 * plus the run's cancellation signal. */
export interface Deps {
  herdrAvailable: () => string | null;
  herdrBackend: (cwd: string, signal?: AbortSignal, sessionDir?: string) => HerdrLike;
  rpcSession: (opts: PiRpcSessionOptions) => SessionLike;
  sleep: (s: number) => Promise<void>;
  /** The "provider/model" ids pi can run, or null to skip the model check. */
  listModels: () => Promise<Set<string> | null>;
  /** Aborting it terminates headless agents and dispatches no further
   * prompts or waves; Herdr panes stay open, as after a normal run. */
  signal?: AbortSignal;
  /** Where agents record their sessions (the run's sessions/); without it
   * headless agents keep none and pane agents use a temp dir. */
  sessionsDir?: string;
}

export const defaultDeps: Deps = {
  herdrAvailable,
  herdrBackend: (cwd, signal, sessionDir) => new HerdrBackend(cwd, signal, sessionDir),
  rpcSession: (opts) => new PiRpcSession(opts),
  sleep,
  listModels: () => listPiModels(),
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface AgentResult {
  name: string;
  wave: number;
  model: string;
  status: "pass" | "fail" | "timeout" | "blocked" | "error";
  rounds: number;
  text: string;
  feedback: string;
  error: string;
  stats: Json;
  display: "herdr" | "headless";
  pane: string;
  /** Kept from an earlier run of the plan instead of being run again. */
  resumed?: boolean;
  /** The agent's session file, when it recorded one. */
  session?: string;
}

export function newResult(name: string, wave: number, model: string, display: AgentResult["display"]): AgentResult {
  return { name, wave, model, status: "error", rounds: 0, text: "", feedback: "", error: "", stats: {}, display, pane: "" };
}

export function resultJson(r: AgentResult): Json {
  return {
    name: r.name,
    wave: r.wave,
    model: r.model,
    status: r.status,
    rounds: r.rounds,
    text: r.text,
    ...(r.feedback ? { feedback: r.feedback } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.pane ? { pane: r.pane } : {}),
    ...(r.resumed ? { resumed: true } : {}),
    ...(r.session ? { session: r.session } : {}),
    display: r.display,
    tokens: r.stats.tokens ?? {},
    cost: r.stats.cost ?? 0,
  };
}

/** First 'VERDICT: pass|fail' line decides; the rest is the feedback.
 * null when the reply has no VERDICT line. */
export function parseVerdict(reply: string): [boolean, string] | null {
  const lines = reply.trim().split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    const low = line.trim().toLowerCase();
    if (low.startsWith("verdict:")) {
      if (low.slice("verdict:".length).trim().startsWith("pass")) return [true, ""];
      const feedback = lines.slice(i + 1).join("\n").trim();
      return [false, feedback || "orchestrator gave no specific feedback"];
    }
  }
  return null;
}

/** Cap a report, saying where it was cut and why - a reader that cannot
 * tell must not mistake the engine's cut for an unfinished report. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return (
    text.slice(0, max) +
    `\n\n[... cut by the engine at ${max} of ${text.length} chars; the agent's report ` +
    `continues past this point - do not fail it for ending here]`
  );
}

/** Cap command output, keeping its head and its (longer) tail. */
function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 4);
  const tail = max - head;
  return (
    text.slice(0, head) +
    `\n\n[... ${text.length - max} chars of review output cut by the engine ...]\n\n` +
    text.slice(-tail)
  );
}

export interface SyncVerdict {
  ok: boolean;
  /** Issues to fix, by the agent that owns them. */
  fixes: Map<string, string>;
  /** Feedback not addressed to any agent. */
  note: string;
}

/** First 'SYNC: pass|fail' line decides; after a fail, each 'AGENT <name>:'
 * line opens that agent's block of issues. null when the reply has no SYNC
 * line. */
export function parseSync(reply: string): SyncVerdict | null {
  const lines = reply.trim().split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim().toLowerCase().startsWith("sync:"));
  if (at === -1) return null;
  if (lines[at]!.trim().slice("sync:".length).trim().toLowerCase().startsWith("pass")) {
    return { ok: true, fixes: new Map(), note: "" };
  }
  const fixes = new Map<string, string[]>();
  const note: string[] = [];
  let current: string[] = note;
  for (const line of lines.slice(at + 1)) {
    const head = /^\s*agent\s+([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i.exec(line);
    if (head) {
      current = fixes.get(head[1]!) ?? [];
      fixes.set(head[1]!, current);
      if (head[2]) current.push(head[2]);
    } else {
      current.push(line);
    }
  }
  const joined = new Map([...fixes].map(([name, l]) => [name, l.join("\n").trim()] as const));
  const noteText = note.join("\n").trim();
  return {
    ok: false,
    fixes: joined,
    note: noteText || (joined.size ? "" : "orchestrator gave no specific feedback"),
  };
}

const doneWhen = (a: Assignment) => a.done_when || "as stated in the assignment";

function filesLabel(a: Assignment): string {
  return a.files.length ? a.files.join(", ") : "NONE - this is a read-only assignment";
}

export function buildPrompt(a: Assignment, results: Map<string, AgentResult>): string {
  let prompt = promptTemplate(a.name, filesLabel(a), doneWhen(a), a.prompt);
  for (const n of a.needs_results) {
    const r = results.get(n);
    if (r) prompt += `\n\nRESULTS FROM PRIOR WAVES - agent '${n}':\n` + clip(r.text, MAX_RESULT_CHARS);
  }
  return prompt;
}

const fixPrompt = (a: Assignment, round: number, feedback: string) =>
  fixTemplate(round, a.max_fix_rounds, filesLabel(a), doneWhen(a), a.prompt, feedback);

/** Run the review command in a shell → [passed, combined stdout+stderr,
 * ending with the command and exit code when it fails].
 * Aborting `signal` kills it and counts as a failed review. */
export function runReview(
  reviewCmd: string,
  cwd: string,
  agentName: string,
  signal?: AbortSignal,
  timeoutS = 300,
): Promise<[boolean, string]> {
  return new Promise((resolve) => {
    const proc = spawn(reviewCmd, {
      shell: true,
      cwd,
      env: { ...process.env, PI_WAVE_AGENT: agentName },
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let out = "";
    proc.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
    proc.stderr.setEncoding("utf8").on("data", (c: string) => (out += c));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve([false, `review command timed out after ${Math.round(timeoutS)}s`]);
    }, timeoutS * 1000);
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve([false, `review command failed to run: ${e.message}`]);
    });
    proc.on("close", (code, sig) => {
      clearTimeout(timer);
      if (code === 0) return resolve([true, out]);
      // name the command last so silent checks (grep -q, test) still tell
      // the agent what failed, and the event's output tail keeps it
      const note = `review_cmd \`${reviewCmd}\` ${code === null ? `was killed by ${sig}` : `exited ${code}`}`;
      resolve([false, out.trim() ? `${clipMiddle(out.trimEnd(), MAX_REVIEW_OUTPUT_CHARS)}\n${note}` : `${note} without printing anything`]);
    });
  });
}

/** The delegate-wave orchestrator agent (wider pane, gpt-5.5 @ high by
 * default).
 *
 * One pane serves the whole run, so every interaction takes the lock -
 * concurrent assignment coroutines must never interleave prompts. */
export class OrchestratorPane {
  pane = "";
  synthPane = "";
  private readonly backend: HerdrLike;
  private readonly spec: OrchestratorSpec;
  private readonly layout: Pick<PaneLayout, "nextSplit">;
  private readonly lock = new Mutex();

  constructor(backend: HerdrLike, spec: OrchestratorSpec, layout: Pick<PaneLayout, "nextSplit">) {
    this.backend = backend;
    this.spec = spec;
    this.layout = layout;
  }

  async start(): Promise<void> {
    // first split of the run (PaneLayout): the engine's own pane, to the
    // right, with a lower ratio so the orchestrator ends up wider than any
    // assignment pane (skill: 0.4, before any wave pane)
    this.pane = await this.layout.nextSplit(this.backend, 0.4);
    await this.backend.startAgent("orchestrator", this.pane, this.spec.model, null, this.spec.thinking, {
      systemPrompt: ORCH_ROLE_SYSTEM_PROMPT,
    });
  }

  /** Judge one agent result against its done_when → [ok, feedback].
   * Throws when the orchestrator twice fails to answer in format - its slip,
   * which a fix round for the agent could never repair. */
  async review(a: Assignment, text: string): Promise<[boolean, string]> {
    const prompt = orchReviewTemplate(a.name, doneWhen(a), a.prompt, clip(text, MAX_RESULT_CHARS));
    const [verdict, reply] = await this.askParsed(prompt, "VERDICT", parseVerdict);
    if (verdict) return verdict;
    throw new Error(`orchestrator reply had no VERDICT line, asked twice:\n${reply.slice(-500)}`);
  }

  /** Cross-check a finished wave; see orchSyncTemplate. */
  async sync(wave: number, reports: string, owners: string, fixes: string): Promise<SyncVerdict> {
    const prompt = orchSyncTemplate(wave, reports, owners, fixes);
    const [verdict, reply] = await this.askParsed(prompt, "SYNC", parseSync);
    return verdict ?? { ok: false, fixes: new Map(), note: `orchestrator reply had no SYNC line, asked twice:\n${reply.slice(-500)}` };
  }

  /** Ask the orchestrator, and once more if its reply lacks the `<marker>:`
   * line → [parsed or null, last reply]. */
  private askParsed<T>(prompt: string, marker: string, parse: (reply: string) => T | null): Promise<[T | null, string]> {
    return this.lock.run(async () => {
      let reply = await this.ask("orchestrator", prompt);
      let parsed = parse(reply);
      if (parsed === null) {
        reply = await this.ask(
          "orchestrator",
          `Your last reply had no \`${marker}:\` line, so the engine could not read it. ` +
            `Reply again with ONLY the ${marker} block, in exactly the format the previous prompt asked for.`,
        );
        parsed = parse(reply);
      }
      return [parsed, reply];
    });
  }

  synthesize(results: Map<string, AgentResult>): Promise<string> {
    const outcomes = [...results.values()]
      .map(
        (r) =>
          `- ${r.name} (${r.model}): status=${r.status}, rounds=${r.rounds}\n` +
          clip(r.text, MAX_SYNTH_RESULT_CHARS),
      )
      .join("\n\n");
    const prompt = orchSynthTemplate(outcomes);
    return this.lock.run(async () => {
      if (this.spec.synthesis_model) {
        // synthesis is reasoning work - a dedicated one-shot `synthesizer`
        // pane (split lazily, reused, left open)
        if (!this.synthPane) {
          this.synthPane = await this.layout.nextSplit(this.backend);
          await this.backend.startAgent(
            "synthesizer",
            this.synthPane,
            this.spec.synthesis_model,
            null,
            this.spec.synthesis_thinking || "high",
            { systemPrompt: SYNTH_ROLE_SYSTEM_PROMPT },
          );
        }
        return this.ask("synthesizer", prompt);
      }
      return this.ask("orchestrator", prompt);
    });
  }

  /** Prompt one of this run's panes and return only its answer. */
  private async ask(name: string, prompt: string): Promise<string> {
    const since = await this.backend.checkpoint(name);
    await this.backend.prompt(name, prompt, ORCH_INTERACT_TIMEOUT);
    return this.backend.reply(name, since);
  }
}

/** Prompt a herdr agent, recovering from submission stalls.
 *
 * Refuses to prompt an agent whose session shows it still mid-turn: a
 * prompt typed into a working agent's pane corrupts its turn (observed: a
 * FIX ROUND sent to an OMP agent still doing its first task).
 *
 * herdr requires a state change within its hard 5s window after a
 * submission from idle; a freshly spawned CLI can take far longer to boot
 * and the submission may still kick in late. On a stall: watch for a late
 * start (longer for OMP) - if the agent wakes, consume the original
 * submission and wait for settle.
 *
 * kind=omp never reports a non-idle agent_status at all (confirmed live -
 * herdr's OMP integration has no activity signal for it, so waitLateStart
 * always times out regardless of how fast OMP actually replies). Resending
 * in that case would just re-submit the same prompt to an agent that is
 * already working or already done, risking duplicate work - observed live
 * as the pane running the assignment twice. So for omp, one stall goes
 * straight to the wait-for-done fallback; kind=pi (whose status field is
 * reliable) keeps resending once before falling back. Before that wait,
 * an omp prompt its session never received is still in the editor (a big
 * paste herdr's Enter did not submit) and gets one more Enter. */
async function promptHerdr(
  backend: HerdrLike,
  a: Assignment,
  message: string,
  since: Checkpoint,
  emit: Emitter,
  deps: Deps,
): Promise<void> {
  if (since.busy) {
    throw new HerdrError(`[${a.name}] is still working on its previous turn - not sending it another prompt`);
  }
  const watchS = a.kind === "omp" ? STALL_WATCH_S_OMP : STALL_WATCH_S;
  const maxAttempts = a.kind === "omp" ? 1 : MAX_PROMPT_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await backend.prompt(a.name, message, a.timeout);
      return;
    } catch (e) {
      if (!(e instanceof HerdrPromptStalled)) throw e;
    }
    emit({ type: "prompt_stall_recovery", agent: a.name, attempt, watch_s: watchS });
    const status = await backend.waitLateStart(a.name, watchS);
    if (status === "blocked") {
      throw new HerdrBlocked(`[${a.name}] agent is blocked at an approval/question dialog`);
    }
    if (status !== null) {
      await backend.waitSettled(a.name, a.timeout);
      return;
    }
    if (attempt < maxAttempts) await deps.sleep(2);
  }
  // status never confirmed a wake (expected every time for omp) - the
  // agent may well be working anyway, so wait for its session reply (or
  // its pane to settle) for as long as the assignment allows; see
  // HerdrBackend.waitDone.
  if (a.kind === "omp" && (await backend.submitPending(a.name, since))) {
    emit({ type: "prompt_submit_enter", agent: a.name });
  }
  emit({ type: "prompt_stall_pane_check", agent: a.name, watch_s: watchS, timeout_s: a.timeout });
  await backend.waitDone(a.name, since, a.timeout, watchS);
}

/** Map an exception from an agent run onto its result status. */
function recordFailure(res: AgentResult, e: unknown): void {
  res.status = e instanceof HerdrBlocked || e instanceof AgentBlockedError ? "blocked" : e instanceof AgentTimeoutError ? "timeout" : "error";
  res.error = errMsg(e);
}

export function runAssignment(
  a: Assignment,
  waveIdx: number,
  plan: Plan,
  results: Map<string, AgentResult>,
  emit: Emitter,
  orch: OrchestratorPane | null,
  layout: PaneLayout | null,
  deps: Deps = defaultDeps,
): Promise<AgentResult> {
  if (resolveDisplay(a.display) === "herdr") {
    return runAssignmentHerdr(a, waveIdx, plan, results, emit, orch, layout, deps);
  }
  return runAssignmentRpc(a, waveIdx, plan, results, emit, deps);
}

/** Agent lives in a Herdr pane (delegate-wave visual): split, start,
 * prompt, read scrollback. Panes are left open for the user to inspect. */
export async function runAssignmentHerdr(
  a: Assignment,
  waveIdx: number,
  plan: Plan,
  results: Map<string, AgentResult>,
  emit: Emitter,
  orch: OrchestratorPane | null,
  layout: PaneLayout | null,
  deps: Deps = defaultDeps,
): Promise<AgentResult> {
  const res = newResult(a.name, waveIdx + 1, a.model, "herdr");
  const problem = deps.herdrAvailable();
  if (problem) {
    res.error = problem;
    emit({ type: "agent_done", agent: a.name, status: res.status, rounds: 0 });
    return res;
  }

  const backend = deps.herdrBackend(plan.cwd, deps.signal);
  emit({ type: "agent_start", agent: a.name, wave: res.wave, model: a.model, display: "herdr", kind: a.kind });
  try {
    res.pane = layout ? await layout.nextSplit(backend) : await backend.splitPane();
    await backend.startAgent(a.name, res.pane, a.model, a.provider, a.thinking, {
      mcpConfig: a.mcp_config,
      kind: a.kind,
    });
    emit({ type: "agent_pane", agent: a.name, pane: res.pane });

    let message = buildPrompt(a, results);
    while (true) {
      deps.signal?.throwIfAborted();
      const since = await backend.checkpoint(a.name);
      await promptHerdr(backend, a, message, since, emit, deps);
      res.text = await backend.reply(a.name, since);
      res.rounds += 1;

      let verdict: boolean | null = null;
      let reviewOut = "";
      if (a.review_cmd) {
        [verdict, reviewOut] = await runReview(a.review_cmd, plan.cwd, a.name, deps.signal);
      } else if (orch) {
        // the delegate-wave orchestrator pane judges against done_when
        [verdict, reviewOut] = await orch.review(a, res.text);
      }
      if (verdict === null || verdict) {
        res.status = "pass";
        break;
      }

      emit({ type: "review_failed", agent: a.name, round: res.rounds, review_output_tail: reviewOut.slice(-500) });
      if (res.rounds > a.max_fix_rounds) {
        res.status = "fail";
        res.feedback = reviewOut;
        break;
      }
      message = fixPrompt(a, res.rounds, reviewOut);
    }
  } catch (e) {
    recordFailure(res, e);
  }
  const session = backend.sessionFile(a.name);
  if (session) res.session = session;
  // Intentionally no teardown: the pane and the agent stay open for the user.
  emit({ type: "agent_done", agent: a.name, status: res.status, rounds: res.rounds, pane: res.pane, text: res.text });
  return res;
}

/** Headless agent via pi RPC mode - structured events, no visible pane. */
export async function runAssignmentRpc(
  a: Assignment,
  waveIdx: number,
  plan: Plan,
  results: Map<string, AgentResult>,
  emit: Emitter,
  deps: Deps = defaultDeps,
): Promise<AgentResult> {
  const res = newResult(a.name, waveIdx + 1, a.model, "headless");
  if (a.kind === "omp") {
    res.error =
      `kind=omp requires display=herdr - OMP agents need a Herdr pane ` +
      `(set "display": "herdr" or run inside Herdr with display auto)`;
    emit({ type: "agent_done", agent: a.name, status: res.status, rounds: 0 });
    return res;
  }
  emit({ type: "agent_start", agent: a.name, wave: res.wave, model: a.model, display: "headless" });
  if (deps.sessionsDir) res.session = path.join(deps.sessionsDir, `${a.name}.jsonl`);
  const sess = deps.rpcSession({
    agentName: a.name,
    cwd: plan.cwd,
    model: a.model,
    provider: a.provider,
    thinking: a.thinking,
    loadExtensions: a.load_extensions,
    mcpConfig: a.mcp_config,
    sessionFile: res.session,
    onEvent: (name, ev) => emit({ agent: name, ...ev, type: "agent_progress" }),
  });
  // closing the session makes an in-flight prompt fail fast
  const onAbort = () => void sess.close().catch(() => {});
  deps.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    sess.verifyModel(await sess.start());

    let message = buildPrompt(a, results);
    while (true) {
      deps.signal?.throwIfAborted();
      await sess.promptAndSettle(message, a.timeout);
      res.text = await sess.lastText();
      res.rounds += 1;

      if (!a.review_cmd) {
        res.status = "pass";
        break;
      }
      const [ok, reviewOut] = await runReview(a.review_cmd, plan.cwd, a.name, deps.signal);
      if (ok) {
        res.status = "pass";
        break;
      }

      emit({ type: "review_failed", agent: a.name, round: res.rounds, review_output_tail: reviewOut.slice(-500) });
      if (res.rounds > a.max_fix_rounds) {
        res.status = "fail";
        res.feedback = reviewOut;
        break;
      }
      message = fixPrompt(a, res.rounds, reviewOut);
    }
    res.stats = await sess.stats();
  } catch (e) {
    recordFailure(res, e);
  } finally {
    deps.signal?.removeEventListener("abort", onAbort);
    await sess.close();
  }
  emit({ type: "agent_done", agent: a.name, status: res.status, rounds: res.rounds, text: res.text });
  return res;
}

export interface SyncOutcome {
  status: "pass" | "fail";
  rounds: number;
  issues?: string;
}

/** After a wave passes its own checks, have the orchestrator cross-check
 * it and route what it finds to the agents that own the work - in this wave
 * or an earlier one, whose panes stay open - as fix prompts, up to
 * MAX_SYNC_ROUNDS times. Agents still flagged after that fail. Agents
 * without a live pane (headless, or never started) cannot take a fix, so
 * their issues stay open. Mutates `results`. */
export async function syncWave(
  wIdx: number,
  plan: Plan,
  results: Map<string, AgentResult>,
  orch: OrchestratorPane,
  herdr: HerdrLike,
  emit: Emitter,
  deps: Deps,
): Promise<SyncOutcome> {
  const wave = plan.waves[wIdx]!;
  const assignments = new Map(plan.waves.flat().map((a) => [a.name, a]));
  const reports = wave
    .map((a) => `### ${a.name} (files: ${filesLabel(a)})\nDEFINITION OF DONE: ${doneWhen(a)}\nREPORT:\n` +
      clip(results.get(a.name)?.text ?? "", MAX_RESULT_CHARS))
    .join("\n\n");
  const owners = [...results.values()]
    .map((r) => `- ${r.name} (wave ${r.wave}, files: ${filesLabel(assignments.get(r.name)!)}, status ${r.status})`)
    .join("\n");
  let fixes = "";
  for (let round = 1; ; round++) {
    deps.signal?.throwIfAborted();
    emit({ type: "sync_start", wave: wIdx + 1, round });
    const verdict = await orch.sync(wIdx + 1, reports, owners, fixes);
    if (verdict.ok) {
      emit({ type: "sync_done", wave: wIdx + 1, status: "pass", rounds: round - 1 });
      return { status: "pass", rounds: round - 1 };
    }
    const fixable = [...verdict.fixes].filter(([name]) => {
      const r = results.get(name);
      return r?.display === "herdr" && r.pane !== "";
    });
    const open = [
      ...(verdict.note ? [verdict.note] : []),
      ...[...verdict.fixes].filter(([name]) => !fixable.some(([n]) => n === name))
        .map(([name, items]) => `${name} (no pane to send a fix to):\n${items}`),
    ];
    if (round > MAX_SYNC_ROUNDS || fixable.length === 0) {
      for (const [name, items] of verdict.fixes) {
        const r = results.get(name);
        if (r) Object.assign(r, { status: "fail", feedback: items });
      }
      const issues = [...[...verdict.fixes].map(([name, items]) => `${name}:\n${items}`), ...(verdict.note ? [verdict.note] : [])]
        .join("\n\n");
      emit({ type: "sync_done", wave: wIdx + 1, status: "fail", rounds: round - 1, issues_tail: issues.slice(-500) });
      return { status: "fail", rounds: round - 1, issues };
    }

    const fixOne = async ([name, items]: [string, string]) => {
      const a = assignments.get(name)!;
      const r = results.get(name)!;
      emit({ type: "sync_fix", wave: wIdx + 1, round, agent: name, issues_tail: items.slice(-500) });
      try {
        const since = await herdr.checkpoint(name);
        await promptHerdr(herdr, a, syncFixTemplate(round, MAX_SYNC_ROUNDS, filesLabel(a), items), since, emit, deps);
        const reply = await herdr.reply(name, since);
        r.text += `\n\nSYNC FIX ${round}:\n${reply}`;
        r.rounds += 1;
        let check = "";
        if (a.review_cmd) {
          const [ok, out] = await runReview(a.review_cmd, plan.cwd, a.name, deps.signal);
          if (!ok) check = `\nits review_cmd now fails:\n${out.slice(-1500)}`;
        }
        return `${name} replied:\n${clip(reply, MAX_SYNTH_RESULT_CHARS)}${check}`;
      } catch (e) {
        return `${name} could not take the fix (${errMsg(e)})`;
      }
    };
    // owners from different waves may share a file; only disjoint ones fix at once
    const files = fixable.flatMap(([name]) => assignments.get(name)!.files);
    const replies =
      new Set(files).size === files.length
        ? await Promise.all(fixable.map(fixOne))
        : await fixable.reduce<Promise<string[]>>(async (acc, f) => [...(await acc), await fixOne(f)], Promise.resolve([]));
    fixes = [...replies, ...open.map((o) => `still open: ${o}`)].join("\n\n");
  }
}

/** pi models the plan names that pi cannot run (a typo, or a provider
 * without auth), as "model (who)". pi accepts any id at start-up and only
 * fails on the first prompt, so this is checked before anything spawns.
 * kind=omp agents run another CLI and are not checked. */
export async function unknownModels(plan: Plan, deps: Deps): Promise<string[]> {
  const wanted = new Map<string, string[]>();
  const want = (model: string, who: string) => wanted.set(model, [...(wanted.get(model) ?? []), who]);
  for (const a of plan.waves.flat()) {
    if (a.kind === "pi") want(a.model.includes("/") || !a.provider ? a.model : `${a.provider}/${a.model}`, a.name);
  }
  if (plan.orchestrator) {
    want(plan.orchestrator.model, "orchestrator");
    if (plan.orchestrator.synthesis_model) want(plan.orchestrator.synthesis_model, "synthesizer");
  }
  const known = await deps.listModels();
  if (!known) return [];
  return [...wanted].filter(([model]) => !known.has(model)).map(([model, who]) => `${model} (${who.join(", ")})`);
}

export interface RunOptions {
  /** The run's own dir (see newRunDir): its state.json is saved after every
   * agent and wave, and agents record their sessions in its sessions/. */
  runDir?: string;
  /** An earlier run of this plan: its passed agents are kept, not run again. */
  resume?: RunState;
}

/** The passed results of an earlier run that still hold for `plan`: same
 * wave, same assignment. An edited assignment runs again. */
function keptResults(plan: Plan, prior: RunState): AgentResult[] {
  if (prior.plan.cwd !== plan.cwd) {
    throw new Error(`cannot resume in ${plan.cwd}: the earlier run ran in ${prior.plan.cwd}`);
  }
  const before = new Map(prior.plan.waves.flat().map((a) => [a.name, JSON.stringify(a)]));
  return plan.waves.flatMap((wave, wIdx) =>
    wave.flatMap((a) => {
      const r = prior.results[a.name];
      const same = r?.status === "pass" && r.wave === wIdx + 1 && before.get(a.name) === JSON.stringify(a);
      return same ? [{ ...r, resumed: true }] : [];
    }),
  );
}

export async function orchestrate(
  plan: Plan,
  emit: Emitter,
  deps: Deps = defaultDeps,
  opts: RunOptions = {},
): Promise<Json> {
  const kept = opts.resume ? keptResults(plan, opts.resume) : [];
  emit({
    type: "plan_start",
    plan: plan.name,
    cwd: plan.cwd,
    waves: plan.waves.length,
    agents: plan.waves.reduce((n, w) => n + w.length, 0),
  });
  if (opts.resume) emit({ type: "resumed", agents: kept.map((r) => r.name) });

  const stateFile = opts.runDir && path.join(opts.runDir, "state.json");
  const sessionsDir = opts.runDir && path.join(opts.runDir, "sessions");
  if (sessionsDir) mkdirSync(sessionsDir, { recursive: true });

  // One Herdr backend for the whole run: it holds each pane agent's session
  // file, which a sync fix to an earlier wave's agent needs.
  let herdr: HerdrLike | null = null;
  const makeHerdr = deps.herdrBackend;
  deps = { ...deps, sessionsDir, herdrBackend: (cwd, signal) => (herdr ??= makeHerdr(cwd, signal, sessionsDir)) };

  const results = new Map<string, AgentResult>(kept.map((r) => [r.name, r]));
  const syncs = new Map<number, SyncOutcome>();
  const state = () => ({ plan, results: Object.fromEntries(results), syncs: Object.fromEntries(syncs) });
  // the first save must work, before anything is spent; a later failure
  // only warns - stopping live agents over it would waste more than it saves
  if (stateFile) saveState(stateFile, state());
  const save = () => {
    if (!stateFile) return;
    try {
      saveState(stateFile, state());
    } catch (e) {
      emit({ type: "state_error", error: errMsg(e) });
    }
  };
  let overall = "completed";
  // why the run stopped early; it also goes into the summary, which is all
  // a tool caller gets back (the stopped event only streams as an update)
  let stopReason = "";
  const stop = (reason: string) => {
    overall = "stopped";
    stopReason = reason;
    emit({ type: "stopped", reason });
  };
  const unknown = await unknownModels(plan, deps);
  if (unknown.length) {
    stop(
      `pi cannot run ${unknown.join("; ")} - fix the model id (list what is ` +
        `available with: pi --list-models <search>); nothing was dispatched`,
    );
  }

  // one shared grid for the whole run: orchestrator right, then the
  // assignment row splits down and fills right (see PaneLayout)
  const layout = new PaneLayout();
  let orch: OrchestratorPane | null = null;
  if (plan.orchestrator && !unknown.length) {
    const problem = deps.herdrAvailable();
    if (problem) {
      emit({ type: "orchestrator_error", error: problem });
    } else {
      orch = new OrchestratorPane(deps.herdrBackend(plan.cwd, deps.signal), plan.orchestrator, layout);
      try {
        await orch.start();
        emit({
          type: "orchestrator_start",
          model: plan.orchestrator.model,
          thinking: plan.orchestrator.thinking,
          pane: orch.pane,
        });
      } catch (e) {
        emit({ type: "orchestrator_error", error: errMsg(e) });
        orch = null;
      }
    }
  }

  for (const [wIdx, allOfWave] of unknown.length ? [] : plan.waves.entries()) {
    deps.signal?.throwIfAborted();
    // on a resume, only what did not pass runs; a wave that passed and
    // synced is done, one whose sync failed only syncs again
    const wave = allOfWave.filter((a) => !results.has(a.name));
    const priorSync = opts.resume?.syncs[wIdx];
    if (!wave.length && priorSync?.status !== "fail") {
      if (priorSync) syncs.set(wIdx, priorSync);
      continue;
    }
    // delegate-wave skill: 4 agents per wave in herdr mode - the assignment
    // row fills right (see PaneLayout), so too many panes in one wave still
    // make unusably narrow columns (observed: the last-split agent
    // stalls/fails). Headless waves have no panes and no such limit.
    const herdrAgents = wave.filter((a) => resolveDisplay(a.display) === "herdr").map((a) => a.name);
    if (herdrAgents.length > MAX_HERDR_AGENTS_PER_WAVE) {
      stop(
        `wave ${wIdx + 1} has ${herdrAgents.length} herdr-display agents ` +
          `(${herdrAgents.join(", ")}) - the delegate-wave skill caps panes ` +
          `at ${MAX_HERDR_AGENTS_PER_WAVE} agents per wave (unusably narrow ` +
          `columns); split into more waves or force display headless`,
      );
      break;
    }
    emit({ type: "wave_start", wave: wIdx + 1, agents: wave.map((a) => a.name) });
    await Promise.all(
      wave.map(async (a) => {
        results.set(a.name, await runAssignment(a, wIdx, plan, results, emit, orch, layout, deps));
        save();
      }),
    );
    let waveOk = allOfWave.every((a) => results.get(a.name)?.status === "pass");
    // a lone first wave has nothing to agree with yet
    if (orch && waveOk && (allOfWave.length > 1 || wIdx > 0)) {
      const sync = await syncWave(wIdx, plan, results, orch, deps.herdrBackend(plan.cwd, deps.signal), emit, deps);
      syncs.set(wIdx, sync);
      waveOk = sync.status === "pass";
    }
    save();
    emit({ type: "wave_done", wave: wIdx + 1, passed: waveOk });
    if (!waveOk && plan.on_failure === "stop") {
      stop("wave failed and plan.on_failure is 'stop'; later waves were not dispatched");
      break;
    }
  }

  const summary: Json = {
    type: "summary",
    plan: plan.name,
    cwd: plan.cwd,
    ...(opts.runDir ? { run_dir: opts.runDir } : {}),
    status: overall,
    ...(stopReason ? { reason: stopReason } : {}),
    waves: plan.waves.map((wave, i) => ({
      wave: i + 1,
      ...(syncs.has(i) ? { sync: syncs.get(i) } : {}),
      agents: wave.flatMap((a) => {
        const r = results.get(a.name);
        return r ? [resultJson(r)] : [];
      }),
    })),
  };
  deps.signal?.throwIfAborted();
  if (orch) {
    try {
      summary.synthesis = await orch.synthesize(results);
      emit({ type: "orchestrator_done", pane: orch.pane, ...(orch.synthPane ? { synthesis_pane: orch.synthPane } : {}) });
    } catch (e) {
      // synthesis is a bonus, not a gate - report its failure honestly
      summary.synthesis = `(orchestrator synthesis failed: ${errMsg(e)})`;
      emit({ type: "orchestrator_error", error: `synthesis failed: ${errMsg(e)}` });
    }
  }
  emit(summary);
  return summary;
}
