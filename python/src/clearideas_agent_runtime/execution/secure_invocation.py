"""Sealed worker invocations (``packages/execution/src/secure-invocation.ts``).

AES-256-GCM envelopes whose JSON form, additional authenticated data, and
validation rules match the TypeScript codec, so either runtime opens the
other's envelopes.
"""

from __future__ import annotations

import base64
import hmac
import math
import os
import re
import time
from collections.abc import Callable, Mapping
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .._js import json as js_json
from .._js import strings as js_strings
from .._js import time as js_time
from .._js.errors import Error
from .contracts import EXECUTION_PROTOCOL_VERSION
from .worker_protocol import parse_worker_invocation

JsonObject = dict[str, Any]

SECURE_INVOCATION_ENVELOPE_VERSION = "1.0"
SECURE_INVOCATION_ALGORITHM = "A256GCM"
KEY_BYTES = 32
NONCE_BYTES = 12
AUTH_TAG_BYTES = 16
DEFAULT_TTL_MS = 5 * 60_000
DEFAULT_MAXIMUM_TTL_MS = 15 * 60_000
DEFAULT_CLOCK_SKEW_MS = 30_000
_KEY_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
_BASE64URL = re.compile(r"[A-Za-z0-9_-]+")
_HEX_KEY = re.compile(r"[A-Fa-f0-9]{64}")


class SecureInvocationError(Error):
    """``code``: INVALID_ENVELOPE, UNKNOWN_KEY, AUTHENTICATION_FAILED, BINDING_MISMATCH, EXPIRED, NOT_YET_VALID."""

    name = "SecureInvocationError"

    def __init__(self, code: str, message: str, cause: Any = None) -> None:
        super().__init__(message, cause=cause)
        self.code = code


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _require_non_empty_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or len(value) == 0 or value != js_strings.trim(value):
        raise SecureInvocationError("INVALID_ENVELOPE", f"{label} must be a non-empty string.")
    return value


def _require_key_id(value: Any, label: str) -> str:
    key_id = _require_non_empty_string(value, label)
    if not _KEY_ID.fullmatch(key_id):
        raise SecureInvocationError("INVALID_ENVELOPE", f"{label} has an invalid format.")
    return key_id


def _decode_base64url(value: Any, label: str, expected_length: int | None = None) -> bytes:
    encoded = _require_non_empty_string(value, label)
    if not _BASE64URL.fullmatch(encoded):
        raise SecureInvocationError("INVALID_ENVELOPE", f"{label} must be unpadded base64url.")
    try:
        decoded = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    except (ValueError, TypeError):
        decoded = b""
    if _b64url(decoded) != encoded:
        raise SecureInvocationError("INVALID_ENVELOPE", f"{label} must use canonical base64url encoding.")
    if expected_length is not None and len(decoded) != expected_length:
        raise SecureInvocationError("INVALID_ENVELOPE", f"{label} must decode to {expected_length} bytes.")
    return decoded


def parse_worker_invocation_encryption_key(value: str | bytes) -> bytes:
    if not isinstance(value, str):
        key = bytes(value)
    elif value.startswith("base64:"):
        key = _decode_base64url(value[len("base64:") :], "Encryption key")
    elif value.startswith("hex:"):
        encoded = value[len("hex:") :]
        if not _HEX_KEY.fullmatch(encoded):
            raise SecureInvocationError(
                "INVALID_ENVELOPE", "Hex encryption keys must contain exactly 64 hexadecimal characters."
            )
        key = bytes.fromhex(encoded)
    else:
        raise SecureInvocationError("INVALID_ENVELOPE", "String encryption keys must start with base64: or hex:.")
    if len(key) != KEY_BYTES:
        raise SecureInvocationError("INVALID_ENVELOPE", f"Encryption keys must contain exactly {KEY_BYTES} bytes.")
    return key


def _as_record(value: Any, label: str) -> JsonObject:
    if not isinstance(value, dict):
        raise SecureInvocationError("INVALID_ENVELOPE", f"{label} must be an object.")
    return value


def _require_iso_timestamp(value: Any, label: str) -> str:
    timestamp = _require_non_empty_string(value, label)
    milliseconds = js_time.parse_ms(timestamp)
    if not math.isfinite(milliseconds) or js_time.iso_from_ms(milliseconds) != timestamp:
        raise SecureInvocationError("INVALID_ENVELOPE", f"{label} must be a canonical ISO 8601 timestamp.")
    return timestamp


def _is_safe_integer(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        return False
    return abs(value) <= js_json.MAX_SAFE_INTEGER


def _parse_metadata(value: Any) -> JsonObject:
    metadata = _as_record(value, "Secure invocation metadata")
    if metadata.get("protocolVersion") != EXECUTION_PROTOCOL_VERSION:
        raise SecureInvocationError("INVALID_ENVELOPE", "Unsupported execution protocol version.")
    if metadata.get("action") not in ("run", "resume"):
        raise SecureInvocationError("INVALID_ENVELOPE", "Invocation action must be run or resume.")
    if not _is_safe_integer(metadata.get("attempt")) or metadata["attempt"] < 1:
        raise SecureInvocationError("INVALID_ENVELOPE", "Invocation attempt must be a positive safe integer.")
    return {
        "protocolVersion": EXECUTION_PROTOCOL_VERSION,
        "executionId": _require_non_empty_string(metadata.get("executionId"), "Execution ID"),
        "runId": _require_non_empty_string(metadata.get("runId"), "Run ID"),
        "action": metadata["action"],
        "attempt": int(metadata["attempt"]),
        "audience": _require_non_empty_string(metadata.get("audience"), "Invocation audience"),
        "issuedAt": _require_iso_timestamp(metadata.get("issuedAt"), "Issued-at timestamp"),
        "expiresAt": _require_iso_timestamp(metadata.get("expiresAt"), "Expiry timestamp"),
    }


def parse_secure_invocation_envelope(value: Any) -> JsonObject:
    envelope = _as_record(value, "Secure invocation envelope")
    if envelope.get("envelopeVersion") != SECURE_INVOCATION_ENVELOPE_VERSION:
        raise SecureInvocationError("INVALID_ENVELOPE", "Unsupported secure envelope version.")
    if envelope.get("algorithm") != SECURE_INVOCATION_ALGORITHM:
        raise SecureInvocationError("INVALID_ENVELOPE", "Unsupported secure envelope algorithm.")
    return {
        "envelopeVersion": SECURE_INVOCATION_ENVELOPE_VERSION,
        "algorithm": SECURE_INVOCATION_ALGORITHM,
        "keyId": _require_key_id(envelope.get("keyId"), "Encryption key ID"),
        "nonce": _b64url(_decode_base64url(envelope.get("nonce"), "Envelope nonce", NONCE_BYTES)),
        "ciphertext": _b64url(_decode_base64url(envelope.get("ciphertext"), "Envelope ciphertext")),
        "authTag": _b64url(_decode_base64url(envelope.get("authTag"), "Envelope authentication tag", AUTH_TAG_BYTES)),
        "metadata": _parse_metadata(envelope.get("metadata")),
    }


def _authenticated_data(envelope: JsonObject) -> bytes:
    header = {
        "envelopeVersion": envelope["envelopeVersion"],
        "algorithm": envelope["algorithm"],
        "keyId": envelope["keyId"],
        "metadata": envelope["metadata"],
    }
    return js_json.stringify(header).encode("utf-8")


def _invocation_attempt(invocation: JsonObject) -> int:
    return invocation["request"]["attempt"] if invocation["action"] == "resume" else 1


def _equal_text(left: str, right: str) -> bool:
    return hmac.compare_digest(left.encode("utf-8", "surrogatepass"), right.encode("utf-8", "surrogatepass"))


class AesGcmWorkerInvocationCodec:
    def __init__(
        self,
        *,
        active_key_id: str,
        keys: Mapping[str, str | bytes],
        default_ttl_ms: int | None = None,
        maximum_ttl_ms: int | None = None,
        clock_skew_ms: int | None = None,
        now: Callable[[], float] | None = None,
    ) -> None:
        self._active_key_id = _require_key_id(active_key_id, "Active encryption key ID")
        parsed: dict[str, bytes] = {}
        for key_id, value in keys.items():
            parsed[_require_key_id(key_id, "Encryption key ID")] = parse_worker_invocation_encryption_key(value)
        if self._active_key_id not in parsed:
            raise SecureInvocationError("UNKNOWN_KEY", "The active encryption key ID is not present in the keyring.")
        self._keys = parsed
        self._default_ttl_ms = DEFAULT_TTL_MS if default_ttl_ms is None else default_ttl_ms
        self._maximum_ttl_ms = DEFAULT_MAXIMUM_TTL_MS if maximum_ttl_ms is None else maximum_ttl_ms
        self._clock_skew_ms = DEFAULT_CLOCK_SKEW_MS if clock_skew_ms is None else clock_skew_ms
        self._now = now or (lambda: time.time() * 1000)
        for label, value in (
            ("defaultTtlMs", self._default_ttl_ms),
            ("maximumTtlMs", self._maximum_ttl_ms),
            ("clockSkewMs", self._clock_skew_ms),
        ):
            if not _is_safe_integer(value) or value < 0:
                raise SecureInvocationError("INVALID_ENVELOPE", f"{label} must be a non-negative safe integer.")
        if self._default_ttl_ms == 0 or self._default_ttl_ms > self._maximum_ttl_ms:
            raise SecureInvocationError(
                "INVALID_ENVELOPE", "defaultTtlMs must be positive and no greater than maximumTtlMs."
            )

    def seal(
        self, invocation: JsonObject, *, execution_id: str, run_id: str, audience: str, ttl_ms: int | None = None
    ) -> JsonObject:
        parsed = parse_worker_invocation(invocation)
        execution_id = _require_non_empty_string(execution_id, "Execution ID")
        run_id = _require_non_empty_string(run_id, "Run ID")
        audience = _require_non_empty_string(audience, "Invocation audience")
        if parsed["request"].get("runId") is not None and not _equal_text(parsed["request"]["runId"], run_id):
            raise SecureInvocationError(
                "BINDING_MISMATCH", "Worker invocation does not match the requested run binding."
            )
        ttl = self._default_ttl_ms if ttl_ms is None else ttl_ms
        if not _is_safe_integer(ttl) or ttl <= 0 or ttl > self._maximum_ttl_ms:
            raise SecureInvocationError(
                "INVALID_ENVELOPE", f"Envelope ttlMs must be between 1 and {self._maximum_ttl_ms}."
            )
        now = math.floor(self._now())
        header: JsonObject = {
            "envelopeVersion": SECURE_INVOCATION_ENVELOPE_VERSION,
            "algorithm": SECURE_INVOCATION_ALGORITHM,
            "keyId": self._active_key_id,
            "metadata": {
                "protocolVersion": EXECUTION_PROTOCOL_VERSION,
                "executionId": execution_id,
                "runId": run_id,
                "action": parsed["action"],
                "attempt": _invocation_attempt(parsed),
                "audience": audience,
                "issuedAt": js_time.iso_from_ms(now),
                "expiresAt": js_time.iso_from_ms(now + ttl),
            },
        }
        nonce = os.urandom(NONCE_BYTES)
        sealed = AESGCM(self._keys[self._active_key_id]).encrypt(
            nonce, js_json.stringify(parsed).encode("utf-8", "surrogatepass"), _authenticated_data(header)
        )
        return {
            **header,
            "nonce": _b64url(nonce),
            "ciphertext": _b64url(sealed[:-AUTH_TAG_BYTES]),
            "authTag": _b64url(sealed[-AUTH_TAG_BYTES:]),
        }

    def open(self, value: Any, *, execution_id: str, run_id: str, audience: str) -> JsonObject:
        envelope = parse_secure_invocation_envelope(value)
        key = self._keys.get(envelope["keyId"])
        if key is None:
            raise SecureInvocationError("UNKNOWN_KEY", "The secure invocation envelope uses an unavailable key ID.")
        try:
            plaintext = AESGCM(key).decrypt(
                _decode_base64url(envelope["nonce"], "nonce"),
                _decode_base64url(envelope["ciphertext"], "ciphertext")
                + _decode_base64url(envelope["authTag"], "authTag"),
                _authenticated_data(envelope),
            )
        except InvalidTag as error:
            raise SecureInvocationError(
                "AUTHENTICATION_FAILED", "Secure invocation authentication failed.", cause=error
            ) from error
        now = self._now()
        issued_at = js_time.parse_ms(envelope["metadata"]["issuedAt"])
        expires_at = js_time.parse_ms(envelope["metadata"]["expiresAt"])
        if issued_at > now + self._clock_skew_ms:
            raise SecureInvocationError("NOT_YET_VALID", "Secure invocation is not yet valid.")
        if expires_at <= now:
            raise SecureInvocationError("EXPIRED", "Secure invocation has expired.")
        if expires_at <= issued_at or expires_at - issued_at > self._maximum_ttl_ms:
            raise SecureInvocationError("INVALID_ENVELOPE", "Secure invocation has an invalid validity interval.")
        metadata = envelope["metadata"]
        if not (
            _equal_text(metadata["executionId"], execution_id)
            and _equal_text(metadata["runId"], run_id)
            and _equal_text(metadata["audience"], audience)
        ):
            raise SecureInvocationError("BINDING_MISMATCH", "Secure invocation does not match its execution binding.")
        try:
            invocation = parse_worker_invocation(plaintext.decode("utf-8"))
        except Exception as error:
            raise SecureInvocationError(
                "INVALID_ENVELOPE", "Secure invocation plaintext is invalid.", cause=error
            ) from error
        if (
            invocation["action"] != metadata["action"]
            or _invocation_attempt(invocation) != metadata["attempt"]
            or (
                invocation["request"].get("runId") is not None
                and not _equal_text(invocation["request"]["runId"], metadata["runId"])
            )
        ):
            raise SecureInvocationError("BINDING_MISMATCH", "Secure invocation metadata does not match its payload.")
        return invocation
