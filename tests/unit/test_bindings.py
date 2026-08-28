from __future__ import annotations

import json
from pathlib import Path

from pytest import MonkeyPatch, raises
from typer.testing import CliRunner

from gofer.cli.main import app
from gofer.core.bindings import binding_contract, inspect_workflow_bindings
from gofer.core.executor import ExecutionContext, NodeOutput, QueuedNode, WorkflowExecutor
from gofer.core.graph import GraphNode
from gofer.core.operations import (
    AgentOperation,
    BashCommandOperation,
    CommonLlmTaskOperation,
    CountFanSource,
    LoopOperation,
    OperationType,
)
from gofer.core.planner import build_execution_plan
from gofer.core.validation import validate_workflow
from gofer.core.workflow import AgenticWorkflow, WorkflowConfig, WorkflowParameterConfig


def _loop_workflow() -> AgenticWorkflow:
    workflow = AgenticWorkflow(WorkflowConfig(id="bindings", name="Bindings"))
    workflow.add_operation(
        GraphNode(
            node_id="files",
            operation=LoopOperation(
                type=OperationType.LOOP,
                source=CountFanSource(type="count", count=2),
            ),
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="consume",
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command='printf "%s" "${FILE_NAME}"',
                env={"FILE_NAME": "{{loop.current.file_name}}"},
            ),
        )
    )
    workflow.then("files", "consume")
    return workflow


def test_loop_environment_binding_is_runtime_bound_with_shell_boundary() -> None:
    workflow = _loop_workflow()

    binding = inspect_workflow_bindings(workflow)[0].to_dict()

    assert binding == {
        "id": "binding:consume:operation.env.FILE_NAME:loop.current.file_name",
        "destinationNode": "consume",
        "destinationField": "operation.env.FILE_NAME",
        "expression": "loop.current.file_name",
        "namespace": "loop",
        "producer": "loop-item",
        "sourceType": "string",
        "destinationType": "string",
        "resolutionPhase": "loop-item",
        "status": "runtime-bound",
        "mode": "embedded",
        "coercion": "string",
        "destinationLayer": "generated-environment",
        "consumer": "process-or-shell",
        "secret": False,
    }
    plan = build_execution_plan(workflow)
    assert plan["bindings"] == [binding]
    assert plan["generations"][1]["nodes"][0]["bindings"] == [binding]
    assert plan["bindingContract"] == binding_contract()
    assert "unresolvedDynamicValues" not in plan


def test_invalid_namespace_and_unreachable_producer_fail_at_destination() -> None:
    workflow = AgenticWorkflow(WorkflowConfig(id="invalid-bindings", name="Invalid"))
    workflow.add_operation(
        GraphNode(
            node_id="producer",
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command="echo value",
            ),
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="consumer",
            inputs={"FIRST": "paramz.name", "SECOND": "producer.output"},
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command="echo done",
            ),
        )
    )

    report = validate_workflow(workflow)

    assert report.ok is False
    errors = {(item.field, item.code): item for item in report.errors}
    assert ("inputs.FIRST", "workflow.binding_invalid") in errors
    assert errors[("inputs.FIRST", "workflow.binding_invalid")].detail is not None
    assert ("inputs.SECOND", "workflow.binding_invalid") in errors


def test_misspelled_raw_producer_is_invalid_with_suggestion() -> None:
    workflow = AgenticWorkflow(WorkflowConfig(id="producer-typo", name="Producer Typo"))
    workflow.add_operation(
        GraphNode(
            node_id="producer",
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command="echo value",
            ),
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="consumer",
            inputs={"VALUE": "prodcer.output"},
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command='printf "%s" "$VALUE"',
            ),
        )
    )
    workflow.then("producer", "consumer")

    binding = inspect_workflow_bindings(workflow)[0]

    assert binding.status == "invalid"
    assert binding.destination_field == "inputs.VALUE"
    assert binding.suggestions == ("producer",)


def test_repeated_references_emit_one_binding_with_one_stable_id() -> None:
    workflow = AgenticWorkflow(WorkflowConfig(id="repeated-binding", name="Repeated Binding"))
    workflow.add_operation(
        GraphNode(
            node_id="command",
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command="echo {{trigger.x}} {{trigger.x}}",
            ),
        )
    )

    bindings = inspect_workflow_bindings(workflow)

    assert len(bindings) == 1
    assert bindings[0].id == "binding:command:operation.command:trigger.x"


def test_agent_memory_run_literals_are_not_reported_as_bare_run_references(
    tmp_path: Path,
) -> None:
    workflow = AgenticWorkflow(WorkflowConfig(id="memory-literals", name="Memory Literals"))
    workflow.add_operation(
        GraphNode(
            node_id="agent",
            operation=AgentOperation(
                type=OperationType.AGENT,
                agent_id="reviewer",
                working_dir=tmp_path,
                memory="run",
            ),
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="common-task",
            operation=CommonLlmTaskOperation(
                type=OperationType.COMMON_LLM_TASK,
                agent_id="reviewer",
                working_dir=tmp_path,
                memory="run",
            ),
        )
    )

    report = validate_workflow(workflow)

    assert inspect_workflow_bindings(workflow) == []
    assert all(item.code != "workflow.binding_invalid" for item in report.diagnostics)


def test_whitespace_for_each_reference_populates_producer_item_context(tmp_path: Path) -> None:
    workflow = AgenticWorkflow(WorkflowConfig(id="for-each-context", name="For Each Context"))
    workflow.add_operation(
        GraphNode(
            node_id="producer",
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command="echo producer",
            ),
        )
    )
    consumer = GraphNode(
        node_id="consumer",
        for_each="{{ producer.items }}",
        operation=BashCommandOperation(
            type=OperationType.BASH_COMMAND,
            command="echo {{items.producer.name}}",
        ),
    )
    workflow.add_operation(consumer)
    workflow.then("producer", "consumer")
    context = ExecutionContext()
    context.record(
        NodeOutput(
            node_id="producer",
            success=True,
            output="producer",
            exit_code=0,
            duration_seconds=0,
            items=[{"name": "alpha"}],
        )
    )
    executor = WorkflowExecutor(workflow, {}, log_base_dir=tmp_path / "logs")

    tasks = executor._for_each_tasks(
        consumer,
        QueuedNode("consumer"),
        context,
        workflow.graph,
    )

    assert tasks is not None
    assert tasks[0].item_context == {
        "producer": {"name": "alpha", "index": "0"},
        "consumer": {"name": "alpha", "index": "0"},
    }
    assert (
        context.resolve_path_with_loop(
            "items.producer.name",
            item_context=tasks[0].item_context,
        )
        == "alpha"
    )


async def test_exact_workflow_run_and_secret_inputs_match_execution(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setenv("GOFER_SECRET_API_TOKEN", "ready-secret")
    workflow = AgenticWorkflow(WorkflowConfig(id="exact-inputs", name="Exact Inputs"))
    workflow.add_operation(
        GraphNode(
            node_id="command",
            inputs={
                "FLOW": "{{ workflow.id }}",
                "RUN_ID": "run.id",
                "TOKEN": "secret.API_TOKEN",
            },
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command='printf "%s|%s|%s" "$FLOW" "$RUN_ID" "$TOKEN"',
            ),
        )
    )
    workflow_path = tmp_path / "exact-inputs.toml"

    bindings = inspect_workflow_bindings(workflow, workflow_path=workflow_path)
    result = await WorkflowExecutor(
        workflow,
        {},
        log_base_dir=tmp_path / "logs",
        workflow_path=workflow_path,
    ).run()

    assert result.success
    flow_id, run_id, token = result.node_outputs["command"].output.split("|")
    assert flow_id == "exact-inputs"
    assert run_id
    assert token == "ready-secret"
    by_field = {binding.destination_field: binding for binding in bindings}
    assert by_field["inputs.FLOW"].status == "resolved"
    assert by_field["inputs.RUN_ID"].status == "runtime-bound"
    assert by_field["inputs.TOKEN"].readiness == "present"
    assert all(binding.destination_layer == "generated-environment" for binding in bindings)
    assert all(binding.destination_type == "string" for binding in bindings)
    assert all(binding.coercion == "string" for binding in bindings)


async def test_scalar_subpaths_are_invalid_with_contextual_runtime_error(tmp_path: Path) -> None:
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="scalar-subpaths",
            name="Scalar Subpaths",
            parameters={"name": WorkflowParameterConfig(type="string", default="gofer")},
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="command",
            inputs={
                "FLOW": "workflow.id.extra",
                "RUN_ID": "run.id.extra",
                "PARAM": "params.name.extra",
            },
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command='printf "%s|%s|%s" "$FLOW" "$RUN_ID" "$PARAM"',
            ),
        )
    )

    bindings = inspect_workflow_bindings(workflow)
    result = await WorkflowExecutor(workflow, {}, log_base_dir=tmp_path / "logs").run()

    assert {binding.status for binding in bindings} == {"invalid"}
    assert not result.success
    output = result.node_outputs["command"].output
    assert "Workflow 'scalar-subpaths' invocation" in output
    assert "node 'command'" in output
    assert "field 'inputs.FLOW'" in output
    assert "workflow.id.extra" in output


async def test_command_input_report_exposes_json_string_coercion(tmp_path: Path) -> None:
    workflow = AgenticWorkflow(WorkflowConfig(id="input-coercion", name="Input Coercion"))
    workflow.add_operation(
        GraphNode(
            node_id="command",
            inputs={"PAYLOAD": "trigger.payload", "stdin": "trigger.payload"},
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command='printf "%s" "$PAYLOAD"',
            ),
        )
    )

    bindings = inspect_workflow_bindings(workflow)
    result = await (
        WorkflowExecutor(workflow, {}, log_base_dir=tmp_path / "logs")
        .with_trigger_context({"payload": {"key": "value"}})
        .run()
    )

    assert result.node_outputs["command"].output == '{"key": "value"}'
    by_field = {binding.destination_field: binding for binding in bindings}
    assert by_field["inputs.PAYLOAD"].destination_layer == "generated-environment"
    assert by_field["inputs.PAYLOAD"].destination_type == "string"
    assert by_field["inputs.PAYLOAD"].coercion == "string"
    assert by_field["inputs.stdin"].destination_layer == "process-stdin"
    assert by_field["inputs.stdin"].coercion == "string"


async def test_missing_exact_secret_input_is_reported_and_fails_execution(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.delenv("GOFER_SECRET_API_TOKEN", raising=False)
    monkeypatch.delenv("API_TOKEN", raising=False)
    workflow = AgenticWorkflow(WorkflowConfig(id="missing-secret", name="Missing Secret"))
    workflow.add_operation(
        GraphNode(
            node_id="command",
            inputs={"TOKEN": "secret.API_TOKEN"},
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command='printf "%s" "$TOKEN"',
            ),
        )
    )

    binding = inspect_workflow_bindings(workflow)[0]
    with raises(ValueError, match="Missing required secret.*API_TOKEN"):
        await WorkflowExecutor(workflow, {}, log_base_dir=tmp_path / "logs").run()

    assert binding.readiness == "missing"


def test_embedded_template_is_invalid_in_exact_only_input() -> None:
    workflow = AgenticWorkflow(WorkflowConfig(id="embedded-input", name="Embedded Input"))
    workflow.add_operation(
        GraphNode(
            node_id="command",
            inputs={"VALUE": "prefix-{{trigger.value}}"},
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command="echo ok",
            ),
        )
    )

    binding = inspect_workflow_bindings(workflow)[0]

    assert binding.status == "invalid"
    assert binding.message == "This field accepts exact references, not embedded templates."


def test_known_type_mismatch_and_environment_conflict_fail_validation() -> None:
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="typed-bindings",
            name="Typed",
            parameters={"label": WorkflowParameterConfig(type="string")},
        )
    )
    workflow.add_operation(
        GraphNode(
            node_id="loop",
            inputs={"env.NAME": "params.label"},
            operation=LoopOperation(
                type=OperationType.LOOP,
                source=CountFanSource(type="count", count="params.label"),
            ),
        )
    )
    conflict = GraphNode(
        node_id="conflict",
        inputs={"env.NAME": "params.label"},
        operation=BashCommandOperation(
            type=OperationType.BASH_COMMAND,
            command="echo ok",
            env={"NAME": "literal"},
        ),
    )
    workflow.add_operation(conflict)

    report = validate_workflow(workflow)

    assert {item.code for item in report.errors} >= {
        "workflow.binding_type_incompatible",
        "workflow.binding_env_conflict",
    }
    mismatch = next(
        binding
        for binding in report.bindings
        if binding.destination_field == "operation.source.count"
    )
    assert mismatch.status == "type-incompatible"
    assert mismatch.mode == "exact"
    assert mismatch.coercion == "none"


def test_secret_report_contains_identifier_and_readiness_but_not_value(
    monkeypatch: MonkeyPatch,
) -> None:
    # The inspector never reads the environment; this sentinel must not enter its payload.
    monkeypatch.setenv("GOFER_SECRET_API_TOKEN", "do-not-leak")
    workflow = AgenticWorkflow(WorkflowConfig(id="secret-binding", name="Secret"))
    workflow.add_operation(
        GraphNode(
            node_id="secret",
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command="echo ok",
                env={"TOKEN": "{{secret.API_TOKEN}}"},
            ),
        )
    )

    payload = json.dumps(build_execution_plan(workflow), sort_keys=True)

    assert "secret.API_TOKEN" in payload
    assert '"readiness": "present"' in payload
    assert "do-not-leak" not in payload


def test_raw_secret_literal_in_interpolation_only_environment_is_not_required() -> None:
    workflow = AgenticWorkflow(WorkflowConfig(id="literal-secret", name="Literal Secret"))
    workflow.add_operation(
        GraphNode(
            node_id="command",
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command='printf "%s" "$TOKEN"',
                env={"TOKEN": "secret.NOT_A_BINDING"},
            ),
        )
    )

    plan = build_execution_plan(workflow)

    assert plan["requiredSecrets"] == []
    assert plan["secretReadiness"] == []
    assert plan["bindings"] == []


def test_validate_explain_bindings_human_and_json_are_consistent(tmp_path: Path) -> None:
    workflow_path = tmp_path / "binding.toml"
    workflow_path.write_text(
        """
[workflow]
id = "binding-cli"
name = "Binding CLI"

[[nodes]]
id = "command"
type = "bash_command"
command = "echo {{trigger.name}}"
""",
        encoding="utf-8",
    )
    runner = CliRunner()

    human = runner.invoke(
        app,
        ["workflow", "validate", str(workflow_path), "--explain-bindings"],
    )
    machine = runner.invoke(
        app,
        ["workflow", "validate", str(workflow_path), "--explain-bindings", "--json"],
    )

    assert human.exit_code == 0
    assert "runtime bindings" in human.output.lower()
    assert "optional" in human.output
    payload = json.loads(machine.output)
    assert machine.exit_code == 0
    assert payload["bindings"][0]["status"] == "optional"
    assert payload["bindings"][0]["id"] in human.output
