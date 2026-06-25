from __future__ import annotations

import inspect
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field

from gofer.core.usage import LlmPricing

if TYPE_CHECKING:
    from gofer.subscriptions.base import Subscription


class AgentConfig(BaseModel):
    agent_id: str
    subscription: Literal["claude_code", "codex"]
    working_dir: Path
    profile: str | None = None
    model: str | None = None
    pricing: LlmPricing = Field(default_factory=LlmPricing)
    prompt_path: Path | None = None
    tools: list[str] = Field(default_factory=list)
    mcp_servers: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    extra_paths: list[Path] = Field(default_factory=list)


class AgentResult(BaseModel):
    agent_id: str
    success: bool
    output: str
    exit_code: int
    duration_seconds: float
    thoughts: list[str] = Field(default_factory=list)
    message: str | None = None
    prompt: str | None = None
    provider: str | None = None
    profile: str | None = None
    model: str | None = None
    usage_metadata: dict[str, object] = Field(default_factory=dict)


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
        max_output_bytes: int | None = None,
        timeout: float | None = None,
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
            prompt_text = format_agent_memory(memory, current_prompt)
        extra_paths = configured_extra_paths(self._config)
        if max_output_bytes is not None and _accepts_execute_kwarg(
            self._subscription,
            "max_output_bytes",
        ):
            execute_kwargs: dict[str, Any] = {"max_output_bytes": max_output_bytes}
            if timeout is not None and _accepts_execute_kwarg(self._subscription, "timeout"):
                execute_kwargs["timeout"] = timeout
            result = await self._subscription.execute(
                prompt=prompt_text,
                working_dir=self._config.working_dir,
                tools=self._config.tools,
                mcp_servers=self._config.mcp_servers,
                env=self._config.env,
                cancel_event=cancel_event,
                extra_paths=extra_paths,
                **execute_kwargs,
            )
        else:
            execute_kwargs = {}
            if timeout is not None and _accepts_execute_kwarg(self._subscription, "timeout"):
                execute_kwargs["timeout"] = timeout
            result = await self._subscription.execute(
                prompt=prompt_text,
                working_dir=self._config.working_dir,
                tools=self._config.tools,
                mcp_servers=self._config.mcp_servers,
                env=self._config.env,
                cancel_event=cancel_event,
                extra_paths=extra_paths,
                **execute_kwargs,
            )
        return AgentResult(
            agent_id=self._config.agent_id,
            success=result.success,
            output=result.output,
            exit_code=result.exit_code,
            duration_seconds=result.duration_seconds,
            thoughts=result.thoughts,
            message=result.message,
            prompt=prompt_text,
            provider=result.provider or self._config.subscription,
            profile=result.profile or self._config.profile,
            model=result.model or self._config.model,
            usage_metadata=result.usage_metadata,
        )


def agent_external_access_warnings(
    config: AgentConfig,
    path_base: Path | None = None,
) -> list[str]:
    warnings_: list[str] = []
    try:
        working_dir = _resolve_config_path(config.working_dir, path_base).resolve()
    except OSError:
        working_dir = _resolve_config_path(config.working_dir, path_base)
    for extra_path in config.extra_paths:
        try:
            resolved_extra = _resolve_config_path(extra_path, path_base).resolve()
        except OSError:
            resolved_extra = _resolve_config_path(extra_path, path_base)
        if resolved_extra == working_dir or working_dir in resolved_extra.parents:
            continue
        warnings_.append(
            f"Agent '{config.agent_id}' grants provider filesystem access outside "
            f"working_dir: extra_paths entry '{resolved_extra}' is outside "
            f"'{working_dir}'"
        )
    return warnings_


def format_agent_memory(memory: list[dict[str, str]], current_prompt: str) -> str:
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


_format_agent_memory = format_agent_memory


def configured_extra_paths(
    config: AgentConfig,
    path_base: Path | None = None,
) -> list[Path]:
    paths: list[Path] = []
    seen: set[Path] = set()
    for configured_path in config.extra_paths:
        path = _resolve_config_path(configured_path, path_base)
        if not path.exists():
            raise ValueError(
                f"Agent '{config.agent_id}' extra_paths entry does not exist: {path}"
            )
        resolved_path = path.resolve()
        if not resolved_path.is_dir():
            raise ValueError(
                f"Agent '{config.agent_id}' extra_paths entry is not a directory: "
                f"{path}"
            )
        if resolved_path in seen:
            continue
        seen.add(resolved_path)
        paths.append(resolved_path)

    return paths


def _resolve_config_path(path: Path, path_base: Path | None) -> Path:
    expanded = path.expanduser()
    if expanded.is_absolute() or path_base is None:
        return expanded
    return path_base / expanded


def _accepts_execute_kwarg(subscription: Subscription, name: str) -> bool:
    parameters = inspect.signature(subscription.execute).parameters
    return name in parameters or any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in parameters.values()
    )
