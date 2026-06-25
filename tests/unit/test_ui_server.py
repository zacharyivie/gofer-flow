from __future__ import annotations

import json
from email.message import Message
from io import BytesIO
from pathlib import Path
from threading import Thread
from types import SimpleNamespace
from typing import cast
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from gofer.core.resources import DEFAULT_RESOURCE_LIMITS, ResourceLimits
from gofer.core.scheduler import WorkflowScheduler
from gofer.core.watcher import WorkflowWatcher
from gofer.ui import server as server_module
from gofer.ui.chat import workflow_chat_prompt_path
from gofer.ui.server import (
    GoferUiRequestHandler,
    GoferUiServer,
    create_server,
    ready_payload,
    render_usage_summary_html,
    render_workflow_usage_html,
    sync_workflow_schedules,
    sync_workflow_watchers,
    workflow_usage_page_payload,
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


def test_ui_server_sync_skips_schedule_when_run_continuously(tmp_path) -> None:
    (tmp_path / "continuous.toml").write_text(
        """
[workflow]
id = "continuous"
name = "Continuous"
run_continuously = true

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


def test_ui_server_sync_skips_watcher_when_run_continuously(tmp_path) -> None:
    (tmp_path / "continuous.toml").write_text(
        """
[workflow]
id = "continuous"
name = "Continuous"
run_continuously = true

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

    assert watcher.list_workflows() == []


def test_ui_server_dynamic_port_reports_bound_port(tmp_path) -> None:
    server = create_server(host="127.0.0.1", port=0, data_dir=tmp_path)

    try:
        payload = ready_payload(server)

        assert payload["host"] == "127.0.0.1"
        assert isinstance(payload["port"], int)
        assert payload["port"] > 0
        assert payload["dataDir"] == str(tmp_path)
        assert "goferCliPath" not in payload
        assert isinstance(payload["goferCliAvailable"], bool)
    finally:
        server.server_close()


def test_ready_payload_exposes_cli_availability_without_helper_path(tmp_path) -> None:
    fake_server = cast(
        GoferUiServer,
        SimpleNamespace(
            server_address=("127.0.0.1", 37655),
            data_dir=tmp_path,
            gofer_cli_path=tmp_path / ".trusted" / "gof",
        ),
    )

    payload = ready_payload(fake_server)

    assert payload == {
        "host": "127.0.0.1",
        "port": 37655,
        "dataDir": str(tmp_path),
        "goferCliAvailable": True,
    }
    assert "goferCliPath" not in payload


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


def test_ui_server_renders_llm_usage_summary() -> None:
    html = render_usage_summary_html(
        {
            "totals": {
                "agent_calls": 2,
                "total_tokens": 42,
                "estimated_cost": 0.125,
                "agent_time_seconds": 3.5,
            },
            "most_expensive_nodes": [
                {
                    "node_id": "expensive",
                    "model": "gpt-test",
                    "total_tokens": 30,
                    "estimated_cost": 0.1,
                    "duration_seconds": 1.0,
                }
            ],
            "slowest_nodes": [
                {
                    "node_id": "slow",
                    "provider": "codex",
                    "total_tokens": 12,
                    "estimated_cost": 0.025,
                    "duration_seconds": 2.5,
                }
            ],
            "budget_failures": [
                {
                    "node_id": "blocked",
                    "budget_violations": ["node budget max_estimated_tokens exceeded"],
                }
            ],
        }
    )

    assert "LLM run usage" in html
    assert "Most expensive nodes" in html
    assert "Slowest nodes" in html
    assert "Budget failures" in html
    assert "expensive" in html
    assert "blocked" in html


def test_ui_server_workflow_usage_page_reads_recent_sidecars(tmp_path: Path) -> None:
    workflow_dir = tmp_path / "logs" / "usage-ui"
    workflow_dir.mkdir(parents=True)
    log_path = workflow_dir / "run.log"
    log_path.write_text("done\n", encoding="utf-8")
    log_path.with_suffix(".outputs.json").write_text(
        json.dumps(
            {
                "workflowId": "usage-ui",
                "runId": "run.log",
                "nodeOutputs": {},
                "usageSummary": {
                    "totals": {
                        "agent_calls": 1,
                        "input_tokens": 4,
                        "output_tokens": 6,
                        "total_tokens": 10,
                        "estimated_cost": 0.01,
                        "agent_time_seconds": 2.0,
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    payload = workflow_usage_page_payload("usage-ui", tmp_path)
    rendered = render_workflow_usage_html(payload)

    assert payload["totals"]["agent_calls"] == 1
    assert payload["totals"]["total_tokens"] == 10
    assert "LLM usage for usage-ui" in rendered
    assert "run.log" in rendered


def test_ui_server_workflow_plan_route_uses_trigger_context_and_base_path(tmp_path) -> None:
    workflow_path = tmp_path / "watched-plan.toml"
    inputs = tmp_path / "inputs"
    inputs.mkdir()
    event_file = inputs / "one.txt"
    event_file.write_text("one")
    workflow_path.write_text(
        """
[workflow]
id = "watched-plan"
name = "Watched Plan"

[workflow.watch]
path = "inputs"
glob = "*.txt"
mode = "fanout"

[[nodes]]
id = "trigger"
type = "loop"

[nodes.source]
type = "trigger_events"
include_content = true
""".strip()
    )
    body = json.dumps(
        {"triggerContext": {"events": [{"path": str(event_file), "kind": "modified"}]}}
    ).encode()
    server = GoferUiServer.__new__(GoferUiServer)
    server.data_dir = tmp_path
    server.resource_limits = DEFAULT_RESOURCE_LIMITS
    handler = GoferUiRequestHandler.__new__(GoferUiRequestHandler)
    handler.server = server
    handler.path = "/api/workflows/watched-plan/plan"
    handler.headers = Message()
    handler.headers["Content-Length"] = str(len(body))
    handler.rfile = BytesIO(body)
    handler.wfile = BytesIO()
    status: dict[str, int] = {}

    def send_response(code: int, message: str | None = None) -> None:
        status["code"] = code

    def send_header(_keyword: str, _value: str) -> None:
        return None

    def end_headers() -> None:
        return None

    setattr(handler, "send_response", send_response)
    setattr(handler, "send_header", send_header)
    setattr(handler, "end_headers", end_headers)

    handler.do_POST()

    handler.wfile.seek(0)
    payload = json.loads(handler.wfile.read().decode("utf-8"))
    assert status["code"] == 200
    plan = payload["plan"]
    assert plan["pathResolutionBase"] == str(tmp_path)
    assert plan["triggerContext"]["watch"]["path"] == str(inputs)
    fan_out = plan["generations"][0]["nodes"][0]["fanOut"]
    assert fan_out["count"] == 1
    assert fan_out["sampleItems"][0]["path"] == str(event_file)
    assert "content" not in fan_out["sampleItems"][0]


def test_ui_server_ignores_data_dir_query_override(tmp_path) -> None:
    requested_data_dir = tmp_path / "requested"
    requested_data_dir.mkdir()
    outside_data_dir = tmp_path / "outside"
    outside_data_dir.mkdir()
    server = GoferUiServer.__new__(GoferUiServer)
    server.data_dir = requested_data_dir
    handler = GoferUiRequestHandler.__new__(GoferUiRequestHandler)
    handler.server = server

    assert handler._request_data_dir({"data_dir": [str(outside_data_dir)]}) == requested_data_dir


def test_ui_server_doctor_endpoint_returns_health_payload(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        server_module,
        "health_payload",
        lambda data_dir, workflow=None: {
            "ok": True,
            "dataDir": str(data_dir),
            "workflow": workflow,
        },
    )
    server = GoferUiServer.__new__(GoferUiServer)
    server.data_dir = tmp_path
    handler = GoferUiRequestHandler.__new__(GoferUiRequestHandler)
    handler.server = server
    handler.path = "/api/doctor"
    handler.wfile = BytesIO()
    status: dict[str, int] = {}

    def send_response(code: int, message: str | None = None) -> None:
        status["code"] = code

    def send_header(_keyword: str, _value: str) -> None:
        return None

    def end_headers() -> None:
        return None

    setattr(handler, "send_response", send_response)
    setattr(handler, "send_header", send_header)
    setattr(handler, "end_headers", end_headers)

    handler.do_GET()

    handler.wfile.seek(0)
    payload = json.loads(handler.wfile.read().decode("utf-8"))
    assert status["code"] == 200
    assert payload == {"ok": True, "dataDir": str(tmp_path), "workflow": None}


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


def test_ui_server_rejects_large_body_before_json_parse() -> None:
    handler = GoferUiRequestHandler.__new__(GoferUiRequestHandler)
    headers = Message()
    headers["Content-Length"] = str(DEFAULT_RESOURCE_LIMITS.max_api_request_body_bytes + 1)
    handler.headers = headers
    handler.rfile = BytesIO(b"")

    try:
        handler._read_json()
    except json.JSONDecodeError as exc:
        assert "exceeds limit" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("Expected JSONDecodeError")


def test_ui_server_uses_configured_body_limit_before_json_parse() -> None:
    server = create_server(
        host="127.0.0.1",
        port=0,
        data_dir=Path("/tmp"),
        resource_limits=ResourceLimits(max_api_request_body_bytes=4),
    )
    handler = GoferUiRequestHandler.__new__(GoferUiRequestHandler)
    headers = Message()
    headers["Content-Length"] = "5"
    handler.headers = headers
    handler.rfile = BytesIO(b"")
    handler.server = server

    try:
        handler._read_json()
    except json.JSONDecodeError as exc:
        assert "limit 4 bytes" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("Expected JSONDecodeError")
    finally:
        server.server_close()


def test_ui_server_rejects_missing_content_length_before_json_parse() -> None:
    handler = GoferUiRequestHandler.__new__(GoferUiRequestHandler)
    handler.headers = Message()
    handler.rfile = BytesIO(b'{"name": "large"}')

    try:
        handler._read_json()
    except json.JSONDecodeError as exc:
        assert "Content-Length is required" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("Expected JSONDecodeError")


def test_ui_server_rejects_invalid_content_length_before_json_parse() -> None:
    handler = GoferUiRequestHandler.__new__(GoferUiRequestHandler)
    headers = Message()
    headers["Content-Length"] = "not-a-number"
    handler.headers = headers
    handler.rfile = BytesIO(b"{}")

    try:
        handler._read_json()
    except json.JSONDecodeError as exc:
        assert "Invalid Content-Length" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("Expected JSONDecodeError")


def test_ui_server_rejects_incomplete_body_before_json_parse() -> None:
    handler = GoferUiRequestHandler.__new__(GoferUiRequestHandler)
    headers = Message()
    headers["Content-Length"] = "10"
    handler.headers = headers
    handler.rfile = BytesIO(b"{}")

    try:
        handler._read_json()
    except json.JSONDecodeError as exc:
        assert "Incomplete request body" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("Expected JSONDecodeError")


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
