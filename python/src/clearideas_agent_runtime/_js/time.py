"""Date semantics: ``Date.prototype.toISOString`` and ``Date.parse`` for ISO strings."""

from __future__ import annotations

import re
import time as _time
from datetime import UTC, datetime, timedelta


def now() -> datetime:
    return datetime.now(UTC)


def now_ms() -> int:
    """Date.now()."""
    return _time.time_ns() // 1_000_000


def to_iso(value: datetime) -> str:
    """``toISOString``: UTC, millisecond precision, ``Z`` suffix."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    value = value.astimezone(UTC)
    millis = value.microsecond // 1000
    year = value.year
    prefix = f"{year:04d}" if 0 <= year <= 9999 else (f"+{year:06d}" if year > 0 else f"-{-year:06d}")
    return f"{prefix}-{value.month:02d}-{value.day:02d}T{value.hour:02d}:{value.minute:02d}:{value.second:02d}.{millis:03d}Z"


def from_ms(ms: int | float) -> datetime:
    return datetime(1970, 1, 1, tzinfo=UTC) + timedelta(milliseconds=ms)


def to_ms(value: datetime) -> int:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    delta = value - datetime(1970, 1, 1, tzinfo=UTC)
    return (delta.days * 86_400 + delta.seconds) * 1000 + delta.microseconds // 1000


def iso_from_ms(ms: int | float) -> str:
    return to_iso(from_ms(ms))


_ISO = re.compile(
    r"^(?P<y>[+-]\d{6}|\d{4})(?:-(?P<mo>\d{2})(?:-(?P<d>\d{2}))?)?"
    r"(?:T(?P<h>\d{2}):(?P<mi>\d{2})(?::(?P<s>\d{2})(?:\.(?P<f>\d+))?)?(?P<z>Z|[+-]\d{2}:\d{2})?)?$"
)


def parse_ms(text: str) -> float:
    """``Date.parse`` for ISO 8601 date-time strings. Returns NaN when invalid."""
    match = _ISO.fullmatch(text)
    if not match:
        return _parse_rfc2822(text)
    try:
        year = int(match["y"])
        month = int(match["mo"] or 1)
        day = int(match["d"] or 1)
        hour = int(match["h"] or 0)
        minute = int(match["mi"] or 0)
        second = int(match["s"] or 0)
        fraction = match["f"] or "0"
        millis = int((fraction + "00")[:3])
        if hour == 24 and minute == 0 and second == 0 and millis == 0:
            base = datetime(year, month, day, tzinfo=UTC) + timedelta(days=1)
        else:
            base = datetime(year, month, day, hour, minute, second, tzinfo=UTC)
    except ValueError:
        return float("nan")
    zone = match["z"]
    if zone and zone != "Z":
        sign = 1 if zone[0] == "+" else -1
        offset = timedelta(hours=int(zone[1:3]), minutes=int(zone[4:6]))
        base = base - sign * offset
    elif not zone and match["h"] is not None:
        # Date-time forms without an offset are local time in JavaScript.
        local = datetime(base.year, base.month, base.day, base.hour, base.minute, base.second)
        base = local.astimezone(UTC)
    return float(to_ms(base) + millis)


def _parse_rfc2822(text: str) -> float:
    """``Date.parse`` fallback for RFC 2822 / HTTP dates (``Wed, 21 Oct 2015 07:28:00 GMT``)."""
    from email.utils import parsedate_to_datetime

    try:
        value = parsedate_to_datetime(text.strip())
    except (TypeError, ValueError, IndexError):
        return float("nan")
    if value is None:
        return float("nan")
    if value.tzinfo is None:
        value = value.astimezone(UTC)
    return float(to_ms(value))
