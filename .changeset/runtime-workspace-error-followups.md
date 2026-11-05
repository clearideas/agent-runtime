---
"@clearideas/agent-runtime-core": patch
"@clearideas/agent-runtime-sandbox": patch
"@clearideas/agent-runtime-model-ai-sdk": patch
"@clearideas/agent-runtime-contracts": patch
"@clearideas/agent-runtime-step-prompt": patch
---

Allow underscore-prefixed workspace paths such as Python's `__init__.py` in staging and helper operations. Relocate paths in the host-process test provider's workspace index so code steps can use it directly. Suppress duplicate SDK stderr logging while continuing to propagate provider failures. Clarify that `maxToolCallsPerIteration` applies cumulatively to one prompt step execution, including checkpoint resumes.
