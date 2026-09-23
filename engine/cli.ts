#!/usr/bin/env node
// CLI entry: node engine/cli.ts <plan.json> [--dry-run]
//                               [--model M] [--provider P] [--thinking T]
//
// stdout is pure JSONL (machine-readable engine events); human diagnostics
// go to stderr. Exit codes: 0 all pass,
// 1 failure/stop, 2 plan error, 130 interrupted.

import { parseArgs } from "node:util";
import { Notifier } from "./notify.ts";
import { defaultDeps, orchestrate } from "./orchestrator.ts";
import { type Plan, PlanError, applyOverrides, loadPlan } from "./plan.ts";
import { PiRpcError } from "./rpc.ts";

type Json = Record<string, any>;

const USAGE =
  "usage: pi-wave <plan.json> [--dry-run] [--model M] [--provider P] [--thinking T]\n\n" +
  "  --dry-run     validate and print the plan without running agents\n" +
  "  --model       override every assignment's model (provider-qualified, or pair with --provider)\n" +
  "  --provider    override every assignment's provider\n" +
  "  --thinking    override every assignment's thinking level (off|minimal|low|medium|high|xhigh|max)\n";

/** After an interrupt, how long to let headless agents shut down before
 * giving up on the run (Herdr prompts cannot be cut short). */
const INTERRUPT_GRACE_S = 10;

const emit = (obj: Json) => void process.stdout.write(JSON.stringify(obj) + "\n");
const say = (line: string) => void process.stderr.write(line + "\n");

function dryRun(plan: Plan): number {
  const o = plan.orchestrator;
  const orchJson = o
    ? {
        model: o.model,
        thinking: o.thinking,
        ...(o.synthesis_model ? { synthesis_model: o.synthesis_model, synthesis_thinking: o.synthesis_thinking } : {}),
      }
    : null;
  emit({
    type: "plan",
    plan: plan.name,
    cwd: plan.cwd,
    on_failure: plan.on_failure,
    source: plan.source,
    ...(orchJson ? { orchestrator: orchJson } : {}),
  });
  for (const [i, wave] of plan.waves.entries()) {
    for (const a of wave) {
      emit({
        type: "assignment",
        wave: i + 1,
        name: a.name,
        model: a.model,
        provider: a.provider,
        kind: a.kind,
        thinking: a.thinking,
        files: a.files,
        review_cmd: a.review_cmd,
        needs_results: a.needs_results,
        timeout: a.timeout,
        max_fix_rounds: a.max_fix_rounds,
        load_extensions: a.load_extensions,
        display: a.display,
        mcp_config: a.mcp_config,
      });
    }
  }
  say("dry-run OK - no agents were started");
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (e) {
    say(`${USAGE}\npi-wave: error: ${(e as Error).message}`);
    return 2;
  }
  if (args.values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [planPath] = args.positionals;
  if (!planPath || args.positionals.length > 1) {
    say(`${USAGE}\npi-wave: error: expected exactly one plan path`);
    return 2;
  }
  const { model, provider, thinking } = args.values;

  let plan: Plan;
  try {
    plan = applyOverrides(loadPlan(planPath), { model, provider, thinking });
  } catch (e) {
    if (!(e instanceof PlanError)) throw e;
    say(`plan error: ${e.message}`);
    return 2;
  }

  const applied = Object.entries({ model, provider, thinking })
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`);
  if (applied.length) say(`overrides applied to every assignment: ${applied.join(", ")}`);

  if (args.values["dry-run"]) return dryRun(plan);

  const notifier = Notifier.create(plan);
  if (notifier) say(`progress dashboard: ${notifier.dashboardPath}`);

  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  const gaveUp = new Promise<"gave-up">((resolve) =>
    controller.signal.addEventListener("abort", () => setTimeout(() => resolve("gave-up"), INTERRUPT_GRACE_S * 1000).unref()),
  );

  try {
    const summary = await Promise.race([
      orchestrate(
        plan,
        (obj) => {
          emit(obj);
          notifier?.handle(obj);
        },
        { ...defaultDeps, signal: controller.signal },
      ),
      gaveUp,
    ]);
    if (summary === "gave-up" || controller.signal.aborted) {
      say("interrupted - child agents were terminated");
      return 130;
    }
    const agents = summary.waves.flatMap((w: Json) => w.agents);
    const allPass = agents.length > 0 && agents.every((ag: Json) => ag.status === "pass");
    return allPass && summary.status === "completed" ? 0 : 1;
  } catch (e) {
    if (controller.signal.aborted) {
      say("interrupted - child agents were terminated");
      return 130;
    }
    say(`${e instanceof PiRpcError ? "rpc" : "engine"} error: ${(e as Error).message}`);
    return 1;
  } finally {
    process.off("SIGTERM", interrupt);
    process.off("SIGINT", interrupt);
    await notifier?.close();
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" },
      model: { type: "string" },
      provider: { type: "string" },
      thinking: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

/** Exit only once stdout/stderr have flushed: pipe writes are async on
 * macOS, and an interrupted run may still hold children that would keep
 * the process alive. */
async function exitWith(code: number): Promise<never> {
  await new Promise<void>((r) => process.stdout.write("", () => r()));
  await new Promise<void>((r) => process.stderr.write("", () => r()));
  process.exit(code);
}

if (import.meta.main) await exitWith(await main());
