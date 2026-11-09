---
title: Conversation messages
description: Continue a chat across runs with a declared, signed, and compacted message history that any step can read.
---

# Conversation messages

A chat continues one run per turn. The agent manifest declares that it accepts
a conversation history; each run supplies the history so far plus the new user
message; the run's final output is the reply; and `RunResult.messages` returns
the history with that reply appended, ready for the next turn. The runtime has
no session: the host stores the returned history between turns.

```text
client            host                            Agent Runtime (one run per turn)
  │  new message    │                                     │
  ├────────────────>│ stored history + signature           │
  │                 │ + new user message + scope           │
  │                 ├────────────────────────────────────>│ validate, verify, ingest media
  │                 │                                     │ compact once if over its limits
  │                 │                                     │ run steps; each sees its selection
  │                 │<────────────────────────────────────┤ final output + signed history
  │<────────────────┤ reply = final output                 │
```

## Declare the history

A manifest that does not declare `messages` cannot receive a history, and its
steps cannot read one.

```yaml
messages:
  required: true # a run must supply a history (a single user message is enough)
  maxMessages: 40 # compaction trigger
  maxBytes: 200000 # compaction trigger: UTF-8 bytes of the history JSON
  requireSignature: true # every message before the new turn must be signed
  context: # optional: overrides policies.context for the history only
    strategy: summarize-or-prune
  markers: # optional: wording of compaction markers
    summary: "[Summary of turns {{ context.turns }}]"
```

| Field              | Meaning                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `required`         | A run must supply at least one message.                                                     |
| `maxMessages`      | Compact when the history has more messages than this (a leading summary counts as one).     |
| `maxBytes`         | Compact when the history's JSON is larger than this. Media counts as references, not bytes. |
| `requireSignature` | Refuse unsigned history, except a first turn of user messages.                              |
| `context`          | History-only context policy, merged over the manifest's `policies.context`. No `trigger`.   |
| `markers`          | Templates for the summary heading and pruning note; see [Compaction](#compaction).          |

Declaring `messages` reserves the `messages` name: no variable, output
variable, or loop variable can use it.

## Supply the history

In an agent run manifest:

```yaml
schemaVersion: "1.0"
agent:
  ref: moderated-chat.agent.yaml
messages:
  - role: user
    content: How do I share a folder with an external reviewer?
  - role: assistant
    content: Open the folder, choose Share, then enter the reviewer's email address.
  - role: user
    content: Can I make the link expire?
messagesSignature: # from the previous turn's RunResult.messagesSignature
  version: "1"
  algorithm: HMAC-SHA256
  keyId: k2026
  count: 2
  value: 3q2-7w...
```

From an embedding host:

```ts
const result = await runtime.run({
  messages: [...stored.messages, { role: "user", content: text }],
  messagesSignature: stored.signature,
  messagesScope: `tenant:${tenantId}/conversation:${conversationId}`,
});
stored = {
  messages: result.messages,
  signature: result.messagesSignature,
};
```

`messagesScope` is host data, like `signal`: it is accepted alongside an agent
run manifest but never read from one. With the CLI, use
`--messages <file>`, `--messages-scope <scope>`, and `--messages-out <file>`;
the output file has the `{ messages, signature }` form that `--messages`
reads, so turns chain.

A history is fixed when the run is created. Resume never accepts new
messages.

### What a history may contain

| Allowed                                               | Rejected                                     |
| ----------------------------------------------------- | -------------------------------------------- |
| `user` and `assistant` messages                       | `system` and `tool` messages                 |
| `text`, `json`, `image`, and `file` parts             | `reasoning`, `tool-call`, and `tool-result`  |
| `metadata` on messages and parts (stored, never sent) | `providerOptions` on messages and parts      |
| `content` as a string, shorthand for one text part    | `metadata.agentRuntime` except on the marker |

System instructions come only from the manifest. Tool rounds stay in the run
transcript; the conversation is user turns and final outputs. If later turns
need facts a tool found, put them in the final output. For files, see
[Files in a conversation](#files-in-a-conversation).

## Turns

A turn is one exchange: the user's message, or messages, and the reply that
completes it. Turn N ends with the N-th `assistant` message, so the runtime
numbers turns from the history alone:

- the new user message belongs to the current turn, `messages.turn`;
- a run without a final output appends nothing, so the host that discards a
  rejected turn and lets the user try again gets the same turn number;
- numbers survive compaction, because the marker records how many turns it
  covers;
- a message's `position` counts every message since the conversation began,
  including the ones a marker replaced.

Hosts compute the same numbers with `conversationTurns(history)`, which
returns `currentTurn`, the turn and position of each message, and what the
marker covers. Use it, for example, to file an upload under the turn it
arrives in before the run.

## Read the history in steps

A step's `history` setting selects what it sees. The same selection applies to
the turns a prompt step inserts and to the step's `messages` variable.

| Setting                      | Selection                                                     |
| ---------------------------- | ------------------------------------------------------------- |
| omitted                      | the whole history in the variable; no inserted turns          |
| `all`                        | the leading summary, if any, and every message                |
| `{ last: N }`                | the newest N messages, without the summary                    |
| `{ last: N, summary: true }` | the summary and the newest N messages                         |
| `{ insert: false }`          | prompt steps: the variable only, no inserted turns            |
| `{ media: latest }`          | media only in the newest user message; placeholders elsewhere |
| `{ media: omit }`            | every image and file replaced by a text placeholder           |

### Inserted turns

With `history` set, a prompt step's model input is its system prompt, then the
selection as real `user` and `assistant` turns, then its own `prompt`, if it
has one. With step `messages`, the selection follows the step's leading system
messages. A prompt step may have only a `systemPrompt` and `history`.

Inserted messages are literal. A user who types
<code v-pre>{{ apiKey }}</code> sends those characters; nothing is
interpolated. `limits.maxMessagesPerPrompt` and `limits.maxInputBytes` count
inserted messages.

### The messages variable

Every step of a declaring manifest can read `messages`, computed from its
selection. It is read-only and never stored in run state.

| Path                  | Value                                                                           |
| --------------------- | ------------------------------------------------------------------------------- |
| `messages.all`        | the selected messages, without the summary, each with its `turn` and `position` |
| `messages.count`      | how many                                                                        |
| `messages.turn`       | the current turn                                                                |
| `messages.last`       | `{ role, text, turn, position }` of the newest message, or null                 |
| `messages.lastUser`   | `{ role, text, turn, position }` of the newest user message, or null            |
| `messages.summary`    | the leading summary's text, when selected, or null                              |
| `messages.summarized` | `{ turns, messages }` the history's marker covers, selected or not, or null     |
| `messages.text`       | the selection as plain text, `user (turn 3): text` per message                  |

It works wherever variables are read: prompt templates
(<code v-pre>{{ messages.lastUser.text }}</code>), `when` and loop
conditions (`messages.count > 10`), loop `source` (`messages.all`), sub-run
`variableMappings`, the code step's variables file, and
`ToolExecutionContext.variables`.

A sub-run step with `history` passes its selection to the child run as the
child's `messages`, signed for the same scope. The child must declare
`messages`.

## The reply

Final output selection is unchanged: `includeInFinalOutput`, or the last
completed step. `RunResult.messages` is the history the run used plus one
`assistant` message whose text is the final output (JSON-stringified when it
is not a string). A run without a final output appends nothing. How an
application represents a refusal or a moderation verdict is the manifest's
and host's choice.

<<< ../examples/manifests/moderated-chat.agent.yaml

The [conversation pattern](https://github.com/clearideas/agent-runtime/blob/main/examples/patterns/conversation.mjs)
runs this manifest for three turns with a signed history. The
[Showcase](./showcase.md#data-chat) has **Data Chat**, a browser chat built the
same way that also reads data and renders charts in the run sandbox.

## Files in a conversation

A history carries text and references, not working files. Files that a
conversation uses or produces, such as an uploaded contract or the revision
the agent wrote, fit better in a [workspace](./workspaces.md) the host keeps
for that conversation:

- the host creates a directory, or a `WorkspaceStore`, per conversation and
  binds it to the workspace the manifest names;
- uploads go into it before the run, and the user message names them;
- steps read and write files there with workspace tools or code steps in the
  run sandbox;
- the reply names the files it produced, so later turns, and any summary,
  know where they are.

How files are laid out is the host's and the manifest's choice. Filing them
by turn, such as `turns/003/input/` and `turns/003/output/`, keeps each one
traceable to the exchange that produced it; `messages.turn` gives a step the
current number.

The [Showcase](./showcase.md#document-chat) has **Document Chat**, built this
way: a code step reads the newest `.docx` in the run sandbox, a prompt step
with the whole conversation returns edits by paragraph, and a second code
step writes the revision as `turns/NNN/output/<name>.docx`. That step's
output, which names the file, is the reply.

Images and PDFs may also travel in the history as media parts; see
[Media](#media).

## Compaction

When a supplied history exceeds `maxMessages` or `maxBytes`, the run compacts
it once, before the first step, with the existing
[context policy](./context-management.md): `summarize`, `prune` (the default),
`summarize-or-prune`, or `fail`. `reduceTo` sets the target (25% of each
trigger by default); the newest whole turns that fit the target stay
verbatim, and the new turn is always kept. Compaction never splits a turn.
With `fail`, an over-limit history is rejected before the run is created.

The oldest turns become one leading summary:

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "[Summary of turns 1–17 of this conversation, written by Agent Runtime to fit the context window. It replaces 34 earlier messages.]"
    },
    { "type": "text", "text": "<summary>" }
  ],
  "metadata": {
    "agentRuntime": {
      "messages": {
        "kind": "summary",
        "replaces": 34,
        "turns": 17,
        "sequence": 3,
        "strategy": "summarize"
      }
    }
  }
}
```

`prune` writes a note instead (`[Agent Runtime removed turns 1–17 (34
messages) ...]`), or keeps an existing summary. The summary is part of
`RunResult.messages`, so the next turn starts from it: a message is
summarized once, and later compactions fold the previous summary into the
next. `replaces` and `turns` are cumulative.

The summarizer sees each message labeled with its turn, such as
`user (turn 12): ...`, and by default names the turns it covers and keeps
goals, established facts, files with their paths and turns, decisions, and
open next steps. It uses the `messages` kind; replace its instruction with
`summarizer.prompts.messages`, where `context.label` reads like "turns 1–17
of the conversation". A host `ContextSummarizerAdapter` receives
`kind: "messages"` and an empty `stepId`.

The manifest owns the marker wording; the runtime owns the numbers.
`messages.markers.summary` and `messages.markers.note` are templates over
`context.firstTurn`, `context.lastTurn`, `context.turns` (such as `1–17`),
and `context.messages` (messages replaced):

```yaml
messages:
  markers:
    summary: "[Earlier in this chat (turns {{ context.turns }}), summarized:]"
    note: "[Turns {{ context.turns }} were removed to save space.]"
```

Compaction settings are manifest-level only. A step's own `policies.context`
never changes the run's history; it can only shrink that step's inserted turns
when its model has a smaller window, and that reduction never reaches
`RunResult.messages`. Summarizer calls count toward the token budget and are
checkpointed, so resume never repeats one.

## Signing

A history held by a client can be edited: a forged assistant message puts
words in the assistant's mouth. Model provider APIs trust their direct caller
with the visible transcript and protect only their own opaque state, such as
signed or encrypted reasoning. Here the host is that caller and the end
user's client is not, so the runtime can sign what it returns.

When the host configures a signer, every `RunResult.messages` is signed with
HMAC-SHA-256 over the JSON Canonicalization Scheme (RFC 8785) form of the
messages and the host's scope. On the next turn:

- the signature must cover an exact prefix of the supplied history;
- only `user` messages may follow the signed prefix;
- a present but invalid signature always rejects the run;
- with `requireSignature` (manifest or host), unsigned history is rejected,
  except a first turn of user messages.

Bind a scope such as `tenant:1/user:7/conversation:abc`, so one user's
history cannot be replayed as another's. Configure keys in host
configuration; no manifest can supply them:

<<< ../examples/manifests/messages.config.yaml

Keys are `base64:` or `hex:` encoded and at least 32 bytes. `activeKeyId`
signs; every listed key verifies, which allows rotation. Hosts that keep keys
in a KMS implement `MessageHistorySigner`.

## Media

Images and files in a history are artifact references:

- inline `data` is stored with the `ArtifactStore` before the run is created
  and replaced by its reference, so checkpoints and returned histories never
  carry bytes;
- references need an `ArtifactStore` and `sha256`, and a reference the runtime
  did not sign or ingest needs the host's `authorizeArtifact` callback;
  without one it is rejected;
- URLs pass to the model adapter as they do elsewhere; any download by the
  host process goes through the host's egress control.

Inserted turns carry images and PDFs to the model. Other files, such as a
Word document or a spreadsheet, are not accepted inline by model providers,
so they reach the model as a text placeholder that names the file, such as
`[file: report.docx (application/vnd.openxmlformats-officedocument.wordprocessingml.document)]`;
read their content with tools or code, or keep them in a
[workspace](#files-in-a-conversation).

When a model profile declares `capabilities.imageInput: false`, a prompt step
that would insert images for it fails validation before the run is created;
set its `history.media` to `omit`.

## Errors

These fail before the run is created, so no run state exists:

| Code                             | Cause                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `MESSAGES_NOT_ACCEPTED`          | a history was supplied to a manifest that does not declare `messages`                                               |
| `MESSAGES_REQUIRED`              | `messages.required` and no history                                                                                  |
| `MESSAGES_INVALID`               | schema violation, or media without an `ArtifactStore` or `sha256`                                                   |
| `MESSAGES_LIMIT_EXCEEDED`        | host ceiling, the new turn alone over a trigger, or `strategy: fail`                                                |
| `MESSAGES_SIGNATURE_REQUIRED`    | a signature is required and absent                                                                                  |
| `MESSAGES_SIGNATURE_INVALID`     | the signature does not verify (`reason`: `unknown-key`, `authentication-failed`, `unsigned-assistant`, `no-signer`) |
| `MESSAGES_ARTIFACT_UNAUTHORIZED` | an unsigned artifact reference was not authorized                                                                   |
| `MESSAGES_MEDIA_UNSUPPORTED`     | a step would send images to a model declared without image input                                                    |

## Events

Events carry counts and outcomes, never message content. `run.started`
includes `messages: { count, signedCount, verified, ingestedArtifacts,
compaction }`. History compaction emits `context.reduced` with
`scope: "messages"` and no `stepId`, and summarizer calls emit `model.*`
events with `purpose: "summarize"`.
