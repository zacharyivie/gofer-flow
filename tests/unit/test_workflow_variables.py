from __future__ import annotations

from pathlib import Path

import pytest

from gofer.core.executor import ResumeOptions, WorkflowExecutor
from gofer.core.graph import GraphNode
from gofer.core.operations import (
    BashCommandOperation,
    CountFanSource,
    HttpRequestOperation,
    LocalSearchOperation,
    LoopOperation,
    NotificationOperation,
    OperationType,
    PassOperation,
    WriteFileOperation,
)
from gofer.core.workflow import (
    AgenticWorkflow,
    WorkflowConfig,
    WorkflowParameterConfig,
    WorkflowVariableConfig,
    resolve_workflow_parameters,
)


def test_removed_set_variable_operation_is_rejected() -> None:
    with pytest.raises(ValueError, match="set_variable"):
        AgenticWorkflow.from_dict(
            {
                "workflow": {"id": "removed", "name": "Removed"},
                "nodes": [
                    {
                        "id": "mutate",
                        "type": "set_variable",
                        "name": "attempt",
                        "value": 2,
                    }
                ],
            }
        )

def test_inputs_and_variables_round_trip_with_legacy_parameters(tmp_path: Path) -> None:
    source = tmp_path / "scope.toml"
    source.write_text(
        """
[workflow]
id = "scope"
name = "Scope"

[workflow.inputs.project_dir]
type = "path"
required = true
description = "Project to inspect"

[workflow.variables]
attempt = 1

[[nodes]]
id = "test"
type = "bash_command"
command = "pwd"
working_dir = "{{inputs.project_dir}}"
""".strip(),
        encoding="utf-8",
    )

    workflow = AgenticWorkflow.from_file(source)

    assert workflow.config.inputs["project_dir"].type == "path"
    assert workflow.config.variables["attempt"].initial == 1
    assert resolve_workflow_parameters(workflow.config, {"project_dir": tmp_path}) == {
        "project_dir": str(tmp_path)
    }

    output = tmp_path / "round-trip.toml"
    workflow.to_file(output)
    loaded = AgenticWorkflow.from_file(output)
    assert loaded.config.inputs == workflow.config.inputs
    assert loaded.config.variables == workflow.config.variables


def test_secret_taint_requires_secret_derived_variables() -> None:
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="secret-taint",
            name="Secret Taint",
            inputs={
                "token": WorkflowParameterConfig(type="secret", required=True),
                "suffix": WorkflowParameterConfig(default="visible"),
            },
            variables={
                "derived": WorkflowVariableConfig(
                    type="string", initial="{{inputs.token}}-{{inputs.suffix}}"
                )
            },
        )
    )

    with pytest.raises(ValueError, match="must declare secret = true"):
        workflow.validate()


def test_invalid_runtime_config_literals_fail_during_validation() -> None:
    with pytest.raises(ValueError, match="channel must be"):
        NotificationOperation(type=OperationType.NOTIFICATION, channel="bogus")
    with pytest.raises(ValueError, match="expected_statuses"):
        HttpRequestOperation(
            type=OperationType.HTTP_REQUEST,
            url="https://example.test",
            expected_statuses="bogus",
        )

    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="runtime-config-references",
            name="Runtime Config References",
            inputs={
                "channel": WorkflowParameterConfig(default="desktop"),
            },
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="notify",
            operation=NotificationOperation(
                type=OperationType.NOTIFICATION,
                channel="{{inputs.channel}}",
            ),
        )
    )
    workflow.validate()


def test_exact_references_parse_in_typed_and_fanout_operation_fields() -> None:
    write = WriteFileOperation(
        type=OperationType.WRITE_FILE,
        path=Path("result.txt"),
        create_dirs="{{inputs.create_dirs}}",
        overwrite="{{inputs.overwrite}}",
    )
    search = LocalSearchOperation(
        type=OperationType.LOCAL_SEARCH,
        index_path=Path("index.json"),
        query="query",
        top_k="{{inputs.top_k}}",
        score_threshold="{{inputs.threshold}}",
        include_snippets="{{inputs.snippets}}",
    )
    loop = LoopOperation(
        type=OperationType.LOOP,
        source=CountFanSource(
            type="count",
            count="{{inputs.count}}",
            max_concurrency="{{inputs.workers}}",
            fail_fast="{{inputs.fail_fast}}",
        ),
    )
    notification = NotificationOperation(
        type=OperationType.NOTIFICATION,
        headers="{{inputs.headers}}",
        payload="{{inputs.payload}}",
    )
    http = HttpRequestOperation(
        type=OperationType.HTTP_REQUEST,
        url="https://example.test",
        json="{{inputs.payload}}",
    )

    assert str(write.create_dirs) == "{{inputs.create_dirs}}"
    assert str(search.top_k) == "{{inputs.top_k}}"
    assert str(loop.source.max_concurrency) == "{{inputs.workers}}"
    assert str(notification.headers) == "{{inputs.headers}}"
    assert notification.payload == "{{inputs.payload}}"
    assert http.json_payload == "{{inputs.payload}}"


@pytest.mark.anyio
async def test_typed_operation_references_resolve_and_revalidate_before_execution(
    tmp_path: Path,
) -> None:
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="typed-operation-references",
            name="Typed Operation References",
            inputs={
                "create_dirs": WorkflowParameterConfig(type="boolean", required=True),
                "overwrite": WorkflowParameterConfig(type="boolean", required=True),
                "count": WorkflowParameterConfig(type="number", required=True),
                "workers": WorkflowParameterConfig(type="number", required=True),
                "fail_fast": WorkflowParameterConfig(type="boolean", required=True),
            },
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="write",
            operation=WriteFileOperation(
                type=OperationType.WRITE_FILE,
                path=Path("nested/result.txt"),
                content="resolved",
                create_dirs="{{inputs.create_dirs}}",
                overwrite="{{inputs.overwrite}}",
            ),
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="loop",
            operation=LoopOperation(
                type=OperationType.LOOP,
                source=CountFanSource(
                    type="count",
                    count="{{inputs.count}}",
                    max_concurrency="{{inputs.workers}}",
                    fail_fast="{{inputs.fail_fast}}",
                ),
            ),
        )
    )

    result = (
        await WorkflowExecutor(
            workflow,
            {},
            log_base_dir=tmp_path / "logs",
            workflow_path=tmp_path / "workflow.toml",
        )
        .with_parameters(
            {
                "create_dirs": True,
                "overwrite": False,
                "count": 2,
                "workers": 3,
                "fail_fast": True,
            }
        )
        .run()
    )

    assert result.success
    assert (tmp_path / "nested" / "result.txt").read_text(encoding="utf-8") == "resolved"
    assert result.node_outputs["loop"].data["max_concurrency"] == 3
    assert result.node_outputs["loop"].data["fail_fast"] is True


@pytest.mark.anyio
async def test_declared_direct_secret_variable_is_redacted_everywhere(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GOFER_SECRET_API_TOKEN", "direct-secret-314")
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="direct-secret-safe",
            name="Direct Secret Safe",
            variables={
                "token": WorkflowVariableConfig(
                    type="string",
                    initial="{{secret.API_TOKEN}}",
                    secret=True,
                )
            },
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="echo",
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command='printf "%s" "{{vars.token}}"',
            ),
        )
    )

    result = await WorkflowExecutor(
        workflow, {}, log_base_dir=tmp_path / "logs", data_dir=tmp_path
    ).run()

    assert result.variables == {"token": "***"}
    assert result.node_outputs["echo"].output == "***"
    for artifact in tmp_path.rglob("*"):
        if artifact.is_file():
            assert b"direct-secret-314" not in artifact.read_bytes()


@pytest.mark.anyio
async def test_generic_for_each_resolves_runtime_execution_settings(
    tmp_path: Path,
) -> None:
    source = tmp_path / "runtime-for-each.toml"
    source.write_text(
        """
[workflow]
id = "runtime-for-each"
name = "Runtime for each"

[workflow.inputs.workers]
type = "number"
required = true

[workflow.inputs.stop_early]
type = "boolean"
required = true

[workflow.variables]
items = ["alpha", "beta", "gamma"]

[[nodes]]
id = "visit"
type = "pass"
message = "{{loop.value}}"
for_each = "{{vars.items}}"
max_concurrency = "{{inputs.workers}}"
fail_fast = "{{inputs.stop_early}}"
""".strip(),
        encoding="utf-8",
    )
    workflow = AgenticWorkflow.from_file(source)

    assert str(workflow.graph._nodes["visit"].max_concurrency) == "{{inputs.workers}}"
    assert str(workflow.graph._nodes["visit"].fail_fast) == "{{inputs.stop_early}}"
    round_trip = tmp_path / "runtime-for-each-round-trip.toml"
    workflow.to_file(round_trip)
    reloaded = AgenticWorkflow.from_file(round_trip)
    assert str(reloaded.graph._nodes["visit"].max_concurrency) == "{{inputs.workers}}"
    assert str(reloaded.graph._nodes["visit"].fail_fast) == "{{inputs.stop_early}}"

    result = await (
        WorkflowExecutor(workflow, {}, log_base_dir=tmp_path / "logs")
        .with_parameters({"workers": 2, "stop_early": False})
        .run()
    )

    assert result.success
    assert result.node_outputs["visit"].output in {"alpha", "beta", "gamma"}


@pytest.mark.anyio
async def test_resume_accepts_replacement_secret_input_when_checkpoint_key_is_missing(
    tmp_path: Path,
) -> None:
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="resume-replacement-secret",
            name="Resume Replacement Secret",
            inputs={"token": WorkflowParameterConfig(type="secret", required=True)},
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="done",
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command='printf "ok"',
            ),
        )
    )
    logs = tmp_path / "logs"
    first = (
        await WorkflowExecutor(workflow, {}, log_base_dir=logs, data_dir=tmp_path)
        .with_parameters({"token": "first-secret"})
        .run()
    )
    assert first.log_path is not None
    (tmp_path / ".checkpoint-secrets.key").unlink()

    resumed = (
        await WorkflowExecutor(workflow, {}, log_base_dir=logs, data_dir=tmp_path)
        .with_parameters({"token": "replacement-secret"})
        .with_resume_options(ResumeOptions(run_id=first.log_path.name, from_node="done"))
        .run()
    )

    assert resumed.success
    assert resumed.inputs == {"token": "***"}
    assert resumed.node_outputs["done"].output == "ok"


@pytest.mark.anyio
async def test_resume_input_override_invalidates_operation_reference_cache(
    tmp_path: Path,
) -> None:
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="resume-input-override",
            name="Resume Input Override",
            inputs={"value": WorkflowParameterConfig(type="string", required=True)},
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="show",
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command='printf "%s" "{{inputs.value}}"',
            ),
        )
    )
    logs = tmp_path / "logs"
    first = (
        await WorkflowExecutor(workflow, {}, log_base_dir=logs, data_dir=tmp_path)
        .with_parameters({"value": "first"})
        .run()
    )
    assert first.log_path is not None

    resumed = (
        await WorkflowExecutor(workflow, {}, log_base_dir=logs, data_dir=tmp_path)
        .with_parameters({"value": "replacement"})
        .with_resume_options(ResumeOptions(run_id=first.log_path.name))
        .run()
    )

    assert resumed.success
    assert resumed.node_outputs["show"].output == "replacement"
    assert resumed.node_outputs["show"].data.get("reused") is not True


@pytest.mark.anyio
async def test_secret_inputs_and_variables_are_redacted_from_run_artifacts(
    tmp_path: Path,
) -> None:
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="secrets",
            name="Secrets",
            inputs={"token": WorkflowParameterConfig(type="string", required=True, secret=True)},
            variables={
                "copy": WorkflowVariableConfig(
                    type="string",
                    initial="{{inputs.token}}",
                    secret=True,
                )
            },
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="echo",
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command='printf "%s" "{{vars.copy}}"',
            ),
        )
    )

    result = (
        await WorkflowExecutor(workflow, {}, log_base_dir=tmp_path / "logs")
        .with_parameters({"token": "super-secret"})
        .run()
    )

    assert result.inputs == {"token": "***"}
    assert result.variables == {"copy": "***"}
    assert result.node_outputs["echo"].output == "***"
    for artifact in (tmp_path / "logs").rglob("*"):
        if artifact.is_file():
            assert "super-secret" not in artifact.read_text(encoding="utf-8")


def test_legacy_parameters_remain_available_as_inputs() -> None:
    config = WorkflowConfig(
        id="legacy",
        name="Legacy",
        parameters={"branch": WorkflowParameterConfig(default="main")},
    )

    assert config.declared_inputs == config.parameters
    assert resolve_workflow_parameters(config) == {"branch": "main"}


@pytest.mark.anyio
async def test_input_drives_working_directory(tmp_path: Path) -> None:
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="working-dir",
            name="Working Dir",
            inputs={"project_dir": WorkflowParameterConfig(type="path", required=True)},
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="pwd",
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command="pwd",
                working_dir=Path("{{inputs.project_dir}}"),
            ),
        )
    )

    result = (
        await WorkflowExecutor(workflow, {}, log_base_dir=tmp_path / "logs")
        .with_parameters({"project_dir": tmp_path})
        .run()
    )

    assert result.node_outputs["pwd"].output.strip() == str(tmp_path)


@pytest.mark.anyio
async def test_pass_fields_resolve_inputs_and_report_context(tmp_path: Path) -> None:
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="pass-fields",
            name="Pass Fields",
            inputs={"message": WorkflowParameterConfig(default="done")},
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="pass",
            operation=PassOperation(
                type=OperationType.PASS,
                message="Passed: {{inputs.message}}",
            ),
        )
    )

    result = await WorkflowExecutor(workflow, {}, log_base_dir=tmp_path / "ok").run()

    assert result.success
    assert result.node_outputs["pass"].output == "Passed: done"

    broken = AgenticWorkflow(WorkflowConfig(id="broken-fields", name="Broken Fields"))
    broken.add_operation(
        GraphNode(
            node_id="pass",
            operation=PassOperation(
                type=OperationType.PASS,
                message="{{inputs.missing}}",
            ),
        )
    )

    failed = await WorkflowExecutor(broken, {}, log_base_dir=tmp_path / "broken").run()

    assert not failed.success
    output = failed.node_outputs["pass"].output
    assert "Workflow 'broken-fields' invocation" in output
    assert "node 'pass'" in output
    assert "field 'operation.message'" in output
    assert "inputs.missing" in output
