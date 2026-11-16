"""``atob``/``btoa`` and base64url helpers with browser semantics."""

from __future__ import annotations

import base64 as _base64
import re

_ALPHABET = re.compile(r"^[A-Za-z0-9+/]*$")


def atob(value: str) -> bytes:
    """Forgiving-base64 decode (HTML spec), as ``atob`` performs it."""
    data = re.sub(r"[\t\n\f\r ]", "", value)
    if len(data) % 4 == 0 and data.endswith("="):
        data = data[:-2] if data.endswith("==") else data[:-1]
    if len(data) % 4 == 1 or not _ALPHABET.fullmatch(data):
        raise ValueError("The string to be decoded is not correctly encoded.")
    return _base64.b64decode(data + "=" * (-len(data) % 4))


def btoa(data: bytes) -> str:
    return _base64.b64encode(data).decode("ascii")


def to_base64url(data: bytes) -> str:
    return _base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def from_base64url(value: str) -> bytes:
    normalized = value.replace("-", "+").replace("_", "/")
    return atob(normalized + "=" * ((4 - len(normalized) % 4) % 4))
