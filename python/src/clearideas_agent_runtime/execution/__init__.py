"""Execution engines and the worker protocol (``@clearideas/agent-runtime-execution``)."""

from .child_process import ChildProcessExecutionEngine
from .client import ExecutionClient
from .contracts import *
from .in_process import ExecutionHandlerContext, InProcessExecutionEngine
from .remote import InMemoryRemoteExecutionControlPlane, RemoteExecutionEngine
from .secure_invocation import (
    SECURE_INVOCATION_ALGORITHM,
    SECURE_INVOCATION_ENVELOPE_VERSION,
    AesGcmWorkerInvocationCodec,
    SecureInvocationError,
    parse_secure_invocation_envelope,
    parse_worker_invocation_encryption_key,
)
from .worker_protocol import (
    MAXIMUM_WORKER_INVOCATION_BYTES,
    create_worker_invocation,
    parse_worker_invocation,
    parse_worker_message,
    serialize_worker_message,
)
