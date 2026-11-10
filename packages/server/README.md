# @clearideas/agent-runtime-server

An OpenAI-compatible HTTP server for Agent Runtime manifests. Each served
manifest appears as a model on `/v1/models`; a chat front end or SDK sends an
ordinary `/v1/chat/completions` request, and the server runs the whole
manifest and returns its reply, streamed or not.

```sh
# One manifest
npx agent-runtime serve ./support-chat.agent.yaml --config ./runtime.yaml --port 8000

# Several, from agent-runtime.server.yaml in the working directory
npx agent-runtime serve
```

The server is a host. Requests select a served model and supply a
conversation or operator-mapped variables; they never supply manifests,
configuration, tools, or provider options. Manifests that declare `messages`
receive the chat as conversation turns, and a conversation ledger continues
each conversation from the runtime's own signed, compacted history. Only the
run's final output is ever streamed as content.

To embed the server in an application:

```ts
import {
  AgentServer,
  createFetchHandler,
  listen,
  loadServerConfig,
} from "@clearideas/agent-runtime-server";

const server = await AgentServer.create({
  loaded: await loadServerConfig("./agent-runtime.server.yaml"),
});
const listening = await listen(server); // node:http
// or: const handler = createFetchHandler(server); // Request → Response
```

The package also exports the host composition shared by every Agent Runtime
host (`composeHostRuntime`, `hostRuntimeDependencies`, `loadHostRuntime`).

See [Serve agents over an OpenAI-compatible API](https://agent-runtime.clearideas.com/serving).

Requires Node.js 22.20.0 or newer.
