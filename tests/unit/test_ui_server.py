from __future__ import annotations

import json
from threading import Thread
from urllib.request import urlopen

from gofer.core.scheduler import WorkflowScheduler
from gofer.ui.server import create_server, ready_payload, sync_workflow_schedules


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
