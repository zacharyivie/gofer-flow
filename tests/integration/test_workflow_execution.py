from __future__ import annotations

from pathlib import Path

from gofer.core.agent import AgentConfig
from gofer.core.executor import WorkflowExecutor
from gofer.core.graph import GraphNode
from gofer.core.operations import AgentOperation, BashCommandOperation, OperationType
from gofer.core.workflow import AgenticWorkflow, WorkflowConfig
from tests.conftest import FakeSubscription


async def test_multi_node_workflow_with_agent(tmp_path: Path) -> None:
    prompt = tmp_path / "prompt.md"
    prompt.write_text("Summarize commits.")
    sub = FakeSubscription(output="summary: lots of changes")

    wf = AgenticWorkflow(WorkflowConfig(id="ci", name="CI"))
    wf.register_agent(AgentConfig(
        agent_id="summarizer",
        subscription="claude_code",
        working_dir=tmp_path,
        prompt_path=prompt,
    ))
    wf.add_operation(GraphNode(
        node_id="setup",
        operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="echo setup"),
    ))
    wf.add_operation(GraphNode(
        node_id="summarize",
        operation=AgentOperation(
            type=OperationType.AGENT,
            agent_id="summarizer",
            prompt_path=prompt,
            working_dir=tmp_path,
        ),
    ))
    wf.then("setup", "summarize")

    result = await WorkflowExecutor(wf, {"claude_code": sub}).run()

    assert result.success
    assert result.node_outputs["setup"].success
    assert result.node_outputs["summarize"].output == "summary: lots of changes"


async def test_parallel_nodes_all_run(tmp_path: Path) -> None:
    wf = AgenticWorkflow(WorkflowConfig(id="par", name="Parallel"))
    for name in ["root", "left", "right", "merge"]:
        wf.add_operation(GraphNode(
            node_id=name,
            operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="echo " + name),
        ))
    wf.then("root", "left")
    wf.then("root", "right")
    wf.then("left", "merge")
    wf.then("right", "merge")

    result = await WorkflowExecutor(wf, {}).run()
    assert result.success
    assert set(result.node_outputs) == {"root", "left", "right", "merge"}
