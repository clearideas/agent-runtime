"""Conversation message options from host configuration (``packages/runtime/src/messages.ts``)."""

from __future__ import annotations

from typing import Any

from .._js import json as js_json
from ..core.messages import MessagesOptions, create_hmac_message_signer
from .values import ValueResolutionContext, resolve_environment_reference


def create_configured_messages_options(
    config: dict[str, Any], context: ValueResolutionContext | None = None
) -> MessagesOptions | None:
    """The signer (keys from the environment), signature requirement, and history ceilings."""
    section = config.get("messages")
    if not section:
        return None
    signing = section.get("signing")
    signer = None
    if signing:
        signer = create_hmac_message_signer(
            signing["activeKeyId"],
            {
                key_id: resolve_environment_reference(reference, context, f"Message signing key {key_id}")
                for key_id, reference in js_json.js_entries(signing["keys"])
            },
        )
    media = section.get("media") or {}
    limits = section.get("limits") or {}
    return MessagesOptions(
        signer=signer,
        require_signature=signing.get("require") if signing else None,
        max_inline_bytes=media.get("maxInlineBytes"),
        max_supplied_messages=limits.get("maxSuppliedMessages"),
        max_supplied_bytes=limits.get("maxSuppliedBytes"),
    )
