from __future__ import annotations

from pathlib import Path

import pytest

from gofer.subscriptions import base
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


@pytest.mark.asyncio
async def test_subscription_execute_splits_thoughts_from_final_message(monkeypatch, tmp_path: Path) -> None:
    async def fake_stream_subprocess(*_args, **_kwargs):
        yield {"type": "chunk", "stream": "stderr", "text": "thinking\n", "returncode": None}
        yield {"type": "chunk", "stream": "stdout", "text": "final answer\n", "returncode": None}
        yield {"type": "exit", "stream": None, "text": "", "returncode": 0}

    monkeypatch.setattr(base, "stream_subprocess", fake_stream_subprocess)

    result = await CodexSubscription().execute(
        prompt="hello",
        working_dir=tmp_path,
        tools=[],
        mcp_servers=[],
        env={},
    )

    assert result.success
    assert result.thoughts == ["thinking\n", "final answer\n"]
    assert result.message == "final answer\n"
    assert result.output == "final answer\n"
