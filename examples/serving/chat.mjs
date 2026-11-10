// A terminal chat client for the OpenAI-compatible server, with no
// dependencies. Like a chat front end, it keeps the conversation and sends
// all of it with every request.
//
//   node chat.mjs [model]        (default: support-chat)
//
// Environment: AGENT_RUNTIME_API_KEY, and optionally
// AGENT_RUNTIME_BASE_URL (default http://127.0.0.1:8000/v1).
import { createInterface } from "node:readline";

const baseURL =
  process.env.AGENT_RUNTIME_BASE_URL ?? "http://127.0.0.1:8000/v1";
const apiKey = process.env.AGENT_RUNTIME_API_KEY ?? "";
const model = process.argv[2] ?? "support-chat";
const dim = (text) => `\u001b[2m${text}\u001b[0m`;
const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${apiKey}`,
};

const listed = await fetch(`${baseURL}/models`, { headers }).catch((error) => {
  console.error(`Cannot reach ${baseURL}: ${error.cause?.code ?? error}`);
  process.exit(1);
});
if (!listed.ok) {
  console.error(
    `Cannot list models (${listed.status}): ${await listed.text()}`,
  );
  process.exit(1);
}
const names = (await listed.json()).data.map((entry) => entry.id);
console.log(
  dim(`Models: ${names.join(", ")}. Chatting with ${model}.`) +
    dim(" /new starts over, /quit exits."),
);

/** Send the conversation, print the streamed reply, and return its text. */
const send = async (messages) => {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!response.ok) {
    console.log(`error ${response.status}: ${await response.text()}`);
    return undefined;
  }
  const turn = response.headers.get("x-agent-runtime-turn");
  const label = `agent${turn ? ` (turn ${turn})` : ""} › `;
  let reply = "";
  let buffer = "";
  let usage;
  const decoder = new TextDecoder();
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (!event.startsWith("data: ") || event === "data: [DONE]") continue;
      const chunk = JSON.parse(event.slice(6));
      if (chunk.error) {
        console.log(`\nerror: ${chunk.error.message}`);
        continue;
      }
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta ?? {};
      // Progress arrives as reasoning; the reply is the only content.
      if (delta.reasoning_content)
        process.stdout.write(dim(delta.reasoning_content));
      if (delta.content) {
        if (!reply) process.stdout.write(label);
        reply += delta.content;
        process.stdout.write(delta.content);
      }
    }
  }
  console.log(usage ? dim(`  [${usage.total_tokens} tokens]`) : "");
  return reply;
};

let messages = [];
const input = createInterface({ input: process.stdin, terminal: false });
process.stdout.write("\nyou › ");
for await (const line of input) {
  const text = line.trim();
  if (text === "/quit") break;
  if (text === "/new") {
    messages = [];
    console.log(dim("New conversation."));
  } else if (text) {
    if (!process.stdin.isTTY) console.log(text);
    messages.push({ role: "user", content: text });
    const reply = await send(messages);
    if (reply === undefined) messages.pop();
    else messages.push({ role: "assistant", content: reply });
  }
  process.stdout.write("\nyou › ");
}
input.close();
