"""JEXL conditions (``@clearideas/agent-runtime-condition-jexl``).

Expressions are parsed with the ``jexl`` package's grammar (``jexl_parser``) and
evaluated with ``pyjexl`` configured for jexl 2.x and JavaScript semantics:
JavaScript operators (loose equality, ``+`` coercion, relational coercion,
``Math.pow``, ``%``), ``undefined`` for missing properties, first-element
property access on arrays, jexl 2 filter rules, and ``Boolean(result)``.
"""

from __future__ import annotations

import math
import re
from typing import Any

from pyjexl import JEXL
from pyjexl.evaluator import Context, Evaluator
from pyjexl.operators import Operator

from .._js import json as js_json
from .._js import ops as js
from .._js import strings as js_strings
from .._js.errors import Error, TypeError_
from .._js.ops import UNDEFINED
from .._js.regex import WS
from ..core.templates import get_nested_value
from . import jexl_parser

_LEGACY_OPERAND = re.compile(r"\{\{" + WS + r"*([^}]+?)" + WS + r"*\}\}")
_NUMERIC = re.compile(r"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:e[+-]?[0-9]+)?$", re.IGNORECASE)


def _stringify_condition_value(value: Any) -> str:
    if not isinstance(value, str):
        if value is UNDEFINED:
            return "undefined"
        return js.to_string(value)
    trimmed = js_strings.trim(value)
    if _NUMERIC.fullmatch(trimmed):
        number = js.to_number(trimmed)
        if isinstance(number, int) or math.isfinite(number):
            return js.to_string(number)
    if re.fullmatch(r"(?:true|false)", trimmed, re.IGNORECASE):
        return trimmed.lower()
    if re.fullmatch(r"null", trimmed, re.IGNORECASE):
        return "null"
    return js_json.stringify(trimmed)


def resolve_condition_expression(expression: str, variables: dict[str, Any]) -> str:
    """Resolves legacy ``{{ variable.path }}`` operands before JEXL evaluation."""
    return _LEGACY_OPERAND.sub(
        lambda match: _stringify_condition_value(get_nested_value(variables, js_strings.trim(match.group(1)))),
        expression,
    )


def _member(value: Any, key: str) -> Any:
    """``value[key]`` for a JSON value (V8's ``TypeError`` for ``null``/``undefined``)."""
    if value is None or value is UNDEFINED:
        raise TypeError_(f"Cannot read properties of {'null' if value is None else 'undefined'} (reading '{key}')")
    if isinstance(value, dict):
        return value.get(key, UNDEFINED)
    if key == "length" and isinstance(value, list):
        return len(value)
    if key == "length" and isinstance(value, str):
        return js_strings.length(value)
    return UNDEFINED


def _index(subject: Any, key: Any) -> Any:
    """``subject[key]`` (property keys are strings; arrays and strings index by canonical integers)."""
    name = js.to_string(key)
    if subject is None or subject is UNDEFINED:
        raise TypeError_(f"Cannot read properties of {'null' if subject is None else 'undefined'} (reading '{name}')")
    if isinstance(subject, dict):
        return subject.get(name, UNDEFINED)
    if isinstance(subject, list | str):
        if name == "length":
            return len(subject) if isinstance(subject, list) else js_strings.length(subject)
        if js_json.is_array_index(name):
            index = int(name)
            if isinstance(subject, list):
                return subject[index] if index < len(subject) else UNDEFINED
            return js_strings.char_at(subject, index) if index < js_strings.length(subject) else UNDEFINED
    return UNDEFINED


class _JsEvaluator(Evaluator):
    def visit_Identifier(self, identifier: Any, context: Any) -> Any:
        # jexl: `relative ? relContext[value] : context[value]`, or the property of
        # `from` (the first element of an array; undefined when missing).
        if identifier.relative:
            return _member(context.relative_value, identifier.value)
        if identifier.subject is not None:
            subject = self.evaluate(identifier.subject, context)
            if subject is None or subject is UNDEFINED:
                return UNDEFINED
            if isinstance(subject, list):
                subject = subject[0] if subject else UNDEFINED
            return _member(subject, identifier.value)
        return context.data.get(identifier.value, UNDEFINED)

    def visit_FilterExpression(self, expression: Any, context: Any) -> Any:  # pyright: ignore[reportIncompatibleMethodOverride]
        subject = self.evaluate(expression.subject, context)
        if expression.relative:
            # jexl `_filterRelative`: each element is the relative context (falsy ones fall back to the context).
            items = subject if isinstance(subject, list) else ([] if subject is UNDEFINED else [subject])
            return [
                item
                for item in items
                if js.truthy(
                    self.evaluate(
                        expression.expression, context.with_relative(item if js.truthy(item) else context.data)
                    )
                )
            ]
        # jexl `_filterStatic`: a boolean keeps or drops the subject; anything else indexes it.
        result = self.evaluate(expression.expression, context)
        if isinstance(result, bool):
            return subject if result else UNDEFINED
        return _index(subject, result)

    def visit_ConditionalExpression(self, conditional: Any, context: Any) -> Any:
        test = self.evaluate(conditional.test, context)
        if js.truthy(test):
            return self.evaluate(conditional.consequent, context) if conditional.consequent is not None else test
        return self.evaluate(conditional.alternate, context)

    def visit_Missing(self, missing: Any, context: Any) -> Any:
        raise TypeError_(f"Cannot read properties of {missing.kind} (reading 'type')")

    def visit_Transform(self, transform: Any, context: Any) -> Any:
        raise Error(f"Transform {transform.name} is not defined.")

    def visit_Function(self, function: Any, context: Any) -> Any:  # pyright: ignore[reportIncompatibleMethodOverride]
        raise Error(f"Jexl Function {function.name} is not defined.")


def _in(left: Any, right: Any) -> bool:
    if isinstance(right, str):
        return js.to_string(left) in right
    if isinstance(right, list):
        return any(js.strict_equals(element, left) for element in right)
    return False


def _floor_divide(left: Any, right: Any) -> Any:
    return js.floor(js.divide(left, right))


def _create_jexl() -> JEXL:
    jexl = JEXL()
    operators = {
        "+": (30, js.add),
        "-": (30, js.subtract),
        "*": (40, js.multiply),
        "/": (40, js.divide),
        "//": (40, _floor_divide),
        "%": (50, js.remainder),
        "^": (50, js.power),
        "==": (20, js.loose_equals),
        "!=": (20, lambda a, b: not js.loose_equals(a, b)),
        ">": (20, lambda a, b: js.compare(a, b, lambda x, y: x > y)),
        ">=": (20, lambda a, b: js.compare(a, b, lambda x, y: x >= y)),
        "<": (20, lambda a, b: js.compare(a, b, lambda x, y: x < y)),
        "<=": (20, lambda a, b: js.compare(a, b, lambda x, y: x <= y)),
        "in": (20, _in),
    }
    for symbol, (precedence, function) in operators.items():
        jexl.add_binary_operator(symbol, precedence, function)
    jexl.config.binary_operators["&&"] = Operator(
        "&&", 10, lambda left, right: (lambda value: right() if js.truthy(value) else value)(left()), evaluate_lazy=True
    )
    jexl.config.binary_operators["||"] = Operator(
        "||", 10, lambda left, right: (lambda value: value if js.truthy(value) else right())(left()), evaluate_lazy=True
    )
    jexl.add_unary_operator("!", lambda value: not js.truthy(value))
    return jexl


class JexlConditionEvaluator:
    """``ConditionEvaluator`` backed by JEXL."""

    def __init__(self) -> None:
        self._jexl = _create_jexl()

    def validate(self, expression: str) -> None:
        """Parse an expression without evaluating it (legacy operands become ``null``)."""
        if js_strings.trim(expression) == "":
            return
        jexl_parser.parse(_LEGACY_OPERAND.sub("null", expression))

    async def evaluate(self, expression: str, variables: dict[str, Any]) -> bool:
        if js_strings.trim(expression) == "":
            return True
        resolved = resolve_condition_expression(expression, variables)
        tree = jexl_parser.to_pyjexl(jexl_parser.parse(resolved), self._jexl.config)
        context = Context(variables)
        context.relative_value = variables  # jexl: the relative context defaults to the context
        value = _JsEvaluator(self._jexl.config).evaluate(tree, context)
        return js.truthy(value)
