from __future__ import annotations

import time
from pathlib import Path

from gofer.core.watcher import WorkflowWatcher
from gofer.core.workflow import AgenticWorkflow, WatchConfig, WorkflowConfig


def test_workflow_watcher_triggers_when_watched_file_changes(tmp_path: Path) -> None:
    watched_file = tmp_path / "input.txt"
    watched_file.write_text("old")
    workflow_path = tmp_path / "watcher.toml"
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="watcher",
            name="Watcher",
            watch=WatchConfig(path=watched_file),
        )
    )
    workflow.to_file(workflow_path)
    triggered = []

    watcher = WorkflowWatcher(poll_interval_seconds=0.01)
    watcher.add_workflow(workflow, workflow_path)
    watcher._trigger = lambda watched, events: triggered.append((watched.workflow_id, events))  # type: ignore[method-assign]

    watched_file.write_text("new")
    watcher.poll_once()

    assert len(triggered) == 1
    assert triggered[0][0] == "watcher"
    assert triggered[0][1][0].kind == "modified"
    assert triggered[0][1][0].path == str(watched_file)


def test_workflow_watcher_detects_directory_glob_changes(tmp_path: Path) -> None:
    watch_dir = tmp_path / "inputs"
    watch_dir.mkdir()
    workflow_path = tmp_path / "watcher.toml"
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="watcher",
            name="Watcher",
            watch=WatchConfig(path=watch_dir, glob="*.txt"),
        )
    )
    workflow.to_file(workflow_path)
    triggered = []

    watcher = WorkflowWatcher(poll_interval_seconds=0.01)
    watcher.add_workflow(workflow, workflow_path)
    watcher._trigger = lambda watched, events: triggered.append((watched.workflow_id, events))  # type: ignore[method-assign]

    (watch_dir / "input.txt").write_text("new")
    watcher.poll_once()

    assert len(triggered) == 1
    assert triggered[0][0] == "watcher"
    assert triggered[0][1][0].kind == "created"
    assert triggered[0][1][0].path == str(watch_dir / "input.txt")


def test_workflow_watcher_resync_preserves_snapshot_when_config_unchanged(
    tmp_path: Path,
) -> None:
    watch_dir = tmp_path / "inputs"
    watch_dir.mkdir()
    workflow_path = tmp_path / "watcher.toml"
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="watcher",
            name="Watcher",
            watch=WatchConfig(path=watch_dir, glob="*.txt"),
        )
    )
    workflow.to_file(workflow_path)
    triggered = []

    watcher = WorkflowWatcher(poll_interval_seconds=0.01)
    watcher.add_workflow(workflow, workflow_path)
    watched_before = watcher._workflows["watcher"]
    watcher.add_workflow(workflow, workflow_path)
    watcher._trigger = lambda watched, events: triggered.append((watched.workflow_id, events))  # type: ignore[method-assign]

    (watch_dir / "input.txt").write_text("new")
    watcher.poll_once()

    assert watcher._workflows["watcher"] is watched_before
    assert len(triggered) == 1


def test_workflow_watcher_batches_multiple_files_added_at_once(tmp_path: Path) -> None:
    watch_dir = tmp_path / "inputs"
    watch_dir.mkdir()
    workflow_path = tmp_path / "watcher.toml"
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="watcher",
            name="Watcher",
            watch=WatchConfig(path=watch_dir, glob="*.txt", mode="batch"),
        )
    )
    workflow.to_file(workflow_path)
    triggered = []

    watcher = WorkflowWatcher(poll_interval_seconds=0.01)
    watcher.add_workflow(workflow, workflow_path)
    watcher._trigger = lambda watched, events: triggered.append(events)  # type: ignore[method-assign]

    (watch_dir / "a.txt").write_text("a")
    (watch_dir / "b.txt").write_text("b")
    watcher.poll_once()

    assert len(triggered) == 1
    assert [event.name for event in triggered[0]] == ["a.txt", "b.txt"]
    assert all(event.kind == "created" for event in triggered[0])


def test_workflow_watcher_queue_mode_enqueues_one_run_per_event(tmp_path: Path) -> None:
    watch_dir = tmp_path / "inputs"
    watch_dir.mkdir()
    workflow_path = tmp_path / "watcher.toml"
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="watcher",
            name="Watcher",
            watch=WatchConfig(path=watch_dir, glob="*.txt", mode="queue"),
        )
    )
    workflow.to_file(workflow_path)
    runs = []

    watcher = WorkflowWatcher(poll_interval_seconds=0.01)
    watcher.add_workflow(workflow, workflow_path)

    def record_run(watched, events):  # noqa: ANN001
        runs.append([event.name for event in events])
        watched.running_count = max(0, watched.running_count - 1)
        watcher._start_queued_runs(watched)

    watcher._run_workflow = record_run  # type: ignore[method-assign]
    (watch_dir / "a.txt").write_text("a")
    (watch_dir / "b.txt").write_text("b")
    watcher.poll_once()

    deadline = time.monotonic() + 1
    while len(runs) < 2 and time.monotonic() < deadline:
        time.sleep(0.01)

    assert runs == [["a.txt"], ["b.txt"]]
