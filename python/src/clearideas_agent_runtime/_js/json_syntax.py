"""V8's ``JSON.parse`` syntax-error messages.

``JSON.parse`` error text reaches persisted data (for example the error of a
tool call whose arguments are not valid JSON), so the Python runtime reports
the message V8 reports. ``v8_syntax_error`` re-scans invalid input the way V8's
``JsonParser`` does (token by token, tracking the same cursor) and formats the
message from V8's templates. Positions count UTF-16 code units.
"""

from __future__ import annotations

_WHITESPACE = frozenset(" \t\n\r")
_MAX_CONTEXT = 10
_MIN_LENGTH_FOR_CONTEXT = _MAX_CONTEXT * 2 + 1
_SPECIAL = frozenset(("[object Object]", "undefined", "Infinity", "NaN"))

_EOS = "EOS"
_NUMBER = "NUMBER"
_STRING = "STRING"
_ILLEGAL = "ILLEGAL"


def _token(unit: int | None) -> str:
    if unit is None:
        return _EOS
    if unit > 0xFF:
        return _ILLEGAL
    character = chr(unit)
    if character == '"':
        return _STRING
    if character == "-" or "0" <= character <= "9":
        return _NUMBER
    return {
        "{": "LBRACE",
        "}": "RBRACE",
        "[": "LBRACK",
        "]": "RBRACK",
        "t": "TRUE",
        "f": "FALSE",
        "n": "NULL",
        ":": "COLON",
        ",": "COMMA",
        " ": "WHITESPACE",
        "\t": "WHITESPACE",
        "\n": "WHITESPACE",
        "\r": "WHITESPACE",
    }.get(character, _ILLEGAL)


class _Failure(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


_AT = " in JSON at position {position} (line {line} column {column})"
TEMPLATES = {
    "ExpectedPropNameOrRBrace": "Expected property name or '}'" + _AT,
    "ExpectedCommaOrRBrack": "Expected ',' or ']' after array element" + _AT,
    "ExpectedCommaOrRBrace": "Expected ',' or '}' after property value" + _AT,
    "ExpectedColonAfterPropertyName": "Expected ':' after property name" + _AT,
    "ExpectedDoubleQuotedPropertyName": "Expected double-quoted property name" + _AT,
    "ExponentPartMissingNumber": "Exponent part is missing a number" + _AT,
    "UnterminatedString": "Unterminated string" + _AT,
    "BadControlCharacter": "Bad control character in string literal" + _AT,
    "BadUnicodeEscape": "Bad Unicode escape" + _AT,
    "BadEscapedCharacter": "Bad escaped character" + _AT,
    "NoNumberAfterMinusSign": "No number after minus sign" + _AT,
    "UnterminatedFractionalNumber": "Unterminated fractional number" + _AT,
    "UnexpectedNonWhiteSpaceCharacter": "Unexpected non-whitespace character after JSON at position {position}"
    + " (line {line} column {column})",
    "UnexpectedTokenNumber": "Unexpected number" + _AT,
    "UnexpectedTokenString": "Unexpected string" + _AT,
}


class _Scanner:
    def __init__(self, text: str) -> None:
        encoded = text.encode("utf-16-le", "surrogatepass")
        self.units = [int.from_bytes(encoded[i : i + 2], "little") for i in range(0, len(encoded), 2)]
        self.text = text
        self.cursor = 0

    # ── cursor ──
    def current(self) -> int | None:
        return self.units[self.cursor] if self.cursor < len(self.units) else None

    def next_character(self) -> int | None:
        self.cursor += 1
        return self.current()

    def skip_whitespace(self) -> None:
        while self.cursor < len(self.units) and chr(self.units[self.cursor]) in _WHITESPACE:
            self.cursor += 1

    def peek(self) -> str:
        self.skip_whitespace()
        return _token(self.current())

    def _string(self, start: int, end: int) -> str:
        data = b"".join(unit.to_bytes(2, "little") for unit in self.units[start:end])
        return data.decode("utf-16-le", "surrogatepass")

    # ── errors ──
    def _location(self) -> tuple[int, int]:
        line, last_break, index = 1, 0, 0
        end = self.cursor
        while index < end:
            unit = self.units[index]
            if unit == 0x0D and index < end - 1 and self.units[index + 1] == 0x0A:
                index += 1
                unit = 0x0A
            if unit in (0x0D, 0x0A):
                line += 1
                last_break = index + 1
            index += 1
        return line, 1 + index - last_break

    def fail(self, token: str, template: str | None = None) -> _Failure:
        position = self.cursor
        line, column = self._location()
        if template is None:
            if token == _EOS:
                return _Failure("Unexpected end of JSON input")
            if token == _NUMBER:
                template = "UnexpectedTokenNumber"
            elif token == _STRING:
                template = "UnexpectedTokenString"
            else:
                return _Failure(self._unexpected_token(position))
        message = TEMPLATES[template].replace("{position}", str(position))
        return _Failure(message.replace("{line}", str(line)).replace("{column}", str(column)))

    def _unexpected_token(self, position: int) -> str:
        if self.text in _SPECIAL:
            return f'"{self.text}" is not valid JSON'
        character = self._string(position, position + 1)
        length = len(self.units)
        if length < _MIN_LENGTH_FOR_CONTEXT:
            return f"Unexpected token '{character}', \"{self.text}\" is not valid JSON"
        if position < _MAX_CONTEXT:
            context = self._string(0, position + _MAX_CONTEXT)
            return f"Unexpected token '{character}', \"{context}\"... is not valid JSON"
        if position < length - _MAX_CONTEXT:
            context = self._string(position - _MAX_CONTEXT, position + _MAX_CONTEXT)
            return f"Unexpected token '{character}', ...\"{context}\"... is not valid JSON"
        context = self._string(position - _MAX_CONTEXT, length)
        return f"Unexpected token '{character}', ...\"{context}\" is not valid JSON"

    def expect(self, token: str, template: str | None = None) -> None:
        found = self.peek()
        if found != token:
            raise self.fail(found, template)
        self.cursor += 1

    def check(self, token: str) -> bool:
        if self.peek() != token:
            return False
        self.cursor += 1
        return True

    # ── values ──
    def parse(self) -> None:
        stack: list[str] = []
        while True:
            # Produce a value.
            while True:
                token = self.peek()
                if token == _STRING:
                    self.cursor += 1
                    self.scan_string()
                elif token == _NUMBER:
                    self.scan_number()
                elif token == "LBRACE":
                    self.cursor += 1
                    if self.check("RBRACE"):
                        pass
                    else:
                        stack.append("object")
                        self.expect(_STRING, "ExpectedPropNameOrRBrace")
                        self.scan_string()
                        self.expect("COLON", "ExpectedColonAfterPropertyName")
                        continue
                elif token == "LBRACK":
                    self.cursor += 1
                    if self.check("RBRACK"):
                        pass
                    else:
                        stack.append("array")
                        continue
                elif token == "TRUE":
                    self.scan_literal("true")
                elif token == "FALSE":
                    self.scan_literal("false")
                elif token == "NULL":
                    self.scan_literal("null")
                else:
                    raise self.fail(token)
                break
            # Consume it.
            while True:
                if not stack:
                    token = self.peek()
                    if token != _EOS:
                        raise self.fail(token, "UnexpectedNonWhiteSpaceCharacter")
                    return
                if stack[-1] == "object":
                    if self.check("COMMA"):
                        self.expect(_STRING, "ExpectedDoubleQuotedPropertyName")
                        self.scan_string()
                        self.expect("COLON", "ExpectedColonAfterPropertyName")
                        break
                    self.expect("RBRACE", "ExpectedCommaOrRBrace")
                    stack.pop()
                    continue
                if self.check("COMMA"):
                    break
                self.expect("RBRACK", "ExpectedCommaOrRBrack")
                stack.pop()
                continue

    def scan_literal(self, literal: str) -> None:
        # The first character matched already.
        self.cursor += 1
        for expected in literal[1:]:
            unit = self.current()
            if unit is None:
                raise self.fail(_EOS)
            if unit != ord(expected):
                raise self.fail(_token(unit))
            self.cursor += 1

    def scan_string(self) -> None:
        """The cursor is after the opening quote."""
        while True:
            unit = self.current()
            if unit is None:
                raise self.fail(_ILLEGAL, "UnterminatedString")
            if unit == 0x22:
                self.cursor += 1
                return
            if unit == 0x5C:
                escaped = self.next_character()
                if escaped is None:
                    raise self.fail(_EOS)
                if escaped > 0xFF:
                    raise self.fail(_ILLEGAL)
                character = chr(escaped)
                if character == "u":
                    for _ in range(4):
                        digit = self.next_character()
                        if digit is None or chr(digit) not in "0123456789abcdefABCDEF":
                            raise self.fail(_ILLEGAL, "BadUnicodeEscape")
                elif character not in '"\\/bfnrt':
                    raise self.fail(_ILLEGAL, "BadEscapedCharacter")
                self.cursor += 1
                continue
            if unit < 0x20:
                raise self.fail(_ILLEGAL, "BadControlCharacter")
            self.cursor += 1

    def _is_digit(self, unit: int | None) -> bool:
        return unit is not None and 0x30 <= unit <= 0x39

    def _is_number_part(self, unit: int | None) -> bool:
        return unit is not None and unit <= 0xFF and chr(unit) in "0123456789.eE+-"

    def _advance_to_non_decimal(self) -> None:
        while self._is_digit(self.current()):
            self.cursor += 1

    def scan_number(self) -> None:
        unit = self.current()
        negative = False
        if unit == 0x2D:
            negative = True
            unit = self.next_character()
        if unit == 0x30:
            unit = self.next_character()
            if self._is_number_part(unit):
                if self._is_digit(unit):
                    raise self.fail(_NUMBER)
            elif not negative:
                return
        else:
            start = self.cursor
            self._advance_to_non_decimal()
            if start == self.cursor:
                raise self.fail(_ILLEGAL, "NoNumberAfterMinusSign")
            if not self._is_number_part(self.current()):
                return
        if self.current() == 0x2E:
            if not self._is_digit(self.next_character()):
                raise self.fail(_ILLEGAL, "UnterminatedFractionalNumber")
            self._advance_to_non_decimal()
        unit = self.current()
        if unit is not None and unit <= 0xFF and chr(unit) in "eE":
            unit = self.next_character()
            if unit in (0x2D, 0x2B):
                unit = self.next_character()
            if not self._is_digit(unit):
                raise self.fail(_ILLEGAL, "ExponentPartMissingNumber")
            self._advance_to_non_decimal()


def v8_syntax_error(text: str) -> str | None:
    """The message of the ``SyntaxError`` ``JSON.parse(text)`` throws in V8, or ``None`` if it parses."""
    scanner = _Scanner(text)
    try:
        scanner.parse()
    except _Failure as failure:
        return failure.message
    return None
