from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest

from gofer.core import watcher as watcher_module
from gofer.core.agent import AgentConfig
from gofer.core.resources import DEFAULT_RESOURCE_LIMITS, ResourceLimitError, ResourceLimits
from gofer.core.watcher import WatchedWorkflow, WatchEvent, WorkflowWatcher
from gofer.core.workflow import AgenticWorkflow, WatchConfig, WorkflowConfig
from tests.conftest import FakeSubscription


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


def test_workflow_watcher_updates_registration_when_resource_limits_change(
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

    watcher = WorkflowWatcher(poll_interval_seconds=0.01)
    watcher.add_workflow(workflow, workflow_path)
    watched_before = watcher._workflows["watcher"]

    updated = AgenticWorkflow(
        WorkflowConfig(
            id="watcher",
            name="Watcher",
            watch=WatchConfig(path=watch_dir, glob="*.txt"),
            resource_limits=ResourceLimits(max_watcher_queue_depth=2),
        )
    )
    updated.to_file(workflow_path)
    watcher.add_workflow(updated, workflow_path)

    watched_after = watcher._workflows["watcher"]
    assert watched_after is not watched_before
    assert watched_after.resource_limits.max_watcher_queue_depth == 2


def test_watched_execution_logs_external_agent_access(
    caplog: pytest.LogCaptureFixture, tmp_path: Path
) -> None:
    watch_dir = tmp_path / "inputs"
    work_dir = tmp_path / "work"
    extra_dir = tmp_path / "shared"
    watch_dir.mkdir()
    work_dir.mkdir()
    extra_dir.mkdir()
    workflow_path = tmp_path / "watcher.toml"
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="watcher",
            name="Watcher",
            watch=WatchConfig(path=watch_dir),
        )
    )
    workflow.register_agent(
        AgentConfig(
            agent_id="reviewer",
            subscription="codex",
            working_dir=work_dir,
            extra_paths=[extra_dir],
        )
    )
    workflow.to_file(workflow_path)
    assert workflow.config.watch is not None
    watcher = WorkflowWatcher(poll_interval_seconds=0.01)
    watched = WatchedWorkflow(
        workflow_id="watcher",
        workflow_path=workflow_path,
        config=workflow.config.watch,
    )
    event = WatchEvent(
        kind="created",
        path=str(watch_dir / "input.txt"),
        name="input.txt",
        directory=str(watch_dir),
    )

    watcher._run_workflow(watched, [event])

    assert "grants provider filesystem access outside working_dir" in caplog.text
    assert str(extra_dir) in caplog.text


def test_watched_execution_persists_usage_sidecar(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    watch_dir = tmp_path / "inputs"
    watch_dir.mkdir()
    prompt_path = tmp_path / "prompt.md"
    prompt_path.write_text("Review {{event.name}}", encoding="utf-8")
    workflow_path = tmp_path / "watcher.toml"
    workflow_path.write_text(
        f"""
[workflow]
id = "watched-usage"
name = "Watched Usage"

[workflow.watch]
path = "{watch_dir}"

[[nodes]]
id = "ask"
type = "agent"
agent_id = "assistant"
working_dir = "."
prompt_path = "{prompt_path}"

[agents.assistant]
subscription = "codex"
working_dir = "."
""".lstrip(),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        watcher_module,
        "_subscriptions",
        {"codex": FakeSubscription(output="done")},
    )
    watcher = WorkflowWatcher(poll_interval_seconds=0.01)
    watched = WatchedWorkflow(
        workflow_id="watched-usage",
        workflow_path=workflow_path,
        config=WatchConfig(path=watch_dir),
    )
    event = WatchEvent(
        kind="created",
        path=str(watch_dir / "input.txt"),
        name="input.txt",
        directory=str(watch_dir),
    )

    watcher._run_workflow(watched, [event])

    sidecars = list((tmp_path / "logs" / "watched-usage").glob("*.outputs.json"))
    assert len(sidecars) == 1
    payload = json.loads(sidecars[0].read_text(encoding="utf-8"))
    assert payload["usageSummary"]["totals"]["agent_calls"] == 1
    assert payload["nodeOutputs"]["ask"]["data"]["prompt"] == "***"


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


def test_workflow_watcher_queue_overflow_drops_oldest_batches(tmp_path: Path) -> None:
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
    watcher = WorkflowWatcher(poll_interval_seconds=0.01)
    watcher.add_workflow(workflow, workflow_path)
    watched = watcher._workflows["watcher"]
    events = [
        WatchEvent(
            kind="modified",
            path=str(watch_dir / f"{index}.txt"),
            name=f"{index}.txt",
            directory=str(watch_dir),
        )
        for index in range(DEFAULT_RESOURCE_LIMITS.max_watcher_queue_depth + 2)
    ]

    watcher._enqueue_events(watched, events)

    assert len(watched.queued_events) == DEFAULT_RESOURCE_LIMITS.max_watcher_queue_depth
    assert watched.dropped_event_batches == 2
    assert watched.queued_events[0][0].name == "2.txt"


def test_workflow_watcher_uses_workflow_queue_limit_override(tmp_path: Path) -> None:
    watch_dir = tmp_path / "inputs"
    watch_dir.mkdir()
    workflow_path = tmp_path / "watcher.toml"
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="watcher",
            name="Watcher",
            watch=WatchConfig(path=watch_dir, glob="*.txt", mode="queue"),
            resource_limits=ResourceLimits(max_watcher_queue_depth=2),
        )
    )
    workflow.to_file(workflow_path)
    watcher = WorkflowWatcher(poll_interval_seconds=0.01)
    watcher.add_workflow(workflow, workflow_path)
    watched = watcher._workflows["watcher"]
    events = [
        WatchEvent(
            kind="modified",
            path=str(watch_dir / f"{index}.txt"),
            name=f"{index}.txt",
            directory=str(watch_dir),
        )
        for index in range(4)
    ]

    watcher._enqueue_events(watched, events)

    assert len(watched.queued_events) == 2
    assert watched.dropped_event_batches == 2
    assert [batch[0].name for batch in watched.queued_events] == ["2.txt", "3.txt"]


def test_workflow_watcher_scan_stops_at_file_limit(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watch_dir = tmp_path / "inputs"
    watch_dir.mkdir()
    files = []
    for index in range(5):
        path = watch_dir / f"{index}.txt"
        path.write_text("x")
        files.append(path)
    workflow_path = tmp_path / "watcher.toml"
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="watcher",
            name="Watcher",
            watch=WatchConfig(path=watch_dir, glob="*.txt", recursive=False),
            resource_limits=ResourceLimits(max_files_scanned=2),
        )
    )
    workflow.to_file(workflow_path)
    original_glob = Path.glob

    def bounded_glob(path: Path, pattern: str):
        if path != watch_dir or pattern != "*.txt":
            yield from original_glob(path, pattern)
            return
        for item_index, file_path in enumerate(files):
            if item_index > 2:
                raise AssertionError("watcher consumed past the scan limit")
            yield file_path

    monkeypatch.setattr(Path, "glob", bounded_glob)

    watcher = WorkflowWatcher(poll_interval_seconds=0.01)
    with pytest.raises(ResourceLimitError, match="watcher scan exceeded limit 2 files"):
        watcher.add_workflow(workflow, workflow_path)


def test_workflow_watcher_diff_caps_event_count(tmp_path: Path) -> None:
    watcher = WorkflowWatcher(poll_interval_seconds=0.01)
    current = {
        str(tmp_path / f"{index}.txt"): (index, index)
        for index in range(5)
    }
    dropped: list[int] = []

    events = watcher._diff_events(  # noqa: SLF001
        {},
        current,
        ResourceLimits(max_watcher_queue_depth=2),
        on_drop=dropped.append,
    )

    assert len(events) == 2
    assert [event.name for event in events] == ["3.txt", "4.txt"]
    assert dropped == [3]


def test_workflow_watcher_diff_reports_all_drops_when_queue_limit_is_zero(
    tmp_path: Path,
) -> None:
    watcher = WorkflowWatcher(poll_interval_seconds=0.01)
    current = {
        str(tmp_path / f"{index}.txt"): (index, index)
        for index in range(3)
    }
    dropped: list[int] = []

    events = watcher._diff_events(  # noqa: SLF001
        {},
        current,
        ResourceLimits(max_watcher_queue_depth=0),
        on_drop=dropped.append,
    )

    assert events == []
    assert dropped == [3]


def test_workflow_watcher_concurrency_is_global_across_workflows(tmp_path: Path) -> None:
    watcher = WorkflowWatcher(poll_interval_seconds=0.01)
    release = threading.Event()
    started: list[str] = []

    def blocking_run(watched, events):  # noqa: ANN001, ARG001
        started.append(watched.workflow_id)
        release.wait(timeout=1)

    watcher._run_workflow = blocking_run  # type: ignore[method-assign]
    workflows = []
    for index in range(2):
        watch_dir = tmp_path / f"inputs-{index}"
        watch_dir.mkdir()
        workflow_path = tmp_path / f"watcher-{index}.toml"
        workflow = AgenticWorkflow(
            WorkflowConfig(
                id=f"watcher-{index}",
                name=f"Watcher {index}",
                watch=WatchConfig(
                    path=watch_dir,
                    glob="*.txt",
                    mode="queue",
                    max_concurrency=DEFAULT_RESOURCE_LIMITS.max_watcher_concurrency,
                ),
            )
        )
        workflow.to_file(workflow_path)
        watcher.add_workflow(workflow, workflow_path)
        workflows.append(watcher._workflows[workflow.config.id])

    watcher._global_running_count = DEFAULT_RESOURCE_LIMITS.max_watcher_concurrency - 1
    event = WatchEvent(
        kind="modified",
        path="input.txt",
        name="input.txt",
        directory="",
    )
    workflows[0].queued_events.append([event])
    workflows[1].queued_events.append([event])

    watcher._start_queued_runs(workflows[0])
    deadline = time.monotonic() + 1
    while not started and time.monotonic() < deadline:
        time.sleep(0.01)
    watcher._start_queued_runs(workflows[1])

    assert started == ["watcher-0"]
    assert workflows[0].running_count == 1
    assert workflows[1].running_count == 0
    assert len(workflows[1].queued_events) == 1
    release.set()


def test_workflow_watcher_global_concurrency_ignores_workflow_raise(
    tmp_path: Path,
) -> None:
    watcher = WorkflowWatcher(
        poll_interval_seconds=0.01,
        resource_limits=ResourceLimits(max_watcher_concurrency=1),
    )
    release = threading.Event()
    started: list[str] = []

    def blocking_run(watched, events):  # noqa: ANN001, ARG001
        started.append(watched.workflow_id)
        release.wait(timeout=1)

    watcher._run_workflow = blocking_run  # type: ignore[method-assign]
    workflows = []
    for index in range(2):
        watch_dir = tmp_path / f"raised-inputs-{index}"
        watch_dir.mkdir()
        workflow_path = tmp_path / f"raised-watcher-{index}.toml"
        workflow = AgenticWorkflow(
            WorkflowConfig(
                id=f"raised-watcher-{index}",
                name=f"Raised Watcher {index}",
                watch=WatchConfig(
                    path=watch_dir,
                    glob="*.txt",
                    mode="queue",
                    max_concurrency=10,
                ),
                resource_limits=ResourceLimits(max_watcher_concurrency=10),
            )
        )
        workflow.to_file(workflow_path)
        watcher.add_workflow(workflow, workflow_path)
        workflows.append(watcher._workflows[workflow.config.id])

    event = WatchEvent(
        kind="modified",
        path="input.txt",
        name="input.txt",
        directory="",
    )
    workflows[0].queued_events.append([event])
    workflows[1].queued_events.append([event])

    watcher._start_queued_runs(workflows[0])
    deadline = time.monotonic() + 1
    while not started and time.monotonic() < deadline:
        time.sleep(0.01)
    watcher._start_queued_runs(workflows[1])

    assert started == ["raised-watcher-0"]
    assert workflows[0].running_count == 1
    assert workflows[1].running_count == 0
    assert len(workflows[1].queued_events) == 1
    release.set()
