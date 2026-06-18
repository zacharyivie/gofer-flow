from __future__ import annotations

import json
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from gofer.core.scheduler import WorkflowScheduler
from gofer.ui import server as server_module
from gofer.core.watcher import WorkflowWatcher
from gofer.ui.chat import workflow_chat_prompt_path
from gofer.ui.server import (
    create_server,
    ready_payload,
    sync_workflow_schedules,
    sync_workflow_watchers,
)
from gofer.utils.run_state import workflow_run_stop_path


def test_ui_server_syncs_workflow_schedules(tmp_path) -> None:
    workflow_path = tmp_path / "scheduled.toml"
    workflow_path.write_text(
        """
[workflow]
id = "scheduled"
name = "Scheduled"

[workflow.schedule]
cron_expression = "43 * * * *"
timezone = "America/New_York"

[[nodes]]
id = "hello"
type = "bash_command"
command = "echo hello"
""".strip()
    )

    scheduler = WorkflowScheduler(db_path=tmp_path / "schedules.db")

    sync_workflow_schedules(tmp_path, scheduler)
    assert [job["id"] for job in scheduler.list_workflows()] == ["scheduled"]

    workflow_path.write_text(
        """
[workflow]
id = "scheduled"
name = "Scheduled"

[[nodes]]
id = "hello"
type = "bash_command"
command = "echo hello"
""".strip()
    )
    sync_workflow_schedules(tmp_path, scheduler)
    assert scheduler.list_workflows() == []


def test_ui_server_sync_skips_invalid_schedule_timezone(tmp_path) -> None:
    (tmp_path / "invalid-timezone.toml").write_text(
        """
[workflow]
id = "invalid-timezone"
name = "Invalid Timezone"

[workflow.schedule]
cron_expression = "43 * * * *"
timezone = "ETC"

[[nodes]]
id = "hello"
type = "bash_command"
command = "echo hello"
""".strip()
    )
    scheduler = WorkflowScheduler(db_path=tmp_path / "schedules.db")

    sync_workflow_schedules(tmp_path, scheduler)

    assert scheduler.list_workflows() == []


def test_ui_server_syncs_workflow_watchers(tmp_path) -> None:
    workflow_path = tmp_path / "watched.toml"
    workflow_path.write_text(
        """
[workflow]
id = "watched"
name = "Watched"

[workflow.watch]
path = "inputs"
glob = "*.txt"

[[nodes]]
id = "hello"
type = "bash_command"
command = "echo hello"
""".strip()
    )
    watcher = WorkflowWatcher()

    sync_workflow_watchers(tmp_path, watcher)

    assert [item["id"] for item in watcher.list_workflows()] == ["watched"]


def test_ui_server_dynamic_port_reports_bound_port(tmp_path) -> None:
    server = create_server(host="127.0.0.1", port=0, data_dir=tmp_path)

    try:
        payload = ready_payload(server)

        assert payload["host"] == "127.0.0.1"
        assert isinstance(payload["port"], int)
        assert payload["port"] > 0
        assert payload["dataDir"] == str(tmp_path)
    finally:
        server.server_close()


def test_ui_server_creates_missing_data_dir_before_scheduler_start(tmp_path) -> None:
    data_dir = tmp_path / "missing" / "gofer"
    server = create_server(host="127.0.0.1", port=0, data_dir=data_dir)

    try:
        server.scheduler.start(paused=True)

        assert data_dir.is_dir()
        assert (data_dir / "schedules.db").exists()
    finally:
        if server.scheduler.is_running():
            server.scheduler.shutdown(wait=False)
        server.server_close()


def test_ui_server_health_check_works_on_dynamic_port(tmp_path) -> None:
    server = create_server(host="127.0.0.1", port=0, data_dir=tmp_path)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        host, port = server.server_address[:2]
        with urlopen(f"http://{host}:{port}/api/health", timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))

        assert response.status == 200
        assert payload == {"ok": True, "dataDir": str(tmp_path)}
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_ui_server_chat_unhandled_error_returns_json(monkeypatch, tmp_path) -> None:
    async def explode(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(server_module, "run_workflow_chat", explode)
    server = create_server(host="127.0.0.1", port=0, data_dir=tmp_path)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        host, port = server.server_address[:2]
        request = Request(
            f"http://{host}:{port}/api/chat",
            data=json.dumps({"messages": [{"role": "user", "body": "hello"}]}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            urlopen(request, timeout=2)
        except HTTPError as exc:
            payload = json.loads(exc.read().decode("utf-8"))
            assert exc.code == 500
            assert payload["error"] == "Workflow assistant failed: boom"
        else:  # pragma: no cover
            raise AssertionError("Expected HTTP 500")
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_ui_server_stops_specific_running_workflow_log(tmp_path) -> None:
    log_dir = tmp_path / "logs" / "stop-me"
    log_dir.mkdir(parents=True)
    run_id = "2026-06-17T12-00-00-0400.log"
    (log_dir / run_id).write_text(
        "2026-06-17T12:00:00-04:00 - stop-me started successfully\n",
        encoding="utf-8",
    )
    server = create_server(host="127.0.0.1", port=0, data_dir=tmp_path)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        host, port = server.server_address[:2]
        request = Request(
            f"http://{host}:{port}/api/workflows/stop-me/runs/{run_id}/stop",
            method="POST",
        )
        with urlopen(request, timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))

        assert response.status == 200
        assert payload["stopped"] is True
        assert workflow_run_stop_path("stop-me", run_id, tmp_path).exists()
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_ui_server_delete_global_chat_prompt(tmp_path) -> None:
    chat_path = workflow_chat_prompt_path(tmp_path, "workflow-assistant")
    chat_path.parent.mkdir(parents=True)
    chat_path.write_text("old chat prompt\n", encoding="utf-8")
    server = create_server(host="127.0.0.1", port=0, data_dir=tmp_path)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        host, port = server.server_address[:2]
        request = Request(
            f"http://{host}:{port}/api/chat",
            method="DELETE",
        )
        with urlopen(request, timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))

        assert response.status == 200
        assert payload == {"workflowId": "workflow-assistant", "deleted": True}
        assert not chat_path.exists()
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_ui_server_delete_thread_chat_prompt(tmp_path) -> None:
    chat_path = workflow_chat_prompt_path(tmp_path, "workflow-assistant:thread-1")
    chat_path.parent.mkdir(parents=True)
    chat_path.write_text("old thread prompt\n", encoding="utf-8")
    server = create_server(host="127.0.0.1", port=0, data_dir=tmp_path)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        host, port = server.server_address[:2]
        request = Request(
            f"http://{host}:{port}/api/chat/threads/thread-1",
            method="DELETE",
        )
        with urlopen(request, timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))

        assert response.status == 200
        assert payload == {"workflowId": "workflow-assistant:thread-1", "deleted": True}
        assert not chat_path.exists()
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
