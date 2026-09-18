// dispatch-wave: pi extension that bridges the pi-wave orchestrator.
//
// Registers a `dispatch_wave` tool: when the agent decides to fan out work,
// it calls this tool with a wave plan path; the extension spawns the Python
// engine (src runs waves of `pi --mode rpc` subagents), streams JSONL
// progress back as tool updates, and returns the final summary as the tool
// result.
//
// Install (pick one):
//   pi -e ~/labs/pi-wave/extension/dispatch-wave.ts      # test run
//   mkdir -p ~/.pi/agent/extensions && cp dispatch-wave.ts ~/.pi/agent/extensions/
//   // or settings.json: { "extensions": ["~/labs/pi-wave/extension"] }
//
// Env overrides: PI_WAVE_HOME (default ~/labs/pi-wave), PI_WAVE_PYTHON (default python3)

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const HOME = process.env.PI_WAVE_HOME ?? path.join(os.homedir(), "labs", "pi-wave");
const PYTHON = process.env.PI_WAVE_PYTHON ?? "python3";
const RUNNER = path.join(HOME, "run.py");

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "dispatch_wave",
    label: "Dispatch Wave",
    description:
      "Execute a wave plan: run waves of parallel coding subagents (visible Herdr panes " +
      "when inside Herdr, headless pi agents otherwise), review each result, run " +
      "consolidated fix rounds (max 2 per agent), and return a JSON summary with " +
      "per-agent status/rounds/tokens and an optional orchestrator synthesis. " +
      "Self-contained — no skill needed. Use it when a task decomposes into " +
      "independent chunks that can run in parallel; prefer it over doing the work " +
      "yourself or typing herdr commands. " +
      "YOU build the plan (inline object or a JSON file path). Schema: " +
      '{ name, cwd: "/abs/project/dir" (omitted or "." = the directory this session runs in — agents work there), on_failure: "stop"|"continue", display: "auto"(herdr panes inside Herdr, headless otherwise)|"herdr"|"headless", orchestrator: true|{model,thinking,synthesis_model,synthesis_thinking} (spawns a wider orchestrator pane, default openai-codex/gpt-5.5 at high, which reviews agents that have no review_cmd against their done_when and writes the final synthesis; set synthesis_model/synthesis_thinking to hand ONLY the synthesis to a dedicated synthesizer pane), waves: [[assignment, ...], ...] }. ' +
      "Each wave runs its assignments in parallel; later waves only start after the " +
      "previous one passes. Assignment fields: name (unique plan-wide, ^[a-z][a-z0-9_-]{0,31}$, " +
      "never \"orchestrator\"), prompt (SELF-CONTAINED — the subagent cannot ask questions; " +
      "include every path and instruction), model (provider-qualified like kimi-coding/k3; " +
      "bare id only when kind is omp), kind (\"pi\" default | \"omp\" — omp ONLY for " +
      "claude-sonnet-5 and requires Herdr), thinking (off|minimal|low|medium|high|xhigh|max), " +
      "files (exact files this agent may touch; [] = read-only), done_when (definition of done), " +
      "review_cmd (optional shell command, exit 0 = pass — takes precedence over the " +
      "orchestrator review), timeout (seconds per prompt round), needs_results (names of " +
      "earlier-wave agents whose final texts are injected into this prompt). " +
      "Model guidance: reasoning/design/plan → openai-codex/gpt-5.5 high; code changes → " +
      "kimi-coding/k3 high ONLY — any assignment that writes or edits files must run k3, " +
      "never a gpt-5 model; quality/review/test → claude-sonnet-5 high via kind omp; cheap " +
      "read-only breadth (discovery, grepping, summarising) → openai-codex/gpt-5.6-luna off. " +
      "Rules the engine enforces: two assignments in the same wave never touch the same " +
      "file; model/effort are verified at spawn (mismatch fails fast); a blocked agent is " +
      "surfaced, never auto-answered; panes stay open for the user. " +
      "After the call, relay the summary honestly — never redo a failed assignment " +
      "yourself. Never call this tool from inside a wave assignment.",
    parameters: Type.Object({
      plan: Type.Union([
        Type.String({ description: "Path to a wave plan JSON file (relative paths resolve against the current working directory)" }),
        Type.Record(Type.String(), Type.Unknown(), {
          description: "The wave plan object inline (written to a temp file)",
        }),
      ], { description: "Wave plan: the plan object inline (preferred) or a path to the JSON file" }),
      model: Type.Optional(Type.String({
        description:
          "Override every assignment's model without editing the plan " +
          "(provider-qualified like 'anthropic/claude-x', or pair with provider)",
      })),
      provider: Type.Optional(Type.String({
        description: "Override every assignment's provider (needed when model is unqualified)",
      })),
      thinking: Type.Optional(Type.String({
        description:
          "Override every assignment's thinking level (off|minimal|low|medium|high|xhigh|max)",
      })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const callerCwd = process.cwd();
      let planPath = params.plan;
      if (typeof planPath !== "string") {
        planPath = path.join(os.tmpdir(), `pi-wave-plan-${Date.now()}.json`);
        writeFileSync(planPath, JSON.stringify(params.plan, null, 2));
      } else if (!path.isAbsolute(planPath)) {
        planPath = path.join(callerCwd, planPath);
      }
      const runnerArgs = [RUNNER, planPath];
      if (params.model) runnerArgs.push("--model", params.model);
      if (params.provider) runnerArgs.push("--provider", params.provider);
      if (params.thinking) runnerArgs.push("--thinking", params.thinking);
      const child = spawn(PYTHON, runnerArgs, {
        cwd: callerCwd,
        signal,
        env: process.env,
      });

      let summary: Record<string, unknown> | null = null;
      let stderrTail: string[] = [];
      let stdoutTail: string[] = [];

      child.stdout.setEncoding("utf8");
      let buf = "";
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          stdoutTail.push(line);
          if (stdoutTail.length > 200) stdoutTail.shift();
          try {
            const ev = JSON.parse(line);
            if (ev.type === "summary") summary = ev;
          } catch {
            // not JSON — ignore, engine stdout is JSONL by contract
          }
          try {
            onUpdate?.({ content: [{ type: "text", text: line }], details: {} });
          } catch {
            // host refused the update — keep going, summary still arrives at exit
          }
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrTail.push(chunk);
        if (stderrTail.length > 50) stderrTail.shift();
      });

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => resolve(code));
      });

      if (summary) {
        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
          details: { exitCode, summary },
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `pi-wave exited with code ${exitCode} and produced no summary.\n` +
              `stderr tail:\n${stderrTail.join("") || "(empty)"}\n` +
              `stdout tail:\n${stdoutTail.slice(-10).join("\n") || "(empty)"}`,
          },
        ],
        details: { exitCode },
      };
    },
  });
}
