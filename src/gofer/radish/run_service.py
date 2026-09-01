"""Compile, preflight, execute, and persist one Radish workflow run."""

from __future__ import annotations

import json
import os
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, cast

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]
from jsonschema.exceptions import ValidationError  # type: ignore[import-untyped]

from gofer.core.approvals import NotificationAdapter
from gofer.radish.artifacts import (
    CompiledArtifact,
    compile_radish_file,
    radish_asset_root,
)
from gofer.radish.contracts import canonical_json_bytes
from gofer.radish.preflight import PreflightRegistry, PreflightResult, run_preflight
from gofer.radish.provider_runtime import default_provider_subscriptions
from gofer.radish.runtime import (
    DEFAULT_NODE_HANDLERS,
    InvalidRadishWorkflowInputError,
    NodeHandlerRegistry,
    RuntimeErrorInfo,
)
from gofer.radish.storage import migrate_legacy_directory, registered_source_root
from gofer.radish.workflow_runtime import (
    NodeRunRecord,
    WorkflowExecutionResult,
    execute_workflow,
)
from gofer.subscriptions.base import Subscription
from gofer.utils.paths import get_data_dir

RUN_ARTIFACT_VERSION = 1
RunStatus = Literal["passed", "failed", "preflight_failed", "invalid_inputs"]


class RadishRunArtifactError(RuntimeError):
    """Raised when a completed run artifact cannot be published."""


@dataclass(frozen=True, slots=True)
class RadishRunResult:
    document: dict[str, Any]
    path: Path
    compiled: CompiledArtifact
    preflight: PreflightResult

    @property
    def status(self) -> RunStatus:
        return cast(RunStatus, self.document["status"])

    @property
    def ok(self) -> bool:
        return self.status == "passed"


async def run_radish_file(
    source_path: Path,
    *,
    workflow_inputs: Mapping[str, Any] | None = None,
    trigger_events: list[Mapping[str, Any]] | tuple[Mapping[str, Any], ...] | None = None,
    data_dir: Path | None = None,
    handlers: NodeHandlerRegistry | None = None,
    subscriptions: Mapping[str, Subscription] | None = None,
    preflight_registry: PreflightRegistry | None = None,
    notification_adapter: NotificationAdapter | None = None,
) -> RadishRunResult:
    """Run one source file through the same boundary used by CLI and Studio."""
    started_at = datetime.now(UTC).isoformat()
    started_clock = time.monotonic()
    resolved_data_dir = data_dir or get_data_dir()
    compiled = compile_radish_file(source_path, data_dir=resolved_data_dir)
    runtime_handlers = handlers or DEFAULT_NODE_HANDLERS
    runtime_subscriptions = (
        subscriptions if subscriptions is not None else default_provider_subscriptions()
    )
    deployment = run_preflight(
        compiled.ir,
        registry=preflight_registry,
        data_dir=resolved_data_dir,
        subscriptions=runtime_subscriptions,
        handlers=runtime_handlers,
    )
    run_id = _new_run_id()
    supplied_inputs = dict(workflow_inputs or {})

    execution: WorkflowExecutionResult | None = None
    input_error: RuntimeErrorInfo | None = None
    if deployment.ready:
        try:
            execution = await execute_workflow(
                compiled.ir,
                workflow_inputs=supplied_inputs,
                trigger_events=trigger_events,
                handlers=runtime_handlers,
                subscriptions=runtime_subscriptions,
                data_dir=resolved_data_dir,
                notification_adapter=notification_adapter,
                run_id=run_id,
            )
        except InvalidRadishWorkflowInputError as exc:
            input_error = RuntimeErrorInfo(
                "configuration",
                "RADISH_WORKFLOW_INPUT_INVALID",
                str(exc),
            )

    finished_at = datetime.now(UTC).isoformat()
    status = _run_status(deployment, execution, input_error)
    document = _run_document(
        run_id=run_id,
        status=status,
        compiled=compiled,
        deployment=deployment,
        execution=execution,
        input_error=input_error,
        input_names=sorted(supplied_inputs),
        started_at=started_at,
        finished_at=finished_at,
        duration_ms=round((time.monotonic() - started_clock) * 1000),
    )
    path = _run_path(
        resolved_data_dir,
        compiled.ir["workflow"]["id"],
        run_id,
        source_path=compiled.source_path,
    )
    _write_json_atomic(path, document)
    return RadishRunResult(document, path, compiled, deployment)


def _run_status(
    deployment: PreflightResult,
    execution: WorkflowExecutionResult | None,
    input_error: RuntimeErrorInfo | None,
) -> RunStatus:
    if not deployment.ready:
        return "preflight_failed"
    if input_error is not None:
        return "invalid_inputs"
    if execution is not None and execution.outcome == "pass":
        return "passed"
    return "failed"


def _run_document(
    *,
    run_id: str,
    status: RunStatus,
    compiled: CompiledArtifact,
    deployment: PreflightResult,
    execution: WorkflowExecutionResult | None,
    input_error: RuntimeErrorInfo | None,
    input_names: list[str],
    started_at: str,
    finished_at: str,
    duration_ms: int,
) -> dict[str, Any]:
    ir = compiled.ir
    runs = [_node_run_document(record) for record in execution.runs] if execution else []
    error = input_error or (execution.error if execution is not None else None)
    events: list[dict[str, Any]] = [{"sequence": 1, "type": "workflow_started", "at": started_at}]
    for sequence, run in enumerate(runs, start=2):
        events.append(
            {
                "sequence": sequence,
                "type": "node_completed",
                "at": run["finished_at"],
                "node_id": run["node_id"],
                "run_number": run["run_number"],
                "outcome": run["outcome"],
            }
        )
    events.append(
        {
            "sequence": len(events) + 1,
            "type": "workflow_completed",
            "at": finished_at,
            "status": status,
        }
    )
    return {
        "run_artifact_version": RUN_ARTIFACT_VERSION,
        "run_id": run_id,
        "status": status,
        "workflow": {
            "id": ir["workflow"]["id"],
            "name": ir["workflow"]["name"],
        },
        "source": {
            "path": str(compiled.source_path),
            "source_fingerprint": ir["source"]["source_fingerprint"],
            "compilation_fingerprint": ir["source"]["compilation_fingerprint"],
            "cache_hit": compiled.cache_hit,
        },
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_ms": duration_ms,
        "input_names": input_names,
        "diagnostics": [
            *compiled.diagnostics,
            *(item.to_json() for item in deployment.diagnostics),
        ],
        "events": events,
        "runs": runs,
        "outputs": execution.outputs if execution is not None else {},
        "latest_node_outputs": execution.latest_node_outputs if execution is not None else {},
        "error": _runtime_error_document(error),
    }


def _node_run_document(record: NodeRunRecord) -> dict[str, Any]:
    return {
        "node_id": record.node_id,
        "run_number": record.run_number,
        "activation_lineage_id": record.activation_lineage_id,
        "activation_group_id": record.activation_group_id,
        "started_at": record.started_at,
        "finished_at": record.finished_at,
        "duration_ms": record.duration_ms,
        "outcome": record.result.outcome,
        "output": record.result.output,
        "error": _runtime_error_document(record.result.error),
    }


def _runtime_error_document(error: RuntimeErrorInfo | None) -> dict[str, Any] | None:
    if error is None:
        return None
    return {
        "kind": error.kind,
        "code": error.code,
        "message": error.message,
        "details": error.details,
    }


def _new_run_id() -> str:
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    return f"{timestamp}-{uuid.uuid4().hex[:12]}"


def _run_path(
    data_dir: Path,
    workflow_id: str,
    run_id: str,
    *,
    source_path: Path,
) -> Path:
    workflow_root = registered_source_root(source_path, data_dir)
    if workflow_root is not None:
        directory = workflow_root / "logs"
        migrate_legacy_directory(data_dir / "radish" / "runs" / workflow_id, directory)
        return directory / f"{run_id}.json"
    return data_dir / "radish" / "runs" / workflow_id / f"{run_id}.json"


def _write_json_atomic(path: Path, document: dict[str, Any]) -> None:
    try:
        schema = json.loads(
            (radish_asset_root() / "schemas" / "run.schema.json").read_text(encoding="utf-8")
        )
        Draft202012Validator(schema).validate(document)
    except (OSError, UnicodeError, json.JSONDecodeError, ValidationError) as exc:
        raise RadishRunArtifactError(f"Invalid Radish run artifact: {exc}") from exc
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_bytes(canonical_json_bytes(document) + b"\n")
        os.replace(temporary, path)
    except (OSError, TypeError, ValueError) as exc:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise RadishRunArtifactError(f"Could not publish Radish run artifact: {exc}") from exc
