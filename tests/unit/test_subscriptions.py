from __future__ import annotations

from agentic_task_manager.subscriptions.claude_code import ClaudeCodeSubscription
from agentic_task_manager.subscriptions.codex import CodexSubscription


def test_claude_code_command_basic() -> None:
    sub = ClaudeCodeSubscription()
    cmd = sub._build_command("hello", [], [])
    assert cmd[:3] == ["claude", "--print", "-p"]
    assert "hello" in cmd


def test_claude_code_command_with_tools() -> None:
    sub = ClaudeCodeSubscription()
    cmd = sub._build_command("hi", ["Bash", "Read"], [])
    assert "--allowedTools" in cmd
    assert "Bash" in cmd
    assert "Read" in cmd


def test_claude_code_command_with_mcp() -> None:
    sub = ClaudeCodeSubscription()
    cmd = sub._build_command("hi", [], ["my-server"])
    assert "--mcp-server" in cmd
    assert "my-server" in cmd


def test_codex_command_basic() -> None:
    sub = CodexSubscription()
    cmd = sub._build_command("hello", [], [])
    assert "codex" in cmd
    assert "hello" in cmd


def test_codex_command_with_tools() -> None:
    sub = CodexSubscription()
    cmd = sub._build_command("hi", ["Bash"], [])
    assert "--tool" in cmd
    assert "Bash" in cmd
