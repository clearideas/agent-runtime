---
title: Three agent patterns
description: Runnable prompt chains, tools with recovery, and approval across processes.
---

# Three agent patterns

For interactive, end-to-end walkthroughs of workspaces, durable runs,
guardrails, documents and remote workers, see the [Showcase](./showcase.md).
The command-line patterns below are smaller examples you can run separately.

Start with these [runnable examples in the repository](https://github.com/clearideas/agent-runtime/tree/main/examples/patterns).
Each includes exact commands, expected output, and troubleshooting.

| Pattern      | What you learn                                                       | Provider key          |
| ------------ | -------------------------------------------------------------------- | --------------------- |
| Prompt chain | Required inputs, intermediate variables, structured final output     | Optional in demo mode |
| Tool agent   | Tool lifecycle events, classified read failure, model-directed retry | Optional in demo mode |
| Approval     | Durable suspension and resume in a fresh process                     | None                  |

From a source checkout:

```sh
npm ci
npm run build
node examples/patterns/prompt-chain.mjs --demo
node examples/patterns/tool-agent.mjs --demo
node examples/patterns/approval.mjs
node examples/patterns/approval.mjs --approve
```

The demos substitute model responses while using the real runtime, tools, and
stores. To run the prompt chain or tool agent against OpenAI, set
`OPENAI_API_KEY` and omit `--demo`.

Next, use [embedding](./embedding.md) to customize the host or
[the quickstart](./quickstart.md) to write your own YAML agent.
