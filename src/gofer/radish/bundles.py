"""Portable bundles for registered Radish workflow workspaces."""

from __future__ import annotations

import fnmatch
import json
import shutil
import stat
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from gofer.core.resources import DEFAULT_RESOURCE_LIMITS, ResourceLimits
from gofer.radish.workspaces import (
    WORKFLOW_ENTRYPOINT,
    WORKFLOW_IGNORE,
    RegisteredWorkflow,
    find_registered_workflow,
    install_registered_workflow,
)

BUNDLE_EXTENSION = ".taskurotta"
BUNDLE_MANIFEST = "taskurotta.bundle.json"
BUNDLE_VERSION = 1


class RadishBundleError(ValueError):
    """Raised when a Radish workflow bundle cannot be exported or imported."""


@dataclass(frozen=True, slots=True)
class RadishBundlePreview:
    workflow_id: str
    workflow_name: str
    files: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "workflowId": self.workflow_id,
            "workflowName": self.workflow_name,
            "files": list(self.files),
        }


def export_radish_bundle(
    workflow_id: str,
    output_path: Path,
    *,
    registry_dir: Path,
) -> RadishBundlePreview:
    workflow = find_registered_workflow(workflow_id, registry_dir=registry_dir)
    output_path = output_path.expanduser().resolve()
    if output_path.suffix.lower() != BUNDLE_EXTENSION:
        output_path = output_path.with_name(f"{output_path.name}{BUNDLE_EXTENSION}")
    if output_path == workflow.workflow_root or workflow.workflow_root in output_path.parents:
        raise RadishBundleError("Export the bundle outside the workflow folder")

    patterns = _read_ignore_patterns(workflow.workflow_root / WORKFLOW_IGNORE)
    files: list[tuple[Path, str]] = []
    for path in sorted(workflow.workflow_root.rglob("*")):
        relative = path.relative_to(workflow.workflow_root).as_posix()
        if _is_ignored(relative, path.is_dir(), patterns):
            continue
        if path.is_symlink():
            raise RadishBundleError(f"Workflow bundle cannot include symbolic link: {relative}")
        if path.is_file():
            files.append((path, relative))
    included = {relative for _, relative in files}
    if WORKFLOW_ENTRYPOINT not in included:
        raise RadishBundleError(f"{WORKFLOW_IGNORE} excludes required {WORKFLOW_ENTRYPOINT}")
    if BUNDLE_MANIFEST in included:
        raise RadishBundleError(f"Workflow contains reserved bundle file {BUNDLE_MANIFEST}")

    preview = RadishBundlePreview(workflow.workflow_id, workflow.name, tuple(sorted(included)))
    manifest = {
        "format": "taskurotta-workflow",
        "version": BUNDLE_VERSION,
        "workflowId": workflow.workflow_id,
        "workflowName": workflow.name,
        "files": list(preview.files),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(f".{output_path.name}.tmp")
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(BUNDLE_MANIFEST, json.dumps(manifest, indent=2) + "\n")
            for source, relative in files:
                archive.write(source, relative)
        temporary.replace(output_path)
    except (OSError, zipfile.BadZipFile) as exc:
        temporary.unlink(missing_ok=True)
        raise RadishBundleError(f"Could not export workflow bundle: {exc}") from exc
    return preview


def preview_radish_bundle(
    bundle_path: Path,
    *,
    limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS,
) -> RadishBundlePreview:
    with _open_validated_bundle(bundle_path, limits) as archive:
        manifest = _read_manifest(archive, limits)
        names = tuple(sorted(name for name in archive.namelist() if name != BUNDLE_MANIFEST))
        declared = tuple(sorted(manifest["files"]))
        if names != declared:
            raise RadishBundleError("Bundle file list does not match its manifest")
        if WORKFLOW_ENTRYPOINT not in names:
            raise RadishBundleError(f"Bundle is missing required {WORKFLOW_ENTRYPOINT}")
        return RadishBundlePreview(manifest["workflowId"], manifest["workflowName"], names)


def import_radish_bundle(
    bundle_path: Path,
    project_root: Path,
    *,
    registry_dir: Path,
    limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS,
) -> RegisteredWorkflow:
    preview = preview_radish_bundle(bundle_path, limits=limits)
    staging_parent = Path(tempfile.mkdtemp(prefix="taskurotta-import-"))
    staged_root = staging_parent / "workflow"
    staged_root.mkdir()
    try:
        with _open_validated_bundle(bundle_path, limits) as archive:
            for name in preview.files:
                destination = staged_root / PurePosixPath(name)
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(name) as source, destination.open("wb") as target:
                    shutil.copyfileobj(source, target)
        return install_registered_workflow(
            project_root,
            staged_root,
            preview.workflow_name,
            preview.workflow_id,
            registry_dir=registry_dir,
        )
    except (OSError, zipfile.BadZipFile) as exc:
        raise RadishBundleError(f"Could not import workflow bundle: {exc}") from exc
    finally:
        shutil.rmtree(staging_parent, ignore_errors=True)


def _read_ignore_patterns(path: Path) -> tuple[tuple[str, bool], ...]:
    if not path.is_file():
        return ()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise RadishBundleError(f"Could not read {path}: {exc}") from exc
    patterns: list[tuple[str, bool]] = []
    for raw in lines:
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        negated = line.startswith("!")
        pattern = line[1:] if negated else line
        if pattern:
            patterns.append((pattern.replace("\\", "/"), negated))
    return tuple(patterns)


def _is_ignored(relative: str, is_directory: bool, patterns: tuple[tuple[str, bool], ...]) -> bool:
    ignored = False
    for pattern, negated in patterns:
        directory_pattern = pattern.endswith("/")
        normalized = pattern.lstrip("/").rstrip("/")
        if not normalized:
            continue
        path_parts = PurePosixPath(relative).parts
        pattern_parts = PurePosixPath(normalized).parts
        if "/" in normalized:
            path_candidates = [path_parts]
            if directory_pattern:
                path_candidates = [path_parts[:index] for index in range(1, len(path_parts) + 1)]
                if not is_directory:
                    path_candidates = path_candidates[:-1]
            matched = any(
                _match_path_parts(candidate, pattern_parts) for candidate in path_candidates
            )
        else:
            segment_candidates = (
                path_parts if is_directory or not directory_pattern else path_parts[:-1]
            )
            matched = any(fnmatch.fnmatchcase(part, normalized) for part in segment_candidates)
        if matched:
            ignored = not negated
    return ignored


def _match_path_parts(path: tuple[str, ...], pattern: tuple[str, ...]) -> bool:
    if not pattern:
        return not path
    if pattern[0] == "**":
        return _match_path_parts(path, pattern[1:]) or bool(
            path and _match_path_parts(path[1:], pattern)
        )
    return bool(
        path
        and fnmatch.fnmatchcase(path[0], pattern[0])
        and _match_path_parts(path[1:], pattern[1:])
    )


def _open_validated_bundle(
    bundle_path: Path,
    limits: ResourceLimits,
) -> zipfile.ZipFile:
    path = bundle_path.expanduser().resolve()
    try:
        if path.stat().st_size > limits.max_bundle_compressed_bytes:
            raise RadishBundleError("Workflow bundle exceeds the compressed size limit")
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise RadishBundleError(f"Invalid .taskurotta bundle: {exc}") from exc
    infos = archive.infolist()
    try:
        if len(infos) > limits.max_bundle_entries:
            raise RadishBundleError("Workflow bundle contains too many files")
        names: set[str] = set()
        total = 0
        for info in infos:
            name = info.filename
            safe = PurePosixPath(name)
            if (
                not name
                or name.endswith("/")
                or safe.is_absolute()
                or ".." in safe.parts
                or "\\" in name
                or name in names
            ):
                raise RadishBundleError(f"Unsafe workflow bundle path: {name}")
            if stat.S_ISLNK(info.external_attr >> 16):
                raise RadishBundleError(f"Workflow bundle contains symbolic link: {name}")
            if info.file_size > limits.max_bundle_entry_bytes:
                raise RadishBundleError(f"Workflow bundle file exceeds size limit: {name}")
            total += info.file_size
            if total > limits.max_bundle_total_uncompressed_bytes:
                raise RadishBundleError("Workflow bundle exceeds the expanded size limit")
            if (
                info.compress_size
                and info.file_size / info.compress_size > limits.max_bundle_compression_ratio
            ):
                raise RadishBundleError(f"Workflow bundle compression ratio is unsafe: {name}")
            names.add(name)
        return archive
    except Exception:
        archive.close()
        raise


def _read_manifest(archive: zipfile.ZipFile, limits: ResourceLimits) -> dict[str, Any]:
    try:
        info = archive.getinfo(BUNDLE_MANIFEST)
        if info.file_size > limits.max_bundle_metadata_bytes:
            raise RadishBundleError("Workflow bundle manifest exceeds the size limit")
        manifest = json.loads(archive.read(info).decode("utf-8"))
    except (KeyError, UnicodeError, json.JSONDecodeError) as exc:
        raise RadishBundleError("Workflow bundle has no valid manifest") from exc
    if (
        not isinstance(manifest, dict)
        or manifest.get("format") != "taskurotta-workflow"
        or manifest.get("version") != BUNDLE_VERSION
        or not isinstance(manifest.get("workflowId"), str)
        or not isinstance(manifest.get("workflowName"), str)
        or not isinstance(manifest.get("files"), list)
        or not all(isinstance(item, str) for item in manifest["files"])
    ):
        raise RadishBundleError("Workflow bundle manifest is invalid or unsupported")
    return manifest
