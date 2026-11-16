"""The ``agent-runtime-py`` command line (``packages/cli``, without ``serve`` and ``examples``).

Commands, options, stores, and output documents match the TypeScript CLI, so
either CLI reads the other's stores, and ``worker`` processes of either
runtime serve either runtime's child-process engine.
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ._js import json as js_json
from ._js import yaml as js_yaml
from ._js.errors import Error, error_message
from .conditions import JexlConditionEvaluator
from .config import (
    ComposeRuntimeOptions,
    compose_runtime,
    empty_agent_runtime_config,
    load_agent_runtime_config,
    parse_agent_runtime_config,
    validate_runtime_configuration,
)
from .contracts import parse, parse_agent_variable_overrides, run_limits_schema
from .core import AgentRuntime
from .core.messages import MessagesOptions
from .execution import EXECUTION_PROTOCOL_VERSION, parse_worker_invocation, serialize_worker_message
from .steps.loop import LoopStepExecutor
from .steps.prompt import PromptMessageHistoryCompactor, PromptStepExecutor
from .steps.standard import ApprovalStepExecutor, CodeStepExecutor, SubRunStepExecutor
from .stores.local import (
    FileAgentManifestSource,
    FileAgentRunManifestSource,
    FileArtifactStore,
    FileRunStore,
    JsonlEventSink,
)

JsonObject = dict[str, Any]
MAXIMUM_WORKER_INPUT_BYTES = 16 * 1024 * 1024
CONFIG_FILE_NAMES = ("agent-runtime.config.yaml", "agent-runtime.config.yml", "agent-runtime.config.json")

USAGE = """Clear Ideas Agent Runtime (Python)

Usage:
  agent-runtime-py validate <manifest.json|manifest.yaml> [--config <config.yaml>]
  agent-runtime-py config validate <config.json|config.yaml>
  agent-runtime-py run <manifest.json|manifest.yaml> [--variables <overrides.json>] [--messages <messages.json|messages.yaml>] [--messages-scope <scope>] [--messages-out <file>] [--max-total-tokens <count>] [--config <config.yaml>] [--run-id <id>] [--store <path>] [--store-driver <file|sqlite>] [--events <file|none>] [--artifacts <directory|none>] [--runtime-module <local-py-file>] [--format <json|pretty|ndjson>]
  agent-runtime-py run-manifest <run.json|run.yaml> [--messages-scope <scope>] [--messages-out <file>] [--config <config.yaml>] [--store <path>] [--store-driver <file|sqlite>] [--events <file|none>] [--artifacts <directory|none>] [--runtime-module <local-py-file>] [--format <json|pretty|ndjson>]
  agent-runtime-py resume <run-id> [--max-total-tokens <count>] [--config <config.yaml>] [--store <path>] [--store-driver <file|sqlite>] [--events <file|none>] [--artifacts <directory|none>] [--runtime-module <local-py-file>] [--format <json|pretty|ndjson>]
  agent-runtime-py inspect <run-id> [--store <path>] [--store-driver <file|sqlite>]
  agent-runtime-py events <events.jsonl> [--run <run-id>] [--type <event-type>] [--tail <count>]
  agent-runtime-py worker [--store <path>] [--store-driver <file|sqlite>] [--config <config.yaml>] [--runtime-module <local-py-file>]

Options accept --name value or --name=value.
"""


@dataclass
class CliIo:
    stdout: Callable[[str], None] = field(default=lambda text: (sys.stdout.write(text), sys.stdout.flush()) and None)
    stderr: Callable[[str], None] = field(default=lambda text: (sys.stderr.write(text), sys.stderr.flush()) and None)


@dataclass
class ParsedOptions:
    positional: list[str]
    options: dict[str, str]


def parse_options(args: list[str], allowed: set[str], flags: set[str] | None = None) -> ParsedOptions:
    flags = flags or set()
    positional: list[str] = []
    options: dict[str, str] = {}
    index = 0
    while index < len(args):
        value = args[index]
        index += 1
        if not value.startswith("--"):
            positional.append(value)
            continue
        separator = value.find("=")
        name = value[2:] if separator < 0 else value[2:separator]
        option = f"--{name}"
        if name not in allowed:
            raise Error(f"Unknown option: {option}")
        if name in flags:
            if separator >= 0:
                raise Error(f"Option {option} does not take a value.")
            if name in options:
                raise Error(f"Option {option} may only be provided once.")
            options[name] = "true"
            continue
        if separator >= 0:
            option_value: str | None = value[separator + 1 :]
        else:
            option_value = args[index] if index < len(args) else None
            if option_value is not None and option_value.startswith("--"):
                option_value = None
            index += 1
        if not option_value:
            raise Error(f"Option {option} requires a value.")
        if name in options:
            raise Error(f"Option {option} may only be provided once.")
        options[name] = option_value
    return ParsedOptions(positional, options)


def _one_positional(parsed: ParsedOptions, label: str) -> str:
    if len(parsed.positional) != 1:
        raise Error(f"Expected exactly one {label}.")
    return parsed.positional[0]


def _positive_integer_option(parsed: ParsedOptions, name: str) -> int | None:
    value = parsed.options.get(name)
    if value is None:
        return None
    try:
        number = float(value)
    except ValueError:
        number = float("nan")
    if not number.is_integer() or number <= 0 or number > 2**53 - 1:
        raise Error(f"--{name} must be a positive safe integer.")
    return int(number)


def _pretty(value: Any) -> str:
    return f"{js_json.stringify(value, 2)}\n"


def _read_document(file: str) -> Any:
    source = Path(file).read_text(encoding="utf-8")
    return js_json.parse(source) if file.endswith(".json") else js_yaml.parse(source)


@dataclass
class _Store:
    driver: str
    location: str
    base_directory: str
    store: Any = None

    def close(self) -> None:
        close = getattr(self.store, "close", None)
        if callable(close):
            close()


def _store_location(parsed: ParsedOptions, worker: bool = False) -> _Store:
    driver = parsed.options.get("store-driver", "file")
    if driver not in ("file", "sqlite"):
        raise Error("--store-driver must be file or sqlite.")
    default = ".agent-runtime-worker" if worker else ".agent-runtime"
    location = os.path.abspath(
        parsed.options.get("store") or (os.path.join(default, "runs.sqlite") if driver == "sqlite" else default)
    )
    return _Store(driver, location, os.path.dirname(location) if driver == "sqlite" else location)


def _open_store(resolved: _Store) -> _Store:
    if resolved.driver == "sqlite":
        from .stores.sqlite import SqliteRunStore

        os.makedirs(os.path.dirname(resolved.location), exist_ok=True)
        resolved.store = SqliteRunStore(resolved.location)
    else:
        resolved.store = FileRunStore(resolved.location)
    return resolved


async def resolve_agent_runtime_config(file: str | None, search_directory: str) -> JsonObject:
    """``--config``, else ``agent-runtime.config.*`` in ``search_directory``, else an empty configuration."""
    if file:
        return await load_agent_runtime_config(file)
    for name in CONFIG_FILE_NAMES:
        candidate = os.path.join(search_directory, name)
        if os.path.exists(candidate):
            return await load_agent_runtime_config(candidate)
    return empty_agent_runtime_config()


def _load_runtime_module(path: str | None, context: JsonObject) -> JsonObject:
    """A host module: ``create_runtime(context) -> dict`` of ``AgentRuntime`` dependencies."""
    if not path:
        return {}
    spec = importlib.util.spec_from_file_location("agent_runtime_host_module", os.path.abspath(path))
    if spec is None or spec.loader is None:
        raise Error(f"Cannot load runtime module {path}.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    factory = getattr(module, "create_runtime", None)
    if not callable(factory):
        raise Error("A runtime module must define create_runtime(context).")
    return dict(factory(context) or {})  # pyright: ignore[reportCallIssue, reportReturnType, reportArgumentType]


def _runtime(manifest: JsonObject, config: JsonObject, host: JsonObject, dependencies: JsonObject) -> AgentRuntime:
    composed = compose_runtime(
        manifest,
        config,
        None,
        ComposeRuntimeOptions(model=host.get("model") is None, tools=host.get("tools") is None),
    )
    values: JsonObject = {
        "step_executors": [
            PromptStepExecutor(),
            LoopStepExecutor(),
            ApprovalStepExecutor(),
            CodeStepExecutor(),
            SubRunStepExecutor(),
        ],
        "condition_evaluator": JexlConditionEvaluator(),
    }
    for name in ("model", "tools", "workspaces", "run_sandbox"):
        value = getattr(composed, name)
        if value is not None:
            values[name] = value
    values.update({key: value for key, value in host.items() if key != "messages" and value is not None})
    values.update(dependencies)
    messages = MessagesOptions(compactor=PromptMessageHistoryCompactor())
    for option in (composed.messages, host.get("messages")):
        if option is not None:
            import dataclasses

            messages = dataclasses.replace(
                messages,
                **{
                    f.name: getattr(option, f.name)
                    for f in dataclasses.fields(option)
                    if getattr(option, f.name) is not None
                },
            )
    values["messages"] = messages
    return AgentRuntime(**values)


async def _validate(args: list[str], io: CliIo) -> None:
    parsed = parse_options(args, {"config"})
    file = os.path.abspath(_one_positional(parsed, "manifest path"))
    manifest = await FileAgentManifestSource(os.path.dirname(file), os.path.basename(file)).load_manifest()
    if parsed.options.get("config"):
        validate_runtime_configuration(manifest, await load_agent_runtime_config(parsed.options["config"]))
    report: JsonObject = {"valid": True, "schemaVersion": manifest["schemaVersion"]}
    for key in ("id", "name"):
        if manifest.get(key):
            report[key] = manifest[key]
    report["stepCount"] = len(manifest["steps"])
    io.stdout(_pretty(report))


async def _config(args: list[str], io: CliIo) -> None:
    if not args or args[0] != "validate":
        raise Error("Expected config validate <Agent Runtime config path>.")
    file = os.path.abspath(_one_positional(parse_options(args[1:], set()), "Agent Runtime config path"))
    config = await load_agent_runtime_config(file)
    report: JsonObject = {
        "valid": True,
        "version": config["version"],
        "providerCount": len(config["providers"]),
        "modelCount": len(config["models"]),
        "connectionCount": len(config["connections"]),
        "workspaceCount": len(config.get("workspaces") or {}),
    }
    if config.get("sandbox"):
        report["sandbox"] = config["sandbox"]["driver"]
    io.stdout(_pretty(report))


_RUN_OPTIONS = {
    "variables",
    "messages",
    "messages-scope",
    "messages-out",
    "max-total-tokens",
    "limits",
    "config",
    "run-id",
    "store",
    "store-driver",
    "events",
    "artifacts",
    "runtime-module",
    "format",
}


async def _run(command: str, args: list[str], io: CliIo) -> None:
    allowed = (
        _RUN_OPTIONS
        if command in ("run", "run-manifest")
        else {
            "max-total-tokens",
            "limits",
            "config",
            "store",
            "store-driver",
            "events",
            "artifacts",
            "runtime-module",
            "format",
        }
    )
    parsed = parse_options(args, allowed)
    output_format = parsed.options.get("format", "json")
    if output_format not in ("json", "pretty", "ndjson"):
        raise Error("--format must be json, pretty, or ndjson.")
    if command == "run-manifest":
        if "messages" in parsed.options:
            raise Error(
                "--messages cannot be combined with an agent run manifest; declare messages in the agent run manifest."
            )
        if any(name in parsed.options for name in ("variables", "run-id", "max-total-tokens", "limits")):
            raise Error(
                "--variables, --run-id, --max-total-tokens, and --limits cannot be combined with an agent run manifest; "
                "declare them in the agent run manifest or the agent manifest."
            )
    resolved = _open_store(_store_location(parsed))
    manifest_source: FileAgentManifestSource | None = None
    try:
        if command == "run-manifest":
            file = os.path.abspath(_one_positional(parsed, "agent run manifest path"))
            agent_run_manifest = await FileAgentRunManifestSource(
                os.path.dirname(file), os.path.basename(file)
            ).load_agent_run_manifest()
            manifest = await FileAgentManifestSource(os.path.dirname(file)).load_manifest(
                agent_run_manifest["agent"]["ref"]
            )
            manifest_source = FileAgentManifestSource(os.path.dirname(file))
            request = {"agentRunManifest": agent_run_manifest}
            if parsed.options.get("messages-scope"):
                request["messagesScope"] = parsed.options["messages-scope"]
        elif command == "resume":
            run_id = _one_positional(parsed, "run id")
            record = await resolved.store.load_run(run_id)
            if record is None:
                raise Error(f"Run {run_id} was not found.")
            manifest = record["manifest"]
            request: JsonObject = {"runId": run_id, "resume": True}
        else:
            file = os.path.abspath(_one_positional(parsed, "manifest path"))
            manifest = await FileAgentManifestSource(os.path.dirname(file), os.path.basename(file)).load_manifest()
            request = {"manifest": manifest}
            if parsed.options.get("run-id"):
                request["runId"] = parsed.options["run-id"]
            if parsed.options.get("variables"):
                request["variables"] = parse_agent_variable_overrides(_read_document(parsed.options["variables"]))
            if parsed.options.get("messages"):
                document = _read_document(parsed.options["messages"])
                messages = document.get("messages") if isinstance(document, dict) else document
                request["messages"] = messages
                if isinstance(document, dict) and document.get("signature"):
                    request["messagesSignature"] = document["signature"]
            if parsed.options.get("messages-scope"):
                request["messagesScope"] = parsed.options["messages-scope"]
        budget = _positive_integer_option(parsed, "max-total-tokens")
        if budget is not None:
            request["budget"] = {"maxTotalTokens": budget}
        if parsed.options.get("limits"):
            request["limits"] = parse(run_limits_schema, _read_document(parsed.options["limits"]))
        config = await resolve_agent_runtime_config(parsed.options.get("config"), os.getcwd())
        host = _load_runtime_module(
            parsed.options.get("runtime-module"), {"manifest": manifest, "storeDirectory": resolved.base_directory}
        )
        sinks: list[Any] = []
        events = parsed.options.get("events", os.path.join(resolved.base_directory, "events.jsonl"))
        if events != "none":
            sinks.append(JsonlEventSink(os.path.abspath(events)))
        if output_format == "ndjson":

            class _Stream:
                def emit(self, event: JsonObject) -> None:
                    io.stdout(f"{js_json.stringify({'type': 'event', 'event': event})}\n")

            sinks.append(_Stream())
        artifacts_directory = parsed.options.get("artifacts", resolved.base_directory)
        dependencies: JsonObject = {"run_store": resolved.store, "event_sinks": sinks}
        if command == "run-manifest":
            dependencies["agent_manifest_source"] = manifest_source
        if artifacts_directory != "none":
            dependencies["artifacts"] = FileArtifactStore(os.path.abspath(artifacts_directory))
        runtime = _runtime(manifest, config, host, dependencies)
        result = await runtime.run(request)
        if parsed.options.get("messages-out"):
            if not result.get("messages"):
                raise Error("--messages-out requires an agent manifest that declares messages.")
            document = {"messages": result["messages"]}
            if result.get("messagesSignature"):
                document["signature"] = result["messagesSignature"]
            path = os.path.abspath(parsed.options["messages-out"])
            Path(path).write_text(_pretty(document), encoding="utf-8")
            os.chmod(path, 0o600)
        if output_format == "ndjson":
            io.stdout(f"{js_json.stringify({'type': 'result', 'result': result})}\n")
        elif output_format == "pretty":
            output = result.get("output")
            if output is not None or "output" in result:
                io.stdout(f"{output if isinstance(output, str) else js_json.stringify(output, 2)}\n")
            io.stderr(
                f"run {result['runId']}: {len(result['stepResults'])} step(s), {len(result['artifacts'])} artifact(s)\n"
            )
        else:
            summary: JsonObject = {
                "runId": result["runId"],
                "status": "completed",
                "stepCount": len(result["stepResults"]),
                "artifactCount": len(result["artifacts"]),
            }
            if result.get("messages"):
                summary["messageCount"] = len(result["messages"])
                summary["messagesSigned"] = result.get("messagesSignature") is not None
            io.stdout(_pretty(summary))
    finally:
        resolved.close()


async def _inspect(args: list[str], io: CliIo) -> None:
    parsed = parse_options(args, {"store", "store-driver"})
    run_id = _one_positional(parsed, "run id")
    resolved = _open_store(_store_location(parsed))
    try:
        record = await resolved.store.load_run(run_id)
        if record is None:
            raise Error(f"Run {run_id} was not found.")
        checkpoint = await resolved.store.load_latest_checkpoint(run_id)
        report: JsonObject = {"run": record}
        if checkpoint is not None:
            report["checkpoint"] = checkpoint
        io.stdout(_pretty(report))
    finally:
        resolved.close()


async def _events(args: list[str], io: CliIo) -> None:
    parsed = parse_options(args, {"run", "type", "tail"})
    file = _one_positional(parsed, "events file")
    tail = _positive_integer_option(parsed, "tail")
    selected = []
    for line in Path(file).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        event = js_json.parse(line)
        if parsed.options.get("run") and event.get("runId") != parsed.options["run"]:
            continue
        if parsed.options.get("type") and event.get("type") != parsed.options["type"]:
            continue
        selected.append(event)
    for event in selected[-tail:] if tail else selected:
        io.stdout(f"{js_json.stringify(event)}\n")


def _assert_safe_inline_configuration(config: JsonObject) -> None:
    for name, definition in js_json.js_entries(config["providers"]):
        if definition.get("baseURL") is not None:
            raise Error(
                f'Inline worker configuration cannot define provider baseURL values; use a trusted configReference for provider "{name}".'
            )
    if config["connections"]:
        raise Error("Inline worker configuration cannot define MCP connections; use a trusted configReference.")
    if config.get("workspaces") or config.get("sandbox"):
        raise Error("Inline worker configuration cannot define workspaces or a sandbox; use a trusted configReference.")
    if (config.get("messages") or {}).get("signing"):
        raise Error("Inline worker configuration cannot define message signing keys; use a trusted configReference.")


async def execute_worker_invocation(
    invocation: JsonObject,
    *,
    store_directory: str,
    on_message: Callable[[JsonObject], Any],
    store_driver: str = "file",
    config_file: str | None = None,
    runtime_module: str | None = None,
    allow_request_configuration: bool = False,
    resolve_config_reference: Callable[[str, JsonObject], Any] | None = None,
    signal: Any = None,
) -> JsonObject:
    """Runs one provider-neutral worker invocation in this process (``executeWorkerInvocation``)."""
    request = invocation["request"]
    manifest = request["manifest"]
    location = os.path.abspath(store_directory)
    directory = os.path.dirname(location) if store_driver == "sqlite" else location
    if config_file:
        config = await load_agent_runtime_config(config_file)
    elif request.get("configuration"):
        if not allow_request_configuration:
            raise Error(
                "Worker request configuration requires allowRequestConfiguration and an explicit environment allowlist."
            )
        config = parse_agent_runtime_config(request["configuration"])
        _assert_safe_inline_configuration(config)
    elif request.get("configReference"):
        if resolve_config_reference is None:
            raise Error("Worker request configReference requires a host resolveConfigReference callback.")
        config = resolve_config_reference(request["configReference"], request)
        if asyncio.iscoroutine(config):
            config = await config
    else:
        config = await resolve_agent_runtime_config(None, os.getcwd())
    if request.get("runtimeReference") and not runtime_module:
        raise Error("Worker request runtimeReference requires a host resolveRuntimeReference callback.")
    host = _load_runtime_module(runtime_module, {"manifest": manifest, "storeDirectory": directory})
    store = _open_store(_Store(store_driver, location, directory))
    try:
        if invocation["action"] == "resume" and request.get("checkpoint"):
            if await store.store.load_run(request["runId"]) is None:
                checkpoint = request["checkpoint"]
                imported = dict(checkpoint)
                if checkpoint["sequence"] != 1:
                    imported.update(
                        {
                            "id": f"{checkpoint['id']}:imported",
                            "sequence": 1,
                            "metadata": {
                                **(checkpoint.get("metadata") or {}),
                                "importedCheckpointId": checkpoint["id"],
                                "importedCheckpointSequence": checkpoint["sequence"],
                            },
                        }
                    )
                await store.store.create_run(
                    {
                        "runId": request["runId"],
                        "manifest": manifest,
                        "status": "suspended",
                        "attempt": checkpoint.get("attempt") or request["attempt"] - 1,
                        "state": js_json.clone(imported["state"]),
                        "createdAt": imported["createdAt"],
                        "updatedAt": imported["createdAt"],
                    }
                )
                await store.store.save_checkpoint(imported)

        class _Sink:
            def emit(self, event: JsonObject) -> Any:
                return on_message({"protocolVersion": EXECUTION_PROTOCOL_VERSION, "type": "event", "event": event})

        runtime = _runtime(
            manifest,
            config,
            host,
            {"run_store": store.store, "event_sinks": [_Sink()], "artifacts": FileArtifactStore(directory)},
        )
        run: JsonObject = {"manifest": manifest}
        for key in ("runId", "execution", "budget"):
            if request.get(key):
                run[key] = request[key]
        if invocation["action"] == "run":
            for key in ("variables", "messages", "messagesSignature"):
                if request.get(key):
                    run[key] = request[key]
            if request.get("messagesScope") is not None:
                run["messagesScope"] = request["messagesScope"]
        else:
            run["resume"] = True
            if request.get("allowRunningTakeover"):
                run["allowRunningTakeover"] = True
        if signal is not None:
            run["signal"] = signal
        return await runtime.run(run)
    finally:
        store.close()


async def _worker(args: list[str], io: CliIo) -> bool:
    parsed = parse_options(args, {"store", "store-driver", "config", "runtime-module"})
    if parsed.positional:
        raise Error("The worker command reads its invocation from stdin.")

    def on_message(message: JsonObject) -> None:
        io.stdout(serialize_worker_message(message))

    try:
        resolved = _store_location(parsed, worker=True)
        source = sys.stdin.buffer.read(MAXIMUM_WORKER_INPUT_BYTES + 1)
        if len(source) > MAXIMUM_WORKER_INPUT_BYTES:
            raise Error("Worker invocation exceeds the input size limit.")
        invocation = parse_worker_invocation(source.decode("utf-8").strip())
        on_message({"protocolVersion": EXECUTION_PROTOCOL_VERSION, "type": "ready"})
        result = await execute_worker_invocation(
            invocation,
            store_directory=resolved.location,
            store_driver=resolved.driver,
            config_file=parsed.options.get("config"),
            runtime_module=parsed.options.get("runtime-module"),
            on_message=on_message,
        )
        on_message({"protocolVersion": EXECUTION_PROTOCOL_VERSION, "type": "result", "result": result})
        return True
    except Exception as error:
        on_message(
            {
                "protocolVersion": EXECUTION_PROTOCOL_VERSION,
                "type": "error",
                "error": {"code": "WORKER_EXECUTION_FAILED", "message": error_message(error), "retryable": False},
            }
        )
        return False


async def run_cli(argv: list[str], io: CliIo | None = None) -> int:
    io = io or CliIo()
    command, *args = argv or ["help"]
    if command in ("help", "--help", "-h"):
        io.stdout(USAGE)
        return 0
    try:
        if command == "validate":
            await _validate(args, io)
        elif command == "config":
            await _config(args, io)
        elif command in ("run", "run-manifest", "resume"):
            await _run(command, args, io)
        elif command == "inspect":
            await _inspect(args, io)
        elif command == "events":
            await _events(args, io)
        elif command == "worker":
            return 0 if await _worker(args, io) else 1
        else:
            io.stderr(f"Unknown command: {command}\n\n{USAGE}")
            return 2
        return 0
    except Exception as error:
        io.stderr(f"Error: {error_message(error)}\n")
        return 1


def main() -> None:
    sys.exit(asyncio.run(run_cli(sys.argv[1:])))


if __name__ == "__main__":
    main()
