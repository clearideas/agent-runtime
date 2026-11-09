import {
  createHmacMessageSigner,
  type AgentRuntimeMessagesOptions,
} from "@clearideas/agent-runtime-core";

import type { AgentRuntimeConfig } from "./config.js";
import {
  resolveEnvironmentReference,
  type ValueResolutionContext,
} from "./values.js";

/**
 * Conversation message options from the host configuration's `messages`
 * section: the signer with keys resolved from the environment, the
 * host-enforced signature requirement, and the history ceilings. Host
 * callbacks such as `authorizeArtifact` and the compactor are added by the
 * composing application.
 */
export const createConfiguredMessagesOptions = (
  config: AgentRuntimeConfig,
  context: ValueResolutionContext = {},
): AgentRuntimeMessagesOptions | undefined => {
  const section = config.messages;
  if (!section) return undefined;
  const signing = section.signing;
  const signer = signing
    ? createHmacMessageSigner({
        activeKeyId: signing.activeKeyId,
        keys: Object.fromEntries(
          Object.entries(signing.keys).map(([id, reference]) => [
            id,
            resolveEnvironmentReference(
              reference,
              context,
              `Message signing key ${id}`,
            ),
          ]),
        ),
      })
    : undefined;
  return {
    ...(signer ? { signer } : {}),
    ...(signing?.require != null ? { requireSignature: signing.require } : {}),
    ...(section.media?.maxInlineBytes != null
      ? { maxInlineBytes: section.media.maxInlineBytes }
      : {}),
    ...(section.limits?.maxSuppliedMessages != null
      ? { maxSuppliedMessages: section.limits.maxSuppliedMessages }
      : {}),
    ...(section.limits?.maxSuppliedBytes != null
      ? { maxSuppliedBytes: section.limits.maxSuppliedBytes }
      : {}),
  };
};
