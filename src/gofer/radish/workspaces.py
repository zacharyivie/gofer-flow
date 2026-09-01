"""Registered Radish projects and canonical on-disk workflow workspaces."""

from __future__ import annotations

import json
import os
import re
import shutil
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]
from jsonschema.exceptions import ValidationError  # type: ignore[import-untyped]

from gofer.radish.contracts import canonical_json_bytes
from gofer.utils.paths import get_data_dir

REGISTRY_VERSION = 1
REGISTRY_FILE = "workspace-registry.json"
WORKSPACE_DIRECTORY = ".taskurotta"
WORKFLOW_ENTRYPOINT = "workflow.rad"
WORKFLOW_METADATA = "workflow.metadata.json"
WORKFLOW_IGNORE = ".taskurottaignore"
DISCOVERY_IGNORED_DIRECTORIES = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "node_modules",
    "venv",
}

DEFAULT_TASKUROTTAIGNORE = """# Sensitive local configuration
.env
.env.*
*.pem
*.key
*.p12
*.pfx
credentials.json
secrets.json

# Development and runtime state
.git/
.venv/
venv/
node_modules/
__pycache__/
.pytest_cache/
.mypy_cache/
.ruff_cache/
*.log
logs/
checkpoints/
compiled/
agent-memory/
"""


class RadishWorkspaceError(ValueError):
    """Raised when a project or registered workflow workspace is invalid."""


@dataclass(frozen=True, slots=True)
class RegisteredWorkflow:
    workflow_id: str
    name: str
    project_root: Path
    workflow_root: Path
    entrypoint: Path
    created_at: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "id": self.workflow_id,
            "name": self.name,
            "projectRoot": str(self.project_root),
            "projectName": self.project_root.name or str(self.project_root),
            "workflowRoot": str(self.workflow_root),
            "sourcePath": str(self.entrypoint),
            "createdAt": self.created_at,
        }


def create_registered_workflow(
    project_root: Path,
    name: str,
    *,
    registry_dir: Path | None = None,
) -> RegisteredWorkflow:
    """Create and register one Radish workflow below a repository project folder."""
    project_root = project_root.expanduser().resolve()
    if not project_root.is_dir():
        raise RadishWorkspaceError(f"Project folder does not exist: {project_root}")
    workflow_name = name.strip()
    if not workflow_name:
        raise RadishWorkspaceError("Workflow name is required")

    registry_root = (registry_dir or get_data_dir()).expanduser().resolve()
    document = _read_registry(registry_root)
    workflow_id = _allocate_workflow_id(_slugify(workflow_name), document, project_root)
    workflow_root = project_root / WORKSPACE_DIRECTORY / workflow_id
    workspace_created = False
    try:
        from gofer.radish.artifacts import compile_radish_file

        workflow_root.mkdir(parents=True, exist_ok=False)
        workspace_created = True
        entrypoint = workflow_root / WORKFLOW_ENTRYPOINT
        _write_text_atomic(entrypoint, _initial_source(workflow_name))
        _write_json_atomic(workflow_root / WORKFLOW_METADATA, _initial_metadata())
        _write_text_atomic(workflow_root / WORKFLOW_IGNORE, DEFAULT_TASKUROTTAIGNORE)
        compile_radish_file(
            entrypoint,
            data_dir=registry_root,
            workflow_id=workflow_id,
        )
        created_at = datetime.now(UTC).isoformat()
        registered = RegisteredWorkflow(
            workflow_id=workflow_id,
            name=workflow_name,
            project_root=project_root,
            workflow_root=workflow_root,
            entrypoint=entrypoint,
            created_at=created_at,
        )
        _register(document, registered)
        _write_registry(registry_root, document)
    except Exception:
        if workspace_created:
            shutil.rmtree(workflow_root, ignore_errors=True)
        raise
    return registered


def discover_registered_workflows(
    project_root: Path,
    *,
    registry_dir: Path | None = None,
) -> tuple[RegisteredWorkflow, ...]:
    """Find Radish workflow directories in a project and register them without rewriting files."""
    project_root = project_root.expanduser().resolve()
    if not project_root.is_dir():
        raise RadishWorkspaceError(f"Project folder does not exist: {project_root}")

    candidates: dict[Path, list[Path]] = {}
    for directory, child_directories, files in os.walk(project_root):
        child_directories[:] = sorted(
            child
            for child in child_directories
            if child not in DISCOVERY_IGNORED_DIRECTORIES
            and (not child.startswith(".") or child == WORKSPACE_DIRECTORY)
        )
        radish_files = sorted(
            Path(directory, filename).resolve()
            for filename in files
            if filename.lower().endswith(".rad")
        )
        if radish_files:
            candidates[Path(directory).resolve()] = radish_files

    registry_root = (registry_dir or get_data_dir()).expanduser().resolve()
    document = _read_registry(registry_root)
    existing = [_registered_workflow(item) for item in document["workflows"]]
    existing_by_root = {workflow.workflow_root.resolve(): workflow for workflow in existing}
    discovered: list[RegisteredWorkflow] = []
    changed = False

    for workflow_root, radish_files in sorted(candidates.items(), key=lambda item: str(item[0])):
        registered = existing_by_root.get(workflow_root)
        if registered is not None:
            discovered.append(registered)
            continue
        entrypoint = next(
            (path for path in radish_files if path.name.lower() == WORKFLOW_ENTRYPOINT),
            radish_files[0],
        )
        workflow_name = workflow_root.name or entrypoint.stem
        workflow_id = _allocate_workflow_id(
            _slugify(workflow_name),
            document,
            project_root,
            existing_workspace=workflow_root,
        )
        registered = RegisteredWorkflow(
            workflow_id=workflow_id,
            name=workflow_name,
            project_root=project_root,
            workflow_root=workflow_root,
            entrypoint=entrypoint,
            created_at=datetime.now(UTC).isoformat(),
        )
        _register(document, registered)
        existing_by_root[workflow_root] = registered
        discovered.append(registered)
        changed = True

    if changed:
        _write_registry(registry_root, document)
    return tuple(discovered)


def list_registered_workflows(
    *, registry_dir: Path | None = None
) -> tuple[RegisteredWorkflow, ...]:
    registry_root = (registry_dir or get_data_dir()).expanduser().resolve()
    document = _read_registry(registry_root)
    workflows = [_registered_workflow(item) for item in document["workflows"]]
    return tuple(sorted(workflows, key=lambda item: (str(item.project_root), item.workflow_id)))


def find_registered_workflow(
    workflow_id: str,
    *,
    registry_dir: Path | None = None,
) -> RegisteredWorkflow:
    canonical = workflow_id.lower()
    matches = [
        workflow
        for workflow in list_registered_workflows(registry_dir=registry_dir)
        if workflow.workflow_id.lower() == canonical
    ]
    if not matches:
        raise RadishWorkspaceError(f"Registered workflow not found: {workflow_id}")
    if len(matches) > 1:
        raise RadishWorkspaceError(f"Workflow ID is registered more than once: {workflow_id}")
    return matches[0]


def read_workflow_metadata(workflow: RegisteredWorkflow) -> dict[str, Any]:
    """Read and validate editor metadata for a registered workflow."""
    path = workflow.workflow_root / WORKFLOW_METADATA
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        Draft202012Validator(_metadata_schema()).validate(document)
    except (OSError, UnicodeError, json.JSONDecodeError, ValidationError) as exc:
        raise RadishWorkspaceError(f"Invalid workflow metadata {path}: {exc}") from exc
    return cast(dict[str, Any], document)


def write_workflow_metadata(workflow: RegisteredWorkflow, document: dict[str, Any]) -> None:
    """Validate and atomically replace editor metadata."""
    try:
        Draft202012Validator(_metadata_schema()).validate(document)
    except ValidationError as exc:
        raise RadishWorkspaceError(
            f"Refusing to write invalid workflow metadata: {exc.message}"
        ) from exc
    _write_json_atomic(workflow.workflow_root / WORKFLOW_METADATA, document)


def write_workflow_source(workflow: RegisteredWorkflow, source: str) -> None:
    """Atomically replace the registered Radish entrypoint."""
    _write_text_atomic(workflow.entrypoint, source)


def update_registered_workflow_name(
    workflow_id: str,
    name: str,
    *,
    registry_dir: Path | None = None,
) -> None:
    """Update the display name without changing the installed workflow ID."""
    workflow_name = name.strip()
    if not workflow_name:
        raise RadishWorkspaceError("Workflow name is required")
    registry_root = (registry_dir or get_data_dir()).expanduser().resolve()
    document = _read_registry(registry_root)
    matches = [
        item for item in document["workflows"] if str(item["id"]).lower() == workflow_id.lower()
    ]
    if len(matches) != 1:
        raise RadishWorkspaceError(f"Registered workflow not found: {workflow_id}")
    matches[0]["name"] = workflow_name
    _write_registry(registry_root, document)


def _registry_schema() -> dict[str, Any]:
    schema_path = Path(__file__).with_name("assets") / "schemas" / "workspace-registry.schema.json"
    if not schema_path.is_file():
        schema_path = (
            Path(__file__).parents[3] / "radish" / "schemas" / "workspace-registry.schema.json"
        )
    try:
        return cast(dict[str, Any], json.loads(schema_path.read_text(encoding="utf-8")))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RadishWorkspaceError(f"Could not load workspace registry schema: {exc}") from exc


def _metadata_schema() -> dict[str, Any]:
    schema_path = Path(__file__).with_name("assets") / "schemas" / "workflow-metadata.schema.json"
    if not schema_path.is_file():
        schema_path = Path(__file__).parents[3] / "radish" / "schemas" / schema_path.name
    try:
        return cast(dict[str, Any], json.loads(schema_path.read_text(encoding="utf-8")))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RadishWorkspaceError(f"Could not load workflow metadata schema: {exc}") from exc


def _empty_registry() -> dict[str, Any]:
    return {"registry_version": REGISTRY_VERSION, "workflows": []}


def _read_registry(registry_dir: Path) -> dict[str, Any]:
    path = registry_dir / "radish" / REGISTRY_FILE
    if not path.exists():
        return _empty_registry()
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        Draft202012Validator(_registry_schema()).validate(document)
    except (OSError, UnicodeError, json.JSONDecodeError, ValidationError) as exc:
        raise RadishWorkspaceError(f"Invalid Radish workspace registry {path}: {exc}") from exc
    return cast(dict[str, Any], document)


def _write_registry(registry_dir: Path, document: dict[str, Any]) -> None:
    try:
        Draft202012Validator(_registry_schema()).validate(document)
    except ValidationError as exc:
        raise RadishWorkspaceError(
            f"Refusing to write invalid workspace registry: {exc.message}"
        ) from exc
    _write_json_atomic(registry_dir / "radish" / REGISTRY_FILE, document)


def _register(document: dict[str, Any], workflow: RegisteredWorkflow) -> None:
    if any(
        str(item["id"]).lower() == workflow.workflow_id.lower() for item in document["workflows"]
    ):
        raise RadishWorkspaceError(f"Workflow ID is already registered: {workflow.workflow_id}")
    document["workflows"].append(
        {
            "id": workflow.workflow_id,
            "name": workflow.name,
            "project_root": str(workflow.project_root),
            "workflow_root": str(workflow.workflow_root),
            "entrypoint": str(workflow.entrypoint),
            "created_at": workflow.created_at,
        }
    )
    document["workflows"].sort(key=lambda item: (item["project_root"], item["id"]))


def _allocate_workflow_id(
    requested: str,
    document: dict[str, Any],
    project_root: Path,
    *,
    existing_workspace: Path | None = None,
) -> str:
    registered_ids = {str(item["id"]).lower() for item in document["workflows"]}
    workspace = project_root / WORKSPACE_DIRECTORY
    suffix = 1
    while True:
        candidate = requested if suffix == 1 else f"{requested}-{suffix}"
        candidate_workspace = workspace / candidate
        workspace_available = not candidate_workspace.exists() or (
            existing_workspace is not None
            and candidate_workspace.resolve() == existing_workspace.resolve()
        )
        if candidate.lower() not in registered_ids and workspace_available:
            return candidate
        suffix += 1


def _registered_workflow(item: dict[str, Any]) -> RegisteredWorkflow:
    return RegisteredWorkflow(
        workflow_id=item["id"],
        name=item["name"],
        project_root=Path(item["project_root"]),
        workflow_root=Path(item["workflow_root"]),
        entrypoint=Path(item["entrypoint"]),
        created_at=item["created_at"],
    )


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    if not slug:
        return "workflow"
    return slug if slug[0].isalpha() else f"workflow-{slug}"


def _initial_source(name: str) -> str:
    encoded_name = json.dumps(name, ensure_ascii=False)
    return f"Radish: 1\n\nWorkflow:\n  name: {encoded_name}\n"


def _initial_metadata() -> dict[str, Any]:
    return {
        "metadataVersion": 1,
        "canvas": {"nodes": {}, "zoom": 1.0, "pan": {"x": 0, "y": 0}},
        "editor": {"foldedDeclarations": []},
    }


def _write_json_atomic(path: Path, document: dict[str, Any]) -> None:
    _write_bytes_atomic(path, canonical_json_bytes(document) + b"\n")


def _write_text_atomic(path: Path, content: str) -> None:
    _write_bytes_atomic(path, content.encode("utf-8"))


def _write_bytes_atomic(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_bytes(content)
        os.replace(temporary, path)
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        raise RadishWorkspaceError(f"Could not write {path}: {exc}") from exc
