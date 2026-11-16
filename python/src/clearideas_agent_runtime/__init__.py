"""Clear Ideas Agent Runtime for Python.

Like ``@clearideas/agent-runtime``, the top-level package is the standard
composition (``create_agent_runtime``, ``define_agent``) and re-exports the
public API of every subpackage, so hosts can write::

    from clearideas_agent_runtime import AgentRuntime, FileRunStore, compose_runtime

The subpackages mirror the TypeScript packages: ``contracts``, ``core``,
``conditions``, ``steps`` (``prompt``, ``loop``, ``standard``), ``stores``
(``local``, ``sqlite``), ``models``, ``config``, ``sandbox``, ``artifacts``,
``execution``, and ``telemetry``. The pydantic-ai model adapter
(``PydanticAIModelAdapter`` and its helpers) needs the ``providers`` extra and
is imported on first use.
"""

from __future__ import annotations

import importlib
import types as _types
from typing import TYPE_CHECKING, Any

from ._js.abort import AbortController, AbortError, AbortSignal
from .agent import create_agent_runtime, define_agent
from .core.version import RUNTIME_VERSION

# The packages ``@clearideas/agent-runtime`` re-exports, in the same order.
_EAGER = (
    "conditions",
    "config",
    "contracts",
    "core",
    "execution",
    "sandbox",
    "steps.loop",
    "steps.prompt",
    "steps.standard",
    "stores.local",
)
# Imported on first use: they need the ``providers`` extra.
_LAZY = ("models.pydantic_ai", "models.providers")


def _public_names(module: _types.ModuleType) -> list[str]:
    names = getattr(module, "__all__", None)
    if names is None:
        names = [name for name in vars(module) if not name.startswith("_")]
    # Submodules and typing aliases such as ``JsonObject`` are not part of the API.
    return [
        name
        for name in names
        if name not in ("JsonObject", "annotations") and not isinstance(getattr(module, name, None), _types.ModuleType)
    ]


def _eager_exports() -> dict[str, Any]:
    exports: dict[str, Any] = {}
    for name in _EAGER:
        module = importlib.import_module(f".{name}", __name__)
        for export in _public_names(module):
            exports.setdefault(export, getattr(module, export))
    return exports


_exports = _eager_exports()
globals().update(_exports)

_lazy_names: dict[str, str] | None = None


def __getattr__(name: str) -> Any:
    global _lazy_names
    if _lazy_names is None:
        _lazy_names = {}
        for module_name in _LAZY:
            try:
                module = importlib.import_module(f".{module_name}", __name__)
            except ImportError:
                continue
            for export in _public_names(module):
                _lazy_names.setdefault(export, module_name)
    module_name = _lazy_names.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(importlib.import_module(f".{module_name}", __name__), name)
    globals()[name] = value
    return value


if TYPE_CHECKING:
    from .conditions import *
    from .config import *
    from .contracts import *
    from .core import *
    from .execution import *
    from .models.providers import create_model_factory
    from .models.pydantic_ai import *
    from .sandbox import *
    from .steps.loop import *
    from .steps.prompt import *
    from .steps.standard import *
    from .stores.local import *

# Assigned through globals() so type checkers read the public names from the
# imports above rather than from a computed list.
globals()["__all__"] = [
    "RUNTIME_VERSION",
    "AbortController",
    "AbortError",
    "AbortSignal",
    "create_agent_runtime",
    "define_agent",
    *sorted(_exports),
]
