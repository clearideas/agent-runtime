"""Optional HTTP hosting support (``lib/hosting.ts``). No hosting-provider SDK belongs here."""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
from collections.abc import Callable

from . import js


def parse_origin(value: str) -> str:
    """The origin of an HTTP(S) URL that is nothing but an origin."""
    try:
        url = js.URL(value)
    except Exception as error:
        raise ValueError(f"Invalid URL: {value}") from error
    if (
        url.protocol not in ("http:", "https:")
        or url.username
        or url.password
        or url.pathname != "/"
        or url.search
        or url.hash
    ):
        raise ValueError(f"Expected an HTTP origin, received {value}")
    return url.origin


_SESSION_ID = re.compile(r"^[a-f0-9]{32}$")
_SIGNATURE = re.compile(r"^[a-f0-9]{64}$")

#: ``(cookie header, secure) -> (session id, Set-Cookie value or None)``
SessionResolver = Callable[[str | None, bool], tuple[str, str | None]]


def create_session_resolver(directory: str) -> SessionResolver:
    """Signed, opaque session cookies bind all demo files to one visitor."""
    os.makedirs(directory, exist_ok=True)
    key_path = os.path.join(directory, "session-signing.key")
    try:
        descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(descriptor, "wb") as file:
            file.write(secrets.token_bytes(32))
    with open(key_path, "rb") as file:
        key = file.read()
    if len(key) != 32:
        raise RuntimeError("The showcase session signing key must contain 32 bytes.")

    def sign(session: str) -> str:
        return hmac.new(key, session.encode(), hashlib.sha256).hexdigest()

    def resolve(cookie_header: str | None, secure: bool) -> tuple[str, str | None]:
        cookie = next(
            (
                part.strip()[len("showcase_session=") :]
                for part in (cookie_header or "").split(";")
                if part.strip().startswith("showcase_session=")
            ),
            "",
        )
        session, _, signature = cookie.partition(".")
        signature = signature.split(".")[0]
        if (
            _SESSION_ID.match(session)
            and _SIGNATURE.match(signature)
            and hmac.compare_digest(bytes.fromhex(signature), bytes.fromhex(sign(session)))
        ):
            return session, None
        created = secrets.token_hex(16)
        attributes = "SameSite=None; Secure; Partitioned" if secure else "SameSite=Lax"
        return created, f"showcase_session={created}.{sign(created)}; Path=/; HttpOnly; Max-Age=604800; {attributes}"

    return resolve
