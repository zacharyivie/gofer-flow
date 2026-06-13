from __future__ import annotations

import shutil

from gofer.subscriptions.base import Subscription


class CodexSubscription(Subscription):
    def _build_command(
        self, prompt: str, tools: list[str], mcp_servers: list[str]
    ) -> list[str]:
        return [
            "codex",
            "exec",
            "--color",
            "never",
            "--sandbox",
            "workspace-write",
            prompt,
        ]

    def is_available(self) -> bool:
        return shutil.which("codex") is not None
