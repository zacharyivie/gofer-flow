"""Pydantic types for configuration values resolved at workflow runtime."""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any, TypeAlias

from pydantic import AfterValidator, PlainSerializer, PlainValidator, WithJsonSchema

EXACT_RUNTIME_REFERENCE_JSON_SCHEMA: dict[str, object] = {
    "type": "string",
    "pattern": r"^\s*\{\{\s*[^{}]+?\s*\}\}\s*$",
}


def runtime_value_schema(native_schema: dict[str, object]) -> dict[str, object]:
    """Describe a native literal or one exact reference to authoring clients."""
    return {"anyOf": [native_schema, EXACT_RUNTIME_REFERENCE_JSON_SCHEMA]}


def runtime_literal_schema(*allowed: str) -> dict[str, object]:
    return runtime_value_schema({"type": "string", "enum": list(allowed)})


def is_exact_runtime_reference(value: object) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"\s*\{\{\s*[^{}]+?\s*\}\}\s*", value))


def _require_exact_runtime_reference(value: str) -> str:
    if not is_exact_runtime_reference(value):
        raise ValueError("value must be an exact runtime reference")
    return value


ExactRuntimeReference: TypeAlias = Annotated[str, AfterValidator(_require_exact_runtime_reference)]


def _runtime_bool(value: object) -> bool | str:
    if is_exact_runtime_reference(value):
        return str(value)
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.lower() in {"true", "false"}:
        return value.lower() == "true"
    raise ValueError("value must be a boolean or exact runtime reference")


def _runtime_int(value: object) -> int | str:
    if is_exact_runtime_reference(value):
        return str(value)
    if isinstance(value, bool):
        raise ValueError("value must be an integer or exact runtime reference")
    try:
        return int(str(value))
    except (TypeError, ValueError) as exc:
        raise ValueError("value must be an integer or exact runtime reference") from exc


def _runtime_float(value: object) -> float | str:
    if is_exact_runtime_reference(value):
        return str(value)
    if isinstance(value, bool):
        raise ValueError("value must be a number or exact runtime reference")
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise ValueError("value must be a number or exact runtime reference") from exc


def _runtime_string_list(value: object) -> list[str] | str:
    if is_exact_runtime_reference(value):
        return str(value)
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return value
    raise ValueError("value must be a string array or exact runtime reference")


def _runtime_int_list(value: object) -> list[int] | str:
    if is_exact_runtime_reference(value):
        return str(value)
    if isinstance(value, list) and all(
        isinstance(item, int) and not isinstance(item, bool) for item in value
    ):
        return value
    raise ValueError("value must be an integer array or exact runtime reference")


def _runtime_string_map(value: object) -> dict[str, str] | str:
    if is_exact_runtime_reference(value):
        return str(value)
    if isinstance(value, dict) and all(
        isinstance(key, str) and isinstance(item, str) for key, item in value.items()
    ):
        return value
    raise ValueError("value must be a string map or exact runtime reference")


def _runtime_object_map(value: object) -> dict[str, object] | str:
    if is_exact_runtime_reference(value):
        return str(value)
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return value
    raise ValueError("value must be an object or exact runtime reference")


def _runtime_object_list(value: object) -> list[dict[str, object]] | str:
    if is_exact_runtime_reference(value):
        return str(value)
    if isinstance(value, list) and all(isinstance(item, dict) for item in value):
        return value
    raise ValueError("value must be an object array or exact runtime reference")


def _runtime_path_list(value: object) -> list[Path] | str:
    if is_exact_runtime_reference(value):
        return str(value)
    if isinstance(value, list):
        paths = [item if isinstance(item, Path) else Path(str(item)) for item in value]
        if paths:
            return paths
        raise ValueError("path array must contain at least one path")
    raise ValueError("value must be a path array or exact runtime reference")


def runtime_literal_validator(*allowed: str) -> Callable[[object], str]:
    def validate(value: object) -> str:
        if isinstance(value, str) and (value in allowed or is_exact_runtime_reference(value)):
            return value
        choices = ", ".join(allowed)
        raise ValueError(f"value must be one of {choices}, or an exact runtime reference")

    return validate


# Plain validators deliberately allow the stored pre-execution value to be an
# exact reference while retaining the native annotation for static consumers.
_runtime_serializer = PlainSerializer(lambda value: value, return_type=Any)
RuntimeBool: TypeAlias = Annotated[
    bool,
    PlainValidator(_runtime_bool),
    _runtime_serializer,
    WithJsonSchema(runtime_value_schema({"type": "boolean"})),
]
RuntimeInt: TypeAlias = Annotated[
    int,
    PlainValidator(_runtime_int),
    _runtime_serializer,
    WithJsonSchema(runtime_value_schema({"type": "integer"})),
]
RuntimeFloat: TypeAlias = Annotated[
    float,
    PlainValidator(_runtime_float),
    _runtime_serializer,
    WithJsonSchema(runtime_value_schema({"type": "number"})),
]
RuntimeStringList: TypeAlias = Annotated[
    list[str],
    PlainValidator(_runtime_string_list),
    _runtime_serializer,
    WithJsonSchema(runtime_value_schema({"type": "array", "items": {"type": "string"}})),
]
RuntimeIntList: TypeAlias = Annotated[
    list[int],
    PlainValidator(_runtime_int_list),
    _runtime_serializer,
    WithJsonSchema(runtime_value_schema({"type": "array", "items": {"type": "integer"}})),
]
RuntimeStringMap: TypeAlias = Annotated[
    dict[str, str],
    PlainValidator(_runtime_string_map),
    _runtime_serializer,
    WithJsonSchema(
        runtime_value_schema({"type": "object", "additionalProperties": {"type": "string"}})
    ),
]
RuntimeObjectMap: TypeAlias = Annotated[
    dict[str, object],
    PlainValidator(_runtime_object_map),
    _runtime_serializer,
    WithJsonSchema(runtime_value_schema({"type": "object"})),
]
RuntimeObjectList: TypeAlias = Annotated[
    list[dict[str, object]],
    PlainValidator(_runtime_object_list),
    _runtime_serializer,
    WithJsonSchema(runtime_value_schema({"type": "array", "items": {"type": "object"}})),
]
RuntimePathList: TypeAlias = Annotated[
    list[Path],
    PlainValidator(_runtime_path_list),
    _runtime_serializer,
    WithJsonSchema(
        runtime_value_schema({"type": "array", "items": {"type": "string", "format": "path"}})
    ),
]
