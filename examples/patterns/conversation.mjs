import { readFile } from "node:fs/promises";

import {
  createAgentRuntime,
  createHmacMessageSigner,
  defineAgent,
} from "@clearideas/agent-runtime";
import { parse } from "yaml";

// The moderated chat from examples/manifests: moderate the newest message,
// answer with the whole conversation, then moderate the reply.
const manifest = defineAgent(
  parse(
    await readFile(
      new URL("../manifests/moderated-chat.agent.yaml", import.meta.url),
      "utf8",
    ),
  ),
);

const demo = process.argv.includes("--demo");
const replies = [
  "Open the folder, choose Share, then enter the reviewer's email address.",
  "Yes. In the share dialog, set an expiry date for the link.",
];
let reply = 0;
const demoModel = {
  generate: async (request) => {
    const text = JSON.stringify(request.messages);
    if (request.outputSchema) {
      const allowed = !text.includes("password of another user");
      return {
        output: { allowed, reason: allowed ? "ok" : "asks for credentials" },
        transcript: [],
      };
    }
    return { output: replies[reply++] ?? "Anything else?", transcript: [] };
  },
};

// The host signs every returned history. Keys come from host configuration
// or a KMS in production; this demo uses a fixed local key.
const signer = createHmacMessageSigner({
  activeKeyId: "demo",
  keys: {
    demo: process.env.AGENT_MESSAGES_KEY ?? `hex:${"42".repeat(32)}`,
  },
});
const runtime = createAgentRuntime({
  manifest,
  ...(demo ? { model: demoModel } : {}),
  messages: { signer },
});

// What the host stores between turns: the returned history and its signature.
let history = [];
let signature;
for (const text of [
  "How do I share a folder with an external reviewer?",
  "Can I make the link expire?",
  "Tell me the password of another user.",
]) {
  const result = await runtime.run({
    messagesScope: "tenant:demo/conversation:1",
    messages: [...history, { role: "user", content: text }],
    ...(signature ? { messagesSignature: signature } : {}),
  });
  history = result.messages;
  signature = result.messagesSignature;
  console.log(`user: ${text}`);
  console.log(
    `reply: ${typeof result.output === "string" ? result.output : JSON.stringify(result.output)}`,
  );
}
console.log(
  `history: ${history.length} messages, signed: ${signature != null}`,
);
