// dispatch-wave: pi extension that runs the pi-wave orchestrator.
//
// Registers a `dispatch_wave` tool: when the agent decides to fan out work,
// it calls this tool with a wave plan; the engine (../engine) runs in this
// pi process, dispatches waves of `pi --mode rpc` subagents (or Herdr
// panes), streams every engine event back as a tool update, and returns
// the final summary as the tool result.
//
// Install: the extension imports ../engine, so load it from this repo
// rather than copying the file:
//   pi -e ~/labs/pi-wave/extension/dispatch-wave.ts      # test run
//   // or ~/.pi/agent/settings.json: { "extensions": ["~/labs/pi-wave/extension"] }

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Notifier } from "../engine/notify.ts";
import { defaultDeps, orchestrate } from "../engine/orchestrator.ts";
import { type Plan, PlanError, applyOverrides, loadPlan, parsePlan } from "../engine/plan.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "dispatch_wave",
    label: "Dispatch Wave",
    description:
      "Execute a wave plan: run waves of parallel coding subagents (visible Herdr panes " +
      "when inside Herdr, headless pi agents otherwise), review each result, run " +
      "consolidated fix rounds (max 2 per agent), and return a JSON summary with " +
      "per-agent status/rounds/tokens and an optional orchestrator synthesis. " +
      "Self-contained - no skill needed. Use it when a task decomposes into " +
      "independent chunks that can run in parallel; prefer it over doing the work " +
      "yourself or typing herdr commands. " +
      "YOU build the plan (inline object or a JSON file path). Schema: " +
      '{ name, cwd: "/abs/project/dir" (omitted or "." = the directory this session runs in - agents work there), on_failure: "stop"|"continue", display: "auto"(herdr panes inside Herdr, headless otherwise)|"herdr"|"headless", orchestrator: true|{model,thinking,synthesis_model,synthesis_thinking} (spawns a wider orchestrator pane, default openai-codex/gpt-5.5 at high, which reviews agents that have no review_cmd against their done_when and writes the final synthesis; set synthesis_model/synthesis_thinking to hand ONLY the synthesis to a dedicated synthesizer pane), waves: [[assignment, ...], ...] }. ' +
      "Each wave runs its assignments in parallel; later waves only start after the " +
      "previous one passes. Assignment fields: name (unique plan-wide, ^[a-z][a-z0-9_-]{0,31}$, " +
      "never \"orchestrator\"), prompt (SELF-CONTAINED - the subagent cannot ask questions; " +
      "include every path and instruction), model (provider-qualified like kimi-coding/k3; " +
      "bare id only when kind is omp), kind (\"pi\" default | \"omp\" - omp ONLY for " +
      "claude-sonnet-5 and requires Herdr), thinking (off|minimal|low|medium|high|xhigh|max), " +
      "files (exact files this agent may touch; [] = read-only), done_when (definition of done), " +
      "review_cmd (optional shell command, exit 0 = pass - takes precedence over the " +
      "orchestrator review), timeout (seconds per prompt round), needs_results (names of " +
      "earlier-wave agents whose final texts are injected into this prompt). " +
      "Model guidance: reasoning/design/plan → openai-codex/gpt-5.5 high; code changes → " +
      "kimi-coding/k3 high ONLY - any assignment that writes or edits files must run k3, " +
      "never a gpt-5 model; quality/review/test → claude-sonnet-5 high via kind omp; cheap " +
      "read-only breadth (discovery, grepping, summarising) → openai-codex/gpt-5.6-luna off. " +
      "Rules the engine enforces: two assignments in the same wave never touch the same " +
      "file; model/effort are verified at spawn (mismatch fails fast); a blocked agent is " +
      "surfaced, never auto-answered; panes stay open for the user. " +
      "After the call, relay the summary honestly - never redo a failed assignment " +
      "yourself. Never call this tool from inside a wave assignment.",
    parameters: Type.Object({
      plan: Type.Union([
        Type.String({ description: "Path to a wave plan JSON file (relative paths resolve against the current working directory)" }),
        Type.Record(Type.String(), Type.Unknown(), {
          description: "The wave plan object inline",
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
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const update = (text: string) => {
        try {
          onUpdate?.({ content: [{ type: "text", text }], details: {} });
        } catch {
          // host refused the update - keep going, the summary still returns
        }
      };

      let plan: Plan;
      try {
        plan =
          typeof params.plan === "string"
            ? loadPlan(params.plan, ctx.cwd)
            : parsePlan(params.plan, "inline", ctx.cwd);
        applyOverrides(plan, { model: params.model, provider: params.provider, thinking: params.thinking });
      } catch (e) {
        // throwing marks the tool result as failed; the engine refused the plan
        if (e instanceof PlanError) throw new Error(`plan error: ${e.message}`);
        throw e;
      }

      // Sink failures (e.g. a chat push without Accessibility permission)
      // must not write to pi's terminal; they travel as tool updates.
      const warnings: string[] = [];
      const notifier = Notifier.create(plan, (msg) => {
        warnings.push(msg);
        update(`warning: ${msg}`);
      });
      try {
        const summary = await orchestrate(
          plan,
          (ev) => {
            notifier?.handle(ev);
            update(JSON.stringify(ev));
          },
          { ...defaultDeps, signal },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
          details: { summary, dashboard: notifier?.dashboardPath, warnings },
        };
      } finally {
        await notifier?.close();
      }
    },
  });
}
