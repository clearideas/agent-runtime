import type {
  AgentManifest,
  ArtifactRef,
  JsonObject,
  JsonValue,
  LoopStep,
  TranscriptItem,
  VariableState,
} from "@clearideas/agent-runtime-contracts";
import {
  applyStatePatch,
  childExecutionKey,
  createLimitSuspension,
  setVariableAtPath,
  withoutMessagesView,
  type ChildExecutionFrame,
  type NestedCheckpointInput,
  type StepExecutionContext,
  type StepExecutionResult,
  type StepExecutor,
} from "@clearideas/agent-runtime-core";

/**
 * A child that was mid-step when the loop checkpointed: its continuation,
 * its variables, and how many trailing transcript items and artifacts of the
 * loop's checkpoint belong to it.
 */
interface LoopChildFrame extends JsonObject {
  state: VariableState;
  continuation: JsonObject | null;
  transcriptCount: number;
  artifactCount: number;
}

interface LoopContinuation extends JsonObject {
  type: "loop";
  stepId: string;
  iterationIndex: number;
  childIndex: number;
  outputs: JsonValue[];
  previous: JsonObject | null;
  lastOutput: JsonValue | null;
  finished: boolean;
  goalMet: boolean;
  goalMetAtIteration: number | null;
  /** Present when the child at childIndex was mid-step. */
  child?: LoopChildFrame;
}

const clone = <T>(value: T): T => structuredClone(value);

const asObject = (value: JsonValue | undefined): JsonObject | undefined =>
  value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

const getNested = (
  state: Readonly<VariableState>,
  rawPath: string,
): JsonValue | undefined => {
  const path = rawPath.trim().replace(/^\{\{\s*|\s*\}\}$/g, "");
  let current: unknown = state;
  for (const segment of path.split(".")) {
    if (
      current == null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    const record = current as Record<string, JsonValue>;
    const lower = segment.toLowerCase();
    const key = Object.keys(record).find(
      (candidate) => candidate.toLowerCase() === lower,
    );
    if (!key) return undefined;
    current = record[key];
  }
  return current as JsonValue | undefined;
};

const parseItems = (
  source: string | undefined,
  delimiter: string | undefined,
  variables: Readonly<VariableState>,
  maxIterations: number | undefined,
): { items: JsonValue[]; structured: boolean } => {
  if (!source?.trim()) {
    return {
      items: Array.from({ length: maxIterations ?? 1 }, (_, index) => index),
      structured: false,
    };
  }
  let value = getNested(variables, source);
  if (value === undefined && !source.includes("{{")) value = variables[source];
  if (typeof value === "string") {
    const sourceText = value;
    try {
      value = JSON.parse(sourceText) as JsonValue;
    } catch {
      return {
        items: sourceText
          .split(delimiter ?? "\n")
          .map((item) => item.trim())
          .filter(Boolean),
        structured: false,
      };
    }
  }
  if (Array.isArray(value)) return { items: clone(value), structured: true };
  if (value && typeof value === "object") {
    const nestedArray = Object.values(value).find(Array.isArray);
    if (nestedArray) return { items: clone(nestedArray), structured: true };
  }
  return { items: [], structured: false };
};

const serializeOutput = (value: JsonValue): string =>
  typeof value === "string" ? value : JSON.stringify(value);

const isCount = (value: JsonValue | undefined): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isChildFrame = (value: JsonValue | undefined): boolean => {
  const frame = asObject(value);
  return (
    frame !== undefined &&
    asObject(frame.state) !== undefined &&
    (frame.continuation === null ||
      asObject(frame.continuation) !== undefined) &&
    isCount(frame.transcriptCount) &&
    isCount(frame.artifactCount)
  );
};

const isLoopContinuation = (
  value: JsonObject | undefined,
  stepId: string,
): value is LoopContinuation =>
  value?.type === "loop" &&
  value.stepId === stepId &&
  typeof value.iterationIndex === "number" &&
  typeof value.childIndex === "number" &&
  Array.isArray(value.outputs) &&
  (value.child === undefined || isChildFrame(value.child));

/** Split a restored list into the loop's own items and its child's tail. */
const splitTail = <T>(items: T[], count: number): [T[], T[]] =>
  count > 0 && count <= items.length
    ? [items.slice(0, items.length - count), items.slice(items.length - count)]
    : [items, []];

/** An iteration's variables for `loop.previous`, without runtime-provided views. */
const snapshotIterationVariables = (
  manifest: AgentManifest,
  state: VariableState,
): VariableState => {
  const result = withoutMessagesView(manifest, clone(state));
  delete result.loop;
  return result;
};

const variableBase = (path: string): string =>
  path.split(".")[0]?.trim().toLowerCase() ?? "";

/**
 * A result variable is an input/output accumulator only when a child writes
 * that variable. Otherwise it receives the current iteration's final child
 * output. This prevents a value written by the previous iteration from being
 * mistaken for the current result.
 */
const resultVariableProducedByChildren = (step: LoopStep): boolean => {
  const resultBase = variableBase(step.loop.resultVariable ?? "");
  if (!resultBase) return false;
  return step.steps.some(
    (child) => variableBase(child.outputVariable ?? "") === resultBase,
  );
};

const continuation = (input: {
  stepId: string;
  iterationIndex: number;
  childIndex: number;
  outputs: JsonValue[];
  previous: JsonObject | null;
  lastOutput: JsonValue | null;
  finished: boolean;
  goalMet: boolean;
  goalMetAtIteration: number | null;
}): LoopContinuation => ({
  type: "loop",
  stepId: input.stepId,
  iterationIndex: input.iterationIndex,
  childIndex: input.childIndex,
  outputs: clone(input.outputs),
  previous: clone(input.previous),
  lastOutput: clone(input.lastOutput),
  finished: input.finished,
  goalMet: input.goalMet,
  goalMetAtIteration: input.goalMetAtIteration,
});

export class LoopStepExecutor implements StepExecutor<LoopStep> {
  readonly type = "loop" as const;

  async execute(
    context: StepExecutionContext & { step: LoopStep },
  ): Promise<StepExecutionResult> {
    if (!context.executeChild || !context.checkpoint) {
      throw new Error(
        "LoopStepExecutor requires Agent Runtime child execution and checkpoint support",
      );
    }
    const executeChild = context.executeChild;
    const checkpoint = context.checkpoint;
    const evaluateCondition = context.evaluateCondition;
    const stepPath = context.stepPath ?? context.step.id;
    const config = context.step.loop;
    const preferResultVariable = resultVariableProducedByChildren(context.step);
    if ((config.condition || config.goal) && !evaluateCondition) {
      throw new Error("Loop conditions and goals require a ConditionEvaluator");
    }
    const parsedItems = parseItems(
      config.source,
      config.delimiter,
      context.variables,
      config.maxIterations,
    );
    const items = parsedItems.items;
    const iterationLimit = Math.min(
      items.length,
      config.maxIterations ?? items.length,
    );
    const restored = isLoopContinuation(
      context.resume?.continuation,
      context.step.id,
    )
      ? context.resume.continuation
      : undefined;
    if (context.resume?.continuation && !restored) {
      // Checkpoints written before loops framed their children hold a child's
      // continuation in place of the loop's; the loop cannot tell where it was.
      await context.emit("diagnostic", {
        code: "LOOP_RESUME_STATE_UNRECOGNIZED",
        message:
          "The loop's saved position was not recognized; it restarts from its first iteration.",
      });
    }
    let state = clone(context.variables as VariableState);
    const outputs: JsonValue[] = clone(restored?.outputs ?? []);
    let previous = clone(restored?.previous ?? null);
    let lastOutput = clone(restored?.lastOutput ?? null);
    let startIteration = restored?.iterationIndex ?? 0;
    let startChild = restored?.childIndex ?? 0;
    let goalMet = restored?.goalMet ?? false;
    let goalMetAtIteration = restored?.goalMetAtIteration ?? null;
    // A mid-step child's transcript and artifacts are the tail of what the
    // loop restored; they go back to the child, not into the loop's lists.
    const [transcript, childTranscript] = splitTail<TranscriptItem>(
      clone(restored ? (context.resume?.transcript ?? []) : []),
      restored?.child?.transcriptCount ?? 0,
    );
    const [artifacts, childArtifacts] = splitTail<ArtifactRef>(
      clone(restored ? (context.resume?.artifacts ?? []) : []),
      restored?.child?.artifactCount ?? 0,
    );
    let resumingChild: LoopChildFrame | undefined = restored?.child
      ? clone(restored.child)
      : undefined;
    /** A child asked to end the run (for example a rejected approval with onReject: complete). */
    let endRun = false;

    if (!restored?.finished) {
      for (
        let iteration = startIteration;
        iteration < iterationLimit;
        iteration += 1
      ) {
        // A runaway guard: the checkpoint after the previous iteration is the
        // position a raised limit resumes from.
        const iterationCeiling = context.limits?.maxLoopIterations;
        if (iterationCeiling !== undefined && iteration >= iterationCeiling) {
          throw createLimitSuspension({
            limit: "maxLoopIterations",
            used: iteration,
            value: iterationCeiling,
            stepId: context.step.id,
          });
        }
        const resumingIteration =
          iteration === startIteration &&
          (startChild > 0 || resumingChild !== undefined);
        let local = resumingIteration ? clone(state) : clone(state);
        if (!resumingIteration) {
          const itemVariable = config.itemVariable ?? "item";
          const indexVariable = config.indexVariable ?? "index";
          setVariableAtPath(
            local,
            itemVariable,
            clone(items[iteration] ?? null),
          );
          setVariableAtPath(local, indexVariable, String(iteration));
          local.loop = {
            index: iteration,
            iteration: iteration + 1,
            outputs: clone(outputs),
            previous: clone(previous),
          };
          await context.emit("loop.iteration.started", {
            iteration: iteration + 1,
            sourceIndex: iteration,
          });
          if (
            config.condition &&
            !(await evaluateCondition!(config.condition, local))
          ) {
            await context.emit("loop.iteration.skipped", {
              iteration: iteration + 1,
              sourceIndex: iteration,
            });
            await checkpoint({
              state,
              cursor: {
                stepId: context.step.id,
                stepPath,
                loopIteration: iteration + 1,
                childIndex: 0,
              },
              continuation: continuation({
                stepId: context.step.id,
                iterationIndex: iteration + 1,
                childIndex: 0,
                outputs,
                previous,
                lastOutput,
                finished: iteration + 1 >= iterationLimit,
                goalMet,
                goalMetAtIteration,
              }),
              transcript,
              artifacts,
            });
            startChild = 0;
            continue;
          }
        }

        const childStart = resumingIteration ? startChild : 0;
        for (
          let childIndex = childStart;
          childIndex < context.step.steps.length;
          childIndex += 1
        ) {
          const child = context.step.steps[childIndex];
          if (!child) continue;
          const childPath = `${stepPath}/${child.id}`;
          const resumed =
            resumingIteration && childIndex === childStart
              ? resumingChild
              : undefined;
          resumingChild = undefined;
          const childStartState = clone(local);
          const frame: ChildExecutionFrame = {
            key: String(iteration),
            checkpoint: (nested: NestedCheckpointInput) => ({
              // The loop resumes from the variables it had when the child began.
              state: childStartState,
              cursor: {
                stepId: child.id,
                stepPath: childPath,
                loopIteration: iteration + 1,
                childIndex,
                ...(nested.cursor ?? {}),
              },
              continuation: {
                ...continuation({
                  stepId: context.step.id,
                  iterationIndex: iteration,
                  childIndex,
                  outputs,
                  previous,
                  lastOutput,
                  finished: false,
                  goalMet,
                  goalMetAtIteration,
                }),
                child: {
                  state: clone(nested.state),
                  continuation: nested.continuation
                    ? clone(nested.continuation)
                    : null,
                  transcriptCount: nested.transcript?.length ?? 0,
                  artifactCount: nested.artifacts?.length ?? 0,
                },
              },
              transcript: [...transcript, ...(nested.transcript ?? [])],
              artifacts: [...artifacts, ...(nested.artifacts ?? [])],
              ...(nested.boundary ? { boundary: nested.boundary } : {}),
            }),
            ...(resumed
              ? {
                  resume: {
                    ...(resumed.continuation
                      ? { continuation: resumed.continuation }
                      : {}),
                    transcript: childTranscript,
                    artifacts: childArtifacts,
                  },
                }
              : {}),
          };
          const result = await executeChild(
            child,
            resumed ? clone(resumed.state) : local,
            childPath,
            frame,
          );
          local = applyStatePatch(local, result.statePatch);
          transcript.push(...(result.transcript ?? []));
          artifacts.push(...(result.artifacts ?? []));
          if (result.output !== undefined) lastOutput = clone(result.output);
          if (result.endRun === true) {
            endRun = true;
            break;
          }

          const nextChildIndex = childIndex + 1;
          const nextChild = context.step.steps[nextChildIndex];
          await checkpoint({
            // The child completed: a step commit point and a restart point.
            boundary: {
              stepPath: childPath,
              executionKey: childExecutionKey(
                context.executionKey ?? stepPath,
                child.id,
                { key: String(iteration) },
              ),
            },
            state: local,
            cursor: {
              stepId: nextChild?.id ?? context.step.id,
              stepPath: nextChild ? `${stepPath}/${nextChild.id}` : stepPath,
              loopIteration: iteration + 1,
              childIndex: nextChildIndex,
            },
            continuation: continuation({
              stepId: context.step.id,
              iterationIndex: iteration,
              childIndex: nextChildIndex,
              outputs,
              previous,
              lastOutput,
              finished: false,
              goalMet,
              goalMetAtIteration,
            }),
            transcript,
            artifacts,
          });
        }

        const resultValue =
          config.resultVariable && preferResultVariable
            ? (getNested(local, config.resultVariable) ?? lastOutput)
            : lastOutput;
        const normalizedResult = clone(resultValue ?? null);
        if (config.resultVariable) {
          setVariableAtPath(local, config.resultVariable, normalizedResult);
        }
        outputs.push(normalizedResult);
        const completedIteration: JsonObject = {
          index: iteration,
          iteration: iteration + 1,
          output: clone(normalizedResult),
          variables: snapshotIterationVariables(context.manifest, local),
        };
        local.loop = {
          index: iteration,
          iteration: iteration + 1,
          outputs: clone(outputs),
          previous: clone(previous),
          current: clone(completedIteration),
        };
        state = local;
        previous = completedIteration;

        if (config.goal && (await evaluateCondition!(config.goal, state))) {
          goalMet = true;
          goalMetAtIteration = iteration + 1;
          await context.emit("loop.goal.met", { iteration: iteration + 1 });
        }
        await context.emit("loop.iteration.completed", {
          iteration: iteration + 1,
          sourceIndex: iteration,
        });

        const finished = endRun || goalMet || iteration + 1 >= iterationLimit;
        await checkpoint({
          state,
          cursor: {
            stepId: context.step.id,
            stepPath,
            loopIteration: iteration + 1,
            childIndex: 0,
          },
          continuation: continuation({
            stepId: context.step.id,
            iterationIndex: iteration + 1,
            childIndex: 0,
            outputs,
            previous,
            lastOutput,
            finished,
            goalMet,
            goalMetAtIteration,
          }),
          transcript,
          artifacts,
        });
        startChild = 0;
        if (goalMet || endRun) break;
      }
    }

    const output: JsonValue =
      config.outputMode === "final"
        ? clone(outputs.at(-1) ?? null)
        : parsedItems.structured
          ? clone(outputs)
          : outputs.map(serializeOutput).join("\n\n");
    if (context.step.outputVariable) {
      setVariableAtPath(state, context.step.outputVariable, output);
    }
    state.loop = {
      ...(asObject(state.loop) ?? {}),
      outputs: clone(outputs),
      goalMet,
      goalMetAtIteration,
    };

    return {
      output,
      statePatch: { set: state },
      transcript,
      artifacts,
      ...(endRun ? { endRun: true } : {}),
      metadata: {
        iterations: outputs.length,
        outputMode: config.outputMode ?? "array",
        goalMet,
        goalMetAtIteration,
      },
    };
  }
}
