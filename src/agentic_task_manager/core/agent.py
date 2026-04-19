from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel

if TYPE_CHECKING:
    from agentic_task_manager.subscriptions.base import Subscription


class AgentConfig(BaseModel):
    agent_id: str
    subscription: Literal["claude_code", "codex"]
    working_dir: Path
    prompt_path: Path
    tools: list[str] = []
    mcp_servers: list[str] = []
    env: dict[str, str] = {}


class AgentResult(BaseModel):
    agent_id: str
    success: bool
    output: str
    exit_code: int
    duration_seconds: float


class Agent:
    def __init__(self, config: AgentConfig, subscription: Subscription) -> None:
        self._config = config
        self._subscription = subscription

    async def run(self, context: dict[str, object] | None = None) -> AgentResult:
        from agentic_task_manager.prompts.manager import PromptManager

        prompt_text = PromptManager().load(self._config.prompt_path, context or {})
        result = await self._subscription.execute(
            prompt=prompt_text,
            working_dir=self._config.working_dir,
            tools=self._config.tools,
            mcp_servers=self._config.mcp_servers,
            env=self._config.env,
        )
        return AgentResult(
            agent_id=self._config.agent_id,
            success=result.success,
            output=result.output,
            exit_code=result.exit_code,
            duration_seconds=result.duration_seconds,
        )
