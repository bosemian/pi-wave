// Herdr display backend - assignment agents run live in Herdr panes.
//
// Used when an assignment has display: "herdr". The engine must itself run
// inside a Herdr pane (HERDR_ENV=1): it inherits the caller context, so the
// first `pane split --current` splits the parent agent's pane to the right
// (the orchestrator), the next pane splits down off it to open the assignment
// row, and every pane after that splits right along that row (see PaneLayout)
// - the delegate-wave visual, driven by a program.
//
// Rules carried over from the herdr/delegate-wave skills:
// - equal assignment panes: split --ratio 0.5 each time;
// - parse IDs from the JSON responses, never guess them;
// - a `blocked` agent is reported, never answered;
// - panes are left open after the run for the user to inspect.

import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentTimeoutError } from "./errors.ts";

type Json = Record<string, any>;

export const READ_LINES = 240;
/** How long a pane must hold still before an agent without a session file
 * counts as done: a working TUI animates, but a thinking model can leave
 * it untouched for several seconds. */
export const PANE_QUIET_S = 30;

export class HerdrError extends Error {
  override name = "HerdrError";
}

/** The agent is sitting at an approval/question dialog. Never answer it
 * programmatically - surface it to the user instead. */
export class HerdrBlocked extends HerdrError {
  override name = "HerdrBlocked";
}

/** herdr observed no state change within its hard 5s window after a
 * submission from idle - typical for a freshly spawned OMP CLI that is
 * still booting. The submission may still kick in late (observed: the
 * engine had already failed the assignment while the agent later did
 * the work), so callers should watch for a late start before resending. */
export class HerdrPromptStalled extends AgentTimeoutError {
  override name = "HerdrPromptStalled";
}

/** `agent start` found the pane not at its interactive shell prompt. herdr
 * refuses at once rather than waiting, which can happen for a pane split
 * a few milliseconds earlier whose shell is not up yet. */
export class HerdrPaneBusy extends HerdrError {
  override name = "HerdrPaneBusy";
}

export const sleep = (s: number) => new Promise<void>((resolve) => setTimeout(resolve, s * 1000));

const expandUser = (p: string) =>
  p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;

/** Like shutil.which: an executable file of that name on PATH. */
function onPath(bin: string): boolean {
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => {
    const p = path.join(dir, bin);
    try {
      accessSync(p, constants.X_OK);
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

export function herdrAvailable(): string | null {
  if (process.env.HERDR_ENV !== "1") {
    return "display=herdr requires running inside Herdr (HERDR_ENV=1) - run pi-wave from a Herdr pane";
  }
  if (!onPath("herdr")) {
    return "herdr binary not found in PATH";
  }
  return null;
}

/** Serializes async critical sections (asyncio.Lock equivalent). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
}

/** Shared pane-grid tracker for one delegate-wave run.
 *
 * The first pane splits the engine's own pane to the right (the
 * orchestrator), the second splits down off it to open the assignment
 * row, and every pane after that splits right along that row:
 *
 *     +---+--------------------+
 *     | E |         O          |
 *     |   +----+----+----+-----+
 *     |   | a1 | a2 | a3 | a4  |
 *     +---+----+----+----+-----+
 *
 * Each split targets the previously created pane, so the row grows to the
 * right. Splits are serialized so the chain stays deterministic even when
 * a wave dispatches its agents concurrently. */
export class PaneLayout {
  private lock = new Mutex();
  private lastPane: string | null = null;
  private count = 0;

  nextSplit(backend: Pick<HerdrBackend, "splitPane">, ratio = 0.5): Promise<string> {
    return this.lock.run(async () => {
      // first split of the run: the engine's own pane, to the right;
      // the second pane drops down to start the row; the rest fill right
      const pane =
        this.count === 0
          ? await backend.splitPane(null, "right", ratio)
          : await backend.splitPane(this.lastPane, this.count === 1 ? "down" : "right", ratio);
      this.count += 1;
      this.lastPane = pane;
      return pane;
    });
  }
}

/** Defensive depth-first search - herdr result shapes vary by version. */
export function findKey(obj: unknown, key: string): any {
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const found = findKey(v, key);
      if (found !== undefined && found !== null) return found;
    }
  } else if (typeof obj === "object" && obj !== null) {
    if (key in obj) return (obj as Json)[key];
    for (const v of Object.values(obj)) {
      const found = findKey(v, key);
      if (found !== undefined && found !== null) return found;
    }
  }
  return null;
}

const head = (args: string[]) => args.slice(0, 3).join(" ");

/** Where an agent was before a prompt: its pane scrollback (for the
 * wait-for-done fallback), how many prompts and replies its session held,
 * and whether it was still mid-turn (its session's last message is not a
 * reply). */
export interface Checkpoint {
  scrollback: string;
  prompts: number;
  replies: number;
  busy: boolean;
}

/** The replies in a pi or OMP session file (both write the same entries),
 * in order, how many prompts (user messages) it received, and whether its
 * last message leaves a turn open. A reply is an
 * assistant message that ended its turn: one that stopped for tool use is
 * mid-turn, the agent keeps going after the tool results. A missing file
 * (nothing sent yet) has none; a line still being written is skipped. */
function sessionReplies(file: string | null): { replies: string[]; prompts: number; busy: boolean } {
  let raw = "";
  try {
    if (file) raw = readFileSync(file, "utf8");
  } catch {
    // not created yet
  }
  const replies: string[] = [];
  let prompts = 0;
  let busy = false;
  for (const line of raw.split("\n")) {
    let entry: Json;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = entry?.type === "message" ? entry.message : null;
    if (!msg) continue;
    if (msg.role === "user") prompts += 1;
    busy = msg.role !== "assistant" || msg.stopReason === "toolUse";
    if (busy) continue;
    const content: Json[] = Array.isArray(msg.content) ? msg.content : [];
    replies.push(content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(""));
  }
  return { replies, prompts, busy };
}

export class HerdrBackend {
  static readonly SETTLED = ["idle", "done"];

  protected readonly cwd: string;
  private readonly signal: AbortSignal | undefined;
  /** Agents record their conversation here, so replies are read exactly
   * instead of scraped from the pane's scrollback: pi to the file named by
   * --session, omp to the one file it creates in its own --session-dir. */
  private readonly sessions = new Map<string, { file: string } | { dir: string }>();
  private sessionDir: string | null = null;

  /** Aborting `signal` kills any herdr command still running (e.g. a
   * `prompt --wait`), so a cancelled run does not wait out its timeout. */
  constructor(cwd: string, signal?: AbortSignal) {
    this.cwd = cwd;
    this.signal = signal;
  }

  protected run(args: string[], timeoutS = 60): Promise<[number, string, string]> {
    return new Promise((resolve, reject) => {
      const proc = spawn("herdr", args, { cwd: this.cwd, stdio: ["ignore", "pipe", "pipe"], signal: this.signal });
      let out = "";
      let err = "";
      proc.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
      proc.stderr.setEncoding("utf8").on("data", (c: string) => (err += c));
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new HerdrError(`herdr ${head(args)}... timed out after ${Math.round(timeoutS)}s`));
      }, timeoutS * 1000);
      proc.on("error", (e) => {
        clearTimeout(timer);
        reject(e.name === "AbortError" ? e : new HerdrError(`herdr ${head(args)}... could not run: ${e.message}`));
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        // killed by a signal: no exit code, but certainly not a success
        resolve([code ?? 1, out, err]);
      });
    });
  }

  protected async runJson(args: string[], timeoutS = 60): Promise<Json> {
    const [rc, out, err] = await this.run(args, timeoutS);
    let payload: unknown = null;
    for (const raw of [out, err]) {
      const text = raw.trim();
      if (!text.startsWith("{")) continue;
      try {
        payload = JSON.parse(text);
        break;
      } catch {
        // try the other stream
      }
    }
    if (rc !== 0) {
      const code = payload ? String(findKey(payload, "code") ?? "") : "";
      const detail = err.trim().slice(0, 400) || out.trim().slice(0, 400);
      // Classify by herdr's error code first: its messages name other states
      // in prose (agent_prompt_stalled reads "no observed working or blocked
      // state"), so matching the text is only a fallback for code-less output.
      if (code.includes("stalled")) {
        throw new HerdrPromptStalled(`herdr timed out waiting for the agent: ${detail}`);
      }
      if (code.includes("blocked") || (!code && detail.toLowerCase().includes("blocked"))) {
        throw new HerdrBlocked(
          `agent is waiting at an approval/question dialog (never answer it ` +
            `programmatically - inspect the pane and ask the user): ${detail}`,
        );
      }
      if (code.includes("timeout")) {
        throw new AgentTimeoutError(`herdr timed out waiting for the agent: ${detail}`);
      }
      if (code === "agent_pane_busy") {
        throw new HerdrPaneBusy(`herdr ${head(args)}... failed (exit ${rc}): ${detail}`);
      }
      throw new HerdrError(`herdr ${head(args)}... failed (exit ${rc}): ${detail}`);
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new HerdrError(`herdr ${head(args)}... returned no JSON: ${out.trim().slice(0, 200)}`);
    }
    return payload as Json;
  }

  // -- wave-agent lifecycle -------------------------------------------------

  /** Split a pane and return the new pane id.
   *
   * With no paneId, splits the engine's own current pane (the first split
   * of a run); otherwise splits the given pane. direction is "right" or
   * "down". Assignment panes keep the delegate-wave default of equal halves
   * (0.5); the orchestrator pane is split first with a lower ratio so it
   * ends up wider than any assignment pane. The grid policy lives in
   * PaneLayout. */
  async splitPane(paneId: string | null = null, direction: "right" | "down" = "right", ratio = 0.5): Promise<string> {
    const target = paneId === null ? ["--current"] : ["--pane", paneId];
    const resp = await this.runJson([
      "pane", "split", ...target, "--direction", direction,
      "--cwd", this.cwd, "--no-focus", "--ratio", String(ratio),
    ]);
    const newPane = findKey(resp.result ?? resp, "pane_id");
    if (!newPane) throw new HerdrError(`pane split returned no pane_id: ${JSON.stringify(resp).slice(0, 300)}`);
    return String(newPane);
  }

  /** Start an agent in the pane; returns the argv Herdr detected.
   *
   * kind "pi" runs the pi agent CLI (model must be provider-qualified);
   * kind "omp" runs the OMP CLI with a bare model id (the delegate-wave
   * rule: only Sonnet goes through OMP). systemPrompt, when set, is
   * appended to the pi agent's system prompt - role constraints that must
   * hold before any prompt arrives (pi kind only). A pane whose shell is
   * not up yet (HerdrPaneBusy) is retried for up to readyS seconds. */
  async startAgent(
    name: string,
    paneId: string,
    model: string,
    provider: string | null,
    thinking: string,
    {
      mcpConfig = "",
      kind = "pi",
      systemPrompt = "",
      readyS = 10,
      pollS = 0.25,
    }: { mcpConfig?: string; kind?: string; systemPrompt?: string; readyS?: number; pollS?: number } = {},
  ): Promise<string[]> {
    const modelArg =
      kind === "omp"
        ? (model.split("/").at(-1) ?? model)
        : model.includes("/") || !provider
          ? model
          : `${provider}/${model}`;
    const extra = ["--model", modelArg, "--thinking", thinking];
    // interactive pi already loads pi-mcp-adapter (user package); only
    // hand it this assignment's config
    if (mcpConfig) extra.push("--mcp-config", expandUser(mcpConfig));
    if (systemPrompt && kind === "pi") extra.push("--append-system-prompt", systemPrompt);
    this.sessionDir ??= mkdtempSync(path.join(os.tmpdir(), "pi-wave-sessions-"));
    if (kind === "pi") {
      const file = path.join(this.sessionDir, `${name}.jsonl`);
      extra.push("--session", file);
      this.sessions.set(name, { file });
    } else if (kind === "omp") {
      // omp has no --session <file>; it names its own file in this dir
      const dir = path.join(this.sessionDir, name);
      extra.push("--session-dir", dir);
      this.sessions.set(name, { dir });
    }
    const args = ["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", "60000", "--", ...extra];
    const deadline = Date.now() + readyS * 1000;
    let resp: Json;
    for (;;) {
      try {
        resp = await this.runJson(args, 90);
        break;
      } catch (e) {
        if (!(e instanceof HerdrPaneBusy) || Date.now() >= deadline) throw e;
        await sleep(pollS);
      }
    }
    const argv = findKey(resp.result ?? resp, "argv");
    if (!Array.isArray(argv)) {
      throw new HerdrError(`agent start returned no argv: ${JSON.stringify(resp).slice(0, 300)}`);
    }
    const want = modelArg.split("/").at(-1) ?? modelArg;
    const joined = argv.map(String).join(" ");
    if (!joined.includes(want)) {
      throw new HerdrError(
        `[${name}] model mismatch: argv '${joined}' does not contain '${want}' ` +
          `(the RPC analogue of delegate-wave's footer check)`,
      );
    }
    return argv.map(String);
  }

  /** Send one prompt and wait for the agent to settle. `--wait` also ends
   * successfully when the agent stops at an approval/question dialog, so a
   * blocked agent is raised here rather than read back as finished. */
  async prompt(name: string, text: string, timeoutS: number): Promise<void> {
    await this.runJson(
      ["agent", "prompt", name, text, "--wait", "--timeout", String(Math.trunc(timeoutS * 1000))],
      timeoutS + 60,
    );
    if (HerdrBackend.agentStatus(await this.state(name)) === "blocked") {
      throw new HerdrBlocked(`agent '${name}' is waiting at an approval/question dialog`);
    }
  }

  /** herdr's `agent get` reports the agent's own status under
   * 'agent_status' (confirmed live on herdr 0.8.2 - the shape has no
   * 'status' key at all, so a bare lookup for 'status' always misses and
   * every wait falls straight through to 'unknown'/idle, making every
   * stall look permanent regardless of what the agent is doing). 'status'
   * is kept as a fallback for other herdr shapes. */
  static agentStatus(state: Json): string {
    return String(findKey(state, "agent_status") || findKey(state, "status") || "unknown");
  }

  /** After a stalled submission: return the first non-idle status seen
   * within watchS (the submission kicking in late), or null if the agent
   * stays idle the whole time. */
  async waitLateStart(name: string, watchS = 10, pollS = 0.5): Promise<string | null> {
    const deadline = performance.now() + watchS * 1000;
    while (true) {
      const status = HerdrBackend.agentStatus(await this.state(name));
      if (status !== "idle" && status !== "unknown") return status;
      if (performance.now() >= deadline) return null;
      await sleep(pollS);
    }
  }

  /** Poll until the agent is idle/done again, blocked, or out of time. */
  async waitSettled(name: string, timeoutS: number, pollS = 0.5): Promise<void> {
    const deadline = performance.now() + timeoutS * 1000;
    while (true) {
      const status = HerdrBackend.agentStatus(await this.state(name));
      if (status === "blocked") {
        throw new HerdrBlocked(`agent '${name}' is waiting at an approval/question dialog`);
      }
      if (HerdrBackend.SETTLED.includes(status)) return;
      if (performance.now() >= deadline) {
        throw new AgentTimeoutError(
          `[${name}] agent did not settle within ${Math.round(timeoutS)}s (last status: ${status})`,
        );
      }
      await sleep(pollS);
    }
  }

  /** The session file an agent records to, or null if it has none (yet):
   * omp creates `<timestamp>_<id>.jsonl` (plus a hidden lock file) in its
   * --session-dir once it starts. */
  private sessionFile(name: string): string | null {
    const s = this.sessions.get(name);
    if (!s) return null;
    if ("file" in s) return s.file;
    try {
      const files = readdirSync(s.dir).filter((f) => f.endsWith(".jsonl") && !f.startsWith("."));
      return files.length ? path.join(s.dir, files.sort().at(-1)!) : null;
    } catch {
      return null;
    }
  }

  /** Status-independent wait for an agent whose herdr status never
   * confirmed it took the prompt (always the case for omp).
   *
   * Done means: with a session file, the session gained a reply since
   * `since` - a message that ended the turn, not a tool-use step; without
   * one, the pane differs from `since.scrollback` (read BEFORE the prompt
   * was sent, so an agent that already finished counts) and has then held
   * still for quietS. Either way the wait is bounded by timeoutS, and the
   * pane tells why it gave up: never changed within bootS (it never took
   * the prompt - likely never finished booting), still changing at the
   * deadline (still working), or quiet without a reply. A pane that keeps
   * changing is an agent at work, never a stall. */
  async waitDone(
    name: string,
    since: Checkpoint,
    timeoutS: number,
    bootS: number,
    pollS = 1,
    quietS = PANE_QUIET_S,
  ): Promise<void> {
    const hasSession = this.sessions.has(name);
    const start = performance.now();
    let last = since.scrollback;
    let changedAt: number | null = null;
    while (true) {
      if (hasSession && sessionReplies(this.sessionFile(name)).replies.length > since.replies) return;
      const text = await this.read(name);
      const now = performance.now();
      if (text !== last) changedAt = now;
      last = text;
      const quiet = changedAt !== null && now - changedAt >= quietS * 1000;
      if (!hasSession && quiet) return;
      if (changedAt === null && now - start >= bootS * 1000) {
        throw new AgentTimeoutError(
          `[${name}] its pane never changed within ${Math.round(bootS)}s of the prompt - ` +
            `it likely never finished booting`,
        );
      }
      if (now - start >= timeoutS * 1000) {
        throw new AgentTimeoutError(
          quiet
            ? `[${name}] its pane went quiet without finishing a reply within the ${Math.round(timeoutS)}s timeout`
            : `[${name}] still working at the ${Math.round(timeoutS)}s timeout (its pane was still changing)`,
        );
      }
      await sleep(pollS);
    }
  }

  /** Snapshot taken before a prompt; pass it to reply() afterwards. */
  async checkpoint(name: string): Promise<Checkpoint> {
    const { replies, prompts, busy } = sessionReplies(this.sessionFile(name));
    return { scrollback: await this.read(name), prompts, replies: replies.length, busy };
  }

  /** Submit a prompt still sitting in the agent's editor: if its session
   * received no prompt since `since`, press Enter once. omp v18 keeps a big
   * paste as a collapsed attachment (📄 #1) that herdr's own Enter does not
   * submit (confirmed live); Enter on an empty editor does nothing. Returns
   * whether it pressed Enter. */
  async submitPending(name: string, since: Checkpoint): Promise<boolean> {
    if (sessionReplies(this.sessionFile(name)).prompts > since.prompts) return false;
    await this.runJson(["agent", "send-keys", name, "Enter"]);
    return true;
  }

  /** The agent's answer to the prompt sent after `since`.
   *
   * Agents with a session file: the last reply their session gained since
   * then, or "" if they gained none (a stale earlier reply, e.g. a previous
   * VERDICT in the orchestrator pane, is never returned). The reply is
   * written as the turn ends, so a short grace covers a settle that is
   * reported a moment before the write. Agents without one fall back to
   * the pane scrollback. */
  async reply(name: string, since: Checkpoint, graceS = 3, pollS = 0.25): Promise<string> {
    if (!this.sessions.has(name)) return this.read(name);
    const deadline = performance.now() + graceS * 1000;
    while (true) {
      const { replies } = sessionReplies(this.sessionFile(name));
      if (replies.length > since.replies) return replies.at(-1) ?? "";
      if (performance.now() >= deadline) return "";
      await sleep(pollS);
    }
  }

  async read(name: string, lines = READ_LINES): Promise<string> {
    const [rc, out, err] = await this.run([
      "agent", "read", name, "--source", "recent-unwrapped", "--lines", String(lines), "--format", "text",
    ]);
    if (rc !== 0) throw new HerdrError(`herdr agent read ${name} failed (exit ${rc}): ${err.trim().slice(0, 300)}`);
    return out;
  }

  state(name: string): Promise<Json> {
    return this.runJson(["agent", "get", name]);
  }
}
