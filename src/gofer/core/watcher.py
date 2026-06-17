from __future__ import annotations

import asyncio
import json
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from gofer.core.executor import WorkflowExecutor
from gofer.core.workflow import AgenticWorkflow, WatchConfig
from gofer.utils.run_state import workflow_stop_path
from gofer.subscriptions.claude_code import ClaudeCodeSubscription
from gofer.subscriptions.codex import CodexSubscription
from gofer.utils.logging import get_logger

log = get_logger(__name__)

_subscriptions = {
    "claude_code": ClaudeCodeSubscription(),
    "codex": CodexSubscription(),
}

Snapshot = dict[str, tuple[int, int]]
WatchEventKind = Literal["created", "modified", "deleted"]


@dataclass(frozen=True)
class WatchEvent:
    kind: WatchEventKind
    path: str
    name: str
    directory: str
    size: int | None = None
    mtime_ns: int | None = None

    def to_context(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "path": self.path,
            "name": self.name,
            "directory": self.directory,
            "size": self.size,
            "mtime_ns": self.mtime_ns,
        }


@dataclass
class WatchedWorkflow:
    workflow_id: str
    workflow_path: Path
    config: WatchConfig
    snapshot: Snapshot = field(default_factory=dict)
    last_triggered_at: float = 0.0
    running_count: int = 0
    queued_events: list[list[WatchEvent]] = field(default_factory=list)


class WorkflowWatcher:
    def __init__(self, poll_interval_seconds: float = 1.0) -> None:
        self._poll_interval_seconds = poll_interval_seconds
        self._workflows: dict[str, WatchedWorkflow] = {}
        self._lock = threading.RLock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def add_workflow(self, workflow: AgenticWorkflow, workflow_path: Path) -> None:
        if workflow.config.watch is None:
            raise ValueError(f"Workflow '{workflow.config.id}' has no watcher configured")

        with self._lock:
            existing = self._workflows.get(workflow.config.id)
            if (
                existing is not None
                and existing.workflow_path == workflow_path
                and existing.config == workflow.config.watch
            ):
                return

        watched = WatchedWorkflow(
            workflow_id=workflow.config.id,
            workflow_path=workflow_path,
            config=workflow.config.watch,
            snapshot=self._snapshot(workflow_path, workflow.config.watch),
        )
        with self._lock:
            self._workflows[workflow.config.id] = watched
        log.info("Watching workflow '%s' path='%s'", workflow.config.id, workflow.config.watch.path)

    def remove_workflow(self, workflow_id: str) -> None:
        with self._lock:
            self._workflows.pop(workflow_id, None)

    def list_workflows(self) -> list[dict[str, str]]:
        with self._lock:
            return [
                {
                    "id": watched.workflow_id,
                    "path": str(watched.config.path),
                    "workflow_path": str(watched.workflow_path),
                }
                for watched in self._workflows.values()
            ]

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

    def shutdown(self, wait: bool = True) -> None:
        self._stop_event.set()
        if wait and self._thread is not None:
            self._thread.join(timeout=2)

    def is_running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def _run_loop(self) -> None:
        while not self._stop_event.wait(self._poll_interval_seconds):
            self.poll_once()

    def poll_once(self) -> None:
        with self._lock:
            watched_items = list(self._workflows.values())

        for watched in watched_items:
            try:
                next_snapshot = self._snapshot(watched.workflow_path, watched.config)
            except Exception as exc:  # noqa: BLE001
                log.warning("Could not scan watcher for '%s': %s", watched.workflow_id, exc)
                continue

            if next_snapshot == watched.snapshot:
                self._start_queued_runs(watched)
                continue

            events = self._diff_events(watched.snapshot, next_snapshot)
            now = time.monotonic()
            watched.snapshot = next_snapshot
            if now - watched.last_triggered_at < watched.config.debounce_seconds:
                self._enqueue_events(watched, events)
                continue
            watched.last_triggered_at = now
            self._trigger(watched, events)

    def _trigger(self, watched: WatchedWorkflow, events: list[WatchEvent]) -> None:
        self._enqueue_events(watched, events)
        self._start_queued_runs(watched)

    def _enqueue_events(self, watched: WatchedWorkflow, events: list[WatchEvent]) -> None:
        if not events:
            return
        with self._lock:
            if watched.config.mode == "queue":
                watched.queued_events.extend([[event] for event in events])
            else:
                watched.queued_events.append(events)

    def _start_queued_runs(self, watched: WatchedWorkflow) -> None:
        threads: list[threading.Thread] = []
        with self._lock:
            max_concurrency = max(1, watched.config.max_concurrency)
            while watched.queued_events and watched.running_count < max_concurrency:
                events = watched.queued_events.pop(0)
                watched.running_count += 1
                thread = threading.Thread(
                    target=self._run_workflow,
                    args=(watched, events),
                    daemon=True,
                )
                threads.append(thread)

        for thread in threads:
            thread.start()

    def _run_workflow(self, watched: WatchedWorkflow, events: list[WatchEvent]) -> None:
        try:
            workflow = AgenticWorkflow.from_file(watched.workflow_path)
            trigger_context = {
                "type": "file_watch",
                "mode": watched.config.mode,
                "watch_path": str(watched.config.path),
                "glob": watched.config.glob,
                "events": [event.to_context() for event in events],
                "events_json": json.dumps([event.to_context() for event in events]),
            }
            if len(events) == 1:
                event_context = events[0].to_context()
                trigger_context["event"] = event_context
                trigger_context["event_json"] = json.dumps(event_context)

            async def execute() -> None:
                result = await WorkflowExecutor(
                    workflow,
                    _subscriptions,
                    log_base_dir=watched.workflow_path.parent / "logs",
                    stop_file=workflow_stop_path(
                        watched.workflow_id,
                        watched.workflow_path.parent,
                    ),
                ).with_trigger_context(trigger_context).run()
                log.info("Watched workflow %s finished: success=%s", watched.workflow_id, result.success)

            asyncio.run(execute())
        except Exception as exc:  # noqa: BLE001
            log.exception("Watched workflow '%s' failed: %s", watched.workflow_id, exc)
        finally:
            with self._lock:
                current = self._workflows.get(watched.workflow_id)
                if current is watched:
                    current.running_count = max(0, current.running_count - 1)
                    should_start_more = bool(current.queued_events)
                else:
                    should_start_more = False
            if should_start_more:
                self._start_queued_runs(watched)

    def _snapshot(self, workflow_path: Path, config: WatchConfig) -> Snapshot:
        return {
            str(path): (stat.st_mtime_ns, stat.st_size)
            for path in self._watched_paths(workflow_path, config)
            if path.exists() and path.is_file()
            for stat in [path.stat()]
        }

    def _watched_paths(self, workflow_path: Path, config: WatchConfig) -> list[Path]:
        target = config.path if config.path.is_absolute() else workflow_path.parent / config.path
        if target.is_dir():
            iterator = target.rglob(config.glob) if config.recursive else target.glob(config.glob)
            return sorted(path for path in iterator if path.is_file())
        return [target]

    def _diff_events(self, previous: Snapshot, current: Snapshot) -> list[WatchEvent]:
        events: list[WatchEvent] = []
        for path_str in sorted(current.keys() - previous.keys()):
            mtime_ns, size = current[path_str]
            events.append(self._event("created", path_str, size=size, mtime_ns=mtime_ns))
        for path_str in sorted(previous.keys() - current.keys()):
            events.append(self._event("deleted", path_str))
        for path_str in sorted(current.keys() & previous.keys()):
            if current[path_str] != previous[path_str]:
                mtime_ns, size = current[path_str]
                events.append(self._event("modified", path_str, size=size, mtime_ns=mtime_ns))
        return events

    def _event(
        self,
        kind: WatchEventKind,
        path_str: str,
        *,
        size: int | None = None,
        mtime_ns: int | None = None,
    ) -> WatchEvent:
        path = Path(path_str)
        return WatchEvent(
            kind=kind,
            path=path_str,
            name=path.name,
            directory=str(path.parent),
            size=size,
            mtime_ns=mtime_ns,
        )
