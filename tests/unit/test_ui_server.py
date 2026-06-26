from __future__ import annotations

import json
import socket
import threading
from email.message import Message
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest

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


class HandlerResult:
    def __init__(
        self,
        status: int,
        headers: list[tuple[str, str]],
        body: bytes,
        server: GoferUiServer,
    ) -> None:
        self.status = status
        self.headers = headers
        self.body = body
        self.server = server

    def json(self) -> object:
        return json.loads(self.body.decode("utf-8"))

    def text(self) -> str:
        return self.body.decode("utf-8")

    def header(self, name: str) -> str | None:
        lowered = name.lower()
        for key, value in reversed(self.headers):
            if key.lower() == lowered:
                return value
        return None


def _fake_server(
    tmp_path: Path,
    *,
    resource_limits: ResourceLimits | None = None,
) -> GoferUiServer:
    server = GoferUiServer.__new__(GoferUiServer)
    server.data_dir = tmp_path
    server.resource_limits = resource_limits or DEFAULT_RESOURCE_LIMITS
    server.gofer_cli_path = None
    server.server_address = ("127.0.0.1", 8765)
    server.sync_calls = 0
    server.continuous_sync_calls = 0

    def sync_schedules() -> None:
        server.sync_calls += 1

    def ensure_continuous_runs() -> None:
        server.continuous_sync_calls += 1

    setattr(server, "sync_schedules", sync_schedules)
    setattr(server, "ensure_continuous_runs", ensure_continuous_runs)
    return server


def _request(
    tmp_path: Path,
    method: str,
    path: str,
    *,
    body: dict[str, object] | bytes | None = None,
    headers: dict[str, str] | None = None,
    resource_limits: ResourceLimits | None = None,
) -> HandlerResult:
    raw_body = b""
    if isinstance(body, bytes):
        raw_body = body
    elif body is not None:
        raw_body = json.dumps(body).encode("utf-8")

    server = _fake_server(tmp_path, resource_limits=resource_limits)
    handler = GoferUiRequestHandler.__new__(GoferUiRequestHandler)
    handler.server = server
    handler.path = path
    handler.headers = Message()
    for key, value in (headers or {}).items():
        handler.headers[key] = value
    if body is not None:
        handler.headers["Content-Length"] = str(len(raw_body))
    handler.rfile = BytesIO(raw_body)
    handler.wfile = BytesIO()
    status: dict[str, int] = {}
    response_headers: list[tuple[str, str]] = []

    def send_response(code: int, message: str | None = None) -> None:
        status["code"] = code

    def send_header(keyword: str, value: str) -> None:
        response_headers.append((keyword, value))

    def end_headers() -> None:
        return None

    setattr(handler, "send_response", send_response)
    setattr(handler, "send_header", send_header)
    setattr(handler, "end_headers", end_headers)

    getattr(handler, f"do_{method}")()
    return HandlerResult(status["code"], response_headers, handler.wfile.getvalue(), server)


def _sockets_available() -> bool:
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.bind(("127.0.0.1", 0))
    except OSError:
        return False
    else:
        probe.close()
        return True


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
    if not _sockets_available():
        pytest.skip("local sockets are unavailable in this environment")
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
    if not _sockets_available():
        pytest.skip("local sockets are unavailable in this environment")
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
    response = _request(tmp_path, "GET", "/api/health")

    assert response.status == 200
    assert response.json() == {"ok": True, "dataDir": str(tmp_path)}
    assert response.header("Content-Type") == "application/json"
    assert response.header("Content-Length") == str(len(response.body))
    assert response.header("Access-Control-Allow-Origin") == "*"


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


def test_ui_server_webhook_trigger_endpoint_runs_workflow(tmp_path: Path) -> None:
    (tmp_path / "hooked.toml").write_text(
        """
[workflow]
id = "hooked"
name = "Hooked"

[workflow.webhooks.default]
enabled = true

[[nodes]]
id = "echo"
type = "bash_command"
command = 'printf "%s" "$SOURCE"'

[nodes.inputs]
"env.SOURCE" = "{{trigger.source}}"
""".strip(),
        encoding="utf-8",
    )

    response = _request(
        tmp_path,
        "POST",
        "/api/workflows/hooked/webhooks/default/trigger",
        body={"ok": True},
    )

    payload = cast(dict[str, object], response.json())
    trigger = cast(dict[str, object], payload["trigger"])
    run = cast(dict[str, object], trigger["run"])
    node_outputs = cast(dict[str, object], run["nodeOutputs"])
    echo = cast(dict[str, object], node_outputs["echo"])
    assert response.status == 202
    assert trigger["triggerId"] == "default"
    assert echo["output"] == "http"


def test_ui_server_webhook_replay_requires_token(tmp_path: Path) -> None:
    (tmp_path / "hooked.toml").write_text(
        """
[workflow]
id = "hooked"
name = "Hooked"

[workflow.webhooks.default]
enabled = true
token = "secret-token"

[[nodes]]
id = "echo"
type = "bash_command"
command = 'printf "%s" "$VALUE"'

[nodes.inputs]
"env.VALUE" = "{{trigger.payload.value}}"
""".strip(),
        encoding="utf-8",
    )

    trigger_response = _request(
        tmp_path,
        "POST",
        "/api/workflows/hooked/webhooks/default/trigger",
        body={"value": "original"},
        headers={"X-Gofer-Webhook-Token": "secret-token"},
    )
    trigger_payload = cast(dict[str, object], trigger_response.json())["trigger"]
    run_id = cast(dict[str, object], trigger_payload)["runId"]

    unauthorized = _request(
        tmp_path,
        "POST",
        "/api/workflows/hooked/webhooks/default/replay",
        body={"runId": str(run_id)},
    )

    assert unauthorized.status == 400
    assert "Unauthorized" in unauthorized.text()

    authorized = _request(
        tmp_path,
        "POST",
        "/api/workflows/hooked/webhooks/default/replay",
        body={"runId": str(run_id)},
        headers={"Authorization": "Bearer secret-token"},
    )

    assert authorized.status == 202


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


def test_ui_server_log_endpoint_forwards_range_query(monkeypatch, tmp_path) -> None:
    captured: dict[str, object] = {}

    def fake_workflow_run_log_payload(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return {"workflowId": "wf", "runId": "run.log", "logText": "3456"}

    monkeypatch.setattr(
        server_module,
        "workflow_run_log_payload",
        fake_workflow_run_log_payload,
    )
    server = GoferUiServer.__new__(GoferUiServer)
    server.data_dir = tmp_path
    handler = GoferUiRequestHandler.__new__(GoferUiRequestHandler)
    handler.server = server
    handler.path = "/api/workflows/wf/logs/run.log?offset=3&limit=4&tailBytes=8&details=0"
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
    assert payload == {"log": {"workflowId": "wf", "runId": "run.log", "logText": "3456"}}
    assert captured["args"] == ("wf", "run.log", tmp_path)
    assert captured["kwargs"] == {
        "offset": 3,
        "limit": 4,
        "tail_bytes": 8,
        "include_details": False,
    }


def test_ui_server_get_routes_forward_to_api_payloads(monkeypatch, tmp_path) -> None:
    calls: dict[str, object] = {}

    def fake_list(data_dir):
        calls["list"] = data_dir
        return {"workflows": []}

    def fake_latest(workflow_id, data_dir):
        calls["latest"] = (workflow_id, data_dir)
        return {"id": "latest.log"}

    def fake_logs(workflow_id, data_dir, **kwargs):
        calls["logs"] = (workflow_id, data_dir, kwargs)
        return {"runs": [], "total": 0}

    def fake_events(workflow_id, run_id, data_dir):
        calls["events"] = (workflow_id, run_id, data_dir)
        return [{"type": "start"}]

    monkeypatch.setattr(server_module, "list_workflow_payloads", fake_list)
    monkeypatch.setattr(server_module, "latest_workflow_log_payload", fake_latest)
    monkeypatch.setattr(server_module, "list_workflow_run_logs_payload", fake_logs)
    monkeypatch.setattr(server_module, "workflow_run_events_payload", fake_events)
    monkeypatch.setattr(
        server_module,
        "provider_payload",
        lambda: {"providers": [{"id": "codex"}]},
    )

    workflows = _request(tmp_path, "GET", "/api/workflows")
    providers = _request(tmp_path, "GET", "/api/chat/providers")
    latest = _request(tmp_path, "GET", "/api/workflows/wf/logs/latest")
    logs = _request(
        tmp_path,
        "GET",
        "/api/workflows/wf/logs?offset=2&limit=3&status=success&trigger=ui&q=needle",
    )
    events = _request(tmp_path, "GET", "/api/workflows/wf/logs/run.log/events")

    assert workflows.status == 200
    assert workflows.json() == {"workflows": []}
    assert providers.json() == {"providers": [{"id": "codex"}]}
    assert latest.json() == {"log": {"id": "latest.log"}}
    assert logs.json() == {"runs": [], "total": 0}
    assert events.json() == {"events": [{"type": "start"}]}
    assert calls["list"] == tmp_path
    assert calls["latest"] == ("wf", tmp_path)
    assert calls["events"] == ("wf", "run.log", tmp_path)
    assert calls["logs"] == (
        "wf",
        tmp_path,
        {
            "offset": 2,
            "limit": 3,
            "status": "success",
            "trigger_type": "ui",
            "search": "needle",
            "started_after": None,
            "started_before": None,
        },
    )


def test_ui_server_post_workflow_routes_and_syncs(monkeypatch, tmp_path) -> None:
    calls: dict[str, object] = {}

    def fake_create(name, data_dir):
        calls["create"] = (name, data_dir)
        return {"id": "created"}

    def fake_import(content, data_dir):
        calls["import"] = (content, data_dir)
        return {"id": "imported"}

    def fake_rename(workflow_id, name, data_dir):
        calls["rename"] = (workflow_id, name, data_dir)
        return {"id": "renamed"}

    def fake_duplicate(workflow_id, name, data_dir):
        calls["duplicate"] = (workflow_id, name, data_dir)
        return {"id": "copy"}

    monkeypatch.setattr(server_module, "create_workflow_payload", fake_create)
    monkeypatch.setattr(server_module, "import_workflow_payload", fake_import)
    monkeypatch.setattr(server_module, "rename_workflow_payload", fake_rename)
    monkeypatch.setattr(server_module, "duplicate_workflow_payload", fake_duplicate)

    create = _request(tmp_path, "POST", "/api/workflows", body={"name": "Created"})
    imported = _request(tmp_path, "POST", "/api/workflows/import", body={"content": "toml"})
    renamed = _request(tmp_path, "POST", "/api/workflows/wf/rename", body={"name": "Renamed"})
    duplicate = _request(tmp_path, "POST", "/api/workflows/wf/duplicate", body={"name": "Copy"})

    assert create.status == 201
    assert create.json() == {"workflow": {"id": "created"}}
    assert create.server.sync_calls == 1
    assert imported.status == 201
    assert renamed.status == 200
    assert renamed.server.sync_calls == 1
    assert renamed.server.continuous_sync_calls == 1
    assert duplicate.status == 201
    assert calls == {
        "create": ("Created", tmp_path),
        "import": ("toml", tmp_path),
        "rename": ("wf", "Renamed", tmp_path),
        "duplicate": ("wf", "Copy", tmp_path),
    }


def test_ui_server_update_delete_run_and_stop_routes(monkeypatch, tmp_path) -> None:
    async def fake_run(workflow_id, data_dir, *, dry_run, trigger_context=None):
        return {
            "workflowId": workflow_id,
            "dataDir": str(data_dir),
            "dryRun": dry_run,
            "triggerContext": trigger_context,
        }

    monkeypatch.setattr(
        server_module,
        "update_workflow_payload",
        lambda workflow_id, payload, data_dir: {
            "id": workflow_id,
            "name": payload["name"],
            "dataDir": str(data_dir),
        },
    )
    monkeypatch.setattr(
        server_module,
        "delete_workflow_payload",
        lambda workflow_id, data_dir: {"workflowId": workflow_id, "deleted": True},
    )
    monkeypatch.setattr(
        server_module,
        "stop_workflow_run_payload",
        lambda workflow_id, data_dir, run_id=None: {
            "workflowId": workflow_id,
            "runId": run_id,
            "stopped": True,
        },
    )
    monkeypatch.setattr(server_module, "run_workflow_payload", fake_run)

    updated = _request(tmp_path, "PUT", "/api/workflows/wf", body={"name": "Updated"})
    deleted = _request(tmp_path, "DELETE", "/api/workflows/wf")
    stopped = _request(tmp_path, "POST", "/api/workflows/wf/stop")
    stopped_run = _request(tmp_path, "POST", "/api/workflows/wf/runs/run.log/stop")
    dry_run = _request(
        tmp_path,
        "POST",
        "/api/workflows/wf/run",
        body={"dryRun": True, "triggerContext": {"source": "test"}},
    )

    assert updated.status == 200
    assert updated.json() == {
        "workflow": {"id": "wf", "name": "Updated", "dataDir": str(tmp_path)}
    }
    assert updated.server.sync_calls == 1
    assert deleted.json() == {"workflowId": "wf", "deleted": True}
    assert deleted.server.sync_calls == 1
    assert stopped.json() == {"workflowId": "wf", "runId": None, "stopped": True}
    assert stopped_run.json() == {"workflowId": "wf", "runId": "run.log", "stopped": True}
    assert dry_run.json() == {
        "plan": {
            "workflowId": "wf",
            "dataDir": str(tmp_path),
            "dryRun": True,
            "triggerContext": {"source": "test"},
        }
    }


def test_ui_server_retention_queue_and_approval_routes(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        server_module,
        "retention_settings_payload",
        lambda data_dir, workflow_id=None: {"workflowId": workflow_id, "settings": {}},
    )
    monkeypatch.setattr(
        server_module,
        "update_retention_settings_payload",
        lambda data_dir, settings, workflow_id=None: {
            "workflowId": workflow_id,
            "settings": settings,
        },
    )
    monkeypatch.setattr(
        server_module,
        "queue_workflow_run_payload",
        lambda workflow_id, data_dir, **kwargs: {"workflowId": workflow_id, **kwargs},
    )
    monkeypatch.setattr(
        server_module,
        "cancel_queued_run_payload",
        lambda run_id, data_dir: {"runId": run_id, "cancelled": True},
    )
    monkeypatch.setattr(
        server_module,
        "list_workflow_approvals_payload",
        lambda workflow_id, data_dir, include_decided: {
            "workflowId": workflow_id,
            "includeDecided": include_decided,
        },
    )
    monkeypatch.setattr(
        server_module,
        "decide_workflow_approval_payload",
        lambda workflow_id, run_id, node_id, decision, data_dir, decided_by, notes: {
            "workflowId": workflow_id,
            "runId": run_id,
            "nodeId": node_id,
            "decision": decision,
            "decidedBy": decided_by,
            "notes": notes,
        },
    )

    assert _request(tmp_path, "GET", "/api/retention").json() == {
        "workflowId": None,
        "settings": {},
    }
    assert _request(tmp_path, "GET", "/api/workflows/wf/retention").json() == {
        "workflowId": "wf",
        "settings": {},
    }
    assert _request(
        tmp_path,
        "POST",
        "/api/workflows/wf/retention",
        body={"keepLast": 5},
    ).json() == {"workflowId": "wf", "settings": {"keepLast": 5}}
    assert _request(
        tmp_path,
        "POST",
        "/api/workflows/wf/queue",
        body={"priority": 7, "trigger": "manual", "parameters": {}, "targetLabels": ["a"]},
    ).json() == {
        "workflowId": "wf",
        "priority": 7,
        "trigger": "manual",
        "parameters": {},
        "target_labels": ["a"],
    }
    assert _request(tmp_path, "POST", "/api/queue/run-1/cancel").json() == {
        "runId": "run-1",
        "cancelled": True,
    }
    assert _request(tmp_path, "GET", "/api/workflows/wf/approvals?all=0").json() == {
        "workflowId": "wf",
        "includeDecided": False,
    }
    assert _request(
        tmp_path,
        "POST",
        "/api/workflows/wf/approvals/run-1/node-1/reject",
        body={"by": "tester", "notes": "no"},
    ).json() == {
        "workflowId": "wf",
        "runId": "run-1",
        "nodeId": "node-1",
        "decision": "rejected",
        "decidedBy": "tester",
        "notes": "no",
    }


def test_ui_server_provider_profile_runner_prune_and_resume_routes(
    monkeypatch,
    tmp_path,
) -> None:
    async def fake_resume(workflow_id, data_dir, **kwargs):
        return {"workflowId": workflow_id, "dataDir": str(data_dir), **kwargs}

    monkeypatch.setattr(
        server_module,
        "provider_profiles_payload",
        lambda data_dir: {"profiles": [{"name": "default"}], "dataDir": str(data_dir)},
    )
    monkeypatch.setattr(
        server_module,
        "upsert_provider_profile_payload",
        lambda payload, data_dir: {"profile": payload, "dataDir": str(data_dir)},
    )
    monkeypatch.setattr(
        server_module,
        "delete_provider_profile_payload",
        lambda profile_name, data_dir: {"name": profile_name, "deleted": True},
    )
    monkeypatch.setattr(
        server_module,
        "runner_queue_payload",
        lambda data_dir: {"runs": [], "dataDir": str(data_dir)},
    )
    monkeypatch.setattr(
        server_module,
        "prune_workflow_run_logs_payload",
        lambda workflow_id, data_dir, **kwargs: {
            "workflowId": workflow_id,
            "dataDir": str(data_dir),
            **kwargs,
        },
    )
    monkeypatch.setattr(server_module, "resume_workflow_payload", fake_resume)

    assert _request(tmp_path, "GET", "/api/provider/profiles").json() == {
        "profiles": [{"name": "default"}],
        "dataDir": str(tmp_path),
    }
    assert _request(
        tmp_path,
        "POST",
        "/api/provider/profiles",
        body={"name": "default", "provider": "codex"},
    ).json() == {
        "profile": {"name": "default", "provider": "codex"},
        "dataDir": str(tmp_path),
    }
    assert _request(tmp_path, "DELETE", "/api/provider/profiles/default").json() == {
        "name": "default",
        "deleted": True,
    }
    assert _request(tmp_path, "GET", "/api/runners").json() == {
        "runs": [],
        "dataDir": str(tmp_path),
    }
    assert _request(
        tmp_path,
        "POST",
        "/api/workflows/wf/logs/prune",
        body={
            "keepLast": "5",
            "keepDays": "10",
            "keepFailedDays": "",
            "dryRun": False,
        },
    ).json() == {
        "workflowId": "wf",
        "dataDir": str(tmp_path),
        "keep_last": 5,
        "keep_days": 10,
        "keep_failed_days": None,
        "dry_run": False,
    }
    assert _request(
        tmp_path,
        "POST",
        "/api/workflows/wf/runs/run.log/resume",
        body={
            "fromNode": "a",
            "skipCache": True,
            "force": True,
            "triggerContext": {"reason": "test"},
        },
    ).json() == {
        "run": {
            "workflowId": "wf",
            "dataDir": str(tmp_path),
            "run_id": "run.log",
            "from_node": "a",
            "only_node": None,
            "skip_cache": True,
            "force": True,
            "trigger_context": {"reason": "test"},
        }
    }


def test_ui_server_chat_routes_and_stream_headers(monkeypatch, tmp_path) -> None:
    async def fake_chat(**kwargs):
        return {"reply": "ok", "provider": kwargs["provider"]}

    async def fake_stream(**kwargs):
        yield {"type": "message", "body": "one"}
        yield {"type": "done"}

    monkeypatch.setattr(server_module, "run_workflow_chat", fake_chat)
    monkeypatch.setattr(server_module, "stream_workflow_chat", fake_stream)

    chat = _request(tmp_path, "POST", "/api/chat", body={"provider": "codex", "messages": []})
    stream = _request(tmp_path, "POST", "/api/chat/stream", body={"messages": []})

    assert chat.status == 200
    assert chat.json() == {"reply": "ok", "provider": "codex"}
    assert stream.status == 200
    assert stream.header("Content-Type") == "application/x-ndjson; charset=utf-8"
    assert stream.header("Cache-Control") == "no-cache"
    assert stream.text().splitlines() == [
        '{"type": "message", "body": "one"}',
        '{"type": "done"}',
    ]


def test_ui_server_chat_stream_provider_error_is_ndjson(monkeypatch, tmp_path) -> None:
    async def bad_stream(**_kwargs):
        raise server_module.ChatProviderError("stream unavailable")
        yield {"type": "unreachable"}

    monkeypatch.setattr(server_module, "stream_workflow_chat", bad_stream)

    response = _request(tmp_path, "POST", "/api/chat/stream", body={"messages": []})

    assert response.status == 200
    assert response.header("Content-Type") == "application/x-ndjson; charset=utf-8"
    assert response.text().splitlines() == [
        '{"type": "error", "error": "stream unavailable"}'
    ]


@pytest.mark.parametrize(
    ("method", "path", "body", "patch_name", "error", "expected_status"),
    [
        (
            "POST",
            "/api/workflows",
            {"name": "Taken"},
            "create_workflow_payload",
            server_module.WorkflowAlreadyExistsError("taken"),
            409,
        ),
        (
            "POST",
            "/api/workflows/import",
            {"content": "bad"},
            "import_workflow_payload",
            server_module.WorkflowCreateError("bad import"),
            400,
        ),
        (
            "PUT",
            "/api/workflows/wf",
            {"id": "wf"},
            "update_workflow_payload",
            server_module.WorkflowUpdateError("bad update"),
            400,
        ),
        (
            "POST",
            "/api/workflows/wf/run",
            {},
            "run_workflow_payload",
            server_module.WorkflowRunError("bad run"),
            400,
        ),
        (
            "GET",
            "/api/workflows/wf/logs/latest",
            None,
            "latest_workflow_log_payload",
            server_module.WorkflowLogError("bad log"),
            400,
        ),
        (
            "POST",
            "/api/chat",
            {"messages": []},
            "run_workflow_chat",
            server_module.ChatProviderError("bad provider"),
            400,
        ),
    ],
)
def test_ui_server_error_status_mappings(
    monkeypatch,
    tmp_path,
    method,
    path,
    body,
    patch_name,
    error,
    expected_status,
) -> None:
    async def async_raise(*_args, **_kwargs):
        raise error

    def sync_raise(*_args, **_kwargs):
        raise error

    replacement = (
        async_raise
        if patch_name in {"run_workflow_payload", "run_workflow_chat"}
        else sync_raise
    )
    monkeypatch.setattr(server_module, patch_name, replacement)

    response = _request(tmp_path, method, path, body=body)

    assert response.status == expected_status
    assert response.json() == {"error": str(error)}


def test_ui_server_unknown_invalid_json_and_options(tmp_path) -> None:
    missing = _request(tmp_path, "GET", "/api/not-found")
    invalid = _request(tmp_path, "POST", "/api/workflows", body=b"{")
    options = _request(tmp_path, "OPTIONS", "/api/workflows")

    assert missing.status == 404
    assert missing.json() == {"error": "Not found"}
    assert invalid.status == 400
    assert "Expecting property name" in cast(dict[str, str], invalid.json())["error"]
    assert options.status == 204
    assert options.body == b""
    assert options.header("Access-Control-Allow-Origin") == "*"
    assert options.header("Access-Control-Allow-Methods") == "GET, POST, PUT, DELETE, OPTIONS"


def test_ui_server_continuous_monitor_starts_one_thread_and_cleans_inactive(
    monkeypatch,
    tmp_path,
) -> None:
    class FakeThread:
        created: list[FakeThread] = []

        def __init__(self, *args, **kwargs) -> None:
            self.target = kwargs.get("target")
            self.args = kwargs.get("args", ())
            self.name = kwargs.get("name")
            self.daemon = kwargs.get("daemon", False)
            self.alive = False
            self.started = 0
            FakeThread.created.append(self)

        def start(self) -> None:
            self.started += 1
            self.alive = True

        def is_alive(self) -> bool:
            return self.alive

        def join(self, timeout: float | None = None) -> None:
            self.alive = False

    (tmp_path / "continuous.toml").write_text(
        """
[workflow]
id = "continuous"
name = "Continuous"
run_continuously = true

[[nodes]]
id = "hello"
type = "bash_command"
command = "echo hello"
""".strip(),
        encoding="utf-8",
    )
    (tmp_path / "invalid.toml").write_text("not = [valid", encoding="utf-8")
    monkeypatch.setattr(server_module.threading, "Thread", FakeThread)
    server = GoferUiServer.__new__(GoferUiServer)
    server.data_dir = tmp_path
    server.resource_limits = ResourceLimits(max_watcher_concurrency=5)
    server._continuous_runs = {}
    server._continuous_lock = threading.Lock()

    server.ensure_continuous_runs()
    server.ensure_continuous_runs()

    assert list(server._continuous_runs) == ["continuous"]
    assert len(FakeThread.created) == 1
    assert FakeThread.created[0].started == 1

    (tmp_path / "continuous.toml").write_text(
        """
[workflow]
id = "continuous"
name = "Continuous"

[[nodes]]
id = "hello"
type = "bash_command"
command = "echo hello"
""".strip(),
        encoding="utf-8",
    )
    server.ensure_continuous_runs()

    assert server._continuous_runs == {}


def test_ui_server_start_stop_continuous_monitor_uses_single_monitor_thread(
    monkeypatch,
    tmp_path,
) -> None:
    class FakeThread:
        def __init__(self, *args, **kwargs) -> None:
            self.target = kwargs.get("target")
            self.name = kwargs.get("name")
            self.daemon = kwargs.get("daemon", False)
            self.alive = False
            self.started = 0
            self.joined = False

        def start(self) -> None:
            self.started += 1
            self.alive = True

        def is_alive(self) -> bool:
            return self.alive

        def join(self, timeout: float | None = None) -> None:
            self.joined = True
            self.alive = False

    monkeypatch.setattr(server_module.threading, "Thread", FakeThread)
    server = GoferUiServer.__new__(GoferUiServer)
    server.data_dir = tmp_path
    server.resource_limits = DEFAULT_RESOURCE_LIMITS
    server._continuous_runs = {}
    server._continuous_lock = threading.Lock()
    server._continuous_stop = threading.Event()
    server._continuous_thread = None

    server.start_continuous_monitor()
    first_thread = server._continuous_thread
    server.start_continuous_monitor()
    server.stop_continuous_monitor()

    assert first_thread is server._continuous_thread
    assert first_thread.started == 1
    assert first_thread.joined is True
    assert server._continuous_stop.is_set()


def test_ui_server_serve_shutdown_cleans_up(monkeypatch, tmp_path, capsys) -> None:
    class FakeLifecycle:
        def __init__(self) -> None:
            self.calls: list[tuple[str, object | None]] = []

        def start(self, paused: bool = False) -> None:
            self.calls.append(("start", paused))

        def resume(self) -> None:
            self.calls.append(("resume", None))

        def shutdown(self, wait: bool = True) -> None:
            self.calls.append(("shutdown", wait))

    class FakeServer:
        def __init__(self) -> None:
            self.server_address = ("127.0.0.1", 4321)
            self.data_dir = tmp_path
            self.gofer_cli_path = None
            self.scheduler = FakeLifecycle()
            self.watcher = FakeLifecycle()
            self.calls: list[str] = []

        def sync_schedules(self) -> None:
            self.calls.append("sync_schedules")

        def start_continuous_monitor(self) -> None:
            self.calls.append("start_continuous_monitor")

        def stop_continuous_monitor(self) -> None:
            self.calls.append("stop_continuous_monitor")

        def serve_forever(self) -> None:
            self.calls.append("serve_forever")
            raise KeyboardInterrupt

        def server_close(self) -> None:
            self.calls.append("server_close")

    fake_server = FakeServer()
    monkeypatch.setattr(server_module, "create_server", lambda **_kwargs: fake_server)
    monkeypatch.setattr(server_module, "_install_shutdown_handlers", lambda _server: None)

    server_module.serve(host="127.0.0.1", port=9999, data_dir=tmp_path)

    output = capsys.readouterr()
    assert "GOFER_UI_READY" in output.out
    assert "GOFER_UI_STOPPED" in output.err
    assert fake_server.scheduler.calls == [
        ("start", True),
        ("resume", None),
        ("shutdown", False),
    ]
    assert fake_server.watcher.calls == [("start", False), ("shutdown", False)]
    assert fake_server.calls == [
        "sync_schedules",
        "start_continuous_monitor",
        "serve_forever",
        "stop_continuous_monitor",
        "server_close",
    ]


def test_ui_server_chat_unhandled_error_returns_json(monkeypatch, tmp_path) -> None:
    async def explode(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(server_module, "run_workflow_chat", explode)
    response = _request(
        tmp_path,
        "POST",
        "/api/chat",
        body={"messages": [{"role": "user", "body": "hello"}]},
    )

    assert response.status == 500
    assert response.json() == {"error": "Workflow assistant failed: boom"}


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
    handler = GoferUiRequestHandler.__new__(GoferUiRequestHandler)
    headers = Message()
    headers["Content-Length"] = "5"
    handler.headers = headers
    handler.rfile = BytesIO(b"")
    handler.server = _fake_server(
        Path("/tmp"),
        resource_limits=ResourceLimits(max_api_request_body_bytes=4),
    )

    try:
        handler._read_json()
    except json.JSONDecodeError as exc:
        assert "limit 4 bytes" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("Expected JSONDecodeError")


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
    response = _request(tmp_path, "POST", f"/api/workflows/stop-me/runs/{run_id}/stop")

    payload = response.json()
    assert response.status == 200
    assert isinstance(payload, dict)
    assert payload["stopped"] is True
    assert workflow_run_stop_path("stop-me", run_id, tmp_path).exists()


def test_ui_server_delete_global_chat_prompt(tmp_path) -> None:
    chat_path = workflow_chat_prompt_path(tmp_path, "workflow-assistant")
    chat_path.parent.mkdir(parents=True)
    chat_path.write_text("old chat prompt\n", encoding="utf-8")
    response = _request(tmp_path, "DELETE", "/api/chat")

    assert response.status == 200
    assert response.json() == {"workflowId": "workflow-assistant", "deleted": True}
    assert not chat_path.exists()


def test_ui_server_delete_thread_chat_prompt(tmp_path) -> None:
    chat_path = workflow_chat_prompt_path(tmp_path, "workflow-assistant:thread-1")
    chat_path.parent.mkdir(parents=True)
    chat_path.write_text("old thread prompt\n", encoding="utf-8")
    response = _request(tmp_path, "DELETE", "/api/chat/threads/thread-1")

    assert response.status == 200
    assert response.json() == {"workflowId": "workflow-assistant:thread-1", "deleted": True}
    assert not chat_path.exists()
