from __future__ import annotations

import difflib
import json
import re
import tomllib
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import tomli_w

from gofer.core.bundles import _sanitized_workflow_data
from gofer.core.workflow import AgenticWorkflow, validate_workflow_id

REVISION_SCHEMA_VERSION = 1
DEFAULT_MAX_REVISIONS = 50
DEFAULT_MAX_AGE_DAYS = 90
AUTOSAVE_COALESCE_SECONDS = 60


class WorkflowRevisionError(ValueError):
    pass


@dataclass(frozen=True)
class RevisionRetention:
    max_revisions: int = DEFAULT_MAX_REVISIONS
    max_age_days: int = DEFAULT_MAX_AGE_DAYS


@dataclass(frozen=True)
class WorkflowRevision:
    workflow_id: str
    revision_id: str
    created_at: str
    source: str
    author: str
    summary: list[str]
    path: Path
    toml: str

    def to_dict(self, *, include_toml: bool = False) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "workflowId": self.workflow_id,
            "revisionId": self.revision_id,
            "createdAt": self.created_at,
            "source": self.source,
            "author": self.author,
            "summary": self.summary,
        }
        if include_toml:
            payload["toml"] = self.toml
        return payload


def revision_storage_dir(data_dir: Path, workflow_id: str) -> Path:
    return data_dir / "workflow-revisions" / validate_workflow_id(workflow_id)


def capture_workflow_revision(
    workflow_path: Path,
    data_dir: Path,
    *,
    source: str,
    author: str = "gofer",
    retention: RevisionRetention | None = None,
    coalesce_seconds: int = AUTOSAVE_COALESCE_SECONDS,
) -> WorkflowRevision | None:
    if not workflow_path.exists():
        raise WorkflowRevisionError(f"Workflow file '{workflow_path}' not found")

    workflow = AgenticWorkflow.from_file(workflow_path)
    workflow_id = workflow.config.id
    toml_text = _sanitized_toml_text(workflow_path)
    latest = _latest_revision(workflow_id, data_dir)
    if latest and latest.toml == toml_text:
        return None

    now = datetime.now(UTC)
    directory = revision_storage_dir(data_dir, workflow_id)
    directory.mkdir(parents=True, exist_ok=True)

    if (
        latest
        and source == "autosave"
        and latest.source == "autosave"
        and _parse_datetime(latest.created_at) >= now - timedelta(seconds=coalesce_seconds)
    ):
        revision_id = latest.revision_id
        path = latest.path
    else:
        revision_id = f"{now.strftime('%Y%m%dT%H%M%S%fZ')}-{uuid.uuid4().hex[:8]}"
        path = directory / f"{revision_id}.json"

    previous_toml = latest.toml if latest else ""
    document = {
        "schemaVersion": REVISION_SCHEMA_VERSION,
        "workflowId": workflow_id,
        "revisionId": revision_id,
        "createdAt": now.isoformat(),
        "source": source,
        "author": author,
        "summary": summarize_workflow_diff(previous_toml, toml_text),
        "toml": toml_text,
    }
    path.write_text(json.dumps(document, indent=2, sort_keys=True), encoding="utf-8")
    revision = _load_revision(path)
    prune_workflow_revisions(workflow_id, data_dir, retention or RevisionRetention())
    return revision


def list_workflow_revisions(
    workflow_id: str,
    data_dir: Path,
    *,
    limit: int | None = None,
) -> list[WorkflowRevision]:
    directory = revision_storage_dir(data_dir, workflow_id)
    if not directory.exists():
        return []
    revisions = [_load_revision(path) for path in sorted(directory.glob("*.json"))]
    revisions.sort(key=lambda item: item.created_at, reverse=True)
    return revisions[:limit] if limit is not None else revisions


def diff_workflow_revision(
    workflow_id: str,
    revision_id: str,
    data_dir: Path,
) -> dict[str, Any]:
    revision = get_workflow_revision(workflow_id, revision_id, data_dir)
    current_path = data_dir / f"{validate_workflow_id(workflow_id)}.toml"
    current_toml = _sanitized_toml_text(current_path) if current_path.exists() else ""
    diff_lines = list(
        difflib.unified_diff(
            revision.toml.splitlines(),
            current_toml.splitlines(),
            fromfile=f"{workflow_id}@{revision.revision_id}",
            tofile=f"{workflow_id}@current",
            lineterm="",
        )
    )
    return {
        "workflowId": workflow_id,
        "revisionId": revision_id,
        "summary": summarize_workflow_diff(revision.toml, current_toml),
        "tomlDiff": "\n".join(diff_lines),
    }


def restore_workflow_revision(
    workflow_id: str,
    revision_id: str,
    data_dir: Path,
    *,
    as_copy: bool = False,
    source: str = "restore",
    author: str = "gofer",
) -> dict[str, Any]:
    revision = get_workflow_revision(workflow_id, revision_id, data_dir)
    workflow = AgenticWorkflow.from_dict(tomllib.loads(revision.toml))
    target_path = data_dir / f"{workflow.config.id}.toml"
    if as_copy:
        workflow = _workflow_copy(workflow, data_dir)
        target_path = data_dir / f"{workflow.config.id}.toml"
    elif workflow.config.id != workflow_id:
        raise WorkflowRevisionError(
            f"Revision belongs to workflow '{workflow.config.id}', not '{workflow_id}'"
        )

    workflow.validate(target_path, data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    if target_path.exists():
        capture_workflow_revision(
            target_path,
            data_dir,
            source=f"{source}:before",
            author=author,
        )
    target_path.write_text(revision.toml, encoding="utf-8")
    if as_copy:
        workflow.to_file(target_path)
    capture_workflow_revision(target_path, data_dir, source=source, author=author)
    return {
        "workflowId": workflow.config.id,
        "path": str(target_path),
        "restoredFrom": revision_id,
        "asCopy": as_copy,
    }


def get_workflow_revision(
    workflow_id: str,
    revision_id: str,
    data_dir: Path,
) -> WorkflowRevision:
    validate_workflow_id(workflow_id)
    if not re.fullmatch(r"[A-Za-z0-9_.:-]+", revision_id):
        raise WorkflowRevisionError("Invalid revision ID")
    path = revision_storage_dir(data_dir, workflow_id) / f"{revision_id}.json"
    if not path.exists():
        raise WorkflowRevisionError(f"Revision '{revision_id}' not found")
    return _load_revision(path)


def prune_workflow_revisions(
    workflow_id: str,
    data_dir: Path,
    retention: RevisionRetention,
) -> list[str]:
    revisions = list_workflow_revisions(workflow_id, data_dir)
    now = datetime.now(UTC)
    keep: set[str] = set()
    removed: list[str] = []
    for index, revision in enumerate(revisions):
        too_many = retention.max_revisions >= 0 and index >= retention.max_revisions
        too_old = (
            retention.max_age_days >= 0
            and _parse_datetime(revision.created_at)
            < now - timedelta(days=retention.max_age_days)
        )
        if too_many or too_old:
            revision.path.unlink(missing_ok=True)
            removed.append(revision.revision_id)
        else:
            keep.add(revision.revision_id)
    return removed


def summarize_workflow_diff(before_toml: str, after_toml: str) -> list[str]:
    if not before_toml:
        return ["workflow created"]
    if before_toml == after_toml:
        return ["no material changes"]
    before = _safe_toml_loads(before_toml)
    after = _safe_toml_loads(after_toml)
    if before is None or after is None:
        return ["workflow TOML changed"]

    summary: list[str] = []
    before_workflow = before.get("workflow", {}) if isinstance(before, dict) else {}
    after_workflow = after.get("workflow", {}) if isinstance(after, dict) else {}
    for key in ("id", "name", "schedule", "watch", "webhooks", "parameters", "run_continuously"):
        if before_workflow.get(key) != after_workflow.get(key):
            summary.append(f"workflow {key} changed")
    summary.extend(_mapping_changes("agent", before.get("agents", {}), after.get("agents", {})))
    summary.extend(_node_changes(before.get("nodes", []), after.get("nodes", [])))
    summary.extend(_edge_changes(before.get("edges", []), after.get("edges", [])))
    return summary or ["workflow settings changed"]


def _sanitized_toml_text(path: Path) -> str:
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise WorkflowRevisionError(str(exc)) from exc
    sanitized = _sanitized_workflow_data(data)
    return tomli_w.dumps(sanitized)


def _latest_revision(workflow_id: str, data_dir: Path) -> WorkflowRevision | None:
    revisions = list_workflow_revisions(workflow_id, data_dir, limit=1)
    return revisions[0] if revisions else None


def _load_revision(path: Path) -> WorkflowRevision:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return WorkflowRevision(
            workflow_id=validate_workflow_id(str(data["workflowId"])),
            revision_id=str(data["revisionId"]),
            created_at=str(data["createdAt"]),
            source=str(data.get("source") or "unknown"),
            author=str(data.get("author") or "unknown"),
            summary=[str(item) for item in data.get("summary", [])],
            path=path,
            toml=str(data["toml"]),
        )
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise WorkflowRevisionError(f"Invalid revision file '{path}': {exc}") from exc


def _parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _safe_toml_loads(value: str) -> dict[str, Any] | None:
    try:
        loaded = tomllib.loads(value)
    except tomllib.TOMLDecodeError:
        return None
    return loaded if isinstance(loaded, dict) else None


def _mapping_changes(label: str, before: object, after: object) -> list[str]:
    before_map = before if isinstance(before, dict) else {}
    after_map = after if isinstance(after, dict) else {}
    changes: list[str] = []
    for key in sorted(set(after_map) - set(before_map)):
        changes.append(f"{label} added: {key}")
    for key in sorted(set(before_map) - set(after_map)):
        changes.append(f"{label} removed: {key}")
    for key in sorted(set(before_map) & set(after_map)):
        if before_map[key] != after_map[key]:
            changes.append(f"{label} changed: {key}")
    return changes


def _node_changes(before: object, after: object) -> list[str]:
    return _mapping_changes("node", _items_by_id(before), _items_by_id(after))


def _edge_changes(before: object, after: object) -> list[str]:
    before_edges = _edge_set(before)
    after_edges = _edge_set(after)
    changes = [f"edge added: {edge}" for edge in sorted(after_edges - before_edges)]
    changes.extend(f"edge removed: {edge}" for edge in sorted(before_edges - after_edges))
    return changes


def _items_by_id(value: object) -> dict[str, object]:
    if not isinstance(value, list):
        return {}
    items: dict[str, object] = {}
    for item in value:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            items[item["id"]] = item
    return items


def _edge_set(value: object) -> set[str]:
    if not isinstance(value, list):
        return set()
    edges: set[str] = set()
    for edge in value:
        if not isinstance(edge, dict):
            continue
        source = edge.get("from")
        target = edge.get("to")
        if isinstance(source, str) and isinstance(target, str):
            condition = edge.get("condition", "always")
            edges.add(f"{source}->{target} ({condition})")
    return edges


def _workflow_copy(workflow: AgenticWorkflow, data_dir: Path) -> AgenticWorkflow:
    base_name = f"{workflow.config.name} Restored"
    base_id = _slugify(base_name)
    candidate = base_id
    counter = 2
    while (data_dir / f"{candidate}.toml").exists():
        candidate = f"{base_id}-{counter}"
        counter += 1
    workflow.config.id = candidate
    workflow.config.name = base_name if counter == 2 else f"{base_name} {counter - 1}"
    return workflow


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", value.lower()).strip("-")
    slug = re.sub(r"-+", "-", slug)
    return slug or "workflow"
