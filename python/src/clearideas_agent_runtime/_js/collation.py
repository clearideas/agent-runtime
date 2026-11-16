"""``String.prototype.localeCompare`` with ICU, as Node uses it.

The TypeScript manifest hasher orders keys with ``localeCompare``. ICU 77 is the
version bundled with Node 22, and ``pyicu-wheels`` ships the same version, so
the comparison is made by the same collation engine.
"""

from __future__ import annotations

import functools
from collections.abc import Iterable

import icu

_COLLATOR = icu.Collator.createInstance(icu.Locale("en"))  # pyright: ignore[reportAttributeAccessIssue]


def locale_compare(left: str, right: str) -> int:
    return _COLLATOR.compare(left, right)


def locale_sorted(values: Iterable[str]) -> list[str]:
    """``[...values].sort((a, b) => a.localeCompare(b))`` (stable)."""
    return sorted(values, key=functools.cmp_to_key(locale_compare))


ICU_VERSION: str = icu.ICU_VERSION  # pyright: ignore[reportAttributeAccessIssue]
