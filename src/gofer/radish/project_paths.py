"""Project-root path policy shared by Radish preflight and runtime handlers."""

from __future__ import annotations

from pathlib import Path, PureWindowsPath


def normalize_project_path(authored: str) -> str:
    """Return the portable IR spelling for one project-relative path."""
    if not authored or authored.startswith("~"):
        raise ValueError("Radish paths must be nonempty project-relative paths.")
    if "\\" in authored:
        raise ValueError("Radish paths use forward slashes, including on Windows.")
    candidate = Path(authored)
    if candidate.is_absolute() or PureWindowsPath(authored).is_absolute():
        raise ValueError(f"Radish path must be project-relative: {authored!r}")
    if ".." in candidate.parts:
        raise ValueError(f"Radish path cannot traverse above the project root: {authored!r}")
    normalized_parts = [part for part in candidate.parts if part not in {"", "."}]
    return "/".join(normalized_parts) if normalized_parts else "."


def project_path(project_root: Path, authored: str) -> Path:
    """Resolve a relative authored path without following its final path component."""
    candidate = Path(normalize_project_path(authored))

    root = project_root.resolve()
    parent = (root / candidate.parent).resolve()
    if not parent.is_relative_to(root):
        raise ValueError(f"Radish path escapes the project root through a symlink: {authored!r}")
    return parent / candidate.name


def path_kind(path: Path) -> str:
    if path.is_symlink():
        return "symlink"
    if path.is_dir():
        return "directory"
    if path.is_file():
        return "file"
    return "missing"
