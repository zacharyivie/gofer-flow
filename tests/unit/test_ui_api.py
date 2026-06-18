from __future__ import annotations

from pathlib import Path

import anyio
import pytest

from gofer.ui.api import (
    WorkflowAlreadyExistsError,
    WorkflowCreateError,
    create_workflow_payload,
    delete_workflow_chat_payload,
    delete_workflow_payload,
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
from gofer.ui.chat import workflow_chat_prompt_path
from gofer.utils.run_state import workflow_run_stop_path


def test_list_workflow_payloads_serializes_real_nodes_and_edges(tmp_path: Path) -> None:
    workflow_path = tmp_path / "daily.toml"
    workflow_path.write_text(
        """
[workflow]
id = "daily"
name = "Daily"

[[nodes]]
id = "collect"
type = "bash_command"
command = "echo hello"
pipe_output = true

[[nodes]]
id = "summarize"
type = "python_script"
script_path = "scripts/summarize.py"

[[edges]]
from = "collect"
to = "summarize"
condition = "on_success"
""".strip()
    )

    payload = list_workflow_payloads(tmp_path)

    assert payload["dataDir"] == str(tmp_path)
    assert payload["errors"] == []
    assert len(payload["workflows"]) == 1

    workflow = payload["workflows"][0]
    assert workflow["id"] == "daily"
    assert workflow["name"] == "Daily"
    assert workflow["sourcePath"] == str(workflow_path)
    assert [node["id"] for node in workflow["nodes"]] == ["collect", "summarize"]
    assert workflow["nodes"][0]["meta"] == "echo hello"
    assert workflow["nodes"][0]["operation"]["command"] == "echo hello"
    assert workflow["nodes"][0]["settings"]["pipeOutput"] is True
    assert workflow["edges"] == [
        {
            "id": "collect-summarize-0",
            "from": "collect",
            "to": "summarize",
            "label": "on success",
            "condition": "on_success",
            "outputPattern": None,
        }
    ]


def test_list_workflow_payloads_reports_invalid_workflows(tmp_path: Path) -> None:
    (tmp_path / "broken.toml").write_text("[workflow]\nid = 1\n")

    payload = list_workflow_payloads(tmp_path)

    assert len(payload["workflows"]) == 1
    workflow = payload["workflows"][0]
    assert workflow["id"] == "broken"
    assert workflow["name"] == "Broken"
    assert workflow["invalid"] is True
    assert workflow["status"] == "Error"
    assert workflow["sourcePath"] == str(tmp_path / "broken.toml")
    assert workflow["validationError"]
    assert payload["errors"][0]["path"] == str(tmp_path / "broken.toml")


def test_list_workflow_payloads_includes_empty_workflows(tmp_path: Path) -> None:
    (tmp_path / "empty-with-agent.toml").write_text(
        """
[workflow]
id = "empty-with-agent"
name = "Empty With Agent"

[agents.codex_agent]
subscription = "codex"
working_dir = "."
""".strip()
    )

    payload = list_workflow_payloads(tmp_path)

    assert len(payload["workflows"]) == 1
    workflow = payload["workflows"][0]
    assert workflow["id"] == "empty-with-agent"
    assert workflow["name"] == "Empty With Agent"
    assert workflow["nodes"] == []
    assert workflow["edges"] == []


def test_create_workflow_payload_writes_real_workflow(tmp_path: Path) -> None:
    workflow = create_workflow_payload("My New Workflow!", tmp_path)

    assert workflow["id"] == "my-new-workflow"
    assert workflow["name"] == "My New Workflow!"
    assert workflow["nodes"] == []
    assert workflow["edges"] == []
    assert [saved["id"] for saved in list_workflow_payloads(tmp_path)["workflows"]] == [
        "my-new-workflow"
    ]


def test_create_workflow_payload_rejects_blank_name(tmp_path: Path) -> None:
    with pytest.raises(WorkflowCreateError):
        create_workflow_payload("   ", tmp_path)


def test_create_workflow_payload_rejects_existing_workflow(tmp_path: Path) -> None:
    create_workflow_payload("Duplicate", tmp_path)

    with pytest.raises(WorkflowAlreadyExistsError):
        create_workflow_payload("Duplicate", tmp_path)


def test_import_workflow_payload_writes_toml(tmp_path: Path) -> None:
    workflow = import_workflow_payload(
        """
[workflow]
id = "imported"
name = "Imported"

[[nodes]]
id = "hello"
type = "bash_command"
command = "echo hello"
""".strip(),
        tmp_path,
    )

    assert workflow["id"] == "imported"
    assert (tmp_path / "imported.toml").exists()


def test_rename_workflow_payload_updates_label_without_changing_id(tmp_path: Path) -> None:
    create_workflow_payload("Original", tmp_path)

    renamed = rename_workflow_payload("original", "Better Name", tmp_path)

    assert renamed["id"] == "original"
    assert renamed["name"] == "Better Name"
    assert (tmp_path / "original.toml").exists()
    assert 'name = "Better Name"' in (tmp_path / "original.toml").read_text()


def test_duplicate_workflow_payload_creates_copy(tmp_path: Path) -> None:
    workflow = create_workflow_payload("Original", tmp_path)
    workflow["nodes"] = [
        {
            "id": "hello",
            "type": "bash_command",
            "operation": {
                "type": "bash_command",
                "command": "echo hello",
            },
            "settings": {},
        }
    ]
    update_workflow_payload("original", workflow, tmp_path)

    source_text = (tmp_path / "original.toml").read_text()
    duplicated = duplicate_workflow_payload("original", None, tmp_path)

    assert duplicated["id"] == "original-2"
    assert duplicated["name"] == "Original-2"
    assert (tmp_path / "original.toml").exists()
    duplicate_text = (tmp_path / "original-2.toml").read_text()
    assert duplicate_text == source_text.replace(
        'id = "original"',
        'id = "original-2"',
        1,
    ).replace('name = "Original"', 'name = "Original-2"', 1)
    assert duplicated["nodes"][0]["id"] == "hello"


def test_delete_workflow_payload_removes_toml_and_logs(tmp_path: Path) -> None:
    create_workflow_payload("Delete Me", tmp_path)
    log_dir = tmp_path / "logs" / "delete-me"
    log_dir.mkdir(parents=True)
    (log_dir / "2026-06-13T10-00-00-0400.log").write_text("old run\n")
    chat_prompt_path = workflow_chat_prompt_path(tmp_path, "delete-me")
    chat_prompt_path.parent.mkdir(parents=True)
    chat_prompt_path.write_text("old chat prompt\n")

    result = delete_workflow_payload("delete-me", tmp_path)

    assert result == {"workflowId": "delete-me", "deleted": True}
    assert not (tmp_path / "delete-me.toml").exists()
    assert not log_dir.exists()
    assert not chat_prompt_path.exists()


def test_delete_workflow_chat_payload_removes_prompt_handoff_file(tmp_path: Path) -> None:
    chat_prompt_path = workflow_chat_prompt_path(tmp_path, "chatty")
    chat_prompt_path.parent.mkdir(parents=True)
    chat_prompt_path.write_text("old chat prompt\n")

    result = delete_workflow_chat_payload("chatty", tmp_path)

    assert result == {"workflowId": "chatty", "deleted": True}
    assert not chat_prompt_path.exists()


def test_update_workflow_payload_persists_nodes_edges_and_agents(tmp_path: Path) -> None:
    workflow = create_workflow_payload("Autosave", tmp_path)
    workflow["agents"] = {
        "reviewer": {
            "agent_id": "reviewer",
            "subscription": "codex",
            "working_dir": ".",
            "prompt_path": "prompts/reviewer.md",
            "tools": ["Read"],
            "mcp_servers": [],
            "env": {"MODE": "review"},
        }
    }
    workflow["nodes"] = [
        {
            "id": "collect",
            "type": "bash_command",
            "operation": {
                "type": "bash_command",
                "command": "git diff --stat",
                "env": {"A": "1"},
            },
            "settings": {
                "pipeOutput": True,
                "retryCount": 1,
                "retryDelaySeconds": 2,
                "timeoutSeconds": 30,
            },
        },
        {
            "id": "review",
            "type": "agent",
            "operation": {
                "type": "agent",
                "agent_id": "reviewer",
                "prompt_path": "prompts/reviewer.md",
                "working_dir": ".",
                "dynamic_count": 1,
                "input_mapping": {"diff": "collect.output"},
                "fan_source": None,
            },
            "settings": {},
        },
    ]
    workflow["edges"] = [
        {
            "from": "collect",
            "to": "review",
            "condition": "on_success",
            "outputPattern": None,
        }
    ]

    saved = update_workflow_payload("autosave", workflow, tmp_path)
    reloaded = list_workflow_payloads(tmp_path)["workflows"][0]

    assert saved["nodes"][0]["operation"]["command"] == "git diff --stat"
    assert reloaded["nodes"][0]["settings"]["pipeOutput"] is True
    assert reloaded["nodes"][0]["settings"]["timeoutSeconds"] == 30.0
    assert reloaded["nodes"][1]["operation"]["input_mapping"] == {"diff": "collect.output"}
    assert reloaded["agents"]["reviewer"]["subscription"] == "codex"
    assert reloaded["agents"]["reviewer"]["env"] == {"MODE": "review"}
    assert reloaded["edges"][0]["condition"] == "on_success"


def test_update_workflow_payload_persists_file_watcher(tmp_path: Path) -> None:
    workflow = create_workflow_payload("Watched", tmp_path)
    workflow["watch"] = {
        "path": "inputs",
        "glob": "*.txt",
        "recursive": True,
        "debounce_seconds": 0.5,
        "mode": "queue",
        "max_concurrency": 2,
    }

    saved = update_workflow_payload("watched", workflow, tmp_path)
    reloaded = list_workflow_payloads(tmp_path)["workflows"][0]

    assert saved["watch"] == workflow["watch"]
    assert reloaded["watch"] == workflow["watch"]
    assert "Watching inputs" in reloaded["description"]


def test_run_workflow_payload_supports_dry_run(tmp_path: Path) -> None:
    workflow = create_workflow_payload("Runnable", tmp_path)
    workflow["nodes"] = [
        {
            "id": "hello",
            "type": "bash_command",
            "operation": {
                "type": "bash_command",
                "command": "echo hello",
            },
            "settings": {},
        }
    ]
    update_workflow_payload("runnable", workflow, tmp_path)

    run = anyio.run(run_workflow_payload, "runnable", tmp_path, True)

    assert run["workflowId"] == "runnable"
    assert run["success"] is True
    assert Path(run["logPath"]).parent == tmp_path / "logs" / "runnable"
    assert run["nodeOutputs"]["hello"]["success"] is True


def test_run_workflow_payload_writes_node_output_to_log(tmp_path: Path) -> None:
    workflow = create_workflow_payload("Logged Runnable", tmp_path)
    workflow["nodes"] = [
        {
            "id": "hello",
            "type": "bash_command",
            "operation": {
                "type": "bash_command",
                "command": "echo hello",
            },
            "settings": {},
        }
    ]
    update_workflow_payload("logged-runnable", workflow, tmp_path)

    run = anyio.run(run_workflow_payload, "logged-runnable", tmp_path, False)

    assert run["success"] is True
    log_path = Path(run["logPath"])
    text = log_path.read_text()
    assert "hello - stdout:" in text
    assert "hello" in text
    assert "hello - node output:" in text


def test_stop_workflow_run_payload_reports_no_active_run(tmp_path: Path) -> None:
    result = stop_workflow_run_payload("not-running", tmp_path)

    assert result == {
        "workflowId": "not-running",
        "stopped": False,
        "message": "No active run",
    }


def test_stop_workflow_run_payload_stops_specific_running_log(tmp_path: Path) -> None:
    log_dir = tmp_path / "logs" / "stop-me"
    log_dir.mkdir(parents=True)
    run_id = "2026-06-17T12-00-00-0400.log"
    (log_dir / run_id).write_text(
        "2026-06-17T12:00:00-04:00 - stop-me started successfully\n",
        encoding="utf-8",
    )

    result = stop_workflow_run_payload("stop-me", tmp_path, run_id=run_id)

    assert result == {
        "workflowId": "stop-me",
        "runId": run_id,
        "stopped": True,
        "message": "Stop requested",
    }
    assert workflow_run_stop_path("stop-me", run_id, tmp_path).exists()


async def test_stop_workflow_run_payload_stops_active_run(tmp_path: Path) -> None:
    workflow = create_workflow_payload("Stop Me", tmp_path)
    workflow["nodes"] = [
        {
            "id": "sleep",
            "type": "bash_command",
            "operation": {
                "type": "bash_command",
                "command": "sleep 5",
            },
            "settings": {},
        }
    ]
    update_workflow_payload("stop-me", workflow, tmp_path)
    run_result = None

    async def run_workflow() -> None:
        nonlocal run_result
        run_result = await run_workflow_payload("stop-me", tmp_path, False)

    with anyio.fail_after(3):
        async with anyio.create_task_group() as tg:
            tg.start_soon(run_workflow)
            for _ in range(30):
                await anyio.sleep(0.05)
                stop_result = stop_workflow_run_payload("stop-me", tmp_path)
                if stop_result["stopped"]:
                    break
            else:  # pragma: no cover
                raise AssertionError("Run did not become active")

    assert run_result is not None
    assert run_result["success"] is False
    assert "stopped by user" in run_result["logText"] or "Process stopped by user" in run_result["logText"]


async def test_run_workflow_payload_allows_concurrent_runs(tmp_path: Path) -> None:
    workflow = create_workflow_payload("Concurrent", tmp_path)
    workflow["nodes"] = [
        {
            "id": "sleep",
            "type": "bash_command",
            "operation": {
                "type": "bash_command",
                "command": "sleep 5",
            },
            "settings": {},
        }
    ]
    update_workflow_payload("concurrent", workflow, tmp_path)
    run_results = []

    async def run_workflow() -> None:
        run_results.append(await run_workflow_payload("concurrent", tmp_path, False))

    with anyio.fail_after(4):
        async with anyio.create_task_group() as tg:
            tg.start_soon(run_workflow)
            tg.start_soon(run_workflow)
            for _ in range(40):
                await anyio.sleep(0.05)
                logs = list_workflow_run_logs_payload("concurrent", tmp_path)["runs"]
                if sum(run["status"] == "running" for run in logs) == 2:
                    break
            else:  # pragma: no cover
                raise AssertionError("Concurrent workflow runs did not both become active")
            stop_workflow_run_payload("concurrent", tmp_path)

    assert len(run_results) == 2
    assert all(run["success"] is False for run in run_results)
    assert len(list_workflow_run_logs_payload("concurrent", tmp_path)["runs"]) == 2


def test_latest_workflow_log_payload_reads_last_run(tmp_path: Path) -> None:
    workflow = create_workflow_payload("Latest Log", tmp_path)
    workflow["nodes"] = [
        {
            "id": "hello",
            "type": "bash_command",
            "operation": {
                "type": "bash_command",
                "command": "echo hello",
            },
            "settings": {},
        }
    ]
    update_workflow_payload("latest-log", workflow, tmp_path)
    anyio.run(run_workflow_payload, "latest-log", tmp_path, False)

    payload = latest_workflow_log_payload("latest-log", tmp_path)

    assert payload["logPath"]
    assert "latest-log started successfully" in payload["logText"]
    assert "hello" in payload["logText"]


def test_list_workflow_run_logs_payload_returns_runs_newest_first(tmp_path: Path) -> None:
    log_dir = tmp_path / "logs" / "history-flow"
    log_dir.mkdir(parents=True)
    first = log_dir / "2026-06-13T10-00-00-0400.log"
    second = log_dir / "2026-06-13T11-00-00-0400.log"
    first.write_text(
        "2026-06-13T10:00:00-04:00 - history-flow started successfully\n"
        "2026-06-13T10:00:00-04:00 - INFO - history-flow completed successfully\n"
    )
    second.write_text(
        "2026-06-13T11:00:00-04:00 - history-flow started successfully\n"
        "2026-06-13T11:00:00-04:00 - ERROR - history-flow failed due to bad\n"
    )

    payload = list_workflow_run_logs_payload("history-flow", tmp_path)

    assert [run["id"] for run in payload["runs"]] == [second.name, first.name]
    assert payload["runs"][0]["status"] == "error"
    assert payload["runs"][1]["status"] == "success"


def test_workflow_run_log_payload_reads_specific_run(tmp_path: Path) -> None:
    log_dir = tmp_path / "logs" / "history-flow"
    log_dir.mkdir(parents=True)
    run = log_dir / "2026-06-13T10-00-00-0400.log"
    run.write_text(
        "2026-06-13T10:00:00-04:00 - history-flow started successfully\n"
        "custom output\n"
        "2026-06-13T10:00:00-04:00 - INFO - history-flow completed successfully\n"
    )

    payload = workflow_run_log_payload("history-flow", run.name, tmp_path)

    assert payload["runId"] == run.name
    assert payload["status"] == "success"
    assert "custom output" in payload["logText"]


def test_list_workflow_payloads_uses_latest_run_status(tmp_path: Path) -> None:
    workflow = create_workflow_payload("Status Flow", tmp_path)
    workflow["nodes"] = [
        {
            "id": "hello",
            "type": "bash_command",
            "operation": {
                "type": "bash_command",
                "command": "echo hello",
            },
            "settings": {},
        }
    ]
    update_workflow_payload("status-flow", workflow, tmp_path)

    assert list_workflow_payloads(tmp_path)["workflows"][0]["status"] == "Ready"

    log_dir = tmp_path / "logs" / "status-flow"
    log_dir.mkdir(parents=True)
    (log_dir / "2026-06-13T10-00-00-0400.log").write_text(
        "2026-06-13T10:00:00-04:00 - status-flow started successfully\n"
        "2026-06-13T10:00:00-04:00 - INFO - dry_run=False\n"
    )

    assert list_workflow_payloads(tmp_path)["workflows"][0]["status"] == "Running"

    anyio.run(run_workflow_payload, "status-flow", tmp_path, False)

    assert list_workflow_payloads(tmp_path)["workflows"][0]["status"] == "Success"

    workflow["nodes"][0]["operation"]["command"] = "exit 2"
    update_workflow_payload("status-flow", workflow, tmp_path)
    anyio.run(run_workflow_payload, "status-flow", tmp_path, False)

    assert list_workflow_payloads(tmp_path)["workflows"][0]["status"] == "Error"
