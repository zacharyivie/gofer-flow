from __future__ import annotations

import shutil

from gofer.subscriptions.base import Subscription


class CodexSubscription(Subscription):
    def _build_command(
        self, prompt: str, tools: list[str], mcp_servers: list[str]
    ) -> list[str]:
        return [
            shutil.which("codex") or "codex",
            "exec",
            "--color",
            "never",
            "--skip-git-repo-check",
            "--sandbox",
            "workspace-write",
            prompt,
        ]

    def is_available(self) -> bool:
        return shutil.which("codex") is not None
