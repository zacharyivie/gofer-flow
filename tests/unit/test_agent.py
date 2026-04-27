from __future__ import annotations

from pathlib import Path

import pytest

from gofer.core.agent import Agent, AgentConfig
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


async def test_agent_failure_propagates(agent_config: AgentConfig) -> None:
    sub = FakeSubscription(output="error", exit_code=1)
    agent = Agent(agent_config, sub)
    result = await agent.run()
    assert not result.success
    assert result.exit_code == 1
