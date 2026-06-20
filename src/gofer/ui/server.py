from __future__ import annotations

import asyncio
import json
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from gofer.core.scheduler import WorkflowScheduler
from gofer.core.watcher import WorkflowWatcher
from gofer.core.workflow import AgenticWorkflow
from gofer.ui.api import (
    WorkflowAlreadyExistsError,
    WorkflowCreateError,
    WorkflowLogError,
    WorkflowRunError,
    WorkflowUpdateError,
    create_workflow_payload,
    delete_workflow_payload,
    delete_workflow_chat_payload,
    duplicate_workflow_payload,
    import_workflow_payload,
    latest_workflow_log_payload,
    list_workflow_payloads,
    list_workflow_run_logs_payload,
    rename_workflow_payload,
    run_workflow_payload,
    stop_workflow_run_payload,
    update_workflow_payload,
    workflow_run_log_payload,
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
    def __init__(self, server_address: tuple[str, int], data_dir: Path) -> None:
        data_dir.mkdir(parents=True, exist_ok=True)
        super().__init__(server_address, GoferUiRequestHandler)
        self.data_dir = data_dir
        self.gofer_cli_path = ensure_local_gofer_cli(data_dir)
        self.scheduler = WorkflowScheduler(db_path=data_dir / "schedules.db")
        self.watcher = WorkflowWatcher()
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
        for path in sorted(self.data_dir.glob("*.toml")):
            try:
                workflow = AgenticWorkflow.from_file(path)
            except Exception:
                continue
            if not workflow.config.run_continuously:
                continue
            active_ids.add(workflow.config.id)
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
            self._send_json({
                "ok": True,
                "dataDir": str(self._default_data_dir()),
            })
            return

        if parsed.path == "/api/workflows":
            query = parse_qs(parsed.query)
            self._sync_schedules()
            payload = list_workflow_payloads(self._request_data_dir(query))
            self._send_json(payload)
            return

        if parsed.path == "/api/chat/providers":
            self._send_json(provider_payload())
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/logs/latest"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix(
                "/logs/latest"
            )
            query = parse_qs(parsed.query)
            try:
                payload = latest_workflow_log_payload(
                    workflow_id,
                    self._request_data_dir(query),
                )
            except WorkflowLogError as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._send_json({"log": payload})
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
                )
            except WorkflowLogError as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._send_json(payload)
            return

        self._send_json({"error": "Not found"}, status=404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/workflows/import":
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                workflow = import_workflow_payload(
                    str(body.get("content", "")),
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

        if parsed.path == "/api/workflows":
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
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

        if parsed.path.startswith("/api/workflows/") and "/runs/" in parsed.path and parsed.path.endswith("/stop"):
            remainder = parsed.path.removeprefix("/api/workflows/")
            workflow_id, run_id = remainder.removesuffix("/stop").split("/runs/", 1)
            query = parse_qs(parsed.query)
            payload = stop_workflow_run_payload(
                workflow_id,
                self._request_data_dir(query),
                run_id=run_id,
            )
            self._send_json(payload)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/stop"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/stop")
            query = parse_qs(parsed.query)
            payload = stop_workflow_run_payload(workflow_id, self._request_data_dir(query))
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

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/run"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/run")
            query = parse_qs(parsed.query)
            try:
                body = self._read_json()
                run = asyncio.run(
                    run_workflow_payload(
                        workflow_id,
                        self._request_data_dir(query),
                        dry_run=bool(body.get("dryRun", False)),
                    )
                )
            except (WorkflowRunError, json.JSONDecodeError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._send_json({"run": run})
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
            payload = delete_workflow_chat_payload(
                "workflow-assistant",
                self._request_data_dir(query),
            )
            self._send_json(payload)
            return

        if parsed.path.startswith("/api/chat/threads/"):
            thread_id = parsed.path.removeprefix("/api/chat/threads/")
            query = parse_qs(parsed.query)
            payload = delete_workflow_chat_payload(
                f"workflow-assistant:{thread_id}",
                self._request_data_dir(query),
            )
            self._send_json(payload)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/chat"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/chat")
            query = parse_qs(parsed.query)
            payload = delete_workflow_chat_payload(
                workflow_id,
                self._request_data_dir(query),
            )
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
            ):
                self._write_stream_event(event)
        except (BrokenPipeError, ConnectionResetError):
            cancel_event.set()
        except ChatProviderError as exc:
            self._write_stream_event({"type": "error", "error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            cancel_event.set()
            log.exception("Unhandled workflow assistant stream error")
            self._write_stream_event({
                "type": "error",
                "error": f"Workflow assistant failed: {exc}",
            })
        finally:
            cancel_event.set()

    def _default_data_dir(self) -> Path:
        server = self.server
        if isinstance(server, GoferUiServer):
            return server.data_dir
        return get_data_dir()

    def _request_data_dir(self, query: dict[str, list[str]]) -> Path:
        data_dir = query.get("data_dir", [None])[0]
        return Path(data_dir) if data_dir else self._default_data_dir()

    def _read_json(self) -> dict[str, Any]:
        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length)
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
        "goferCliPath": str(server.gofer_cli_path) if server.gofer_cli_path else None,
    }


def create_server(
    host: str = "127.0.0.1",
    port: int = 8765,
    data_dir: Path | None = None,
) -> GoferUiServer:
    return GoferUiServer((host, port), data_dir or get_data_dir())


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
