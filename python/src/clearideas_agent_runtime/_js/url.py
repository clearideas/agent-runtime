"""WHATWG URL parsing with Ada, the parser Node uses for ``new URL()``."""

from __future__ import annotations

import ipaddress

import ada_url


class URL:
    """A parsed URL with the WHATWG ``URL`` accessors used by the runtime."""

    def __init__(self, value: str, base: str | None = None) -> None:
        try:
            self._url = ada_url.URL(value, base) if base is not None else ada_url.URL(value)
        except ValueError as error:
            raise TypeError(f"Invalid URL: {value}") from error

    href = property(lambda self: self._url.href)
    protocol = property(lambda self: self._url.protocol)
    username = property(lambda self: self._url.username)
    password = property(lambda self: self._url.password)
    host = property(lambda self: self._url.host)
    hostname = property(lambda self: self._url.hostname)
    port = property(lambda self: self._url.port)
    pathname = property(lambda self: self._url.pathname)
    search = property(lambda self: self._url.search)
    hash = property(lambda self: self._url.hash)
    origin = property(lambda self: self._url.origin)

    def __str__(self) -> str:
        return self.href


def can_parse(value: str) -> bool:
    try:
        URL(value)
    except TypeError:
        return False
    return True


def is_ip(value: str) -> int:
    """``net.isIP``: 4, 6, or 0."""
    try:
        return ipaddress.ip_address(value).version
    except ValueError:
        return 0
