from __future__ import annotations

import asyncio
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from gofer.core.scheduler import WorkflowScheduler
from gofer.core.workflow import AgenticWorkflow
from gofer.utils.logging import get_logger
from gofer.ui.api import (
    WorkflowAlreadyExistsError,
    WorkflowCreateError,
    WorkflowLogError,
    WorkflowRunError,
    WorkflowUpdateError,
    create_workflow_payload,
    delete_workflow_payload,
    import_workflow_payload,
    latest_workflow_log_payload,
    list_workflow_payloads,
    run_workflow_payload,
    update_workflow_payload,
)
from gofer.ui.chat import ChatProviderError, provider_payload, run_workflow_chat
from gofer.utils.paths import get_data_dir


log = get_logger(__name__)


def sync_workflow_schedules(data_dir: Path, scheduler: WorkflowScheduler) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    active_schedule_ids: set[str] = set()

    for path in sorted(data_dir.glob("*.toml")):
        try:
            workflow = AgenticWorkflow.from_file(path)
        except Exception:
            continue
        if workflow.config.schedule is None:
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


class GoferUiServer(ThreadingHTTPServer):
    def __init__(self, server_address: tuple[str, int], data_dir: Path) -> None:
        super().__init__(server_address, GoferUiRequestHandler)
        self.data_dir = data_dir
        self.scheduler = WorkflowScheduler(db_path=data_dir / "schedules.db")

    def sync_schedules(self) -> None:
        sync_workflow_schedules(self.data_dir, self.scheduler)


class GoferUiRequestHandler(BaseHTTPRequestHandler):
    server_version = "GoferUi/0.1"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self._send_json({"ok": True})
            return

        if parsed.path == "/api/workflows":
            query = parse_qs(parsed.query)
            data_dir = query.get("data_dir", [None])[0]
            payload = list_workflow_payloads(Path(data_dir) if data_dir else None)
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
            data_dir = query.get("data_dir", [None])[0]
            try:
                payload = latest_workflow_log_payload(
                    workflow_id,
                    Path(data_dir) if data_dir else None,
                )
            except WorkflowLogError as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._send_json({"log": payload})
            return

        self._send_json({"error": "Not found"}, status=404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/workflows/import":
            query = parse_qs(parsed.query)
            data_dir = query.get("data_dir", [None])[0]
            try:
                body = self._read_json()
                workflow = import_workflow_payload(
                    str(body.get("content", "")),
                    Path(data_dir) if data_dir else None,
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
            data_dir = query.get("data_dir", [None])[0]
            try:
                body = self._read_json()
                workflow = create_workflow_payload(
                    str(body.get("name", "")),
                    Path(data_dir) if data_dir else None,
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

        if parsed.path == "/api/chat":
            query = parse_qs(parsed.query)
            chat_data_dir = Path(query["data_dir"][0]) if "data_dir" in query else get_data_dir()
            try:
                body = self._read_json()
                response = asyncio.run(
                    run_workflow_chat(
                        provider=str(body.get("provider", "codex")),
                        model=str(body.get("model", "cli-default")),
                        messages=body.get("messages") or [],
                        workflow=body.get("workflow"),
                        data_dir=chat_data_dir,
                    )
                )
            except (ChatProviderError, json.JSONDecodeError) as exc:
                self._send_json({"error": str(exc)}, status=400)
                return

            self._send_json(response)
            return

        if parsed.path.startswith("/api/workflows/") and parsed.path.endswith("/run"):
            workflow_id = parsed.path.removeprefix("/api/workflows/").removesuffix("/run")
            query = parse_qs(parsed.query)
            data_dir = query.get("data_dir", [None])[0]
            try:
                body = self._read_json()
                run = asyncio.run(
                    run_workflow_payload(
                        workflow_id,
                        Path(data_dir) if data_dir else None,
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
            data_dir = query.get("data_dir", [None])[0]
            try:
                workflow = update_workflow_payload(
                    workflow_id,
                    self._read_json(),
                    Path(data_dir) if data_dir else None,
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
        if parsed.path.startswith("/api/workflows/"):
            workflow_id = parsed.path.removeprefix("/api/workflows/")
            query = parse_qs(parsed.query)
            data_dir = query.get("data_dir", [None])[0]
            try:
                payload = delete_workflow_payload(
                    workflow_id,
                    Path(data_dir) if data_dir else None,
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


def serve(host: str = "127.0.0.1", port: int = 8765) -> None:
    data_dir = get_data_dir()
    server = GoferUiServer((host, port), data_dir)
    server.scheduler.start(paused=True)
    server.sync_schedules()
    server.scheduler.resume()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.scheduler.shutdown(wait=False)
        server.server_close()


if __name__ == "__main__":
    serve()
