from __future__ import annotations

import shutil
from pathlib import Path

from gofer.subscriptions.base import Subscription


class ClaudeCodeSubscription(Subscription):
    def _build_command(
        self,
        prompt: str,
        tools: list[str],
        mcp_servers: list[str],
        extra_paths: list[Path] | None = None,
    ) -> list[str]:
        cmd = [shutil.which("claude") or "claude", "--print", "--output-format", "json"]
        for path in extra_paths or []:
            cmd += ["--add-dir", str(path)]
        cmd += ["-p", prompt]
        for tool in tools:
            cmd += ["--allowedTools", tool]
        for server in mcp_servers:
            cmd += ["--mcp-server", server]
        return cmd

    def is_available(self) -> bool:
        return shutil.which("claude") is not None
