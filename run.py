#!/usr/bin/env python3
"""Zero-install launcher: python3 run.py <plan.json> [--dry-run]
                                       [--model M] [--provider P] [--thinking T]"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from pi_wave.cli import main  # noqa: E402

raise SystemExit(main())
