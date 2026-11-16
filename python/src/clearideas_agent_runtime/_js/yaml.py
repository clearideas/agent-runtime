"""YAML parsing that matches the ``yaml`` npm package's ``parse`` (YAML 1.2 core schema).

``ruamel.yaml`` is configured with the YAML 1.2 core schema resolvers from the
specification (section 10.3.2); keys are converted to strings as JavaScript
objects require, unknown tags keep their plain value, and duplicate keys and
multiple documents are rejected.
"""

from __future__ import annotations

import re
from typing import Any

from ruamel.yaml import YAML
from ruamel.yaml.constructor import ConstructorError, SafeConstructor
from ruamel.yaml.error import YAMLError
from ruamel.yaml.nodes import MappingNode, ScalarNode, SequenceNode
from ruamel.yaml.resolver import BaseResolver

from . import json as js_json


class YamlParseError(ValueError):
    """The document is not valid YAML for the runtime."""


class CoreSchemaResolver(BaseResolver):
    def __init__(self, version: Any = None, loader: Any = None, loadumper: Any = None) -> None:
        super().__init__(loader if loader is not None else loadumper)

    @property
    def processing_version(self) -> tuple[int, int]:
        return (1, 2)


_add = CoreSchemaResolver.add_implicit_resolver_base
_add("tag:yaml.org,2002:null", re.compile(r"^(?:~|null|Null|NULL|)$"), [*"~nN", ""])
_add("tag:yaml.org,2002:bool", re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$"), list("tTfF"))
_add(
    "tag:yaml.org,2002:int",
    re.compile(r"^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$"),
    list("-+0123456789"),
)
_add(
    "tag:yaml.org,2002:float",
    re.compile(
        r"^(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?"
        r"|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$"
    ),
    list("-+0123456789."),
)


def _key_string(key: Any) -> str:
    if isinstance(key, str):
        return key
    if key is None:
        return ""
    if key is True:
        return "true"
    if key is False:
        return "false"
    if isinstance(key, (int, float)):
        return js_json.number_to_string(js_json.normalize(key))
    if isinstance(key, (list, tuple)):
        return "[ " + ", ".join(_key_string(item) for item in key) + " ]"
    return str(key)


class CoreSchemaConstructor(SafeConstructor):
    def construct_yaml_int(self, node: Any) -> Any:
        text = self.construct_scalar(node).replace("_", "")
        sign = -1 if text.startswith("-") else 1
        digits = text.lstrip("+-")
        if digits.startswith("0x"):
            return js_json.normalize(sign * int(digits[2:], 16))
        if digits.startswith("0o"):
            return js_json.normalize(sign * int(digits[2:], 8))
        return js_json.normalize(sign * int(digits, 10))

    def construct_yaml_float(self, node: Any) -> Any:
        text = self.construct_scalar(node).lower()
        if text in (".inf", "+.inf"):
            return float("inf")
        if text == "-.inf":
            return float("-inf")
        if text == ".nan":
            return float("nan")
        return js_json.normalize(float(text))

    def construct_mapping(self, node: Any, deep: bool = False) -> Any:  # type: ignore[override]
        if not isinstance(node, MappingNode):
            raise ConstructorError(None, None, f"expected a mapping node, but found {node.id}", node.start_mark)
        mapping: dict[str, Any] = {}
        for key_node, value_node in node.value:
            key = _key_string(self.construct_object(key_node, deep=True))
            if key in mapping:
                raise ConstructorError(
                    "while constructing a mapping",
                    node.start_mark,
                    f"Map keys must be unique: {key!r}",
                    key_node.start_mark,
                )
            mapping[key] = self.construct_object(value_node, deep=deep)
        return mapping

    def construct_yaml_map(self, node: Any) -> Any:
        data: dict[str, Any] = {}
        yield data
        data.update(self.construct_mapping(node, deep=True))

    def construct_unknown(self, node: Any) -> Any:
        """Unknown tags keep the plain value (the ``yaml`` package warns and does the same)."""
        if isinstance(node, ScalarNode):
            return self.construct_scalar(node)
        if isinstance(node, SequenceNode):
            return [self.construct_object(child, deep=True) for child in node.value]
        return self.construct_mapping(node, deep=True)


CoreSchemaConstructor.add_constructor("tag:yaml.org,2002:int", CoreSchemaConstructor.construct_yaml_int)
CoreSchemaConstructor.add_constructor("tag:yaml.org,2002:float", CoreSchemaConstructor.construct_yaml_float)
CoreSchemaConstructor.add_constructor("tag:yaml.org,2002:map", CoreSchemaConstructor.construct_yaml_map)
CoreSchemaConstructor.add_constructor(None, CoreSchemaConstructor.construct_unknown)


def _yaml() -> YAML:
    loader = YAML(typ="safe", pure=True)
    loader.Resolver = CoreSchemaResolver
    loader.Constructor = CoreSchemaConstructor
    return loader


def parse(text: str) -> Any:
    """``parse`` from the ``yaml`` package: one document, JSON-compatible values."""
    try:
        return _yaml().load(text)
    except YAMLError as error:
        raise YamlParseError(str(error)) from error


def dump(value: Any) -> str:
    """YAML text for JSON values (used for human-facing output only)."""
    import io

    emitter = YAML(typ="safe", pure=True)
    emitter.default_flow_style = False
    emitter.sort_base_mapping_type_on_output = False  # type: ignore[attr-defined]
    stream = io.StringIO()
    emitter.dump(value, stream)
    return stream.getvalue()
