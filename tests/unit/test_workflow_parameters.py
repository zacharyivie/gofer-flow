from __future__ import annotations

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

    for provided, message in [
        ({}, "Missing required workflow parameter: count"),
        ({"count": 2, "extra": "x"}, "Unknown workflow parameter"),
        ({"count": 4, "kind": "daily"}, "must be <= 3"),
        ({"count": 2, "kind": "monthly"}, "must be one of"),
    ]:
        try:
            resolve_workflow_parameters(config, provided)
        except ValueError as exc:
            assert message in str(exc)
        else:
            raise AssertionError("parameter validation unexpectedly passed")


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
    assert "Missing required workflow parameter: message" in missing.output

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
        assert "Missing required workflow parameter: report_date" in str(exc)
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
