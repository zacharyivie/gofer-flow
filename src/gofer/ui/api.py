from __future__ import annotations

import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, overload

from pydantic import BaseModel, TypeAdapter

from gofer.core.agent import AgentConfig
from gofer.core.executor import WorkflowExecutor
from gofer.core.graph import EdgeConditionType, EdgeConfig, GraphNode
from gofer.core.operations import Operation, OperationType
from gofer.core.workflow import AgenticWorkflow, WorkflowConfig
from gofer.subscriptions.claude_code import ClaudeCodeSubscription
from gofer.subscriptions.codex import CodexSubscription
from gofer.utils.paths import get_data_dir


class WorkflowAlreadyExistsError(ValueError):
    pass


class WorkflowCreateError(ValueError):
    pass


class WorkflowUpdateError(ValueError):
    pass


class WorkflowRunError(ValueError):
    pass


class WorkflowLogError(ValueError):
    pass


_operation_adapter: TypeAdapter[Operation] = TypeAdapter(Operation)
_subscriptions = {
    "claude_code": ClaudeCodeSubscription(),
    "codex": CodexSubscription(),
}


def list_workflow_payloads(data_dir: Path | None = None) -> dict[str, Any]:
    """Return serializable workflow summaries for the React UI."""
    base = data_dir or get_data_dir()
    workflows: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    if not base.exists():
        return {"dataDir": str(base), "workflows": workflows, "errors": errors}

    for path in sorted(base.glob("*.toml")):
        try:
            workflow = AgenticWorkflow.from_file(path)
        except Exception as exc:
            errors.append({"path": str(path), "message": str(exc)})
            continue

        if workflow.agents and not list(workflow.graph._graph.nodes()):
            continue

        workflows.append(workflow_to_payload(workflow, path))

    return {"dataDir": str(base), "workflows": workflows, "errors": errors}


def create_workflow_payload(name: str, data_dir: Path | None = None) -> dict[str, Any]:
    """Create a workflow TOML file and return its UI payload."""
    workflow_name = name.strip()
    if not workflow_name:
        raise WorkflowCreateError("Workflow name is required")

    base = data_dir or get_data_dir()
    base.mkdir(parents=True, exist_ok=True)

    workflow_id = _slugify(workflow_name)
    path = base / f"{workflow_id}.toml"
    if path.exists():
        raise WorkflowAlreadyExistsError(f"Workflow '{workflow_id}' already exists")

    workflow = AgenticWorkflow(WorkflowConfig(id=workflow_id, name=workflow_name))
    workflow.to_file(path)
    return workflow_to_payload(workflow, path)


def import_workflow_payload(content: str, data_dir: Path | None = None) -> dict[str, Any]:
    base = data_dir or get_data_dir()
    base.mkdir(parents=True, exist_ok=True)

    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False) as fh:
            fh.write(content)
            temp_path = Path(fh.name)

        workflow = AgenticWorkflow.from_file(temp_path)
        workflow.validate()
        path = base / f"{workflow.config.id}.toml"
        if path.exists():
            raise WorkflowAlreadyExistsError(f"Workflow '{workflow.config.id}' already exists")
        workflow.to_file(path)
    except WorkflowAlreadyExistsError:
        raise
    except Exception as exc:
        raise WorkflowCreateError(str(exc)) from exc
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)

    return workflow_to_payload(workflow, path)


def delete_workflow_payload(workflow_id: str, data_dir: Path | None = None) -> dict[str, Any]:
    base = data_dir or get_data_dir()
    path = base / f"{workflow_id}.toml"
    if not path.exists():
        raise WorkflowUpdateError(f"Workflow '{workflow_id}' not found")
    path.unlink()
    return {"workflowId": workflow_id, "deleted": True}


def update_workflow_payload(
    workflow_id: str, payload: dict[str, Any], data_dir: Path | None = None
) -> dict[str, Any]:
    """Persist a UI workflow payload back to TOML and return the saved payload."""
    if payload.get("id") != workflow_id:
        raise WorkflowUpdateError("Workflow ID in URL and payload must match")

    base = data_dir or get_data_dir()
    base.mkdir(parents=True, exist_ok=True)
    path = base / f"{workflow_id}.toml"
    if not path.exists():
        raise WorkflowUpdateError(f"Workflow '{workflow_id}' not found")

    try:
        workflow = workflow_from_payload(payload)
        workflow.validate()
        workflow.to_file(path)
    except Exception as exc:
        raise WorkflowUpdateError(str(exc)) from exc

    return workflow_to_payload(workflow, path)


async def run_workflow_payload(
    workflow_id: str, data_dir: Path | None = None, dry_run: bool = False
) -> dict[str, Any]:
    base = data_dir or get_data_dir()
    path = base / f"{workflow_id}.toml"
    if not path.exists():
        raise WorkflowRunError(f"Workflow '{workflow_id}' not found")

    try:
        workflow = AgenticWorkflow.from_file(path)
        workflow.validate()
        result = await WorkflowExecutor(
            workflow,
            _subscriptions,
            dry_run=dry_run,
            log_base_dir=base / "logs",
        ).run()
    except Exception as exc:
        raise WorkflowRunError(str(exc)) from exc

    return {
        "workflowId": result.workflow_id,
        "success": result.success,
        "durationSeconds": result.duration_seconds,
        "logPath": str(result.log_path) if result.log_path else None,
        "logText": result.log_path.read_text() if result.log_path else "",
        "nodeOutputs": {
            node_id: {
                "success": output.success,
                "output": output.output,
                "exitCode": output.exit_code,
                "durationSeconds": output.duration_seconds,
                "skipped": output.skipped,
                "fanOutputs": [
                    {"label": label, "output": fan_output}
                    for label, fan_output in output.fan_outputs
                ],
            }
            for node_id, output in result.node_outputs.items()
        },
    }


def latest_workflow_log_payload(
    workflow_id: str, data_dir: Path | None = None
) -> dict[str, Any]:
    base = data_dir or get_data_dir()
    log_dir = base / "logs" / workflow_id
    if not log_dir.exists():
        return {"workflowId": workflow_id, "logPath": None, "logText": ""}

    logs = sorted(log_dir.glob("*.log"), key=lambda path: (path.stat().st_mtime, path.name))
    if not logs:
        return {"workflowId": workflow_id, "logPath": None, "logText": ""}

    latest = logs[-1]
    try:
        text = latest.read_text()
    except OSError as exc:
        raise WorkflowLogError(str(exc)) from exc

    return {"workflowId": workflow_id, "logPath": str(latest), "logText": text}


def workflow_from_payload(payload: dict[str, Any]) -> AgenticWorkflow:
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id=str(payload["id"]),
            name=str(payload.get("name") or payload["id"]),
            schedule=payload.get("schedule"),
        )
    )

    for agent_id, agent_data in (payload.get("agents") or {}).items():
        if not isinstance(agent_data, dict):
            continue
        workflow.register_agent(
            AgentConfig(agent_id=str(agent_id), **_without(agent_data, "agent_id"))
        )

    for node_data in payload.get("nodes") or []:
        if not isinstance(node_data, dict):
            continue
        node_id = str(node_data["id"])
        operation_data = dict(node_data.get("operation") or {})
        if "type" not in operation_data:
            operation_data["type"] = node_data.get("type")
        operation_data = _clean_operation_data(operation_data)
        settings = node_data.get("settings") or {}
        workflow.add_operation(
            GraphNode(
                node_id=node_id,
                operation=_operation_adapter.validate_python(operation_data),
                pipe_output=bool(settings.get("pipeOutput", False)),
                retry_count=int(settings.get("retryCount") or 0),
                retry_delay_seconds=float(settings.get("retryDelaySeconds") or 1.0),
                timeout_seconds=_optional_float(settings.get("timeoutSeconds")),
            )
        )

    for edge_data in payload.get("edges") or []:
        if not isinstance(edge_data, dict):
            continue
        from_node = str(edge_data["from"])
        to_node = str(edge_data["to"])
        condition = EdgeConditionType(edge_data.get("condition") or "always")
        workflow.then(
            from_node,
            to_node,
            EdgeConfig(
                from_node=from_node,
                to_node=to_node,
                condition=condition,
                output_pattern=edge_data.get("outputPattern") or None,
            ),
        )

    return workflow


def workflow_to_payload(workflow: AgenticWorkflow, path: Path | None = None) -> dict[str, Any]:
    generations = workflow.graph.topological_generations()
    node_positions: dict[str, tuple[int, int]] = {}
    for generation_index, generation in enumerate(generations):
        column_x = 96 + generation_index * 300
        total_height = max(0, (len(generation) - 1) * 170)
        start_y = 260 - total_height // 2
        for row_index, node in enumerate(generation):
            node_positions[node.node_id] = (column_x, max(48, start_y + row_index * 170))

    nodes: list[dict[str, Any]] = []
    for generation in generations:
        for node in generation:
            x, y = node_positions[node.node_id]
            operation = _model_dump(node.operation)
            nodes.append(
                {
                    "id": node.node_id,
                    "label": _node_label(node.node_id),
                    "type": str(node.operation.type),
                    "meta": _operation_meta(operation),
                    "operation": operation,
                    "settings": {
                        "pipeOutput": node.pipe_output,
                        "retryCount": node.retry_count,
                        "retryDelaySeconds": node.retry_delay_seconds,
                        "timeoutSeconds": node.timeout_seconds,
                    },
                    "x": x,
                    "y": y,
                }
            )

    edges: list[dict[str, Any]] = []
    for index, (from_id, to_id) in enumerate(workflow.graph._graph.edges()):
        config = workflow.graph.get_edge_config(from_id, to_id)
        condition = str(config.condition)
        edges.append(
            {
                "id": f"{from_id}-{to_id}-{index}",
                "from": from_id,
                "to": to_id,
                "label": _edge_label(condition, config.output_pattern),
                "condition": condition,
                "outputPattern": config.output_pattern,
            }
        )

    schedule = _model_dump(workflow.config.schedule) if workflow.config.schedule else None
    status = _latest_run_status(workflow.config.id, path)
    tags = [status.lower()]
    operation_types = sorted({str(node["type"]) for node in nodes})
    tags.extend(operation_types[:2])

    return {
        "id": workflow.config.id,
        "name": workflow.config.name,
        "description": _workflow_description(workflow, schedule),
        "status": status,
        "updatedAt": _updated_at(path),
        "sourcePath": str(path) if path else None,
        "schedule": schedule,
        "tags": tags,
        "agents": {
            agent_id: _model_dump(agent_config)
            for agent_id, agent_config in workflow.agents.items()
        },
        "nodes": nodes,
        "edges": edges,
    }


@overload
def _model_dump(model: None) -> None: ...


@overload
def _model_dump(model: BaseModel) -> dict[str, Any]: ...


def _model_dump(model: BaseModel | None) -> dict[str, Any] | None:
    if model is None:
        return None
    return model.model_dump(mode="json", exclude_none=True)


def _without(data: dict[str, Any], key: str) -> dict[str, Any]:
    return {k: v for k, v in data.items() if k != key}


def _optional_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    return float(value)


def _clean_operation_data(data: dict[str, Any]) -> dict[str, Any]:
    op_type = data.get("type")
    if op_type == OperationType.BASH_COMMAND:
        if not data.get("working_dir"):
            data.pop("working_dir", None)
    if op_type in {OperationType.PYTHON_SCRIPT, OperationType.SHELL_SCRIPT}:
        data["args"] = data.get("args") or []
    if op_type == OperationType.AGENT and not data.get("fan_source"):
        data["fan_source"] = None
    return data


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9-]", "-", value.lower())
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug or "workflow"


def _node_label(node_id: str) -> str:
    return node_id.replace("_", " ").replace("-", " ").title()


def _operation_meta(operation: dict[str, Any]) -> str:
    match operation.get("type"):
        case OperationType.BASH_COMMAND:
            return str(operation.get("command", "bash command"))
        case OperationType.PYTHON_SCRIPT | OperationType.SHELL_SCRIPT:
            return str(operation.get("script_path", "script"))
        case OperationType.AGENT:
            agent_id = operation.get("agent_id", "agent")
            prompt_path = operation.get("prompt_path")
            return f"{agent_id} · {prompt_path}" if prompt_path else str(agent_id)
    return str(operation.get("type", "operation"))


def _edge_label(condition: str, output_pattern: str | None) -> str:
    if condition == "always":
        return "always"
    if condition == "output_matches" and output_pattern:
        return f"matches {output_pattern}"
    return condition.replace("_", " ")


def _workflow_description(workflow: AgenticWorkflow, schedule: dict[str, Any] | None) -> str:
    node_count = len(list(workflow.graph._graph.nodes()))
    edge_count = len(list(workflow.graph._graph.edges()))
    agent_count = len(workflow.agents)
    schedule_text = f" Scheduled with {schedule['cron_expression']}." if schedule else ""
    return f"{node_count} nodes, {edge_count} edges, {agent_count} agents.{schedule_text}"


def _workflow_status(schedule: dict[str, Any] | None) -> str:
    return "Scheduled" if schedule else "Ready"


def _latest_run_status(workflow_id: str, path: Path | None) -> str:
    if path is None:
        return "Ready"

    log_dir = path.parent / "logs" / workflow_id
    if not log_dir.exists():
        return "Ready"

    logs = sorted(
        log_dir.glob("*.log"),
        key=lambda log_path: (log_path.stat().st_mtime, log_path.name),
    )
    if not logs:
        return "Ready"

    try:
        last_line = logs[-1].read_text().splitlines()[-1]
    except (IndexError, OSError):
        return "Ready"

    if f"{workflow_id} completed successfully" in last_line:
        return "Success"
    if f"{workflow_id} failed due to" in last_line:
        return "Error"
    return "Running"


def _updated_at(path: Path | None) -> str:
    if path is None or not path.exists():
        return "Unknown"
    return datetime.fromtimestamp(path.stat().st_mtime).strftime("%b %d, %Y %H:%M")
