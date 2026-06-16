from __future__ import annotations

from gofer.subscriptions import claude_code, codex
from gofer.subscriptions.claude_code import ClaudeCodeSubscription
from gofer.subscriptions.codex import CodexSubscription


def test_claude_code_command_basic(monkeypatch) -> None:
    monkeypatch.setattr(claude_code.shutil, "which", lambda _binary: None)
    sub = ClaudeCodeSubscription()
    cmd = sub._build_command("hello", [], [])
    assert cmd[:3] == ["claude", "--print", "-p"]
    assert "hello" in cmd


def test_claude_code_command_with_tools(monkeypatch) -> None:
    monkeypatch.setattr(claude_code.shutil, "which", lambda _binary: None)
    sub = ClaudeCodeSubscription()
    cmd = sub._build_command("hi", ["Bash", "Read"], [])
    assert "--allowedTools" in cmd
    assert "Bash" in cmd
    assert "Read" in cmd


def test_claude_code_command_with_mcp(monkeypatch) -> None:
    monkeypatch.setattr(claude_code.shutil, "which", lambda _binary: None)
    sub = ClaudeCodeSubscription()
    cmd = sub._build_command("hi", [], ["my-server"])
    assert "--mcp-server" in cmd
    assert "my-server" in cmd


def test_codex_command_basic(monkeypatch) -> None:
    monkeypatch.setattr(codex.shutil, "which", lambda _binary: None)
    sub = CodexSubscription()
    cmd = sub._build_command("hello", [], [])
    assert cmd == [
        "codex",
        "exec",
        "--color",
        "never",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "hello",
    ]


def test_codex_command_ignores_unsupported_tool_flags(monkeypatch) -> None:
    monkeypatch.setattr(codex.shutil, "which", lambda _binary: None)
    sub = CodexSubscription()
    cmd = sub._build_command("hi", ["Bash"], [])
    assert "--tool" not in cmd
    assert cmd[-1] == "hi"


def test_subscription_commands_use_resolved_binary_paths(monkeypatch) -> None:
    monkeypatch.setattr(
        codex.shutil,
        "which",
        lambda binary: {
            "codex": r"C:\Users\me\AppData\Roaming\npm\codex.cmd",
            "claude": r"C:\Users\me\AppData\Roaming\npm\claude.cmd",
        }.get(binary),
    )

    assert CodexSubscription()._build_command("hello", [], [])[0] == (
        r"C:\Users\me\AppData\Roaming\npm\codex.cmd"
    )
    assert ClaudeCodeSubscription()._build_command("hello", [], [])[0] == (
        r"C:\Users\me\AppData\Roaming\npm\claude.cmd"
    )
