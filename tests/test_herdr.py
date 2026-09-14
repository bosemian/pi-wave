"""Tests for the display field and Herdr backend parsing (no Herdr needed)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pi_wave.plan import PlanError, load_plan, resolve_display  # noqa: E402
from pi_wave.herdr_backend import _find_key  # noqa: E402


def write_plan(tmp: Path, plan: dict) -> str:
    f = tmp / "plan.json"
    f.write_text(json.dumps(plan), encoding="utf-8")
    return str(f)


def base_assignment(**over) -> dict:
    a = {
        "name": "wave-1-code",
        "prompt": "do the thing",
        "model": "kimi-coding/k3",
        "files": [],
    }
    a.update(over)
    return a


class TestAutoDisplay(unittest.TestCase):
    def test_default_display_is_auto(self):
        import tempfile
        tmp = Path(tempfile.mkdtemp())
        cwd = tmp / "proj"
        cwd.mkdir()
        p = load_plan(write_plan(tmp, {"cwd": str(cwd), "waves": [[base_assignment()]]}))
        self.assertEqual(p.display, "auto")
        self.assertEqual(p.waves[0][0].display, "auto")

    def test_resolve_display_follows_herdr_env(self):
        import os
        from unittest.mock import patch
        with patch.dict(os.environ, {"HERDR_ENV": "1"}):
            self.assertEqual(resolve_display("auto"), "herdr")
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(resolve_display("auto"), "headless")
        self.assertEqual(resolve_display("headless"), "headless")
        self.assertEqual(resolve_display("herdr"), "herdr")


class TestDisplayField(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.cwd = str(self.tmp / "proj")
        Path(self.cwd).mkdir()

    def test_plan_level_display_inherited(self):
        p = load_plan(write_plan(self.tmp, {
            "cwd": self.cwd,
            "display": "herdr",
            "waves": [[base_assignment()]],
        }))
        self.assertEqual(p.waves[0][0].display, "herdr")
        self.assertEqual(p.display, "herdr")

    def test_assignment_display_overrides_plan(self):
        p = load_plan(write_plan(self.tmp, {
            "cwd": self.cwd,
            "display": "herdr",
            "waves": [[base_assignment(), base_assignment(name="wave-1-b",
                                                          display="headless")]],
        }))
        self.assertEqual(p.waves[0][0].display, "herdr")
        self.assertEqual(p.waves[0][1].display, "headless")

    def test_bad_display_rejected(self):
        with self.assertRaises(PlanError) as cm:
            load_plan(write_plan(self.tmp, {
                "cwd": self.cwd,
                "waves": [[base_assignment(display="tmux")]],
            }))
        self.assertIn("display", str(cm.exception))

    def test_bad_plan_display_rejected(self):
        with self.assertRaises(PlanError) as cm:
            load_plan(write_plan(self.tmp, {
                "cwd": self.cwd,
                "display": "screen",
                "waves": [[base_assignment()]],
            }))
        self.assertIn("display", str(cm.exception))

    def test_mcp_config_missing_file_rejected(self):
        with self.assertRaises(PlanError) as cm:
            load_plan(write_plan(self.tmp, {
                "cwd": self.cwd,
                "waves": [[base_assignment(mcp_config="/no/such/file.json")]],
            }))
        self.assertIn("mcp_config", str(cm.exception))

    def test_mcp_config_valid_file_accepted(self):
        cfg = self.tmp / "wigolo.mcp.json"
        cfg.write_text("{}", encoding="utf-8")
        p = load_plan(write_plan(self.tmp, {
            "cwd": self.cwd,
            "waves": [[base_assignment(mcp_config=str(cfg))]],
        }))
        self.assertEqual(p.waves[0][0].mcp_config, str(cfg))

    def test_dry_run_shows_display(self):
        import subprocess
        plan_file = write_plan(self.tmp, {
            "cwd": self.cwd,
            "display": "herdr",
            "waves": [[base_assignment()]],
        })
        repo_root = Path(__file__).resolve().parents[1]
        proc = subprocess.run(
            ["python3", str(repo_root / "run.py"), plan_file, "--dry-run"],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
        assignment = next(l for l in lines if l["type"] == "assignment")
        self.assertEqual(assignment["display"], "herdr")


class TestHerdrJsonParsing(unittest.TestCase):
    def test_find_pane_id_nested(self):
        resp = {"result": {"pane": {"pane_id": "w1:p7", "tab_id": "w1:t1"}}}
        self.assertEqual(_find_key(resp.get("result", resp), "pane_id"), "w1:p7")

    def test_find_argv_list(self):
        resp = {"result": {"argv": ["pi", "--model", "kimi-coding/k3", "--thinking", "high"]}}
        argv = _find_key(resp.get("result", resp), "argv")
        self.assertIn("kimi-coding/k3", " ".join(argv))

    def test_find_key_missing_returns_none(self):
        self.assertIsNone(_find_key({"a": {"b": 1}}, "pane_id"))


if __name__ == "__main__":
    unittest.main()
