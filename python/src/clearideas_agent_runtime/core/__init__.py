"""Deterministic execution engine and host ports (``@clearideas/agent-runtime-core``)."""

from .errors import *
from .execution_plan import ExecutionWave, build_execution_waves
from .limits import *
from .messages import *
from .policies import merge_execution_policies, resolve_step_policies
from .ports import *
from .runtime import *
from .runtime import (
    AgentRuntimeDependencies,
    ConditionEvaluator,
    ManifestHasher,
    RunTokenBudget,
    StepExecutor,
    maybe_await,
    stable_stringify,
)
from .state import (
    apply_state_patch,
    get_variable_at_path,
    has_variable_at_path,
    set_variable_at_path,
    snapshot_state,
    unset_variable_at_path,
)
from .templates import compile_prompt_template
from .version import RUNTIME_VERSION
