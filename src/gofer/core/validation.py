from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from apscheduler.triggers.cron import CronTrigger

from gofer.core.graph import EdgeConditionType
from gofer.core.network_policy import network_policy_warnings
from gofer.core.operations import (
    AgentOperation,
    CommonLlmTaskOperation,
    CopyFileOperation,
    DeleteFileOperation,
    DirectoryFanSource,
    FileOperation,
    FolderOperation,
    HttpRequestOperation,
    LocalSearchOperation,
    LocalVectorizeOperation,
    LoopOperation,
    MoveFileOperation,
    NotificationOperation,
    OpenResourceOperation,
    PromptFileOperation,
    PythonScriptOperation,
    ReadFileOperation,
    ShellScriptOperation,
    TabularFanSource,
    TriggerEventsFanSource,
    WorkflowCallOperation,
    WriteFileOperation,
)
from gofer.core.secrets import workflow_secret_readiness
from gofer.core.workflow import AgenticWorkflow, FilesystemAccessEntry, WebhookTriggerConfig

ValidationSeverity = Literal["error", "warning"]
ValidationTargetType = Literal["workflow", "node", "edge", "agent", "trigger"]


@dataclass(frozen=True)
class ValidationFix:
    action: str
    label: str
    payload: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "label": self.label,
            "payload": self.payload,
        }


@dataclass(frozen=True)
class ValidationDiagnostic:
    code: str
    severity: ValidationSeverity
    target_type: ValidationTargetType
    message: str
    target_id: str | None = None
    field: str | None = None
    fixes: tuple[ValidationFix, ...] = ()
    detail: dict[str, Any] | None = None

    @property
    def subject(self) -> str:
        if self.target_id is None:
            return self.target_type
        return f"{self.target_type}:{self.target_id}"

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.code,
            "code": self.code,
            "severity": self.severity,
            "targetType": self.target_type,
            "subject": self.subject,
            "message": self.message,
        }
        if self.target_id is not None:
            payload["targetId"] = self.target_id
        if self.field is not None:
            payload["field"] = self.field
        if self.fixes:
            payload["fixes"] = [fix.to_dict() for fix in self.fixes]
        if self.detail:
            payload["detail"] = self.detail
        return payload


@dataclass(frozen=True)
class WorkflowValidationReport:
    ok: bool
    diagnostics: list[ValidationDiagnostic]
    workflow_id: str | None = None
    workflow_path: Path | None = None

    @property
    def errors(self) -> list[ValidationDiagnostic]:
        return [item for item in self.diagnostics if item.severity == "error"]

    @property
    def warnings(self) -> list[ValidationDiagnostic]:
        return [item for item in self.diagnostics if item.severity == "warning"]

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "ok": self.ok,
            "errors": [item.to_dict() for item in self.errors],
            "warnings": [item.to_dict() for item in self.warnings],
            "diagnostics": [item.to_dict() for item in self.diagnostics],
        }
        if self.workflow_id is not None:
            payload["workflowId"] = self.workflow_id
        if self.workflow_path is not None:
            payload["workflowPath"] = str(self.workflow_path)
        return payload


def validate_workflow_file(
    workflow_path: Path,
    *,
    data_dir: Path | None = None,
) -> WorkflowValidationReport:
    try:
        with open(workflow_path, "rb") as fh:
            raw = tomllib.load(fh)
    except Exception as exc:  # noqa: BLE001
        diagnostic = ValidationDiagnostic(
            code="workflow.toml_invalid",
            severity="error",
            target_type="workflow",
            field="toml",
            message=f"Workflow TOML could not be parsed: {exc}",
        )
        return WorkflowValidationReport(
            ok=False,
            diagnostics=[diagnostic],
            workflow_path=workflow_path,
        )

    return validate_workflow_data(raw, workflow_path=workflow_path, data_dir=data_dir)


def validate_workflow_data(
    data: dict[str, Any],
    *,
    workflow_path: Path | None = None,
    data_dir: Path | None = None,
) -> WorkflowValidationReport:
    diagnostics: list[ValidationDiagnostic] = []
    workflow_id = _raw_workflow_id(data)
    workflow: AgenticWorkflow | None = None
    try:
        workflow = AgenticWorkflow.from_dict(data)
    except Exception as exc:  # noqa: BLE001
        diagnostics.append(
            ValidationDiagnostic(
                code="workflow.load_failed",
                severity="error",
                target_type="workflow",
                field="toml",
                message=f"Workflow could not be loaded: {exc}",
            )
        )

    diagnostics.extend(_raw_edge_diagnostics(data))

    if workflow is not None:
        diagnostics.extend(
            validate_workflow(
                workflow,
                workflow_path=workflow_path,
                data_dir=data_dir,
            ).diagnostics
        )
        workflow_id = workflow.config.id

    return WorkflowValidationReport(
        ok=not any(item.severity == "error" for item in diagnostics),
        diagnostics=diagnostics,
        workflow_id=workflow_id,
        workflow_path=workflow_path,
    )


def validate_workflow(
    workflow: AgenticWorkflow,
    *,
    workflow_path: Path | None = None,
    data_dir: Path | None = None,
) -> WorkflowValidationReport:
    path_base = workflow_path.parent if workflow_path is not None else data_dir
    diagnostics: list[ValidationDiagnostic] = []

    try:
        workflow.graph.validate()
    except Exception as exc:  # noqa: BLE001
        diagnostics.append(
            ValidationDiagnostic(
                code="workflow.graph_invalid",
                severity="error",
                target_type="workflow",
                message=str(exc),
            )
        )

    diagnostics.extend(_agent_diagnostics(workflow, path_base))
    diagnostics.extend(_node_diagnostics(workflow, path_base))
    diagnostics.extend(_edge_diagnostics(workflow))
    diagnostics.extend(_trigger_diagnostics(workflow, path_base))
    diagnostics.extend(_secret_readiness_diagnostics(workflow, workflow_path, data_dir))

    return WorkflowValidationReport(
        ok=not any(item.severity == "error" for item in diagnostics),
        diagnostics=diagnostics,
        workflow_id=workflow.config.id,
        workflow_path=workflow_path,
    )


def _secret_readiness_diagnostics(
    workflow: AgenticWorkflow,
    workflow_path: Path | None,
    data_dir: Path | None,
) -> list[ValidationDiagnostic]:
    readiness = workflow_secret_readiness(
        workflow,
        workflow_path=workflow_path,
        data_dir=data_dir,
    )
    if not readiness:
        return []
    missing = [item.name for item in readiness if not item.present]
    names = [item.name for item in readiness]
    message = "Required secrets: " + ", ".join(names)
    if missing:
        message += ". Missing: " + ", ".join(missing)
    return [
        ValidationDiagnostic(
            code="workflow.secret_readiness",
            severity="warning",
            target_type="workflow",
            field="secrets",
            message=message,
            detail={
                "secretReadiness": [item.to_dict() for item in readiness],
            },
        )
    ]


def _raw_workflow_id(data: dict[str, Any]) -> str | None:
    workflow = data.get("workflow")
    if isinstance(workflow, dict):
        value = workflow.get("id")
        if value is not None:
            return str(value)
    return None


def _raw_edge_diagnostics(data: dict[str, Any]) -> list[ValidationDiagnostic]:
    nodes = data.get("nodes") or []
    node_ids = {
        str(node.get("id"))
        for node in nodes
        if isinstance(node, dict) and node.get("id") is not None
    }
    diagnostics: list[ValidationDiagnostic] = []
    for index, edge in enumerate(data.get("edges") or []):
        if not isinstance(edge, dict):
            continue
        edge_id = _edge_id(edge, index)
        from_node = str(edge.get("from", ""))
        to_node = str(edge.get("to", ""))
        if from_node not in node_ids:
            diagnostics.append(_dangling_edge_diagnostic(edge_id, "from", from_node, edge))
        if to_node not in node_ids:
            diagnostics.append(_dangling_edge_diagnostic(edge_id, "to", to_node, edge))
    return diagnostics


def _agent_diagnostics(
    workflow: AgenticWorkflow,
    path_base: Path | None,
) -> list[ValidationDiagnostic]:
    diagnostics: list[ValidationDiagnostic] = []
    for agent_id, agent in sorted(workflow.agents.items()):
        if agent.prompt_path is not None:
            diagnostics.extend(
                _missing_prompt_file_diagnostics(
                    agent.prompt_path,
                    path_base,
                    target_type="agent",
                    target_id=agent_id,
                    field="prompt_path",
                )
            )
    return diagnostics


def _node_diagnostics(
    workflow: AgenticWorkflow,
    path_base: Path | None,
) -> list[ValidationDiagnostic]:
    diagnostics: list[ValidationDiagnostic] = []
    node_ids = {node.node_id for node in workflow.graph.nodes_in_order()}
    for node in workflow.graph.nodes_in_order():
        op = node.operation
        diagnostics.extend(_filesystem_access_diagnostics(workflow, op, node.node_id, path_base))
        if isinstance(op, (AgentOperation, CommonLlmTaskOperation)):
            if op.agent_id not in workflow.agents:
                diagnostics.append(
                    ValidationDiagnostic(
                        code="workflow.agent_missing",
                        severity="error",
                        target_type="node",
                        target_id=node.node_id,
                        field="agent_id",
                        message=(
                            f"Node '{node.node_id}' references missing agent '{op.agent_id}'."
                        ),
                        fixes=(
                            ValidationFix(
                                action="create_agent",
                                label=f"Create agent '{op.agent_id}'",
                                payload={"agentId": op.agent_id, "nodeId": node.node_id},
                            ),
                        ),
                    )
                )
            if isinstance(op, AgentOperation) and op.prompt_path is not None:
                diagnostics.extend(
                    _missing_prompt_file_diagnostics(
                        op.prompt_path,
                        path_base,
                        target_type="node",
                        target_id=node.node_id,
                        field="operation.prompt_path",
                    )
                )
            if isinstance(op, AgentOperation):
                diagnostics.extend(_dynamic_count_diagnostics(op, node.node_id, node_ids))
        elif isinstance(op, HttpRequestOperation):
            diagnostics.extend(_http_request_network_diagnostics(op, node.node_id))
        elif isinstance(op, NotificationOperation):
            diagnostics.extend(_notification_diagnostics(op, node.node_id))
        elif isinstance(op, WorkflowCallOperation):
            diagnostics.extend(
                _workflow_call_diagnostics(op, node.node_id, workflow.config.id, path_base)
            )

        if isinstance(op, (PythonScriptOperation, ShellScriptOperation)):
            diagnostics.extend(
                _missing_path_diagnostics(
                    op.script_path,
                    path_base,
                    code="workflow.script_path_missing",
                    target_type="node",
                    target_id=node.node_id,
                    field="operation.script_path",
                    label="Script path",
                )
            )
        elif isinstance(op, PromptFileOperation) and op.template_path is not None:
            diagnostics.extend(
                _missing_path_diagnostics(
                    op.template_path,
                    path_base,
                    code="workflow.prompt_template_missing",
                    target_type="node",
                    target_id=node.node_id,
                    field="operation.template_path",
                    label="Prompt template path",
                )
            )
        elif isinstance(op, LoopOperation):
            diagnostics.extend(_fan_source_diagnostics(op.source, node.node_id, path_base))
        elif isinstance(op, LocalVectorizeOperation):
            diagnostics.extend(
                _missing_path_diagnostics(
                    op.source_path,
                    path_base,
                    code="workflow.local_vector_source_missing",
                    target_type="node",
                    target_id=node.node_id,
                    field="operation.source_path",
                    label="Local vector source path",
                    allow_file=True,
                    allow_dir=True,
                )
            )
        elif isinstance(op, LocalSearchOperation):
            diagnostics.extend(
                _missing_path_diagnostics(
                    op.index_path,
                    path_base,
                    code="workflow.local_search_index_missing",
                    target_type="node",
                    target_id=node.node_id,
                    field="operation.index_path",
                    label="Local search index path",
                )
            )
    return diagnostics


def _workflow_call_diagnostics(
    op: WorkflowCallOperation,
    node_id: str,
    current_workflow_id: str,
    path_base: Path | None,
) -> list[ValidationDiagnostic]:
    workflow_id = op.workflow_id.strip()
    if not workflow_id:
        return [
            ValidationDiagnostic(
                code="workflow.call_target_missing",
                severity="error",
                target_type="node",
                target_id=node_id,
                field="operation.workflow_id",
                message=f"Node '{node_id}' runs another workflow but has no target workflow.",
            )
        ]
    if workflow_id == current_workflow_id:
        return [
            ValidationDiagnostic(
                code="workflow.call_self",
                severity="error",
                target_type="node",
                target_id=node_id,
                field="operation.workflow_id",
                message=f"Node '{node_id}' cannot run its own workflow.",
            )
        ]
    if path_base is None:
        return []
    candidate = path_base / f"{workflow_id}.toml"
    if candidate.exists():
        return []
    for path in path_base.glob("*.toml"):
        try:
            data = tomllib.loads(path.read_text(encoding="utf-8"))
        except OSError:
            continue
        except tomllib.TOMLDecodeError:
            continue
        config = data.get("workflow") if isinstance(data, dict) else None
        if isinstance(config, dict) and str(config.get("id", "")).strip() == workflow_id:
            return []
    return [
        ValidationDiagnostic(
            code="workflow.call_target_not_found",
            severity="error",
            target_type="node",
            target_id=node_id,
            field="operation.workflow_id",
            message=f"Node '{node_id}' references unknown workflow '{workflow_id}'.",
        )
    ]


def _edge_diagnostics(workflow: AgenticWorkflow) -> list[ValidationDiagnostic]:
    diagnostics: list[ValidationDiagnostic] = []
    for index, (from_node, to_node) in enumerate(workflow.graph._graph.edges()):
        edge = workflow.graph.get_edge_config(from_node, to_node)
        edge_id = f"{from_node}-{to_node}-{index}"
        if edge.condition == EdgeConditionType.OUTPUT_MATCHES:
            pattern = edge.output_pattern or ""
            try:
                re.compile(pattern)
            except re.error as exc:
                diagnostics.append(
                    ValidationDiagnostic(
                        code="workflow.edge_regex_invalid",
                        severity="error",
                        target_type="edge",
                        target_id=edge_id,
                        field="outputPattern",
                        message=(
                            f"Edge '{from_node} -> {to_node}' has an invalid output regex: {exc}."
                        ),
                        fixes=(
                            ValidationFix(
                                action="replace_edge_pattern",
                                label="Escape regex pattern",
                                payload={
                                    "edgeId": edge_id,
                                    "from": from_node,
                                    "to": to_node,
                                    "outputPattern": re.escape(pattern),
                                },
                            ),
                        ),
                    )
                )
    return diagnostics


def _trigger_diagnostics(
    workflow: AgenticWorkflow,
    path_base: Path | None,
) -> list[ValidationDiagnostic]:
    diagnostics: list[ValidationDiagnostic] = []
    schedule = workflow.config.schedule
    if schedule is not None:
        try:
            ZoneInfo(schedule.timezone)
        except ZoneInfoNotFoundError:
            diagnostics.append(
                ValidationDiagnostic(
                    code="workflow.schedule_timezone_invalid",
                    severity="error",
                    target_type="trigger",
                    target_id="schedule",
                    field="timezone",
                    message=f"Schedule timezone '{schedule.timezone}' is not available.",
                    fixes=(
                        ValidationFix(
                            action="set_schedule_timezone",
                            label="Use UTC timezone",
                            payload={"timezone": "UTC"},
                        ),
                    ),
                )
            )
        try:
            CronTrigger.from_crontab(schedule.cron_expression, timezone=schedule.timezone)
        except Exception as exc:  # noqa: BLE001
            diagnostics.append(
                ValidationDiagnostic(
                    code="workflow.schedule_cron_invalid",
                    severity="error",
                    target_type="trigger",
                    target_id="schedule",
                    field="cron_expression",
                    message=f"Schedule cron expression is invalid: {exc}",
                    fixes=(
                        ValidationFix(
                            action="disable_schedule",
                            label="Disable schedule",
                            payload={},
                        ),
                    ),
                )
            )

    watch = workflow.config.watch
    if watch is not None:
        diagnostics.extend(
            _missing_path_diagnostics(
                watch.path,
                path_base,
                code="workflow.watch_path_missing",
                target_type="trigger",
                target_id="watch",
                field="path",
                label="Watch path",
                allow_file=True,
                allow_dir=True,
            )
        )

    if workflow.config.run_continuously and (schedule is not None or watch is not None):
        diagnostics.append(
            ValidationDiagnostic(
                code="workflow.trigger_conflict",
                severity="warning",
                target_type="trigger",
                target_id="run_continuously",
                field="runContinuously",
                message=(
                    "Continuous mode overrides schedule and file watcher starts until it "
                    "is disabled."
                ),
                fixes=(
                    ValidationFix(
                        action="disable_conflicting_triggers",
                        label="Disable schedule and watcher",
                        payload={},
                    ),
                    ValidationFix(
                        action="disable_continuous",
                        label="Disable continuous mode",
                        payload={},
                    ),
                ),
            )
        )
    for trigger_id, config in sorted(workflow.config.webhooks.items()):
        if config.missing_authentication:
            diagnostics.append(
                ValidationDiagnostic(
                    code="workflow.webhook_authentication_missing",
                    severity="error",
                    target_type="trigger",
                    target_id=trigger_id,
                    field="authentication",
                    message=(
                        f"Enabled webhook trigger '{trigger_id}' has no token, token_env, "
                        "or explicit unauthenticated opt-in."
                    ),
                    detail=_webhook_authentication_detail(config),
                    fixes=(
                        ValidationFix(
                            action="set_webhook_token_env",
                            label="Set token_env for the webhook trigger",
                            payload={"triggerId": trigger_id},
                        ),
                        ValidationFix(
                            action="allow_unauthenticated_webhook",
                            label="Explicitly allow unauthenticated local testing",
                            payload={"triggerId": trigger_id, "allowUnauthenticated": True},
                        ),
                    ),
                )
            )
        elif config.requires_unauthenticated_warning:
            diagnostics.append(
                ValidationDiagnostic(
                    code="workflow.webhook_unauthenticated_allowed",
                    severity="warning",
                    target_type="trigger",
                    target_id=trigger_id,
                    field="allowUnauthenticated",
                    message=(
                        f"Webhook trigger '{trigger_id}' explicitly allows unauthenticated "
                        "requests. This is high risk and should only be used for local testing."
                    ),
                    detail=_webhook_authentication_detail(config),
                )
            )
        if not config.store_raw_payload:
            continue
        diagnostics.append(
            ValidationDiagnostic(
                code="workflow.webhook_raw_payload_retention",
                severity="warning",
                target_type="trigger",
                target_id=trigger_id,
                field="storeRawPayload",
                message=(
                    f"Webhook trigger '{trigger_id}' stores raw replay payloads. "
                    "This is high risk because incoming secrets may be persisted in "
                    ".trigger.json sidecars."
                ),
                detail={
                    "risk": "high",
                    "replayPayloadRetention": "raw",
                    "storeRawPayload": True,
                },
            )
        )
    return diagnostics


def _webhook_authentication_detail(config: WebhookTriggerConfig) -> dict[str, Any]:
    return {
        "risk": "high",
        "authentication": "none" if not config.has_authentication else "token",
        "tokenConfigured": config.has_authentication,
        "allowUnauthenticated": config.allow_unauthenticated,
    }


def _dynamic_count_diagnostics(
    op: AgentOperation,
    node_id: str,
    node_ids: set[str],
) -> list[ValidationDiagnostic]:
    value = op.dynamic_count
    if isinstance(value, int):
        return []
    expression = value.strip()
    if not expression or expression.isdigit():
        return []
    source_node = expression.split(".", 1)[0].strip("{} ")
    severity: ValidationSeverity = "warning"
    message = (
        f"Node '{node_id}' uses deprecated dynamic_count expression "
        f"'{expression}'. Prefer a loop node feeding this agent."
    )
    if source_node and source_node not in node_ids:
        severity = "error"
        message = f"Node '{node_id}' dynamic_count references unknown source '{source_node}'."
    return [
        ValidationDiagnostic(
            code="workflow.dynamic_count_source",
            severity=severity,
            target_type="node",
            target_id=node_id,
            field="operation.dynamic_count",
            message=message,
        )
    ]


def _fan_source_diagnostics(
    source: Any,
    node_id: str,
    path_base: Path | None,
) -> list[ValidationDiagnostic]:
    if isinstance(source, TabularFanSource):
        return _missing_path_diagnostics(
            source.path,
            path_base,
            code="workflow.fanout_path_missing",
            target_type="node",
            target_id=node_id,
            field="operation.source.path",
            label="Tabular fan-out path",
        )
    if isinstance(source, DirectoryFanSource):
        return _missing_path_diagnostics(
            source.path,
            path_base,
            code="workflow.fanout_path_missing",
            target_type="node",
            target_id=node_id,
            field="operation.source.path",
            label="Directory fan-out path",
            allow_dir=True,
            allow_file=False,
        )
    return []


def _filesystem_access_diagnostics(
    workflow: AgenticWorkflow,
    op: object,
    node_id: str,
    path_base: Path | None,
) -> list[ValidationDiagnostic]:
    diagnostics: list[ValidationDiagnostic] = []

    def check(
        path: Path,
        permission: Literal["read", "write", "execute"],
        field: str,
        label: str,
    ) -> None:
        resolved = _resolve_path(path, path_base)
        if _path_has_workflow_access(workflow, resolved, permission, path_base):
            return
        diagnostics.append(
            ValidationDiagnostic(
                code="workflow.filesystem_access",
                severity="warning",
                target_type="node",
                target_id=node_id,
                field=field,
                message=(
                    f"{label} '{path}' resolves outside the trusted project folder "
                    f"and lacks {permission} permission in filesystem_access."
                ),
                detail={
                    "path": str(resolved),
                    "permission": permission,
                },
            )
        )

    if isinstance(op, PythonScriptOperation | ShellScriptOperation):
        check(op.script_path, "execute", "operation.script_path", "Script path")
    elif isinstance(op, ReadFileOperation):
        check(op.path, "read", "operation.path", "Read path")
    elif isinstance(op, WriteFileOperation):
        check(op.path, "write", "operation.path", "Write path")
    elif isinstance(op, CopyFileOperation):
        check(op.source_path, "read", "operation.source_path", "Copy source path")
        check(
            op.destination_path,
            "write",
            "operation.destination_path",
            "Copy destination path",
        )
    elif isinstance(op, MoveFileOperation):
        check(op.source_path, "write", "operation.source_path", "Move source path")
        check(
            op.destination_path,
            "write",
            "operation.destination_path",
            "Move destination path",
        )
    elif isinstance(op, DeleteFileOperation):
        check(op.path, "write", "operation.path", "Delete path")
    elif isinstance(op, FileOperation):
        check(op.path, "read", "operation.path", "File resource path")
    elif isinstance(op, FolderOperation):
        check(op.path, "read", "operation.path", "Folder resource path")
    elif isinstance(op, OpenResourceOperation):
        if _open_resource_target_is_local_path(op):
            check(
                Path(op.target),
                "read",
                "operation.target",
                "Open resource target path",
            )
    elif isinstance(op, PromptFileOperation):
        if op.template_path is not None:
            check(
                op.template_path,
                "read",
                "operation.template_path",
                "Prompt template path",
            )
        check(op.output_path, "write", "operation.output_path", "Prompt output path")
    elif isinstance(op, LocalVectorizeOperation):
        index_path = _resolve_path(op.index_path, path_base)
        check(
            op.source_path,
            "read",
            "operation.source_path",
            "Local vector source path",
        )
        check(
            op.index_path,
            "write",
            "operation.index_path",
            "Local vector index path",
        )
        check(
            index_path.parent,
            "write",
            "operation.index_path",
            "Local vector index directory",
        )
        check(
            _default_vector_entries_path(index_path),
            "write",
            "operation.index_path",
            "Local vector entries path",
        )
    elif isinstance(op, LocalSearchOperation):
        check(op.index_path, "read", "operation.index_path", "Local search index path")

    source = op.source if isinstance(op, LoopOperation) else None
    if isinstance(source, TabularFanSource):
        check(source.path, "read", "operation.source.path", "Tabular fan-out path")
    elif isinstance(source, DirectoryFanSource):
        check(source.path, "read", "operation.source.path", "Directory fan-out path")
    elif isinstance(source, TriggerEventsFanSource) and source.include_content:
        diagnostics.append(
            ValidationDiagnostic(
                code="workflow.filesystem_access_trigger_content",
                severity="warning",
                target_type="node",
                target_id=node_id,
                field="operation.source.include_content",
                message=(
                    "Trigger-event fan-out with include_content reads event paths at "
                    "runtime and requires read permission for each outside event path."
                ),
            )
        )
    return diagnostics


def _http_request_network_diagnostics(
    op: HttpRequestOperation,
    node_id: str,
) -> list[ValidationDiagnostic]:
    return [
        ValidationDiagnostic(
            code="workflow.http_network_policy",
            severity="warning",
            target_type="node",
            target_id=node_id,
            field="operation.url",
            message=warning,
            detail={
                "networkAllowlist": list(op.network_allowlist),
            },
        )
        for warning in network_policy_warnings(op.url, op.network_allowlist)
    ]


def _notification_diagnostics(
    op: NotificationOperation,
    node_id: str,
) -> list[ValidationDiagnostic]:
    diagnostics: list[ValidationDiagnostic] = []
    if op.channel in {"slack", "teams", "webhook"}:
        if not op.webhook_url:
            diagnostics.append(
                ValidationDiagnostic(
                    code="workflow.notification_webhook_url_missing",
                    severity="error",
                    target_type="node",
                    target_id=node_id,
                    field="operation.webhook_url",
                    message=(
                        f"Node '{node_id}' uses {op.channel} notifications but has no webhook_url."
                    ),
                )
            )
        else:
            diagnostics.extend(
                ValidationDiagnostic(
                    code="workflow.notification_network_policy",
                    severity="warning",
                    target_type="node",
                    target_id=node_id,
                    field="operation.webhook_url",
                    message=warning,
                    detail={"networkAllowlist": list(op.network_allowlist)},
                )
                for warning in network_policy_warnings(
                    op.webhook_url,
                    op.network_allowlist,
                )
            )
    if op.channel == "email":
        required = {
            "smtp_host": op.smtp_host,
            "email_from": op.email_from,
            "email_to": op.email_to,
        }
        for field_name, value in required.items():
            if value:
                continue
            diagnostics.append(
                ValidationDiagnostic(
                    code="workflow.notification_email_config_missing",
                    severity="error",
                    target_type="node",
                    target_id=node_id,
                    field=f"operation.{field_name}",
                    message=(
                        f"Node '{node_id}' uses email notifications but is missing {field_name}."
                    ),
                )
            )
    return diagnostics


def _default_vector_entries_path(index_path: Path) -> Path:
    return index_path.with_name(f"{index_path.name}.entries.jsonl")


def _open_resource_target_is_local_path(op: OpenResourceOperation) -> bool:
    if op.resource_type == "app":
        return False
    if op.resource_type == "url":
        return False
    return "://" not in op.target


def _path_has_workflow_access(
    workflow: AgenticWorkflow,
    path: Path,
    permission: Literal["read", "write", "execute"],
    path_base: Path | None,
) -> bool:
    if path_base is None:
        return True
    resolved_path = _resolved_for_access(path)
    trusted_root = _resolved_for_access(path_base)
    if resolved_path == trusted_root or trusted_root in resolved_path.parents:
        root_entry = _project_root_access_entry(workflow, trusted_root, path_base)
        return getattr(root_entry, permission) if root_entry is not None else True
    for entry in workflow.config.filesystem_access:
        if not getattr(entry, permission):
            continue
        if _access_entry_covers_path(entry, resolved_path, path_base):
            return True
    return False


def _access_entry_covers_path(
    entry: FilesystemAccessEntry,
    resolved_path: Path,
    path_base: Path | None,
) -> bool:
    entry_path = _resolve_path(entry.path, path_base)
    resolved_entry = _resolved_for_access(entry_path)
    return resolved_path == resolved_entry or resolved_entry in resolved_path.parents


def _project_root_access_entry(
    workflow: AgenticWorkflow,
    trusted_root: Path,
    path_base: Path | None,
) -> FilesystemAccessEntry | None:
    for entry in workflow.config.filesystem_access:
        entry_path = _resolve_path(entry.path, path_base)
        if _resolved_for_access(entry_path) == trusted_root:
            return entry
    return None


def _resolved_for_access(path: Path) -> Path:
    try:
        return path.resolve()
    except OSError:
        return path.absolute()


def _missing_prompt_file_diagnostics(
    path: Path,
    path_base: Path | None,
    *,
    target_type: ValidationTargetType,
    target_id: str,
    field: str,
) -> list[ValidationDiagnostic]:
    resolved = _resolve_path(path, path_base)
    if resolved.is_file():
        return []
    return [
        ValidationDiagnostic(
            code="workflow.prompt_path_missing",
            severity="error",
            target_type=target_type,
            target_id=target_id,
            field=field,
            message=f"Prompt file '{path}' does not exist.",
            fixes=(
                ValidationFix(
                    action="create_prompt_file",
                    label="Create prompt file",
                    payload={"path": str(path), "targetId": target_id, "field": field},
                ),
            ),
        )
    ]


def _missing_path_diagnostics(
    path: Path,
    path_base: Path | None,
    *,
    code: str,
    target_type: ValidationTargetType,
    target_id: str,
    field: str,
    label: str,
    allow_file: bool = True,
    allow_dir: bool = False,
) -> list[ValidationDiagnostic]:
    resolved = _resolve_path(path, path_base)
    if (allow_file and resolved.is_file()) or (allow_dir and resolved.is_dir()):
        return []
    return [
        ValidationDiagnostic(
            code=code,
            severity="error",
            target_type=target_type,
            target_id=target_id,
            field=field,
            message=f"{label} '{path}' does not exist.",
        )
    ]


def _resolve_path(path: Path, path_base: Path | None) -> Path:
    expanded = path.expanduser()
    if expanded.is_absolute() or path_base is None:
        return expanded
    return path_base / expanded


def _edge_id(edge: dict[str, Any], index: int) -> str:
    raw = edge.get("id")
    if raw:
        return str(raw)
    return f"{edge.get('from', '')}-{edge.get('to', '')}-{index}"


def _dangling_edge_diagnostic(
    edge_id: str,
    field: Literal["from", "to"],
    node_id: str,
    edge: dict[str, Any],
) -> ValidationDiagnostic:
    return ValidationDiagnostic(
        code="workflow.edge_dangling",
        severity="error",
        target_type="edge",
        target_id=edge_id,
        field=field,
        message=f"Edge '{edge_id}' references missing {field} node '{node_id}'.",
        fixes=(
            ValidationFix(
                action="remove_edge",
                label="Remove dangling edge",
                payload={
                    "edgeId": edge_id,
                    "from": edge.get("from"),
                    "to": edge.get("to"),
                },
            ),
        ),
    )
