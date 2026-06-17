from __future__ import annotations

import time
import threading
from abc import ABC, abstractmethod
from pathlib import Path

from gofer.core.agent import AgentResult
from gofer.utils.process import run_subprocess


class Subscription(ABC):
    async def execute(
        self,
        prompt: str,
        working_dir: Path,
        tools: list[str],
        mcp_servers: list[str],
        env: dict[str, str],
        timeout: float | None = None,
        cancel_event: threading.Event | None = None,
    ) -> AgentResult:
        cmd = self._build_command(prompt, tools, mcp_servers)
        start = time.monotonic()
        returncode, stdout, stderr = await run_subprocess(
            cmd,
            cancel_event=cancel_event,
            cwd=working_dir,
            env=env,
            timeout=timeout,
        )
        duration = time.monotonic() - start
        return AgentResult(
            agent_id="",
            success=returncode == 0,
            output=stdout or stderr,
            exit_code=returncode,
            duration_seconds=duration,
        )

    @abstractmethod
    def _build_command(
        self, prompt: str, tools: list[str], mcp_servers: list[str]
    ) -> list[str]: ...

    @abstractmethod
    def is_available(self) -> bool: ...
