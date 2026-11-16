"""``LoopStepExecutor`` (``@clearideas/agent-runtime-step-loop``)."""

from __future__ import annotations

import copy
import re
from typing import Any

from .._js import json as js_json
from .._js import strings as js_strings
from .._js.errors import Error
from .._js.ops import UNDEFINED
from .._js.regex import WS
from ..core import apply_state_patch, child_execution_key, set_variable_at_path, without_messages_view
from ..core.errors import create_limit_suspension

JsonObject = dict[str, Any]
_TEMPLATE_EDGES = re.compile(r"^\{\{" + WS + r"*|" + WS + r"*\}\}$")


def _get_nested(state: JsonObject, raw_path: str) -> Any:
    path = _TEMPLATE_EDGES.sub("", js_strings.trim(raw_path))
    current: Any = state
    for segment in path.split("."):
        if not isinstance(current, dict):
            return UNDEFINED
        lower = js_strings.lower(segment)
        key = next((candidate for candidate in js_json.js_keys(current) if js_strings.lower(candidate) == lower), None)
        if key is None:
            return UNDEFINED
        current = current[key]
    return current


def _parse_items(
    source: str | None, delimiter: str | None, variables: JsonObject, max_iterations: int | None
) -> tuple[list[Any], bool]:
    if not source or not js_strings.trim(source):
        return list(range(1 if max_iterations is None else max_iterations)), False
    value = _get_nested(variables, source)
    if value is UNDEFINED and "{{" not in source:
        value = variables.get(source, UNDEFINED)
    if isinstance(value, str):
        try:
            value = js_json.parse(value)
        except ValueError:
            parts = (js_strings.trim(item) for item in value.split(delimiter if delimiter is not None else "\n"))
            return [item for item in parts if item], False
    if isinstance(value, list):
        return copy.deepcopy(value), True
    if isinstance(value, dict):
        nested = next((item for _, item in js_json.js_entries(value) if isinstance(item, list)), None)
        if nested is not None:
            return copy.deepcopy(nested), True
    return [], False


def _serialize_output(value: Any) -> str:
    return value if isinstance(value, str) else js_json.stringify(value)


def _is_loop_continuation(value: Any, step_id: str) -> bool:
    return (
        isinstance(value, dict)
        and value.get("type") == "loop"
        and value.get("stepId") == step_id
        and _is_number(value.get("iterationIndex"))
        and _is_number(value.get("childIndex"))
        and isinstance(value.get("outputs"), list)
        and ("child" not in value or _is_child_frame(value["child"]))
    )


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_child_frame(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("state"), dict)
        and (value.get("continuation") is None or isinstance(value.get("continuation"), dict))
        and isinstance(value.get("transcriptCount"), int)
        and value["transcriptCount"] >= 0
        and isinstance(value.get("artifactCount"), int)
        and value["artifactCount"] >= 0
    )


def _split_tail(items: list[Any], count: int) -> tuple[list[Any], list[Any]]:
    return (items[:-count], items[-count:]) if 0 < count <= len(items) else (items, [])


def _snapshot_iteration_variables(manifest: JsonObject, state: JsonObject) -> JsonObject:
    result = without_messages_view(manifest, copy.deepcopy(state))
    result.pop("loop", None)
    return result


def _variable_base(path: str) -> str:
    return js_strings.lower(js_strings.trim(path.split(".")[0]))


def _result_variable_produced_by_children(step: JsonObject) -> bool:
    result_base = _variable_base(step["loop"].get("resultVariable") or "")
    if not result_base:
        return False
    return any(_variable_base(child.get("outputVariable") or "") == result_base for child in step["steps"])


def _continuation(
    *,
    step_id: str,
    iteration_index: int,
    child_index: int,
    outputs: list[Any],
    previous: Any,
    last_output: Any,
    finished: bool,
    goal_met: bool,
    goal_met_at_iteration: int | None,
) -> JsonObject:
    return {
        "type": "loop",
        "stepId": step_id,
        "iterationIndex": iteration_index,
        "childIndex": child_index,
        "outputs": copy.deepcopy(outputs),
        "previous": copy.deepcopy(previous),
        "lastOutput": copy.deepcopy(last_output),
        "finished": finished,
        "goalMet": goal_met,
        "goalMetAtIteration": goal_met_at_iteration,
    }


class LoopStepExecutor:
    type = "loop"

    async def execute(self, context: Any) -> JsonObject:
        if context.execute_child is None or context.checkpoint is None:
            raise Error("LoopStepExecutor requires Agent Runtime child execution and checkpoint support")
        execute_child = context.execute_child
        checkpoint = context.checkpoint
        evaluate_condition = context.evaluate_condition
        step = context.step
        step_path = context.step_path or step["id"]
        config = step["loop"]
        prefer_result_variable = _result_variable_produced_by_children(step)
        if (config.get("condition") or config.get("goal")) and evaluate_condition is None:
            raise Error("Loop conditions and goals require a ConditionEvaluator")
        items, structured = _parse_items(
            config.get("source"), config.get("delimiter"), context.variables, config.get("maxIterations")
        )
        max_iterations = config.get("maxIterations")
        iteration_limit = min(len(items), len(items) if max_iterations is None else max_iterations)
        resume = context.resume or {}
        restored = resume.get("continuation") if _is_loop_continuation(resume.get("continuation"), step["id"]) else None
        if resume.get("continuation") and restored is None:
            await context.emit(
                "diagnostic",
                {
                    "code": "LOOP_RESUME_STATE_UNRECOGNIZED",
                    "message": "The loop's saved position was not recognized; it restarts from its first iteration.",
                },
            )
        restored = restored or {}
        state = copy.deepcopy(context.variables)
        outputs: list[Any] = copy.deepcopy(restored.get("outputs") or [])
        previous = copy.deepcopy(restored.get("previous"))
        last_output = copy.deepcopy(restored.get("lastOutput"))
        start_iteration = restored.get("iterationIndex", 0)
        start_child = restored.get("childIndex", 0)
        goal_met = restored.get("goalMet", False)
        goal_met_at_iteration = restored.get("goalMetAtIteration")
        resuming_child = copy.deepcopy(restored.get("child"))
        transcript, child_transcript = _split_tail(
            copy.deepcopy(resume.get("transcript") or []) if restored else [],
            (resuming_child or {}).get("transcriptCount", 0),
        )
        artifacts, child_artifacts = _split_tail(
            copy.deepcopy(resume.get("artifacts") or []) if restored else [],
            (resuming_child or {}).get("artifactCount", 0),
        )
        end_run = False

        def snapshot(iteration_index: int, child_index: int, finished: bool) -> JsonObject:
            return _continuation(
                step_id=step["id"],
                iteration_index=iteration_index,
                child_index=child_index,
                outputs=outputs,
                previous=previous,
                last_output=last_output,
                finished=finished,
                goal_met=goal_met,
                goal_met_at_iteration=goal_met_at_iteration,
            )

        if not restored.get("finished"):
            iteration = start_iteration
            while iteration < iteration_limit:
                iteration_ceiling = (context.limits or {}).get("maxLoopIterations")
                if iteration_ceiling is not None and iteration >= iteration_ceiling:
                    raise create_limit_suspension(
                        limit="maxLoopIterations", used=iteration, value=iteration_ceiling, step_id=step["id"]
                    )
                resuming_iteration = iteration == start_iteration and (start_child > 0 or resuming_child is not None)
                local = copy.deepcopy(state)
                if not resuming_iteration:
                    set_variable_at_path(
                        local,
                        config.get("itemVariable") or "item",
                        copy.deepcopy(items[iteration] if iteration < len(items) else None),
                    )
                    set_variable_at_path(local, config.get("indexVariable") or "index", str(iteration))
                    local["loop"] = {
                        "index": iteration,
                        "iteration": iteration + 1,
                        "outputs": copy.deepcopy(outputs),
                        "previous": copy.deepcopy(previous),
                    }
                    await context.emit("loop.iteration.started", {"iteration": iteration + 1, "sourceIndex": iteration})
                    if config.get("condition") and not await evaluate_condition(config["condition"], local):
                        await context.emit(
                            "loop.iteration.skipped", {"iteration": iteration + 1, "sourceIndex": iteration}
                        )
                        await checkpoint(
                            {
                                "state": state,
                                "cursor": {
                                    "stepId": step["id"],
                                    "stepPath": step_path,
                                    "loopIteration": iteration + 1,
                                    "childIndex": 0,
                                },
                                "continuation": snapshot(iteration + 1, 0, iteration + 1 >= iteration_limit),
                                "transcript": transcript,
                                "artifacts": artifacts,
                            }
                        )
                        start_child = 0
                        iteration += 1
                        continue
                child_start = start_child if resuming_iteration else 0
                for child_index in range(child_start, len(step["steps"])):
                    child = step["steps"][child_index]
                    child_path = f"{step_path}/{child['id']}"
                    resumed = resuming_child if resuming_iteration and child_index == child_start else None
                    resuming_child = None
                    child_start_state = copy.deepcopy(local)

                    def frame_checkpoint(
                        nested: JsonObject,
                        child_start_state: JsonObject = child_start_state,
                        child_id: str = child["id"],
                        child_path: str = child_path,
                        iteration: int = iteration,
                        child_index: int = child_index,
                    ) -> JsonObject:
                        return {
                            "state": child_start_state,
                            "cursor": {
                                "stepId": child_id,
                                "stepPath": child_path,
                                "loopIteration": iteration + 1,
                                "childIndex": child_index,
                                **(nested.get("cursor") or {}),
                            },
                            "continuation": {
                                **snapshot(iteration, child_index, False),
                                "child": {
                                    "state": copy.deepcopy(nested["state"]),
                                    "continuation": copy.deepcopy(nested.get("continuation")),
                                    "transcriptCount": len(nested.get("transcript") or []),
                                    "artifactCount": len(nested.get("artifacts") or []),
                                },
                            },
                            "transcript": [*transcript, *(nested.get("transcript") or [])],
                            "artifacts": [*artifacts, *(nested.get("artifacts") or [])],
                            **({"boundary": nested["boundary"]} if nested.get("boundary") else {}),
                        }

                    frame: JsonObject = {"key": str(iteration), "checkpoint": frame_checkpoint}
                    if resumed is not None:
                        frame["resume"] = {
                            **({"continuation": resumed["continuation"]} if resumed.get("continuation") else {}),
                            "transcript": child_transcript,
                            "artifacts": child_artifacts,
                        }
                    result = await execute_child(
                        child, copy.deepcopy(resumed["state"]) if resumed is not None else local, child_path, frame
                    )
                    local = apply_state_patch(local, result.get("statePatch"))
                    transcript.extend(result.get("transcript") or [])
                    artifacts.extend(result.get("artifacts") or [])
                    if "output" in result:
                        last_output = copy.deepcopy(result["output"])
                    if result.get("endRun") is True:
                        end_run = True
                        break
                    next_index = child_index + 1
                    next_child = step["steps"][next_index] if next_index < len(step["steps"]) else None
                    await checkpoint(
                        {
                            "boundary": {
                                "stepPath": child_path,
                                "executionKey": child_execution_key(
                                    context.execution_key or step_path, child["id"], {"key": str(iteration)}
                                ),
                            },
                            "state": local,
                            "cursor": {
                                "stepId": next_child["id"] if next_child else step["id"],
                                "stepPath": f"{step_path}/{next_child['id']}" if next_child else step_path,
                                "loopIteration": iteration + 1,
                                "childIndex": next_index,
                            },
                            "continuation": snapshot(iteration, next_index, False),
                            "transcript": transcript,
                            "artifacts": artifacts,
                        }
                    )
                result_value: Any = last_output
                if config.get("resultVariable") and prefer_result_variable:
                    found = _get_nested(local, config["resultVariable"])
                    result_value = last_output if found is UNDEFINED or found is None else found
                normalized = copy.deepcopy(result_value)
                if config.get("resultVariable"):
                    set_variable_at_path(local, config["resultVariable"], normalized)
                outputs.append(normalized)
                completed = {
                    "index": iteration,
                    "iteration": iteration + 1,
                    "output": copy.deepcopy(normalized),
                    "variables": _snapshot_iteration_variables(context.manifest, local),
                }
                local["loop"] = {
                    "index": iteration,
                    "iteration": iteration + 1,
                    "outputs": copy.deepcopy(outputs),
                    "previous": copy.deepcopy(previous),
                    "current": copy.deepcopy(completed),
                }
                state = local
                previous = completed
                if config.get("goal") and await evaluate_condition(config["goal"], state):
                    goal_met = True
                    goal_met_at_iteration = iteration + 1
                    await context.emit("loop.goal.met", {"iteration": iteration + 1})
                await context.emit("loop.iteration.completed", {"iteration": iteration + 1, "sourceIndex": iteration})
                finished = end_run or goal_met or iteration + 1 >= iteration_limit
                await checkpoint(
                    {
                        "state": state,
                        "cursor": {
                            "stepId": step["id"],
                            "stepPath": step_path,
                            "loopIteration": iteration + 1,
                            "childIndex": 0,
                        },
                        "continuation": snapshot(iteration + 1, 0, finished),
                        "transcript": transcript,
                        "artifacts": artifacts,
                    }
                )
                start_child = 0
                if goal_met or end_run:
                    break
                iteration += 1

        if config.get("outputMode") == "final":
            output: Any = copy.deepcopy(outputs[-1] if outputs else None)
        elif structured:
            output = copy.deepcopy(outputs)
        else:
            output = "\n\n".join(_serialize_output(item) for item in outputs)
        if step.get("outputVariable"):
            set_variable_at_path(state, step["outputVariable"], output)
        existing_loop = state.get("loop") if isinstance(state.get("loop"), dict) else {}
        state["loop"] = {
            **existing_loop,  # pyright: ignore[reportGeneralTypeIssues]
            "outputs": copy.deepcopy(outputs),
            "goalMet": goal_met,
            "goalMetAtIteration": goal_met_at_iteration,
        }
        result: JsonObject = {
            "output": output,
            "statePatch": {"set": state},
            "transcript": transcript,
            "artifacts": artifacts,
        }
        if end_run:
            result["endRun"] = True
        result["metadata"] = {
            "iterations": len(outputs),
            "outputMode": config.get("outputMode") or "array",
            "goalMet": goal_met,
            "goalMetAtIteration": goal_met_at_iteration,
        }
        return result
