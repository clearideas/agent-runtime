"""Port of ``packages/condition-jexl/src/index.test.ts``, plus jexl's error messages (as ``jexl`` reports them)."""

from __future__ import annotations

import pytest

from clearideas_agent_runtime._js.errors import Error, TypeError_
from clearideas_agent_runtime.conditions import JexlConditionEvaluator, resolve_condition_expression


async def test_evaluates_direct_jexl_expressions_against_variables() -> None:
    evaluator = JexlConditionEvaluator()
    assert await evaluator.evaluate("count >= 2 && enabled", {"count": 2, "enabled": True}) is True


async def test_supports_case_insensitive_nested_handlebars_operands() -> None:
    evaluator = JexlConditionEvaluator()
    variables = {"Result": {"Status": "ready"}, "attempts": "3"}
    expression = '{{ result.status }} == "ready" && {{ attempts }} >= 2'
    assert resolve_condition_expression(expression, variables) == '"ready" == "ready" && 3 >= 2'
    assert await evaluator.evaluate(expression, variables) is True


async def test_returns_true_for_a_blank_condition() -> None:
    assert await JexlConditionEvaluator().evaluate("  ", {}) is True


def test_validates_syntax_before_a_run_without_evaluating() -> None:
    evaluator = JexlConditionEvaluator()
    evaluator.validate("count >= 2 && enabled")
    evaluator.validate('{{ result.status }} == "ready"')
    evaluator.validate("")
    with pytest.raises(Error):
        evaluator.validate("status === ")
    with pytest.raises(Error):
        evaluator.validate("approved &&")


@pytest.mark.parametrize(
    ("expression", "message"),
    [
        ("status === ", "Invalid expression token: ="),
        ("approved &&", "Unexpected end of expression: approved &&"),
        ("a @ b", "Invalid expression token: @"),
        ("[1,2][1]", "Token [ (openBracket) unexpected in expression: [1,2]["),
        ("constructor == 1", "Token constructor  (undefined) unexpected in expression: constructor "),
    ],
)
def test_reports_jexl_syntax_errors(expression: str, message: str) -> None:
    with pytest.raises(Error) as caught:
        JexlConditionEvaluator().validate(expression)
    assert str(caught.value) == message


async def test_degenerate_trees_fail_like_v8() -> None:
    evaluator = JexlConditionEvaluator()
    evaluator.validate("(")
    with pytest.raises(TypeError_, match=r"Cannot read properties of null \(reading 'type'\)"):
        await evaluator.evaluate("(", {})
    with pytest.raises(TypeError_, match=r"Object\.defineProperty called on non-object"):
        evaluator.validate("1 + ()")
    assert await evaluator.evaluate("(1", {}) is True
