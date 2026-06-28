from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from gofer.core.operations import (
    AgentOperation,
    ApprovalGateOperation,
    BashCommandOperation,
    CommonLlmTaskOperation,
    HttpRequestOperation,
    NotificationOperation,
    PythonScriptOperation,
    ShellScriptOperation,
)
from gofer.core.provider_profiles import resolve_provider_settings
from gofer.core.workflow import AgenticWorkflow

SECRET_TOKEN_PATTERN = re.compile(
    r"\{\{\s*secret\.([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}|secret:([A-Za-z_][A-Za-z0-9_.-]*)"
)


@dataclass
class SecretRequirement:
    name: str
    sources: set[str] = field(default_factory=set)

    def add_source(self, source: str) -> None:
        if source:
            self.sources.add(source)


@dataclass(frozen=True)
class SecretStatus:
    name: str
    present: bool
    sources: tuple[str, ...]

    @property
    def status(self) -> str:
        return "present" if self.present else "missing"

    @property
    def env_names(self) -> tuple[str, str]:
        return (f"GOFER_SECRET_{self.name}", self.name)

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "name": self.name,
            "status": self.status,
            "present": self.present,
            "sources": list(self.sources),
            "envNames": list(self.env_names),
        }
        if self.present:
            payload["maskedValue"] = "***"
        return payload


def secret_value(name: str) -> str | None:
    return os.environ.get(f"GOFER_SECRET_{name}") or os.environ.get(name)


def secret_present(name: str) -> bool:
    return secret_value(name) is not None


def secret_reference_names(value: object) -> set[str]:
    names: set[str] = set()
    if isinstance(value, str):
        for match in SECRET_TOKEN_PATTERN.finditer(value):
            names.add(match.group(1) or match.group(2))
        if value.startswith("env:") and len(value) > 4:
            names.add(value[4:])
    elif isinstance(value, dict):
        for item in value.values():
            names.update(secret_reference_names(item))
    elif isinstance(value, list | tuple | set):
        for item in value:
            names.update(secret_reference_names(item))
    return names


def workflow_secret_requirements(
    workflow: AgenticWorkflow,
    *,
    workflow_path: Path | None = None,
    data_dir: Path | None = None,
) -> list[SecretRequirement]:
    path_base = workflow_path.parent if workflow_path is not None else None
    profile_data_dir = data_dir if data_dir is not None else path_base
    requirements: dict[str, SecretRequirement] = {}

    def add(name: str, source: str) -> None:
        requirement = requirements.setdefault(name, SecretRequirement(name=name))
        requirement.add_source(source)

    def add_refs(value: object, source: str) -> None:
        for name in secret_reference_names(value):
            add(name, source)

    for trigger_id, trigger in workflow.config.webhooks.items():
        if trigger.token_env:
            add(trigger.token_env, f"trigger:{trigger_id}.token_env")

    for node in workflow.graph.nodes_in_order():
        op = node.operation
        node_source = f"node:{node.node_id}"
        if isinstance(op, (BashCommandOperation, PythonScriptOperation, ShellScriptOperation)):
            add_refs(op.env, f"{node_source}.env")
        elif isinstance(op, (AgentOperation, CommonLlmTaskOperation)):
            agent = workflow.agents.get(op.agent_id)
            if agent is not None:
                add_refs(agent.env, f"agent:{agent.agent_id}.env")
                settings = resolve_provider_settings(
                    agent_subscription=agent.subscription,
                    profile_name=agent.profile,
                    agent_model=agent.model,
                    operation_profile=op.profile,
                    operation_model=op.model,
                    operation_timeout=op.timeout,
                    data_dir=profile_data_dir,
                )
                for env_name, secret_name in settings.secret_refs.items():
                    add(secret_name, f"{node_source}.provider.{env_name}")
                if settings.api_key_secret:
                    add(settings.api_key_secret, f"{node_source}.provider.api_key")
                elif settings.api_key_env:
                    add(settings.api_key_env, f"{node_source}.provider.api_key")
        elif isinstance(op, HttpRequestOperation):
            add_refs(op.model_dump(by_alias=True), node_source)
        elif isinstance(op, NotificationOperation):
            add_refs(op.model_dump(), node_source)
        elif isinstance(op, ApprovalGateOperation):
            add_refs(
                {
                    "message": op.message,
                    "notification_title": op.notification_title,
                },
                node_source,
            )
        else:
            try:
                add_refs(op.model_dump(by_alias=True), node_source)
            except AttributeError:
                add_refs(json.loads(json.dumps(op, default=str)), node_source)

    return sorted(requirements.values(), key=lambda item: item.name)


def workflow_secret_readiness(
    workflow: AgenticWorkflow,
    *,
    workflow_path: Path | None = None,
    data_dir: Path | None = None,
) -> list[SecretStatus]:
    return [
        SecretStatus(
            name=requirement.name,
            present=secret_present(requirement.name),
            sources=tuple(sorted(requirement.sources)),
        )
        for requirement in workflow_secret_requirements(
            workflow,
            workflow_path=workflow_path,
            data_dir=data_dir,
        )
    ]


def missing_workflow_secrets(
    workflow: AgenticWorkflow,
    *,
    workflow_path: Path | None = None,
    data_dir: Path | None = None,
) -> list[str]:
    return [
        status.name
        for status in workflow_secret_readiness(
            workflow,
            workflow_path=workflow_path,
            data_dir=data_dir,
        )
        if not status.present
    ]
