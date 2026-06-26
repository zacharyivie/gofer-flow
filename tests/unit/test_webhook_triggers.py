from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from gofer.cli.main import app
from gofer.core.workflow import AgenticWorkflow
from gofer.ui.api import (
    WorkflowTriggerError,
    list_workflow_payloads,
    list_workflow_run_logs_payload,
    replay_workflow_trigger_payload,
    trigger_workflow_payload,
    update_workflow_payload,
    workflow_run_log_payload,
)

runner = CliRunner()


def _write_webhook_workflow(path: Path) -> None:
    path.write_text(
        """
[workflow]
id = "hooked"
name = "Hooked"

[workflow.webhooks.github]
enabled = true
token = "secret-token"
fanout_path = "payload.items"
source = "github"

[[nodes]]
id = "echo"
type = "bash_command"
command = 'printf "%s|%s|%s" "$ISSUE" "$EVENT" "$SOURCE"'

[nodes.inputs]
"env.ISSUE" = "{{trigger.payload.issue.number}}"
"env.EVENT" = "{{trigger.headers.x_github_event}}"
"env.SOURCE" = "{{trigger.source}}"
""".strip(),
        encoding="utf-8",
    )


def test_webhook_trigger_config_round_trips(tmp_path: Path) -> None:
    workflow_path = tmp_path / "hooked.toml"
    _write_webhook_workflow(workflow_path)

    workflow = AgenticWorkflow.from_file(workflow_path)
    trigger = workflow.config.webhooks["github"]

    assert trigger.enabled is True
    assert trigger.token == "secret-token"
    assert trigger.fanout_path == "payload.items"
    assert trigger.source == "github"

    saved = tmp_path / "saved.toml"
    workflow.to_file(saved)
    reloaded = AgenticWorkflow.from_file(saved)

    assert reloaded.config.webhooks["github"].enabled is True
    assert reloaded.config.webhooks["github"].token == "secret-token"


def test_update_workflow_payload_preserves_masked_webhook_token(tmp_path: Path) -> None:
    workflow_path = tmp_path / "hooked.toml"
    _write_webhook_workflow(workflow_path)
    payload = list_workflow_payloads(tmp_path)["workflows"][0]

    assert payload["webhooks"]["github"]["tokenConfigured"] is True
    assert "token" not in payload["webhooks"]["github"]

    update_workflow_payload("hooked", payload, tmp_path)

    reloaded = AgenticWorkflow.from_file(workflow_path)
    assert reloaded.config.webhooks["github"].token == "secret-token"


@pytest.mark.anyio
async def test_webhook_trigger_rejects_unauthorized_request(tmp_path: Path) -> None:
    _write_webhook_workflow(tmp_path / "hooked.toml")

    with pytest.raises(WorkflowTriggerError, match="Unauthorized"):
        await trigger_workflow_payload(
            "hooked",
            "github",
            tmp_path,
            payload={"issue": {"number": 7}},
            token="wrong",
        )


@pytest.mark.anyio
async def test_webhook_trigger_interpolates_payload_headers_and_saves_replay(
    tmp_path: Path,
) -> None:
    _write_webhook_workflow(tmp_path / "hooked.toml")

    result = await trigger_workflow_payload(
        "hooked",
        "github",
        tmp_path,
        payload={"issue": {"number": 42}, "items": [{"title": "first"}]},
        headers={
            "Authorization": "Bearer secret-token",
            "X-Gofer-Webhook-Token": "secret-token",
            "X-GitHub-Event": "issues",
        },
        source="github",
        token="secret-token",
    )

    run = result["run"]
    assert run["success"] is True
    assert run["nodeOutputs"]["echo"]["output"] == "42|issues|github"

    log_payload = workflow_run_log_payload("hooked", str(result["runId"]), tmp_path)
    assert "trigger=" in log_payload["logText"]
    assert '"requestId":' in log_payload["logText"]

    trigger_sidecar = tmp_path / "logs" / "hooked" / str(result["runId"])
    replay_payload = json.loads(trigger_sidecar.with_suffix(".trigger.json").read_text())
    assert replay_payload["payload"]["issue"]["number"] == 42
    assert replay_payload["headers"]["x_github_event"] == "issues"
    assert "authorization" not in replay_payload["headers"]
    assert "x_gofer_webhook_token" not in replay_payload["headers"]

    runs = list_workflow_run_logs_payload("hooked", tmp_path)["runs"]
    assert runs[0]["triggerType"] == "webhook"
    assert runs[0]["triggerId"] == "github"
    assert runs[0]["hasTriggerReplay"] is True


@pytest.mark.anyio
async def test_webhook_trigger_payload_array_feeds_trigger_event_fanout(
    tmp_path: Path,
) -> None:
    (tmp_path / "fanout.toml").write_text(
        """
[workflow]
id = "fanout"
name = "Fanout"

[workflow.webhooks.default]
enabled = true
fanout_path = "payload.items"

[[nodes]]
id = "events"
type = "loop"

[nodes.source]
type = "trigger_events"

[[nodes]]
id = "echo"
type = "bash_command"
command = 'printf "%s" "$TITLE"'

[nodes.inputs]
"env.TITLE" = "loop.title"

[[edges]]
from = "events"
to = "echo"
""".strip(),
        encoding="utf-8",
    )

    result = await trigger_workflow_payload(
        "fanout",
        "default",
        tmp_path,
        payload={"items": [{"title": "one"}, {"title": "two"}]},
    )

    assert result["run"]["nodeOutputs"]["events"]["data"]["count"] == 2
    assert "node output:\none" in result["run"]["logText"]
    assert "node output:\ntwo" in result["run"]["logText"]


@pytest.mark.anyio
async def test_webhook_trigger_replay_uses_saved_payload(tmp_path: Path) -> None:
    _write_webhook_workflow(tmp_path / "hooked.toml")
    original = await trigger_workflow_payload(
        "hooked",
        "github",
        tmp_path,
        payload={"issue": {"number": 9}, "items": []},
        headers={"X-GitHub-Event": "issues"},
        token="secret-token",
    )

    replay = await replay_workflow_trigger_payload(
        "hooked",
        str(original["runId"]),
        tmp_path,
        trigger_id="github",
    )

    assert replay["run"]["success"] is True
    assert replay["run"]["nodeOutputs"]["echo"]["output"] == "9|issues|replay:" + str(
        original["runId"]
    )


def test_workflow_trigger_cli_runs_webhook(tmp_path: Path) -> None:
    _write_webhook_workflow(tmp_path / "hooked.toml")

    result = runner.invoke(
        app,
        [
            "workflow",
            "trigger",
            "hooked",
            "--trigger-id",
            "github",
            "--payload-json",
            '{"issue":{"number":5},"items":[]}',
            "--header",
            "X-GitHub-Event: issues",
            "--token",
            "secret-token",
            "--data-dir",
            str(tmp_path),
        ],
    )

    assert result.exit_code == 0, result.output
    assert "Triggered hooked:github" in result.output
