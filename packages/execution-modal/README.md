# `@clearideas/agent-runtime-execution-modal`

Implements `RemoteComputeLauncher` for Modal. The package maps worker
invocations to Modal function calls and uses the configured
`RemoteExecutionControlPlane` for status, ordered events, and results.

Applications provide `ModalGateway`, credentials, function lookup, application
names, environment names, and a `WorkerInvocationEnvelopeCodec`.

Modal execution fails closed without an invocation codec. The launcher sends
an authenticated encrypted envelope and the worker decodes it with
`decodeModalWorkerInvocation`. Plaintext invocation requires the explicit
`allowPlaintextInvocationForDevelopment` option and is only intended for a
trusted, isolated development worker.
