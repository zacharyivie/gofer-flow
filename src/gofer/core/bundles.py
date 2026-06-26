from __future__ import annotations

import json
import re
import tomllib
import urllib.parse
import zipfile
from dataclasses import dataclass, field
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path, PurePosixPath
from typing import Any, cast

import tomli_w

from gofer.core.workflow import AgenticWorkflow, validate_workflow_id

BUNDLE_FORMAT_VERSION = 1
MANIFEST_PATH = "manifest.json"
WORKFLOW_PATH = "workflow.toml"
ASSET_PREFIX = "assets/"
IMPORTED_ASSET_PREFIX = "bundle-assets"
SECRET_TOKEN_PATTERN = re.compile(
    r"\{\{\s*secret\.([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}|secret:([A-Za-z_][A-Za-z0-9_.-]*)"
)
SENSITIVE_FIELD_NAMES = {
    "authorization",
    "cookie",
    "x-api-key",
    "api-key",
    "token",
    "password",
    "secret",
}
MASKED_SECRET_VALUE = "***"


class BundleError(ValueError):
    pass


@dataclass(frozen=True)
class BundlePath:
    source: Path
    workflow_path: str
    archive_path: str
    kind: str


@dataclass(frozen=True)
class ExternalRequirement:
    path: str
    reason: str
    owner: str

    def to_dict(self) -> dict[str, str]:
        return {"path": self.path, "reason": self.reason, "owner": self.owner}


@dataclass(frozen=True)
class BundleManifest:
    format_version: int
    workflow_id: str
    workflow_name: str
    gofer_flow_version: str
    included_paths: list[dict[str, str]]
    required_secrets: list[dict[str, str]]
    provider_assumptions: list[dict[str, str]]
    triggers: list[dict[str, str]]
    external_requirements: list[dict[str, str]]
    notes: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "formatVersion": self.format_version,
            "workflow": {
                "id": self.workflow_id,
                "name": self.workflow_name,
            },
            "goferFlowVersion": self.gofer_flow_version,
            "includedPaths": self.included_paths,
            "requiredSecrets": self.required_secrets,
            "providerAssumptions": self.provider_assumptions,
            "triggers": self.triggers,
            "externalRequirements": self.external_requirements,
        }
        if self.notes:
            payload["notes"] = self.notes
        return payload

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BundleManifest:
        workflow = data.get("workflow") or {}
        return cls(
            format_version=int(data.get("formatVersion", 0)),
            workflow_id=str(workflow.get("id") or ""),
            workflow_name=str(workflow.get("name") or ""),
            gofer_flow_version=str(data.get("goferFlowVersion") or "unknown"),
            included_paths=[
                {str(k): str(v) for k, v in item.items()}
                for item in data.get("includedPaths", [])
                if isinstance(item, dict)
            ],
            required_secrets=[
                {str(k): str(v) for k, v in item.items()}
                for item in data.get("requiredSecrets", [])
                if isinstance(item, dict)
            ],
            provider_assumptions=[
                {str(k): str(v) for k, v in item.items()}
                for item in data.get("providerAssumptions", [])
                if isinstance(item, dict)
            ],
            triggers=[
                {str(k): str(v) for k, v in item.items()}
                for item in data.get("triggers", [])
                if isinstance(item, dict)
            ],
            external_requirements=[
                {str(k): str(v) for k, v in item.items()}
                for item in data.get("externalRequirements", [])
                if isinstance(item, dict)
            ],
            notes=str(data["notes"]) if data.get("notes") is not None else None,
        )


@dataclass(frozen=True)
class ImportConflict:
    path: str
    action: str

    def to_dict(self) -> dict[str, str]:
        return {"path": self.path, "action": self.action}


@dataclass(frozen=True)
class BundleImportPlan:
    manifest: BundleManifest
    workflow_id: str
    workflow_name: str
    workflow_path: Path
    files_to_create: list[str]
    files_to_overwrite: list[str]
    conflicts: list[ImportConflict]
    external_requirements: list[dict[str, str]]
    required_secrets: list[dict[str, str]]
    path_rewrites: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "workflowId": self.workflow_id,
            "workflowName": self.workflow_name,
            "workflowPath": str(self.workflow_path),
            "manifest": self.manifest.to_dict(),
            "filesToCreate": self.files_to_create,
            "filesToOverwrite": self.files_to_overwrite,
            "conflicts": [conflict.to_dict() for conflict in self.conflicts],
            "externalRequirements": self.external_requirements,
            "requiredSecrets": self.required_secrets,
            "pathRewrites": self.path_rewrites,
        }


def export_workflow_bundle(
    workflow_ref: str | Path,
    output_path: Path,
    *,
    data_dir: Path | None = None,
    notes: str | None = None,
) -> BundleManifest:
    workflow, workflow_path = _resolve_workflow_with_path(workflow_ref, data_dir)
    raw = _read_workflow_toml(workflow_path)
    sanitized = _sanitized_workflow_data(raw)
    path_base = workflow_path.parent
    included, external = _collect_bundle_paths(workflow, path_base)
    manifest = BundleManifest(
        format_version=BUNDLE_FORMAT_VERSION,
        workflow_id=workflow.config.id,
        workflow_name=workflow.config.name,
        gofer_flow_version=_gofer_version(),
        included_paths=[
            {
                "path": item.workflow_path,
                "archivePath": item.archive_path,
                "kind": item.kind,
            }
            for item in included
        ],
        required_secrets=_required_secrets(raw, workflow, included),
        provider_assumptions=_provider_assumptions(workflow),
        triggers=_triggers(workflow),
        external_requirements=[item.to_dict() for item in external],
        notes=notes,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(MANIFEST_PATH, json.dumps(manifest.to_dict(), indent=2) + "\n")
        archive.writestr(WORKFLOW_PATH, tomli_w.dumps(sanitized))
        for item in included:
            if item.source.is_dir():
                for file_path in sorted(path for path in item.source.rglob("*") if path.is_file()):
                    rel = file_path.relative_to(item.source).as_posix()
                    archive.writestr(
                        _safe_archive_join(item.archive_path, rel),
                        file_path.read_bytes(),
                    )
            else:
                archive.write(item.source, item.archive_path)
    return manifest


def preview_workflow_bundle(bundle_path: Path, *, data_dir: Path | None = None) -> BundleImportPlan:
    return _build_import_plan(bundle_path, _data_dir(data_dir), replace=False)


def import_workflow_bundle(
    bundle_path: Path,
    *,
    data_dir: Path | None = None,
    replace: bool = False,
    dry_run: bool = False,
) -> BundleImportPlan:
    base = _data_dir(data_dir)
    plan = _build_import_plan(bundle_path, base, replace=replace)
    if dry_run:
        return plan
    base.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(bundle_path) as archive:
        _validate_archive_entries(archive)
        workflow_data = _workflow_data_for_import(archive, plan)
        for item in plan.manifest.included_paths:
            archive_path = item["archivePath"]
            original_path = item["path"]
            target_rel = plan.path_rewrites.get(original_path, original_path)
            for name in archive.namelist():
                if name == archive_path or name.startswith(f"{archive_path.rstrip('/')}/"):
                    if name.endswith("/"):
                        continue
                    nested = None
                    if name != archive_path:
                        nested = PurePosixPath(name).relative_to(PurePosixPath(archive_path))
                    destination = _safe_destination(
                        base,
                        target_rel,
                        nested.as_posix() if nested is not None else None,
                    )
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(archive.read(name))
        plan.workflow_path.parent.mkdir(parents=True, exist_ok=True)
        plan.workflow_path.write_bytes(tomli_w.dumps(workflow_data).encode())
    AgenticWorkflow.from_file(plan.workflow_path).validate(plan.workflow_path, base)
    return plan


def _build_import_plan(bundle_path: Path, base: Path, *, replace: bool) -> BundleImportPlan:
    if not bundle_path.exists():
        raise BundleError(f"{bundle_path} not found")
    with zipfile.ZipFile(bundle_path) as archive:
        _validate_archive_entries(archive)
        manifest = BundleManifest.from_dict(json.loads(archive.read(MANIFEST_PATH)))
        if manifest.format_version != BUNDLE_FORMAT_VERSION:
            raise BundleError(f"Unsupported bundle format version {manifest.format_version}")
        raw = tomllib.loads(archive.read(WORKFLOW_PATH).decode("utf-8"))
        archived_asset_files = _archived_asset_files(archive, manifest)
    workflow = AgenticWorkflow.from_dict(raw)
    requested_id = workflow.config.id
    workflow_id = requested_id if replace else _available_workflow_id(requested_id, base)
    workflow_name = (
        workflow.config.name
        if workflow_id == requested_id
        else f"{workflow.config.name} ({workflow_id})"
    )
    workflow_path = _safe_destination(base, f"{workflow_id}.toml")

    path_rewrites: dict[str, str] = {}
    conflicts: list[ImportConflict] = []
    asset_conflict = any(
        _safe_destination(base, item["path"]).exists() for item in manifest.included_paths
    )
    if asset_conflict and not replace:
        for item in manifest.included_paths:
            path_rewrites[item["path"]] = f"{IMPORTED_ASSET_PREFIX}/{workflow_id}/{item['path']}"
            conflicts.append(
                ImportConflict(
                    path=item["path"],
                    action=f"rename to {path_rewrites[item['path']]}",
                )
            )
    if workflow_path.exists() and not replace:
        conflicts.append(
            ImportConflict(
                path=f"{requested_id}.toml",
                action=f"rename to {workflow_id}.toml",
            )
        )

    files_to_create: list[str] = []
    files_to_overwrite: list[str] = []
    import_paths = [f"{workflow_id}.toml"]
    for item, nested in archived_asset_files:
        target_rel = path_rewrites.get(item["path"], item["path"])
        import_paths.append(_safe_archive_join(target_rel, nested) if nested else target_rel)
    for rel in import_paths:
        destination = _safe_destination(base, rel)
        if destination.exists():
            files_to_overwrite.append(destination.relative_to(base).as_posix())
        else:
            files_to_create.append(destination.relative_to(base).as_posix())

    return BundleImportPlan(
        manifest=manifest,
        workflow_id=workflow_id,
        workflow_name=workflow_name,
        workflow_path=workflow_path,
        files_to_create=files_to_create,
        files_to_overwrite=files_to_overwrite,
        conflicts=conflicts,
        external_requirements=manifest.external_requirements,
        required_secrets=manifest.required_secrets,
        path_rewrites=path_rewrites,
    )


def _archived_asset_files(
    archive: zipfile.ZipFile,
    manifest: BundleManifest,
) -> list[tuple[dict[str, str], str | None]]:
    archived_names = archive.namelist()
    files: list[tuple[dict[str, str], str | None]] = []
    for item in manifest.included_paths:
        archive_path = _safe_relative_path(item["archivePath"])
        matched = False
        for name in archived_names:
            if name.endswith("/"):
                continue
            if name == archive_path:
                files.append((item, None))
                matched = True
                continue
            if name.startswith(f"{archive_path.rstrip('/')}/"):
                nested = PurePosixPath(name).relative_to(PurePosixPath(archive_path)).as_posix()
                files.append((item, _safe_relative_path(nested)))
                matched = True
        if not matched:
            raise BundleError(f"Bundle is missing archived asset {archive_path}")
    return files


def _workflow_data_for_import(
    archive: zipfile.ZipFile,
    plan: BundleImportPlan,
) -> dict[str, Any]:
    raw = tomllib.loads(archive.read(WORKFLOW_PATH).decode("utf-8"))
    raw.setdefault("workflow", {})["id"] = plan.workflow_id
    raw["workflow"]["name"] = plan.workflow_name
    if plan.path_rewrites:
        _rewrite_workflow_paths(raw, plan.path_rewrites)
    return raw


def _collect_bundle_paths(
    workflow: AgenticWorkflow,
    path_base: Path,
) -> tuple[list[BundlePath], list[ExternalRequirement]]:
    included: dict[str, BundlePath] = {}
    external: dict[str, ExternalRequirement] = {}

    def add(path: Path | None, owner: str, kind: str, *, copy_dir: bool = False) -> None:
        if path is None:
            return
        if path.is_absolute() or str(path).startswith("~"):
            external[str(path)] = ExternalRequirement(
                path=str(path),
                reason="absolute or user-relative path is machine-specific",
                owner=owner,
            )
            return
        rel = _safe_relative_path(str(path))
        source = (path_base / rel).resolve()
        if not source.exists():
            external[rel] = ExternalRequirement(
                path=rel,
                reason="referenced path was missing during export",
                owner=owner,
            )
            return
        if source.is_dir() and not copy_dir:
            external[rel] = ExternalRequirement(
                path=rel,
                reason="directory path is treated as an external requirement",
                owner=owner,
            )
            return
        included[rel] = BundlePath(
            source=source,
            workflow_path=rel,
            archive_path=f"{ASSET_PREFIX}{rel}",
            kind=kind,
        )

    def add_vector_index_sidecar(index_path: Path, owner: str) -> None:
        if index_path.is_absolute() or str(index_path).startswith("~"):
            return
        rel = _safe_relative_path(str(index_path))
        source = (path_base / rel).resolve()
        if not source.exists() or source.is_dir():
            return

        entries_path, entries_rel, explicit = _vector_index_entries_path(source, rel, path_base)
        if entries_path is None or entries_rel is None:
            return
        if entries_path.is_absolute() and not entries_path.is_relative_to(path_base.resolve()):
            external[str(entries_path)] = ExternalRequirement(
                path=str(entries_path),
                reason="absolute or user-relative path is machine-specific",
                owner=f"{owner}.entries_file",
            )
            return
        if not entries_path.exists():
            if explicit:
                external[entries_rel] = ExternalRequirement(
                    path=entries_rel,
                    reason="referenced path was missing during export",
                    owner=f"{owner}.entries_file",
                )
            return
        included[entries_rel] = BundlePath(
            source=entries_path,
            workflow_path=entries_rel,
            archive_path=f"{ASSET_PREFIX}{entries_rel}",
            kind="index_entries",
        )

    if workflow.config.watch is not None:
        add(workflow.config.watch.path, "workflow.watch", "watch", copy_dir=False)
    for agent_id, agent in workflow.agents.items():
        add(agent.prompt_path, f"agent:{agent_id}.prompt_path", "prompt")
        add(agent.working_dir, f"agent:{agent_id}.working_dir", "working_dir", copy_dir=False)
        for index, extra_path in enumerate(agent.extra_paths):
            add(extra_path, f"agent:{agent_id}.extra_paths[{index}]", "extra_path", copy_dir=False)
    for node in workflow.graph.nodes_in_order():
        op = node.operation
        for field_name, kind, copy_dir in (
            ("prompt_path", "prompt", False),
            ("script_path", "script", False),
            ("template_path", "prompt_template", False),
            ("index_path", "index", False),
            ("source_path", "sample_asset", True),
            ("path", "sample_asset", False),
        ):
            value = getattr(op, field_name, None)
            if isinstance(value, Path):
                owner = f"node:{node.node_id}.{field_name}"
                add(value, owner, kind, copy_dir=copy_dir)
                if field_name == "index_path":
                    add_vector_index_sidecar(value, owner)
        source = getattr(op, "source", None)
        source_path = getattr(source, "path", None)
        if isinstance(source_path, Path):
            add(source_path, f"node:{node.node_id}.source.path", "sample_asset", copy_dir=False)
    return sorted(included.values(), key=lambda item: item.workflow_path), sorted(
        external.values(),
        key=lambda item: item.path,
    )


def _required_secrets(
    data: dict[str, Any],
    workflow: AgenticWorkflow,
    included: list[BundlePath],
) -> list[dict[str, str]]:
    names: set[str] = set()
    for match in SECRET_TOKEN_PATTERN.finditer(json.dumps(data, sort_keys=True)):
        names.add(match.group(1) or match.group(2))
    for item in included:
        if item.source.is_dir():
            paths = [path for path in item.source.rglob("*") if path.is_file()]
        else:
            paths = [item.source]
        for path in paths:
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            for match in SECRET_TOKEN_PATTERN.finditer(text):
                names.add(match.group(1) or match.group(2))
    for trigger in workflow.config.webhooks.values():
        if trigger.token_env:
            names.add(trigger.token_env)
    for name in _required_env_secret_names(data):
        names.add(name)
    return [{"name": name, "description": "Required by bundled workflow"} for name in sorted(names)]


def _provider_assumptions(workflow: AgenticWorkflow) -> list[dict[str, str]]:
    assumptions = []
    for agent in workflow.agents.values():
        item = {
            "agentId": agent.agent_id,
            "subscription": agent.subscription,
        }
        if agent.profile:
            item["profile"] = agent.profile
        if agent.model:
            item["model"] = agent.model
        assumptions.append(item)
    return assumptions


def _triggers(workflow: AgenticWorkflow) -> list[dict[str, str]]:
    triggers: list[dict[str, str]] = []
    if workflow.config.schedule is not None:
        triggers.append(
            {
                "type": "schedule",
                "cron": workflow.config.schedule.cron_expression,
                "timezone": workflow.config.schedule.timezone,
            }
        )
    if workflow.config.watch is not None:
        triggers.append(
            {
                "type": "watch",
                "path": str(workflow.config.watch.path),
                "glob": workflow.config.watch.glob,
                "mode": workflow.config.watch.mode,
            }
        )
    for trigger_id, trigger in sorted(workflow.config.webhooks.items()):
        item = {
            "type": "webhook",
            "id": trigger_id,
            "source": trigger.source,
            "enabled": str(trigger.enabled).lower(),
            "concurrencyPolicy": trigger.concurrency_policy,
        }
        if trigger.token_env:
            item["tokenEnv"] = trigger.token_env
        if trigger.fanout_path:
            item["fanoutPath"] = trigger.fanout_path
        triggers.append(item)
    return triggers


def _vector_index_entries_path(
    index_path: Path,
    workflow_rel: str,
    path_base: Path,
) -> tuple[Path | None, str | None, bool]:
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return (
            _default_vector_entries_path(index_path),
            _default_vector_entries_rel(workflow_rel),
            False,
        )
    if not isinstance(index, dict):
        return (
            _default_vector_entries_path(index_path),
            _default_vector_entries_rel(workflow_rel),
            False,
        )
    entries_file = index.get("entries_file")
    if isinstance(entries_file, str) and entries_file:
        entries_path = Path(entries_file)
        if entries_path.is_absolute() or str(entries_path).startswith("~"):
            return entries_path, str(entries_path), True
        resolved = (index_path.parent / entries_path).resolve()
        try:
            entries_rel = resolved.relative_to(path_base.resolve()).as_posix()
        except ValueError:
            return resolved, str(resolved), True
        return resolved, _safe_relative_path(entries_rel), True
    return (
        _default_vector_entries_path(index_path),
        _default_vector_entries_rel(workflow_rel),
        False,
    )


def _default_vector_entries_path(index_path: Path) -> Path:
    return index_path.with_name(f"{index_path.name}.entries.jsonl")


def _default_vector_entries_rel(workflow_rel: str) -> str:
    path = PurePosixPath(workflow_rel)
    filename = f"{path.name}.entries.jsonl"
    if path.parent == PurePosixPath("."):
        return _safe_relative_path(filename)
    return _safe_archive_join(path.parent.as_posix(), filename)


def _sanitized_workflow_data(data: dict[str, Any]) -> dict[str, Any]:
    copied = json.loads(json.dumps(data, default=str))
    webhooks = copied.get("workflow", {}).get("webhooks", {})
    if isinstance(webhooks, dict):
        for trigger in webhooks.values():
            if isinstance(trigger, dict) and trigger.get("token"):
                trigger.pop("token", None)
    _sanitize_http_request_nodes(copied)
    _sanitize_env_maps(copied)
    return cast(dict[str, Any], copied)


def _required_env_secret_names(data: dict[str, Any]) -> set[str]:
    names: set[str] = set()
    for env in _workflow_env_maps(data):
        for key, value in env.items():
            env_name = str(key)
            env_value = str(value)
            if _is_sensitive_env_name(env_name) and not _contains_secret_reference(env_value):
                names.add(env_name)
    return names


def _sanitize_env_maps(data: dict[str, Any]) -> None:
    for env in _workflow_env_maps(data):
        for key, value in list(env.items()):
            env_name = str(key)
            env_value = str(value)
            if _is_sensitive_env_name(env_name) and not _contains_secret_reference(env_value):
                env[env_name] = MASKED_SECRET_VALUE


def _workflow_env_maps(data: dict[str, Any]) -> list[dict[str, Any]]:
    env_maps: list[dict[str, Any]] = []
    agents = data.get("agents")
    if isinstance(agents, dict):
        for agent in agents.values():
            if isinstance(agent, dict) and isinstance(agent.get("env"), dict):
                env_maps.append(agent["env"])
    nodes = data.get("nodes")
    if isinstance(nodes, list):
        for node in nodes:
            if isinstance(node, dict) and isinstance(node.get("env"), dict):
                env_maps.append(node["env"])
    return env_maps


def _sanitize_http_request_nodes(data: dict[str, Any]) -> None:
    nodes = data.get("nodes")
    if not isinstance(nodes, list):
        return
    for node in nodes:
        if not isinstance(node, dict) or node.get("type") != "http_request":
            continue
        configured = {str(field).lower() for field in node.get("secret_fields") or []}
        secret_values = _collect_http_secret_values(node, configured)
        node["url"] = _sanitize_http_url(
            str(node.get("url", "")),
            configured,
            secret_values,
        )
        for key in ("headers", "params", "json"):
            if key in node:
                node[key] = _sanitize_http_value(
                    node[key],
                    configured,
                    key,
                    secret_values,
                )
        body = node.get("body")
        if isinstance(body, str):
            node["body"] = _sanitize_http_body(body, configured, secret_values)


def _collect_http_secret_values(node: dict[str, Any], configured: set[str]) -> set[str]:
    values: set[str] = set()
    url = node.get("url")
    if isinstance(url, str):
        if _is_sensitive_http_field("url", configured):
            values.update(_collect_plain_leaf_strings(url))
        parsed = urllib.parse.urlsplit(url)
        for key, value in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True):
            if _is_sensitive_http_field(key, configured):
                values.update(_collect_plain_leaf_strings(value))
    for key in ("headers", "params", "json"):
        values.update(_collect_configured_http_values(node.get(key), configured, key))
    body = node.get("body")
    if isinstance(body, str):
        values.update(_collect_http_body_secret_values(body, configured))
    return {value for value in values if value and not _contains_secret_reference(value)}


def _collect_configured_http_values(
    value: object,
    configured: set[str],
    path: str = "",
) -> set[str]:
    if isinstance(value, dict):
        values: set[str] = set()
        for key, item in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            if _is_sensitive_http_field(child_path, configured):
                values.update(_collect_plain_leaf_strings(item))
            else:
                values.update(_collect_configured_http_values(item, configured, child_path))
        return values
    if isinstance(value, list):
        values = set()
        for item in value:
            values.update(_collect_configured_http_values(item, configured, path))
        return values
    if path and _is_sensitive_http_field(path, configured):
        return _collect_plain_leaf_strings(value)
    return set()


def _collect_plain_leaf_strings(value: object) -> set[str]:
    if isinstance(value, str):
        return {value} if value and not _contains_secret_reference(value) else set()
    if isinstance(value, dict):
        values: set[str] = set()
        for item in value.values():
            values.update(_collect_plain_leaf_strings(item))
        return values
    if isinstance(value, list):
        values = set()
        for item in value:
            values.update(_collect_plain_leaf_strings(item))
        return values
    if value is None:
        return set()
    text = str(value)
    return {text} if text else set()


def _collect_http_body_secret_values(value: str, configured: set[str]) -> set[str]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        values: set[str] = set()
        for pattern in (
            r"(?:^|[&\s;,])(?P<key>[A-Za-z0-9_.-]+)\s*=\s*(?P<value>[^&\s;,]+)",
            r"(?:^|[\s{,])['\"]?(?P<key>[A-Za-z0-9_.-]+)['\"]?\s*:\s*"
            r"(?P<quote>['\"]?)(?P<value>[^,'\"}\s]+)(?P=quote)",
        ):
            for match in re.finditer(pattern, value):
                if _is_sensitive_http_field(match.group("key"), configured):
                    secret = match.group("value").strip("\"'")
                    if secret and not _contains_secret_reference(secret):
                        values.add(secret)
        return values
    return _collect_configured_http_values(parsed, configured)


def _sanitize_http_url(url: str, configured: set[str], secret_values: set[str]) -> str:
    if _is_sensitive_http_field("url", configured):
        return url if _is_secret_reference_only(url) else MASKED_SECRET_VALUE
    parsed = urllib.parse.urlsplit(url)
    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    sanitized_pairs = [
        (
            key,
            _sanitize_http_string(
                value,
                secret_values,
                force=_is_sensitive_http_field(key, configured),
            ),
        )
        for key, value in query_pairs
    ]
    sanitized = urllib.parse.urlunsplit(
        parsed._replace(query=urllib.parse.urlencode(sanitized_pairs))
    )
    return _sanitize_http_string(sanitized, secret_values)


def _sanitize_http_value(
    value: object,
    configured: set[str],
    path: str = "",
    secret_values: set[str] | None = None,
) -> object:
    secret_values = secret_values or set()
    if isinstance(value, dict):
        sanitized: dict[str, object] = {}
        for key, item in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            sanitized[str(key)] = _sanitize_http_value(
                item,
                configured,
                child_path,
                secret_values,
            )
        return sanitized
    if isinstance(value, list):
        return [
            _sanitize_http_value(item, configured, path, secret_values)
            for item in value
        ]
    if isinstance(value, str):
        return _sanitize_http_string(
            value,
            secret_values,
            force=bool(path) and _is_sensitive_http_field(path, configured),
        )
    if path and _is_sensitive_http_field(path, configured):
        return MASKED_SECRET_VALUE
    return value


def _sanitize_http_body(value: str, configured: set[str], secret_values: set[str]) -> str:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        sanitized = _sanitize_http_string(value, secret_values)

        def mask_key_value(match: re.Match[str]) -> str:
            if not _is_sensitive_http_field(match.group("key"), configured):
                return match.group(0)
            quote = match.groupdict().get("quote") or ""
            return f"{match.group('prefix')}{quote}{MASKED_SECRET_VALUE}{quote}"

        sanitized = re.sub(
            r"(?P<prefix>(?:^|[&\s;,])(?P<key>[A-Za-z0-9_.-]+)\s*=\s*)"
            r"(?P<value>[^&\s;,]+)",
            mask_key_value,
            sanitized,
        )
        return re.sub(
            r"(?P<prefix>(?:^|[\s{,])['\"]?(?P<key>[A-Za-z0-9_.-]+)['\"]?\s*:\s*)"
            r"(?P<quote>['\"]?)(?P<value>[^,'\"}\s]+)(?P=quote)",
            mask_key_value,
            sanitized,
        )
    return json.dumps(
        _sanitize_http_value(parsed, configured, secret_values=secret_values),
        default=str,
    )


def _sanitize_http_string(
    value: str,
    secret_values: set[str],
    *,
    force: bool = False,
) -> str:
    if force:
        return value if _is_secret_reference_only(value) else MASKED_SECRET_VALUE
    sanitized = value
    for secret_value in sorted(secret_values, key=len, reverse=True):
        sanitized = sanitized.replace(secret_value, MASKED_SECRET_VALUE)
    return sanitized


def _contains_secret_reference(value: str) -> bool:
    return bool(SECRET_TOKEN_PATTERN.search(value))


def _is_secret_reference_only(value: str) -> bool:
    return SECRET_TOKEN_PATTERN.fullmatch(value.strip()) is not None


def _is_sensitive_http_field(path: str, configured: set[str]) -> bool:
    normalized = path.lower()
    name = normalized.rsplit(".", maxsplit=1)[-1]
    return (
        normalized in configured
        or name in configured
        or name in SENSITIVE_FIELD_NAMES
        or any(token in name for token in ("token", "secret"))
    )


def _is_sensitive_env_name(name: str) -> bool:
    normalized = name.lower()
    return (
        normalized in SENSITIVE_FIELD_NAMES
        or normalized.endswith("_key")
        or normalized.endswith("_token")
        or normalized.endswith("_secret")
        or normalized.endswith("_password")
        or any(token in normalized for token in ("token", "secret", "password"))
    )


def _rewrite_workflow_paths(data: dict[str, Any], rewrites: dict[str, str]) -> None:
    path_fields = {
        "prompt_path",
        "script_path",
        "template_path",
        "index_path",
        "source_path",
        "path",
        "working_dir",
        "extra_paths",
    }

    def visit(value: Any, key: str | None = None) -> Any:
        if key in path_fields and isinstance(value, str):
            return rewrites.get(value, value)
        if key == "extra_paths" and isinstance(value, list):
            return [rewrites.get(str(item), item) for item in value]
        if isinstance(value, dict):
            return {
                item_key: visit(item_value, str(item_key)) for item_key, item_value in value.items()
            }
        if isinstance(value, list):
            return [visit(item) for item in value]
        return value

    updated = visit(data)
    data.clear()
    data.update(updated)


def _resolve_workflow_with_path(
    workflow_ref: str | Path,
    data_dir: Path | None,
) -> tuple[AgenticWorkflow, Path]:
    path = Path(workflow_ref)
    if path.suffix == ".toml" or path.exists():
        if not path.exists():
            raise BundleError(f"Workflow file '{path}' not found")
        return AgenticWorkflow.from_file(path), path.resolve()
    base = _data_dir(data_dir)
    candidate = _safe_destination(base, f"{workflow_ref}.toml")
    if candidate.exists():
        return AgenticWorkflow.from_file(candidate), candidate
    for candidate in sorted(base.glob("*.toml")) if base.exists() else []:
        workflow = AgenticWorkflow.from_file(candidate)
        if workflow.config.id == str(workflow_ref):
            return workflow, candidate
    raise BundleError(f"Workflow '{workflow_ref}' not found in {base}")


def _read_workflow_toml(path: Path) -> dict[str, Any]:
    with path.open("rb") as fh:
        return tomllib.load(fh)


def _available_workflow_id(workflow_id: str, base: Path) -> str:
    validate_workflow_id(workflow_id)
    if not _safe_destination(base, f"{workflow_id}.toml").exists():
        return workflow_id
    index = 2
    while True:
        candidate = f"{workflow_id}-{index}"
        validate_workflow_id(candidate)
        if not _safe_destination(base, f"{candidate}.toml").exists():
            return candidate
        index += 1


def _validate_archive_entries(archive: zipfile.ZipFile) -> None:
    names = set(archive.namelist())
    if MANIFEST_PATH not in names:
        raise BundleError("Bundle is missing manifest.json")
    if WORKFLOW_PATH not in names:
        raise BundleError("Bundle is missing workflow.toml")
    for info in archive.infolist():
        _safe_relative_path(info.filename)


def _safe_relative_path(path: str) -> str:
    pure = PurePosixPath(path.replace("\\", "/"))
    if pure.is_absolute() or not str(pure) or any(part in {"", ".", ".."} for part in pure.parts):
        raise BundleError(f"Unsafe bundle path: {path}")
    return pure.as_posix()


def _safe_archive_join(base: str, relative: str) -> str:
    return _safe_relative_path(f"{base.rstrip('/')}/{relative}")


def _safe_destination(base: Path, relative: str, nested: str | None = None) -> Path:
    rel = _safe_relative_path(relative)
    if nested:
        rel = _safe_archive_join(rel, nested)
    destination = (base / rel).resolve()
    resolved_base = base.resolve()
    if destination != resolved_base and not destination.is_relative_to(resolved_base):
        raise BundleError(f"Unsafe destination path: {relative}")
    return destination


def _data_dir(data_dir: Path | None) -> Path:
    from gofer.utils.paths import get_data_dir

    return (data_dir or get_data_dir()).resolve()


def _gofer_version() -> str:
    try:
        return version("gofer-flow")
    except PackageNotFoundError:
        return "unknown"
