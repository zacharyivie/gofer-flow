from __future__ import annotations

import time
import threading
from abc import ABC, abstractmethod
from pathlib import Path

from gofer.core.agent import AgentResult
from gofer.utils.process import stream_subprocess


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
        stdout_chunks: list[str] = []
        stderr_chunks: list[str] = []
        thought_chunks: list[str] = []
        returncode = 1
        async for event in stream_subprocess(
            cmd,
            cancel_event=cancel_event,
            cwd=working_dir,
            env=env,
            timeout=timeout,
        ):
            if event["type"] == "chunk":
                text = event["text"]
                if not text:
                    continue
                thought_chunks.append(text)
                if event["stream"] == "stdout":
                    stdout_chunks.append(text)
                else:
                    stderr_chunks.append(text)
                continue
            if event["stream"] is None:
                returncode = event["returncode"] if event["returncode"] is not None else 1
        duration = time.monotonic() - start
        stdout = "".join(stdout_chunks)
        stderr = "".join(stderr_chunks)
        message = stdout or stderr
        return AgentResult(
            agent_id="",
            success=returncode == 0,
            output=message,
            exit_code=returncode,
            duration_seconds=duration,
            thoughts=thought_chunks,
            message=message,
        )

    @abstractmethod
    def _build_command(
        self, prompt: str, tools: list[str], mcp_servers: list[str]
    ) -> list[str]: ...

    @abstractmethod
    def is_available(self) -> bool: ...
