"""Deterministic corpus generators shared by interop tests."""

from __future__ import annotations

import copy
import random
from typing import Any

from clearideas_agent_runtime._js import yaml

from .conftest import REPOSITORY

WRONG_VALUES: list[Any] = [
    None,
    True,
    False,
    0,
    -1,
    1.5,
    2.0,
    1e30,
    11,
    "",
    "  padded  ",
    "a.b",
    "__proto__",
    "messages",
    "x" * 101,
    "BAD_alias",
    [],
    {},
    ["x"],
    [1, "b", None],
    {"k": "v"},
    {"type": "nope"},
    "nope",
    "https://ok.example",
    "not a url",
    "2024-01-02T03:04:05Z",
]


def repository_manifests() -> list[dict[str, Any]]:
    manifests = []
    for path in sorted(REPOSITORY.glob("**/*.agent.y*ml")) + sorted(REPOSITORY.glob("**/*.agent.json")):
        if any(part in ("node_modules", ".venv") for part in path.parts):
            continue
        document = yaml.parse(path.read_text())
        if isinstance(document, dict) and "steps" in document:
            manifests.append(document)
    return manifests


RICH_MANIFESTS: list[dict[str, Any]] = [
    {
        "schemaVersion": "1.0",
        "id": "rich",
        "name": "Rich",
        "description": "d",
        "model": {
            "provider": "openai",
            "model": "gpt-5",
            "options": {"openai": {"reasoningEffort": "low"}},
        },
        "variables": [
            {
                "key": "topic",
                "type": "string",
                "value": "x",
                "description": "d",
                "requiresOverride": False,
            },
            {"key": "n", "type": "number", "value": 3},
            {"key": "cfg", "type": "object", "value": {"a": 1}},
            {"key": "list", "type": "array", "value": [1]},
            {"key": "doc", "type": "json", "value": {"b": [1]}},
        ],
        "connections": [
            {
                "ref": "docs",
                "alias": "docs-api",
                "tools": ["search"],
                "mode": "read",
                "required": True,
            }
        ],
        "workspaces": [{"ref": "repo", "alias": "code", "tools": ["read_file"], "mode": "read_write"}],
        "messages": {
            "required": False,
            "description": "chat",
            "maxMessages": 20,
            "maxBytes": 4096,
            "requireSignature": False,
            "context": {
                "strategy": "summarize",
                "summarizer": {"model": {"ref": "fast"}, "maxOutputTokens": 200},
            },
            "markers": {"summary": "S", "note": "N"},
        },
        "steps": [
            {
                "id": "draft",
                "type": "prompt",
                "prompt": "Write {{topic}}",
                "systemPrompt": "Brief",
                "outputVariable": "draft",
                "maxOutputTokens": 100,
                "tools": ["a", "b"],
                "completionPolicy": {"onTruncation": "fail", "requireOutput": True},
                "history": {"last": 4, "summary": True, "insert": True, "media": "latest"},
                "policies": {
                    "toolCallLimit": "fail",
                    "modelRetry": {"maxAttempts": 3, "initialDelayMs": 10, "maxDelayMs": 100},
                    "outputRepair": {"maxAttempts": 1},
                    "context": {
                        "strategy": "prune",
                        "trigger": {"inputBytes": 1000, "contextRatio": 0.5, "toolRounds": 3},
                        "retain": {"recentToolRounds": 2},
                        "reduceTo": 0.25,
                        "openingShare": 0.5,
                        "maxCompactions": 2,
                        "overflowRetries": 3,
                        "maxToolResultBytes": 500,
                        "toolResultShare": 0.4,
                        "variables": {
                            "topic": {"keep": True},
                            "cfg.a": {"strategy": "prune", "maxBytes": 100},
                        },
                        "summarizer": {
                            "minSummaryBytes": 256,
                            "maxSummaryBytes": 1024,
                            "chunkBytes": 2048,
                            "summaryShare": 0.3,
                            "maxCalls": 4,
                            "maxPasses": 2,
                            "prompts": {
                                "input": "i",
                                "transcript": "t",
                                "toolResult": "r",
                                "messages": "m",
                            },
                        },
                    },
                },
                "metadata": {"k": 1},
                "extensions": {"x": {}},
            },
            {"id": "chat", "type": "prompt", "history": "all", "systemPrompt": "Hi"},
            {
                "id": "rich",
                "type": "prompt",
                "messages": [
                    {"role": "system", "content": [{"type": "text", "text": "s"}]},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "u"},
                            {"type": "image", "url": "https://x/y.png", "mediaType": "image/png"},
                            {
                                "type": "file",
                                "data": "aGk=",
                                "mediaType": "text/plain",
                                "name": "a.txt",
                            },
                        ],
                    },
                    {
                        "role": "assistant",
                        "content": [
                            {"type": "reasoning", "text": "r"},
                            {
                                "type": "tool-call",
                                "call": {"id": "c1", "name": "t", "input": {"q": 1}},
                            },
                        ],
                    },
                    {
                        "role": "tool",
                        "content": [
                            {
                                "type": "tool-result",
                                "result": {"callId": "c1", "name": "t", "output": {"ok": True}},
                            }
                        ],
                    },
                ],
            },
            {
                "id": "check",
                "type": "approval",
                "prompt": "ok?",
                "action": "pause",
                "onReject": "continue",
                "when": "draft != null",
                "policies": {"onError": "continue"},
            },
            {
                "id": "each",
                "type": "loop",
                "loop": {
                    "source": "list",
                    "delimiter": ",",
                    "itemVariable": "item",
                    "indexVariable": "i",
                    "condition": "item",
                    "goal": "done",
                    "outputMode": "array",
                    "resultVariable": "results",
                    "maxIterations": 5,
                },
                "steps": [
                    {
                        "id": "inner",
                        "type": "prompt",
                        "prompt": "{{item}}",
                        "model": {"ref": "fast"},
                    }
                ],
            },
            {
                "id": "hook",
                "type": "webhook",
                "url": "https://example.com/hook",
                "method": "POST",
                "headers": {"x-a": "b"},
                "body": {"k": [1, 2]},
                "timeoutMs": 1000,
                "retries": 2,
                "idempotencyKey": "k",
            },
            {
                "id": "sub",
                "type": "sub-run",
                "manifestRef": "child",
                "variableMappings": {"a": "b"},
            },
            {
                "id": "inline",
                "type": "sub-run",
                "manifest": {
                    "schemaVersion": "1.0",
                    "steps": [{"id": "x", "type": "approval", "prompt": "p"}],
                },
            },
            {
                "id": "run",
                "type": "code",
                "language": "python",
                "code": "print(1)",
                "timeoutMs": 500,
                "environment": {"A": "1"},
                "workspaces": ["code"],
                "sandbox": "run",
            },
        ],
        "policies": {"onError": "fail", "context": {"strategy": "summarize-or-prune"}},
        "limits": {
            "maxSteps": 20,
            "maxMessagesPerPrompt": 10,
            "maxInputBytes": 1000,
            "maxOutputBytes": 100,
            "maxToolCallsPerIteration": 5,
            "providerTimeoutMs": 100,
        },
        "metadata": {"team": "x"},
        "extensions": {"agentRuntime": {"stateProjection": "x"}},
    },
]


def _paths(value: Any, path: tuple[Any, ...] = ()):
    yield path
    if isinstance(value, dict):
        for key, item in value.items():
            yield from _paths(item, (*path, key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _paths(item, (*path, index))


def _parent(document: Any, path: tuple[Any, ...]) -> Any:
    for segment in path[:-1]:
        document = document[segment]
    return document


def mutate(document: Any, rng: random.Random) -> Any:
    paths = [path for path in _paths(document) if path]
    if not paths:
        return rng.choice(WRONG_VALUES)
    path = rng.choice(paths)
    parent, key = _parent(document, path), path[-1]
    choice = rng.random()
    if choice < 0.15 and isinstance(parent, dict):
        del parent[key]
    elif choice < 0.24 and isinstance(parent, dict):
        parent[rng.choice(["zzUnknown", "aaUnknown", "extra"])] = 1
    elif choice < 0.3 and isinstance(parent, list) and parent:
        parent.append(copy.deepcopy(rng.choice(parent)))
    elif choice < 0.34 and isinstance(parent, list) and parent:
        parent.insert(0, copy.deepcopy(rng.choice(WRONG_VALUES)))
    elif (
        choice < 0.38
        and isinstance(parent, dict)
        and parent.get("type") in ("approval", "code", "webhook", "sub-run", "loop")
    ):
        parent["policies"] = {
            rng.choice(["toolCallLimit", "modelRetry", "outputRepair", "context", "onError"]): rng.choice(
                ["fail", {}, "continue"]
            )
        }
    elif choice < 0.42 and isinstance(parent, dict) and parent.get("type") == "prompt":
        parent["messages"] = rng.choice(
            [
                [],
                [{"role": "user", "content": "hi"}],
                [{"role": "system", "content": [{"type": "image", "url": "u"}]}],
            ]
        )
    elif choice < 0.46 and isinstance(parent, dict) and "id" in parent:
        parent["history"] = rng.choice(["all", "some", {"last": 0}, {"insert": True}, {"media": "all"}])
    else:
        parent[key] = copy.deepcopy(rng.choice(WRONG_VALUES))
    return document


def mutated(bases: list[Any], seed: int, count: int) -> list[Any]:
    rng = random.Random(seed)
    corpus = [copy.deepcopy(base) for base in bases]
    for _ in range(count):
        document = copy.deepcopy(rng.choice(bases))
        for _ in range(rng.choice([1, 1, 1, 2, 3])):
            document = mutate(document, rng)
        corpus.append(document)
    return corpus


def conversation_histories() -> list[Any]:
    marker = {
        "agentRuntime": {
            "messages": {
                "kind": "summary",
                "replaces": 4,
                "turns": 2,
                "sequence": 1,
                "strategy": "summarize",
            }
        }
    }
    return [
        [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": [{"type": "text", "text": "hi"}]},
        ],
        [
            {"role": "assistant", "content": "summary", "metadata": marker},
            {"role": "user", "content": [{"type": "json", "value": {"a": 1}}]},
        ],
        [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "artifact": {"id": "a", "name": "n", "mediaType": "image/png"},
                    },
                    {
                        "type": "file",
                        "url": "https://x/f.pdf",
                        "mediaType": "application/pdf",
                        "name": "f.pdf",
                    },
                ],
            }
        ],
        [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "data": "aGk=",
                        "mediaType": "image/png",
                        "metadata": {"m": 1},
                    }
                ],
            }
        ],
    ]


def checkpoints() -> list[Any]:
    item = {
        "id": "t1",
        "type": "message",
        "role": "assistant",
        "content": [{"type": "text", "text": "x"}],
        "createdAt": "2024-01-02T03:04:05.000Z",
        "model": "m",
        "usage": {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3},
    }
    return [
        {
            "id": "checkpoint_1",
            "runId": "run_1",
            "sequence": 1,
            "attempt": 1,
            "manifestHash": "sha256:x",
            "contractVersion": "1.0",
            "runtimeVersion": "0.9.0",
            "cursor": {
                "stepIndex": 1,
                "stepId": "a",
                "stepPath": "a",
                "loopIteration": 0,
                "childIndex": 0,
            },
            "state": {"a": 1, "b": {"c": [1]}},
            "stepResults": [
                {
                    "stepId": "a",
                    "stepIndex": 0,
                    "status": "completed",
                    "output": "x",
                    "variables": {"a": 1},
                    "transcript": [item],
                    "artifacts": [
                        {
                            "id": "art",
                            "name": "n",
                            "mediaType": "text/plain",
                            "size": 1,
                            "sha256": "ab",
                        }
                    ],
                    "usage": {"inputTokens": 1},
                    "completedAt": "2024-01-02T03:04:05.000Z",
                }
            ],
            "transcript": [item],
            "artifacts": [],
            "activeStepTranscript": [],
            "activeStepArtifacts": [],
            "continuation": {"k": 1},
            "budget": {"maxTotalTokens": 10, "consumedTokens": 3},
            "messages": {
                "history": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
                "compaction": "complete",
                "signedCount": 0,
                "scope": "s",
                "journal": {},
            },
            "createdAt": "2024-01-02T03:04:05.000+02:00",
            "metadata": {"m": 1},
        }
    ]


def run_manifests() -> list[Any]:
    return [
        {
            "schemaVersion": "1.0",
            "agent": {"ref": " hello "},
            "runId": " r1 ",
            "variables": [{"key": "topic", "value": "x"}, {"key": "n", "value": 2}],
            "execution": {"mode": "parallel", "maxConcurrency": 4},
            "budget": {"maxTotalTokens": 1000},
            "messages": [{"role": "user", "content": "hi"}],
            "messagesSignature": {
                "version": "1",
                "algorithm": "HMAC-SHA256",
                "keyId": "k",
                "count": 0,
                "value": "abc_-",
            },
        },
        {
            "schemaVersion": "1.0",
            "agent": {"ref": "x"},
            "variables": [{"key": "a", "value": 1}, {"key": "A", "value": 2}],
        },
    ]
