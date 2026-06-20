from __future__ import annotations

import threading
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from gofer.subscriptions.base import Subscription


class AgentConfig(BaseModel):
    agent_id: str
    subscription: Literal["claude_code", "codex"]
    working_dir: Path
    prompt_path: Path | None = None
    tools: list[str] = []
    mcp_servers: list[str] = []
    env: dict[str, str] = {}


class AgentResult(BaseModel):
    agent_id: str
    success: bool
    output: str
    exit_code: int
    duration_seconds: float
    thoughts: list[str] = Field(default_factory=list)
    message: str | None = None
    prompt: str | None = None


class Agent:
    def __init__(self, config: AgentConfig, subscription: Subscription) -> None:
        self._config = config
        self._subscription = subscription

    async def run(
        self,
        context: dict[str, object] | None = None,
        cancel_event: threading.Event | None = None,
        prompt_override: str | None = None,
        memory: list[dict[str, str]] | None = None,
    ) -> AgentResult:
        from gofer.prompts.manager import PromptManager

        ctx = context or {}
        prompt_text = (
            PromptManager._interpolate(prompt_override, ctx)
            if prompt_override is not None
            else PromptManager().load(self._config.prompt_path, ctx)
            if self._config.prompt_path is not None
            else ""
        )
        if piped := ctx.get("_piped_input"):
            prompt_text = f"{piped}\n\n{prompt_text}"
        if file_content := ctx.get("file_content"):
            prompt_text = f"{prompt_text}\n\n{file_content}"
        if row := ctx.get("_row"):
            prompt_text = f"{prompt_text}\n\n{row}"
        current_prompt = prompt_text
        if memory:
            prompt_text = _format_agent_memory(memory, current_prompt)
        execute_kwargs = {
            "prompt": prompt_text,
            "working_dir": self._config.working_dir,
            "tools": self._config.tools,
            "mcp_servers": self._config.mcp_servers,
            "env": self._config.env,
        }
        if cancel_event is not None:
            execute_kwargs["cancel_event"] = cancel_event
        result = await self._subscription.execute(**execute_kwargs)
        return AgentResult(
            agent_id=self._config.agent_id,
            success=result.success,
            output=result.output,
            exit_code=result.exit_code,
            duration_seconds=result.duration_seconds,
            thoughts=result.thoughts,
            message=result.message,
            prompt=current_prompt,
        )


def _format_agent_memory(memory: list[dict[str, str]], current_prompt: str) -> str:
    lines = [
        "Continue this agent node conversation using the previous turns as context.",
        "",
        "Previous conversation:",
    ]
    for turn in memory:
        role = turn.get("role", "message").strip().title() or "Message"
        body = turn.get("body", "").strip()
        if body:
            lines.append(f"{role}:")
            lines.append(body)
            lines.append("")
    lines.extend(["Current request:", current_prompt])
    return "\n".join(lines).strip()
