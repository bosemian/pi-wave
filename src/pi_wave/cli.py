"""CLI entry: python3 run.py <plan.json> [--dry-run]
                            [--model M] [--provider P] [--thinking T]

stdout is pure JSONL (machine-readable — the dispatch_wave extension forwards
it); human diagnostics go to stderr. Exit codes: 0 all pass, 1 failure/stop,
2 plan error, 130 interrupted.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import signal
import sys

from .notify import Notifier
from .plan import PlanError, apply_overrides, load_plan
from .rpc import PiRpcError


def _emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def _dry_run(plan) -> int:
    orch_json = {}
    if plan.orchestrator:
        orch_json = {
            "model": plan.orchestrator.model,
            "thinking": plan.orchestrator.thinking,
        }
        if plan.orchestrator.synthesis_model:
            orch_json["synthesis_model"] = plan.orchestrator.synthesis_model
            orch_json["synthesis_thinking"] = plan.orchestrator.synthesis_thinking
    _emit({
        "type": "plan",
        "plan": plan.name,
        "cwd": plan.cwd,
        "on_failure": plan.on_failure,
        "source": plan.source,
        **({"orchestrator": orch_json} if orch_json else {}),
    })
    for i, wave in enumerate(plan.waves):
        for a in wave:
            _emit({
                "type": "assignment",
                "wave": i + 1,
                "name": a.name,
                "model": a.model,
                "provider": a.provider,
                "kind": a.kind,
                "thinking": a.thinking,
                "files": a.files,
                "review_cmd": a.review_cmd,
                "needs_results": a.needs_results,
                "timeout": a.timeout,
                "max_fix_rounds": a.max_fix_rounds,
                "load_extensions": a.load_extensions,
                "display": a.display,
                "mcp_config": a.mcp_config,
            })
    print("dry-run OK — no agents were started", file=sys.stderr)
    return 0


async def run_orchestrate(plan, emit) -> dict:
    from .orchestrator import orchestrate

    loop = asyncio.get_running_loop()
    main_task = asyncio.current_task()
    try:
        loop.add_signal_handler(signal.SIGTERM, main_task.cancel)
    except NotImplementedError:
        pass
    return await orchestrate(plan, emit)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pi-wave", description="Wave orchestrator for pi agents")
    ap.add_argument("plan", help="path to wave plan JSON")
    ap.add_argument("--dry-run", action="store_true", help="validate and print the plan without running agents")
    ap.add_argument("--model", help="override every assignment's model (provider-qualified, or pair with --provider)")
    ap.add_argument("--provider", help="override every assignment's provider")
    ap.add_argument("--thinking", help="override every assignment's thinking level (off|minimal|low|medium|high|xhigh|max)")
    args = ap.parse_args(argv)

    try:
        plan = load_plan(args.plan)
        plan = apply_overrides(plan, args.model, args.provider, args.thinking)
    except PlanError as e:
        print(f"plan error: {e}", file=sys.stderr)
        return 2

    applied = [f"{k}={v}" for k, v in
               (("model", args.model), ("provider", args.provider),
                ("thinking", args.thinking)) if v]
    if applied:
        print(f"overrides applied to every assignment: " + ", ".join(applied), file=sys.stderr)

    if args.dry_run:
        return _dry_run(plan)

    notifier = Notifier.create(plan)
    if notifier is not None:
        print(f"progress dashboard: {notifier.dashboard_path}", file=sys.stderr)

    def emit(obj: dict) -> None:
        _emit(obj)
        if notifier is not None:
            notifier.handle(obj)

    try:
        summary = asyncio.run(run_orchestrate(plan, emit))
    except (KeyboardInterrupt, asyncio.CancelledError):
        print("interrupted — child agents were terminated", file=sys.stderr)
        return 130
    except PiRpcError as e:
        print(f"rpc error: {e}", file=sys.stderr)
        return 1
    finally:
        if notifier is not None:
            notifier.close()

    all_pass = all(
        ag["status"] == "pass" for w in summary["waves"] for ag in w["agents"]
    ) and bool(summary["waves"])
    return 0 if all_pass and summary["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
