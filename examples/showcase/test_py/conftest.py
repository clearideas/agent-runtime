"""Unit tests of the Python showcase's host library (the HTTP tests live in ../test).

Run with `make test` at the repository root, or:
    ../../python/.venv/bin/python -m pytest test_py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
