from __future__ import annotations

from pathlib import Path

from gofer.core.agent import AgentConfig
from gofer.core.executor import WorkflowExecutor
from gofer.core.graph import GraphNode
from gofer.core.operations import AgentOperation, BashCommandOperation, OperationType
from gofer.core.workflow import AgenticWorkflow, WorkflowConfig
from legacy.tests.conftest import FakeSubscription


def _bash_node(node_id: str, command: str = "true") -> GraphNode:
    return GraphNode(
        node_id=node_id,
        operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command=command),
    )


def _make_workflow(wf_id: str = "test") -> AgenticWorkflow:
    return AgenticWorkflow(WorkflowConfig(id=wf_id, name="Test"))


async def test_single_bash_node_succeeds() -> None:
    wf = _make_workflow()
    wf.add_operation(_bash_node("echo", "echo hello"))
    executor = WorkflowExecutor(wf, {})
    result = await executor.run()
    assert result.success
    assert "echo" in result.node_outputs


async def test_linear_execution_order() -> None:
    wf = _make_workflow()
    wf.add_operation(_bash_node("a", "true"))
    wf.add_operation(_bash_node("b", "true"))
    wf.then("a", "b")

    executor = WorkflowExecutor(wf, {})
    result = await executor.run()
    assert result.success
    assert set(result.node_outputs) == {"a", "b"}


async def test_failure_halts_workflow() -> None:
    wf = _make_workflow()
    wf.add_operation(GraphNode(
        node_id="fail",
        operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="false"),
        on_failure="halt",
    ))
    wf.add_operation(_bash_node("after"))
    wf.then("fail", "after")

    executor = WorkflowExecutor(wf, {})
    result = await executor.run()
    assert not result.success
    assert "after" not in result.node_outputs


async def test_failure_skip_continues() -> None:
    wf = _make_workflow()
    wf.add_operation(GraphNode(
        node_id="fail",
        operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="false"),
        on_failure="skip",
    ))
    wf.add_operation(_bash_node("after"))
    wf.then("fail", "after")

    executor = WorkflowExecutor(wf, {})
    result = await executor.run()
    assert "after" in result.node_outputs


async def test_dry_run_does_not_execute() -> None:
    wf = _make_workflow()
    wf.add_operation(_bash_node("dangerous", "rm -rf /"))
    executor = WorkflowExecutor(wf, {}, dry_run=True)
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
    executor = WorkflowExecutor(wf, {"claude_code": sub})
    result = await executor.run()
    assert result.success
    assert "agent output" in result.node_outputs["agent-step"].output
    assert len(sub.calls) == 1
