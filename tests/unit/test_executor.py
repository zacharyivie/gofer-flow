from __future__ import annotations

from pathlib import Path

from gofer.core import executor as executor_module
from gofer.core.agent import AgentConfig
from gofer.core.executor import WorkflowExecutor, command_shell_args
from gofer.core.graph import EdgeConditionType, EdgeConfig, GraphNode
from gofer.core.operations import (
    AgentOperation,
    BashCommandOperation,
    OperationType,
    PythonScriptOperation,
)
from gofer.core.workflow import AgenticWorkflow, WorkflowConfig
from tests.conftest import FakeSubscription


def _bash_node(node_id: str, command: str = "true") -> GraphNode:
    return GraphNode(
        node_id=node_id,
        operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command=command),
    )


def _make_workflow(wf_id: str = "test") -> AgenticWorkflow:
    return AgenticWorkflow(WorkflowConfig(id=wf_id, name="Test"))


def test_command_shell_args_uses_bash_off_windows(monkeypatch) -> None:
    monkeypatch.setattr(executor_module.sys, "platform", "linux")

    assert command_shell_args("echo hello") == ["bash", "-c", "echo hello"]


def test_command_shell_args_uses_powershell_on_windows(monkeypatch) -> None:
    monkeypatch.setattr(executor_module.sys, "platform", "win32")

    assert command_shell_args("Write-Output hello") == [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Write-Output hello",
    ]


async def test_single_bash_node_succeeds(tmp_path: Path) -> None:
    wf = _make_workflow()
    wf.add_operation(_bash_node("echo", "echo hello"))
    executor = WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs")
    result = await executor.run()
    assert result.success
    assert "echo" in result.node_outputs


async def test_linear_execution_order(tmp_path: Path) -> None:
    wf = _make_workflow()
    wf.add_operation(_bash_node("a", "true"))
    wf.add_operation(_bash_node("b", "true"))
    wf.then("a", "b")

    executor = WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs")
    result = await executor.run()
    assert result.success
    assert set(result.node_outputs) == {"a", "b"}


async def test_failure_halts_workflow(tmp_path: Path) -> None:
    wf = _make_workflow()
    wf.add_operation(GraphNode(
        node_id="fail",
        operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="false"),
        on_failure="halt",
    ))
    wf.add_operation(_bash_node("after"))
    wf.then("fail", "after")

    executor = WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs")
    result = await executor.run()
    assert not result.success
    assert "after" not in result.node_outputs


async def test_failure_skip_continues(tmp_path: Path) -> None:
    wf = _make_workflow()
    wf.add_operation(GraphNode(
        node_id="fail",
        operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="false"),
        on_failure="skip",
    ))
    wf.add_operation(_bash_node("after"))
    wf.then("fail", "after")

    executor = WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs")
    result = await executor.run()
    assert "after" in result.node_outputs


async def test_failed_bash_command_routes_to_on_failure_edge(tmp_path: Path) -> None:
    wf = _make_workflow()
    wf.add_operation(_bash_node("fail", "1/0"))
    wf.add_operation(_bash_node("recover", "echo recovered"))
    wf.then(
        "fail",
        "recover",
        EdgeConfig(
            from_node="fail",
            to_node="recover",
            condition=EdgeConditionType.ON_FAILURE,
        ),
    )

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert not result.success
    assert not result.node_outputs["fail"].success
    assert result.node_outputs["recover"].success
    assert "recovered" in result.node_outputs["recover"].output


async def test_uncaught_python_exception_routes_to_on_failure_edge(tmp_path: Path) -> None:
    script = tmp_path / "explode.py"
    script.write_text("1 / 0\n")

    wf = _make_workflow()
    wf.add_operation(GraphNode(
        node_id="explode",
        operation=PythonScriptOperation(
            type=OperationType.PYTHON_SCRIPT,
            script_path=script,
        ),
    ))
    wf.add_operation(_bash_node("recover", "echo python recovered"))
    wf.then(
        "explode",
        "recover",
        EdgeConfig(
            from_node="explode",
            to_node="recover",
            condition=EdgeConditionType.ON_FAILURE,
        ),
    )

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert not result.success
    assert not result.node_outputs["explode"].success
    assert "ZeroDivisionError" in result.node_outputs["explode"].output
    assert result.node_outputs["recover"].success
    assert "python recovered" in result.node_outputs["recover"].output


async def test_failure_route_runs_after_retries_are_exhausted(tmp_path: Path) -> None:
    wf = _make_workflow()
    wf.add_operation(GraphNode(
        node_id="fail",
        operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="false"),
        retry_count=2,
        retry_delay_seconds=0,
    ))
    wf.add_operation(_bash_node("recover", "echo recovered after retries"))
    wf.then(
        "fail",
        "recover",
        EdgeConfig(
            from_node="fail",
            to_node="recover",
            condition=EdgeConditionType.ON_FAILURE,
        ),
    )

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert not result.success
    assert result.node_outputs["recover"].success
    assert "recovered after retries" in result.node_outputs["recover"].output
    assert result.log_path is not None
    text = result.log_path.read_text()
    assert "fail - attempt 1 started" in text
    assert "fail - attempt 2 started" in text
    assert "fail - attempt 3 started" in text
    assert text.index("fail - attempt 3 finished") < text.index("recover - attempt 1 started")


async def test_self_loop_repeats_until_output_no_longer_matches(tmp_path: Path) -> None:
    counter = tmp_path / "counter"
    command = (
        f"n=$(cat {counter} 2>/dev/null || echo 0); "
        "n=$((n + 1)); "
        f"echo $n > {counter}; "
        'if [ "$n" -lt 3 ]; then echo retry; else echo done; fi'
    )

    wf = _make_workflow("recursive")
    wf.add_operation(_bash_node("improve", command))
    wf.then(
        "improve",
        "improve",
        EdgeConfig(
            from_node="improve",
            to_node="improve",
            condition=EdgeConditionType.OUTPUT_MATCHES,
            output_pattern="retry",
        ),
    )

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert result.success
    assert result.node_outputs["improve"].output.strip() == "done"
    assert len(result.node_runs["improve"]) == 3
    assert result.log_path is not None
    text = result.log_path.read_text()
    assert "improve - run 2 attempt 1 started" in text
    assert "improve - run 3 attempt 1 finished success=True" in text


async def test_recursive_workflow_stops_at_max_total_node_runs(tmp_path: Path) -> None:
    wf = _make_workflow("runaway")
    wf.add_operation(_bash_node("loop", "echo again"))
    wf.then("loop", "loop")

    result = await WorkflowExecutor(
        wf,
        {},
        log_base_dir=tmp_path / "logs",
        max_total_node_runs=3,
    ).run()

    assert not result.success
    assert result.log_path is not None
    assert "maximum node run limit exceeded" in result.log_path.read_text()


async def test_dry_run_does_not_execute(tmp_path: Path) -> None:
    wf = _make_workflow()
    wf.add_operation(_bash_node("dangerous", "rm -rf /"))
    executor = WorkflowExecutor(wf, {}, dry_run=True, log_base_dir=tmp_path / "logs")
    result = await executor.run()
    assert result.success


async def test_agent_node_uses_subscription(tmp_path: Path) -> None:
    prompt = tmp_path / "p.md"
    prompt.write_text("Do something.")
    sub = FakeSubscription(output="agent output")

    wf = _make_workflow()
    wf.register_agent(AgentConfig(
        agent_id="bot",
        subscription="claude_code",
        working_dir=tmp_path,
        prompt_path=prompt,
    ))
    wf.add_operation(GraphNode(
        node_id="agent-step",
        operation=AgentOperation(
            type=OperationType.AGENT,
            agent_id="bot",
            prompt_path=prompt,
            working_dir=tmp_path,
        ),
    ))
    executor = WorkflowExecutor(wf, {"claude_code": sub}, log_base_dir=tmp_path / "logs")
    result = await executor.run()
    assert result.success
    assert "agent output" in result.node_outputs["agent-step"].output
    assert len(sub.calls) == 1


async def test_workflow_run_writes_success_log(tmp_path: Path) -> None:
    wf = _make_workflow("logged")
    wf.add_operation(_bash_node("echo", "echo hello"))

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert result.log_path is not None
    assert result.log_path.parent == tmp_path / "logs" / "logged"
    assert result.log_path.exists()
    lines = result.log_path.read_text().splitlines()
    assert lines[0].endswith(" - logged started successfully")
    assert "echo - stdout:" in result.log_path.read_text()
    assert "hello" in result.log_path.read_text()
    assert lines[-1].endswith(" - INFO - logged completed successfully")


async def test_workflow_run_writes_failure_log(tmp_path: Path) -> None:
    wf = _make_workflow("broken")
    wf.add_operation(_bash_node("fail", "echo bad >&2; exit 3"))

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert result.log_path is not None
    text = result.log_path.read_text()
    lines = text.splitlines()
    assert not result.success
    assert lines[0].endswith(" - broken started successfully")
    assert "fail - stderr:" in text
    assert "bad" in text
    assert "broken failed due to node fail failed" in lines[-1]
