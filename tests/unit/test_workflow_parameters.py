from __future__ import annotations

import json
from pathlib import Path

import anyio
from typer.testing import CliRunner

from gofer.cli.main import app
from gofer.core.executor import WorkflowExecutor
from gofer.core.graph import GraphNode
from gofer.core.operations import BashCommandOperation, OperationType
from gofer.core.workflow import (
    AgenticWorkflow,
    ScheduleConfig,
    WatchConfig,
    WorkflowConfig,
    WorkflowParameterConfig,
    masked_workflow_parameters,
    resolve_workflow_parameters,
)
from gofer.ui.api import WorkflowRunError, run_workflow_payload, workflow_plan_payload

runner = CliRunner()


def test_legacy_dashboard_nodes_are_removed_with_attached_edges() -> None:
    workflow = AgenticWorkflow.from_dict(
        {
            "workflow": {"id": "legacy", "name": "Legacy"},
            "nodes": [
                {"id": "start", "type": "pass", "message": "start"},
                {
                    "id": "retired",
                    "type": "dashboard_item",
                    "dashboard": "old",
                    "component": "items",
                },
                {"id": "finish", "type": "pass", "message": "finish"},
            ],
            "edges": [
                {"from": "start", "to": "retired"},
                {"from": "retired", "to": "finish"},
                {"from": "start", "to": "finish"},
            ],
        }
    )

    assert [node.node_id for node in workflow.graph.nodes_in_order()] == ["start", "finish"]
    assert list(workflow.graph._graph.edges()) == [("start", "finish")]


def test_workflow_parameters_parse_validate_and_serialize(tmp_path: Path) -> None:
    path = tmp_path / "params.toml"
    path.write_text(
        """
[workflow]
id = "params-flow"
name = "Params Flow"

[workflow.parameters.customer_id]
type = "string"
required = true
pattern = "^[A-Z]+-[0-9]+$"

[workflow.parameters.retries]
type = "number"
default = 2
min = 1
max = 5

[workflow.parameters.api_token]
type = "secret"
required = true

[workflow.schedule]
cron_expression = "0 9 * * *"
timezone = "UTC"

[workflow.schedule.params]
customer_id = "ACME-1"
api_token = "secret:API_TOKEN"

[[nodes]]
id = "start"
type = "pass"
message = "{{params.customer_id}}"
""".strip(),
        encoding="utf-8",
    )

    workflow = AgenticWorkflow.from_file(path)
    params = resolve_workflow_parameters(
        workflow.config,
        {"api_token": "plain-token"},
        workflow.config.schedule.params if workflow.config.schedule else {},
    )

    assert params == {
        "customer_id": "ACME-1",
        "retries": 2.0,
        "api_token": "plain-token",
    }
    assert masked_workflow_parameters(workflow.config, params)["api_token"] == "***"

    saved = tmp_path / "saved.toml"
    workflow.to_file(saved)
    round_trip = AgenticWorkflow.from_file(saved)

    assert round_trip.config.parameters["customer_id"].required is True
    assert round_trip.config.schedule is not None
    assert round_trip.config.schedule.params["customer_id"] == "ACME-1"


def test_workflow_parameter_validation_rejects_missing_unknown_and_invalid() -> None:
    config = WorkflowConfig(
        id="params",
        name="Params",
        parameters={
            "kind": WorkflowParameterConfig(type="enum", choices=["daily", "weekly"]),
            "count": WorkflowParameterConfig(type="number", min=1, max=3, required=True),
        },
    )

    for provided, field_path, expected_type, detail in [
        ({}, "inputs.count", "number", "missing required workflow input 'count'"),
        (
            {"count": 2, "extra": "x"},
            "inputs.extra",
            "declared workflow input name",
            "unknown workflow input(s): extra",
        ),
        (
            {"count": "bogus", "kind": "daily"},
            "inputs.count",
            "number",
            "must be a valid number",
        ),
        ({"count": 4, "kind": "daily"}, "inputs.count", "number", "must be <= 3"),
        ({"count": 2, "kind": "monthly"}, "inputs.kind", "enum", "must be one of"),
    ]:
        try:
            resolve_workflow_parameters(config, provided)
        except ValueError as exc:
            diagnostic = str(exc)
            assert "Workflow 'params' invocation 'preflight'" in diagnostic
            assert "node '<invocation>'" in diagnostic
            assert f"field '{field_path}'" in diagnostic
            assert f"expected type '{expected_type}'" in diagnostic
            assert detail in diagnostic
            assert "workflow parameter" not in diagnostic.lower()
        else:
            raise AssertionError("input validation unexpectedly passed")


def test_executor_interpolates_params_in_command_input_and_dynamic_count(
    tmp_path: Path,
) -> None:
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="param-run",
            name="Param Run",
            parameters={
                "name": WorkflowParameterConfig(type="string", required=True),
                "count": WorkflowParameterConfig(type="number", required=True),
            },
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="echo",
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command="printf '%s' '{{params.name}}'",
            ),
        )
    )

    result = anyio.run(
        WorkflowExecutor(
            workflow,
            {},
            log_base_dir=tmp_path / "logs",
        )
        .with_parameters({"name": "report", "count": 2})
        .run
    )

    assert result.success is True
    assert result.node_outputs["echo"].output == "report"
    assert result.parameters == {"name": "report", "count": 2.0}


def test_cli_run_accepts_params_and_fails_when_required_missing(tmp_path: Path) -> None:
    workflow_path = tmp_path / "cli.toml"
    workflow_path.write_text(
        """
[workflow]
id = "cli-params"
name = "CLI Params"

[workflow.parameters.message]
type = "string"
required = true

[[nodes]]
id = "echo"
type = "bash_command"
command = "printf '%s' '{{params.message}}'"
""".strip(),
        encoding="utf-8",
    )

    missing = runner.invoke(app, ["workflow", "run", str(workflow_path)])
    assert missing.exit_code == 1
    diagnostic = " ".join(missing.output.split())
    assert "missing required workflow input 'message'" in diagnostic
    assert "field 'inputs.message'" in diagnostic
    assert "expected type 'string'" in diagnostic

    result = runner.invoke(
        app,
        ["workflow", "run", str(workflow_path), "--param", "message=hello", "--verbose"],
    )
    assert result.exit_code == 0
    assert "hello" in result.output


def test_ui_api_validates_params_and_masks_secret_run_metadata(tmp_path: Path) -> None:
    (tmp_path / "api-params.toml").write_text(
        """
[workflow]
id = "api-params"
name = "API Params"

[workflow.parameters.report_date]
type = "date"
required = true

[workflow.parameters.token]
type = "secret"
required = true

[[nodes]]
id = "start"
type = "pass"
message = "{{params.report_date}}"
""".strip(),
        encoding="utf-8",
    )

    try:
        anyio.run(run_workflow_payload, "api-params", tmp_path)
    except WorkflowRunError as exc:
        assert "missing required workflow input 'report_date'" in str(exc)
        assert "field 'inputs.report_date'" in str(exc)
        assert "expected type 'date'" in str(exc)
    else:
        raise AssertionError("run without required parameters unexpectedly passed")

    plan = workflow_plan_payload(
        "api-params",
        tmp_path,
        parameters={"report_date": "2026-06-26", "token": "clear-secret"},
    )
    assert plan["parameters"] == {"report_date": "2026-06-26", "token": "***"}

    run = anyio.run(
        run_workflow_payload,
        "api-params",
        tmp_path,
        False,
        None,
        {"report_date": "2026-06-26", "token": "clear-secret"},
    )
    assert run["success"] is True
    assert run["parameters"] == {"report_date": "2026-06-26", "token": "***"}
    assert "clear-secret" not in Path(tmp_path, run["logPath"]).read_text(encoding="utf-8")


def test_ui_plan_allows_missing_required_params_for_preview(tmp_path: Path) -> None:
    (tmp_path / "api-params-preview.toml").write_text(
        """
[workflow]
id = "api-params-preview"
name = "API Params Preview"

[workflow.parameters.report_date]
type = "date"
required = true

[workflow.parameters.token]
type = "secret"
required = true

[[nodes]]
id = "start"
type = "pass"
message = "{{params.report_date}}"
""".strip(),
        encoding="utf-8",
    )

    plan = workflow_plan_payload(
        "api-params-preview",
        tmp_path,
        parameters={"report_date": "", "token": ""},
    )

    assert plan["workflowId"] == "api-params-preview"
    assert plan["validation"]["ok"] is True
    assert plan["parameters"] == {}


def test_cli_plan_accepts_params_json_and_masks_secret(tmp_path: Path) -> None:
    workflow_path = tmp_path / "cli-plan.toml"
    workflow_path.write_text(
        """
[workflow]
id = "cli-plan-params"
name = "CLI Plan Params"

[workflow.parameters.message]
type = "string"
required = true

[workflow.parameters.token]
type = "secret"
required = true

[[nodes]]
id = "echo"
type = "pass"
message = "{{params.message}}"
""".strip(),
        encoding="utf-8",
    )

    result = runner.invoke(
        app,
        [
            "workflow",
            "plan",
            str(workflow_path),
            "--json",
            "--params-json",
            '{"message":"hello","token":"clear-secret"}',
        ],
    )

    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["parameters"] == {"message": "hello", "token": "***"}
    assert "clear-secret" not in result.output


def test_cli_plan_allows_missing_required_params(tmp_path: Path) -> None:
    workflow_path = tmp_path / "cli-plan-missing.toml"
    workflow_path.write_text(
        """
[workflow]
id = "cli-plan-missing"
name = "CLI Plan Missing"

[workflow.parameters.message]
type = "string"
required = true

[[nodes]]
id = "echo"
type = "pass"
message = "{{params.message}}"
""".strip(),
        encoding="utf-8",
    )

    result = runner.invoke(app, ["workflow", "plan", str(workflow_path), "--json"])

    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["workflowId"] == "cli-plan-missing"
    assert payload["parameters"] == {}


def test_schedule_and_watch_store_parameter_defaults() -> None:
    config = WorkflowConfig(
        id="defaults",
        name="Defaults",
        schedule=ScheduleConfig(
            cron_expression="0 9 * * *",
            params={"report_date": "2026-06-26"},
        ),
        watch=WatchConfig(path=Path("incoming"), params={"customer": "ACME"}),
    )

    assert config.schedule is not None
    assert config.schedule.params["report_date"] == "2026-06-26"
    assert config.watch is not None
    assert config.watch.params["customer"] == "ACME"
