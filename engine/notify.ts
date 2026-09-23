// Progress sinks: a live dashboard file plus macOS notifications.
//
// Engine events already reach the caller (JSONL from the CLI, tool updates
// in the extension); this module adds two human-facing side channels fed
// from the same events:
//
// - a run directory ~/.pi-wave/progress/<plan>-<timestamp>/ with
//   dashboard.md (compact, always-current per-role overview, rewritten
//   atomically on every event - built for pull-reading, e.g. by a desktop
//   bot) and events.jsonl (every raw event, including full agent texts)
// - macOS notifications on agent_done / review_failed / wave_done / summary
//
// Both sinks are best-effort: any failure prints to stderr and never stops
// the run. Env knobs: PI_WAVE_PROGRESS=off disables the files,
// PI_WAVE_PROGRESS_DIR moves them (default ~/.pi-wave/progress),
// PI_WAVE_NOTIFY=off disables notifications (default on under darwin).
//
// An optional third sink (opt-in, PI_WAVE_CHAT_PUSH=on) pushes one-line
// digests into a chat app such as Cursor's Bot by activating it and pasting
// via the clipboard - the only external input channel those apps expose.
// Per-role digests (a role finishing, a failed review) can land in one chat
// per role: set PI_WAVE_CHAT_ROLE_URL to the app's per-chat URL scheme with a
// {role} placeholder (e.g. grok://chat/{role}) and each push opens that URL to
// focus the role's chat before pasting. When it is unset, per-role digests
// fall back to a bot named after the role (PI_WAVE_CHAT_ROLE_APP, default the
// bare role name). Run-level digests go to PI_WAVE_CHAT_APP.

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Assignment, Plan } from "./plan.ts";

type Json = Record<string, any>;

export const EMOJI: Record<string, string> = {
  working: "🔄",
  pass: "✅",
  fail: "❌",
  timeout: "⏱",
  blocked: "🚫",
  error: "💥",
};
const DETAIL_CHARS = 200;
const LOG_LINES = 60;
const SUMMARY_CHARS = 280;
const DEFAULT_PROGRESS_DIR = "~/.pi-wave/progress";
export const DEFAULT_CHAT_EVENTS = ["plan_start", "review_failed", "agent_done", "wave_done", "summary"];

const OFF = ["off", "0", "no", "false"];
const ON = ["on", "1", "yes", "true"];

const expandUser = (p: string) =>
  p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hms = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const stampOf = (d: Date) => `${ymd(d).replaceAll("-", "")}-${hms(d).replaceAll(":", "")}`;

class RoleRow {
  wave: number | string;
  model: string;
  status = "working"; // working | pass | fail | timeout | blocked | error
  rounds = 0;
  turn = 0;
  files: string[];
  doneWhen: string;
  detail: string[] = [];
  tokens: Json = {};
  cost: unknown = 0;

  constructor(wave: number | string, model: string, files: string[] = [], doneWhen = "") {
    this.wave = wave;
    this.model = model;
    this.files = files;
    this.doneWhen = doneWhen;
  }

  statusCell(): string {
    if (this.status === "working") return `${EMOJI.working} working${this.turn ? ` · turn ${this.turn}` : ""}`;
    return `${EMOJI[this.status] ?? "❔"} ${this.status}`;
  }
}

/** Runs async jobs one at a time in the background; a failing job never
 * stops the ones after it (the asyncio-free stand-in for a worker thread). */
class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  push(job: () => Promise<void>): void {
    this.tail = this.tail.then(job).catch(() => {});
  }

  /** Wait for queued jobs, but never longer than timeoutS. */
  async drain(timeoutS: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.tail, new Promise<void>((r) => (timer = setTimeout(r, timeoutS * 1000)))]);
    clearTimeout(timer);
  }
}

function osascript(script: string, timeoutS: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("osascript", ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutS * 1000);
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stderr: e.message });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

export function applescript(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export interface MacSink {
  notify(title: string, subtitle: string, body: string, sound?: boolean): void;
  close(): Promise<void>;
}

/** osascript `display notification`, queued in the background - emit()
 * never waits on it. Failures (no permission, non-macOS) vanish. */
export class MacNotifier implements MacSink {
  private q = new SerialQueue();

  notify(title: string, subtitle: string, body: string, sound = false): void {
    const script = [
      `display notification "${applescript(body.slice(0, 250))}"`,
      `with title "${applescript(title)}"`,
      ...(subtitle ? [`subtitle "${applescript(subtitle)}"`] : []),
      ...(sound ? ['sound name "Glass"'] : []),
    ].join(" ");
    this.q.push(async () => void (await osascript(script, 10)));
  }

  close(timeoutS = 5): Promise<void> {
    return this.q.drain(timeoutS);
  }
}

export interface ChatSink {
  push(text: string, target?: { app?: string; url?: string }): void;
  close(): Promise<void>;
}

/** Pushes short status lines into a chat app (e.g. Cursor's Bot) by
 * activating it and pasting via the clipboard - such apps expose no API,
 * deep link, or CLI, so UI automation is the only external input channel.
 * `push(text, {app})` targets a specific app so per-role digests can go to
 * a bot named after the role; run-level digests use the default app.
 * `push(text, {url})` instead opens a per-chat URL (via `open`) to focus
 * one chat per role before pasting - one role, one chat.
 *
 * Trade-offs (why this is opt-in): every push steals focus while the
 * script activates the app, briefly replaces the clipboard (restored
 * afterwards; a non-text clipboard cannot be restored), and each landed
 * message is one LLM turn for the bot. Pushes are therefore one-liners
 * filtered by event type.
 *
 * Requires Accessibility permission for whatever process runs pi-wave
 * (System Events keystroke); without it, osascript fails and we print a
 * hint on stderr - the run itself is unaffected. */
export class ChatPusher implements ChatSink {
  readonly app: string;
  private readonly sendKey: string;
  private readonly delay: number;
  private q = new SerialQueue();
  private failed = 0;

  private readonly warn: (msg: string) => void;

  constructor(app = "Grok Bot", sendKey = "return", delay = 0.8, warn: (msg: string) => void = stderrWarn) {
    this.app = app;
    this.sendKey = sendKey;
    this.delay = delay;
    this.warn = warn;
  }

  push(text: string, { app, url }: { app?: string; url?: string } = {}): void {
    const script = this.script(text, { app, url });
    this.q.push(async () => {
      const r = await osascript(script, 30);
      if (r.code !== 0 && this.failed < 3) {
        this.failed += 1;
        this.warn(
          `chat push failed: ${r.stderr.trim()}\n` +
            "  hint: grant Accessibility to the app running pi-wave (System Settings > " +
            "Privacy & Security > Accessibility), or set PI_WAVE_CHAT_PUSH=off",
        );
      }
    });
  }

  script(text: string, { app, url }: { app?: string; url?: string } = {}): string {
    // AppleScript string literals cannot hold raw newlines - join parts
    const literal = text
      .split("\n")
      .map((part) => `"${applescript(part)}"`)
      .join(" & return & ");
    const send = this.sendKey === "cmd+return" ? "keystroke return with command down" : "keystroke return";
    // a per-chat URL focuses one chat (open picks the scheme's handler
    // app); otherwise activate the app by name. `quoted form of` shell-
    // quotes the URL so the role name cannot break out of the command.
    const focus = url
      ? `    do shell script "open " & quoted form of "${applescript(url)}"\n`
      : `    tell application "${applescript(app || this.app)}" to activate\n`;
    return (
      "on run\n" +
      "    set saved to missing value\n" +
      "    try\n" +
      "        set saved to the clipboard\n" +
      "    end try\n" +
      `    set the clipboard to ${literal}\n` +
      focus +
      `    delay ${this.delay}\n` +
      '    tell application "System Events"\n' +
      '        keystroke "v" using command down\n' +
      "        delay 0.25\n" +
      `        ${send}\n` +
      "    end tell\n" +
      "    delay 0.2\n" +
      "    if saved is not missing value then set the clipboard to saved\n" +
      "end run"
    );
  }

  close(timeoutS = 10): Promise<void> {
    return this.q.drain(timeoutS);
  }
}

const mdCell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");

/** The agent is prompted to end its final message with a concise summary
 * of what it did, so the work digest is the LAST non-empty line, capped. */
export function tailSummary(text: string): string {
  for (const raw of text.split(/\r?\n/).reverse()) {
    const line = raw.trim().replace(/^[#\->*• ]+/, "").trim();
    if (line) return line.slice(0, SUMMARY_CHARS);
  }
  return "";
}

/** Where sink failures are reported by default (the CLI). A host that
 * owns the terminal, like pi's TUI, passes its own `warn` instead. */
const stderrWarn = (msg: string) => void process.stderr.write(msg + "\n");

export interface NotifierOptions {
  warn?: (msg: string) => void;
  mac?: MacSink | null;
  chat?: ChatSink | null;
  chatEvents?: string[];
  roleAppTmpl?: string;
  roleUrlTmpl?: string;
}

/** Observes engine events and maintains the side channels. */
export class Notifier {
  readonly dashboardPath: string;
  readonly chat: ChatSink | null;
  readonly roleAppTmpl: string;
  readonly roleUrlTmpl: string;
  private readonly plan: Plan;
  private readonly runDir: string;
  private readonly eventsPath: string;
  private readonly mac: MacSink | null;
  private readonly chatEvents: Set<string>;
  private readonly warn: (msg: string) => void;
  private readonly roles = new Map<string, RoleRow>();
  private orch: RoleRow | null = null;
  private readonly log: string[] = [];
  private readonly started = new Date();
  private status = "running";
  private wave = 0;
  private synthesis = "";
  private readonly assign: Map<string, Assignment>;
  private totals: [number, number] = [0, 0]; // (passed, total) once a summary arrived

  constructor(plan: Plan, runDir: string, opts: NotifierOptions = {}) {
    this.plan = plan;
    this.runDir = runDir;
    this.dashboardPath = path.join(runDir, "dashboard.md");
    this.eventsPath = path.join(runDir, "events.jsonl");
    this.mac = opts.mac ?? null;
    this.chat = opts.chat ?? null;
    this.chatEvents = new Set(opts.chatEvents ?? DEFAULT_CHAT_EVENTS);
    this.warn = opts.warn ?? stderrWarn;
    this.roleAppTmpl = opts.roleAppTmpl ?? "{role}";
    this.roleUrlTmpl = opts.roleUrlTmpl ?? "";
    this.assign = new Map(plan.waves.flat().map((a) => [a.name, a]));
    mkdirSync(runDir, { recursive: true });
    this.pointLatest();
  }

  // -- construction ---------------------------------------------------

  static create(plan: Plan, warn: (msg: string) => void = stderrWarn): Notifier | null {
    const env = process.env;
    if (OFF.includes((env.PI_WAVE_PROGRESS ?? "").toLowerCase())) return null;
    const base = expandUser(env.PI_WAVE_PROGRESS_DIR ?? DEFAULT_PROGRESS_DIR);
    const stamp = stampOf(new Date());
    let runDir = path.join(base, `${plan.name}-${stamp}`);
    for (let n = 2; existsSync(runDir); n++) runDir = path.join(base, `${plan.name}-${stamp}-${n}`);
    const setting = (env.PI_WAVE_NOTIFY ?? "auto").toLowerCase();
    const useMac = setting === "auto" ? process.platform === "darwin" : !OFF.includes(setting);
    let chat: ChatPusher | null = null;
    let chatEvents: string[] | undefined;
    if (ON.includes((env.PI_WAVE_CHAT_PUSH ?? "off").toLowerCase())) {
      chat = new ChatPusher(
        env.PI_WAVE_CHAT_APP ?? "Grok Bot",
        env.PI_WAVE_CHAT_SEND_KEY ?? "return",
        Number(env.PI_WAVE_CHAT_DELAY ?? "0.8"),
        warn,
      );
      const raw = env.PI_WAVE_CHAT_EVENTS ?? "";
      if (raw) chatEvents = raw.split(",").map((e) => e.trim()).filter(Boolean);
    }
    return new Notifier(plan, runDir, {
      mac: useMac ? new MacNotifier() : null,
      chat,
      chatEvents,
      roleAppTmpl: env.PI_WAVE_CHAT_ROLE_APP ?? "{role}",
      roleUrlTmpl: env.PI_WAVE_CHAT_ROLE_URL ?? "",
      warn,
    });
  }

  // -- event intake ---------------------------------------------------

  /** Row lookup that self-heals: some engine paths (e.g. a kind=omp
   * assignment failing validation) emit agent_done without a prior
   * agent_start, so rows are created on demand from plan metadata. */
  private rowFor(name: string, wave: number | null = null, model = ""): RoleRow {
    let row = this.roles.get(name);
    if (!row) {
      const a = this.assign.get(name);
      const w = wave ?? this.plan.waves.findIndex((ws) => ws.some((x) => x.name === name)) + 1;
      row = new RoleRow(w, model || a?.model || "", [...(a?.files ?? [])], a?.done_when ?? "");
      this.roles.set(name, row);
    }
    return row;
  }

  /** Record one engine event. Never throws: a broken sink must not take
   * the run down with it. */
  handle(event: Json): void {
    try {
      this.record(event);
    } catch (e) {
      this.warn(`progress notifier: dropped event ${event.type}: ${(e as Error).message}`);
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.mac?.close(), this.chat?.close()]);
  }

  private push(etype: string, text: string): void {
    if (this.chat && this.chatEvents.has(etype)) this.chat.push(text);
  }

  /** Push a per-role digest to the role's own chat: open its per-chat URL
   * when PI_WAVE_CHAT_ROLE_URL is set, else the bot named per role. */
  private pushRole(etype: string, role: string, text: string): void {
    if (!this.chat || !this.chatEvents.has(etype)) return;
    if (this.roleUrlTmpl) this.chat.push(text, { url: this.roleUrlTmpl.replaceAll("{role}", role) });
    else this.chat.push(text, { app: this.roleAppTmpl.replaceAll("{role}", role) });
  }

  private record(event: Json): void {
    appendFileSync(this.eventsPath, JSON.stringify(event) + "\n");
    const etype = event.type;
    if (etype === "plan_start") {
      this.log.push(`plan start · ${event.waves} waves · ${event.agents} agents`);
      this.push("plan_start", `🚀 pi-wave ${event.plan} started - ${event.waves} waves · ${event.agents} roles`);
    } else if (etype === "wave_start") {
      this.wave = Number(event.wave ?? this.wave);
      this.log.push(`wave ${this.wave} start · ${(event.agents ?? []).join(", ")}`);
    } else if (etype === "agent_start") {
      const name = String(event.agent ?? "");
      const a = this.assign.get(name);
      this.roles.set(name, new RoleRow(Number(event.wave ?? 0), String(event.model ?? ""), [...(a?.files ?? [])], a?.done_when ?? ""));
      this.log.push(`${name} start (${event.model})`);
    } else if (etype === "progress" || etype === "agent_progress") {
      // "progress" accepted for engines predating the agent_progress fix
      const row = this.roles.get(String(event.agent ?? ""));
      if (row) row.turn = Number(event.turn ?? row.turn);
      this.log.push(`${event.agent} turn ${event.turn}`);
    } else if (etype === "prompt_stall_recovery") {
      this.log.push(`${event.agent} prompt stalled - recovering`);
    } else if (etype === "prompt_submit_enter") {
      this.log.push(`${event.agent} prompt left unsent - pressed Enter`);
    } else if (etype === "review_failed") {
      const name = String(event.agent ?? "");
      const row = this.roles.get(name);
      if (row) {
        row.rounds = Number(event.round ?? row.rounds);
        const tail = String(event.review_output_tail ?? "").trim();
        if (tail) row.detail.push(`review r${row.rounds}: ` + mdCell(tail.slice(-DETAIL_CHARS)));
      }
      this.log.push(`${name} review failed (round ${event.round})`);
      this.notify(name, `🔁 failed review · round ${event.round}`);
      this.pushRole("review_failed", name, `🔁 ${name} failed review - fix round ${event.round}`);
    } else if (etype === "agent_done") {
      const name = String(event.agent ?? "");
      const row = this.rowFor(name);
      row.status = String(event.status ?? row.status);
      row.rounds = Number(event.rounds ?? row.rounds);
      this.log.push(`${name} ${event.status} · ${event.rounds} round(s)`);
      const status = String(event.status ?? "");
      this.notify(name, statusPhrase(status, event.rounds ?? "?"), ["fail", "timeout", "blocked", "error"].includes(status));
      const head = `${name} - ${statusPhrase(status, event.rounds ?? "?")} · wave ${row.wave}`;
      const work = tailSummary(String(event.text ?? ""));
      this.pushRole("agent_done", name, head + (work ? `\n${work}` : ""));
    } else if (etype === "wave_done") {
      const ok = Boolean(event.passed);
      this.log.push(`wave ${event.wave} ` + (ok ? "passed" : "FAILED"));
      this.notify(`wave ${event.wave}`, ok ? "✅ all agents passed" : "❌ wave failed - see dashboard", !ok);
      this.push("wave_done", `🏁 wave ${event.wave}/${this.plan.waves.length} - ` + (ok ? "all passed" : "FAILED"));
    } else if (etype === "sync_start") {
      this.log.push(`wave ${event.wave} sync check ${event.round}`);
    } else if (etype === "sync_fix") {
      this.log.push(`wave ${event.wave} sync: fix sent to ${event.agent}`);
    } else if (etype === "sync_done") {
      this.log.push(`wave ${event.wave} sync ${event.status === "pass" ? "passed" : "FAILED"} after ${event.rounds} fix round(s)`);
    } else if (etype === "stopped") {
      this.log.push(`stopped: ${event.reason}`);
    } else if (etype === "orchestrator_start") {
      this.orch = new RoleRow("-", String(event.model ?? ""));
      this.orch.detail.push(`thinking: ${event.thinking}`);
      this.log.push(`orchestrator start (${event.model})`);
    } else if (etype === "orchestrator_done") {
      if (this.orch) this.orch.status = "pass";
      this.log.push("orchestrator done");
    } else if (etype === "orchestrator_error") {
      this.orch ??= new RoleRow("-", "");
      this.orch.status = "error";
      this.orch.detail.push(mdCell(String(event.error ?? "").slice(0, DETAIL_CHARS)));
      this.log.push(`orchestrator error: ${String(event.error).slice(0, 80)}`);
    } else if (etype === "summary") {
      this.absorbSummary(event);
    }
    this.rewriteDashboard();
  }

  private absorbSummary(event: Json): void {
    this.status = String(event.status ?? this.status);
    let passed = 0;
    let total = 0;
    for (const w of event.waves ?? []) {
      for (const ag of w.agents ?? []) {
        total += 1;
        const row = this.rowFor(String(ag.name ?? ""), Number(ag.wave ?? 0) || null, String(ag.model ?? ""));
        row.status = String(ag.status ?? row.status);
        row.rounds = Number(ag.rounds ?? row.rounds);
        row.tokens = ag.tokens ?? {};
        row.cost = ag.cost ?? 0;
        if (ag.error) row.detail.push("error: " + mdCell(String(ag.error).slice(0, DETAIL_CHARS)));
        if (ag.feedback) row.detail.push("feedback: " + mdCell(String(ag.feedback).slice(-DETAIL_CHARS)));
        if (row.status === "pass") passed += 1;
      }
    }
    this.totals = [passed, total];
    this.synthesis = String(event.synthesis ?? "");
    this.log.push(`summary · ${this.status} · ${passed}/${total} passed`);
    this.notify("run finished", `${this.status} · ${passed}/${total} agents passed`, true);
    const lines = [`📋 pi-wave ${this.plan.name} ${this.status} - ${passed}/${total} roles passed`];
    for (const [name, row] of this.roles) lines.push(`${EMOJI[row.status] ?? "❔"} ${name} · ${row.rounds} round(s)`);
    if (this.synthesis.trim()) lines.push("synthesis: " + this.synthesis.trim().slice(0, 240));
    this.push("summary", lines.join("\n"));
  }

  // -- notifications --------------------------------------------------

  private notify(subtitle: string, body: string, sound = false): void {
    this.mac?.notify(`pi-wave · ${this.plan.name}`, subtitle, body, sound);
  }

  // -- dashboard ------------------------------------------------------

  private rewriteDashboard(): void {
    const tmp = this.dashboardPath + ".tmp";
    writeFileSync(tmp, this.render());
    renameSync(tmp, this.dashboardPath);
  }

  private pointLatest(): void {
    const base = path.dirname(this.runDir);
    const latest = path.join(base, "latest");
    const tmp = path.join(base, `.latest-${process.pid}`);
    try {
      symlinkSync(path.basename(this.runDir), tmp);
      renameSync(tmp, latest);
    } catch {
      try {
        rmSync(tmp, { force: true });
        writeFileSync(latest, this.runDir + "\n");
      } catch {
        // best-effort pointer only
      }
    }
  }

  private render(): string {
    const now = hms(new Date());
    const [passed, total] = this.totals;
    const head = [
      `# pi-wave · ${this.plan.name}`,
      "",
      `**${this.status}**` +
        (this.status === "running" && this.wave ? ` · wave ${this.wave}/${this.plan.waves.length}` : "") +
        (total ? ` · ${passed}/${total} passed` : "") +
        ` · started ${ymd(this.started)} ${hms(this.started)}` +
        ` · updated ${now}`,
      `cwd: \`${this.plan.cwd}\``,
      "",
      "| Wave | Role | Model | Status | Rounds |",
      "| --- | --- | --- | --- | --- |",
    ];
    for (const [name, row] of this.roles) {
      const rounds = row.status !== "working" ? String(row.rounds) : "-";
      head.push(`| ${row.wave} | ${name} | ${mdCell(row.model)} | ${row.statusCell()} | ${rounds} |`);
    }
    if (this.orch) head.push(`| - | orchestrator | ${mdCell(this.orch.model)} | ${this.orch.statusCell()} | - |`);

    const synthesis = this.synthesis.trim() ? ["", "## Synthesis", "", this.synthesis.trim()] : [];
    const log = ["", "## Recent events", "", ...this.log.slice(-LOG_LINES).reverse().map((l) => `- ${l}`)];
    return [...head, ...this.renderNotes(), ...synthesis, ...log].join("\n") + "\n";
  }

  private renderNotes(): string[] {
    const notes: string[] = [];
    for (const [name, row] of this.roles) {
      const bits: string[] = [];
      if (row.files.length) bits.push("files: " + row.files.map((f) => `\`${f}\``).join(", "));
      if (row.doneWhen) bits.push("done: " + mdCell(row.doneWhen.slice(0, 160)));
      if (row.status !== "working" && (Object.keys(row.tokens).length || row.cost)) {
        if (row.tokens.total) bits.push(`${row.tokens.total} tokens`);
        if (row.cost) bits.push(`$${row.cost}`);
      }
      bits.push(...row.detail);
      if (bits.length) notes.push(`- **${name}** - ` + bits.join(" · "));
    }
    if (this.orch?.detail.length) notes.push("- **orchestrator** - " + this.orch.detail.join(" · "));
    return notes.length ? ["", "## Role notes", "", ...notes] : [];
  }
}

function statusPhrase(status: string, rounds: unknown): string {
  const phrases: Record<string, string> = {
    pass: `✅ passed · ${rounds} round(s)`,
    fail: `❌ failed after ${rounds} rounds`,
    timeout: "⏱ timed out",
    blocked: "🚫 blocked on an approval dialog",
    error: "💥 error",
  };
  return phrases[status] ?? status;
}
