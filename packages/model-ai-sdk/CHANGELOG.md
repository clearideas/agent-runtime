# @clearideas/agent-runtime-model-ai-sdk

## 0.6.1

### Patch Changes

- 184aede: Allow Anthropic SDK 4.0.72 and newer to complete streamed responses by omitting
  the metadata-only `anthropic.message_start` custom part from replay content.
  Preserve existing text/tool replay, usage accounting, and provider options.
  Other unknown content and semantic custom parts, including Anthropic fallback
  blocks, remain explicit unsupported-content errors rather than being discarded.
- 743cc1e: Allow underscore-prefixed workspace paths such as Python's `__init__.py` in staging and helper operations. Relocate paths in the host-process test provider's workspace index so code steps can use it directly. Suppress duplicate SDK stderr logging while continuing to propagate provider failures. Clarify that `maxToolCallsPerIteration` applies cumulatively to one prompt step execution, including checkpoint resumes.
- Updated dependencies [743cc1e]
- Updated dependencies [f944e14]
  - @clearideas/agent-runtime-core@0.6.1
  - @clearideas/agent-runtime-contracts@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [ec1209b]
- Updated dependencies [7a9b18c]
  - @clearideas/agent-runtime-contracts@0.6.0
  - @clearideas/agent-runtime-core@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [4196b3a]
  - @clearideas/agent-runtime-core@0.5.0
  - @clearideas/agent-runtime-contracts@0.5.0
