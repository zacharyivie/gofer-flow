from __future__ import annotations

import hmac
import json
import os
import re
import shutil
import threading
import tomllib
import urllib.parse
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast, overload

import anyio
import tomli_w
from pydantic import BaseModel, TypeAdapter

from gofer.core.agent import AgentConfig
from gofer.core.approvals import ApprovalRequest, ApprovalStore
from gofer.core.bundles import (
    BundleError,
    export_workflow_bundle,
    import_workflow_bundle,
    preview_workflow_bundle,
)
from gofer.core.dashboards import (
    DashboardComponentType,
    DashboardError,
    add_component,
    add_item,
    add_section,
    create_dashboard,
    delete_component,
    delete_dashboard,
    delete_item,
    delete_section,
    duplicate_dashboard,
    list_dashboards,
    list_items,
    load_dashboard,
    move_item,
    rename_dashboard,
    set_component_content,
    set_component_display,
    set_component_schema,
    set_component_title,
    set_component_views,
    update_item,
    update_section,
)
from gofer.core.executor import (
    ResumeOptions,
    WorkflowExecutor,
    _collect_configured_secret_text_values,
    _collect_configured_secret_values,
    _is_sensitive_field,
    _mask_http_text,
    _mask_http_url,
    _mask_http_value,
)
from gofer.core.graph import EdgeConditionType, EdgeConfig, GraphNode
from gofer.core.health import run_health_checks, workflow_health_diagnostics
from gofer.core.operations import (
    HttpRequestOperation,
    NotificationOperation,
    Operation,
    OperationType,
)
from gofer.core.planner import build_execution_plan
from gofer.core.provider_profiles import (
    load_provider_profiles,
    provider_profile_from_ui_payload,
    provider_profile_ui_payload,
    save_provider_profiles,
    validate_provider_profile_name,
)
from gofer.core.resources import (
    DEFAULT_RESOURCE_LIMITS,
    ResourceLimits,
    byte_len,
    read_text_file_range,
    tail_text_file,
    truncate_text_bytes,
)
from gofer.core.revisions import (
    WorkflowRevisionError,
    capture_workflow_revision,
    diff_workflow_revision,
    list_workflow_revisions,
    restore_workflow_revision,
)
from gofer.core.runner import (
    RunnerQueueStore,
    workflow_required_capabilities,
)
from gofer.core.secrets import workflow_secret_readiness
from gofer.core.templates import (
    create_workflow_from_template,
    list_workflow_templates,
    preview_workflow_template,
)
from gofer.core.usage import LlmUsageBudget, summarize_node_outputs
from gofer.core.validation import (
    validate_workflow,
    validate_workflow_data,
    validate_workflow_file,
)
from gofer.core.workflow import (
    AgenticWorkflow,
    FilesystemAccessEntry,
    WebhookTriggerConfig,
    WorkflowConfig,
    WorkflowMetadata,
    masked_workflow_parameters,
    resolve_workflow_parameters,
    validate_workflow_id,
)
from gofer.subscriptions.claude_code import ClaudeCodeSubscription
from gofer.subscriptions.codex import CodexSubscription
from gofer.subscriptions.direct_api import AnthropicApiSubscription, OpenAiApiSubscription
from gofer.ui.chat import delete_workflow_chat_prompt, workflow_chat_prompt_path
from gofer.utils.paths import get_data_dir
from gofer.utils.run_state import (
    request_workflow_run_stop,
    request_workflow_stop,
)


class WorkflowAlreadyExistsError(ValueError):
    pass


class WorkflowCreateError(ValueError):
    pass


class WorkflowUpdateError(ValueError):
    pass


class WorkflowRunError(ValueError):
    pass


class WorkflowTriggerError(ValueError):
    pass


class RunnerQueueError(ValueError):
    pass


class WorkflowApprovalError(ValueError):
    pass


class WorkflowPlanError(ValueError):
    pass


class WorkflowHistoryError(ValueError):
    pass


class ProviderProfileError(ValueError):
    pass


class WorkflowLogError(ValueError):
    pass


class WorkflowBundleError(ValueError):
    pass


class DashboardUiError(ValueError):
    pass


_operation_adapter: TypeAdapter[Operation] = TypeAdapter(Operation)
_subscriptions = {
    "claude_code": ClaudeCodeSubscription(),
    "codex": CodexSubscription(),
    "openai_api": OpenAiApiSubscription(),
    "anthropic_api": AnthropicApiSubscription(),
}
_active_run_stop_events: dict[tuple[str, str], set[threading.Event]] = {}
_active_run_log_paths: dict[tuple[str, str], dict[threading.Event, Path]] = {}
_active_run_lock = threading.Lock()
RUN_ID_PATTERN = re.compile(r"[A-Za-z0-9_.+-]+\.log")
CHAT_THREAD_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
RUN_NODE_OUTPUTS_SUFFIX = ".outputs.json"
RUN_EVENTS_SUFFIX = ".events.json"
RUN_SUMMARY_SUFFIX = ".summary.json"
RUN_TRIGGER_SUFFIX = ".trigger.json"
RETENTION_SETTINGS_FILE = "retention.json"
DEFAULT_RETENTION_SETTINGS = {"keepDays": 14, "keepFailedDays": 30, "keepLast": 100}
INDEX_VERSION = 1
WORKFLOW_INDEX_FILE = "workflows.json"
RUN_INDEX_PREFIX = "runs-"


def list_workflow_payloads(data_dir: Path | None = None) -> dict[str, Any]:
    """Return serializable workflow summaries for the React UI."""
    base = _data_dir(data_dir)
    workflows: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    if not base.exists():
        return {
            "dataDir": str(base),
            "workflows": workflows,
            "errors": errors,
            "promptAgentIds": [],
        }

    workflow_index = _read_workflow_index(base)
    index_entries = _workflow_index_entries(workflow_index)
    index_changed = False
    for path in sorted(base.glob("*.toml")):
        cached = _workflow_index_payload(base, index_entries.get(path.name), path)
        if cached is not None:
            workflows.append(cached)
            continue
        try:
            workflow = AgenticWorkflow.from_file(path)
        except Exception as exc:
            error = {"path": path.name, "message": str(exc)}
            errors.append(error)
            payload = invalid_workflow_payload(path, str(exc))
            workflows.append(payload)
            index_entries[path.name] = _workflow_index_entry(path, payload)
            index_changed = True
            continue

        payload = workflow_to_payload(workflow, path)
        workflows.append(payload)
        index_entries[path.name] = _workflow_index_entry(path, payload)
        index_changed = True

    existing_names = {path.name for path in base.glob("*.toml")}
    stale_names = [name for name in index_entries if name not in existing_names]
    for name in stale_names:
        index_entries.pop(name, None)
        index_changed = True
    if index_changed:
        _write_workflow_index(base, index_entries)

    return {
        "dataDir": str(base),
        "workflows": workflows,
        "errors": errors,
        "promptAgentIds": prompt_agent_ids(base),
    }


def health_payload(
    data_dir: Path | None = None,
    workflow: str | None = None,
) -> dict[str, Any]:
    """Return environment health diagnostics for the React UI."""
    return run_health_checks(data_dir=data_dir, workflow=workflow).to_dict()


def provider_profiles_payload(data_dir: Path | None = None) -> dict[str, Any]:
    profiles = load_provider_profiles(_data_dir(data_dir))
    return {"profiles": [provider_profile_ui_payload(profile) for profile in profiles.values()]}


def runner_queue_payload(data_dir: Path | None = None) -> dict[str, Any]:
    store = RunnerQueueStore(_data_dir(data_dir))
    return {
        "executionModes": ["local", "remote"],
        "runners": [runner.to_payload() for runner in store.list_runners()],
        "runs": [run.to_payload() for run in store.list_runs()],
    }


def dashboard_payload(data_dir: Path | None = None) -> dict[str, Any]:
    try:
        dashboards = list_dashboards(_data_dir(data_dir))
    except DashboardError as exc:
        raise DashboardUiError(str(exc)) from exc
    return {
        "dashboards": [dashboard.model_dump(mode="json", by_alias=True) for dashboard in dashboards]
    }


def create_dashboard_payload(
    name: str,
    data_dir: Path | None = None,
    dashboard_id: str | None = None,
) -> dict[str, Any]:
    try:
        dashboard = create_dashboard(name, _data_dir(data_dir), dashboard_id)
    except DashboardError as exc:
        raise DashboardUiError(str(exc)) from exc
    return {"dashboard": dashboard.model_dump(mode="json", by_alias=True)}


def update_dashboard_payload(
    dashboard_id: str,
    data_dir: Path | None = None,
    *,
    name: str | None = None,
    duplicate: bool = False,
) -> dict[str, Any]:
    try:
        dashboard = (
            duplicate_dashboard(dashboard_id, _data_dir(data_dir), name)
            if duplicate
            else rename_dashboard(dashboard_id, name or "", _data_dir(data_dir))
        )
    except DashboardError as exc:
        raise DashboardUiError(str(exc)) from exc
    return {"dashboard": dashboard.model_dump(mode="json", by_alias=True)}


def delete_dashboard_payload(dashboard_id: str, data_dir: Path | None = None) -> dict[str, Any]:
    try:
        delete_dashboard(dashboard_id, _data_dir(data_dir))
    except DashboardError as exc:
        raise DashboardUiError(str(exc)) from exc
    return {"deleted": dashboard_id}


def add_dashboard_section_payload(
    dashboard_id: str,
    title: str,
    data_dir: Path | None = None,
    section_id: str | None = None,
) -> dict[str, Any]:
    try:
        dashboard = add_section(dashboard_id, title, _data_dir(data_dir), section_id)
    except DashboardError as exc:
        raise DashboardUiError(str(exc)) from exc
    return {"dashboard": dashboard.model_dump(mode="json", by_alias=True)}


def update_dashboard_section_payload(
    dashboard_id: str,
    section_id: str,
    data_dir: Path | None = None,
    *,
    title: str | None = None,
    layout: dict[str, Any] | None = None,
) -> dict[str, Any]:
    try:
        dashboard = update_section(
            dashboard_id,
            section_id,
            _data_dir(data_dir),
            title=title,
            layout=layout,
        )
    except DashboardError as exc:
        raise DashboardUiError(str(exc)) from exc
    return {"dashboard": dashboard.model_dump(mode="json", by_alias=True)}


def delete_dashboard_section_payload(
    dashboard_id: str,
    section_id: str,
    data_dir: Path | None = None,
) -> dict[str, Any]:
    try:
        dashboard = delete_section(dashboard_id, section_id, _data_dir(data_dir))
    except DashboardError as exc:
        raise DashboardUiError(str(exc)) from exc
    return {"dashboard": dashboard.model_dump(mode="json", by_alias=True)}


def add_dashboard_component_payload(
    dashboard_id: str,
    section_id: str,
    title: str,
    component_type: DashboardComponentType,
    data_dir: Path | None = None,
    component_id: str | None = None,
) -> dict[str, Any]:
    try:
        dashboard = add_component(
            dashboard_id,
            section_id,
            title,
            component_type,
            _data_dir(data_dir),
            component_id,
        )
    except DashboardError as exc:
        raise DashboardUiError(str(exc)) from exc
    return {"dashboard": dashboard.model_dump(mode="json", by_alias=True)}


def delete_dashboard_component_payload(
    dashboard_id: str,
    component_id: str,
    data_dir: Path | None = None,
) -> dict[str, Any]:
    try:
        dashboard = delete_component(dashboard_id, component_id, _data_dir(data_dir))
    except DashboardError as exc:
        raise DashboardUiError(str(exc)) from exc
    return {"dashboard": dashboard.model_dump(mode="json", by_alias=True)}


def update_dashboard_component_payload(
    dashboard_id: str,
    component_id: str,
    data_dir: Path | None = None,
    *,
    content: str | None = None,
    display: dict[str, Any] | None = None,
    schema: dict[str, Any] | None = None,
    title: str | None = None,
    views: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    try:
        if title is not None:
            dashboard = set_component_title(
                dashboard_id,
                component_id,
                title,
                _data_dir(data_dir),
            )
        elif content is not None:
            dashboard = set_component_content(
                dashboard_id,
                component_id,
                content,
                _data_dir(data_dir),
            )
        elif schema is not None:
            dashboard = set_component_schema(
                dashboard_id,
                component_id,
                schema,
                _data_dir(data_dir),
            )
        elif views is not None:
            dashboard = set_component_views(dashboard_id, component_id, views, _data_dir(data_dir))
        elif display is not None:
            dashboard = set_component_display(
                dashboard_id,
                component_id,
                display,
                _data_dir(data_dir),
            )
        else:
            dashboard = load_dashboard(dashboard_id, _data_dir(data_dir))
    except DashboardError as exc:
        raise DashboardUiError(str(exc)) from exc
    return {"dashboard": dashboard.model_dump(mode="json", by_alias=True)}


def dashboard_items_payload(
    dashboard_id: str,
    component_id: str,
    data_dir: Path | None = None,
    filter_rule: str | None = None,
) -> dict[str, Any]:
    try:
        items = list_items(dashboard_id, component_id, _data_dir(data_dir), filter_rule)
    except DashboardError as exc:
        raise DashboardUiError(str(exc)) from exc
    return {"items": items}


def mutate_dashboard_item_payload(
    dashboard_id: str,
    component_id: str,
    action: str,
    body: dict[str, Any],
    data_dir: Path | None = None,
) -> dict[str, Any]:
    try:
        if action == "add":
            item = add_item(
                dashboard_id,
                component_id,
                dict(body.get("item") or {}),
                _data_dir(data_dir),
            )
        elif action == "update":
            item = update_item(
                dashboard_id,
                component_id,
                str(body.get("itemId") or body.get("id") or ""),
                dict(body.get("patch") or body.get("item") or {}),
                _data_dir(data_dir),
            )
        elif action == "delete":
            item = delete_item(
                dashboard_id,
                component_id,
                str(body.get("itemId") or body.get("id") or ""),
                _data_dir(data_dir),
            )
        elif action == "move":
            item = move_item(
                dashboard_id,
                component_id,
                str(body.get("itemId") or body.get("id") or ""),
                str(body.get("field") or "status"),
                body.get("value"),
                _data_dir(data_dir),
            )
        else:
            raise DashboardUiError(f"Unsupported dashboard item action: {action}")
    except DashboardError as exc:
        raise DashboardUiError(str(exc)) from exc
    try:
        dashboard = load_dashboard(dashboard_id, _data_dir(data_dir))
    except DashboardError as exc:
        raise DashboardUiError(str(exc)) from exc
    return {"item": item, "dashboard": dashboard.model_dump(mode="json", by_alias=True)}


def queue_workflow_run_payload(
    workflow_id: str,
    data_dir: Path | None = None,
    *,
    priority: int = 0,
    trigger: str = "ui",
    parameters: dict[str, Any] | None = None,
    target_labels: list[str] | None = None,
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    path = _workflow_toml_path(workflow_id, base, error_cls=RunnerQueueError)
    if not path.exists():
        raise RunnerQueueError(f"Workflow '{workflow_id}' not found")
    try:
        workflow = AgenticWorkflow.from_file(path)
        workflow.validate(path, base)
    except Exception as exc:
        raise RunnerQueueError(str(exc)) from exc
    queued_parameters = dict(parameters or {})
    workflow_params = queued_parameters.get("workflowParams")
    if workflow_params is None:
        workflow_params = {}
    if not isinstance(workflow_params, dict):
        raise RunnerQueueError("workflowParams must be an object")
    try:
        queued_parameters["workflowParams"] = resolve_workflow_parameters(
            workflow.config,
            workflow_params,
        )
    except ValueError as exc:
        raise RunnerQueueError(str(exc)) from exc
    queued = RunnerQueueStore(base).enqueue(
        workflow.config.id,
        path,
        priority=priority,
        trigger=trigger,
        parameters=queued_parameters,
        target_labels=target_labels or [],
        required_capabilities=workflow_required_capabilities(workflow),
    )
    return {"run": queued.to_payload()}


def cancel_queued_run_payload(
    run_id: str,
    data_dir: Path | None = None,
) -> dict[str, Any]:
    try:
        queued = RunnerQueueStore(_data_dir(data_dir)).cancel_run(run_id)
    except ValueError as exc:
        raise RunnerQueueError(str(exc)) from exc
    return {"run": queued.to_payload()}


def upsert_provider_profile_payload(
    payload: dict[str, Any],
    data_dir: Path | None = None,
) -> dict[str, Any]:
    profiles = load_provider_profiles(_data_dir(data_dir))
    existing_name = payload.get("name")
    existing = profiles.get(existing_name) if isinstance(existing_name, str) else None
    try:
        profile = provider_profile_from_ui_payload(payload, existing)
    except ValueError as exc:
        raise ProviderProfileError(str(exc)) from exc
    profiles[profile.name] = profile
    save_provider_profiles(profiles, _data_dir(data_dir))
    return {"profile": provider_profile_ui_payload(profile)}


def delete_provider_profile_payload(
    name: str,
    data_dir: Path | None = None,
) -> dict[str, Any]:
    try:
        validate_provider_profile_name(name)
    except ValueError as exc:
        raise ProviderProfileError(str(exc)) from exc
    profiles = load_provider_profiles(_data_dir(data_dir))
    if name not in profiles:
        raise ProviderProfileError(f"Provider profile '{name}' not found")
    del profiles[name]
    save_provider_profiles(profiles, _data_dir(data_dir))
    return {"profile": name, "deleted": True}


def prompt_agent_ids(data_dir: Path) -> list[str]:
    base = _data_dir(data_dir)
    prompts_dir = _safe_path(base, "prompts", error_cls=WorkflowUpdateError)
    if not prompts_dir.exists():
        return []
    return sorted(
        {path.stem for path in prompts_dir.glob("*.md") if re.fullmatch(r"agent-\d+", path.stem)},
        key=_agent_id_sort_key,
    )


def _agent_id_sort_key(agent_id: str) -> tuple[int, str]:
    match = re.fullmatch(r"agent-(\d+)", agent_id)
    return (int(match.group(1)) if match else 0, agent_id)


def _index_dir(base: Path) -> Path:
    return _safe_path(base, "indexes", error_cls=WorkflowLogError)


def _workflow_index_path(base: Path) -> Path:
    return _index_dir(base) / WORKFLOW_INDEX_FILE


def _run_index_path(base: Path, workflow_id: str) -> Path:
    safe_id = _validate_storage_workflow_id(workflow_id, WorkflowLogError)
    return _index_dir(base) / f"{RUN_INDEX_PREFIX}{safe_id}.json"


def _read_index_document(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict) or payload.get("version") != INDEX_VERSION:
        return {}
    return payload


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp_path.write_text(
        json.dumps(payload, default=str, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    os.replace(tmp_path, path)


def _read_workflow_index(base: Path) -> dict[str, Any]:
    return _read_index_document(_workflow_index_path(base))


def _workflow_index_entries(index: dict[str, Any]) -> dict[str, Any]:
    entries = index.get("workflows")
    return cast(dict[str, Any], entries) if isinstance(entries, dict) else {}


def _write_workflow_index(base: Path, entries: dict[str, Any]) -> None:
    try:
        _write_json_atomic(
            _workflow_index_path(base),
            {
                "version": INDEX_VERSION,
                "updatedAt": datetime.now(UTC).isoformat(),
                "workflows": entries,
            },
        )
    except OSError:
        return


def _file_index_stat(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {"mtimeNs": stat.st_mtime_ns, "size": stat.st_size}


def _index_stat_matches(entry: dict[str, Any], path: Path) -> bool:
    try:
        stat = _file_index_stat(path)
    except OSError:
        return False
    return bool(entry.get("mtimeNs") == stat["mtimeNs"] and entry.get("size") == stat["size"])


def _workflow_status_from_run_status(status: object) -> str:
    status_value = str(status or "unknown")
    if status_value == "success":
        return "Success"
    if status_value == "error":
        return "Error"
    if status_value == "stopped":
        return "Stopped"
    return "Running"


def _workflow_payload_with_latest_run(
    payload: dict[str, Any],
    latest_run: dict[str, Any] | None,
) -> dict[str, Any]:
    updated = dict(payload)
    updated["status"] = (
        _workflow_status_from_run_status(latest_run.get("status"))
        if latest_run is not None
        else "Ready"
    )
    tags = list(updated.get("tags") or [])
    if tags:
        tags[0] = str(updated["status"]).lower()
    else:
        tags = [str(updated["status"]).lower()]
    updated["tags"] = tags
    return updated


def _latest_run_index_metadata(log_path: Path, summary: dict[str, Any]) -> dict[str, Any] | None:
    try:
        return {
            "id": log_path.name,
            **_file_index_stat(log_path),
            "status": summary.get("status"),
            "startedAt": summary.get("startedAt"),
            "finishedAt": summary.get("finishedAt"),
            "triggerType": summary.get("triggerType"),
        }
    except OSError:
        return None


def _workflow_index_entry(
    path: Path,
    payload: dict[str, Any],
    latest_run: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        **_file_index_stat(path),
        "latestRun": latest_run,
        "payload": _workflow_payload_with_latest_run(payload, latest_run),
    }


def _workflow_index_latest_run_matches(base: Path, entry: dict[str, Any]) -> bool:
    latest_run = entry.get("latestRun")
    if latest_run is None:
        return True
    if not isinstance(latest_run, dict):
        return False
    run_id = latest_run.get("id")
    payload = entry.get("payload")
    workflow_id = payload.get("id") if isinstance(payload, dict) else None
    if not isinstance(run_id, str) or not isinstance(workflow_id, str):
        return False
    log_path = base / "logs" / workflow_id / run_id
    return _index_stat_matches(latest_run, log_path)


def _workflow_index_payload(base: Path, entry: Any, path: Path) -> dict[str, Any] | None:
    if not isinstance(entry, dict) or not _index_stat_matches(entry, path):
        return None
    if not _workflow_index_latest_run_matches(base, entry):
        return None
    payload = entry.get("payload")
    return cast(dict[str, Any], payload) if isinstance(payload, dict) else None


def _upsert_workflow_index(base: Path, path: Path, payload: dict[str, Any]) -> None:
    entries = _workflow_index_entries(_read_workflow_index(base))
    workflow_id = str(payload.get("id") or _slugify(path.stem))
    existing = entries.get(path.name)
    latest_run = None
    if isinstance(existing, dict) and _workflow_index_latest_run_matches(base, existing):
        existing_latest_run = existing.get("latestRun")
        if isinstance(existing_latest_run, dict):
            latest_run = existing_latest_run
    if latest_run is None:
        latest_run = _latest_run_metadata_from_index_entries(
            base,
            workflow_id,
            _run_index_entries(_read_run_index(base, workflow_id)),
        )
    try:
        entries[path.name] = _workflow_index_entry(path, payload, latest_run)
    except OSError:
        return
    _write_workflow_index(base, entries)


def _remove_workflow_index_entry(base: Path, workflow_id: str) -> None:
    entries = _workflow_index_entries(_read_workflow_index(base))
    if entries.pop(f"{workflow_id}.toml", None) is not None:
        _write_workflow_index(base, entries)


def _workflow_index_key_for_id(entries: dict[str, Any], workflow_id: str) -> str | None:
    direct = f"{workflow_id}.toml"
    if direct in entries:
        return direct
    for key, entry in entries.items():
        if not isinstance(entry, dict):
            continue
        payload = entry.get("payload")
        if isinstance(payload, dict) and payload.get("id") == workflow_id:
            return key
    return None


def _sync_workflow_index_latest_run(
    base: Path,
    workflow_id: str,
    latest_run: dict[str, Any] | None,
) -> None:
    entries = _workflow_index_entries(_read_workflow_index(base))
    key = _workflow_index_key_for_id(entries, workflow_id)
    if key is None:
        return
    entry = entries.get(key)
    if not isinstance(entry, dict):
        return
    payload = entry.get("payload")
    if not isinstance(payload, dict):
        return
    entry["latestRun"] = latest_run
    entry["payload"] = _workflow_payload_with_latest_run(payload, latest_run)
    _write_workflow_index(base, entries)


def _latest_run_metadata_from_index_entries(
    base: Path,
    workflow_id: str,
    entries: dict[str, Any],
) -> dict[str, Any] | None:
    latest_name = None
    latest_key: tuple[int, str] | None = None
    for name, entry in entries.items():
        if not isinstance(name, str) or not isinstance(entry, dict):
            continue
        log_path = base / "logs" / workflow_id / name
        if not RUN_ID_PATTERN.fullmatch(name) or not _index_stat_matches(entry, log_path):
            continue
        mtime_ns = entry.get("mtimeNs")
        if not isinstance(mtime_ns, int):
            continue
        key = (mtime_ns, name)
        if latest_key is None or key > latest_key:
            latest_name = name
            latest_key = key
    if latest_name is None:
        return None
    entry = entries.get(latest_name)
    if not isinstance(entry, dict):
        return None
    summary = entry.get("summary")
    if not isinstance(summary, dict):
        return None
    log_path = base / "logs" / workflow_id / latest_name
    return _latest_run_index_metadata(log_path, summary)


def invalid_workflow_payload(path: Path, message: str) -> dict[str, Any]:
    workflow_id = _slugify(path.stem)
    return {
        "id": workflow_id,
        "name": path.stem.replace("-", " ").replace("_", " ").title(),
        "description": f"Invalid workflow TOML: {message}",
        "status": "Error",
        "updatedAt": _updated_at(path),
        "sourcePath": path.name,
        "schedule": None,
        "watch": None,
        "resourceLimits": _model_dump(DEFAULT_RESOURCE_LIMITS),
        "llmBudget": _model_dump(LlmUsageBudget()),
        "runContinuously": False,
        "maxTotalNodeRuns": 1000,
        "tags": ["error", "invalid"],
        "agents": {},
        "nodes": [],
        "edges": [],
        "invalid": True,
        "validationError": message,
    }


def list_workflow_templates_payload() -> dict[str, Any]:
    return {"templates": [template.to_dict() for template in list_workflow_templates()]}


def workflow_template_payload(name: str) -> dict[str, Any]:
    try:
        return {"template": preview_workflow_template(name).to_dict()}
    except ValueError as exc:
        raise WorkflowCreateError(str(exc)) from exc


def create_workflow_payload(
    name: str,
    data_dir: Path | None = None,
    *,
    template: str | None = None,
) -> dict[str, Any]:
    """Create a workflow TOML file and return its UI payload."""
    workflow_name = name.strip()
    if not workflow_name and not template:
        raise WorkflowCreateError("Workflow name is required")

    base = _data_dir(data_dir)
    base.mkdir(parents=True, exist_ok=True)

    if template:
        try:
            result = create_workflow_from_template(
                template,
                base,
                workflow_name=workflow_name or None,
            )
        except ValueError as exc:
            raise WorkflowCreateError(str(exc)) from exc
        capture_workflow_revision(result.path, base, source="template", author="ui")
        payload = workflow_to_payload(result.workflow, result.path)
        _upsert_workflow_index(base, result.path, payload)
        return payload

    workflow_id = _slugify(workflow_name)
    path = _workflow_toml_path(workflow_id, base, error_cls=WorkflowCreateError)
    if path.exists():
        raise WorkflowAlreadyExistsError(f"Workflow '{workflow_id}' already exists")

    workflow = AgenticWorkflow(WorkflowConfig(id=workflow_id, name=workflow_name))
    workflow.to_file(path)
    capture_workflow_revision(path, base, source="create", author="ui")
    payload = workflow_to_payload(workflow, path)
    _upsert_workflow_index(base, path, payload)
    return payload


def import_workflow_payload(content: str, data_dir: Path | None = None) -> dict[str, Any]:
    base = _data_dir(data_dir)

    try:
        workflow = AgenticWorkflow.from_dict(tomllib.loads(content))
        base.mkdir(parents=True, exist_ok=True)
        path = _workflow_toml_path(
            workflow.config.id,
            base,
            error_cls=WorkflowCreateError,
        )
        if path.exists():
            raise WorkflowAlreadyExistsError(f"Workflow '{workflow.config.id}' already exists")
        workflow.validate(path, base)
        workflow.to_file(path)
        capture_workflow_revision(path, base, source="import", author="ui")
    except WorkflowAlreadyExistsError:
        raise
    except Exception as exc:
        raise WorkflowCreateError(str(exc)) from exc

    payload = workflow_to_payload(workflow, path)
    _upsert_workflow_index(base, path, payload)
    return payload


def export_workflow_bundle_payload(
    workflow_id: str,
    output_path: Path,
    data_dir: Path | None = None,
    *,
    notes: str | None = None,
) -> dict[str, Any]:
    try:
        manifest = export_workflow_bundle(
            workflow_id,
            output_path,
            data_dir=_data_dir(data_dir),
            notes=notes,
        )
    except BundleError as exc:
        raise WorkflowBundleError(str(exc)) from exc
    return {"bundlePath": str(output_path), "manifest": manifest.to_dict()}


def preview_workflow_bundle_payload(
    bundle_path: Path,
    data_dir: Path | None = None,
    *,
    resource_limits: ResourceLimits | None = None,
) -> dict[str, Any]:
    try:
        return preview_workflow_bundle(
            bundle_path,
            data_dir=_data_dir(data_dir),
            limits=resource_limits,
        ).to_dict()
    except BundleError as exc:
        raise WorkflowBundleError(str(exc)) from exc


def import_workflow_bundle_payload(
    bundle_path: Path,
    data_dir: Path | None = None,
    *,
    replace: bool = False,
    dry_run: bool = False,
    resource_limits: ResourceLimits | None = None,
) -> dict[str, Any]:
    try:
        plan = import_workflow_bundle(
            bundle_path,
            data_dir=_data_dir(data_dir),
            replace=replace,
            dry_run=dry_run,
            limits=resource_limits,
        )
    except BundleError as exc:
        raise WorkflowBundleError(str(exc)) from exc
    if not dry_run and plan.workflow_path.exists():
        capture_workflow_revision(
            plan.workflow_path,
            _data_dir(data_dir),
            source="import",
            author="ui",
        )
        try:
            workflow = AgenticWorkflow.from_file(plan.workflow_path)
            _upsert_workflow_index(
                _data_dir(data_dir),
                plan.workflow_path,
                workflow_to_payload(workflow, plan.workflow_path),
            )
        except Exception:
            pass
    return plan.to_dict()


def delete_workflow_payload(workflow_id: str, data_dir: Path | None = None) -> dict[str, Any]:
    base = _data_dir(data_dir)
    path = _workflow_toml_path(workflow_id, base, error_cls=WorkflowUpdateError)
    if not path.exists():
        raise WorkflowUpdateError(f"Workflow '{workflow_id}' not found")
    path.unlink()
    shutil.rmtree(
        _workflow_storage_dir(base, "logs", workflow_id, error_cls=WorkflowUpdateError),
        ignore_errors=True,
    )
    try:
        _run_index_path(base, workflow_id).unlink()
    except FileNotFoundError:
        pass
    shutil.rmtree(
        _workflow_storage_dir(
            base,
            "agent-memory",
            workflow_id,
            error_cls=WorkflowUpdateError,
        ),
        ignore_errors=True,
    )
    delete_workflow_chat_prompt(base, workflow_id)
    _remove_workflow_index_entry(base, workflow_id)
    return {"workflowId": workflow_id, "deleted": True}


def rename_workflow_payload(
    workflow_id: str,
    name: str,
    data_dir: Path | None = None,
) -> dict[str, Any]:
    workflow_name = name.strip()
    if not workflow_name:
        raise WorkflowUpdateError("Workflow name is required")

    base = _data_dir(data_dir)
    path = _workflow_toml_path(workflow_id, base, error_cls=WorkflowUpdateError)
    if not path.exists():
        raise WorkflowUpdateError(f"Workflow '{workflow_id}' not found")

    workflow = AgenticWorkflow.from_file(path)
    workflow.config.name = workflow_name
    workflow.to_file(path)
    payload = workflow_to_payload(workflow, path)
    _upsert_workflow_index(base, path, payload)
    return payload


def _next_duplicate_name(original_name: str, base: Path) -> tuple[str, str]:
    candidate_number = 2
    while True:
        candidate_name = f"{original_name}-{candidate_number}"
        candidate_id = _slugify(candidate_name)
        if not _workflow_toml_path(
            candidate_id,
            base,
            error_cls=WorkflowCreateError,
        ).exists():
            return candidate_name, candidate_id
        candidate_number += 1


def _replace_workflow_header_value(text: str, key: str, value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    pattern = re.compile(
        rf"(^\[workflow\]\s*(?:(?!^\[).)*?^){key}\s*=\s*(['\"]).*?\2",
        re.MULTILINE | re.DOTALL,
    )
    replacement = rf'\1{key} = "{escaped}"'
    next_text, count = pattern.subn(replacement, text, count=1)
    if count:
        return next_text
    return re.sub(
        r"(^\[workflow\]\s*)",
        rf'\1{key} = "{escaped}"\n',
        text,
        count=1,
        flags=re.MULTILINE,
    )


def _copy_workflow_toml_with_identity(
    source_path: Path,
    target_path: Path,
    workflow_id: str,
    workflow_name: str,
) -> None:
    text = source_path.read_text(encoding="utf-8")
    text = _replace_workflow_header_value(text, "id", workflow_id)
    text = _replace_workflow_header_value(text, "name", workflow_name)
    target_path.write_text(text, encoding="utf-8")


def duplicate_workflow_payload(
    workflow_id: str,
    name: str | None = None,
    data_dir: Path | None = None,
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    path = _workflow_toml_path(workflow_id, base, error_cls=WorkflowUpdateError)
    if not path.exists():
        raise WorkflowUpdateError(f"Workflow '{workflow_id}' not found")

    source = AgenticWorkflow.from_file(path)
    if name and name.strip():
        candidate_name = name.strip()
        candidate_id = _slugify(candidate_name)
        if _workflow_toml_path(
            candidate_id,
            base,
            error_cls=WorkflowCreateError,
        ).exists():
            raise WorkflowAlreadyExistsError(f"Workflow '{candidate_id}' already exists")
    else:
        candidate_name, candidate_id = _next_duplicate_name(source.config.name, base)

    target_path = _workflow_toml_path(candidate_id, base, error_cls=WorkflowCreateError)
    _copy_workflow_toml_with_identity(path, target_path, candidate_id, candidate_name)
    duplicated = AgenticWorkflow.from_file(target_path)
    capture_workflow_revision(target_path, base, source="duplicate", author="ui")
    payload = workflow_to_payload(duplicated, target_path)
    _upsert_workflow_index(base, target_path, payload)
    return payload


def delete_workflow_chat_payload(
    workflow_id: str,
    data_dir: Path | None = None,
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    _validate_chat_prompt_id(workflow_id)
    path = workflow_chat_prompt_path(base, workflow_id).resolve()
    _assert_within_base(path, base, error_cls=WorkflowUpdateError)
    delete_workflow_chat_prompt(base, workflow_id)
    return {"workflowId": workflow_id, "deleted": True}


def update_workflow_payload(
    workflow_id: str, payload: dict[str, Any], data_dir: Path | None = None
) -> dict[str, Any]:
    """Persist a UI workflow payload back to TOML and return the saved payload."""
    if payload.get("id") != workflow_id:
        raise WorkflowUpdateError("Workflow ID in URL and payload must match")

    base = _data_dir(data_dir)
    base.mkdir(parents=True, exist_ok=True)
    path = _workflow_toml_path(workflow_id, base, error_cls=WorkflowUpdateError)
    if not path.exists():
        raise WorkflowUpdateError(f"Workflow '{workflow_id}' not found")

    try:
        audit_metadata = _workflow_audit_metadata(payload.pop("auditMetadata", None))
        workflow = AgenticWorkflow.from_file(path)
        payload = _restore_masked_http_secrets(payload, workflow)
        payload = _restore_masked_notification_secrets(payload, workflow)
        payload = _restore_masked_webhook_secrets(payload, workflow)
        workflow = workflow_from_payload(payload)
        workflow.validate(path, base)
        workflow.to_file(path)
        _write_ui_node_positions(path, _ui_node_positions_from_payload(payload))
        capture_workflow_revision(
            path,
            base,
            source="chat_patch" if audit_metadata else "autosave",
            author="ui",
            metadata=audit_metadata,
        )
    except Exception as exc:
        raise WorkflowUpdateError(str(exc)) from exc

    payload = workflow_to_payload(workflow, path)
    _upsert_workflow_index(base, path, payload)
    return payload


def _workflow_audit_metadata(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    allowed_keys = {
        "appliedHunkIds",
        "messageId",
        "patchTitle",
        "prompt",
        "response",
        "source",
        "threadId",
        "threadTitle",
    }
    metadata: dict[str, Any] = {}
    for key in allowed_keys:
        if key not in value:
            continue
        item = value[key]
        if isinstance(item, list):
            metadata[key] = [str(part)[:256] for part in item[:50]]
        elif item is not None:
            metadata[key] = str(item)[:4000]
    return metadata or None


def list_workflow_history_payload(
    workflow_id: str,
    data_dir: Path | None = None,
    *,
    limit: int | None = None,
) -> dict[str, Any]:
    try:
        revisions = list_workflow_revisions(workflow_id, _data_dir(data_dir), limit=limit)
    except WorkflowRevisionError as exc:
        raise WorkflowHistoryError(str(exc)) from exc
    return {"workflowId": workflow_id, "revisions": [item.to_dict() for item in revisions]}


def workflow_revision_diff_payload(
    workflow_id: str,
    revision_id: str,
    data_dir: Path | None = None,
) -> dict[str, Any]:
    try:
        return diff_workflow_revision(workflow_id, revision_id, _data_dir(data_dir))
    except WorkflowRevisionError as exc:
        raise WorkflowHistoryError(str(exc)) from exc


def restore_workflow_revision_payload(
    workflow_id: str,
    revision_id: str,
    data_dir: Path | None = None,
    *,
    as_copy: bool = False,
) -> dict[str, Any]:
    try:
        result = restore_workflow_revision(
            workflow_id,
            revision_id,
            _data_dir(data_dir),
            as_copy=as_copy,
            source="restore",
            author="ui",
        )
    except WorkflowRevisionError as exc:
        raise WorkflowHistoryError(str(exc)) from exc
    path = Path(str(result["path"]))
    workflow = AgenticWorkflow.from_file(path)
    return {"restore": result, "workflow": workflow_to_payload(workflow, path)}


def validate_workflow_payload(
    workflow_id: str,
    data_dir: Path | None = None,
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    path = _workflow_toml_path(workflow_id, base, error_cls=WorkflowUpdateError)
    if not path.exists():
        raise WorkflowUpdateError(f"Workflow '{workflow_id}' not found")
    return validate_workflow_file(path, data_dir=base).to_dict()


def validate_workflow_draft_payload(
    payload: dict[str, Any],
    data_dir: Path | None = None,
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    workflow_id = str(payload.get("id") or "draft")
    path = _workflow_toml_path(workflow_id, base, error_cls=WorkflowUpdateError)
    try:
        workflow = workflow_from_payload(payload)
    except Exception:
        return validate_workflow_data(
            _workflow_payload_to_validation_data(payload),
            workflow_path=path,
            data_dir=base,
        ).to_dict()
    return validate_workflow(workflow, workflow_path=path, data_dir=base).to_dict()


def apply_workflow_validation_fix_payload(
    workflow_id: str,
    fix: dict[str, Any],
    data_dir: Path | None = None,
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    workflow_path = _workflow_toml_path(workflow_id, base, error_cls=WorkflowUpdateError)
    if not workflow_path.exists():
        raise WorkflowUpdateError(f"Workflow '{workflow_id}' not found")

    action = str(fix.get("action") or "")
    payload = fix.get("payload") or {}
    if action != "create_prompt_file":
        raise WorkflowUpdateError(f"Validation fix '{action}' is not supported by the API")
    prompt_path = Path(str(payload.get("path") or ""))
    if not str(prompt_path):
        raise WorkflowUpdateError("Prompt path is required")
    destination = prompt_path.expanduser()
    if not destination.is_absolute():
        destination = workflow_path.parent / destination
    destination = destination.resolve()
    _assert_within_base(destination, base, error_cls=WorkflowUpdateError)
    if destination.exists():
        return {"applied": False, "path": _api_relative_path(base, destination)}
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text("", encoding="utf-8")
    return {"applied": True, "path": _api_relative_path(base, destination)}


async def run_workflow_payload(
    workflow_id: str,
    data_dir: Path | None = None,
    dry_run: bool = False,
    trigger_context: dict[str, Any] | None = None,
    parameters: dict[str, Any] | None = None,
    resume_options: ResumeOptions | None = None,
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    path = _workflow_toml_path(workflow_id, base, error_cls=WorkflowRunError)
    if not path.exists():
        raise WorkflowRunError(f"Workflow '{workflow_id}' not found")

    try:
        workflow = AgenticWorkflow.from_file(path)
    except Exception as exc:
        raise WorkflowRunError(str(exc)) from exc
    resource_warnings = workflow.resource_warnings(path.parent)
    try:
        run_parameters = resolve_workflow_parameters(workflow.config, parameters)
    except ValueError as exc:
        raise WorkflowRunError(str(exc)) from exc

    if dry_run:
        plan = build_execution_plan(
            workflow,
            workflow_path=path,
            data_dir=base,
            trigger_context=trigger_context,
        )
        plan["parameters"] = masked_workflow_parameters(workflow.config, run_parameters)
        return plan

    try:
        validation = validate_workflow(workflow, workflow_path=path, data_dir=base)
        if not validation.ok:
            messages = "; ".join(item.message for item in validation.errors)
            raise WorkflowRunError(f"Workflow validation failed: {messages}")
        workflow.validate(path, base)
    except Exception as exc:
        raise WorkflowRunError(str(exc)) from exc

    run_key = _run_key(base, workflow_id)
    cancel_event = threading.Event()
    with _active_run_lock:
        if workflow.config.run_continuously and _active_run_stop_events.get(run_key):
            raise WorkflowRunError(
                f"Workflow '{workflow_id}' is configured to run continuously and is already running"
            )
        reserved_paths = set(_active_run_log_paths.get(run_key, {}).values())
        run_log_path = _new_run_log_path(workflow_id, base, reserved_paths)
        _active_run_stop_events.setdefault(run_key, set()).add(cancel_event)
        _active_run_log_paths.setdefault(run_key, {})[cancel_event] = run_log_path

    try:
        executor = WorkflowExecutor(
            workflow,
            _subscriptions,
            dry_run=dry_run,
            log_base_dir=_safe_path(base, "logs", error_cls=WorkflowRunError),
            run_log_path=run_log_path,
            workflow_path=path,
            data_dir=base,
            cancel_event=cancel_event,
            stop_file=_workflow_stop_file(workflow_id, base, error_cls=WorkflowRunError),
        ).with_trigger_context(trigger_context or {})
        executor = executor.with_parameters(run_parameters)
        if resume_options is not None:
            executor = executor.with_resume_options(resume_options)
        result = await executor.run()
    except Exception as exc:
        raise WorkflowRunError(str(exc)) from exc
    finally:
        with _active_run_lock:
            events = _active_run_stop_events.get(run_key)
            if events is not None:
                events.discard(cancel_event)
                if not events:
                    _active_run_stop_events.pop(run_key, None)
            log_paths = _active_run_log_paths.get(run_key)
            if log_paths is not None:
                log_paths.pop(cancel_event, None)
                if not log_paths:
                    _active_run_log_paths.pop(run_key, None)

    node_outputs, node_outputs_truncated = _node_outputs_payload(
        result.node_outputs,
        workflow.config.resource_limits,
    )
    if result.log_path:
        _write_run_node_outputs_payload(
            result.log_path,
            workflow_id=result.workflow_id,
            limits=workflow.config.resource_limits,
            node_outputs=node_outputs,
            node_outputs_truncated=node_outputs_truncated,
            usage_summary=result.usage_summary,
        )
        _write_run_summary_payload(base, workflow_id, result.log_path)
    run_payload = {
        "workflowId": result.workflow_id,
        "success": result.success,
        "durationSeconds": result.duration_seconds,
        "logPath": _api_relative_path(base, result.log_path) if result.log_path else None,
        "status": _log_status(result.log_path) if result.log_path else "unknown",
        **_log_text_payload(result.log_path, workflow.config.resource_limits),
        "resourceWarnings": resource_warnings,
        "usageSummary": result.usage_summary,
        "parameters": result.parameters,
        "nodeOutputs": node_outputs,
        "nodeOutputsTruncated": node_outputs_truncated,
        "nodeOutputsMaxBytes": workflow.config.resource_limits.max_api_log_response_bytes,
    }
    if result.log_path:
        run_payload.update(_read_run_events_payload(result.log_path))
        _apply_retention_policy(base, workflow_id)
    return run_payload


async def resume_workflow_payload(
    workflow_id: str,
    data_dir: Path | None = None,
    *,
    run_id: str,
    from_node: str | None = None,
    only_node: str | None = None,
    skip_cache: bool = False,
    force: bool = False,
    trigger_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if from_node and only_node:
        raise WorkflowRunError("fromNode and onlyNode cannot be used together")
    if not run_id:
        raise WorkflowRunError("runId is required")
    return await run_workflow_payload(
        workflow_id,
        data_dir,
        dry_run=False,
        trigger_context=trigger_context,
        resume_options=ResumeOptions(
            run_id=run_id,
            from_node=from_node,
            only_node=only_node,
            skip_cache=skip_cache,
            force=force,
        ),
    )


async def trigger_workflow_payload(
    workflow_id: str,
    trigger_id: str = "default",
    data_dir: Path | None = None,
    *,
    payload: Any = None,
    headers: dict[str, Any] | None = None,
    source: str | None = None,
    token: str | None = None,
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    path = _workflow_toml_path(workflow_id, base, error_cls=WorkflowTriggerError)
    if not path.exists():
        raise WorkflowTriggerError(f"Workflow '{workflow_id}' not found")
    try:
        workflow = AgenticWorkflow.from_file(path)
    except Exception as exc:
        raise WorkflowTriggerError(str(exc)) from exc
    trigger_config = workflow.config.webhooks.get(trigger_id)
    if trigger_config is None:
        raise WorkflowTriggerError(
            f"Workflow '{workflow_id}' has no webhook trigger '{trigger_id}'"
        )
    if not trigger_config.enabled:
        raise WorkflowTriggerError(f"Webhook trigger '{trigger_id}' is disabled")
    _authorize_webhook_trigger(trigger_config, token)
    if trigger_config.concurrency_policy == "reject_if_running":
        active_run_ids = _active_run_ids(workflow_id, base)
        if active_run_ids:
            raise WorkflowTriggerError(f"Workflow '{workflow_id}' already has an active run")

    trigger_context = _webhook_trigger_context(
        trigger_id=trigger_id,
        payload=payload,
        headers=headers or {},
        source=source or trigger_config.source,
        fanout_path=trigger_config.fanout_path,
        sensitive_payload_fields=set(trigger_config.sensitive_payload_fields),
        store_raw_payload=trigger_config.store_raw_payload,
    )
    run = await run_workflow_payload(
        workflow_id,
        base,
        dry_run=False,
        trigger_context=trigger_context,
    )
    log_path_value = run.get("logPath")
    run_id = Path(str(log_path_value)).name if log_path_value else None
    log_path = (
        _workflow_run_log_path(
            workflow_id,
            run_id,
            base,
            error_cls=WorkflowTriggerError,
        )
        if run_id
        else None
    )
    replay = {
        "workflowId": workflow_id,
        "triggerId": trigger_id,
        "requestId": trigger_context["requestId"],
        "receivedAt": trigger_context["receivedAt"],
        "source": trigger_context["source"],
        "headers": trigger_context["headers"],
        "payload": trigger_context["payload"]
        if trigger_config.store_raw_payload
        else trigger_context["sanitizedPayload"],
        "payloadSanitized": not trigger_config.store_raw_payload,
        "replayNotice": (
            "Webhook payload was sanitized before replay storage; sensitive fields are "
            "masked and replay will use the masked values."
            if not trigger_config.store_raw_payload
            else "Raw webhook payload retention is enabled for exact replay."
        ),
    }
    if log_path is not None:
        _write_run_trigger_payload(log_path, replay)
        _write_run_summary_payload(base, workflow_id, log_path)
    return {
        "workflowId": workflow_id,
        "triggerId": trigger_id,
        "requestId": trigger_context["requestId"],
        "runId": run_id,
        "run": run,
        "replay": replay,
    }


async def replay_workflow_trigger_payload(
    workflow_id: str,
    run_id: str,
    data_dir: Path | None = None,
    *,
    trigger_id: str | None = None,
    token: str | None = None,
    require_token: bool = False,
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    log_path = _workflow_run_log_path(
        workflow_id,
        run_id,
        base,
        error_cls=WorkflowTriggerError,
    )
    replay = _read_run_trigger_payload(log_path)
    if not replay:
        raise WorkflowTriggerError(f"Run '{run_id}' has no saved trigger payload")
    replay_trigger_id = trigger_id or str(replay.get("triggerId") or "default")
    replay_token = token
    path = _workflow_toml_path(workflow_id, base, error_cls=WorkflowTriggerError)
    try:
        workflow = AgenticWorkflow.from_file(path)
        config = workflow.config.webhooks.get(replay_trigger_id)
        if config is not None:
            expected_token = _webhook_expected_token(config)
            if require_token:
                _authorize_webhook_trigger(config, token)
            else:
                replay_token = expected_token
    except Exception:
        if require_token:
            raise
        replay_token = None
    return await trigger_workflow_payload(
        workflow_id,
        replay_trigger_id,
        base,
        payload=replay.get("payload"),
        headers=cast(dict[str, Any], replay.get("headers") or {}),
        source=f"replay:{run_id}",
        token=replay_token,
    )


def workflow_plan_payload(
    workflow_id: str,
    data_dir: Path | None = None,
    trigger_context: dict[str, Any] | None = None,
    parameters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    path = _workflow_toml_path(workflow_id, base, error_cls=WorkflowPlanError)
    if not path.exists():
        raise WorkflowPlanError(f"Workflow '{workflow_id}' not found")
    try:
        workflow = AgenticWorkflow.from_file(path)
        run_parameters = resolve_workflow_parameters(
            workflow.config,
            parameters,
            allow_missing_required=True,
        )
        plan = build_execution_plan(
            workflow,
            workflow_path=path,
            data_dir=base,
            trigger_context=trigger_context,
        )
        plan["parameters"] = masked_workflow_parameters(workflow.config, run_parameters)
        return plan
    except Exception as exc:
        raise WorkflowPlanError(str(exc)) from exc


def stop_workflow_run_payload(
    workflow_id: str,
    data_dir: Path | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    _validate_storage_workflow_id(workflow_id, WorkflowUpdateError)
    if run_id is None:
        _disable_run_continuously(workflow_id, base)
    if run_id:
        log_path = _workflow_run_log_path(
            workflow_id,
            run_id,
            base,
            error_cls=WorkflowUpdateError,
        )
        if not log_path.exists() or _log_status(log_path) != "running":
            return {
                "workflowId": workflow_id,
                "runId": run_id,
                "stopped": False,
                "message": "No active run",
            }
        request_workflow_run_stop(workflow_id, run_id, base)
        return {
            "workflowId": workflow_id,
            "runId": run_id,
            "stopped": True,
            "message": "Stop requested",
        }

    with _active_run_lock:
        cancel_events = tuple(_active_run_stop_events.get(_run_key(base, workflow_id), ()))

    if not cancel_events:
        path = _workflow_toml_path(workflow_id, base, error_cls=WorkflowUpdateError)
        if not path.exists():
            return {"workflowId": workflow_id, "stopped": False, "message": "No active run"}
        request_workflow_stop(workflow_id, base)
        return {
            "workflowId": workflow_id,
            "stopped": True,
            "message": "Stop requested",
        }

    for cancel_event in cancel_events:
        cancel_event.set()
    request_workflow_stop(workflow_id, base)
    return {"workflowId": workflow_id, "stopped": True}


def _disable_run_continuously(workflow_id: str, data_dir: Path) -> None:
    try:
        path = _workflow_toml_path(
            workflow_id,
            data_dir,
            error_cls=WorkflowUpdateError,
        )
    except WorkflowUpdateError:
        return
    if not path.exists():
        return
    try:
        workflow = AgenticWorkflow.from_file(path)
    except Exception:
        return
    if not workflow.config.run_continuously:
        return
    workflow.config.run_continuously = False
    workflow.to_file(path)


def _run_key(data_dir: Path, workflow_id: str) -> tuple[str, str]:
    return (str(data_dir.resolve()), workflow_id)


def _new_run_log_path(
    workflow_id: str,
    base: Path,
    reserved_paths: set[Path] | None = None,
) -> Path:
    safe_id = _validate_storage_workflow_id(workflow_id, WorkflowRunError)
    log_dir = _safe_path(base, "logs", safe_id, error_cls=WorkflowRunError)
    log_dir.mkdir(parents=True, exist_ok=True)
    reserved_paths = reserved_paths or set()
    for _ in range(1000):
        timestamp = datetime.now().astimezone().strftime("%Y-%m-%dT%H-%M-%S%f%z")
        log_path = log_dir / f"{timestamp}.log"
        if log_path not in reserved_paths and not log_path.exists():
            return log_path
    raise WorkflowRunError("Unable to reserve a unique run log path")


def _approval_request_payload(request: ApprovalRequest) -> dict[str, Any]:
    decision = request.decision
    return {
        "workflowId": request.workflow_id,
        "runId": request.run_id,
        "nodeId": request.node_id,
        "message": request.message,
        "status": "decided" if decision is not None else "pending",
        "approvers": request.approvers,
        "requestedAt": request.requested_at,
        "timeoutSeconds": request.timeout_seconds,
        "timeoutDecision": request.timeout_decision,
        "decision": decision.to_dict() if decision is not None else None,
        "logPath": request.log_path,
    }


def list_workflow_approvals_payload(
    workflow_id: str,
    data_dir: Path | None = None,
    *,
    include_decided: bool = True,
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    _validate_storage_workflow_id(workflow_id, WorkflowApprovalError)
    store = ApprovalStore(base)
    all_requests = store.list_requests(workflow_id)
    for request in all_requests:
        if _is_timeout_decision(request):
            _resume_decided_approval(base, store, request)
    requests = (
        all_requests
        if include_decided
        else [request for request in all_requests if request.decision is None]
    )
    return {
        "workflowId": workflow_id,
        "approvals": [_approval_request_payload(request) for request in requests],
    }


def decide_workflow_approval_payload(
    workflow_id: str,
    run_id: str,
    node_id: str,
    decision: str,
    data_dir: Path | None = None,
    *,
    decided_by: str = "ui",
    notes: str = "",
) -> dict[str, Any]:
    if decision not in {"approved", "rejected"}:
        raise WorkflowApprovalError("Decision must be approved or rejected")
    base = _data_dir(data_dir)
    _validate_storage_workflow_id(workflow_id, WorkflowApprovalError)
    store = ApprovalStore(base)
    request = store.get(workflow_id, run_id, node_id)
    if request is None or request.decision is not None:
        raise WorkflowApprovalError("Pending approval not found")
    try:
        decided = store.decide(
            workflow_id,
            run_id,
            node_id,
            decision,  # type: ignore[arg-type]
            decided_by=decided_by,
            notes=notes,
        )
    except ValueError as exc:
        raise WorkflowApprovalError(str(exc)) from exc
    persisted_decision = store.get(workflow_id, run_id, node_id) or decided
    resumed = _resume_decided_approval(base, store, persisted_decision)
    return {
        "workflowId": workflow_id,
        "approval": _approval_request_payload(persisted_decision),
        "resumed": resumed,
    }


def _approval_waiter_is_live(request: ApprovalRequest) -> bool:
    if request.waiter_pid is None:
        return False
    try:
        os.kill(request.waiter_pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _resume_decided_approval(
    base: Path,
    store: ApprovalStore,
    request: ApprovalRequest,
) -> bool:
    if request.decision is None or _approval_waiter_is_live(request):
        return False
    workflow_path = Path(request.workflow_path) if request.workflow_path else None
    if workflow_path is None or not workflow_path.exists():
        workflow_path = base / f"{request.workflow_id}.toml"
    if not workflow_path.exists():
        return False
    try:
        workflow = AgenticWorkflow.from_file(workflow_path)
        result = anyio.run(
            WorkflowExecutor(
                workflow,
                _subscriptions,
                log_base_dir=_safe_path(base, "logs", error_cls=WorkflowApprovalError),
                workflow_path=workflow_path,
                data_dir=base,
                approval_store=store,
            ).resume_from_approval,
            request,
        )
    except Exception:
        return False
    if result is None:
        return False
    node_outputs, node_outputs_truncated = _node_outputs_payload(
        result.node_outputs,
        workflow.config.resource_limits,
    )
    if result.log_path:
        _write_run_node_outputs_payload(
            result.log_path,
            workflow_id=result.workflow_id,
            limits=workflow.config.resource_limits,
            node_outputs=node_outputs,
            node_outputs_truncated=node_outputs_truncated,
            usage_summary=result.usage_summary,
        )
        _write_run_summary_payload(base, result.workflow_id, result.log_path)
        _apply_retention_policy(base, result.workflow_id)
    return True


def _is_timeout_decision(request: ApprovalRequest) -> bool:
    return (
        request.decision is not None
        and request.decision.decided_by == "gofer"
        and request.decision.notes.startswith("Timed out after ")
    )


def _run_node_outputs_path(log_path: Path) -> Path:
    return log_path.with_suffix(RUN_NODE_OUTPUTS_SUFFIX)


def _run_events_path(log_path: Path) -> Path:
    return log_path.with_suffix(RUN_EVENTS_SUFFIX)


def _run_summary_path(log_path: Path) -> Path:
    return log_path.with_suffix(RUN_SUMMARY_SUFFIX)


def _run_trigger_path(log_path: Path) -> Path:
    return log_path.with_suffix(RUN_TRIGGER_SUFFIX)


def _sorted_run_log_paths(log_dir: Path, *, reverse: bool) -> list[Path]:
    paths = [path for path in log_dir.glob("*.log") if path.is_file()]

    def sort_key(path: Path) -> tuple[int, str]:
        try:
            return (path.stat().st_mtime_ns, path.name)
        except OSError:
            return (0, path.name)

    return sorted(paths, key=sort_key, reverse=reverse)


def _write_run_trigger_payload(log_path: Path, payload: dict[str, Any]) -> None:
    try:
        _run_trigger_path(log_path).write_text(
            json.dumps(payload, default=str),
            encoding="utf-8",
        )
    except OSError:
        return


def _read_run_trigger_payload(log_path: Path) -> dict[str, Any]:
    path = _run_trigger_path(log_path)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _write_run_node_outputs_payload(
    log_path: Path,
    *,
    workflow_id: str,
    limits: ResourceLimits,
    node_outputs: dict[str, Any],
    node_outputs_truncated: bool,
    usage_summary: dict[str, object] | None = None,
) -> None:
    payload = {
        "workflowId": workflow_id,
        "runId": log_path.name,
        "nodeOutputs": node_outputs,
        "usageSummary": usage_summary or summarize_node_outputs(node_outputs),
        "nodeOutputsTruncated": node_outputs_truncated,
        "nodeOutputsMaxBytes": limits.max_api_log_response_bytes,
    }
    _run_node_outputs_path(log_path).write_text(
        json.dumps(payload, default=str),
        encoding="utf-8",
    )


def _read_run_node_outputs_payload(log_path: Path) -> dict[str, Any]:
    outputs_path = _run_node_outputs_path(log_path)
    if not outputs_path.exists():
        return {}
    try:
        payload = json.loads(outputs_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    node_outputs = payload.get("nodeOutputs")
    if not isinstance(node_outputs, dict):
        return {}
    return {
        "nodeOutputs": node_outputs,
        "usageSummary": payload.get("usageSummary") or summarize_node_outputs(node_outputs),
        "nodeOutputsTruncated": bool(payload.get("nodeOutputsTruncated", False)),
        "nodeOutputsMaxBytes": payload.get("nodeOutputsMaxBytes"),
    }


def _read_run_events_payload(log_path: Path) -> dict[str, Any]:
    events_path = _run_events_path(log_path)
    if not events_path.exists():
        return {"runEvents": [], "runNodes": {}}
    try:
        payload = json.loads(events_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"runEvents": [], "runNodes": {}}
    if not isinstance(payload, dict):
        return {"runEvents": [], "runNodes": {}}
    events = payload.get("events")
    nodes = payload.get("nodes")
    return {
        "runEvents": events if isinstance(events, list) else [],
        "runNodes": nodes if isinstance(nodes, dict) else {},
    }


def _read_run_events_document(log_path: Path) -> dict[str, Any]:
    events_path = _run_events_path(log_path)
    if not events_path.exists():
        return {}
    try:
        payload = json.loads(events_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _webhook_expected_token(config: WebhookTriggerConfig) -> str | None:
    if config.token:
        return config.token
    if config.token_env:
        value = os.getenv(config.token_env)
        return value if value else None
    return None


def _authorize_webhook_trigger(config: WebhookTriggerConfig, token: str | None) -> None:
    if config.missing_authentication:
        raise WorkflowTriggerError(
            f"Webhook trigger '{config.id}' has no authentication configured"
        )
    if config.allow_unauthenticated and not config.has_authentication:
        return
    expected_token = _webhook_expected_token(config)
    if expected_token is None:
        if config.token_env:
            raise WorkflowTriggerError(
                f"Webhook trigger '{config.id}' token_env '{config.token_env}' is not set"
            )
        raise WorkflowTriggerError(
            f"Webhook trigger '{config.id}' has no authentication configured"
        )
    if not hmac.compare_digest(token or "", expected_token):
        raise WorkflowTriggerError("Unauthorized webhook trigger request")


def _normalize_trigger_headers(headers: dict[str, Any]) -> dict[str, str]:
    normalized: dict[str, str] = {}
    sensitive_headers = {"authorization", "x_gofer_webhook_token"}
    for key, value in headers.items():
        header_key = str(key).strip().lower().replace("-", "_")
        if not header_key or header_key in sensitive_headers:
            continue
        normalized[header_key] = str(value)
    return normalized


def _extract_trigger_path(source: Any, path: str | None) -> Any:
    if not path:
        return None
    parts = [part for part in path.split(".") if part]
    obj = source
    if parts and parts[0] == "payload":
        parts = parts[1:]
    for part in parts:
        if isinstance(obj, list):
            try:
                obj = obj[int(part)]
            except (ValueError, IndexError):
                return None
            continue
        if not isinstance(obj, dict):
            return None
        obj = obj.get(part)
    return obj


def _webhook_events(payload: Any, fanout_path: str | None) -> list[dict[str, object]]:
    value = _extract_trigger_path(payload, fanout_path) if fanout_path else payload
    if not isinstance(value, list):
        return []
    events: list[dict[str, object]] = []
    for index, item in enumerate(value):
        if isinstance(item, dict):
            events.append({str(key): item_value for key, item_value in item.items()})
        else:
            events.append({"value": item, "index": str(index)})
    return events


def _webhook_sensitive_payload_fields(fields: set[str] | None = None) -> set[str]:
    normalized: set[str] = set()
    for field in fields or set():
        value = str(field).strip().lower()
        if not value:
            continue
        normalized.add(value)
        if value.startswith("payload."):
            normalized.add(value.removeprefix("payload."))
        else:
            normalized.add(f"payload.{value}")
    return normalized


def _sanitize_webhook_payload(payload: Any, sensitive_payload_fields: set[str]) -> Any:
    return _mask_http_value(
        payload,
        _webhook_sensitive_payload_fields(sensitive_payload_fields),
    )


def _webhook_trigger_context(
    *,
    trigger_id: str,
    payload: Any,
    headers: dict[str, Any],
    source: str,
    fanout_path: str | None,
    sensitive_payload_fields: set[str] | None = None,
    store_raw_payload: bool = False,
) -> dict[str, Any]:
    request_id = uuid.uuid4().hex
    received_at = datetime.now(UTC).isoformat()
    normalized_headers = _normalize_trigger_headers(headers)
    configured_sensitive_fields = _webhook_sensitive_payload_fields(sensitive_payload_fields)
    sanitized_payload = _sanitize_webhook_payload(payload, configured_sensitive_fields)
    execution_payload = payload if store_raw_payload else sanitized_payload
    events = _webhook_events(execution_payload, fanout_path)
    context: dict[str, Any] = {
        "type": "webhook",
        "mode": "webhook",
        "triggerId": trigger_id,
        "source": source,
        "requestId": request_id,
        "receivedAt": received_at,
        "payload": execution_payload,
        "sanitizedPayload": sanitized_payload,
        "payloadSanitized": not store_raw_payload,
        "sensitivePayloadFields": sorted(configured_sensitive_fields),
        "rawPayloadRetention": store_raw_payload,
        "headers": normalized_headers,
        "events": events,
        "events_json": json.dumps(events, default=str),
    }
    if events:
        context["event"] = events[0]
        context["event_json"] = json.dumps(events[0], default=str)
    return context


def workflow_run_events_payload(
    workflow_id: str,
    run_id: str,
    data_dir: Path | None = None,
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    log_path = _workflow_run_log_path(
        workflow_id,
        run_id,
        base,
        error_cls=WorkflowLogError,
    )
    if log_path.suffix != ".log" or not log_path.exists() or not log_path.is_file():
        raise WorkflowLogError(f"Run log '{run_id}' not found")
    return {
        "workflowId": workflow_id,
        "runId": run_id,
        "logPath": _api_relative_path(base, log_path),
        "status": _log_status(log_path),
        **_read_run_events_payload(log_path),
    }


def _serialized_node_outputs_size(payload: dict[str, Any]) -> int:
    return byte_len(json.dumps(payload, default=str, separators=(",", ":")))


def _fit_node_output_text(
    payload: dict[str, Any],
    *,
    node_id: str,
    value: str,
    label: str,
    limit: int,
    max_bytes: int,
    fan_index: int | None = None,
) -> bool:
    if not value:
        return False
    candidate_limit = min(limit, byte_len(value))
    while candidate_limit > 0:
        text = truncate_text_bytes(value, candidate_limit, label)
        if fan_index is None:
            payload[node_id]["output"] = text
        else:
            payload[node_id]["fanOutputs"][fan_index]["output"] = text
        if _serialized_node_outputs_size(payload) <= max_bytes:
            return byte_len(text) < byte_len(value)
        candidate_limit //= 2
    if fan_index is None:
        payload[node_id]["output"] = ""
    else:
        payload[node_id]["fanOutputs"][fan_index]["output"] = ""
    return True


def _node_outputs_payload(
    node_outputs: dict[str, Any],
    limits: ResourceLimits,
) -> tuple[dict[str, Any], bool]:
    max_bytes = limits.max_api_log_response_bytes
    truncated = False
    payload: dict[str, Any] = {}
    for node_id, output in node_outputs.items():
        output_data = _compact_agent_output_data(output.type, output.data)
        output_text = output.output
        final_agent_message = _final_agent_message(output.type, output_data)
        if output.type == "http_request" and isinstance(output.data, dict):
            output_data = output.data.get("responsePreview", output.data)
            if isinstance(output_data, dict):
                preview_body = output_data.get("body")
                preview_error = output_data.get("error")
                if isinstance(preview_body, str):
                    output_text = preview_body
                elif isinstance(preview_error, str):
                    output_text = preview_error
        payload[node_id] = {
            "success": output.success,
            "output": "",
            "exitCode": output.exit_code,
            "durationSeconds": output.duration_seconds,
            "skipped": output.skipped,
            "fanOutputs": [],
            "data": _node_output_data_payload(
                output_data,
                limits,
                f"{node_id} data",
            ),
        }
        if final_agent_message is not None and isinstance(payload[node_id]["data"], dict):
            payload[node_id]["data"]["message"] = final_agent_message
        if _serialized_node_outputs_size(payload) > max_bytes:
            payload[node_id]["data"] = _uncapped_agent_message_data(final_agent_message)
        if _serialized_node_outputs_size(payload) > max_bytes:
            if final_agent_message is None:
                payload.pop(node_id)
                truncated = True
                break
            truncated = True
        truncated = (
            _fit_node_output_text(
                payload,
                node_id=node_id,
                value=output_text,
                label=f"{node_id} output",
                limit=limits.max_log_bytes_per_node,
                max_bytes=max_bytes,
            )
            or truncated
        )
        for label, fan_output in output.fan_outputs:
            fan_outputs = payload[node_id]["fanOutputs"]
            fan_outputs.append({"label": label, "output": ""})
            fan_index = len(fan_outputs) - 1
            if _serialized_node_outputs_size(payload) > max_bytes:
                fan_outputs.pop()
                truncated = True
                break
            truncated = (
                _fit_node_output_text(
                    payload,
                    node_id=node_id,
                    value=fan_output,
                    label=f"{node_id} fan output",
                    limit=limits.max_log_bytes_per_node,
                    max_bytes=max_bytes,
                    fan_index=fan_index,
                )
                or truncated
            )
    return payload, truncated


def _final_agent_message(output_type: str | None, data: Any) -> str | None:
    if output_type not in {
        str(OperationType.AGENT),
        str(OperationType.COMMON_LLM_TASK),
    }:
        return None
    if not isinstance(data, dict):
        return None
    message = data.get("message")
    return message if isinstance(message, str) else None


def _compact_agent_output_data(output_type: str | None, data: Any) -> Any:
    if output_type not in {
        str(OperationType.AGENT),
        str(OperationType.COMMON_LLM_TASK),
    }:
        return data
    if not isinstance(data, dict):
        return data
    compacted = {
        str(key): value
        for key, value in data.items()
        if str(key).lower() not in {"prompt", "thoughts", "inputs"}
    }
    omitted = [str(key) for key in data if str(key).lower() in {"prompt", "thoughts", "inputs"}]
    if omitted:
        compacted["omittedFromOutputPayload"] = omitted
    return compacted


def _uncapped_agent_message_data(message: str | None) -> dict[str, str]:
    return {"message": message} if message is not None else {}


def _log_text_payload(path: Path | None, limits: ResourceLimits) -> dict[str, Any]:
    if path is None:
        return {
            "logText": "",
            "logTruncated": False,
            "logMaxBytes": limits.max_api_log_response_bytes,
        }
    text, truncated = tail_text_file(path, limits.max_api_log_response_bytes)
    return {
        "logText": text,
        "logTruncated": truncated,
        "logMaxBytes": limits.max_api_log_response_bytes,
    }


def _log_text_range_payload(
    path: Path,
    *,
    offset: int | None = None,
    limit: int | None = None,
    tail_bytes: int | None = None,
    default_limit: int,
) -> dict[str, Any]:
    size = path.stat().st_size
    if tail_bytes is not None:
        max_bytes = max(0, min(tail_bytes, default_limit))
        text, truncated = tail_text_file(path, max_bytes)
        start = max(0, size - max_bytes) if truncated else 0
        end = size
    else:
        max_bytes = max(0, min(limit if limit is not None else default_limit, default_limit))
        text, start, end = read_text_file_range(
            path,
            offset=max(0, offset or 0),
            max_bytes=max_bytes,
        )
        truncated = start > 0 or end < size
    return {
        "logText": text,
        "truncated": truncated,
        "maxBytes": default_limit,
        "logStart": start,
        "logEnd": end,
        "logSize": size,
        "hasMoreBefore": start > 0,
        "hasMoreAfter": end < size,
    }


def _workflow_resource_limits(workflow_id: str, data_dir: Path) -> ResourceLimits:
    try:
        path = _workflow_toml_path(
            workflow_id,
            data_dir,
            error_cls=WorkflowLogError,
        )
    except WorkflowLogError:
        return DEFAULT_RESOURCE_LIMITS
    if not path.exists():
        return DEFAULT_RESOURCE_LIMITS
    try:
        return AgenticWorkflow.from_file(path).config.resource_limits
    except Exception:
        return DEFAULT_RESOURCE_LIMITS


def _node_output_data_payload(value: Any, limits: ResourceLimits, label: str) -> Any:
    if isinstance(value, str):
        return truncate_text_bytes(value, limits.max_log_bytes_per_node, label)
    if isinstance(value, dict):
        return {
            str(key): _node_output_data_payload(item, limits, f"{label}.{key}")
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [
            _node_output_data_payload(item, limits, f"{label}[{index}]")
            for index, item in enumerate(value)
        ]
    return value


def latest_workflow_log_payload(workflow_id: str, data_dir: Path | None = None) -> dict[str, Any]:
    base = _data_dir(data_dir)
    _validate_storage_workflow_id(workflow_id, WorkflowLogError)
    limits = _workflow_resource_limits(workflow_id, base)
    log_dir = _workflow_storage_dir(base, "logs", workflow_id, error_cls=WorkflowLogError)
    if not log_dir.exists():
        return {"workflowId": workflow_id, "logPath": None, "logText": ""}

    latest = _latest_run_path_from_workflow_index(base, workflow_id)
    if latest is None:
        logs = _run_log_paths(base, workflow_id, log_dir, reverse=False)
        if not logs:
            return {"workflowId": workflow_id, "logPath": None, "logText": ""}
        latest = logs[-1]
        _indexed_run_summaries(base, workflow_id, [latest], cheap=True)

    if not latest.exists():
        return {"workflowId": workflow_id, "logPath": None, "logText": ""}
    try:
        text, truncated = tail_text_file(latest, limits.max_api_log_response_bytes)
    except OSError as exc:
        raise WorkflowLogError(str(exc)) from exc

    return {
        "workflowId": workflow_id,
        "logPath": _api_relative_path(base, latest),
        "logText": text,
        "truncated": truncated,
        "maxBytes": limits.max_api_log_response_bytes,
        **_read_run_node_outputs_payload(latest),
        **_read_run_events_payload(latest),
    }


def _latest_run_path_from_workflow_index(base: Path, workflow_id: str) -> Path | None:
    entries = _workflow_index_entries(_read_workflow_index(base))
    key = _workflow_index_key_for_id(entries, workflow_id)
    if key is None:
        return None
    entry = entries.get(key)
    if not isinstance(entry, dict):
        return None
    latest_run = entry.get("latestRun")
    if not isinstance(latest_run, dict):
        return None
    run_id = latest_run.get("id")
    if not isinstance(run_id, str) or not RUN_ID_PATTERN.fullmatch(run_id):
        return None
    log_path = base / "logs" / workflow_id / run_id
    if not _index_stat_matches(latest_run, log_path):
        return None
    return log_path


def _workflow_terminal_event(events: list[Any]) -> dict[str, Any]:
    for event in reversed(events):
        if isinstance(event, dict) and event.get("nodeId") == "workflow":
            return event
    return {}


def _write_run_summary_payload(base: Path, workflow_id: str, log_path: Path) -> None:
    try:
        _run_summary_path(log_path).write_text(
            json.dumps(_log_run_summary(base, workflow_id, log_path), default=str),
            encoding="utf-8",
        )
    except OSError:
        return
    _upsert_run_index(base, workflow_id, log_path)


def write_run_summary_payload(base: Path, workflow_id: str, log_path: Path) -> None:
    """Write the run summary sidecar and update metadata indexes for a completed run."""
    _write_run_summary_payload(base, workflow_id, log_path)


def _read_run_summary_payload(base: Path, log_path: Path) -> dict[str, Any] | None:
    summary_path = _run_summary_path(log_path)
    if not summary_path.exists():
        return None
    try:
        payload = json.loads(summary_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    try:
        stat = log_path.stat()
    except OSError:
        return None
    payload["id"] = log_path.name
    payload["logPath"] = _api_relative_path(base, log_path)
    payload["modifiedAt"] = stat.st_mtime
    payload["logSizeBytes"] = stat.st_size
    return payload


def _read_run_index(base: Path, workflow_id: str) -> dict[str, Any]:
    return _read_index_document(_run_index_path(base, workflow_id))


def _run_index_entries(index: dict[str, Any]) -> dict[str, Any]:
    entries = index.get("runs")
    return cast(dict[str, Any], entries) if isinstance(entries, dict) else {}


def _write_run_index(
    base: Path,
    workflow_id: str,
    entries: dict[str, Any],
    *,
    complete: bool = False,
) -> None:
    log_dir = _workflow_storage_dir(base, "logs", workflow_id, error_cls=WorkflowLogError)
    try:
        payload: dict[str, Any] = {
            "version": INDEX_VERSION,
            "workflowId": workflow_id,
            "updatedAt": datetime.now(UTC).isoformat(),
            "complete": complete,
            "runs": entries,
        }
        if complete and log_dir.exists():
            payload["logDir"] = _file_index_stat(log_dir)
        _write_json_atomic(
            _run_index_path(base, workflow_id),
            payload,
        )
    except OSError:
        return


def _run_index_entry(log_path: Path, summary: dict[str, Any]) -> dict[str, Any]:
    return {**_file_index_stat(log_path), "summary": summary}


def _run_index_summary(entry: Any, log_path: Path) -> dict[str, Any] | None:
    if not isinstance(entry, dict) or not _index_stat_matches(entry, log_path):
        return None
    summary = entry.get("summary")
    return cast(dict[str, Any], summary) if isinstance(summary, dict) else None


def _complete_run_index_log_paths(
    base: Path,
    workflow_id: str,
    log_dir: Path,
    *,
    reverse: bool,
) -> list[Path] | None:
    index = _read_run_index(base, workflow_id)
    if not index.get("complete"):
        return None
    log_dir_entry = index.get("logDir")
    if not isinstance(log_dir_entry, dict) or not _index_stat_matches(log_dir_entry, log_dir):
        return None
    entries = _run_index_entries(index)
    indexed_paths: list[tuple[tuple[int, str], Path]] = []
    for name, entry in entries.items():
        if not isinstance(name, str):
            return None
        if not isinstance(entry, dict):
            return None
        log_path = log_dir / name
        if not RUN_ID_PATTERN.fullmatch(name) or not _index_stat_matches(entry, log_path):
            return None
        mtime_ns = entry.get("mtimeNs")
        if not isinstance(mtime_ns, int):
            return None
        indexed_paths.append(((mtime_ns, name), log_path))
    return [
        log_path
        for _, log_path in sorted(
            indexed_paths,
            key=lambda item: item[0],
            reverse=reverse,
        )
    ]


def _run_log_paths(
    base: Path,
    workflow_id: str,
    log_dir: Path,
    *,
    reverse: bool,
) -> list[Path]:
    indexed = _complete_run_index_log_paths(base, workflow_id, log_dir, reverse=reverse)
    if indexed is not None:
        return indexed
    return _sorted_run_log_paths(log_dir, reverse=reverse)


def _indexed_run_summaries(
    base: Path,
    workflow_id: str,
    log_paths: list[Path],
    *,
    cheap: bool,
    prune_missing: bool = False,
) -> list[dict[str, Any]]:
    index = _read_run_index(base, workflow_id)
    entries = _run_index_entries(index)
    changed = False
    summaries: list[dict[str, Any]] = []
    for log_path in log_paths:
        summary = _run_index_summary(entries.get(log_path.name), log_path)
        if summary is None:
            try:
                summary = _log_run_summary(base, workflow_id, log_path, cheap=cheap)
            except OSError:
                continue
            entries[log_path.name] = _run_index_entry(log_path, summary)
            changed = True
        summaries.append(summary)
    if prune_missing:
        existing_names = {path.name for path in log_paths}
        stale_names = [name for name in entries if name not in existing_names]
        for name in stale_names:
            entries.pop(name, None)
            changed = True
    log_dir = _workflow_storage_dir(base, "logs", workflow_id, error_cls=WorkflowLogError)
    log_dir_entry = index.get("logDir")
    complete_changed = prune_missing and (
        not bool(index.get("complete"))
        or not isinstance(log_dir_entry, dict)
        or not _index_stat_matches(log_dir_entry, log_dir)
    )
    if changed or complete_changed:
        _write_run_index(base, workflow_id, entries, complete=prune_missing)
        _sync_workflow_index_latest_run(
            base,
            workflow_id,
            _latest_run_metadata_from_index_entries(base, workflow_id, entries),
        )
    return summaries


def _upsert_run_index(base: Path, workflow_id: str, log_path: Path) -> None:
    index = _read_run_index(base, workflow_id)
    entries = _run_index_entries(index)
    try:
        summary = _log_run_summary(base, workflow_id, log_path)
    except OSError:
        return
    entries[log_path.name] = _run_index_entry(log_path, summary)
    _write_run_index(base, workflow_id, entries, complete=bool(index.get("complete")))
    _sync_workflow_index_latest_run(
        base,
        workflow_id,
        _latest_run_metadata_from_index_entries(base, workflow_id, entries),
    )


def _remove_run_index_entries(base: Path, workflow_id: str, run_ids: list[str]) -> None:
    index = _read_run_index(base, workflow_id)
    entries = _run_index_entries(index)
    changed = False
    for run_id in run_ids:
        if entries.pop(run_id, None) is not None:
            changed = True
    if changed:
        _write_run_index(base, workflow_id, entries, complete=bool(index.get("complete")))
        _sync_workflow_index_latest_run(
            base,
            workflow_id,
            _latest_run_metadata_from_index_entries(base, workflow_id, entries),
        )


def _log_run_summary(
    base: Path,
    workflow_id: str,
    log_path: Path,
    *,
    cheap: bool = False,
) -> dict[str, Any]:
    stat = log_path.stat()
    stored = _read_run_summary_payload(base, log_path)
    events_doc = {} if cheap and stored else _read_run_events_document(log_path)
    events = events_doc.get("events") if isinstance(events_doc.get("events"), list) else []
    nodes = events_doc.get("nodes") if isinstance(events_doc.get("nodes"), dict) else {}
    terminal = _workflow_terminal_event(events if isinstance(events, list) else [])
    status = str(
        terminal.get("status")
        or (stored or {}).get("status")
        or (_log_status_bounded(log_path) if cheap else _log_status(log_path))
    )
    if status == "completed":
        status = "success"
    elif status == "failed":
        status = "error"
    started_raw = (
        events_doc.get("startedAt") or (stored or {}).get("startedAt") or _log_started_at(log_path)
    )
    started_at = str(started_raw) if started_raw is not None else None
    finished_at = terminal.get("occurredAt") or (stored or {}).get("finishedAt")
    duration = (stored or {}).get("durationSeconds")
    finished = _parse_run_datetime(finished_at)
    started = _parse_run_datetime(started_at)
    if duration is None and started is not None and finished is not None:
        duration = (finished - started).total_seconds()
    trigger_payload = _read_run_trigger_payload(log_path)
    return {
        "id": log_path.name,
        "logPath": _api_relative_path(base, log_path),
        "startedAt": started_at,
        "finishedAt": finished_at,
        "durationSeconds": duration,
        "modifiedAt": stat.st_mtime,
        "status": status,
        "success": (
            terminal.get("success")
            if "success" in terminal
            else (stored or {}).get("success", status == "success")
        ),
        "triggerType": (stored or {}).get("triggerType") or _run_trigger_type(log_path),
        "triggerId": trigger_payload.get("triggerId"),
        "hasTriggerReplay": bool(trigger_payload),
        "nodeCount": len(nodes) if nodes else (stored or {}).get("nodeCount", 0),
        "logSizeBytes": stat.st_size,
    }


def _run_trigger_type(log_path: Path, max_bytes: int = 64 * 1024) -> str:
    try:
        with log_path.open("r", encoding="utf-8", errors="replace") as handle:
            text = handle.read(max_bytes)
        for line in text.splitlines():
            if " - INFO - trigger=" in line:
                value = line.split("trigger=", 1)[1].strip()
                if "run_continuously" in value:
                    return "continuous"
                if "schedule=" in value:
                    return "schedule"
                if "watch=" in value:
                    return "watch"
                if '"type": "webhook"' in value or "'type': 'webhook'" in value:
                    return "webhook"
                if "trigger_context=provided" in value:
                    return "provided"
    except OSError:
        pass
    return "manual"


def list_workflow_run_logs_payload(
    workflow_id: str,
    data_dir: Path | None = None,
    *,
    offset: int = 0,
    limit: int | None = None,
    status: str | None = None,
    trigger_type: str | None = None,
    search: str | None = None,
    started_after: datetime | None = None,
    started_before: datetime | None = None,
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    log_dir = _workflow_storage_dir(
        base,
        "logs",
        workflow_id,
        error_cls=WorkflowLogError,
    )
    if not log_dir.exists():
        return {
            "workflowId": workflow_id,
            "runs": [],
            "pagination": {"offset": max(0, offset), "limit": limit, "total": 0},
        }

    logs = _run_log_paths(base, workflow_id, log_dir, reverse=True)
    needs_prepage_filter = bool(status or trigger_type or started_after or started_before or search)
    if needs_prepage_filter:
        runs = _indexed_run_summaries(base, workflow_id, logs, cheap=True, prune_missing=True)
        if status:
            runs = [run for run in runs if str(run.get("status")) == status]
        if trigger_type:
            runs = [run for run in runs if str(run.get("triggerType")) == trigger_type]
        if started_after or started_before:
            runs = [
                run for run in runs if _run_started_at_in_range(run, started_after, started_before)
            ]
    else:
        runs = [{"id": log_path.name, "path": log_path} for log_path in logs]
    search_scanned_bytes = 0
    search_truncated = False
    if search:
        query = search.lower()
        limits = _workflow_resource_limits(workflow_id, base)
        remaining_bytes = max(0, limits.max_api_log_response_bytes)
        matched_runs = []
        for run in runs:
            if (
                query in str(run.get("id", "")).lower()
                or query in str(run.get("status", "")).lower()
                or query in str(run.get("triggerType", "")).lower()
            ):
                matched_runs.append(run)
                continue
            if remaining_bytes <= 0:
                search_truncated = True
                continue
            matched, scanned, truncated = _log_contains_text_bounded(
                log_dir / str(run.get("id")),
                query,
                remaining_bytes,
            )
            search_scanned_bytes += scanned
            remaining_bytes -= scanned
            search_truncated = search_truncated or truncated
            if matched:
                matched_runs.append(run)
        runs = matched_runs

    total = len(runs)
    page_offset = max(0, offset)
    page_limit = max(0, limit) if limit is not None else None
    if page_limit is not None:
        runs = runs[page_offset : page_offset + page_limit]
    elif page_offset:
        runs = runs[page_offset:]
    if not needs_prepage_filter:
        page_paths = [run["path"] for run in runs if isinstance(run.get("path"), Path)]
        runs = _indexed_run_summaries(base, workflow_id, page_paths, cheap=False)

    pagination: dict[str, Any] = {"offset": page_offset, "limit": page_limit, "total": total}
    if search:
        pagination["searchTruncated"] = search_truncated
        pagination["searchScannedBytes"] = search_scanned_bytes
    return {
        "workflowId": workflow_id,
        "runs": runs,
        "pagination": pagination,
    }


def _run_started_at_in_range(
    run: dict[str, Any],
    started_after: datetime | None,
    started_before: datetime | None,
) -> bool:
    started = _parse_run_datetime(run.get("startedAt"))
    if started is None:
        return False
    normalized_after = _normalize_datetime(started_after)
    normalized_before = _normalize_datetime(started_before)
    if normalized_after and started < normalized_after:
        return False
    return not (normalized_before and started > normalized_before)


def _log_contains_text_bounded(
    log_path: Path,
    query: str,
    max_bytes: int,
) -> tuple[bool, int, bool]:
    try:
        size = log_path.stat().st_size
        read_bytes = min(max(0, max_bytes), size)
        with log_path.open("rb") as handle:
            data = handle.read(read_bytes)
    except OSError:
        return False, 0, False
    text = data.decode("utf-8", errors="replace").lower()
    return query in text, read_bytes, read_bytes < size


def workflow_run_log_payload(
    workflow_id: str,
    run_id: str,
    data_dir: Path | None = None,
    *,
    offset: int | None = None,
    limit: int | None = None,
    tail_bytes: int | None = None,
    include_details: bool = True,
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    limits = _workflow_resource_limits(workflow_id, base)
    log_path = _workflow_run_log_path(
        workflow_id,
        run_id,
        base,
        error_cls=WorkflowLogError,
    )
    if log_path.suffix != ".log" or not log_path.exists() or not log_path.is_file():
        raise WorkflowLogError(f"Run log '{run_id}' not found")

    try:
        log_text = _log_text_range_payload(
            log_path,
            offset=offset,
            limit=limit,
            tail_bytes=tail_bytes,
            default_limit=limits.max_api_log_response_bytes,
        )
    except OSError as exc:
        raise WorkflowLogError(str(exc)) from exc

    payload = {
        "workflowId": workflow_id,
        "runId": run_id,
        "logPath": _api_relative_path(base, log_path),
        "startedAt": _log_started_at(log_path),
        "status": _log_status(log_path) if include_details else _log_status_bounded(log_path),
        **log_text,
    }
    if include_details:
        payload.update(_read_run_node_outputs_payload(log_path))
        payload.update(_read_run_events_payload(log_path))
    return payload


def _active_run_ids(workflow_id: str, base: Path) -> set[str]:
    with _active_run_lock:
        active_paths = tuple(_active_run_log_paths.get(_run_key(base, workflow_id), {}).values())
    return {log_path.name for log_path in active_paths}


def prune_workflow_run_logs_payload(
    workflow_id: str,
    data_dir: Path | None = None,
    *,
    keep_last: int | None = None,
    keep_days: int | None = None,
    keep_failed_days: int | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    if keep_last is None and keep_days is None and keep_failed_days is None:
        saved_settings = retention_settings_payload(base, workflow_id)["settings"]
        keep_last = saved_settings.get("keepLast")
        keep_days = saved_settings.get("keepDays")
        keep_failed_days = saved_settings.get("keepFailedDays")
    log_dir = _workflow_storage_dir(base, "logs", workflow_id, error_cls=WorkflowLogError)
    if not log_dir.exists():
        return {"workflowId": workflow_id, "dryRun": dry_run, "runs": [], "deleted": []}
    logs = _run_log_paths(base, workflow_id, log_dir, reverse=True)
    runs = _indexed_run_summaries(base, workflow_id, logs, cheap=True, prune_missing=True)
    active_run_ids = _active_run_ids(workflow_id, base)
    retained_ids = {str(run["id"]) for run in runs[: max(0, keep_last or 0)]}
    now = datetime.now(UTC)
    candidates: list[dict[str, Any]] = []
    for run in runs:
        run_id = str(run["id"])
        if run_id in retained_ids or run_id in active_run_ids or run.get("status") == "running":
            continue
        started = _parse_run_datetime(run.get("startedAt"))
        status_value = str(run.get("status") or "")
        threshold = (
            keep_failed_days
            if status_value == "error" and keep_failed_days is not None
            else keep_days
        )
        if threshold is None:
            continue
        if started is not None and started >= now - timedelta(days=max(0, threshold)):
            continue
        candidates.append(run)

    deleted: list[str] = []
    if not dry_run:
        for run in candidates:
            run_id = str(run["id"])
            _delete_run_log_files(log_dir / run_id)
            deleted.append(run_id)
        _remove_run_index_entries(base, workflow_id, deleted)
    return {
        "workflowId": workflow_id,
        "dryRun": dry_run,
        "runs": candidates,
        "deleted": deleted,
    }


def _apply_retention_policy(base: Path, workflow_id: str) -> None:
    try:
        prune_workflow_run_logs_payload(workflow_id, base, dry_run=False)
    except WorkflowLogError:
        return
    except OSError:
        return


def _retention_settings_path(base: Path) -> Path:
    return _safe_path(base, "settings", RETENTION_SETTINGS_FILE, error_cls=WorkflowLogError)


def _coerce_retention_settings(value: Any) -> dict[str, int]:
    source = value if isinstance(value, dict) else {}
    settings: dict[str, int] = {}
    for key, default in DEFAULT_RETENTION_SETTINGS.items():
        raw = source.get(key, default)
        settings[key] = max(0, int(raw)) if isinstance(raw, int | float) else default
    return settings


def _read_retention_document(base: Path) -> dict[str, Any]:
    path = _retention_settings_path(base)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _retention_workflow_document(document: dict[str, Any]) -> dict[str, Any]:
    workflows = document.get("workflows")
    return cast(dict[str, Any], workflows) if isinstance(workflows, dict) else {}


def retention_settings_payload(
    data_dir: Path | None = None,
    workflow_id: str | None = None,
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    if workflow_id:
        _validate_storage_workflow_id(workflow_id, WorkflowLogError)
    document = _read_retention_document(base)
    global_settings = _coerce_retention_settings(document.get("global"))
    workflows = _retention_workflow_document(document)
    workflow_settings = (
        _coerce_retention_settings(workflows.get(workflow_id))
        if workflow_id and workflow_id in workflows
        else None
    )
    return {
        "workflowId": workflow_id,
        "global": global_settings,
        "workflow": workflow_settings,
        "settings": workflow_settings or global_settings,
    }


def update_retention_settings_payload(
    data_dir: Path | None = None,
    *,
    workflow_id: str | None = None,
    settings: dict[str, Any],
) -> dict[str, Any]:
    base = _data_dir(data_dir)
    if workflow_id:
        _validate_storage_workflow_id(workflow_id, WorkflowLogError)
    document = _read_retention_document(base)
    workflows = _retention_workflow_document(document)
    if workflow_id:
        workflows[workflow_id] = _coerce_retention_settings(settings)
        document["workflows"] = workflows
    else:
        document["global"] = _coerce_retention_settings(settings)
    document.setdefault("global", DEFAULT_RETENTION_SETTINGS)
    document.setdefault("workflows", workflows)
    path = _retention_settings_path(base)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, indent=2, sort_keys=True), encoding="utf-8")
    return retention_settings_payload(base, workflow_id)


def _parse_run_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return _normalize_datetime(parsed)


def _normalize_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _delete_run_log_files(log_path: Path) -> None:
    for path in (
        log_path,
        _run_events_path(log_path),
        _run_node_outputs_path(log_path),
        _run_summary_path(log_path),
        _run_trigger_path(log_path),
        log_path.with_suffix(".resume.json"),
    ):
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def workflow_from_payload(payload: dict[str, Any]) -> AgenticWorkflow:
    webhooks: dict[str, WebhookTriggerConfig] = {}
    for trigger_id, trigger_data in (payload.get("webhooks") or {}).items():
        if not isinstance(trigger_data, dict):
            continue
        item = dict(trigger_data)
        if item.get("token") == "***":
            item.pop("token", None)
        item.pop("tokenConfigured", None)
        item.pop("risk", None)
        item.pop("riskReasons", None)
        webhooks[str(trigger_id)] = WebhookTriggerConfig(
            id=str(trigger_id),
            **_without(item, "id"),
        )
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id=str(payload["id"]),
            name=str(payload.get("name") or payload["id"]),
            schedule=payload.get("schedule"),
            watch=payload.get("watch"),
            webhooks=webhooks,
            parameters=payload.get("parameters") or {},
            resource_limits=ResourceLimits(**(payload.get("resourceLimits") or {})),
            llm_budget=LlmUsageBudget(**(payload.get("llmBudget") or {})),
            run_continuously=bool(payload.get("runContinuously", False)),
            max_total_node_runs=int(payload.get("maxTotalNodeRuns") or 1000),
            filesystem_access=[
                FilesystemAccessEntry(**item)
                for item in payload.get("filesystemAccess", [])
                if isinstance(item, dict) and item.get("path")
            ],
            metadata=WorkflowMetadata(**(payload.get("metadata") or {})),
        )
    )

    for agent_id, agent_data in (payload.get("agents") or {}).items():
        if not isinstance(agent_data, dict):
            continue
        agent_data = dict(agent_data)
        if not agent_data.get("prompt_path"):
            agent_data.pop("prompt_path", None)
        if not agent_data.get("profile"):
            agent_data.pop("profile", None)
        if not agent_data.get("model"):
            agent_data.pop("model", None)
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
                label=str(node_data.get("label") or "") or None,
                inputs=dict(node_data.get("inputs") or {}),
                operation=_operation_adapter.validate_python(operation_data),
                pipe_output=bool(settings.get("pipeOutput", False)),
                allow_failure=bool(settings.get("allowFailure", False)),
                await_all_inputs=bool(settings.get("awaitAllInputs", True)),
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


def _workflow_payload_to_validation_data(payload: dict[str, Any]) -> dict[str, Any]:
    workflow_data: dict[str, Any] = {
        "id": str(payload.get("id") or "draft"),
        "name": str(payload.get("name") or payload.get("id") or "Draft"),
    }
    if payload.get("schedule") is not None:
        workflow_data["schedule"] = payload.get("schedule")
    if payload.get("watch") is not None:
        workflow_data["watch"] = payload.get("watch")
    if payload.get("parameters"):
        workflow_data["parameters"] = payload.get("parameters")
    if payload.get("runContinuously"):
        workflow_data["run_continuously"] = bool(payload.get("runContinuously"))
    if payload.get("maxTotalNodeRuns") is not None:
        workflow_data["max_total_node_runs"] = payload.get("maxTotalNodeRuns")
    if payload.get("resourceLimits"):
        workflow_data["resource_limits"] = payload.get("resourceLimits")
    if payload.get("llmBudget"):
        workflow_data["llm_budget"] = payload.get("llmBudget")
    if payload.get("filesystemAccess"):
        workflow_data["filesystem_access"] = payload.get("filesystemAccess")
    if payload.get("metadata"):
        workflow_data["metadata"] = payload.get("metadata")

    nodes: list[dict[str, Any]] = []
    for node in payload.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        operation = dict(node.get("operation") or {})
        if "type" not in operation:
            operation["type"] = node.get("type")
        operation["id"] = node.get("id")
        nodes.append(operation)

    edges: list[dict[str, Any]] = []
    for edge in payload.get("edges") or []:
        if not isinstance(edge, dict):
            continue
        edges.append(
            {
                "id": edge.get("id"),
                "from": edge.get("from"),
                "to": edge.get("to"),
                "condition": edge.get("condition") or "always",
                "output_pattern": edge.get("outputPattern"),
            }
        )

    return {
        "workflow": workflow_data,
        "agents": payload.get("agents") or {},
        "nodes": nodes,
        "edges": edges,
    }


def _restore_masked_http_secrets(
    payload: dict[str, Any],
    existing: AgenticWorkflow,
) -> dict[str, Any]:
    existing_operations = {
        node.node_id: node.operation
        for node in existing.graph.nodes_in_order()
        if isinstance(node.operation, HttpRequestOperation)
    }
    if not existing_operations:
        return payload

    restored = dict(payload)
    restored_nodes: list[Any] = []
    for node_data in payload.get("nodes") or []:
        if not isinstance(node_data, dict):
            restored_nodes.append(node_data)
            continue
        existing_operation = existing_operations.get(str(node_data.get("id") or ""))
        operation_data = node_data.get("operation")
        if not isinstance(existing_operation, HttpRequestOperation) or not isinstance(
            operation_data, dict
        ):
            restored_nodes.append(node_data)
            continue

        restored_operation = _restore_masked_http_operation(
            operation_data,
            _model_dump(existing_operation),
        )
        restored_nodes.append({**node_data, "operation": restored_operation})

    restored["nodes"] = restored_nodes
    return restored


def _restore_masked_webhook_secrets(
    payload: dict[str, Any],
    existing: AgenticWorkflow,
) -> dict[str, Any]:
    webhook_payload = payload.get("webhooks")
    if not isinstance(webhook_payload, dict) or not existing.config.webhooks:
        return payload

    restored = dict(payload)
    restored_webhooks: dict[str, Any] = {}
    for trigger_id, item in webhook_payload.items():
        if not isinstance(item, dict):
            restored_webhooks[str(trigger_id)] = item
            continue
        existing_config = existing.config.webhooks.get(str(trigger_id))
        restored_item = dict(item)
        if (
            existing_config is not None
            and restored_item.get("tokenConfigured")
            and not restored_item.get("token")
        ):
            restored_item["token"] = existing_config.token
        restored_webhooks[str(trigger_id)] = restored_item
    restored["webhooks"] = restored_webhooks
    return restored


def _restore_masked_notification_secrets(
    payload: dict[str, Any],
    existing: AgenticWorkflow,
) -> dict[str, Any]:
    existing_operations = {
        node.node_id: node.operation
        for node in existing.graph.nodes_in_order()
        if isinstance(node.operation, NotificationOperation)
    }
    if not existing_operations:
        return payload

    restored = dict(payload)
    restored_nodes: list[Any] = []
    for node_data in payload.get("nodes") or []:
        if not isinstance(node_data, dict):
            restored_nodes.append(node_data)
            continue
        existing_operation = existing_operations.get(str(node_data.get("id") or ""))
        operation_data = node_data.get("operation")
        if not isinstance(existing_operation, NotificationOperation) or not isinstance(
            operation_data,
            dict,
        ):
            restored_nodes.append(node_data)
            continue
        restored_operation = _restore_masked_notification_operation(
            operation_data,
            _model_dump(existing_operation),
        )
        restored_nodes.append({**node_data, "operation": restored_operation})
    restored["nodes"] = restored_nodes
    return restored


def _restore_masked_notification_operation(
    operation: dict[str, Any],
    existing_operation: dict[str, Any],
) -> dict[str, Any]:
    restored = dict(operation)
    restored["webhook_url"] = _restore_masked_http_url(
        restored.get("webhook_url"),
        existing_operation.get("webhook_url"),
        set(),
    )
    for key in ("headers", "payload", "email_to"):
        value = restored.get(key)
        existing_value = existing_operation.get(key)
        if isinstance(value, (dict, list)) and isinstance(existing_value, (dict, list)):
            restored[key] = _restore_masked_http_value(value, existing_value, set())
    for key in ("email_from", "smtp_host", "smtp_username", "smtp_password"):
        if restored.get(key) == "***":
            restored[key] = existing_operation.get(key, restored[key])
    return restored


def _restore_masked_http_operation(
    operation: dict[str, Any],
    existing_operation: dict[str, Any],
) -> dict[str, Any]:
    configured = {str(field).lower() for field in operation.get("secret_fields") or []}
    restored = dict(operation)
    restored["url"] = _restore_masked_http_url(
        restored.get("url"),
        existing_operation.get("url"),
        configured,
    )
    for key in ("headers", "params", "json"):
        value = restored.get(key)
        existing_value = existing_operation.get(key)
        if isinstance(value, dict) and isinstance(existing_value, dict):
            restored[key] = _restore_masked_http_value(value, existing_value, configured)
    if isinstance(restored.get("body"), str) and "***" in restored["body"]:
        restored["body"] = existing_operation.get("body", restored["body"])
    return restored


def _restore_masked_http_url(
    value: object,
    existing: object,
    configured: set[str],
) -> object:
    if not isinstance(value, str) or not isinstance(existing, str):
        return value
    if value == "***":
        return existing
    if "***" not in value and "%2A%2A%2A" not in value.upper():
        return value

    try:
        parsed = urllib.parse.urlsplit(value)
        existing_parsed = urllib.parse.urlsplit(existing)
    except ValueError:
        return existing

    if (
        "***" in urllib.parse.unquote(parsed.scheme)
        or "***" in urllib.parse.unquote(parsed.netloc)
        or "***" in urllib.parse.unquote(parsed.path)
        or "***" in urllib.parse.unquote(parsed.fragment)
    ):
        return existing

    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    existing_pairs = urllib.parse.parse_qsl(
        existing_parsed.query,
        keep_blank_values=True,
    )
    existing_by_key: dict[str, list[str]] = {}
    for key, item in existing_pairs:
        existing_by_key.setdefault(key, []).append(item)

    restored_pairs: list[tuple[str, str]] = []
    for key, item in query_pairs:
        if item == "***":
            values = existing_by_key.get(key)
            if values:
                restored_pairs.append((key, values.pop(0)))
                continue
            if _is_sensitive_field(key, configured):
                return existing
        restored_pairs.append((key, item))

    return urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(restored_pairs)))


def _restore_masked_http_value(
    value: object,
    existing: object,
    configured: set[str],
    path: str = "",
) -> object:
    if isinstance(value, dict) and isinstance(existing, dict):
        restored: dict[str, object] = {}
        for key, item in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            restored[str(key)] = _restore_masked_http_value(
                item,
                existing.get(key),
                configured,
                child_path,
            )
        return restored
    if isinstance(value, list) and isinstance(existing, list):
        return [
            _restore_masked_http_value(
                item,
                existing[index] if index < len(existing) else None,
                configured,
                path,
            )
            for index, item in enumerate(value)
        ]
    if value == "***" and path and _is_sensitive_field(path, configured):
        return existing
    return value


def workflow_to_payload(workflow: AgenticWorkflow, path: Path | None = None) -> dict[str, Any]:
    generations = workflow.graph.topological_generations()
    node_positions: dict[str, tuple[int, int]] = {}
    for generation_index, generation in enumerate(generations):
        column_x = 96 + generation_index * 300
        total_height = max(0, (len(generation) - 1) * 170)
        start_y = 260 - total_height // 2
        for row_index, node in enumerate(generation):
            node_positions[node.node_id] = (column_x, max(48, start_y + row_index * 170))
    node_positions.update(_read_ui_node_positions(path))

    nodes: list[dict[str, Any]] = []
    for generation in generations:
        for node in generation:
            x, y = node_positions[node.node_id]
            operation = _ui_operation_payload(node.operation)
            nodes.append(
                {
                    "id": node.node_id,
                    "label": node.label or _node_label(node.node_id),
                    "type": str(node.operation.type),
                    "meta": _operation_meta(operation),
                    "operation": operation,
                    "inputs": node.inputs,
                    "settings": {
                        "pipeOutput": node.pipe_output,
                        "allowFailure": node.allow_failure,
                        "awaitAllInputs": node.await_all_inputs,
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

    schedule = _trigger_config_payload(workflow.config.schedule)
    watch = _trigger_config_payload(workflow.config.watch)
    status = _latest_run_status(workflow.config.id, path)
    tags = [status.lower()]
    operation_types = sorted({str(node["type"]) for node in nodes})
    tags.extend(operation_types[:2])
    health_diagnostics = workflow_health_diagnostics(path) if path is not None else []
    validation_report = (
        validate_workflow(workflow, workflow_path=path, data_dir=path.parent)
        if path is not None
        else validate_workflow(workflow)
    )
    validation_diagnostics = [item.to_dict() for item in validation_report.diagnostics]
    secret_readiness = [
        item.to_dict()
        for item in workflow_secret_readiness(
            workflow,
            workflow_path=path,
            data_dir=path.parent if path is not None else None,
        )
    ]

    return {
        "id": workflow.config.id,
        "name": workflow.config.name,
        "description": _workflow_description(workflow, schedule, watch),
        "status": status,
        "updatedAt": _updated_at(path),
        "sourcePath": path.name if path else None,
        "schedule": schedule,
        "watch": watch,
        "parameters": {
            name: spec.model_dump(mode="json", exclude_none=True)
            for name, spec in workflow.config.parameters.items()
        },
        "webhooks": _webhook_config_payload(workflow.config.webhooks),
        "resourceLimits": _model_dump(workflow.config.resource_limits),
        "llmBudget": _model_dump(workflow.config.llm_budget),
        "resourceWarnings": workflow.resource_warnings(),
        "healthWarnings": [
            item.to_dict() for item in health_diagnostics if item.severity == "warning"
        ],
        "healthErrors": [item.to_dict() for item in health_diagnostics if item.severity == "error"],
        "validationDiagnostics": validation_diagnostics,
        "secretReadiness": secret_readiness,
        "validationWarnings": [
            item for item in validation_diagnostics if item.get("severity") == "warning"
        ],
        "validationErrors": [
            item for item in validation_diagnostics if item.get("severity") == "error"
        ],
        "runContinuously": workflow.config.run_continuously,
        "maxTotalNodeRuns": workflow.config.max_total_node_runs,
        "filesystemAccess": [
            entry.model_dump(mode="json", exclude_none=True)
            for entry in workflow.config.filesystem_access
        ],
        "metadata": _model_dump(workflow.config.metadata),
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
    return model.model_dump(mode="json", exclude_none=True, by_alias=True)


def _trigger_config_payload(model: BaseModel | None) -> dict[str, Any] | None:
    payload = _model_dump(model)
    if payload is not None and payload.get("params") == {}:
        payload.pop("params", None)
    return payload


def _webhook_config_payload(webhooks: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for trigger_id, config in webhooks.items():
        item = config.model_dump(mode="json", exclude_none=True)
        item["tokenConfigured"] = bool(item.pop("token", None) or item.get("token_env"))
        item["riskReasons"] = _webhook_payload_risk_reasons(config)
        item["risk"] = "high" if item["riskReasons"] else "normal"
        payload[trigger_id] = item
    return payload


def _webhook_payload_risk_reasons(config: WebhookTriggerConfig) -> list[str]:
    reasons: list[str] = []
    if config.missing_authentication:
        reasons.append("missing_authentication")
    if config.requires_unauthenticated_warning:
        reasons.append("unauthenticated_allowed")
    if config.store_raw_payload:
        reasons.append("raw_payload_retention")
    return reasons


def _ui_operation_payload(operation: Operation) -> dict[str, Any]:
    data = _model_dump(operation)
    if isinstance(operation, HttpRequestOperation):
        return _masked_http_operation_payload(operation, data)
    if isinstance(operation, NotificationOperation):
        return _masked_notification_operation_payload(operation, data)
    return data


def _masked_notification_operation_payload(
    operation: NotificationOperation,
    data: dict[str, Any],
) -> dict[str, Any]:
    secret_values = set()
    secret_values.update(_collect_configured_secret_values(operation.headers, set()))
    secret_values.update(_collect_configured_secret_values(operation.payload, set()))
    secret_values.update(
        _collect_configured_secret_values(
            {
                "smtp_username": operation.smtp_username,
                "smtp_password": operation.smtp_password,
            },
            set(),
        )
    )
    secret_values = {value for value in secret_values if value}

    masked = dict(data)
    webhook_url = masked.get("webhook_url")
    if isinstance(webhook_url, str):
        masked["webhook_url"] = (
            webhook_url
            if "{{secret." in webhook_url or webhook_url.strip().startswith("secret:")
            else "***"
        )
    for key in ("headers", "payload", "email_to"):
        value = masked.get(key)
        if isinstance(value, (dict, list)):
            masked[key] = _preserve_secret_reference_placeholders(
                _mask_http_value(value, set(), secret_values=secret_values),
                value,
            )
    for key in ("email_from", "smtp_host", "smtp_username", "smtp_password"):
        value = masked.get(key)
        if isinstance(value, str):
            if "{{secret." in value or value.strip().startswith("secret:"):
                masked[key] = value
            elif key in {"smtp_username", "smtp_password"} or _is_sensitive_field(key, set()):
                masked[key] = "***"
            else:
                masked[key] = _mask_http_text(value, set(), secret_values=secret_values)
    return masked


def _masked_http_operation_payload(
    operation: HttpRequestOperation,
    data: dict[str, Any],
) -> dict[str, Any]:
    configured = {field.lower() for field in operation.secret_fields}
    secret_values = set()
    secret_values.update(_collect_configured_secret_values(operation.headers, configured))
    secret_values.update(_collect_configured_secret_values(operation.params, configured))
    secret_values.update(_collect_configured_secret_values(operation.json_payload, configured))
    if operation.body:
        secret_values.update(_collect_configured_secret_text_values(operation.body, configured))
    secret_values = {value for value in secret_values if value}

    masked = dict(data)
    masked["url"] = _mask_http_url(
        str(masked.get("url", "")),
        configured=configured,
        secret_values=secret_values,
        url_sensitive="url" in configured,
        sensitive_query_keys=configured,
    )
    for key in ("headers", "params"):
        value = masked.get(key)
        if isinstance(value, dict):
            masked[key] = _preserve_secret_reference_placeholders(
                _mask_http_value(
                    value,
                    configured,
                    secret_values=secret_values,
                ),
                value,
            )
    if "json" in masked:
        masked["json"] = _preserve_secret_reference_placeholders(
            _mask_http_value(
                masked["json"],
                configured,
                secret_values=secret_values,
            ),
            data.get("json"),
        )
    body = masked.get("body")
    if isinstance(body, str):
        masked["body"] = _mask_http_text(
            body,
            configured,
            secret_values=secret_values,
        )
    return masked


def _preserve_secret_reference_placeholders(value: object, original: object) -> object:
    if isinstance(original, str) and (
        "{{secret." in original or original.strip().startswith("secret:")
    ):
        return original
    if isinstance(value, dict) and isinstance(original, dict):
        return {
            str(key): _preserve_secret_reference_placeholders(
                item,
                original.get(key),
            )
            for key, item in value.items()
        }
    if isinstance(value, list) and isinstance(original, list):
        return [
            _preserve_secret_reference_placeholders(
                item,
                original[index] if index < len(original) else None,
            )
            for index, item in enumerate(value)
        ]
    return value


def _without(data: dict[str, Any], key: str) -> dict[str, Any]:
    return {k: v for k, v in data.items() if k != key}


def _optional_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    return float(value)


def _ui_node_positions_from_payload(payload: dict[str, Any]) -> dict[str, dict[str, int]]:
    positions: dict[str, dict[str, int]] = {}
    for node_data in payload.get("nodes") or []:
        if not isinstance(node_data, dict):
            continue
        node_id = str(node_data.get("id") or "")
        if not node_id:
            continue
        x = _optional_int(node_data.get("x"))
        y = _optional_int(node_data.get("y"))
        if x is None or y is None:
            continue
        positions[node_id] = {"x": x, "y": y}
    return positions


def _read_ui_node_positions(path: Path | None) -> dict[str, tuple[int, int]]:
    if path is None or not path.exists():
        return {}
    try:
        with path.open("rb") as fh:
            data = tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError):
        return {}

    ui = data.get("ui") or {}
    if not isinstance(ui, dict):
        return {}
    raw_positions = ui.get("node_positions") or {}
    if not isinstance(raw_positions, dict):
        return {}

    positions: dict[str, tuple[int, int]] = {}
    for node_id, raw_position in raw_positions.items():
        if not isinstance(raw_position, dict):
            continue
        x = _optional_int(raw_position.get("x"))
        y = _optional_int(raw_position.get("y"))
        if x is None or y is None:
            continue
        positions[str(node_id)] = (x, y)
    return positions


def _write_ui_node_positions(path: Path, positions: dict[str, dict[str, int]]) -> None:
    with path.open("rb") as fh:
        data = tomllib.load(fh)
    if positions:
        ui = data.get("ui")
        if not isinstance(ui, dict):
            ui = {}
            data["ui"] = ui
        ui["node_positions"] = positions
    else:
        ui = data.get("ui")
        if isinstance(ui, dict):
            ui.pop("node_positions", None)
            if not ui:
                data.pop("ui", None)
    path.write_bytes(tomli_w.dumps(data).encode())


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool) or value in (None, ""):
        return None
    try:
        return int(round(float(value)))
    except (TypeError, ValueError, OverflowError):
        return None


def _clean_operation_data(data: dict[str, Any]) -> dict[str, Any]:
    op_type = data.get("type")
    if op_type == OperationType.BASH_COMMAND:
        if not data.get("working_dir"):
            data.pop("working_dir", None)
    if op_type in {OperationType.PYTHON_SCRIPT, OperationType.SHELL_SCRIPT}:
        data["args"] = data.get("args") or []
    if op_type == OperationType.AGENT and not data.get("fan_source"):
        data["fan_source"] = None
    if op_type == OperationType.AGENT:
        if not data.get("prompt_path"):
            data.pop("prompt_path", None)
        if not data.get("skill_name"):
            data.pop("skill_name", None)
    if op_type in {OperationType.AGENT, OperationType.COMMON_LLM_TASK}:
        if not data.get("profile"):
            data.pop("profile", None)
        if not data.get("model"):
            data.pop("model", None)
        if data.get("timeout") in ("", None):
            data.pop("timeout", None)
    if op_type == OperationType.PROMPT_FILE and not data.get("template_path"):
        data.pop("template_path", None)
    return data


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9-]", "-", value.lower())
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug or "workflow"


def _data_dir(data_dir: Path | None) -> Path:
    return (data_dir or get_data_dir()).resolve()


def _assert_within_base(
    path: Path,
    base: Path,
    *,
    error_cls: type[ValueError],
) -> Path:
    resolved_base = base.resolve()
    resolved_path = path.resolve()
    if resolved_path != resolved_base and not resolved_path.is_relative_to(resolved_base):
        raise error_cls("Invalid path")
    return resolved_path


def _safe_path(base: Path, *parts: str, error_cls: type[ValueError]) -> Path:
    return _assert_within_base(base.joinpath(*parts), base, error_cls=error_cls)


def _api_relative_path(base: Path, path: Path) -> str:
    resolved = _assert_within_base(path, base, error_cls=WorkflowLogError)
    return resolved.relative_to(base.resolve()).as_posix()


def _validate_storage_workflow_id(
    workflow_id: str,
    error_cls: type[ValueError],
) -> str:
    try:
        return validate_workflow_id(workflow_id)
    except ValueError as exc:
        raise error_cls("Invalid workflow id") from exc


def _workflow_toml_path(
    workflow_id: str,
    base: Path,
    *,
    error_cls: type[ValueError],
) -> Path:
    safe_id = _validate_storage_workflow_id(workflow_id, error_cls)
    return _safe_path(base, f"{safe_id}.toml", error_cls=error_cls)


def _workflow_storage_dir(
    base: Path,
    directory: str,
    workflow_id: str,
    *,
    error_cls: type[ValueError],
) -> Path:
    safe_id = _validate_storage_workflow_id(workflow_id, error_cls)
    return _safe_path(base, directory, safe_id, error_cls=error_cls)


def _validate_run_id(run_id: str, error_cls: type[ValueError]) -> str:
    if not RUN_ID_PATTERN.fullmatch(run_id):
        raise error_cls("Invalid run log id")
    return run_id


def _workflow_run_log_path(
    workflow_id: str,
    run_id: str,
    base: Path,
    *,
    error_cls: type[ValueError],
) -> Path:
    safe_id = _validate_storage_workflow_id(workflow_id, error_cls)
    safe_run_id = _validate_run_id(run_id, error_cls)
    return _safe_path(base, "logs", safe_id, safe_run_id, error_cls=error_cls)


def _workflow_stop_file(
    workflow_id: str,
    base: Path,
    *,
    error_cls: type[ValueError],
) -> Path:
    safe_id = _validate_storage_workflow_id(workflow_id, error_cls)
    return _safe_path(base, "run-state", f"{safe_id}.stop", error_cls=error_cls)


def _validate_chat_prompt_id(prompt_id: str) -> None:
    if prompt_id == "workflow-assistant":
        return
    if prompt_id.startswith("workflow-assistant:"):
        thread_id = prompt_id.split(":", 1)[1]
        if CHAT_THREAD_ID_PATTERN.fullmatch(thread_id):
            return
        raise WorkflowUpdateError("Invalid chat thread id")
    _validate_storage_workflow_id(prompt_id, WorkflowUpdateError)


def _node_label(node_id: str) -> str:
    return node_id.replace("_", " ").replace("-", " ").title()


def _operation_meta(operation: dict[str, Any]) -> str:
    match operation.get("type"):
        case OperationType.BASH_COMMAND:
            return str(operation.get("command", "command"))
        case OperationType.PYTHON_SCRIPT | OperationType.SHELL_SCRIPT:
            return str(operation.get("script_path", "script"))
        case OperationType.READ_FILE:
            return f"read {operation.get('path', 'file')}"
        case OperationType.WRITE_FILE:
            return f"write {operation.get('path', 'file')}"
        case OperationType.COPY_FILE:
            return (
                f"copy {operation.get('source_path', 'source')} "
                f"to {operation.get('destination_path', 'destination')}"
            )
        case OperationType.MOVE_FILE:
            return (
                f"move {operation.get('source_path', 'source')} "
                f"to {operation.get('destination_path', 'destination')}"
            )
        case OperationType.DELETE_FILE:
            return f"delete {operation.get('path', 'file')}"
        case OperationType.FILE:
            return str(operation.get("path", "file"))
        case OperationType.FOLDER:
            return str(operation.get("path", "folder"))
        case OperationType.OPEN_RESOURCE:
            return f"open {operation.get('target', 'target')}"
        case OperationType.PROMPT_FILE:
            return f"prompt {operation.get('output_path', 'file')}"
        case OperationType.COMMON_LLM_TASK:
            return f"{operation.get('task', 'summarize')} with {operation.get('agent_id', 'agent')}"
        case OperationType.LOCAL_VECTORIZE:
            return f"index {operation.get('source_path', 'files')}"
        case OperationType.LOCAL_SEARCH:
            return f"search {operation.get('index_path', 'index')}"
        case OperationType.HTTP_REQUEST:
            return f"{operation.get('method', 'GET')} {operation.get('url', 'url')}"
        case OperationType.APPROVAL_GATE:
            timeout = operation.get("timeout_seconds")
            return f"approval timeout {timeout}s" if timeout else "approval required"
        case OperationType.NOTIFICATION:
            channel = operation.get("channel", "desktop")
            title = operation.get("title", "notification")
            return f"{channel} · {title}"
        case OperationType.AGENT:
            agent_id = operation.get("agent_id", "agent")
            prompt_path = operation.get("prompt_path")
            skill_name = operation.get("skill_name")
            if skill_name:
                return f"{agent_id} · /{skill_name}"
            return f"{agent_id} · {prompt_path}" if prompt_path else str(agent_id)
        case OperationType.LOOP:
            source = operation.get("source") or {}
            return f"loop {source.get('type', 'items')}"
        case OperationType.BREAK:
            return operation.get("message") or "break loop"
    return str(operation.get("type", "operation"))


def _edge_label(condition: str, output_pattern: str | None) -> str:
    if condition == "always":
        return "always"
    if condition == "output_matches" and output_pattern:
        return f"matches {output_pattern}"
    return condition.replace("_", " ")


def _workflow_description(
    workflow: AgenticWorkflow,
    schedule: dict[str, Any] | None,
    watch: dict[str, Any] | None,
) -> str:
    node_count = len(list(workflow.graph._graph.nodes()))
    edge_count = len(list(workflow.graph._graph.edges()))
    agent_count = len(workflow.agents)
    continuous_text = " Runs continuously." if workflow.config.run_continuously else ""
    schedule_text = (
        f" Scheduled with {schedule['cron_expression']}."
        if schedule and not workflow.config.run_continuously
        else ""
    )
    watch_text = (
        f" Watching {watch['path']}." if watch and not workflow.config.run_continuously else ""
    )
    return (
        f"{node_count} nodes, {edge_count} edges, {agent_count} agents."
        f"{continuous_text}{schedule_text}{watch_text}"
    )


def _workflow_status(schedule: dict[str, Any] | None) -> str:
    return "Scheduled" if schedule else "Ready"


def _latest_run_status(workflow_id: str, path: Path | None) -> str:
    if path is None:
        return "Ready"

    base = path.parent
    log_dir = base / "logs" / workflow_id
    if not log_dir.exists():
        return "Ready"

    latest = _latest_run_path_from_workflow_index(base, workflow_id)
    if latest is None:
        logs = _run_log_paths(base, workflow_id, log_dir, reverse=False)
        if not logs:
            return "Ready"
        latest = logs[-1]

    summary = _run_index_summary(
        _run_index_entries(_read_run_index(base, workflow_id)).get(latest.name),
        latest,
    )
    if summary is None:
        summaries = _indexed_run_summaries(base, workflow_id, [latest], cheap=True)
        summary = summaries[0] if summaries else {}
    status = str(summary.get("status") or "unknown")
    if status == "success":
        return "Success"
    if status == "error":
        return "Error"
    if status == "stopped":
        return "Stopped"
    return "Running"


def _log_started_at(path: Path) -> str | None:
    try:
        with path.open("rb") as fh:
            first_line = fh.readline(DEFAULT_RESOURCE_LIMITS.max_api_log_response_bytes).decode(
                "utf-8",
                errors="replace",
            )
    except (IndexError, OSError):
        return None
    return first_line.split(" - ", 1)[0] or None


def _log_status(path: Path) -> str:
    events = _read_run_events_payload(path).get("runEvents", [])
    if isinstance(events, list):
        for event in reversed(events):
            if not isinstance(event, dict):
                continue
            if event.get("status") == "stopped":
                return "stopped"
    try:
        text, _ = tail_text_file(path, DEFAULT_RESOURCE_LIMITS.max_api_log_response_bytes)
        lines = text.splitlines()
    except OSError:
        return "unknown"
    if not lines:
        return "unknown"
    for line in reversed(lines):
        normalized = line.lower()
        if "completed successfully" in normalized:
            return "success"
        if "stopped by user" in normalized or "process stopped by user" in normalized:
            return "stopped"
        if "failed due to" in normalized:
            return "error"
    return "running"


def _log_status_bounded(path: Path, max_bytes: int = 64 * 1024) -> str:
    events = _read_run_events_payload(path).get("runEvents", [])
    if isinstance(events, list):
        for event in reversed(events):
            if not isinstance(event, dict):
                continue
            status = event.get("status")
            if status == "stopped":
                return "stopped"
            if status == "completed":
                return "success"
            if status == "failed":
                return "error"
    try:
        text, _ = tail_text_file(path, max_bytes)
        lines = text.splitlines()
    except OSError:
        return "unknown"
    for line in reversed(lines):
        normalized = line.lower()
        if "completed successfully" in normalized:
            return "success"
        if "stopped by user" in normalized or "process stopped by user" in normalized:
            return "stopped"
        if "failed due to" in normalized:
            return "error"
    return "running" if lines else "unknown"


def _updated_at(path: Path | None) -> str:
    if path is None or not path.exists():
        return "Unknown"
    return datetime.fromtimestamp(path.stat().st_mtime).strftime("%b %d, %Y %H:%M")
