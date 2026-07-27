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
