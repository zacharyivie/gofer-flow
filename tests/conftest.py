from __future__ import annotations

from pathlib import Path

import pytest

from gofer.core.agent import AgentResult
from gofer.subscriptions.base import Subscription


class FakeSubscription(Subscription):
    def __init__(
        self,
        output: str = "ok",
        exit_code: int = 0,
        thoughts: list[str] | None = None,
        message: str | None = None,
    ) -> None:
        self.calls: list[dict[str, object]] = []
        self._output = output
        self._exit_code = exit_code
        self._thoughts = thoughts or []
        self._message = message

    def _build_command(
        self, prompt: str, tools: list[str], mcp_servers: list[str]
    ) -> list[str]:
        return ["fake"]

    def is_available(self) -> bool:
        return True

    async def execute(
        self,
        prompt: str,
        working_dir: Path,
        tools: list[str],
        mcp_servers: list[str],
        env: dict[str, str],
        timeout: float | None = None,
        cancel_event=None,
    ) -> AgentResult:
        self.calls.append({"prompt": prompt, "working_dir": working_dir})
        return AgentResult(
            agent_id="",
            success=self._exit_code == 0,
            output=self._output,
            exit_code=self._exit_code,
            duration_seconds=0.0,
            thoughts=self._thoughts,
            message=self._message,
        )


@pytest.fixture
def fake_subscription() -> FakeSubscription:
    return FakeSubscription()
