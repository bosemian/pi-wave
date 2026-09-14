"""Unit tests for plan validation (no network, no pi required).

Run from the repo root:  python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pi_wave.plan import PlanError, apply_overrides, load_plan  # noqa: E402


def write_plan(tmp: Path, plan: dict) -> str:
    f = tmp / "plan.json"
    f.write_text(json.dumps(plan), encoding="utf-8")
    return str(f)


def base_assignment(**over) -> dict:
    a = {
        "name": "wave-1-code",
        "prompt": "do the thing",
        "model": "kimi-coding/k3",
        "thinking": "high",
        "files": ["src/a.py"],
    }
    a.update(over)
    return a


class TestPlanValidation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cwd = str(Path(self.tmp) / "proj")
        Path(self.cwd).mkdir()

    def test_valid_plan_loads(self):
        p = load_plan(write_plan(Path(self.tmp), {
            "name": "t",
            "cwd": self.cwd,
            "waves": [[base_assignment(), base_assignment(name="wave-1-review", files=[])],
                      [base_assignment(name="wave-2-docs", files=["docs/x.md"],
                                       needs_results=["wave-1-code"])]],
        }))
        self.assertEqual(len(p.waves), 2)
        self.assertEqual(p.waves[0][0].name, "wave-1-code")
        self.assertEqual(p.waves[1][0].name, "wave-2-docs")
        # model "kimi-coding/k3" is qualified, so no explicit provider field is needed
        self.assertIsNone(p.waves[0][0].provider)

    def test_same_wave_file_conflict_rejected(self):
        with self.assertRaises(PlanError) as cm:
            load_plan(write_plan(Path(self.tmp), {
                "cwd": self.cwd,
                "waves": [[base_assignment(), base_assignment(name="wave-1-other",
                                                              files=["src/a.py"])]],
            }))
        self.assertIn("file conflict", str(cm.exception))

    def test_same_file_different_waves_ok(self):
        p = load_plan(write_plan(Path(self.tmp), {
            "cwd": self.cwd,
            "waves": [[base_assignment()],
                      [base_assignment(name="wave-2-docs", files=["src/a.py"])]],
        }))
        self.assertEqual(len(p.waves), 2)

    def test_duplicate_names_rejected(self):
        with self.assertRaises(PlanError) as cm:
            load_plan(write_plan(Path(self.tmp), {
                "cwd": self.cwd,
                "waves": [[base_assignment()],
                          [base_assignment(files=[])]],
            }))
        self.assertIn("duplicate agent name", str(cm.exception))

    def test_unqualified_model_without_provider_rejected(self):
        with self.assertRaises(PlanError) as cm:
            load_plan(write_plan(Path(self.tmp), {
                "cwd": self.cwd,
                "waves": [[base_assignment(model="k3")]],
            }))
        self.assertIn("provider-qualified", str(cm.exception))

    def test_unqualified_model_with_provider_ok(self):
        p = load_plan(write_plan(Path(self.tmp), {
            "cwd": self.cwd,
            "waves": [[base_assignment(model="k3", provider="kimi-coding")]],
        }))
        self.assertEqual(p.waves[0][0].provider, "kimi-coding")

    def test_bad_thinking_rejected(self):
        with self.assertRaises(PlanError) as cm:
            load_plan(write_plan(Path(self.tmp), {
                "cwd": self.cwd,
                "waves": [[base_assignment(thinking="ultra")]],
            }))
        self.assertIn("thinking", str(cm.exception))

    def test_needs_results_from_same_wave_rejected(self):
        with self.assertRaises(PlanError) as cm:
            load_plan(write_plan(Path(self.tmp), {
                "cwd": self.cwd,
                "waves": [[base_assignment(),
                           base_assignment(name="wave-1-other", files=[],
                                           needs_results=["wave-1-code"])]],
            }))
        self.assertIn("earlier wave", str(cm.exception))

    def test_needs_results_unknown_agent_rejected(self):
        with self.assertRaises(PlanError) as cm:
            load_plan(write_plan(Path(self.tmp), {
                "cwd": self.cwd,
                "waves": [[base_assignment(needs_results=["ghost"])]],
            }))
        self.assertIn("unknown agent", str(cm.exception))

    def test_bad_name_rejected(self):
        with self.assertRaises(PlanError):
            load_plan(write_plan(Path(self.tmp), {
                "cwd": self.cwd,
                "waves": [[base_assignment(name="Bad Name")]],
            }))

    def test_missing_cwd_rejected(self):
        with self.assertRaises(PlanError) as cm:
            load_plan(write_plan(Path(self.tmp), {
                "cwd": "/definitely/not/a/real/dir/xyz",
                "waves": [[base_assignment()]],
            }))
        self.assertIn("cwd", str(cm.exception))


class TestKindAndOrchestrator(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cwd = str(Path(self.tmp) / "proj")
        Path(self.cwd).mkdir()

    def _plan(self, **over):
        return load_plan(write_plan(Path(self.tmp), {
            "cwd": self.cwd,
            "waves": [[base_assignment(**over)]],
        }))

    def test_kind_defaults_to_pi(self):
        self.assertEqual(self._plan().waves[0][0].kind, "pi")

    def test_bad_kind_rejected(self):
        with self.assertRaises(PlanError) as cm:
            self._plan(kind="omp2")
        self.assertIn("kind", str(cm.exception))

    def test_omp_accepts_bare_model(self):
        a = self._plan(kind="omp", model="claude-sonnet-5").waves[0][0]
        self.assertEqual(a.kind, "omp")
        self.assertEqual(a.model, "claude-sonnet-5")

    def test_orchestrator_true_uses_skill_defaults(self):
        p = load_plan(write_plan(Path(self.tmp), {
            "cwd": self.cwd,
            "orchestrator": True,
            "waves": [[base_assignment()]],
        }))
        self.assertEqual(p.orchestrator.model, "openai-codex/gpt-5.6-sol")
        self.assertEqual(p.orchestrator.thinking, "high")

    def test_orchestrator_object_custom(self):
        p = load_plan(write_plan(Path(self.tmp), {
            "cwd": self.cwd,
            "orchestrator": {"model": "kimi-coding/k3", "thinking": "low"},
            "waves": [[base_assignment()]],
        }))
        self.assertEqual(p.orchestrator.model, "kimi-coding/k3")
        self.assertEqual(p.orchestrator.thinking, "low")

    def test_orchestrator_unqualified_model_rejected(self):
        with self.assertRaises(PlanError) as cm:
            load_plan(write_plan(Path(self.tmp), {
                "cwd": self.cwd,
                "orchestrator": {"model": "gpt-5.6-sol"},
                "waves": [[base_assignment()]],
            }))
        self.assertIn("provider-qualified", str(cm.exception))

    def test_orchestrator_bad_thinking_rejected(self):
        with self.assertRaises(PlanError) as cm:
            load_plan(write_plan(Path(self.tmp), {
                "cwd": self.cwd,
                "orchestrator": {"thinking": "ultra"},
                "waves": [[base_assignment()]],
            }))
        self.assertIn("thinking", str(cm.exception))

    def test_orchestrator_name_reserved_when_enabled(self):
        with self.assertRaises(PlanError) as cm:
            load_plan(write_plan(Path(self.tmp), {
                "cwd": self.cwd,
                "orchestrator": True,
                "waves": [[base_assignment(name="orchestrator")]],
            }))
        self.assertIn("reserved", str(cm.exception))

    def test_orchestrator_name_ok_when_disabled(self):
        p = load_plan(write_plan(Path(self.tmp), {
            "cwd": self.cwd,
            "waves": [[base_assignment(name="orchestrator")]],
        }))
        self.assertEqual(p.waves[0][0].name, "orchestrator")

    def test_synthesis_fields_parse(self):
        p = load_plan(write_plan(Path(self.tmp), {
            "cwd": self.cwd,
            "orchestrator": {"model": "openai-codex/gpt-5.5",
                             "synthesis_model": "openai-codex/gpt-5.6-sol",
                             "synthesis_thinking": "high"},
            "waves": [[base_assignment()]],
        }))
        self.assertEqual(p.orchestrator.model, "openai-codex/gpt-5.5")
        self.assertEqual(p.orchestrator.synthesis_model, "openai-codex/gpt-5.6-sol")
        self.assertEqual(p.orchestrator.synthesis_thinking, "high")

    def test_synthesis_fields_default_empty(self):
        p = load_plan(write_plan(Path(self.tmp), {
            "cwd": self.cwd,
            "orchestrator": True,
            "waves": [[base_assignment()]],
        }))
        self.assertEqual(p.orchestrator.synthesis_model, "")

    def test_unqualified_synthesis_model_rejected(self):
        with self.assertRaises(PlanError) as cm:
            load_plan(write_plan(Path(self.tmp), {
                "cwd": self.cwd,
                "orchestrator": {"synthesis_model": "gpt-5.6-sol"},
                "waves": [[base_assignment()]],
            }))
        self.assertIn("synthesis_model", str(cm.exception))

    def test_bad_synthesis_thinking_rejected(self):
        with self.assertRaises(PlanError) as cm:
            load_plan(write_plan(Path(self.tmp), {
                "cwd": self.cwd,
                "orchestrator": {"synthesis_model": "openai-codex/gpt-5.6-sol",
                                 "synthesis_thinking": "ultra"},
                "waves": [[base_assignment()]],
            }))
        self.assertIn("synthesis_thinking", str(cm.exception))

    def test_synthesizer_name_reserved_when_synthesis_model_set(self):
        with self.assertRaises(PlanError) as cm:
            load_plan(write_plan(Path(self.tmp), {
                "cwd": self.cwd,
                "orchestrator": {"synthesis_model": "openai-codex/gpt-5.6-sol"},
                "waves": [[base_assignment(name="synthesizer")]],
            }))
        self.assertIn("synthesizer", str(cm.exception))

    def test_override_skips_qualification_check_for_omp(self):
        p = self._plan(kind="omp", model="claude-sonnet-5")
        apply_overrides(p, model="k3")  # unqualified, but the agent is omp
        self.assertEqual(p.waves[0][0].model, "k3")


class TestOverrides(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cwd = str(Path(self.tmp) / "proj")
        Path(self.cwd).mkdir()

    def _plan(self, **over):
        return load_plan(write_plan(Path(self.tmp), {
            "cwd": self.cwd,
            "waves": [[base_assignment(**over)]],
        }))

    def test_model_override_replaces_assignment(self):
        p = apply_overrides(self._plan(), model="anthropic/claude-x")
        self.assertEqual(p.waves[0][0].model, "anthropic/claude-x")

    def test_unqualified_model_override_without_provider_rejected(self):
        with self.assertRaises(PlanError) as cm:
            apply_overrides(self._plan(), model="k3")
        self.assertIn("provider", str(cm.exception))

    def test_unqualified_model_override_keeps_assignment_provider(self):
        p = apply_overrides(self._plan(model="k3", provider="kimi-coding"), model="k3-v2")
        a = p.waves[0][0]
        self.assertEqual(a.model, "k3-v2")
        self.assertEqual(a.provider, "kimi-coding")

    def test_provider_override_replaces_assignment_provider(self):
        p = apply_overrides(self._plan(model="k3", provider="kimi-coding"), provider="other")
        self.assertEqual(p.waves[0][0].provider, "other")

    def test_thinking_override_replaces_assignment(self):
        p = apply_overrides(self._plan(), thinking="low")
        self.assertEqual(p.waves[0][0].thinking, "low")

    def test_bad_thinking_override_rejected(self):
        with self.assertRaises(PlanError) as cm:
            apply_overrides(self._plan(), thinking="ultra")
        self.assertIn("thinking", str(cm.exception))

    def test_untouched_fields_survive_override(self):
        p = apply_overrides(self._plan(), model="anthropic/claude-x", thinking="off")
        a = p.waves[0][0]
        self.assertEqual(a.prompt, "do the thing")
        self.assertEqual(a.files, ["src/a.py"])


class TestRepoExamples(unittest.TestCase):
    def test_role_split_respects_pane_cap(self):
        # delegate-wave skill: at most 2 herdr-display agents per wave
        root = Path(__file__).resolve().parents[1]
        p = load_plan(root / "examples" / "role-split-plan.json")
        self.assertTrue(all(len(w) <= 2 for w in p.waves),
                        f"wave sizes: {[len(w) for w in p.waves]}")


if __name__ == "__main__":
    unittest.main()
