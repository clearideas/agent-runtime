"""JEXL conditions: the boolean a condition evaluates to, and whether it validates."""

from __future__ import annotations

import itertools

import pytest

from clearideas_agent_runtime._js import json as js_json
from clearideas_agent_runtime._js.errors import error_message, error_name
from clearideas_agent_runtime.conditions import JexlConditionEvaluator

CONTEXT = {
    "classification": {"route": "question"},
    "briefDraft": None,
    "inputCheck": {"allowed": True},
    "review": {"enabled": True},
    "score": "9",
    "count": 3,
    "items": [{"name": "a", "n": 1}, {"name": "b", "n": 5}],
    "tags": ["x", "y"],
    "empty": [],
    "obj": {},
    "zero": 0,
    "text": "",
    "flag": False,
    "price": 10.5,
    "name": "Alice",
    "numstr": "42",
    "fstr": "3.5",
    "neg": -2,
    "big": 1e21,
    "t": True,
    "nul": None,
    "arr1": [1],
    "arr0": [0],
    "arrs": ["a"],
    "unicode": "é😀",
    "nested": {"deep": {"value": 42, "list": [1, 2, 3]}},
    "Mixed": {"Case": "v"},
}
OPERANDS = [
    "0",
    "1",
    "-1",
    "2.5",
    '"0"',
    '""',
    '"9"',
    '"abc"',
    '"1e3"',
    '" 7 "',
    "true",
    "false",
    "null",
    "missing",
    "empty",
    "obj",
    "tags",
    "arr1",
    "arr0",
    "arrs",
    "zero",
    "text",
    "flag",
    "score",
    "count",
    "numstr",
    "fstr",
    "neg",
    "big",
    "nested.deep.value",
    "missing.x.y",
    "items[.n > 2]",
    "items.name",
    "unicode",
    "name",
]
OPERATORS = ["==", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/", "//", "%", "^", "&&", "||", "in"]
EXTRA = [
    'items[.n > 2].name == "b"',
    "items[0].name",
    "items[5].name",
    "nested.deep.list[1] == 2",
    "nested.deep.list.length",
    "unicode.length == 3",
    '"x" in tags && !("z" in tags)',
    "{a: 1}.a",
    "foo(",
    "1 +",
    "== 2",
    "a b",
    "x|upper",
    '"unterminated',
    "'single' == \"single\"",
    ".5 == 0.5",
    "1e3 == 1000",
    "a.b.c.d == null",
    "{{ score }} == 9",
    "{{score}} >= {{count}}",
    "{{ missing }} == undefined",
    "{{ name }} == 'Alice'",
    "{{ mixed.case }} == 'v'",
    "{{ flag }} == false",
    "{{ nul }} == null",
    "{{ price }} > 10",
    "",
    "   ",
]


def _corpus() -> list[str]:
    expressions = [f"{a} {op} {b}" for op in OPERATORS for a, b in itertools.product(OPERANDS, repeat=2)]
    expressions += [f"!{a}" for a in OPERANDS] + OPERANDS + [f"{a} ? 1 : 0" for a in OPERANDS] + EXTRA
    return expressions


def test_conditions_evaluate_like_the_typescript_evaluator(oracle):
    expressions = _corpus()
    context = js_json.normalize(CONTEXT)
    expected = oracle.values(
        "condition", [{"expression": expression, "variables": context} for expression in expressions]
    )
    evaluator = JexlConditionEvaluator()
    import asyncio

    async def evaluate(expression: str):
        validity: dict = {"valid": True}
        try:
            evaluator.validate(expression)
        except Exception as error:
            validity = {"valid": False, "invalid": {"name": error_name(error), "message": error_message(error)}}
        try:
            return {**validity, "value": await evaluator.evaluate(expression, context)}
        except Exception as error:
            return {**validity, "error": {"name": error_name(error), "message": error_message(error)}}

    async def evaluate_all():
        return [await evaluate(expression) for expression in expressions]

    actual = asyncio.run(evaluate_all())
    mismatches = [
        (expression, reference, result)
        for expression, reference, result in zip(expressions, expected, actual, strict=True)
        if reference != result
    ]
    assert len(expressions) > 19_000
    assert mismatches == [], mismatches[:10]


#: Degenerate input the ``jexl`` grammar accepts or rejects in its own way.
QUIRKS = [
    "[1,2][1]",
    "(",
    "(1",
    "()",
    "() + 1",
    "1 + ()",
    "() | x",
    "constructor",
    "a.toString",
    "toString == 1",
    "__proto__",
    "x ? () : 1",
    "x ? 1 : ()",
    "{a: ()}",
    "[()]",
    "a[()]",
    "-",
    "--1",
    "1 -",
    "- 1",
    "a |",
    "a | b",
    "a | b(1, 2)",
    "f(1)",
    "a.b(",
    "a.b()",
    "'unterminated",
    "@",
    "1 2",
    ".a",
    "..a",
    "a..b",
    "{}",
    "{a}",
    "{a:1,}",
    "{a:1, b: [1, {c: 2}]}.b[1].c",
    "[1,]",
    "x(1,)",
    "a ? b",
    "a ? b :",
    "!",
    "!!a",
    "a[.b == 1]",
    "a[.b == 1].c",
    "[1,2,3][.]",
    "a in",
    "in a",
    "1 == == 2",
    "(1 + 2",
    "1 + 2)",
    "a ?: b",
    "'a' + ",
    "\"x\" == 'x'",
    "'\\'' == 'x'",
    "привет == 1",
    "ёж == 1",
    "a$b == 1",
    "1.5.2",
    ".5 + 1",
    "5. + 1",
    "1e3 == 1000",
    "true == !false",
    "truex == 1",
    "intro == 1",
    "a in b in c",
    "x ? y ? 1 : 2 : 3",
    "a\n==\n1",
    "\u00a0a == 1",
    "n.z == 1",
    "e.z == 1",
    "m[.z == 1]",
    "s[.length > 1]",
    "b.length == 3",
    "c.length == 1",
    "a.length",
    ".x",
    "c[0] == 'xyz'",
    "c['0'] == 'xyz'",
    "c[5]",
    "b[1] == 'y'",
    "b['length'] == 3",
    "a[0].b",
    "n[0].z",
    "u[1]",
    "x[1]",
    "{k: 1}['k'] == 1",
    "{k: 1}[1]",
    "[1,2,3][.] == [1,2,3][0]",
]


@pytest.mark.parametrize("expression", QUIRKS)
def test_degenerate_expressions_validate_and_fail_like_jexl(oracle, expression):
    """The jexl grammar's validity, errors (jexl's and V8's), and values for odd input."""
    variables = js_json.normalize(
        {
            "a": [{"b": 1, "c": 2}],
            "x": True,
            "y": False,
            "b": "xyz",
            "c": ["xyz"],
            "n": [None],
            "e": [],
            "m": [None, {"z": 1}],
            "s": ["a", "bc"],
        }
    )
    expected = oracle.values("condition", [{"expression": expression, "variables": variables}])[0]
    evaluator = JexlConditionEvaluator()
    import asyncio

    validity: dict = {"valid": True}
    try:
        evaluator.validate(expression)
    except Exception as error:
        validity = {"valid": False, "invalid": {"name": error_name(error), "message": error_message(error)}}
    try:
        actual = {**validity, "value": asyncio.run(evaluator.evaluate(expression, variables))}
    except Exception as error:
        actual = {**validity, "error": {"name": error_name(error), "message": error_message(error)}}
    assert actual == expected
