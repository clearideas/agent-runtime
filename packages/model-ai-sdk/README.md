# `@clearideas/agent-runtime-model-ai-sdk`

Implements `ModelAdapter` with AI SDK.

Register any AI SDK-compatible model, including hosted providers,
OpenAI-compatible endpoints, local models, and custom language-model
implementations.

```ts
import { createOpenAI } from "@ai-sdk/openai";
import {
  AiSdkModelAdapter,
  createProviderRegistryModelResolver,
} from "@clearideas/agent-runtime-model-ai-sdk";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const model = new AiSdkModelAdapter({
  resolveModel: createProviderRegistryModelResolver({
    openai: (modelId) => openai(modelId),
    local: (modelId) => myLocalAiSdkProvider(modelId),
  }),
});
```

Manifests identify models as `provider/model`. Provider names map to resolver
functions in `createProviderRegistryModelResolver`.

The adapter supports generation, text and reasoning deltas, structured object
output, tool-call conversion, usage, provider metadata, and abort signals.
Agent Runtime executes tool calls sequentially.

Anthropic 4.0.72 and newer emit an `anthropic.message_start` custom part with
stream metadata. The adapter omits this metadata-only part from replayable
assistant content while preserving ordinary content, token usage, and provider
options. Older provider versions that do not emit this part remain supported.

Other custom parts remain unsupported and raise an error. In particular,
Anthropic server-side fallback blocks carry replay semantics and are not
silently discarded. Replaying those blocks requires an extension to the
runtime's content contracts; this compatibility fix does not enable that
feature.
