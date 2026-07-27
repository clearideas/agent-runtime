# @clearideas/agent-runtime-step-loop

Sequential collection and goal loops with nested child checkpoints. Loop state
includes the current item, index, prior iteration, outputs, and goal result.
Recovery resumes after the last committed child.

Loop conditions and goals require a registered `ConditionEvaluator`.
