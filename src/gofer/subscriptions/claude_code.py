from __future__ import annotations

from pathlib import Path

from gofer.core.provider_capabilities import resolve_provider_executable
from gofer.core.provider_profiles import ResolvedProviderSettings
from gofer.subscriptions.base import Subscription


class ClaudeCodeSubscription(Subscription):
    def _build_command(
        self,
        prompt: str,
        tools: list[str],
        mcp_servers: list[str],
        extra_paths: list[Path] | None = None,
        provider_settings: ResolvedProviderSettings | None = None,
    ) -> list[str]:
        _validate_claude_settings(provider_settings)
        cmd = [
            resolve_provider_executable("claude_code") or "claude",
            "--print",
            "--output-format",
            "stream-json",
        ]
        if provider_settings:
            if provider_settings.model:
                cmd += ["--model", provider_settings.model]
            if provider_settings.effort:
                cmd += ["--effort", provider_settings.effort]
            if provider_settings.approval_mode not in (None, "default"):
                approval_mode = provider_settings.approval_mode
                if approval_mode is not None:
                    cmd += ["--permission-mode", approval_mode]
            cmd += provider_settings.extra_args
        for path in extra_paths or []:
            cmd += ["--add-dir", str(path)]
        cmd += ["-p", prompt]
        for tool in [*(provider_settings.tools if provider_settings else []), *tools]:
            cmd += ["--allowedTools", tool]
        for server in [
            *(provider_settings.mcp_servers if provider_settings else []),
            *mcp_servers,
        ]:
            cmd += ["--mcp-server", server]
        return cmd

    def is_available(self) -> bool:
        return resolve_provider_executable("claude_code") is not None


def _validate_claude_settings(settings: ResolvedProviderSettings | None) -> None:
    if settings is None:
        return
    if settings.subscription != "claude_code":
        raise ValueError(
            f"Claude Code subscription cannot run provider profile for '{settings.subscription}'"
        )
    if settings.sandbox_mode not in (None, "default"):
        raise ValueError("Claude Code profiles do not support sandbox_mode")
