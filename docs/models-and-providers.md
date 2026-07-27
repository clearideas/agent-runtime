---
title: Models and providers
description: Configure hosted providers, reusable model profiles, local models, and custom model adapters.
---

# Models and providers

## Built-in providers

The runtime includes AI SDK drivers for:

| Provider name        | Driver               | Default environment variable   |
| -------------------- | -------------------- | ------------------------------ |
| `openai`             | OpenAI               | `OPENAI_API_KEY`               |
| `anthropic`          | Anthropic            | `ANTHROPIC_API_KEY`            |
| `google` or `gemini` | Google Generative AI | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `xai` or `grok`      | xAI                  | `XAI_API_KEY`                  |
| `groq`               | Groq                 | `GROQ_API_KEY`                 |
| `cohere`             | Cohere               | `COHERE_API_KEY`               |

An explicit model reference uses the provider's conventional environment
variable:

```yaml
model:
  provider: openai
  model: gpt-5.6
```

## Model profiles

Model profiles define reusable deployment settings:

```yaml
version: "1.0"
providers:
  primary-openai:
    driver: openai
    apiKey:
      env: TEAM_OPENAI_API_KEY
models:
  fast:
    provider: primary-openai
    model: gpt-5.4-mini
    options:
      openai:
        reasoningEffort: low
    capabilities:
      streaming: true
      tools: true
      structuredOutput: true
      reasoning: false
      maxInputTokens: 128000
      maxOutputTokens: 16384
```

The agent manifest uses:

```yaml
model:
  ref: fast
```

Profile and per-step `options` are forwarded as AI SDK `providerOptions`, so
they must use the provider-keyed shape required by that SDK. Per-step values
are merged over profile defaults. The runtime rejects tool use or structured
output when the profile disables them, and enforces the declared per-step
output-token limit. Other capability fields record the selected deployment's
capabilities.

## Hosted authorization policy

Local quick starts may use explicit provider and model names. A service that
accepts agent manifests from users should restrict those choices with a host
policy:

```ts
const runtime = composeRuntime(
  manifest,
  config,
  {},
  {
    modelPolicy: {
      requireProfiles: true,
      allowedProviders: ["primary-openai"],
      allowedModels: ["primary-openai/gpt-5.6"],
      allowManifestOptions: false,
    },
  },
);
```

`requireProfiles` limits manifests to host-defined profiles.
`allowedProviders` and `allowedModels` constrain the resolved deployment.
`allowManifestOptions: false` prevents manifests from adding or overriding
provider options. `authorizeModel` is available for tenant- or run-specific
policy.

## OpenAI-compatible endpoints

Use `openai-compatible` for Ollama, LM Studio, vLLM, or another self-hosted or
managed compatible API:

```yaml
version: "1.0"
providers:
  local:
    driver: openai-compatible
    baseURL: http://127.0.0.1:11434/v1
    includeUsage: true
  private-vllm:
    driver: openai-compatible
    baseURL:
      env: PRIVATE_VLLM_BASE_URL
    apiKey:
      env: PRIVATE_VLLM_API_KEY
    headers:
      X-Tenant-ID:
        env: PRIVATE_VLLM_TENANT
models:
  local-gemma:
    provider: local
    model: gemma4
```

Base URLs must use HTTP or HTTPS and cannot contain embedded credentials.

## Custom model adapters

Implement `ModelAdapter` when an endpoint is not compatible with a built-in
driver:

```ts
interface ModelAdapter {
  generate(request: ModelRequest): Promise<ModelResult>;
  stream?(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

`ModelAdapter` receives a resolved `provider/model` or `ref/profile`
identifier and returns transcript items, tool calls, usage, and completion
metadata.

When `stream` is absent, Agent Runtime emits one completed result. Streaming
adapters emit `text-delta`, optional `reasoning-delta`, `tool-call`, and one
terminal `completed` event.

## Secret handling

- Put environment references in host configuration, not literal keys.
- Do not put secrets in manifests, variables, provider options, event payloads, or metadata.
- Treat runtime modules as trusted host code; they can read the process environment.
- Remote execution adapters must encrypt credentials in transit and define key
  management and rotation. See
  [remote execution security](./remote-execution.md#security-and-delivery).
- Do not retain provider credentials in reused compute containers after a run.
