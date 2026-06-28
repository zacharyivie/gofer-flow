from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from gofer.cli.main import app
from gofer.core.validation import validate_workflow_file
from gofer.core.workflow import AgenticWorkflow
from gofer.ui.api import WorkflowRunError, run_workflow_payload

runner = CliRunner()


def _write_workflow(tmp_path: Path, content: str, name: str = "workflow.toml") -> Path:
    path = tmp_path / name
    path.write_text(content.strip() + "\n", encoding="utf-8")
    return path


def test_canvas_group_metadata_round_trips_and_validates_node_refs(tmp_path: Path) -> None:
    workflow = _write_workflow(
        tmp_path,
        """
[workflow]
id = "grouped"
name = "Grouped"

[workflow.metadata.canvas]

[[workflow.metadata.canvas.groups]]
id = "phase-1"
label = "Phase 1"
color = "#2563eb"
node_ids = ["step"]
x = 12
y = 24
width = 420
height = 220
collapsed = true

[[nodes]]
id = "step"
type = "bash_command"
command = "echo hi"
""",
    )

    parsed = AgenticWorkflow.from_file(workflow)
    parsed.validate(workflow, tmp_path)
    parsed.to_file(workflow)

    data = workflow.read_text(encoding="utf-8")
    assert "[[workflow.metadata.canvas.groups]]" in data
    assert "node_ids = [" in data
    assert '"step"' in data

    invalid = _write_workflow(
        tmp_path,
        data.replace('"step"', '"missing"', 1),
        name="invalid.toml",
    )
    parsed_invalid = AgenticWorkflow.from_file(invalid)
    with pytest.raises(ValueError, match="Canvas group 'phase-1' references unknown node"):
        parsed_invalid.validate(invalid, tmp_path)


def test_validation_reports_missing_agent_prompt_and_script_paths(tmp_path: Path) -> None:
    workflow = _write_workflow(
        tmp_path,
        """
[workflow]
id = "validation-flow"
name = "Validation Flow"

[agents.writer]
subscription = "codex"
working_dir = "."
prompt_path = "missing-agent-prompt.md"

[[nodes]]
id = "agent"
type = "agent"
agent_id = "missing"
working_dir = "."
prompt_path = "missing-node-prompt.md"

[[nodes]]
id = "script"
type = "python_script"
script_path = "missing.py"
""",
    )

    report = validate_workflow_file(workflow, data_dir=tmp_path)
    diagnostics = {item.code: item for item in report.diagnostics}

    assert report.ok is False
    assert "workflow.agent_missing" in diagnostics
    assert any(item.code == "workflow.prompt_path_missing" for item in report.errors)
    assert any(item.code == "workflow.script_path_missing" for item in report.errors)
    assert any(fix.action == "create_agent" for item in report.errors for fix in item.fixes)
    assert any(fix.action == "create_prompt_file" for item in report.errors for fix in item.fixes)


def test_validation_warns_for_ungranted_managed_paths_outside_workflow_project(
    tmp_path: Path,
) -> None:
    workflow_dir = tmp_path / "project"
    external_dir = tmp_path / "external"
    workflow_dir.mkdir()
    external_dir.mkdir()
    (external_dir / "rows.csv").write_text("name\noutside\n")
    (external_dir / "template.md").write_text("Hello")
    (external_dir / "docs").mkdir()
    (external_dir / "docs" / "one.txt").write_text("outside")
    workflow = _write_workflow(
        workflow_dir,
        f"""
[workflow]
id = "access-validation"
name = "Access Validation"
filesystem_access = [
  {{ path = "{external_dir / "template.md"}", read = true, write = false }},
]

[[nodes]]
id = "tabular"
type = "loop"

[nodes.source]
type = "tabular"
path = "{external_dir / "rows.csv"}"

[[nodes]]
id = "prompt"
type = "prompt_file"
template_path = "{external_dir / "template.md"}"
output_path = "{external_dir / "out.md"}"

[[nodes]]
id = "vectorize"
type = "local_vectorize"
source_path = "{external_dir / "docs"}"
index_path = "{external_dir / "index.json"}"
""",
    )

    report = validate_workflow_file(workflow, data_dir=tmp_path)

    messages = "\n".join(item.message for item in report.warnings)
    assert "Tabular fan-out path" in messages
    assert "Prompt output path" in messages
    assert "Prompt template path" not in messages
    assert "Local vector source path" in messages
    assert "Local vector index path" in messages


def test_validation_warns_for_blocked_http_request_without_leaking_query(
    tmp_path: Path,
) -> None:
    workflow = _write_workflow(
        tmp_path,
        """
[workflow]
id = "network-validation"
name = "Network Validation"

[[nodes]]
id = "metadata"
type = "http_request"
url = "http://169.254.169.254/latest?token=secret"

[[nodes]]
id = "internal"
type = "http_request"
url = "http://10.1.2.3/status"
network_allowlist = ["10.0.0.0/8"]
""",
    )

    report = validate_workflow_file(workflow, data_dir=tmp_path)

    warnings = [item for item in report.warnings if item.code == "workflow.http_network_policy"]
    assert len(warnings) == 1
    assert warnings[0].target_id == "metadata"
    assert "blocked private or local address" in warnings[0].message
    assert "secret" not in warnings[0].message
    assert warnings[0].detail == {"networkAllowlist": []}


def test_validation_reports_invalid_edge_regex(tmp_path: Path) -> None:
    workflow = _write_workflow(
        tmp_path,
        """
[workflow]
id = "regex-flow"
name = "Regex Flow"

[[nodes]]
id = "one"
type = "pass"
message = "one"

[[nodes]]
id = "two"
type = "pass"
message = "two"

[[edges]]
from = "one"
to = "two"
condition = "output_matches"
output_pattern = "["
""",
    )

    report = validate_workflow_file(workflow, data_dir=tmp_path)

    assert any(item.code == "workflow.edge_regex_invalid" for item in report.errors)
    assert any(fix.action == "replace_edge_pattern" for item in report.errors for fix in item.fixes)


def test_validation_reports_invalid_cron_timezone_and_trigger_conflict(
    tmp_path: Path,
) -> None:
    workflow = _write_workflow(
        tmp_path,
        """
[workflow]
id = "trigger-flow"
name = "Trigger Flow"
run_continuously = true

[workflow.schedule]
cron_expression = "not a cron"
timezone = "Mars/Olympus"

[workflow.watch]
path = "missing-watch-dir"
glob = "*.py"

[[nodes]]
id = "start"
type = "pass"
message = "ok"
""",
    )

    report = validate_workflow_file(workflow, data_dir=tmp_path)
    codes = {item.code for item in report.diagnostics}

    assert "workflow.schedule_cron_invalid" in codes
    assert "workflow.schedule_timezone_invalid" in codes
    assert "workflow.watch_path_missing" in codes
    assert "workflow.trigger_conflict" in codes
    assert any(item.severity == "warning" for item in report.diagnostics)


def test_validation_marks_raw_webhook_replay_payload_retention_high_risk(
    tmp_path: Path,
) -> None:
    workflow = _write_workflow(
        tmp_path,
        """
[workflow]
id = "raw-webhook"
name = "Raw Webhook"

[workflow.webhooks.default]
enabled = true
allow_unauthenticated = true
store_raw_payload = true

[[nodes]]
id = "start"
type = "pass"
message = "ok"
""",
    )

    report = validate_workflow_file(workflow, data_dir=tmp_path)
    warning = next(
        item for item in report.warnings if item.code == "workflow.webhook_raw_payload_retention"
    )

    assert warning.target_type == "trigger"
    assert warning.target_id == "default"
    assert warning.field == "storeRawPayload"
    assert warning.detail == {
        "risk": "high",
        "replayPayloadRetention": "raw",
        "storeRawPayload": True,
    }


def test_validation_rejects_enabled_webhook_without_authentication(
    tmp_path: Path,
) -> None:
    workflow = _write_workflow(
        tmp_path,
        """
[workflow]
id = "missing-webhook-auth"
name = "Missing Webhook Auth"

[workflow.webhooks.default]
enabled = true

[[nodes]]
id = "start"
type = "pass"
message = "ok"
""",
    )

    report = validate_workflow_file(workflow, data_dir=tmp_path)
    error = next(
        item for item in report.errors if item.code == "workflow.webhook_authentication_missing"
    )

    assert report.ok is False
    assert error.target_type == "trigger"
    assert error.target_id == "default"
    assert error.detail == {
        "risk": "high",
        "authentication": "none",
        "tokenConfigured": False,
        "allowUnauthenticated": False,
    }


def test_validation_marks_explicit_unauthenticated_webhook_high_risk(
    tmp_path: Path,
) -> None:
    workflow = _write_workflow(
        tmp_path,
        """
[workflow]
id = "local-webhook"
name = "Local Webhook"

[workflow.webhooks.default]
enabled = true
allow_unauthenticated = true

[[nodes]]
id = "start"
type = "pass"
message = "ok"
""",
    )

    report = validate_workflow_file(workflow, data_dir=tmp_path)
    warning = next(
        item for item in report.warnings if item.code == "workflow.webhook_unauthenticated_allowed"
    )

    assert report.ok is True
    assert warning.target_id == "default"
    assert warning.field == "allowUnauthenticated"
    assert warning.detail == {
        "risk": "high",
        "authentication": "none",
        "tokenConfigured": False,
        "allowUnauthenticated": True,
    }


def test_validation_reports_notification_channel_config(tmp_path: Path) -> None:
    workflow = _write_workflow(
        tmp_path,
        """
[workflow]
id = "notify-config"
name = "Notify Config"

[[nodes]]
id = "slack"
type = "notification"
channel = "slack"

[[nodes]]
id = "email"
type = "notification"
channel = "email"
email_to = ["ops@example.test"]
""",
    )

    report = validate_workflow_file(workflow)

    errors = {(item.code, item.target_id, item.field) for item in report.errors}
    assert (
        "workflow.notification_webhook_url_missing",
        "slack",
        "operation.webhook_url",
    ) in errors
    assert (
        "workflow.notification_email_config_missing",
        "email",
        "operation.smtp_host",
    ) in errors
    assert (
        "workflow.notification_email_config_missing",
        "email",
        "operation.email_from",
    ) in errors


def test_validation_reports_dangling_edge_with_remove_fix(tmp_path: Path) -> None:
    workflow = _write_workflow(
        tmp_path,
        """
[workflow]
id = "dangling-flow"
name = "Dangling Flow"

[[nodes]]
id = "one"
type = "pass"
message = "one"

[[edges]]
from = "one"
to = "missing"
""",
    )

    report = validate_workflow_file(workflow, data_dir=tmp_path)

    assert any(item.code == "workflow.edge_dangling" for item in report.errors)
    assert any(fix.action == "remove_edge" for item in report.errors for fix in item.fixes)


def test_workflow_validate_json_outputs_structured_diagnostics(tmp_path: Path) -> None:
    workflow = _write_workflow(
        tmp_path,
        """
[workflow]
id = "cli-validation-flow"
name = "CLI Validation Flow"

[[nodes]]
id = "script"
type = "shell_script"
script_path = "missing.sh"
""",
    )

    result = runner.invoke(app, ["workflow", "validate", str(workflow), "--json"])

    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert payload["errors"][0]["code"] == "workflow.script_path_missing"
    assert payload["errors"][0]["targetType"] == "node"


def test_workflow_validation_reports_secret_readiness(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("GOFER_SECRET_API_TOKEN", raising=False)
    monkeypatch.delenv("API_TOKEN", raising=False)
    workflow = _write_workflow(
        tmp_path,
        """
[workflow]
id = "secret-validation-flow"
name = "Secret Validation Flow"

[[nodes]]
id = "notify"
type = "notification"
body = "Token {{secret.API_TOKEN}}"
""",
    )

    report = validate_workflow_file(workflow, data_dir=tmp_path)

    readiness = next(item for item in report.warnings if item.code == "workflow.secret_readiness")
    assert "API_TOKEN" in readiness.message
    assert readiness.detail == {
        "secretReadiness": [
            {
                "name": "API_TOKEN",
                "status": "missing",
                "present": False,
                "sources": ["node:notify"],
                "envNames": ["GOFER_SECRET_API_TOKEN", "API_TOKEN"],
            }
        ]
    }


def test_api_run_blocks_structurally_invalid_workflow(tmp_path: Path) -> None:
    _write_workflow(
        tmp_path,
        """
[workflow]
id = "blocked-flow"
name = "Blocked Flow"

[[nodes]]
id = "one"
type = "pass"
message = "one"

[[nodes]]
id = "two"
type = "pass"
message = "two"

[[edges]]
from = "one"
to = "two"
condition = "output_matches"
output_pattern = "["
""",
        name="blocked-flow.toml",
    )

    try:
        import anyio

        anyio.run(run_workflow_payload, "blocked-flow", tmp_path)
    except WorkflowRunError as exc:
        assert "Workflow validation failed" in str(exc)
    else:  # pragma: no cover - explicit failure branch
        raise AssertionError("invalid workflow run was not blocked")
