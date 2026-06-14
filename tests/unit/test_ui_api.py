from __future__ import annotations

from pathlib import Path

import anyio
import pytest

from gofer.ui.api import (
    WorkflowAlreadyExistsError,
    WorkflowCreateError,
    create_workflow_payload,
    delete_workflow_payload,
    import_workflow_payload,
    latest_workflow_log_payload,
    list_workflow_payloads,
    run_workflow_payload,
    update_workflow_payload,
)


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

    assert payload["workflows"] == []
    assert payload["errors"][0]["path"] == str(tmp_path / "broken.toml")


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


def test_delete_workflow_payload_removes_toml(tmp_path: Path) -> None:
    create_workflow_payload("Delete Me", tmp_path)

    result = delete_workflow_payload("delete-me", tmp_path)

    assert result == {"workflowId": "delete-me", "deleted": True}
    assert not (tmp_path / "delete-me.toml").exists()


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
