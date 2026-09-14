"""Wave plan loading and validation.

A plan is a JSON file:
{
  "name": "my-run",
  "cwd": "/abs/path/to/project",          // optional, default: process cwd
  "on_failure": "stop",                   // "stop" (default) | "continue"
  "waves": [
    [ {assignment}, {assignment} ],       // one wave = parallel batch
    [ {assignment} ]
  ]
}

Assignment:
{
  "name": "wave-1-research",              // unique across the whole plan
  "prompt": "self-contained instructions",
  "model": "openai-codex/gpt-5.6-luna",   // provider-qualified id (pi kind)
                                          // omp kind: bare id, e.g. "claude-sonnet-5"
  "provider": "openai-codex",             // optional (redundant if model is qualified)
  "kind": "pi",                           // "pi" (default) | "omp" (Sonnet via OMP;
                                          // requires display=herdr)
  "thinking": "off|minimal|low|medium|high|xhigh|max",   // default "high"
  "files": ["src/a.py"],                  // exact files this agent may touch ([] = read-only)
  "done_when": "definition of done text", // optional, goes into the prompt
  "review_cmd": "pytest -q",              // optional; exit 0 = pass, else fix round
  "max_fix_rounds": 2,
  "timeout": 600,                         // seconds per prompt round
  "needs_results": ["wave-1-research"],   // inject prior agents' final texts
  "load_extensions": false,               // keep false: blocks nested dispatch_wave
  "display": "auto",                      // "auto" (default) — herdr panes when run
}                                         // inside Herdr, headless otherwise;
                                          // "herdr"/"headless" force one mode
// "mcp_config": "/path/to/mcp.json"     // optional; gives the agent MCP tools
//                                       // (e.g. wigolo research) via pi-mcp-adapter

Plan-level:
{
  "orchestrator": true,   // or {"model": "...", "thinking": "high",
}                         //     "synthesis_model": "...", "synthesis_thinking": "high"}
                          // spawns the delegate-wave orchestrator pane (default
                          // openai-codex/gpt-5.6-sol at high, wider pane). It
                          // reviews results without a review_cmd and writes the
                          // final synthesis. Set synthesis_model/synthesis_thinking
                          // to hand ONLY the synthesis to a dedicated
                          // `synthesizer` pane. Herdr display only.

Enforced delegate-wave rules:
- two assignments in the same wave must not touch the same file;
- names are unique plan-wide.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

THINKING_LEVELS = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}
DISPLAY_MODES = {"auto", "headless", "herdr"}
AGENT_KINDS = {"pi", "omp"}
NAME_PATTERN = r"^[a-z][a-z0-9_-]{0,31}$"
ORCHESTRATOR_NAME = "orchestrator"
SYNTHESIZER_NAME = "synthesizer"


def resolve_display(display: str) -> str:
    """auto → herdr when running inside Herdr, headless otherwise."""
    if display == "auto":
        return "herdr" if os.environ.get("HERDR_ENV") == "1" else "headless"
    return display


class PlanError(ValueError):
    pass


@dataclass
class Assignment:
    name: str
    prompt: str
    model: str
    provider: str | None = None
    kind: str = "pi"
    thinking: str = "high"
    files: list[str] = field(default_factory=list)
    done_when: str = ""
    review_cmd: str = ""
    max_fix_rounds: int = 2
    timeout: float = 600.0
    needs_results: list[str] = field(default_factory=list)
    load_extensions: bool = False
    display: str = "auto"
    mcp_config: str = ""


@dataclass
class OrchestratorSpec:
    """The delegate-wave orchestrator pane: reviews results against done_when
    and writes the final synthesis. Defaults follow the skill (sol @ high).
    synthesis_model/synthesis_thinking, when set, hand ONLY the final
    synthesis to a dedicated one-shot `synthesizer` pane; the orchestrator
    pane keeps doing the reviews."""
    model: str = "openai-codex/gpt-5.6-sol"
    thinking: str = "high"
    synthesis_model: str = ""
    synthesis_thinking: str = ""


@dataclass
class Plan:
    name: str
    cwd: str
    on_failure: str
    waves: list[list[Assignment]]
    source: str = ""
    display: str = "auto"
    orchestrator: OrchestratorSpec | None = None


def _req(d: dict, key: str, ctx: str):
    if key not in d or not str(d[key]).strip():
        raise PlanError(f"{ctx}: missing required field '{key}'")
    return d[key]


def _parse_assignment(d: dict, wave_idx: int, idx: int, default_display: str = "headless") -> Assignment:
    ctx = f"wave {wave_idx + 1}, agent {idx + 1}"
    if not isinstance(d, dict):
        raise PlanError(f"{ctx}: assignment must be an object")
    import re

    name = str(_req(d, "name", ctx))
    if not re.match(NAME_PATTERN, name):
        raise PlanError(f"{ctx}: name '{name}' must match {NAME_PATTERN}")
    prompt = str(_req(d, "prompt", ctx))
    model = str(_req(d, "model", ctx))
    provider = str(d["provider"]).strip() if d.get("provider") else None
    kind = str(d.get("kind", "pi"))
    if kind not in AGENT_KINDS:
        raise PlanError(f"{ctx}: kind '{kind}' not in {sorted(AGENT_KINDS)}")
    if kind == "pi" and "/" not in model and not provider:
        raise PlanError(
            f"{ctx}: model '{model}' is not provider-qualified and no 'provider' "
            f"field given (pi requires 'provider/model', its default provider is google)"
        )
    thinking = str(d.get("thinking", "high"))
    if thinking not in THINKING_LEVELS:
        raise PlanError(f"{ctx}: thinking '{thinking}' not in {sorted(THINKING_LEVELS)}")
    files = d.get("files", [])
    if not isinstance(files, list) or not all(isinstance(f, str) for f in files):
        raise PlanError(f"{ctx}: 'files' must be a list of strings")
    timeout = float(d.get("timeout", 600))
    if timeout <= 0:
        raise PlanError(f"{ctx}: timeout must be > 0")
    max_fix = int(d.get("max_fix_rounds", 2))
    if max_fix < 0 or max_fix > 5:
        raise PlanError(f"{ctx}: max_fix_rounds must be 0..5")
    display = str(d.get("display", default_display))
    if display not in DISPLAY_MODES:
        raise PlanError(f"{ctx}: display '{display}' not in {sorted(DISPLAY_MODES)}")
    mcp_config = str(d.get("mcp_config", "")).strip()
    if mcp_config and not Path(mcp_config).expanduser().is_file():
        raise PlanError(f"{ctx}: mcp_config file not found: {mcp_config}")
    return Assignment(
        name=name,
        prompt=prompt,
        model=model,
        provider=provider,
        kind=kind,
        thinking=thinking,
        files=[os.path.normpath(f) for f in files],
        done_when=str(d.get("done_when", "")),
        review_cmd=str(d.get("review_cmd", "")),
        max_fix_rounds=max_fix,
        timeout=timeout,
        needs_results=[str(n) for n in d.get("needs_results", [])],
        load_extensions=bool(d.get("load_extensions", False)),
        display=display,
        mcp_config=mcp_config,
    )

def _parse_orchestrator(v, p: Path) -> OrchestratorSpec | None:
    """true → skill defaults; {"model": ..., "thinking": ...} → custom."""
    if not v:
        return None
    spec = OrchestratorSpec()
    if isinstance(v, dict):
        if v.get("model"):
            spec.model = str(v["model"]).strip()
        if v.get("thinking"):
            spec.thinking = str(v["thinking"]).strip()
        if v.get("synthesis_model"):
            spec.synthesis_model = str(v["synthesis_model"]).strip()
        if v.get("synthesis_thinking"):
            spec.synthesis_thinking = str(v["synthesis_thinking"]).strip()
    elif v is not True:
        raise PlanError(
            f"{p}: 'orchestrator' must be true or an object with model/thinking"
        )
    if "/" not in spec.model:
        raise PlanError(
            f"{p}: orchestrator model '{spec.model}' is not provider-qualified "
            f"(the orchestrator runs via pi, which requires 'provider/model')"
        )
    if spec.thinking not in THINKING_LEVELS:
        raise PlanError(
            f"{p}: orchestrator thinking '{spec.thinking}' not in {sorted(THINKING_LEVELS)}"
        )
    if spec.synthesis_model and "/" not in spec.synthesis_model:
        raise PlanError(
            f"{p}: synthesis_model '{spec.synthesis_model}' is not provider-qualified "
            f"(the synthesizer runs via pi, which requires 'provider/model')"
        )
    if spec.synthesis_thinking and spec.synthesis_thinking not in THINKING_LEVELS:
        raise PlanError(
            f"{p}: synthesis_thinking '{spec.synthesis_thinking}' not in {sorted(THINKING_LEVELS)}"
        )
    return spec


def load_plan(path: str | Path) -> Plan:
    p = Path(path).expanduser()
    if not p.is_file():
        raise PlanError(f"plan file not found: {p}")
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise PlanError(f"{p}: invalid JSON: {e}") from e
    if not isinstance(raw, dict):
        raise PlanError(f"{p}: top level must be an object")
    waves_raw = raw.get("waves")
    if not isinstance(waves_raw, list) or not waves_raw:
        raise PlanError(f"{p}: 'waves' must be a non-empty list of waves")

    plan = Plan(
        name=str(raw.get("name", p.stem)),
        cwd=str(Path(str(raw.get("cwd", "")) or Path.cwd()).expanduser().resolve()),
        on_failure=str(raw.get("on_failure", "stop")),
        waves=[],
        source=str(p),
        display=str(raw.get("display", "auto")),
        orchestrator=_parse_orchestrator(raw.get("orchestrator"), p),
    )
    if plan.display not in DISPLAY_MODES:
        raise PlanError(f"{p}: display must be one of {sorted(DISPLAY_MODES)}")
    if plan.on_failure not in {"stop", "continue"}:
        raise PlanError(f"{p}: on_failure must be 'stop' or 'continue'")
    if not Path(plan.cwd).is_dir():
        raise PlanError(f"{p}: cwd does not exist: {plan.cwd}")

    seen_names: set[str] = set()
    all_names: list[str] = []
    for w_idx, wave_raw in enumerate(waves_raw):
        if not isinstance(wave_raw, list) or not wave_raw:
            raise PlanError(f"{p}: wave {w_idx + 1} must be a non-empty list of assignments")
        wave: list[Assignment] = []
        seen_files: dict[str, str] = {}
        for a_idx, a_raw in enumerate(wave_raw):
            a = _parse_assignment(a_raw, w_idx, a_idx, default_display=plan.display)
            if a.name in seen_names:
                raise PlanError(f"{p}: duplicate agent name '{a.name}' (names must be unique plan-wide)")
            if plan.orchestrator and a.name == ORCHESTRATOR_NAME:
                raise PlanError(
                    f"{p}: assignment name '{ORCHESTRATOR_NAME}' is reserved for the "
                    f"orchestrator pane when plan-level 'orchestrator' is enabled"
                )
            if (plan.orchestrator and plan.orchestrator.synthesis_model
                    and a.name == SYNTHESIZER_NAME):
                raise PlanError(
                    f"{p}: assignment name '{SYNTHESIZER_NAME}' is reserved for the "
                    f"synthesis pane when orchestrator synthesis_model is set"
                )
            seen_names.add(a.name)
            for f in a.files:
                if f in seen_files:
                    raise PlanError(
                        f"{p}: file conflict in wave {w_idx + 1}: '{f}' is touched by both "
                        f"'{seen_files[f]}' and '{a.name}' — move one to a later wave"
                    )
                seen_files[f] = a.name
            wave.append(a)
            all_names.append(a.name)
        plan.waves.append(wave)

    seen_before: set[str] = set()
    for w_idx, wave in enumerate(plan.waves):
        for a in wave:
            for dep in a.needs_results:
                if dep not in all_names:
                    raise PlanError(f"{p}: '{a.name}' needs results of unknown agent '{dep}'")
                if dep not in seen_before:
                    raise PlanError(
                        f"{p}: '{a.name}' needs results of '{dep}', which is not in an earlier wave"
                    )
        seen_before.update(a.name for a in wave)
    return plan


def apply_overrides(plan: Plan, model: str | None = None,
                    provider: str | None = None,
                    thinking: str | None = None) -> Plan:
    """Replace model/provider/thinking on every assignment (CLI overrides).

    Mutates and returns the same plan. Same qualification rule as
    _parse_assignment: an unqualified model needs a provider — from the
    override or from the assignment itself (an assignment-level provider
    survives a --model-only override).
    """
    if model is not None and not model.strip():
        raise PlanError("override: model must not be empty")
    if thinking is not None and thinking not in THINKING_LEVELS:
        raise PlanError(f"override: thinking '{thinking}' not in {sorted(THINKING_LEVELS)}")
    for wave in plan.waves:
        for a in wave:
            if model is not None:
                a.model = model.strip()
            if provider is not None:
                a.provider = provider.strip() or None
            if thinking is not None:
                a.thinking = thinking
            if a.kind == "pi" and "/" not in a.model and not a.provider:
                raise PlanError(
                    f"override: agent '{a.name}' would get unqualified model "
                    f"'{a.model}' and no provider (pi requires 'provider/model'; "
                    f"pass --provider too)"
                )
    return plan
