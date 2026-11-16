"""The ``jexl`` (npm) grammar: its lexer and parser, producing pyjexl AST nodes.

pyjexl parses with its own PEG grammar, which accepts and rejects a few
expressions differently from the ``jexl`` package the TypeScript runtime uses
(``[1,2][1]``, unbalanced ``(1``, ``constructor``) and words its errors
differently. Validation errors reach run records and the CLI, so expressions
are parsed here the way ``jexl`` parses them (its ``Lexer``, ``Parser``,
parse states, and handlers, with the same error messages, including the
``TypeError``s its handlers raise on degenerate input) and the tree is
evaluated by pyjexl's evaluator.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from pyjexl import parser as ast

from .._js import json as js_json
from .._js.errors import Error, TypeError_
from .._js.regex import WS

# ─── Grammar ────────────────────────────────────────────────────────────────

#: ``grammar.elements``: element → type (in definition order).
ELEMENTS: dict[str, str] = {
    ".": "dot",
    "[": "openBracket",
    "]": "closeBracket",
    "|": "pipe",
    "{": "openCurl",
    "}": "closeCurl",
    ":": "colon",
    ",": "comma",
    "(": "openParen",
    ")": "closeParen",
    "?": "question",
    "+": "binaryOp",
    "-": "binaryOp",
    "*": "binaryOp",
    "/": "binaryOp",
    "//": "binaryOp",
    "%": "binaryOp",
    "^": "binaryOp",
    "==": "binaryOp",
    "!=": "binaryOp",
    ">": "binaryOp",
    ">=": "binaryOp",
    "<": "binaryOp",
    "<=": "binaryOp",
    "&&": "binaryOp",
    "||": "binaryOp",
    "in": "binaryOp",
    "!": "unaryOp",
}
PRECEDENCE: dict[str, float] = {
    "+": 30,
    "-": 30,
    "*": 40,
    "/": 40,
    "//": 40,
    "%": 50,
    "^": 50,
    "==": 20,
    "!=": 20,
    ">": 20,
    ">=": 20,
    "<": 20,
    "<=": 20,
    "&&": 10,
    "||": 10,
    "in": 20,
    "!": float("inf"),
}
#: Keys of ``Object.prototype``: ``grammar.elements[key]`` finds them, with no ``type``.
_PROTOTYPE_KEYS = frozenset(
    [
        "constructor",
        "__defineGetter__",
        "__defineSetter__",
        "hasOwnProperty",
        "__lookupGetter__",
        "__lookupSetter__",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "toString",
        "valueOf",
        "__proto__",
        "toLocaleString",
    ]
)

# ─── Lexer ──────────────────────────────────────────────────────────────────

_IDENT_CHARS = "a-zA-Z\u0430-\u044f\u0410-\u042f_\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u00ff$"
_NUMERIC = re.compile(r"^-?(?:(?:[0-9]*\.[0-9]+)|[0-9]+)\Z")
_IDENT = re.compile(f"^[{_IDENT_CHARS}][{_IDENT_CHARS}0-9]*\\Z")
_WHITESPACE = re.compile(f"^{WS}*\\Z")
_NEGATES_AFTER = ("binaryOp", "unaryOp", "openParen", "openBracket", "question", "colon")


def _escape(element: str) -> str:
    escaped = re.sub(r"[.*+?^${}()|[\]\\]", lambda match: "\\" + match.group(0), element)
    if _IDENT.match(element):
        escaped = f"\\b{escaped}\\b"
    return escaped


def _split_regex() -> re.Pattern[str]:
    # Longest elements first; equal lengths keep their definition order (a stable sort).
    elements = sorted(ELEMENTS, key=len, reverse=True)
    pre = ["'(?:(?:\\\\')|[^'])*'", '"(?:(?:\\\\")|[^"])*"', f"{WS}+", r"\btrue\b", r"\bfalse\b"]
    post = [f"[{_IDENT_CHARS}][{_IDENT_CHARS}0-9]*", r"(?:(?:[0-9]*\.[0-9]+)|[0-9]+)"]
    return re.compile(
        "(" + "|".join(["|".join(pre), "|".join(_escape(e) for e in elements), "|".join(post)]) + ")", re.ASCII
    )


_SPLIT = _split_regex()


@dataclass
class Token:
    type: str | None
    value: Any
    raw: str


def _unquote(text: str) -> str:
    quote = text[0]
    inner = text[1:-1].replace("\\" + quote, quote)
    return inner.replace("\\\\", "\\", 1)


def _create_token(element: str) -> Token:
    token = Token("literal", element, element)
    if element[0] in ('"', "'"):
        token.value = _unquote(element)
    elif _NUMERIC.match(element):
        token.value = js_json.normalize(_parse_float(element))
    elif element in ("true", "false"):
        token.value = element == "true"
    elif element in ELEMENTS:
        token.type = ELEMENTS[element]
    elif element in _PROTOTYPE_KEYS:
        token.type = None
    elif _IDENT.match(element):
        token.type = "identifier"
    else:
        raise Error(f"Invalid expression token: {element}")
    return token


def _parse_float(text: str) -> float:
    return float(text)


def tokenize(expression: str) -> list[Token]:
    """``Lexer.tokenize``."""
    elements = [element for element in _SPLIT.split(expression) if element]
    tokens: list[Token] = []
    negate = False
    for element in elements:
        if _WHITESPACE.match(element):
            if tokens:
                tokens[-1].raw += element
        elif element == "-" and (not tokens or tokens[-1].type in _NEGATES_AFTER):
            negate = True
        else:
            if negate:
                element = "-" + element
                negate = False
            tokens.append(_create_token(element))
    if negate:
        tokens.append(_create_token("-"))
    return tokens


# ─── Parser ─────────────────────────────────────────────────────────────────


@dataclass(eq=False)
class Node:
    """A ``jexl`` AST node (a plain object in JavaScript)."""

    type: str
    fields: dict[str, Any] = field(default_factory=dict)
    parent: Any = None

    def __getitem__(self, key: str) -> Any:
        return self.fields.get(key)

    def __setitem__(self, key: str, value: Any) -> None:
        self.fields[key] = value


_UNDEFINED = object()

_STATES: dict[str, dict[str, Any]] = {
    "expectOperand": {
        "tokenTypes": {
            "literal": {"toState": "expectBinOp"},
            "identifier": {"toState": "identifier"},
            "unaryOp": {},
            "openParen": {"toState": "subExpression"},
            "openCurl": {"toState": "expectObjKey", "handler": "objStart"},
            "dot": {"toState": "traverse"},
            "openBracket": {"toState": "arrayVal", "handler": "arrayStart"},
        }
    },
    "expectBinOp": {
        "tokenTypes": {
            "binaryOp": {"toState": "expectOperand"},
            "pipe": {"toState": "expectTransform"},
            "dot": {"toState": "traverse"},
            "question": {"toState": "ternaryMid", "handler": "ternaryStart"},
        },
        "completable": True,
    },
    "expectTransform": {"tokenTypes": {"identifier": {"toState": "postTransform", "handler": "transform"}}},
    "expectObjKey": {
        "tokenTypes": {
            "identifier": {"toState": "expectKeyValSep", "handler": "objKey"},
            "closeCurl": {"toState": "expectBinOp"},
        }
    },
    "expectKeyValSep": {"tokenTypes": {"colon": {"toState": "objVal"}}},
    "postTransform": {
        "tokenTypes": {
            "openParen": {"toState": "argVal"},
            "binaryOp": {"toState": "expectOperand"},
            "dot": {"toState": "traverse"},
            "openBracket": {"toState": "filter"},
            "pipe": {"toState": "expectTransform"},
        },
        "completable": True,
    },
    "postArgs": {
        "tokenTypes": {
            "binaryOp": {"toState": "expectOperand"},
            "dot": {"toState": "traverse"},
            "openBracket": {"toState": "filter"},
            "pipe": {"toState": "expectTransform"},
        },
        "completable": True,
    },
    "identifier": {
        "tokenTypes": {
            "binaryOp": {"toState": "expectOperand"},
            "dot": {"toState": "traverse"},
            "openBracket": {"toState": "filter"},
            "openParen": {"toState": "argVal", "handler": "functionCall"},
            "pipe": {"toState": "expectTransform"},
            "question": {"toState": "ternaryMid", "handler": "ternaryStart"},
        },
        "completable": True,
    },
    "traverse": {"tokenTypes": {"identifier": {"toState": "identifier"}}},
    "filter": {"subHandler": "filter", "endStates": {"closeBracket": "identifier"}},
    "subExpression": {"subHandler": "subExpression", "endStates": {"closeParen": "expectBinOp"}},
    "argVal": {"subHandler": "argVal", "endStates": {"comma": "argVal", "closeParen": "postArgs"}},
    "objVal": {"subHandler": "objVal", "endStates": {"comma": "expectObjKey", "closeCurl": "expectBinOp"}},
    "arrayVal": {"subHandler": "arrayVal", "endStates": {"comma": "arrayVal", "closeBracket": "expectBinOp"}},
    "ternaryMid": {"subHandler": "ternaryMid", "endStates": {"colon": "ternaryEnd"}},
    "ternaryEnd": {"subHandler": "ternaryEnd", "completable": True},
}


def _read(target: Any, key: str) -> Any:
    """``target[key]`` with V8's error for ``null``/``undefined`` targets."""
    if target is None or target is _UNDEFINED:
        kind = "null" if target is None else "undefined"
        raise TypeError_(f"Cannot read properties of {kind} (reading '{key}')")
    return target[key] if key != "_parent" else target.parent


class Parser:
    """``Parser``: a state machine fed one token at a time."""

    def __init__(self, prefix: str = "", stop_map: dict[str, str] | None = None) -> None:
        self.state = "expectOperand"
        self.tree: Any = None
        self.expr = prefix
        self.relative = False
        self.stop_map = stop_map or {}
        self.cursor: Any = _UNDEFINED
        self.sub: Parser | None = None
        self.parent_stop = False
        self.next_ident_encapsulate: Any = False
        self.next_ident_relative: Any = False
        self.obj_key: Any = None

    def add_token(self, token: Token) -> str | bool:
        if self.state == "complete":
            raise Error("Cannot add a new token to a completed Parser")
        state = _STATES[self.state]
        start = self.expr
        self.expr += token.raw
        if "subHandler" in state:
            if self.sub is None:
                self._start_sub(start)
            assert self.sub is not None
            stop = self.sub.add_token(token)
            if stop:
                self._end_sub()
                if self.parent_stop:
                    return stop
                self.state = str(stop)
        elif token.type is not None and token.type in state["tokenTypes"]:
            options = state["tokenTypes"][token.type]
            handler = options.get("handler", token.type)
            method = getattr(self, f"_h_{handler}", None)
            if method is not None:
                method(token)
            if "toState" in options:
                self.state = options["toState"]
        elif token.type is not None and token.type in self.stop_map:
            return self.stop_map[token.type]
        else:
            kind = "undefined" if token.type is None else token.type
            raise Error(f"Token {token.raw} ({kind}) unexpected in expression: {self.expr}")
        return False

    def complete(self) -> Any:
        if _truthy(self.cursor) and not _STATES[self.state].get("completable"):
            raise Error(f"Unexpected end of expression: {self.expr}")
        if self.sub is not None:
            self._end_sub()
        self.state = "complete"
        return self.tree if _truthy(self.cursor) else None

    def _end_sub(self) -> None:
        assert self.sub is not None
        result = self.sub.complete()
        getattr(self, f"_s_{_STATES[self.state]['subHandler']}")(result)
        self.sub = None

    def _start_sub(self, expression: str) -> None:
        end_states = _STATES[self.state].get("endStates")
        if not end_states:
            self.parent_stop = True
            end_states = self.stop_map
        self.sub = Parser(expression, end_states)

    def _place_at_cursor(self, node: Any) -> None:
        if not _truthy(self.cursor):
            self.tree = node
        else:
            self.cursor["right"] = node
            _set_parent(node, self.cursor)
        self.cursor = node

    def _place_before_cursor(self, node: Any) -> None:
        self.cursor = _read(self.cursor, "_parent")
        self._place_at_cursor(node)

    # ── token handlers ──
    def _h_arrayStart(self, _token: Token) -> None:
        self._place_at_cursor(Node("ArrayLiteral", {"value": []}))

    def _h_binaryOp(self, token: Token) -> None:
        precedence = PRECEDENCE.get(token.value, 0)
        parent = _read(self.cursor, "_parent")
        while (
            parent is not None
            and parent is not _UNDEFINED
            and parent["operator"]
            and PRECEDENCE[parent["operator"]] >= precedence
        ):
            self.cursor = parent
            parent = parent.parent
        node = Node("BinaryExpression", {"operator": token.value, "left": self.cursor})
        _set_parent(self.cursor, node)
        self.cursor = parent
        self._place_at_cursor(node)

    def _h_dot(self, _token: Token) -> None:
        cursor = self.cursor
        self.next_ident_encapsulate = (
            _truthy(cursor)
            and cursor.type != "UnaryExpression"
            and (cursor.type != "BinaryExpression" or (cursor.type == "BinaryExpression" and _truthy(cursor["right"])))
        )
        self.next_ident_relative = (not _truthy(cursor)) or (_truthy(cursor) and not self.next_ident_encapsulate)
        if self.next_ident_relative:
            self.relative = True

    def _h_functionCall(self, _token: Token) -> None:
        name = _read(self.cursor, "value")
        self._place_before_cursor(Node("FunctionCall", {"name": name, "args": [], "pool": "functions"}))

    def _h_identifier(self, token: Token) -> None:
        node = Node("Identifier", {"value": token.value})
        if self.next_ident_encapsulate:
            node["from"] = self.cursor
            self._place_before_cursor(node)
            self.next_ident_encapsulate = False
        else:
            if self.next_ident_relative:
                node["relative"] = True
                self.next_ident_relative = False
            self._place_at_cursor(node)

    def _h_literal(self, token: Token) -> None:
        self._place_at_cursor(Node("Literal", {"value": token.value}))

    def _h_objKey(self, token: Token) -> None:
        self.obj_key = token.value

    def _h_objStart(self, _token: Token) -> None:
        self._place_at_cursor(Node("ObjectLiteral", {"value": {}}))

    def _h_ternaryStart(self, _token: Token) -> None:
        self.tree = Node("ConditionalExpression", {"test": self.tree})
        self.cursor = self.tree

    def _h_transform(self, token: Token) -> None:
        self._place_before_cursor(
            Node("FunctionCall", {"name": token.value, "args": [self.cursor], "pool": "transforms"})
        )

    def _h_unaryOp(self, token: Token) -> None:
        self._place_at_cursor(Node("UnaryExpression", {"operator": token.value}))

    # ── sub-expression handlers ──
    def _s_argVal(self, node: Any) -> None:
        if _truthy(node):
            _read(self.cursor, "args").append(node)

    def _s_arrayVal(self, node: Any) -> None:
        if _truthy(node):
            _read(self.cursor, "value").append(node)

    def _s_filter(self, node: Any) -> None:
        assert self.sub is not None
        self._place_before_cursor(
            Node("FilterExpression", {"expr": node, "relative": self.sub.relative, "subject": self.cursor})
        )

    def _s_objVal(self, node: Any) -> None:
        _read(self.cursor, "value")[self.obj_key] = node

    def _s_subExpression(self, node: Any) -> None:
        self._place_at_cursor(node)

    def _s_ternaryEnd(self, node: Any) -> None:
        _read(self.cursor, "value")  # a missing cursor fails like the property write
        self.cursor["alternate"] = node

    def _s_ternaryMid(self, node: Any) -> None:
        _read(self.cursor, "value")
        self.cursor["consequent"] = node


def _truthy(value: Any) -> bool:
    return value is not None and value is not _UNDEFINED and value is not False


def _set_parent(node: Any, parent: Any) -> None:
    """``Object.defineProperty(node, '_parent', ...)``."""
    if not isinstance(node, Node):
        raise TypeError_("Object.defineProperty called on non-object")
    node.parent = parent


def parse(expression: str) -> Any:
    """``Jexl.compile``: the ``jexl`` AST (``None`` for an empty expression)."""
    parser = Parser()
    for token in tokenize(expression):
        parser.add_token(token)
    return parser.complete()


# ─── pyjexl AST ─────────────────────────────────────────────────────────────


class Missing(ast.Node):
    """A subtree that is ``null``/``undefined`` in the ``jexl`` AST; evaluating it fails like V8."""

    fields = ["kind"]  # noqa: RUF012 - pyjexl node fields


def to_pyjexl(node: Any, config: Any) -> Any:
    """The ``jexl`` AST as pyjexl nodes (evaluated by pyjexl's ``Evaluator``)."""
    if node is None or node is _UNDEFINED:
        return Missing("null" if node is None else "undefined")
    kind = node.type
    fields = node.fields
    if kind == "Literal":
        return ast.Literal(fields["value"])
    if kind == "Identifier":
        subject = fields.get("from")
        return ast.Identifier(
            fields["value"],
            subject=to_pyjexl(subject, config) if subject is not None else None,
            relative=bool(fields.get("relative")),
        )
    if kind == "BinaryExpression":
        return ast.BinaryExpression(
            config.binary_operators[fields["operator"]],
            to_pyjexl(fields.get("left", _UNDEFINED), config),
            to_pyjexl(fields.get("right", _UNDEFINED), config),
        )
    if kind == "UnaryExpression":
        return ast.UnaryExpression(
            config.unary_operators[fields["operator"]], to_pyjexl(fields.get("right", _UNDEFINED), config)
        )
    if kind == "ArrayLiteral":
        return ast.ArrayLiteral([to_pyjexl(item, config) for item in fields["value"]])
    if kind == "ObjectLiteral":
        return ast.ObjectLiteral({key: to_pyjexl(value, config) for key, value in fields["value"].items()})
    if kind == "FilterExpression":
        return ast.FilterExpression(
            to_pyjexl(fields.get("expr"), config),
            to_pyjexl(fields.get("subject"), config),
            relative=bool(fields.get("relative")),
        )
    if kind == "ConditionalExpression":
        consequent = fields.get("consequent", _UNDEFINED)
        return ast.ConditionalExpression(
            to_pyjexl(fields.get("test"), config),
            None if not _truthy(consequent) else to_pyjexl(consequent, config),
            to_pyjexl(fields.get("alternate", _UNDEFINED), config),
        )
    if kind == "FunctionCall":
        args = [to_pyjexl(arg, config) for arg in fields["args"]]
        if fields["pool"] == "transforms":
            return ast.Transform(fields["name"], args=args[1:], subject=args[0])
        return ast.Function(fields["name"], args)
    raise Error(f"Corrupt AST: unknown node type {kind}")
