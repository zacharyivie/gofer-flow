from __future__ import annotations

from pathlib import Path

from gofer.utils.paths import get_data_dir


def workflow_stop_path(workflow_id: str, data_dir: Path | None = None) -> Path:
    base = data_dir or get_data_dir()
    safe_id = workflow_id.replace("/", "_").replace("\\", "_")
    return base / "run-state" / f"{safe_id}.stop"


def request_workflow_stop(workflow_id: str, data_dir: Path | None = None) -> Path:
    path = workflow_stop_path(workflow_id, data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("stop requested\n", encoding="utf-8")
    return path


def clear_workflow_stop(workflow_id: str, data_dir: Path | None = None) -> None:
    workflow_stop_path(workflow_id, data_dir).unlink(missing_ok=True)
