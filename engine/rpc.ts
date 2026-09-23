// Async client for pi's RPC mode (JSONL over stdin/stdout).
//
// Framing per pi docs/rpc.md: records are separated by LF (\n) only, so we
// split on \n ourselves (node:readline would also split on \r and U+2028).
//
// One PiRpcSession = one assignment agent. The session is short-lived per
// assignment (and per fix round we re-prompt the same process, mirroring
// delegate-wave's "one consolidated fix prompt to the originating agent").

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentTimeoutError } from "./errors.ts";

type Json = Record<string, any>;
export type EventHook = (agentName: string, ev: Json) => void;

const expandUser = (p: string) =>
  p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;

// pi's MCP support (--mcp-config) is registered by the pi-mcp-adapter package.
// With --no-extensions, package discovery is off but explicit -e paths still
// load - so we load ONLY the adapter (never dispatch-wave: recursion guard
// stays intact) and hand it the assignment's MCP config.
export const MCP_ADAPTER_ENTRY =
  process.env.PI_WAVE_MCP_ADAPTER ?? "~/.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts";

export class PiRpcError extends Error {
  override name = "PiRpcError";
}

export function mcpFlags(mcpConfig: string): string[] {
  if (!mcpConfig) return [];
  const entry = expandUser(MCP_ADAPTER_ENTRY);
  if (!statSync(entry, { throwIfNoEntry: false })?.isFile()) {
    throw new PiRpcError(
      `mcp_config requires the pi-mcp-adapter package but its entry was not ` +
        `found at ${entry} (install with: pi install npm:pi-mcp-adapter, or set PI_WAVE_MCP_ADAPTER)`,
    );
  }
  return ["--no-extensions", "-e", entry, "--mcp-config", expandUser(mcpConfig)];
}

/** Every "provider/model" pi can run here, from `pi --list-models` (which
 * lists only providers with working auth), or null when the list cannot be
 * read - callers then skip the check rather than block the run. */
export function listPiModels(piBin = "pi", timeoutS = 30): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    const proc = spawn(piBin, ["--list-models"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutS * 1000);
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const [header, ...rows] = out.trim().split("\n");
      if (code !== 0 || !header?.trim().startsWith("provider")) return resolve(null);
      const models = new Set<string>();
      for (const row of rows) {
        const [provider, model] = row.trim().split(/\s+/);
        if (provider && model) models.add(`${provider}/${model}`);
      }
      resolve(models);
    });
  });
}

export interface PiRpcSessionOptions {
  agentName: string;
  cwd: string;
  model: string;
  provider?: string | null;
  thinking?: string;
  loadExtensions?: boolean;
  mcpConfig?: string;
  onEvent?: EventHook;
  /** Executable to spawn; tests point this at a fake pi. */
  piBin?: string;
}

const PROCESS_EXIT = "__process_exit__";

/** Unbounded FIFO of events with a timed async get(). */
class EventQueue {
  private items: Json[] = [];
  private waiter: ((ev: Json) => void) | null = null;

  put(ev: Json): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(ev);
    } else {
      this.items.push(ev);
    }
  }

  /** Resolves with the next event, or null after timeoutMs. */
  get(timeoutMs: number): Promise<Json | null> {
    const ev = this.items.shift();
    if (ev) return Promise.resolve(ev);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, Math.max(0, timeoutMs));
      this.waiter = (e) => {
        clearTimeout(timer);
        resolve(e);
      };
    });
  }
}

/** Resolves with fn's result, or rejects with onTimeout() after ms. */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export class PiRpcSession {
  readonly agentName: string;
  proc: ChildProcessWithoutNullStreams | null = null;

  private readonly opts: PiRpcSessionOptions;
  private nextId = 0;
  private waiters = new Map<string, { resolve: (r: Json) => void; reject: (e: Error) => void }>();
  private events = new EventQueue();
  private stderrTail: string[] = [];
  private lastTextCache: string | null = null;
  private turns = 0;
  private closed = false;
  private ended = false;
  private exited: Promise<void> | null = null;

  constructor(opts: PiRpcSessionOptions) {
    this.opts = opts;
    this.agentName = opts.agentName;
  }

  // -- lifecycle ----------------------------------------------------------

  async start(): Promise<Json> {
    const { model, provider, thinking = "high", loadExtensions = false, mcpConfig = "" } = this.opts;
    const argv = ["--mode", "rpc", "--no-session", "--model", model, "--thinking", thinking];
    if (provider) argv.push("--provider", provider);
    // Recursion guard: assignment agents must never load dispatch_wave
    // (soft rule in prompts, hard guarantee here).
    if (!loadExtensions) argv.push("--no-extensions");
    argv.push(...mcpFlags(mcpConfig));

    const proc = spawn(this.opts.piBin ?? "pi", argv, { cwd: this.opts.cwd, stdio: "pipe" });
    // A stream 'error' with no listener is an uncaught exception, which
    // would take down the host process (pi, when run from the extension).
    // Write failures (EPIPE after pi died) already reach request() through
    // the write callback, and a dead pi surfaces through 'close'.
    for (const emitter of [proc, proc.stdin, proc.stdout, proc.stderr]) emitter.on("error", () => {});
    this.exited = new Promise((resolve) => proc.on("close", () => resolve()));
    this.drainStderr(proc);
    this.readStdout(proc);
    // Spawn failures (e.g. ENOENT) surface as an 'error' event, not a throw.
    await new Promise<void>((resolve, reject) => {
      proc.once("spawn", resolve);
      proc.once("error", (e) => reject(new PiRpcError(`[${this.agentName}] cannot start pi: ${e.message}`)));
    });
    this.proc = proc;
    const state = await this.request({ type: "get_state" }, 30);
    return state.data;
  }

  /** Fail fast when pi did not resolve the requested model (the RPC
   * analogue of delegate-wave's 'check the pane footer' rule). */
  verifyModel(state: Json): void {
    const got = state?.model?.id;
    const want = this.opts.model.split("/").at(-1);
    if (got !== want) {
      throw new PiRpcError(
        `[${this.agentName}] model mismatch: requested '${this.opts.model}' ` +
          `but pi resolved '${got}' - fix the plan's model id ` +
          `(check with: pi --list-models ${want})`,
      );
    }
  }

  async close(): Promise<void> {
    const proc = this.proc;
    if (this.closed || proc === null) return;
    this.closed = true;
    try {
      await withTimeout(this.request({ type: "abort" }, 5), 3_000, () => new Error("abort timeout"));
    } catch {
      // best effort: the process may already be gone
    }
    proc.kill("SIGTERM");
    try {
      await withTimeout(this.exited!, 5_000, () => new Error("exit timeout"));
    } catch {
      proc.kill("SIGKILL");
    }
  }

  // -- requests / events --------------------------------------------------

  async request(cmd: Json, timeoutS = 120): Promise<Json> {
    const proc = this.proc;
    if (proc === null) throw new PiRpcError(`[${this.agentName}] session not started`);
    if (this.ended) throw new PiRpcError(`[${this.agentName}] session ended before response`);
    const rid = `r${++this.nextId}`;
    const resp = new Promise<Json>((resolve, reject) => this.waiters.set(rid, { resolve, reject }));
    // If the write fails we never await resp; its later rejection must not
    // become an unhandled rejection.
    resp.catch(() => {});
    let result: Json;
    try {
      await new Promise<void>((resolve, reject) =>
        proc.stdin.write(JSON.stringify({ ...cmd, id: rid }) + "\n", (e) =>
          e ? reject(new PiRpcError(`[${this.agentName}] cannot send ${cmd.type}: ${e.message}`)) : resolve(),
        ),
      );
      result = await withTimeout(
        resp,
        timeoutS * 1000,
        () => new AgentTimeoutError(`[${this.agentName}] ${cmd.type} got no response within ${timeoutS}s`),
      );
    } finally {
      this.waiters.delete(rid);
    }
    if (result.success === false) {
      throw new PiRpcError(`[${this.agentName}] ${cmd.type} failed: ${result.error}`);
    }
    return result;
  }

  /** Send one prompt, then block until agent_settled (no retry,
   * compaction retry, or queued continuation remains). */
  async promptAndSettle(message: string, timeoutS: number): Promise<void> {
    if (this.proc === null) throw new PiRpcError(`[${this.agentName}] session not started`);
    await this.request({ type: "prompt", message }, 30);
    const deadline = performance.now() + timeoutS * 1000;
    while (true) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        await this.abortAndDrain();
        throw new AgentTimeoutError(
          `[${this.agentName}] prompt did not settle within ${Math.round(timeoutS)}s`,
        );
      }
      // A wait that runs out loops back to the deadline check above, so a
      // stuck agent is aborted before we give up on it.
      const ev = await this.nextEvent(remaining);
      if (ev === null) continue;
      this.absorbEvent(ev);
      if (ev.type === "agent_settled") return;
    }
  }

  async lastText(): Promise<string> {
    if (this.lastTextCache !== null) return this.lastTextCache;
    const resp = await this.request({ type: "get_last_assistant_text" }, 30);
    const text: string = resp.data?.text || "";
    this.lastTextCache = text;
    return text;
  }

  async stats(): Promise<Json> {
    try {
      const resp = await this.request({ type: "get_session_stats" }, 30);
      return resp.data;
    } catch {
      return {};
    }
  }

  // -- internals ------------------------------------------------------------

  private absorbEvent(ev: Json): void {
    if (ev.type === "message_end") {
      const msg = ev.message ?? {};
      if (msg.role === "assistant") {
        this.lastTextCache = (msg.content ?? [])
          .filter((c: Json) => c.type === "text")
          .map((c: Json) => c.text ?? "")
          .join("");
      }
    } else if (ev.type === "turn_end") {
      this.turns += 1;
      this.opts.onEvent?.(this.agentName, { type: "progress", turn: this.turns });
    }
  }

  private async abortAndDrain(): Promise<void> {
    try {
      await this.request({ type: "abort" }, 5);
      const deadline = performance.now() + 15_000;
      while (performance.now() < deadline) {
        const ev = await this.nextEvent(deadline - performance.now());
        if (ev === null || ev.type === "agent_settled") return;
      }
    } catch {
      // best effort: the caller raises the timeout either way
    }
  }

  /** The next event, or null when none arrives within timeoutMs. */
  private async nextEvent(timeoutMs: number): Promise<Json | null> {
    const ev = await this.events.get(timeoutMs);
    if (ev === null) return null;
    if (ev.type === PROCESS_EXIT) {
      // Keep the sentinel visible to any later wait on this dead session.
      this.events.put(ev);
      throw new PiRpcError(
        `[${this.agentName}] pi process exited unexpectedly; ` +
          `stderr tail: ${this.stderrTail.join("").slice(-800)}`,
      );
    }
    return ev;
  }

  private readStdout(proc: ChildProcessWithoutNullStreams): void {
    proc.stdout.setEncoding("utf8");
    let buf = "";
    proc.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        this.handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    proc.on("close", () => {
      this.ended = true;
      if (buf) this.handleLine(buf);
      for (const w of this.waiters.values()) {
        w.reject(new PiRpcError(`[${this.agentName}] session ended before response`));
      }
      this.waiters.clear();
      this.events.put({ type: PROCESS_EXIT });
    });
  }

  private handleLine(line: string): void {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!text.trim()) return;
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return;
    const rec = obj as Json;
    if (rec.type === "response" && "id" in rec) {
      const w = this.waiters.get(String(rec.id));
      this.waiters.delete(String(rec.id));
      w?.resolve(rec);
    } else {
      this.events.put(rec);
    }
  }

  private drainStderr(proc: ChildProcessWithoutNullStreams): void {
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 200) this.stderrTail.shift();
    });
  }
}
