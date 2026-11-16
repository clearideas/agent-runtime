"""JSON, string, time, collation, YAML, and URL primitives against JavaScript."""

from __future__ import annotations

import json
import math
import random
import struct

from clearideas_agent_runtime._js import collation, strings, time, url, yaml
from clearideas_agent_runtime._js import json as js_json

from .conftest import REPOSITORY


def _random_number(rng: random.Random) -> int | float:
    choice = rng.random()
    if choice < 0.3:
        return rng.randint(-(10**6), 10**6)
    if choice < 0.45:
        return rng.choice([0, 1, -1, 2**53 - 1, -(2**53 - 1), 2**53, 2**60, 10**21, 10**20, 123456789012])
    if choice < 0.75:
        return rng.uniform(-1e6, 1e6)
    value = struct.unpack("d", struct.pack("Q", rng.getrandbits(64)))[0]
    return value if math.isfinite(value) else 0.5


_POOL = 'abcXYZ09 _-"\\/\n\t\u0000\u001f\u007f\u00e9\u2028\u2029\ud7ff\ue000😀日本'


def _random_string(rng: random.Random) -> str:
    return "".join(rng.choice(_POOL) for _ in range(rng.randint(0, 8)))


def _random_key(rng: random.Random) -> str:
    if rng.random() < 0.25:
        return rng.choice(["0", "1", "2", "10", "01", "-1", "4294967294", "4294967295", "1.5", " 1"])
    return _random_string(rng)


def _random_value(rng: random.Random, depth: int = 0):
    choice = rng.random()
    if depth > 3 or choice < 0.5:
        return rng.choice([None, True, False, _random_number(rng), _random_number(rng), _random_string(rng)])
    if choice < 0.75:
        return [_random_value(rng, depth + 1) for _ in range(rng.randint(0, 4))]
    return {_random_key(rng): _random_value(rng, depth + 1) for _ in range(rng.randint(0, 5))}


def _values(seed: int, count: int) -> list:
    rng = random.Random(seed)
    return [_random_value(rng) for _ in range(count)]


def test_stringify_matches_json_stringify(oracle):
    values = _values(1, 1500)
    wire = [json.loads(json.dumps(value)) for value in values]
    expected = oracle.values("stringify", [{"value": value} for value in wire])
    pretty = oracle.values("stringify", [{"value": value, "indent": 2} for value in wire[:300]])
    assert [js_json.stringify(js_json.normalize(value)) for value in wire] == expected
    assert [js_json.stringify(js_json.normalize(value), 2) for value in wire[:300]] == pretty


def test_parse_then_stringify_matches_json_parse(oracle):
    texts = [json.dumps(value, ensure_ascii=False) for value in _values(2, 800)]
    texts += [
        '{"b":1,"2":2,"a":3,"1":1.0,"x":1e400}'.replace("1e400", "1e300"),
        "[1.0,-0.0,9007199254740993,0.1]",
    ]
    expected = oracle.values("stringifyParsed", texts)
    assert [js_json.stringify(js_json.parse(text)) for text in texts] == expected


def test_byte_length_matches_text_encoder(oracle):
    values = [json.loads(json.dumps(value)) for value in _values(3, 500)]
    expected = oracle.values("jsonByteLength", values)
    assert [js_json.byte_length(js_json.normalize(value)) for value in values] == expected


def test_canonical_json_matches_core(oracle):
    values = [json.loads(json.dumps(value)) for value in _values(4, 1500)]
    expected = oracle.values("canonicalJson", values)
    assert [js_json.canonical_json(js_json.normalize(value)) for value in values] == expected


def test_locale_sort_matches_local_compare(oracle):
    rng = random.Random(5)
    pools = [
        "abcxyzABCXYZ",
        "_-.$@#0123456789 ",
        "éÉèäÄöÖüßñçøåæœ",
        "ıİşğ",
        "日本語中文한국어",
        "العربية",
        "Ελληνικά",
        "кириллица",
        "😀🚀👍🏽",
        "\u0301\u0308",
        "ﬁﬂ",
    ]
    keys = sorted(
        {"".join(rng.choice("".join(rng.sample(pools, 2))) for _ in range(rng.randint(1, 6))) for _ in range(2000)}
    )
    keys += [
        "schemaVersion",
        "steps",
        "id",
        "type",
        "x-api-key",
        "X-Api-Key",
        "_private",
        "$schema",
        "a1",
        "A1",
        "a_1",
        "a-1",
    ]
    [expected] = oracle.values("localeSort", [keys])
    assert collation.locale_sorted(keys) == expected


def test_utf16_string_operations(oracle):
    texts = [
        "",
        "abc",
        "😀😀",
        "a😀b😀c",
        "  \u00a0trim\u3000 ",
        "\u1680x\u2028",
        "İSTANBUL",
        "ΟΔΟΣ",
        "ß",
        "\u0085x\u001c",
    ]
    expected = oracle.values("utf16", texts)
    actual = [
        {
            "length": strings.length(text),
            "head": strings.slice(text, 0, 3),
            "tail": strings.slice(text, -3),
            "lower": strings.lower(text),
            "trim": strings.trim(text),
        }
        for text in texts
    ]
    assert json.loads(js_json.stringify(actual)) == expected


def test_iso_time_matches_date(oracle):
    millis = [0, 1, 999, 1_700_000_000_123, 253402300799999, -1, -62135596800000]
    assert [time.iso_from_ms(ms) for ms in millis] == oracle.values("isoString", millis)
    texts = [
        "2024-01-02T03:04:05.678Z",
        "2024-01-02T03:04:05Z",
        "2024-01-02T03:04:05.678+02:00",
        "2024-01-02",
        "2024-13-01",
        "nope",
        "2024-01-02T24:00:00Z",
    ]
    assert [("NaN" if math.isnan(ms) else ms) for ms in map(time.parse_ms, texts)] == oracle.values("dateParse", texts)


def _yaml_documents() -> dict[str, str]:
    documents: dict[str, str] = {}
    for path in sorted(REPOSITORY.glob("**/*.y*ml")):
        if "node_modules" in path.parts or ".github" in path.parts or ".venv" in path.parts:
            continue
        documents[str(path.relative_to(REPOSITORY))] = path.read_text()
    scalars = [
        "yes",
        "no",
        "on",
        "off",
        "True",
        "~",
        "null",
        "NULL",
        "",
        "0o17",
        "017",
        "0x1F",
        "0b101",
        "1_000",
        "1e3",
        "1.0",
        ".5",
        "+1",
        "-.Inf",
        ".nan",
        "2001-12-14",
        "12:30:45",
        "0.1e-2",
        "685.230_15e+03",
        "0777",
        "-0",
        "9007199254740993",
        "123456789012345678901234567890",
        "'single'",
        '"esc \\u00e9 \\t"',
        "!!str 123",
        "!!int '42'",
        "&a 1",
        "foo #comment",
        "'it''s'",
        "=",
        "<<",
        "[1, 2, ]",
        "{a: 1, b: }",
        "!Ref Name",
    ]
    for scalar in scalars:
        documents[f"scalar {scalar!r}"] = f"v: {scalar}\n"
    documents.update(
        {
            "anchors": "a: &x {k: 1}\nb: *x\nc: [*x, *x]\n",
            "merge-key": "base: &b {x: 1}\nderived:\n  <<: *b\n  y: 3\n",
            "block-scalars": "a: |\n  l1\n  l2\n\nb: >-\n  x\n  y\n\n  z\nc: |+\n  k\n\n",
            "duplicate-keys": "a: 1\na: 2\n",
            "number-keys": "1: a\n2.5: b\n10: c\n",
            "multi-doc": "a: 1\n---\nb: 2\n",
            "empty": "",
            "top-list": "- 1\n- two\n",
            "unclosed": "a: [1, 2\n",
            "bad-indent": "a:\n  b: 1\n c: 2\n",
        }
    )
    return documents


def test_yaml_parse_matches_yaml_package(oracle):
    documents = _yaml_documents()
    results = oracle("yamlParse", list(documents.values()))
    mismatches = []
    for (name, text), result in zip(documents.items(), results, strict=True):
        try:
            actual = {
                "ok": True,
                "value": js_json.stringify(yaml.parse(text)) if text.strip() else "null",
            }
        except yaml.YamlParseError:
            actual = {"ok": False}
        if result["ok"] != actual["ok"] or (result["ok"] and result["value"] != actual["value"]):
            mismatches.append((name, result.get("value"), actual.get("value")))
    assert mismatches == []


def test_url_parsing_matches_whatwg_url(oracle):
    urls = [
        "https://example.com/hook",
        "HTTPS://EXAMPLE.COM:443/a/../b?x=1#f",
        "http://[::1]:8080/x",
        "http://0x7f.1/",
        "https://例え.jp/パス",
        "not a url",
        "//example.com",
        "mailto:a@b.com",
        "https://user:pw@host/",
        "  https://trim.com  ",
        "http:\\\\example.com\\p",
        "https://example.com:99999",
    ]
    results = oracle("url", urls)
    for text, result in zip(urls, results, strict=True):
        if not result["ok"]:
            assert not url.can_parse(text), text
            continue
        parsed = url.URL(text)
        actual = {key: getattr(parsed, key) for key in ("href", "protocol", "hostname", "port", "username", "password")}
        assert actual == result["value"], text
