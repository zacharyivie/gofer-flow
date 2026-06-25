from __future__ import annotations

from pathlib import Path

import pytest

from gofer.core.agent import Agent, AgentConfig
from gofer.core.graph import GraphNode
from gofer.core.operations import AgentOperation, OperationType
from gofer.core.workflow import AgenticWorkflow, WorkflowConfig
from tests.conftest import FakeSubscription


@pytest.fixture
def prompt_file(tmp_path: Path) -> Path:
    p = tmp_path / "prompt.md"
    p.write_text("Summarize {{repo}}.")
    return p


@pytest.fixture
def agent_config(prompt_file: Path, tmp_path: Path) -> AgentConfig:
    return AgentConfig(
        agent_id="test-agent",
        subscription="claude_code",
        working_dir=tmp_path,
        prompt_path=prompt_file,
    )


async def test_agent_delegates_to_subscription(
    agent_config: AgentConfig, tmp_path: Path
) -> None:
    sub = FakeSubscription(output="summary output")
    agent = Agent(agent_config, sub)
    result = await agent.run({"repo": "myrepo"})
    assert result.success
    assert result.output == "summary output"
    assert result.agent_id == "test-agent"
    assert len(sub.calls) == 1


async def test_agent_interpolates_prompt(agent_config: AgentConfig) -> None:
    sub = FakeSubscription()
    agent = Agent(agent_config, sub)
    await agent.run({"repo": "awesome-project"})
    assert "awesome-project" in str(sub.calls[0]["prompt"])


async def test_agent_includes_memory_in_prompt(agent_config: AgentConfig) -> None:
    sub = FakeSubscription()
    agent = Agent(agent_config, sub)
    result = await agent.run(
        {"repo": "awesome-project"},
        memory=[
            {"role": "user", "body": "Previous question"},
            {"role": "assistant", "body": "Previous answer"},
        ],
    )

    prompt = str(sub.calls[0]["prompt"])
    assert "Previous conversation:" in prompt
    assert "Previous question" in prompt
    assert "Previous answer" in prompt
    assert "Current request:" in prompt
    assert "awesome-project" in prompt
    assert result.prompt == prompt


async def test_agent_context_paths_do_not_expand_subscription_sandbox(
    agent_config: AgentConfig,
    tmp_path: Path,
) -> None:
    external_dir = tmp_path.parent / "ticket backlog"
    external_dir.mkdir(exist_ok=True)
    external_file = external_dir / "ticket.txt"
    external_file.write_text("ticket", encoding="utf-8")

    sub = FakeSubscription()
    agent = Agent(agent_config, sub)

    await agent.run({
        "repo": "awesome-project",
        "_piped_input": str(external_dir),
        "file_path": str(external_file),
    })

    assert str(external_dir) in str(sub.calls[0]["prompt"])
    assert sub.calls[0]["extra_paths"] == []


async def test_agent_passes_configured_extra_paths_to_subscription(
    agent_config: AgentConfig,
    tmp_path: Path,
) -> None:
    external_dir = tmp_path.parent / "shared context"
    external_dir.mkdir(exist_ok=True)
    config = agent_config.model_copy(update={"extra_paths": [external_dir]})

    sub = FakeSubscription()
    agent = Agent(config, sub)

    await agent.run({"repo": "awesome-project"})

    assert sub.calls[0]["extra_paths"] == [external_dir.resolve()]


def test_workflow_validation_rejects_missing_agent_extra_path(
    agent_config: AgentConfig,
    tmp_path: Path,
) -> None:
    missing_path = tmp_path / "missing"
    wf = AgenticWorkflow(WorkflowConfig(id="missing-extra-path", name="Missing"))
    wf.register_agent(agent_config.model_copy(update={"extra_paths": [missing_path]}))

    with pytest.raises(ValueError, match="extra_paths entry does not exist"):
        wf.validate()


def test_workflow_validation_rejects_file_agent_extra_path(
    agent_config: AgentConfig,
    tmp_path: Path,
) -> None:
    file_path = tmp_path / "not-a-dir.txt"
    file_path.write_text("not a sandbox directory", encoding="utf-8")
    wf = AgenticWorkflow(WorkflowConfig(id="file-extra-path", name="File Extra Path"))
    wf.register_agent(agent_config.model_copy(update={"extra_paths": [file_path]}))

    with pytest.raises(ValueError, match="extra_paths entry is not a directory"):
        wf.validate()


def test_workflow_resource_warnings_use_agent_node_working_dir_override(
    agent_config: AgentConfig,
    tmp_path: Path,
) -> None:
    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    node_working_dir = tmp_path / "other-repo"
    node_working_dir.mkdir()
    extra_dir = repo_dir / "shared"
    extra_dir.mkdir()
    wf = AgenticWorkflow(WorkflowConfig(id="node-workdir-access", name="Access"))
    wf.register_agent(
        agent_config.model_copy(update={"working_dir": repo_dir, "extra_paths": [extra_dir]})
    )
    wf.add_operation(GraphNode(
        node_id="review",
        operation=AgentOperation(
            type=OperationType.AGENT,
            agent_id=agent_config.agent_id,
            working_dir=node_working_dir,
        ),
    ))

    warnings = wf.resource_warnings()

    assert len(warnings) == 1
    assert str(extra_dir.resolve()) in warnings[0]
    assert str(node_working_dir.resolve()) in warnings[0]


async def test_agent_failure_propagates(agent_config: AgentConfig) -> None:
    sub = FakeSubscription(output="error", exit_code=1)
    agent = Agent(agent_config, sub)
    result = await agent.run()
    assert not result.success
    assert result.exit_code == 1
