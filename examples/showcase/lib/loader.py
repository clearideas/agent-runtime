"""Import a demo's Python modules (``demos/<folder>/<module>.py``).

Demo folders use hyphens, so they are imported as packages named with
underscores (``demos.repo_mechanic``), which lets each host import its
``script.py`` with a relative import.
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

DEMOS_DIRECTORY = Path(__file__).resolve().parent.parent / "demos"


def _package(name: str, directory: Path) -> None:
    if name not in sys.modules:
        module = types.ModuleType(name)
        module.__path__ = [str(directory)]
        module.__package__ = name
        sys.modules[name] = module


def load_demo_module(folder: str, module: str = "host") -> types.ModuleType:
    """``demos/<folder>/<module>.py``, imported as ``demos.<folder_with_underscores>.<module>``."""
    _package("demos", DEMOS_DIRECTORY)
    package = f"demos.{folder.replace('-', '_')}"
    _package(package, DEMOS_DIRECTORY / folder)
    return importlib.import_module(f"{package}.{module}")
