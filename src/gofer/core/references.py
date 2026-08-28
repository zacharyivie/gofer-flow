from __future__ import annotations

import re
from enum import StrEnum


class ReferenceNamespace(StrEnum):
    PARAMS = "params"
    INPUTS = "inputs"
    VARS = "vars"
    NODES = "nodes"
    TRIGGER = "trigger"
    LOOP = "loop"
    ITEM = "item"
    ITEMS = "items"
    PREVIOUS = "previous"
    WORKFLOW = "workflow"
    RUN = "run"
    SECRET = "secret"


REFERENCE_NAMESPACE_CAPABILITIES = [
    {"id": f"reference.{item.value}", "name": item.value} for item in ReferenceNamespace
] + [
    {"id": "reference.node", "name": "<node-id>"},
    {"id": "reference.input", "name": "<input-name>"},
]


# This registry is intentionally explicit. Every operation field resolved at
# runtime must be published here so parsers, authoring clients, and execution
# expose one reference contract.
REFERENCE_FIELD_CAPABILITIES: dict[str, tuple[str, ...]] = {
    "nodes.*.inputs.*": ("literal", "exact_typed_reference"),
    "nodes.*.for_each": ("exact_typed_reference",),
    "nodes.*.max_concurrency": ("literal", "exact_typed_reference"),
    "nodes.*.fail_fast": ("literal", "exact_typed_reference"),
    "nodes[type=pass].message": ("literal", "interpolation"),
    "nodes[type=fail].message": ("literal", "interpolation"),
    "nodes[type=break].message": ("literal", "interpolation"),
    "nodes[type=agent].agent_id": ("literal", "interpolation"),
    "nodes[type=agent].input_mapping.*": (
        "literal",
        "exact_typed_reference",
        "interpolation",
    ),
    "nodes[type=agent].input_mapping": ("literal", "exact_typed_reference"),
    "nodes[type=agent].dynamic_count": ("literal", "exact_typed_reference"),
    "nodes[type=agent].memory": ("literal", "exact_typed_reference"),
    "nodes[type=agent].timeout": ("literal", "exact_typed_reference"),
    "nodes[type=agent].repair_attempts": ("literal", "exact_typed_reference"),
    "nodes[type=agent].profile": ("literal", "interpolation"),
    "nodes[type=agent].model": ("literal", "interpolation"),
    "nodes[type=agent].effort": ("literal", "interpolation"),
    "nodes[type=agent].skill_name": ("literal", "interpolation"),
    "nodes[type=agent].output_schema": (
        "literal",
        "interpolation",
        "exact_typed_reference",
    ),
    "nodes[type=agent].fan_source.count": ("literal", "exact_typed_reference"),
    "nodes[type=agent].fan_source.max_concurrency": (
        "literal",
        "exact_typed_reference",
    ),
    "nodes[type=agent].fan_source.fail_fast": (
        "literal",
        "exact_typed_reference",
    ),
    "nodes[type=agent].fan_source.path": ("literal", "interpolation"),
    "nodes[type=agent].fan_source.glob": ("literal", "interpolation"),
    "nodes[type=agent].fan_source.include_content": (
        "literal",
        "exact_typed_reference",
    ),
    "nodes[type=common_llm_task].agent_id": ("literal", "interpolation"),
    "nodes[type=common_llm_task].input_mapping.*": (
        "literal",
        "exact_typed_reference",
        "interpolation",
    ),
    "nodes[type=common_llm_task].input_mapping": (
        "literal",
        "exact_typed_reference",
    ),
    "nodes[type=common_llm_task].target": ("literal", "interpolation"),
    "nodes[type=common_llm_task].instructions": ("literal", "interpolation"),
    "nodes[type=common_llm_task].task": ("literal", "exact_typed_reference"),
    "nodes[type=common_llm_task].memory": ("literal", "exact_typed_reference"),
    "nodes[type=common_llm_task].timeout": ("literal", "exact_typed_reference"),
    "nodes[type=common_llm_task].repair_attempts": (
        "literal",
        "exact_typed_reference",
    ),
    "nodes[type=common_llm_task].profile": ("literal", "interpolation"),
    "nodes[type=common_llm_task].model": ("literal", "interpolation"),
    "nodes[type=common_llm_task].effort": ("literal", "interpolation"),
    "nodes[type=common_llm_task].output_schema": (
        "literal",
        "interpolation",
        "exact_typed_reference",
    ),
    "nodes[type=common_llm_task].working_dir": ("literal", "interpolation"),
    "nodes[type=agent].working_dir": ("literal", "interpolation"),
    "nodes[type=agent].prompt_path": ("literal", "interpolation"),
    "nodes[type=bash_command].command": ("literal", "interpolation"),
    "nodes[type=bash_command].working_dir": ("literal", "interpolation"),
    "nodes[type=bash_command].env.*": ("literal", "interpolation"),
    "nodes[type=bash_command].env": ("literal", "exact_typed_reference"),
    "nodes[type=python_script].script_path": ("literal", "interpolation"),
    "nodes[type=python_script].args": ("literal", "exact_typed_reference"),
    "nodes[type=python_script].env": ("literal", "exact_typed_reference"),
    "nodes[type=python_script].args.*": ("literal", "interpolation"),
    "nodes[type=python_script].env.*": ("literal", "interpolation"),
    "nodes[type=shell_script].args.*": ("literal", "interpolation"),
    "nodes[type=shell_script].script_path": ("literal", "interpolation"),
    "nodes[type=shell_script].args": ("literal", "exact_typed_reference"),
    "nodes[type=shell_script].env": ("literal", "exact_typed_reference"),
    "nodes[type=shell_script].env.*": ("literal", "interpolation"),
    "nodes[type=read_file].path": ("literal", "interpolation"),
    "nodes[type=read_file].encoding": ("literal", "interpolation"),
    "nodes[type=read_file].errors": ("literal", "interpolation"),
    "nodes[type=write_file].path": ("literal", "interpolation"),
    "nodes[type=write_file].content": ("literal", "interpolation"),
    "nodes[type=write_file].encoding": ("literal", "interpolation"),
    "nodes[type=copy_file].source_path": ("literal", "interpolation"),
    "nodes[type=copy_file].destination_path": ("literal", "interpolation"),
    "nodes[type=move_file].source_path": ("literal", "interpolation"),
    "nodes[type=move_file].destination_path": ("literal", "interpolation"),
    "nodes[type=delete_file].path": ("literal", "interpolation"),
    "nodes[type=file].path": ("literal", "interpolation"),
    "nodes[type=folder].path": ("literal", "interpolation"),
    "nodes[type=open_resource].target": ("literal", "interpolation"),
    "nodes[type=workflow].workflow_id": ("literal", "interpolation"),
    "nodes[type=subflow].parameter_bindings.*": ("literal", "interpolation"),
    "nodes[type=subflow].parameter_bindings": ("literal", "exact_typed_reference"),
    "nodes[type=subflow].input_bindings.*": ("literal", "interpolation"),
    "nodes[type=subflow].input_bindings": ("literal", "exact_typed_reference"),
    "nodes[type=workflow].input_bindings.*": ("literal", "interpolation"),
    "nodes[type=workflow].input_bindings": ("literal", "exact_typed_reference"),
    "nodes[type=subflow].component_id": ("literal", "interpolation"),
    "nodes[type=subflow].version": ("literal", "interpolation"),
    "nodes[type=subflow].source_path": ("literal", "interpolation"),
    "nodes[type=approval_gate].message": ("literal", "interpolation"),
    "nodes[type=approval_gate].notification_title": ("literal", "interpolation"),
    "nodes[type=approval_gate].subject": ("literal", "exact_typed_reference"),
    "nodes[type=approval_gate].approvers.*": ("literal", "interpolation"),
    "nodes[type=approval_gate].timeout_seconds": ("literal", "exact_typed_reference"),
    "nodes[type=approval_gate].timeout_decision": ("literal", "exact_typed_reference"),
    "nodes[type=approval_gate].notify": ("literal", "exact_typed_reference"),
    "nodes[type=http_request].method": ("literal", "interpolation"),
    "nodes[type=http_request].url": ("literal", "interpolation"),
    "nodes[type=http_request].headers.*": ("literal", "interpolation"),
    "nodes[type=http_request].headers": ("literal", "exact_typed_reference"),
    "nodes[type=http_request].params.*": ("literal", "interpolation"),
    "nodes[type=http_request].params": ("literal", "exact_typed_reference"),
    "nodes[type=http_request].json.*": ("literal", "interpolation"),
    "nodes[type=http_request].json": ("literal", "exact_typed_reference"),
    "nodes[type=http_request].body": ("literal", "interpolation"),
    "nodes[type=http_request].timeout_seconds": ("literal", "exact_typed_reference"),
    "nodes[type=http_request].retry.*": ("literal", "exact_typed_reference"),
    "nodes[type=http_request].expected_statuses": ("literal", "exact_typed_reference"),
    "nodes[type=http_request].network_allowlist": ("literal", "exact_typed_reference"),
    "nodes[type=http_request].response_mode": ("literal", "exact_typed_reference"),
    "nodes[type=http_request].output_mapping": ("literal", "exact_typed_reference"),
    "nodes[type=http_request].output_mapping.*": ("literal", "interpolation"),
    "nodes[type=http_request].secret_fields": ("literal", "exact_typed_reference"),
    "nodes[type=http_request].secret_fields.*": ("literal", "interpolation"),
    "nodes[type=http_request].network_allowlist.*": ("literal", "interpolation"),
    "nodes[type=notification].title": ("literal", "interpolation"),
    "nodes[type=notification].body": ("literal", "interpolation"),
    "nodes[type=notification].channel": ("literal", "exact_typed_reference"),
    "nodes[type=notification].urgency": ("literal", "exact_typed_reference"),
    "nodes[type=notification].webhook_url": ("literal", "interpolation"),
    "nodes[type=notification].headers.*": ("literal", "interpolation"),
    "nodes[type=notification].headers": ("literal", "exact_typed_reference"),
    "nodes[type=notification].payload.*": ("literal", "interpolation"),
    "nodes[type=notification].payload": ("literal", "exact_typed_reference"),
    "nodes[type=notification].email_from": ("literal", "interpolation"),
    "nodes[type=notification].email_to.*": ("literal", "interpolation"),
    "nodes[type=notification].email_to": ("literal", "exact_typed_reference"),
    "nodes[type=notification].smtp_host": ("literal", "interpolation"),
    "nodes[type=notification].smtp_username": ("literal", "interpolation"),
    "nodes[type=notification].smtp_password": ("literal", "interpolation"),
    "nodes[type=notification].smtp_port": ("literal", "exact_typed_reference"),
    "nodes[type=notification].smtp_starttls": ("literal", "exact_typed_reference"),
    "nodes[type=notification].timeout_seconds": ("literal", "exact_typed_reference"),
    "nodes[type=notification].retry.*": ("literal", "exact_typed_reference"),
    "nodes[type=notification].expected_statuses": ("literal", "exact_typed_reference"),
    "nodes[type=notification].network_allowlist": ("literal", "exact_typed_reference"),
    "nodes[type=notification].network_allowlist.*": ("literal", "interpolation"),
    "nodes[type=loop].source.count": ("literal", "exact_typed_reference"),
    "nodes[type=loop].source.max_concurrency": ("literal", "exact_typed_reference"),
    "nodes[type=loop].source.fail_fast": ("literal", "exact_typed_reference"),
    "nodes[type=loop].source.path": ("literal", "interpolation"),
    "nodes[type=loop].source.glob": ("literal", "interpolation"),
    "nodes[type=loop].source.include_content": ("literal", "exact_typed_reference"),
    "nodes[type=prompt_file].variables.*": ("literal", "exact_typed_reference"),
    "nodes[type=prompt_file].template": ("literal", "interpolation"),
    "nodes[type=prompt_file].template_path": ("literal", "interpolation"),
    "nodes[type=prompt_file].output_path": ("literal", "interpolation"),
    "nodes[type=prompt_file].variables": ("literal", "exact_typed_reference"),
    "nodes[type=prompt_file].encoding": ("literal", "interpolation"),
    "nodes[type=prompt_file].create_dirs": ("literal", "exact_typed_reference"),
    "nodes[type=prompt_file].overwrite": ("literal", "exact_typed_reference"),
    "nodes[type=write_file].create_dirs": ("literal", "exact_typed_reference"),
    "nodes[type=write_file].overwrite": ("literal", "exact_typed_reference"),
    "nodes[type=write_file].append": ("literal", "exact_typed_reference"),
    "nodes[type=copy_file].create_dirs": ("literal", "exact_typed_reference"),
    "nodes[type=copy_file].overwrite": ("literal", "exact_typed_reference"),
    "nodes[type=move_file].create_dirs": ("literal", "exact_typed_reference"),
    "nodes[type=move_file].overwrite": ("literal", "exact_typed_reference"),
    "nodes[type=delete_file].use_trash": ("literal", "exact_typed_reference"),
    "nodes[type=delete_file].recursive": ("literal", "exact_typed_reference"),
    "nodes[type=delete_file].missing_ok": ("literal", "exact_typed_reference"),
    "nodes[type=open_resource].resource_type": ("literal", "exact_typed_reference"),
    "nodes[type=open_resource].args": ("literal", "exact_typed_reference"),
    "nodes[type=open_resource].args.*": ("literal", "interpolation"),
    "nodes[type=local_vectorize].source_path": ("literal", "interpolation"),
    "nodes[type=local_vectorize].index_path": ("literal", "interpolation"),
    "nodes[type=local_vectorize].glob": ("literal", "interpolation"),
    "nodes[type=local_vectorize].encoding": ("literal", "interpolation"),
    "nodes[type=local_vectorize].embedding_strategy": ("literal", "interpolation"),
    "nodes[type=local_vectorize].search_strategy": ("literal", "interpolation"),
    "nodes[type=local_vectorize].recursive": ("literal", "exact_typed_reference"),
    "nodes[type=local_vectorize].chunk_size": ("literal", "exact_typed_reference"),
    "nodes[type=local_vectorize].chunk_overlap": ("literal", "exact_typed_reference"),
    "nodes[type=local_vectorize].mode": ("literal", "exact_typed_reference"),
    "nodes[type=local_search].index_path": ("literal", "interpolation"),
    "nodes[type=local_search].query": ("literal", "interpolation"),
    "nodes[type=local_search].embedding_strategy": ("literal", "interpolation"),
    "nodes[type=local_search].search_strategy": ("literal", "interpolation"),
    "nodes[type=local_search].top_k": ("literal", "exact_typed_reference"),
    "nodes[type=local_search].score_threshold": ("literal", "exact_typed_reference"),
    "nodes[type=local_search].include_snippets": ("literal", "exact_typed_reference"),
    "nodes[type=local_search].include_file_metadata": (
        "literal",
        "exact_typed_reference",
    ),
    "nodes[type=subflow].expanded": ("literal", "exact_typed_reference"),
    "nodes[type=subflow].filesystem_access": ("literal", "exact_typed_reference"),
    "nodes[type=subflow].filesystem_access.*.*": ("literal", "interpolation"),
    "nodes[type=subflow].provider_requirements": ("literal", "exact_typed_reference"),
    "nodes[type=subflow].provider_requirements.*.*": ("literal", "interpolation"),
    "nodes[type=subflow].secret_requirements": ("literal", "exact_typed_reference"),
    "nodes[type=subflow].secret_requirements.*": ("literal", "interpolation"),
}

EXACT_REFERENCE_PATTERN = re.compile(
    r"^\{\{\s*([A-Za-z_][A-Za-z0-9_-]*"
    r"(?:\.(?:[A-Za-z_][A-Za-z0-9_-]*|[0-9]+))*)\s*\}\}$"
)
RAW_REFERENCE_PATTERN = re.compile(
    r"^[A-Za-z_][A-Za-z0-9_-]*(?:\.(?:[A-Za-z_][A-Za-z0-9_-]*|[0-9]+))*$"
)


def parse_exact_reference(value: str) -> str | None:
    """Return one normalized exact reference, including whitespace-tolerant braces."""
    stripped = value.strip()
    wrapped = EXACT_REFERENCE_PATTERN.fullmatch(stripped)
    if wrapped is not None:
        return wrapped.group(1)
    return stripped if RAW_REFERENCE_PATTERN.fullmatch(stripped) else None


def require_reference_capability(field_pattern: str) -> None:
    """Gate runtime interpolation on the published capability registry."""
    if field_pattern not in REFERENCE_FIELD_CAPABILITIES:
        raise RuntimeError(f"Missing reference capability for runtime field: {field_pattern}")


def require_operation_reference_capability(
    operation_type: str,
    field_path: tuple[str, ...],
) -> None:
    """Require a published rule for one recursively resolved operation path."""
    prefix = f"nodes[type={operation_type}]"
    candidates: list[str] = []
    for length in range(len(field_path), 0, -1):
        parent = field_path[:length]
        candidates.append(f"{prefix}.{'.'.join(parent)}")
        for wildcard_start in range(length - 1, 0, -1):
            wildcard = (*parent[:wildcard_start], *("*" for _ in parent[wildcard_start:]))
            candidates.append(f"{prefix}.{'.'.join(wildcard)}")
        if length > 1:
            candidates.append(f"{prefix}.{'.'.join((*parent[:-1], '*'))}")
    for candidate in candidates:
        if candidate in REFERENCE_FIELD_CAPABILITIES:
            return
    concrete = f"{prefix}.{'.'.join(field_path)}"
    raise RuntimeError(f"Missing reference capability for runtime field: {concrete}")
