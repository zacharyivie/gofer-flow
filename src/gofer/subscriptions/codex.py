from __future__ import annotations

import shutil
from pathlib import Path

from gofer.subscriptions.base import Subscription


class CodexSubscription(Subscription):
    def _build_command(
        self,
        prompt: str,
        tools: list[str],
        mcp_servers: list[str],
        extra_paths: list[Path] | None = None,
    ) -> list[str]:
        cmd = [
            shutil.which("codex") or "codex",
            "exec",
            "--color",
            "never",
            "--skip-git-repo-check",
            "--sandbox",
            "workspace-write",
            "--json",
        ]
        for path in extra_paths or []:
            cmd += ["--add-dir", str(path)]
        cmd.append(prompt)
        return cmd

    def is_available(self) -> bool:
        return shutil.which("codex") is not None
