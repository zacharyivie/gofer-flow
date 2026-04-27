from __future__ import annotations

import shutil

from gofer.subscriptions.base import Subscription


class ClaudeCodeSubscription(Subscription):
    def _build_command(
        self, prompt: str, tools: list[str], mcp_servers: list[str]
    ) -> list[str]:
        cmd = ["claude", "--print", "-p", prompt]
        for tool in tools:
            cmd += ["--allowedTools", tool]
        for server in mcp_servers:
            cmd += ["--mcp-server", server]
        return cmd

    def is_available(self) -> bool:
        return shutil.which("claude") is not None
