from __future__ import annotations

import shutil

from agentic_task_manager.subscriptions.base import Subscription


class CodexSubscription(Subscription):
    def _build_command(
        self, prompt: str, tools: list[str], mcp_servers: list[str]
    ) -> list[str]:
        cmd = ["codex", "--quiet", "-p", prompt]
        for tool in tools:
            cmd += ["--tool", tool]
        return cmd

    def is_available(self) -> bool:
        return shutil.which("codex") is not None
