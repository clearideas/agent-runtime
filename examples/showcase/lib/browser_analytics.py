"""Self-hosted browser analytics settings (``lib/browser-analytics.ts``)."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from typing import Any

from . import js

_SITE_KEY = re.compile(r"^[A-Za-z0-9._-]{3,64}$")


def resolve_browser_analytics(
    options: Mapping[str, str] | bool | None = None, environment: Mapping[str, str] | None = None
) -> dict[str, Any]:
    """``{"enabled": False}`` or ``{"enabled": True, "apiBaseUrl", "siteKey"}``.

    ``options`` is ``{"apiBaseUrl", "siteKey"}``, ``False`` to disable, or
    ``None`` to read SHOWCASE_ANALYTICS_API_BASE_URL and
    SHOWCASE_ANALYTICS_SITE_KEY.
    """
    environment = os.environ if environment is None else environment
    if options is False:
        return {"enabled": False}
    settings = options if isinstance(options, Mapping) else {}
    api_base_url = settings.get("apiBaseUrl") or environment.get("SHOWCASE_ANALYTICS_API_BASE_URL")
    site_key = settings.get("siteKey") or environment.get("SHOWCASE_ANALYTICS_SITE_KEY")
    if not api_base_url and not site_key:
        return {"enabled": False}
    if not api_base_url or not site_key or not _SITE_KEY.match(site_key):
        raise ValueError("Showcase analytics requires a collector URL and registered site key.")
    url = js.URL(api_base_url)
    if url.protocol not in ("http:", "https:") or url.username or url.password or url.search or url.hash:
        raise ValueError("Showcase analytics requires an HTTP(S) collector URL without credentials or query.")
    return {"enabled": True, "apiBaseUrl": re.sub(r"/+$", "", api_base_url), "siteKey": site_key}
