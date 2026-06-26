from __future__ import annotations

import asyncio
import base64
import html
import json
import signal
import sys
import tempfile
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from gofer.core.resources import DEFAULT_RESOURCE_LIMITS, ResourceLimits
from gofer.core.scheduler import WorkflowScheduler
from gofer.core.usage import summarize_node_outputs
from gofer.core.watcher import WorkflowWatcher
from gofer.core.workflow import AgenticWorkflow
from gofer.ui.api import (
    ProviderProfileError,
    RunnerQueueError,
    WorkflowAlreadyExistsError,
    WorkflowApprovalError,
    WorkflowBundleError,
    WorkflowCreateError,
    WorkflowHistoryError,
    WorkflowLogError,
    WorkflowPlanError,
    WorkflowRunError,
    WorkflowTriggerError,
    WorkflowUpdateError,
    apply_workflow_validation_fix_payload,
    cancel_queued_run_payload,
    create_workflow_payload,
    decide_workflow_approval_payload,
    delete_provider_profile_payload,
    delete_workflow_chat_payload,
    delete_workflow_payload,
    duplicate_workflow_payload,
    export_workflow_bundle_payload,
    health_payload,
    import_workflow_bundle_payload,
    import_workflow_payload,
    latest_workflow_log_payload,
    list_workflow_approvals_payload,
    list_workflow_history_payload,
    list_workflow_payloads,
    list_workflow_run_logs_payload,
    list_workflow_templates_payload,
    preview_workflow_bundle_payload,
    provider_profiles_payload,
    prune_workflow_run_logs_payload,
    queue_workflow_run_payload,
    rename_workflow_payload,
    replay_workflow_trigger_payload,
    restore_workflow_revision_payload,
    resume_workflow_payload,
    retention_settings_payload,
    run_workflow_payload,
    runner_queue_payload,
    stop_workflow_run_payload,
    trigger_workflow_payload,
    update_retention_settings_payload,
    update_workflow_payload,
    upsert_provider_profile_payload,
    validate_workflow_draft_payload,
    validate_workflow_payload,
    workflow_plan_payload,
    workflow_revision_diff_payload,
    workflow_run_events_payload,
    workflow_run_log_payload,
    workflow_template_payload,
)
from gofer.ui.chat import (
    ChatProviderError,
    ensure_local_gofer_cli,
    provider_payload,
    run_workflow_chat,
    stream_workflow_chat,
)
from gofer.utils.logging import get_logger
from gofer.utils.paths import get_data_dir

log = get_logger(__name__)
CONTINUOUS_RUN_POLL_SECONDS = 1.0


def _optional_query(query: dict[str, list[str]], name: str) -> str | None:
    value = query.get(name, [None])[0]
    return value if value not in {None, ""} else None


def _int_query(query: dict[str, list[str]], name: str, default: int) -> int:
    value = _optional_query(query, name)
    if value is None:
        return default
    return int(value)


def _optional_int_query(query: dict[str, list[str]], name: str) -> int | None:
    value = _optional_query(query, name)
    return int(value) if value is not None else None


def _optional_datetime_query(query: dict[str, list[str]], name: str) -> datetime | None:
    value = _optional_query(query, name)
    return datetime.fromisoformat(value) if value is not None else None


def _optional_body_int(body: dict[str, Any], name: str) -> int | None:
    value = body.get(name)
    if value in {None, ""}:
        return None
    return int(str(value))


def sync_workflow_schedules(data_dir: Path, scheduler: WorkflowScheduler) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    active_schedule_ids: set[str] = set()

    for path in sorted(data_dir.glob("*.toml")):
        try:
            workflow = AgenticWorkflow.from_file(path)
        except Exception:
            continue
        if workflow.config.run_continuously or workflow.config.schedule is None:
            continue
        try:
            scheduler.add_workflow(workflow, path)
        except Exception as exc:  # noqa: BLE001
            log.warning("Skipping invalid schedule in %s: %s", path, exc)
            continue
        active_schedule_ids.add(workflow.config.id)

    for job in scheduler.list_workflows():
        if job["id"] not in active_schedule_ids:
            scheduler.remove_workflow(job["id"])


def sync_workflow_watchers(data_dir: Path, watcher: WorkflowWatcher) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    active_watch_ids: set[str] = set()

    for path in sorted(data_dir.glob("*.toml")):
        try:
            workflow = AgenticWorkflow.from_file(path)
        except Exception:
            continue
        if workflow.config.run_continuously or workflow.config.watch is None:
            continue
        try:
            watcher.add_workflow(workflow, path)
        except Exception as exc:  # noqa: BLE001
            log.warning("Skipping invalid watcher in %s: %s", path, exc)
            continue
        active_watch_ids.add(workflow.config.id)

    for watched in watcher.list_workflows():
        if watched["id"] not in active_watch_ids:
            watcher.remove_workflow(watched["id"])


class GoferUiServer(ThreadingHTTPServer):
    def __init__(
        self,
        server_address: tuple[str, int],
        data_dir: Path,
        resource_limits: ResourceLimits | None = None,
    ) -> None:
        data_dir.mkdir(parents=True, exist_ok=True)
        super().__init__(server_address, GoferUiRequestHandler)
        self.data_dir = data_dir
        self.resource_limits = resource_limits or DEFAULT_RESOURCE_LIMITS
        self.gofer_cli_path = ensure_local_gofer_cli(data_dir)
        self.scheduler = WorkflowScheduler(db_path=data_dir / "schedules.db")
        self.watcher = WorkflowWatcher(resource_limits=self.resource_limits)
        self._continuous_runs: dict[str, threading.Thread] = {}
        self._continuous_lock = threading.Lock()
        self._continuous_stop = threading.Event()
        self._continuous_thread: threading.Thread | None = None

    def sync_schedules(self) -> None:
        sync_workflow_schedules(self.data_dir, self.scheduler)
        sync_workflow_watchers(self.data_dir, self.watcher)

    def start_continuous_monitor(self) -> None:
        if self._continuous_thread and self._continuous_thread.is_alive():
            return
        self._continuous_stop.clear()
        self._continuous_thread = threading.Thread(
            target=self._continuous_monitor_loop,
            name="gofer-continuous-workflow-monitor",
            daemon=True,
        )
        self._continuous_thread.start()

    def stop_continuous_monitor(self) -> None:
        self._continuous_stop.set()
        if self._continuous_thread:
            self._continuous_thread.join(timeout=3)

    def _continuous_monitor_loop(self) -> None:
        while not self._continuous_stop.is_set():
            try:
                self.ensure_continuous_runs()
            except Exception:  # noqa: BLE001
                log.exception("Continuous workflow monitor failed")
            self._continuous_stop.wait(CONTINUOUS_RUN_POLL_SECONDS)

    def ensure_continuous_runs(self) -> None:
        active_ids: set[str] = set()
        continuous_workflows: list[AgenticWorkflow] = []
        for path in sorted(self.data_dir.glob("*.toml")):
            try:
                workflow = AgenticWorkflow.from_file(path)
            except Exception:
                continue
            if not workflow.config.run_continuously:
                continue
            continuous_workflows.append(workflow)

        global_limit = self.resource_limits.max_watcher_concurrency

        for workflow in continuous_workflows:
            active_ids.add(workflow.config.id)
            with self._continuous_lock:
                active_count = sum(
                    1 for thread in self._continuous_runs.values() if thread.is_alive()
                )
            if active_count >= global_limit:
                log.warning(
                    "Skipping continuous workflow '%s'; global concurrency limit %s reached",
                    workflow.config.id,
                    global_limit,
                )
                continue
            self._start_continuous_run_if_needed(workflow.config.id)

        with self._continuous_lock:
            for workflow_id in list(self._continuous_runs):
                thread = self._continuous_runs[workflow_id]
                if workflow_id not in active_ids or not thread.is_alive():
                    self._continuous_runs.pop(workflow_id, None)

    def _start_continuous_run_if_needed(self, workflow_id: str) -> None:
        with self._continuous_lock:
            existing = self._continuous_runs.get(workflow_id)
            if existing and existing.is_alive():
                return

            thread = threading.Thread(
                target=self._run_continuous_workflow_once,
                args=(workflow_id,),
                name=f"gofer-continuous-{workflow_id}",
                daemon=True,
            )
            self._continuous_runs[workflow_id] = thread
            thread.start()

    def _run_continuous_workflow_once(self, workflow_id: str) -> None:
        try:
            asyncio.run(run_workflow_payload(workflow_id, self.data_dir, dry_run=False))
        except Exception as exc:  # noqa: BLE001
            log.warning("Continuous workflow '%s' run failed: %s", workflow_id, exc)
            time.sleep(CONTINUOUS_RUN_POLL_SECONDS)
        finally:
            with self._continuous_lock:
                current = self._continuous_runs.get(workflow_id)
                if current is threading.current_thread():
                    self._continuous_runs.pop(workflow_id, None)


class GoferUiRequestHandler(BaseHTTPRequestHandler):
    server_version = "GoferUi/0.1"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self._send_json(
                {
                    "ok": True,
                    "dataDir": str(self._default_data_dir()),
                }
            )
            return

        if parsed.path == "/api/doctor":
            query = parse_qs(parsed.query)
            self._send_json(health_payload(self._request_data_dir(query)))
            return

        if parsed.path.startswith("/workflows/") and parsed.path.endswith("/usage"):
            workflow_id = parsed.path.removeprefix("/workflows/").removesuffix("/usage")
            query = parse_qs(parsed.query)
            try:
                payload = workflow_usage_page_payload(
                    workflow_id,
                    self._request_data_dir(query),
                )
            except WorkflowLogError as exc:
                self._send_html(f"<p>{html.escape(str(exc))}</p>", status=404)
                return

            self._send_html(render_workflow_usage_html(payload))
            return

        if parsed.path.startswith("/workflows/") and "/logs/" in parsed.path:
            remainder = parsed.path.removeprefix("/workflows/")
            workflow_id, run_part = remainder.split("/logs/", 1)
            if not run_part.endswith("/usage"):
                self._send_json({"error": "Not found"}, status=404)
                return
            run_id = run_part.removesuffix("/usage")
            query = parse_qs(parsed.query)
            try:
                payload = workflow_run_log_payload(
                    workflow_id,
                    run_id,
                    self._request_data_dir(query),
                    offset=_optional_int_query(query, "offset"),
                    limit=_optional_int_query(query, "limit"),
                    tail_bytes=_optional_int_query(query, "tailBytes"),
                    include_details=query.get("details", ["1"])[0] != "0",
                )
            except WorkflowLogError as exc:
                self._send_html(f"<p>{html.escape(str(exc))}</p>", status=404)
                return

            self._send_html(render_usage_summary_html(payload.get("usageSummary") or {}))
            return

        if parsed.path == "/api/workflows":
            query = parse_qs(parsed.query)
            self._sync_schedules()
            payload = list_workflow_payloads(self._request_data_dir(query))
            self._send_json(payload)
            return

        if parsed.path == "/api/workflow-templates":
            self._send_json(list_workflow_templates_payload())
            return

        if parsed.path.startswith("/api/workflow-templates/"):
            template_name = parsed.path.removeprefix("/api/workflow-templates/")
            try:
                self._send_json(workflow_template_payload(template_name))
            except WorkflowCreateError as exc:
                self._send_json({"error": str(exc)}, status=404)
            return

        if parsed.path == "/api/chat/providers":
            self._send_json(provider_payload())
            return

        if parsed.path == "/api/provider/profiles":
            query = parse_qs(parsed.query)
            try:
                self._send_json(provider_profiles_payload(self._request_data_dir(query)))
            except ProviderProfileError as exc:
                self._send_json({"error": str(exc)}, status=400)
            return

        if parsed.path in {"/api/runners", "/api/queue"}:
            query = parse_qs(parsed.query)
            try:
                self._send_json(runner_queue_payload(self._request_data_dir(query)))
            except RunnerQueueError as exc:
                self._send_json({"error": str(exc)}, status=400)
            return

        if parsed.path == "/api/retention":
            query = parse_qs(parsed.query)
            try:
                self._send_json(retention_settings_payload(self._request_data_dir(query)))
            except WorkflowLogError as exc:
                self._send_json({"error": str(exc)}, status=400)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/retention"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/retention")
            query = parse_qs(parsed.query)
            try:
                self._send_json(
                    retention_settings_payload(self._request_data_dir(query), workflow_id)
                )
            except WorkflowLogError as exc:
                self._send_json({"error": str(exc)}, status=400)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/history"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/history")
            query = parse_qs(parsed.query)
            try:
                self._send_json(
                    list_workflow_history_payload(
                        workflow_id,
                        self._request_data_dir(query),
                        limit=_optional_int_query(query, "limit"),
                    )
                )
            except WorkflowHistoryError as exc:
                self._send_json({"error": str(exc)}, status=400)
            return

        if (
            parsed.path.startswith("/api/workflows/")
            and "/history/" in parsed.path
            and parsed.path.endswith("/diff")
        ):
            remainder = parsed.path.removeprefix("/api/workflows/").removesuffix("/diff")
            workflow_id, revision_id = remainder.split("/history/", 1)
            query = parse_qs(parsed.query)
            try:
                self._send_json(
                    workflow_revision_diff_payload(
                        workflow_id,
                        revision_id,
                        self._request_data_dir(query),
                    )
                )
            except WorkflowHistoryError as exc:
                self._send_json({"error": str(exc)}, status=400)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/doctor"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/doctor")
            query = parse_qs(parsed.query)
            self._send_json(health_payload(self._request_data_dir(query), workflow_id))
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/validate"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/validate")
            query = parse_qs(parsed.query)
            try:
                self._send_json(
                    validate_workflow_payload(workflow_id, self._request_data_dir(query))
                )
            except WorkflowUpdateError as exc:
                self._send_json({"error": str(exc)}, status=404)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/logs/latest"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/logs/latest")
            query = parse_qs(parsed.query)
            try:
                payload = latest_workflow_log_payload(
                    workflow_id,
                    self._request_data_dir(query),
                )
            except (WorkflowLogError, ValueError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._send_json({"log": payload})
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/events"):
            remainder = parsed.path.removeprefix("/api/workflows/").removesuffix("/events")
            if "/logs/" not in remainder:
                self._send_json({"error": "Invalid events path"}, status=404)
                return
            workflow_id, run_id = remainder.split("/logs/", 1)
            query = parse_qs(parsed.query)
            try:
                payload = workflow_run_events_payload(
                    workflow_id,
                    run_id,
                    self._request_data_dir(query),
                )
            except WorkflowLogError as exc:
                self._send_json({"error": str(exc)}, status=404)
                return

            self._send_json({"events": payload})
            return

        if parsed.path.startswith("/api/workflows/") and "/logs/" in parsed.path:
            remainder = parsed.path.removeprefix("/api/workflows/")
            workflow_id, run_id = remainder.split("/logs/", 1)
            query = parse_qs(parsed.query)
            try:
                payload = workflow_run_log_payload(
                    workflow_id,
                    run_id,
                    self._request_data_dir(query),
                    offset=_optional_int_query(query, "offset"),
                    limit=_optional_int_query(query, "limit"),
                    tail_bytes=_optional_int_query(query, "tailBytes"),
                    include_details=query.get("details", ["1"])[0] != "0",
                )
            except WorkflowLogError as exc:
                self._send_json({"error": str(exc)}, status=404)
                return

            self._send_json({"log": payload})
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/logs"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/logs")
            query = parse_qs(parsed.query)
            try:
                payload = list_workflow_run_logs_payload(
                    workflow_id,
                    self._request_data_dir(query),
                    offset=_int_query(query, "offset", 0),
                    limit=_optional_int_query(query, "limit"),
                    status=_optional_query(query, "status"),
                    trigger_type=_optional_query(query, "trigger"),
                    search=_optional_query(query, "q"),
                    started_after=_optional_datetime_query(query, "startedAfter"),
                    started_before=_optional_datetime_query(query, "startedBefore"),
                )
            except (WorkflowLogError, ValueError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._send_json(payload)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/approvals"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/approvals")
            query = parse_qs(parsed.query)
            try:
                payload = list_workflow_approvals_payload(
                    workflow_id,
                    self._request_data_dir(query),
                    include_decided=query.get("all", ["1"])[0] != "0",
                )
            except WorkflowApprovalError as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._send_json(payload)
            return

        self._send_json({"error": "Not found"}, status=404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/retention":
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                payload = update_retention_settings_payload(
                    self._request_data_dir(query),
                    settings=body,
                )
            except (WorkflowLogError, json.JSONDecodeError, ValueError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return
            self._send_json(payload)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/retention"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/retention")
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                payload = update_retention_settings_payload(
                    self._request_data_dir(query),
                    workflow_id=workflow_id,
                    settings=body,
                )
            except (WorkflowLogError, json.JSONDecodeError, ValueError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return
            self._send_json(payload)
            return

        if parsed.path == "/api/workflows/import":
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                with _bundle_path_from_body(body) as bundle_path:
                    if bundle_path:
                        plan = import_workflow_bundle_payload(
                            bundle_path,
                            self._request_data_dir(query),
                            replace=bool(body.get("replace", False)),
                            dry_run=bool(body.get("dryRun", False)),
                        )
                        self._sync_schedules()
                        self._send_json(
                            {"import": plan},
                            status=200 if body.get("dryRun") else 201,
                        )
                        return
                workflow = import_workflow_payload(
                    str(body.get("content", "")),
                    self._request_data_dir(query),
                )
            except WorkflowAlreadyExistsError as exc:
                self._send_json({"error": str(exc)}, status=409)
                return
            except (
                WorkflowBundleError,
                WorkflowCreateError,
                json.JSONDecodeError,
                ValueError,
            ) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._sync_schedules()
            self._send_json({"workflow": workflow}, status=201)
            return

        if parsed.path == "/api/workflows/import/preview":
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                with _bundle_path_from_body(body) as bundle_path:
                    payload = preview_workflow_bundle_payload(
                        bundle_path or Path(""),
                        self._request_data_dir(query),
                    )
            except (WorkflowBundleError, json.JSONDecodeError, ValueError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return
            self._send_json({"import": payload})
            return

        if parsed.path == "/api/workflows":
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                if body.get("template"):
                    workflow = create_workflow_payload(
                        str(body.get("name", "")),
                        self._request_data_dir(query),
                        template=body.get("template"),
                    )
                else:
                    workflow = create_workflow_payload(
                        str(body.get("name", "")),
                        self._request_data_dir(query),
                    )
            except WorkflowAlreadyExistsError as exc:
                self._send_json({"error": str(exc)}, status=409)
                return
            except (WorkflowCreateError, json.JSONDecodeError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._sync_schedules()
            self._send_json({"workflow": workflow}, status=201)
            return

        if parsed.path == "/api/chat/stream":
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
            except json.JSONDecodeError as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._send_stream_headers()
            asyncio.run(
                self._stream_chat_response(
                    body=body,
                    data_dir=self._request_data_dir(query),
                )
            )
            return

        if parsed.path == "/api/chat":
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                response = asyncio.run(
                    run_workflow_chat(
                        provider=str(body.get("provider", "codex")),
                        model=str(body.get("model", "cli-default")),
                        messages=body.get("messages") or [],
                        workflow=body.get("workflow"),
                        data_dir=self._request_data_dir(query),
                        resource_limits=self._resource_limits(),
                    )
                )
            except (ChatProviderError, json.JSONDecodeError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return
            except Exception as exc:  # noqa: BLE001
                log.exception("Unhandled workflow assistant error")
                self._send_json({"error": f"Workflow assistant failed: {exc}"}, status=500)
                return

            self._send_json(response)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/validate"):
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                self._send_json(
                    validate_workflow_draft_payload(
                        body,
                        self._request_data_dir(query),
                    )
                )
            except (WorkflowUpdateError, json.JSONDecodeError) as exc:
                self._send_json({"error": str(exc)}, status=400)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/validate/fix"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/validate/fix")
            query = parse_qs(parsed.query)
            try:
                payload = apply_workflow_validation_fix_payload(
                    workflow_id,
                    self._read_json(),
                    self._request_data_dir(query),
                )
            except (WorkflowUpdateError, json.JSONDecodeError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return
            self._send_json(payload)
            return

        if parsed.path == "/api/provider/profiles":
            query = parse_qs(parsed.query)
            try:
                payload = upsert_provider_profile_payload(
                    self._read_json(),
                    self._request_data_dir(query),
                )
            except (ProviderProfileError, json.JSONDecodeError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return
            self._send_json(payload)
            return

        if (
            parsed.path.startswith("/api/workflows/")
            and "/runs/" in parsed.path
            and parsed.path.endswith("/resume")
        ):
            remainder = parsed.path.removeprefix("/api/workflows/")
            workflow_id, run_id = remainder.removesuffix("/resume").split("/runs/", 1)
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                trigger_context = body.get("triggerContext")
                if trigger_context is not None and not isinstance(trigger_context, dict):
                    raise WorkflowRunError("triggerContext must be an object")
                payload = asyncio.run(
                    resume_workflow_payload(
                        workflow_id,
                        self._request_data_dir(query),
                        run_id=run_id,
                        from_node=body.get("fromNode"),
                        only_node=body.get("onlyNode"),
                        skip_cache=bool(body.get("skipCache", False)),
                        force=bool(body.get("force", False)),
                        trigger_context=trigger_context,
                    )
                )
            except (WorkflowRunError, json.JSONDecodeError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return
            self._send_json({"run": payload})
            return

        if (
            parsed.path.startswith("/api/workflows/")
            and "/runs/" in parsed.path
            and parsed.path.endswith("/stop")
        ):
            remainder = parsed.path.removeprefix("/api/workflows/")
            workflow_id, run_id = remainder.removesuffix("/stop").split("/runs/", 1)
            query = parse_qs(parsed.query)
            try:
                payload = stop_workflow_run_payload(
                    workflow_id,
                    self._request_data_dir(query),
                    run_id=run_id,
                )
            except WorkflowUpdateError as exc:
                self._send_json({"error": str(exc)}, status=400)
                return
            self._send_json(payload)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/stop"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/stop")
            query = parse_qs(parsed.query)
            try:
                payload = stop_workflow_run_payload(workflow_id, self._request_data_dir(query))
            except WorkflowUpdateError as exc:
                self._send_json({"error": str(exc)}, status=400)
                return
            self._sync_schedules()
            self._send_json(payload)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/rename"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/rename")
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                workflow = rename_workflow_payload(
                    workflow_id,
                    str(body.get("name", "")),
                    self._request_data_dir(query),
                )
            except WorkflowAlreadyExistsError as exc:
                self._send_json({"error": str(exc)}, status=409)
                return
            except (WorkflowUpdateError, json.JSONDecodeError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._sync_schedules()
            self._sync_continuous_runs()
            self._send_json({"workflow": workflow})
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/logs/prune"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/logs/prune")
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                payload = prune_workflow_run_logs_payload(
                    workflow_id,
                    self._request_data_dir(query),
                    keep_last=_optional_body_int(body, "keepLast"),
                    keep_days=_optional_body_int(body, "keepDays"),
                    keep_failed_days=_optional_body_int(body, "keepFailedDays"),
                    dry_run=bool(body.get("dryRun", True)),
                )
            except (WorkflowLogError, json.JSONDecodeError, ValueError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return
            self._send_json(payload)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/duplicate"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/duplicate")
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                workflow = duplicate_workflow_payload(
                    workflow_id,
                    body.get("name"),
                    self._request_data_dir(query),
                )
            except WorkflowAlreadyExistsError as exc:
                self._send_json({"error": str(exc)}, status=409)
                return
            except (WorkflowCreateError, WorkflowUpdateError, json.JSONDecodeError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._sync_schedules()
            self._send_json({"workflow": workflow}, status=201)
            return

        if (
            parsed.path.startswith("/api/workflows/")
            and "/history/" in parsed.path
            and parsed.path.endswith("/restore")
        ):
            remainder = parsed.path.removeprefix("/api/workflows/").removesuffix("/restore")
            workflow_id, revision_id = remainder.split("/history/", 1)
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                payload = restore_workflow_revision_payload(
                    workflow_id,
                    revision_id,
                    self._request_data_dir(query),
                    as_copy=bool(body.get("asCopy", False)),
                )
            except (WorkflowHistoryError, json.JSONDecodeError, ValueError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._sync_schedules()
            self._send_json(payload)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/export"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/export")
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                output_path = Path(str(body.get("outputPath", "")))
                payload = export_workflow_bundle_payload(
                    workflow_id,
                    output_path,
                    self._request_data_dir(query),
                    notes=body.get("notes"),
                )
            except (WorkflowBundleError, json.JSONDecodeError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return
            self._send_json(payload, status=201)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/plan"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/plan")
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                trigger_context = body.get("triggerContext")
                if trigger_context is not None and not isinstance(trigger_context, dict):
                    raise WorkflowPlanError("triggerContext must be an object")
                parameters = body.get("parameters")
                if parameters is not None and not isinstance(parameters, dict):
                    raise WorkflowPlanError("parameters must be an object")
                plan = workflow_plan_payload(
                    workflow_id,
                    self._request_data_dir(query),
                    trigger_context=trigger_context,
                    parameters=parameters,
                )
            except (WorkflowPlanError, json.JSONDecodeError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._send_json({"plan": plan})
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/queue"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/queue")
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                parameters = body.get("parameters")
                if parameters is not None and not isinstance(parameters, dict):
                    raise RunnerQueueError("parameters must be an object")
                target_labels = body.get("targetLabels")
                if target_labels is not None and not isinstance(target_labels, list):
                    raise RunnerQueueError("targetLabels must be an array")
                payload = queue_workflow_run_payload(
                    workflow_id,
                    self._request_data_dir(query),
                    priority=int(body.get("priority") or 0),
                    trigger=str(body.get("trigger") or "ui"),
                    parameters=parameters,
                    target_labels=[str(label) for label in (target_labels or [])],
                )
            except (RunnerQueueError, json.JSONDecodeError, ValueError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._send_json(payload, status=202)
            return

        if parsed.path.startswith("/api/queue/") and parsed.path.endswith("/cancel"):
            run_id = parsed.path.removeprefix("/api/queue/").removesuffix("/cancel")
            query = parse_qs(parsed.query)
            try:
                payload = cancel_queued_run_payload(run_id, self._request_data_dir(query))
            except RunnerQueueError as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._send_json(payload)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/run"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/run")
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                dry_run = bool(body.get("dryRun", False))
                trigger_context = body.get("triggerContext")
                if trigger_context is not None and not isinstance(trigger_context, dict):
                    raise WorkflowRunError("triggerContext must be an object")
                parameters = body.get("parameters")
                if parameters is not None and not isinstance(parameters, dict):
                    raise WorkflowRunError("parameters must be an object")
                if parameters is None:
                    result = asyncio.run(
                        run_workflow_payload(
                            workflow_id,
                            self._request_data_dir(query),
                            dry_run=dry_run,
                            trigger_context=trigger_context,
                        )
                    )
                else:
                    result = asyncio.run(
                        run_workflow_payload(
                            workflow_id,
                            self._request_data_dir(query),
                            dry_run=dry_run,
                            trigger_context=trigger_context,
                            parameters=parameters,
                        )
                    )
            except (WorkflowRunError, json.JSONDecodeError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._send_json({"plan" if dry_run else "run": result})
            return

        if (
            parsed.path.startswith("/api/workflows/")
            and "/webhooks/" in parsed.path
            and parsed.path.endswith("/replay")
        ):
            remainder = parsed.path.removeprefix("/api/workflows/")
            workflow_id, trigger_part = remainder.split("/webhooks/", 1)
            trigger_id = trigger_part.removesuffix("/replay")
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                run_id = str(body.get("runId") or "")
                if not run_id:
                    raise WorkflowTriggerError("runId is required")
                payload = asyncio.run(
                    replay_workflow_trigger_payload(
                        workflow_id,
                        run_id,
                        self._request_data_dir(query),
                        trigger_id=trigger_id,
                        token=self._webhook_token(),
                        require_token=True,
                    )
                )
            except (WorkflowTriggerError, json.JSONDecodeError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return
            self._send_json({"trigger": payload}, status=202)
            return

        if (
            parsed.path.startswith("/api/workflows/")
            and "/webhooks/" in parsed.path
            and parsed.path.endswith("/trigger")
        ):
            remainder = parsed.path.removeprefix("/api/workflows/")
            workflow_id, trigger_part = remainder.split("/webhooks/", 1)
            trigger_id = trigger_part.removesuffix("/trigger")
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                payload = asyncio.run(
                    trigger_workflow_payload(
                        workflow_id,
                        trigger_id,
                        self._request_data_dir(query),
                        payload=body,
                        headers={str(key): str(value) for key, value in self.headers.items()},
                        source=str(self.headers.get("X-Gofer-Webhook-Source") or "http"),
                        token=self._webhook_token(),
                    )
                )
            except (WorkflowTriggerError, json.JSONDecodeError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return
            self._send_json({"trigger": payload}, status=202)
            return

        if (
            parsed.path.startswith("/api/workflows/")
            and "/approvals/" in parsed.path
            and (parsed.path.endswith("/approve") or parsed.path.endswith("/reject"))
        ):
            remainder = parsed.path.removeprefix("/api/workflows/")
            workflow_id, approval_part = remainder.split("/approvals/", 1)
            approval_key, action = approval_part.rsplit("/", 1)
            run_id, node_id = approval_key.split("/", 1)
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                payload = decide_workflow_approval_payload(
                    workflow_id,
                    run_id,
                    node_id,
                    "approved" if action == "approve" else "rejected",
                    self._request_data_dir(query),
                    decided_by=str(body.get("by") or "ui"),
                    notes=str(body.get("notes") or ""),
                )
            except (WorkflowApprovalError, json.JSONDecodeError, ValueError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._send_json(payload)
            return

        self._send_json({"error": "Not found"}, status=404)

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/workflows/"):
            workflow_id = parsed.path.removeprefix("/api/workflows/")
            query = parse_qs(parsed.query)
            try:
                workflow = update_workflow_payload(
                    workflow_id,
                    self._read_json(),
                    self._request_data_dir(query),
                )
            except (WorkflowUpdateError, json.JSONDecodeError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._sync_schedules()
            self._send_json({"workflow": workflow})
            return

        self._send_json({"error": "Not found"}, status=404)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/chat":
            query = parse_qs(parsed.query)
            try:
                payload = delete_workflow_chat_payload(
                    "workflow-assistant",
                    self._request_data_dir(query),
                )
            except WorkflowUpdateError as exc:
                self._send_json({"error": str(exc)}, status=400)
                return
            self._send_json(payload)
            return

        if parsed.path.startswith("/api/chat/threads/"):
            thread_id = parsed.path.removeprefix("/api/chat/threads/")
            query = parse_qs(parsed.query)
            try:
                payload = delete_workflow_chat_payload(
                    f"workflow-assistant:{thread_id}",
                    self._request_data_dir(query),
                )
            except WorkflowUpdateError as exc:
                self._send_json({"error": str(exc)}, status=400)
                return
            self._send_json(payload)
            return

        if parsed.path.startswith("/api/provider/profiles/"):
            profile_name = parsed.path.removeprefix("/api/provider/profiles/")
            query = parse_qs(parsed.query)
            try:
                payload = delete_provider_profile_payload(
                    profile_name,
                    self._request_data_dir(query),
                )
            except ProviderProfileError as exc:
                self._send_json({"error": str(exc)}, status=404)
                return
            self._send_json(payload)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/chat"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/chat")
            query = parse_qs(parsed.query)
            try:
                payload = delete_workflow_chat_payload(
                    workflow_id,
                    self._request_data_dir(query),
                )
            except WorkflowUpdateError as exc:
                self._send_json({"error": str(exc)}, status=400)
                return
            self._send_json(payload)
            return

        if parsed.path.startswith("/api/workflows/"):
            workflow_id = parsed.path.removeprefix("/api/workflows/")
            query = parse_qs(parsed.query)
            try:
                payload = delete_workflow_payload(
                    workflow_id,
                    self._request_data_dir(query),
                )
            except WorkflowUpdateError as exc:
                self._send_json({"error": str(exc)}, status=404)
                return

            self._sync_schedules()
            self._send_json(payload)
            return

        self._send_json({"error": "Not found"}, status=404)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _sync_schedules(self) -> None:
        server = self.server
        if isinstance(server, GoferUiServer):
            server.sync_schedules()

    def _sync_continuous_runs(self) -> None:
        server = self.server
        if isinstance(server, GoferUiServer):
            server.ensure_continuous_runs()

    async def _stream_chat_response(self, body: dict[str, Any], data_dir: Path) -> None:
        cancel_event = threading.Event()
        try:
            async for event in stream_workflow_chat(
                provider=str(body.get("provider", "codex")),
                model=str(body.get("model", "cli-default")),
                messages=body.get("messages") or [],
                workflow=body.get("workflow"),
                cancel_event=cancel_event,
                data_dir=data_dir,
                resource_limits=self._resource_limits(),
            ):
                self._write_stream_event(event)
        except (BrokenPipeError, ConnectionResetError):
            cancel_event.set()
        except ChatProviderError as exc:
            self._write_stream_event({"type": "error", "error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            cancel_event.set()
            log.exception("Unhandled workflow assistant stream error")
            self._write_stream_event(
                {
                    "type": "error",
                    "error": f"Workflow assistant failed: {exc}",
                }
            )
        finally:
            cancel_event.set()

    def _default_data_dir(self) -> Path:
        server = self.server
        if isinstance(server, GoferUiServer):
            return server.data_dir
        return get_data_dir()

    def _resource_limits(self) -> ResourceLimits:
        server = getattr(self, "server", None)
        if isinstance(server, GoferUiServer):
            return server.resource_limits
        return DEFAULT_RESOURCE_LIMITS

    def _request_data_dir(self, _query: dict[str, list[str]]) -> Path:
        return self._default_data_dir()

    def _read_json(self) -> dict[str, Any]:
        limit = self._resource_limits().max_api_request_body_bytes
        content_length_header = self.headers.get("Content-Length")
        if content_length_header is None:
            raise json.JSONDecodeError("Content-Length is required", "", 0)
        try:
            content_length = int(content_length_header)
        except ValueError as exc:
            raise json.JSONDecodeError("Invalid Content-Length", "", 0) from exc
        if content_length < 0:
            raise json.JSONDecodeError("Invalid Content-Length", "", 0)
        if content_length > limit:
            raise json.JSONDecodeError(
                f"Request body exceeds limit {limit} bytes",
                "",
                0,
            )
        raw_body = self.rfile.read(content_length)
        if len(raw_body) != content_length:
            raise json.JSONDecodeError("Incomplete request body", "", 0)
        payload = json.loads(raw_body.decode("utf-8") or "{}")
        if not isinstance(payload, dict):
            raise WorkflowCreateError("Request body must be a JSON object")
        return payload

    def _send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _webhook_token(self) -> str | None:
        token = self.headers.get("X-Gofer-Webhook-Token")
        authorization = self.headers.get("Authorization", "")
        if token is None and authorization.startswith("Bearer "):
            token = authorization.removeprefix("Bearer ").strip()
        return token

    def _send_html(self, markup: str, status: int = 200) -> None:
        body = markup.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_stream_headers(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _write_stream_event(self, event: dict[str, Any]) -> None:
        self.wfile.write(json.dumps(event).encode("utf-8") + b"\n")
        self.wfile.flush()


def ready_payload(server: GoferUiServer) -> dict[str, Any]:
    host, port = server.server_address[:2]
    return {
        "host": host,
        "port": port,
        "dataDir": str(server.data_dir),
        "goferCliAvailable": server.gofer_cli_path is not None,
    }


def workflow_usage_page_payload(
    workflow_id: str,
    data_dir: Path,
    *,
    limit: int = 10,
) -> dict[str, Any]:
    runs_payload = list_workflow_run_logs_payload(workflow_id, data_dir)
    run_summaries: list[dict[str, Any]] = []
    totals = {
        "agent_calls": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "estimated_cost": 0.0,
        "agent_time_seconds": 0.0,
    }
    for run_log in (runs_payload.get("runs") or [])[:limit]:
        run_id = str(run_log["id"])
        try:
            payload = workflow_run_log_payload(workflow_id, run_id, data_dir)
        except WorkflowLogError:
            continue
        summary = payload.get("usageSummary")
        if not isinstance(summary, dict):
            summary = summarize_node_outputs(payload.get("nodeOutputs") or {})
        run_summaries.append(
            {
                "runId": run_id,
                "status": payload.get("status"),
                "startedAt": payload.get("startedAt"),
                "summary": summary,
            }
        )
        run_totals = summary.get("totals") if isinstance(summary, dict) else {}
        if not isinstance(run_totals, dict):
            continue
        for key in ("agent_calls", "input_tokens", "output_tokens", "total_tokens"):
            totals[key] += int(run_totals.get(key) or 0)
        totals["estimated_cost"] += float(run_totals.get("estimated_cost") or 0.0)
        totals["agent_time_seconds"] += float(run_totals.get("agent_time_seconds") or 0.0)
    return {"workflowId": workflow_id, "runs": run_summaries, "totals": totals}


def render_workflow_usage_html(payload: dict[str, Any]) -> str:
    workflow_id = html.escape(str(payload.get("workflowId") or "workflow"))
    totals_value = payload.get("totals")
    totals: dict[str, Any] = totals_value if isinstance(totals_value, dict) else {}
    rows = []
    for run in payload.get("runs") or []:
        if not isinstance(run, dict):
            continue
        summary = run.get("summary") if isinstance(run.get("summary"), dict) else {}
        run_totals = summary.get("totals") if isinstance(summary, dict) else {}
        if not isinstance(run_totals, dict):
            run_totals = {}
        rows.append(
            "<tr>"
            f"<td>{html.escape(str(run.get('runId') or ''))}</td>"
            f"<td>{html.escape(str(run.get('status') or 'unknown'))}</td>"
            f"<td>{html.escape(str(run_totals.get('agent_calls') or 0))}</td>"
            f"<td>{html.escape(str(run_totals.get('total_tokens') or 0))}</td>"
            f"<td>${float(run_totals.get('estimated_cost') or 0.0):.6f}</td>"
            f"<td>{float(run_totals.get('agent_time_seconds') or 0.0):.2f}s</td>"
            "</tr>"
        )
    table = "".join(rows) or "<tr><td colspan='6'>No usage records found.</td></tr>"
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>LLM usage for {workflow_id}</title></head><body>"
        f"<h1>LLM usage for {workflow_id}</h1>"
        f"{_usage_totals_html(totals)}"
        "<h2>Recent runs</h2><table>"
        "<thead><tr><th>Run</th><th>Status</th><th>Calls</th><th>Tokens</th>"
        "<th>Cost</th><th>Agent time</th></tr></thead>"
        f"<tbody>{table}</tbody></table></body></html>"
    )


def render_usage_summary_html(summary: dict[str, Any]) -> str:
    totals = summary.get("totals") if isinstance(summary, dict) else {}
    if not isinstance(totals, dict):
        totals = {}
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<title>LLM run usage</title></head><body>"
        "<h1>LLM run usage</h1>"
        f"{_usage_totals_html(totals)}"
        f"{_usage_nodes_html('Most expensive nodes', summary.get('most_expensive_nodes'))}"
        f"{_usage_nodes_html('Slowest nodes', summary.get('slowest_nodes'))}"
        f"{_budget_failures_html(summary.get('budget_failures'))}"
        "</body></html>"
    )


def _usage_totals_html(totals: dict[str, Any]) -> str:
    return (
        "<section><h2>Summary</h2><dl>"
        f"<dt>Agent calls</dt><dd>{html.escape(str(totals.get('agent_calls') or 0))}</dd>"
        f"<dt>Total tokens</dt><dd>{html.escape(str(totals.get('total_tokens') or 0))}</dd>"
        f"<dt>Estimated cost</dt><dd>${float(totals.get('estimated_cost') or 0.0):.6f}</dd>"
        f"<dt>Agent time</dt><dd>{float(totals.get('agent_time_seconds') or 0.0):.2f}s</dd>"
        "</dl></section>"
    )


def _usage_nodes_html(title: str, nodes: Any) -> str:
    rows = []
    for node in nodes or []:
        if not isinstance(node, dict):
            continue
        rows.append(
            "<tr>"
            f"<td>{html.escape(str(node.get('node_id') or ''))}</td>"
            f"<td>{html.escape(str(node.get('model') or node.get('provider') or ''))}</td>"
            f"<td>{html.escape(str(node.get('total_tokens') or 0))}</td>"
            f"<td>${float(node.get('estimated_cost') or 0.0):.6f}</td>"
            f"<td>{float(node.get('duration_seconds') or 0.0):.2f}s</td>"
            "</tr>"
        )
    body = "".join(rows) or "<tr><td colspan='5'>None</td></tr>"
    return (
        f"<section><h2>{html.escape(title)}</h2><table>"
        "<thead><tr><th>Node</th><th>Model</th><th>Tokens</th><th>Cost</th>"
        "<th>Duration</th></tr></thead>"
        f"<tbody>{body}</tbody></table></section>"
    )


def _budget_failures_html(nodes: Any) -> str:
    items = []
    for node in nodes or []:
        if not isinstance(node, dict):
            continue
        violations = ", ".join(str(value) for value in node.get("budget_violations") or [])
        items.append(
            f"<li>{html.escape(str(node.get('node_id') or ''))}: {html.escape(violations)}</li>"
        )
    body = "".join(items) or "<li>None</li>"
    return f"<section><h2>Budget failures</h2><ul>{body}</ul></section>"


def create_server(
    host: str = "127.0.0.1",
    port: int = 8765,
    data_dir: Path | None = None,
    resource_limits: ResourceLimits | None = None,
) -> GoferUiServer:
    return GoferUiServer(
        (host, port),
        data_dir or get_data_dir(),
        resource_limits=resource_limits,
    )


@contextmanager
def _bundle_path_from_body(body: dict[str, Any]) -> Iterator[Path | None]:
    if body.get("bundleContent"):
        with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as temp_file:
            temp_file.write(base64.b64decode(str(body["bundleContent"])))
            temp_path = Path(temp_file.name)
        try:
            yield temp_path
        finally:
            temp_path.unlink(missing_ok=True)
        return
    bundle_path = body.get("bundlePath")
    yield Path(str(bundle_path)) if bundle_path else None


def _install_shutdown_handlers(server: GoferUiServer) -> None:
    def request_shutdown(signum: int, _frame: object) -> None:
        log.info("Received signal %s; shutting down Gofer UI server", signum)
        threading.Thread(target=server.shutdown, daemon=True).start()

    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(signum, request_shutdown)
        except (OSError, ValueError):
            log.debug("Could not install handler for signal %s", signum)


def serve(host: str = "127.0.0.1", port: int = 8765, data_dir: Path | None = None) -> None:
    server = create_server(host=host, port=port, data_dir=data_dir)
    server.scheduler.start(paused=True)
    server.sync_schedules()
    server.scheduler.resume()
    server.watcher.start()
    server.start_continuous_monitor()
    _install_shutdown_handlers(server)
    print(f"GOFER_UI_READY {json.dumps(ready_payload(server), sort_keys=True)}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.stop_continuous_monitor()
        server.watcher.shutdown(wait=False)
        server.scheduler.shutdown(wait=False)
        server.server_close()
        print("GOFER_UI_STOPPED", file=sys.stderr, flush=True)


if __name__ == "__main__":
    serve()
