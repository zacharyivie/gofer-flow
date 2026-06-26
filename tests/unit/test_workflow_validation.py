from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from gofer.cli.main import app
from gofer.core.validation import validate_workflow_file
from gofer.ui.api import WorkflowRunError, run_workflow_payload

runner = CliRunner()


def _write_workflow(tmp_path: Path, content: str, name: str = "workflow.toml") -> Path:
    path = tmp_path / name
    path.write_text(content.strip() + "\n", encoding="utf-8")
    return path


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
    assert any(
        fix.action == "create_agent"
        for item in report.errors
        for fix in item.fixes
    )
    assert any(
        fix.action == "create_prompt_file"
        for item in report.errors
        for fix in item.fixes
    )


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
    assert any(
        fix.action == "replace_edge_pattern"
        for item in report.errors
        for fix in item.fixes
    )


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
    assert any(
        fix.action == "remove_edge"
        for item in report.errors
        for fix in item.fixes
    )


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
