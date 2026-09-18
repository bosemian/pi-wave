"""Wave execution loop — the programmatic delegate-wave orchestrator.

For each wave: dispatch every assignment in parallel, wait for all to settle,
review each result against its definition of done, send at most
max_fix_rounds consolidated fix prompts, then move on. Default on_failure
is "stop": an assignment that exhausts its fix rounds halts later waves and
the state is reported honestly in the summary.
"""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field
from typing import Any

from .plan import Assignment, OrchestratorSpec, Plan, resolve_display
from .rpc import PiRpcSession
from .herdr_backend import (
    HerdrBackend,
    HerdrBlocked,
    HerdrPromptStalled,
    PaneLayout,
    herdr_available,
)

PROMPT_TEMPLATE = """\
You are assignment agent "{name}" in a delegated wave. Work autonomously and answer \
directly: do NOT dispatch subagents, do NOT delegate further, do NOT invoke \
delegate-wave or dispatch_wave.

FILES YOU MAY TOUCH: {files}
DEFINITION OF DONE: {done_when}

ASSIGNMENT:
{prompt}

When finished, end your final message with a concise summary of exactly what you did."""

FIX_TEMPLATE = """\
FIX ROUND {round}/{max}: your previous result failed review. Address ALL of the \
feedback below in one pass, then end with a concise summary of what you changed.

FILES YOU MAY TOUCH: {files}
DEFINITION OF DONE: {done_when}

ORIGINAL ASSIGNMENT:
{prompt}

REVIEW FEEDBACK:
{feedback}"""

ORCH_REVIEW_TEMPLATE = """\
You are the wave orchestrator reviewing assignment agent "{name}".
Review only — never edit files or do the assignment's work yourself; your \
entire reply must be the VERDICT block.

DEFINITION OF DONE: {done_when}
ORIGINAL ASSIGNMENT:
{prompt}

AGENT'S FINAL REPORT:
{text}

Judge the result against the definition of done, not effort expended. Reply in \
EXACTLY this format:
Line 1: VERDICT: pass
or:    VERDICT: fail
If fail, lines 2+ are ONE consolidated list of everything the agent must fix."""

ORCH_SYNTH_TEMPLATE = """\
All waves are done. Synthesize ONE final summary for the user: what changed, \
what was verified, and what remains. Do not repeat each agent's report \
verbatim. Text only — do not modify any files.

PER-AGENT OUTCOMES:
{outcomes}"""

# Role constraints pinned into the panes' system prompts (via
# --append-system-prompt, see HerdrBackend.start_agent): the orchestrator
# only reviews and synthesizes — it never implements assignments itself.
# The soft version of this rule also lives in the templates above; a hard
# guard (like assignment agents' --no-extensions) is not possible here
# because the pane needs its tools to read the repo while reviewing.
ORCH_ROLE_SYSTEM_PROMPT = """\
You are the delegate-wave orchestrator pane. The engine dispatches every \
assignment to other panes — your pane never implements anything. NEVER edit, \
create, or run code to do an assignment's work yourself. When asked to \
review, reply with ONLY the VERDICT block the prompt specifies; when asked \
to synthesize, reply with the summary text only."""

SYNTH_ROLE_SYSTEM_PROMPT = """\
You are the synthesizer pane of a delegated wave run. Your only job is \
writing the final summary text when asked. Never edit, create, or run code; \
never implement assignments."""

MAX_INJECTED_RESULT_CHARS = 6000
ORCH_INTERACT_TIMEOUT = 300.0
MAX_HERDR_AGENTS_PER_WAVE = 4


class OrchestratorPane:
    """The delegate-wave orchestrator agent (wider pane, gpt-5.5 @ high by
    default).

    One pane serves the whole run, so every interaction takes the lock —
    concurrent assignment coroutines must never interleave prompts."""

    def __init__(self, backend: HerdrBackend, spec: OrchestratorSpec,
                 layout: PaneLayout) -> None:
        self._backend = backend
        self._spec = spec
        self._layout = layout
        self._lock = asyncio.Lock()
        self.pane = ""
        self.synth_pane = ""

    async def start(self) -> None:
        # first split of the run (PaneLayout): the engine's own pane, to the
        # right, with a lower ratio so the orchestrator ends up wider than any
        # assignment pane (skill: 0.4, before any wave pane)
        self.pane = await self._layout.next_split(self._backend, ratio=0.4)
        await self._backend.start_agent(
            "orchestrator", self.pane, self._spec.model, None, self._spec.thinking,
            system_prompt=ORCH_ROLE_SYSTEM_PROMPT)

    async def review(self, a: Assignment, text: str) -> tuple[bool, str]:
        """Judge one agent result against its done_when → (ok, feedback)."""
        async with self._lock:
            await self._backend.prompt(
                "orchestrator",
                ORCH_REVIEW_TEMPLATE.format(
                    name=a.name,
                    done_when=a.done_when or "as stated in the assignment",
                    prompt=a.prompt,
                    text=text[:MAX_INJECTED_RESULT_CHARS],
                ),
                timeout_s=ORCH_INTERACT_TIMEOUT,
            )
            reply = await self._backend.read("orchestrator")
        verdict, feedback = _parse_verdict(reply)
        return verdict, feedback

    async def synthesize(self, results: dict) -> str:
        outcomes = "\n\n".join(
            f"- {r.name} ({r.model}): status={r.status}, rounds={r.rounds}\n"
            + r.text[:MAX_INJECTED_RESULT_CHARS]
            for r in results.values()
        )
        prompt = ORCH_SYNTH_TEMPLATE.format(outcomes=outcomes)
        async with self._lock:
            if self._spec.synthesis_model:
                # synthesis is reasoning work — a dedicated one-shot
                # `synthesizer` pane (split lazily, reused, left open)
                if not self.synth_pane:
                    self.synth_pane = await self._layout.next_split(self._backend)
                    await self._backend.start_agent(
                        "synthesizer", self.synth_pane,
                        self._spec.synthesis_model, None,
                        self._spec.synthesis_thinking or "high",
                        system_prompt=SYNTH_ROLE_SYSTEM_PROMPT)
                await self._backend.prompt(
                    "synthesizer", prompt, timeout_s=ORCH_INTERACT_TIMEOUT)
                return await self._backend.read("synthesizer")
            await self._backend.prompt(
                "orchestrator", prompt, timeout_s=ORCH_INTERACT_TIMEOUT)
            return await self._backend.read("orchestrator")


def _parse_verdict(reply: str) -> tuple[bool, str]:
    """First 'VERDICT: pass|fail' line decides; the rest is the feedback."""
    lines = reply.strip().splitlines()
    for i, line in enumerate(lines):
        low = line.strip().lower()
        if low.startswith("verdict:"):
            verdict = low[len("verdict:"):].strip()
            feedback = "\n".join(lines[i + 1:]).strip()
            if verdict.startswith("pass"):
                return True, ""
            return False, feedback or "orchestrator gave no specific feedback"
    return False, f"orchestrator reply had no VERDICT line:\n{reply[-500:]}"


@dataclass
class AgentResult:
    name: str
    wave: int
    model: str
    status: str = "error"  # pass | fail | timeout | blocked | error
    rounds: int = 0
    text: str = ""
    feedback: str = ""
    error: str = ""
    stats: dict[str, Any] = field(default_factory=dict)
    display: str = "headless"
    pane: str = ""

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "wave": self.wave,
            "model": self.model,
            "status": self.status,
            "rounds": self.rounds,
            "text": self.text,
            **({"feedback": self.feedback} if self.feedback else {}),
            **({"error": self.error} if self.error else {}),
            **({"pane": self.pane} if self.pane else {}),
            "display": self.display,
            "tokens": self.stats.get("tokens", {}),
            "cost": self.stats.get("cost", 0),
        }


Emitter = Any  # callable(dict) — JSONL lines on stdout


def _files_label(a: Assignment) -> str:
    return ", ".join(a.files) if a.files else "NONE — this is a read-only assignment"


def _build_prompt(a: Assignment, results: dict[str, AgentResult]) -> str:
    prompt = PROMPT_TEMPLATE.format(
        name=a.name,
        files=_files_label(a),
        done_when=a.done_when or "as stated in the assignment",
        prompt=a.prompt,
    )
    deps = [n for n in a.needs_results if n in results]
    if deps:
        parts = [
            f"\n\nRESULTS FROM PRIOR WAVES — agent '{n}':\n"
            + results[n].text[:MAX_INJECTED_RESULT_CHARS]
            for n in deps
        ]
        prompt += "".join(parts)
    return prompt


async def _run_review(review_cmd: str, cwd: str, agent_name: str, timeout: float = 300.0):
    env = {**os.environ, "PI_WAVE_AGENT": agent_name}
    try:
        proc = await asyncio.create_subprocess_shell(
            review_cmd,
            cwd=cwd,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        return proc.returncode == 0, out.decode("utf-8", errors="replace")
    except asyncio.TimeoutError:
        return False, f"review command timed out after {timeout:.0f}s"
    except Exception as e:
        return False, f"review command failed to run: {e}"


STALL_WATCH_S = 10.0       # pi agents boot fast; a stall usually means lost input
STALL_WATCH_S_OMP = 60.0   # the OMP CLI can take 30-90s to first respond
MAX_PROMPT_ATTEMPTS = 2


async def _prompt_herdr(backend: HerdrBackend, a: Assignment, message: str,
                        emit: Emitter) -> None:
    """Prompt a herdr agent, recovering from submission stalls.

    herdr requires a state change within its hard 5s window after a
    submission from idle; a freshly spawned CLI can take far longer to
    boot and the submission may still kick in late. On a stall: watch for
    a late start (longer for OMP) — if the agent wakes, consume the
    original submission and wait for settle.

    kind=omp never reports a non-idle agent_status at all (confirmed
    live — herdr's OMP integration has no activity signal for it, so
    wait_late_start always times out regardless of how fast OMP actually
    replies). Resending in that case would just re-submit the same prompt
    to an agent that is already working or already done, risking
    duplicate work — observed live as the pane running the assignment
    twice. So for omp, one stall goes straight to the pane-settled
    fallback; kind=pi (whose status field is reliable) keeps resending
    once before falling back."""
    watch_s = STALL_WATCH_S_OMP if a.kind == "omp" else STALL_WATCH_S
    max_attempts = 1 if a.kind == "omp" else MAX_PROMPT_ATTEMPTS
    baseline = await backend.read(a.name)
    for attempt in range(1, max_attempts + 1):
        try:
            await backend.prompt(a.name, message, timeout_s=a.timeout)
            return
        except HerdrPromptStalled:
            emit({"type": "prompt_stall_recovery", "agent": a.name,
                  "attempt": attempt, "watch_s": watch_s})
            status = await backend.wait_late_start(a.name, watch_s=watch_s)
            if status == "blocked":
                raise HerdrBlocked(
                    f"[{a.name}] agent is blocked at an approval/question dialog")
            if status is not None:
                await backend.wait_settled(a.name, timeout_s=a.timeout)
                return
            if attempt < max_attempts:
                await asyncio.sleep(2.0)
    # status never confirmed a wake (expected every time for omp) — before
    # declaring failure, check the pane itself: its own notification can
    # simply not fire while the agent is genuinely working (see
    # HerdrBackend.wait_pane_settled).
    emit({"type": "prompt_stall_pane_check", "agent": a.name, "watch_s": watch_s})
    if await backend.wait_pane_settled(a.name, baseline, timeout_s=watch_s):
        return
    raise TimeoutError(
        f"[{a.name}] prompt stalled {max_attempts}x and the agent stayed "
        f"idle for {watch_s:.0f}s — it likely never finished booting")


async def run_assignment(
    a: Assignment,
    wave_idx: int,
    plan: Plan,
    results: dict[str, AgentResult],
    emit: Emitter,
    orch: OrchestratorPane | None = None,
    layout: PaneLayout | None = None,
) -> AgentResult:
    if resolve_display(a.display) == "herdr":
        return await _run_assignment_herdr(a, wave_idx, plan, results, emit, orch, layout)
    return await _run_assignment_rpc(a, wave_idx, plan, results, emit)


async def _run_assignment_herdr(
    a: Assignment,
    wave_idx: int,
    plan: Plan,
    results: dict[str, AgentResult],
    emit: Emitter,
    orch: OrchestratorPane | None = None,
    layout: PaneLayout | None = None,
) -> AgentResult:
    """Agent lives in a Herdr pane (delegate-wave visual): split, start, prompt,
    read scrollback. Panes are left open for the user to inspect."""
    res = AgentResult(name=a.name, wave=wave_idx + 1, model=a.model, display="herdr")
    problem = herdr_available()
    if problem:
        res.status = "error"
        res.error = problem
        emit({"type": "agent_done", "agent": a.name, "status": res.status, "rounds": 0})
        return res

    backend = HerdrBackend(cwd=plan.cwd)
    emit({"type": "agent_start", "agent": a.name, "wave": res.wave,
          "model": a.model, "display": "herdr", "kind": a.kind})
    try:
        if layout is not None:
            pane = await layout.next_split(backend)
        else:
            pane = await backend.split_pane()
        res.pane = pane
        await backend.start_agent(a.name, pane, a.model, a.provider, a.thinking,
                                  mcp_config=a.mcp_config, kind=a.kind)
        emit({"type": "agent_pane", "agent": a.name, "pane": pane})

        message = _build_prompt(a, results)
        while True:
            await _prompt_herdr(backend, a, message, emit)
            res.text = await backend.read(a.name)
            res.rounds += 1

            verdict: bool | None
            review_out = ""
            if a.review_cmd:
                verdict, review_out = await _run_review(a.review_cmd, plan.cwd, a.name)
            elif orch is not None:
                # the delegate-wave orchestrator pane judges against done_when
                verdict, review_out = await orch.review(a, res.text)
            else:
                verdict = None
            if verdict is None:
                res.status = "pass"
                break
            if verdict:
                res.status = "pass"
                break

            emit({
                "type": "review_failed",
                "agent": a.name,
                "round": res.rounds,
                "review_output_tail": review_out[-500:],
            })
            if res.rounds > a.max_fix_rounds:
                res.status = "fail"
                res.feedback = review_out
                break
            message = FIX_TEMPLATE.format(
                round=res.rounds,
                max=a.max_fix_rounds,
                files=_files_label(a),
                done_when=a.done_when or "as stated in the assignment",
                prompt=a.prompt,
                feedback=review_out,
            )
    except HerdrBlocked as e:
        res.status = "blocked"
        res.error = str(e)
    except TimeoutError as e:
        res.status = "timeout"
        res.error = str(e)
    except Exception as e:
        res.status = "error"
        res.error = str(e)
    # Intentionally no teardown: the pane and the agent stay open for the user.
    emit({"type": "agent_done", "agent": a.name, "status": res.status,
          "rounds": res.rounds, "pane": res.pane, "text": res.text})
    return res


async def _run_assignment_rpc(
    a: Assignment,
    wave_idx: int,
    plan: Plan,
    results: dict[str, AgentResult],
    emit: Emitter,
) -> AgentResult:
    """Headless agent via pi RPC mode — structured events, no visible pane."""
    res = AgentResult(name=a.name, wave=wave_idx + 1, model=a.model, display="headless")
    if a.kind == "omp":
        res.status = "error"
        res.error = (
            f"kind=omp requires display=herdr — OMP agents need a Herdr pane "
            f"(set \"display\": \"herdr\" or run inside Herdr with display auto)"
        )
        emit({"type": "agent_done", "agent": a.name, "status": res.status, "rounds": 0})
        return res
    emit({"type": "agent_start", "agent": a.name, "wave": res.wave,
          "model": a.model, "display": "headless"})
    sess = PiRpcSession(
        agent_name=a.name,
        cwd=plan.cwd,
        model=a.model,
        provider=a.provider,
        thinking=a.thinking,
        load_extensions=a.load_extensions,
        mcp_config=a.mcp_config,
        on_event=lambda name, ev: emit({"agent": name, **ev, "type": "agent_progress"}),
    )
    try:
        state = await sess.start()
        sess.verify_model(state)

        message = _build_prompt(a, results)
        while True:
            await sess.prompt_and_settle(message, timeout=a.timeout)
            res.text = await sess.last_text()
            res.rounds += 1

            if not a.review_cmd:
                res.status = "pass"
                break

            ok, review_out = await _run_review(a.review_cmd, plan.cwd, a.name)
            if ok:
                res.status = "pass"
                break

            emit({
                "type": "review_failed",
                "agent": a.name,
                "round": res.rounds,
                "review_output_tail": review_out[-500:],
            })
            if res.rounds > a.max_fix_rounds:
                res.status = "fail"
                res.feedback = review_out
                break
            message = FIX_TEMPLATE.format(
                round=res.rounds,
                max=a.max_fix_rounds,
                files=_files_label(a),
                done_when=a.done_when or "as stated in the assignment",
                prompt=a.prompt,
                feedback=review_out,
            )
        res.stats = await sess.stats()
    except TimeoutError as e:
        res.status = "timeout"
        res.error = str(e)
    except Exception as e:
        res.status = "error"
        res.error = str(e)
    finally:
        await sess.close()
    emit({"type": "agent_done", "agent": a.name, "status": res.status,
          "rounds": res.rounds, "text": res.text})
    return res


async def orchestrate(plan: Plan, emit: Emitter) -> dict[str, Any]:
    emit({
        "type": "plan_start",
        "plan": plan.name,
        "cwd": plan.cwd,
        "waves": len(plan.waves),
        "agents": sum(len(w) for w in plan.waves),
    })

    # one shared grid for the whole run: orchestrator right, then the
    # assignment row splits down and fills right (see PaneLayout)
    layout = PaneLayout()
    orch: OrchestratorPane | None = None
    if plan.orchestrator:
        problem = herdr_available()
        if problem:
            emit({"type": "orchestrator_error", "error": problem})
        else:
            orch = OrchestratorPane(HerdrBackend(cwd=plan.cwd), plan.orchestrator, layout)
            try:
                await orch.start()
                emit({"type": "orchestrator_start",
                      "model": plan.orchestrator.model,
                      "thinking": plan.orchestrator.thinking,
                      "pane": orch.pane})
            except Exception as e:
                emit({"type": "orchestrator_error", "error": str(e)})
                orch = None

    results: dict[str, AgentResult] = {}
    overall = "completed"
    for w_idx, wave in enumerate(plan.waves):
        # delegate-wave skill: 4 agents per wave in herdr mode — the
        # assignment row fills right (see PaneLayout), so too many panes in
        # one wave still make unusably narrow columns (observed: the
        # last-split agent stalls/fails). Headless waves have no panes and
        # no such limit.
        herdr_agents = [a.name for a in wave if resolve_display(a.display) == "herdr"]
        if len(herdr_agents) > MAX_HERDR_AGENTS_PER_WAVE:
            overall = "stopped"
            emit({
                "type": "stopped",
                "reason": (
                    f"wave {w_idx + 1} has {len(herdr_agents)} herdr-display agents "
                    f"({', '.join(herdr_agents)}) — the delegate-wave skill caps panes "
                    f"at {MAX_HERDR_AGENTS_PER_WAVE} agents per wave (unusably narrow "
                    f"columns); split into more waves or force display headless"
                ),
            })
            break
        emit({"type": "wave_start", "wave": w_idx + 1, "agents": [a.name for a in wave]})
        outcomes = await asyncio.gather(
            *(run_assignment(a, w_idx, plan, results, emit, orch, layout) for a in wave)
        )
        for r in outcomes:
            results[r.name] = r
        wave_ok = all(r.status == "pass" for r in outcomes)
        emit({"type": "wave_done", "wave": w_idx + 1, "passed": wave_ok})
        if not wave_ok and plan.on_failure == "stop":
            overall = "stopped"
            emit({
                "type": "stopped",
                "reason": "wave failed and plan.on_failure is 'stop'; later waves were not dispatched",
            })
            break

    summary = {
        "type": "summary",
        "plan": plan.name,
        "cwd": plan.cwd,
        "status": overall,
        "waves": [
            {
                "wave": i + 1,
                "agents": [results[a.name].to_json() for a in wave if a.name in results],
            }
            for i, wave in enumerate(plan.waves)
        ],
    }
    if orch is not None:
        try:
            summary["synthesis"] = await orch.synthesize(results)
            emit({"type": "orchestrator_done", "pane": orch.pane,
                  **({"synthesis_pane": orch.synth_pane} if orch.synth_pane else {})})
        except Exception as e:
            # synthesis is a bonus, not a gate — report its failure honestly
            summary["synthesis"] = f"(orchestrator synthesis failed: {e})"
            emit({"type": "orchestrator_error", "error": f"synthesis failed: {e}"})
    emit(summary)
    return summary
