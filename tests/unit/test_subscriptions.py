from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from gofer.subscriptions import base, claude_code, codex
from gofer.subscriptions.claude_code import ClaudeCodeSubscription
from gofer.subscriptions.codex import CodexSubscription


def test_claude_code_command_basic(monkeypatch) -> None:
    monkeypatch.setattr(claude_code.shutil, "which", lambda _binary: None)
    sub = ClaudeCodeSubscription()
    cmd = sub._build_command("hello", [], [])
    assert cmd[:5] == ["claude", "--print", "--output-format", "stream-json", "-p"]
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
        "--json",
        "hello",
    ]


def test_codex_command_ignores_unsupported_tool_flags(monkeypatch) -> None:
    monkeypatch.setattr(codex.shutil, "which", lambda _binary: None)
    sub = CodexSubscription()
    cmd = sub._build_command("hi", ["Bash"], [])
    assert "--tool" not in cmd
    assert cmd[-1] == "hi"


def test_codex_command_adds_extra_sandbox_dirs(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(codex.shutil, "which", lambda _binary: None)
    extra_dir = tmp_path / "tickets"
    sub = CodexSubscription()

    cmd = sub._build_command("hi", [], [], [extra_dir])

    assert ["--add-dir", str(extra_dir)] == cmd[-3:-1]
    assert cmd[-1] == "hi"


def test_claude_code_command_adds_extra_sandbox_dirs(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(claude_code.shutil, "which", lambda _binary: None)
    extra_dir = tmp_path / "tickets"
    sub = ClaudeCodeSubscription()

    cmd = sub._build_command("hi", [], [], [extra_dir])

    assert cmd[:5] == ["claude", "--print", "--output-format", "stream-json", "--add-dir"]
    assert cmd[5] == str(extra_dir)
    assert cmd[6:8] == ["-p", "hi"]


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
async def test_subscription_execute_splits_thoughts_from_final_message(
    monkeypatch, tmp_path: Path
) -> None:
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


@pytest.mark.asyncio
async def test_codex_execute_ignores_prompt_echo_when_extracting_final_message(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    async def fake_stream_subprocess(*_args, **_kwargs):
        yield {
            "type": "chunk",
            "stream": "stdout",
            "text": json.dumps(
                {
                    "type": "item.completed",
                    "item": {
                        "type": "message",
                        "role": "user",
                        "content": [
                            {
                                "type": "input_text",
                                "text": "Return FIX REQUIRED or NO FIX NEEDED.",
                            }
                        ],
                    },
                }
            )
            + "\n",
            "returncode": None,
        }
        yield {
            "type": "chunk",
            "stream": "stdout",
            "text": json.dumps(
                {
                    "type": "item.completed",
                    "item": {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "NO FIX NEEDED",
                            }
                        ],
                    },
                }
            )
            + "\n",
            "returncode": None,
        }
        yield {"type": "exit", "stream": None, "text": "", "returncode": 0}

    monkeypatch.setattr(base, "stream_subprocess", fake_stream_subprocess)

    result = await CodexSubscription().execute(
        prompt="Return FIX REQUIRED or NO FIX NEEDED.",
        working_dir=tmp_path,
        tools=[],
        mcp_servers=[],
        env={},
    )

    assert result.message == "NO FIX NEEDED"
    assert result.output == "NO FIX NEEDED"
    assert "FIX REQUIRED" not in result.output


@pytest.mark.asyncio
async def test_codex_execute_extracts_last_transcript_codex_block(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    async def fake_stream_subprocess(*_args, **_kwargs):
        yield {
            "type": "chunk",
            "stream": "stdout",
            "text": (
                "user\n"
                "Return FIX REQUIRED or NO FIX NEEDED.\n"
                "codex\n"
                "I am reviewing the workflow.\n"
                "exec\n"
                "some tool output\n"
                "codex\n"
                "NO FIX NEEDED\n"
                "tokens used\n"
                "123\n"
            ),
            "returncode": None,
        }
        yield {"type": "exit", "stream": None, "text": "", "returncode": 0}

    monkeypatch.setattr(base, "stream_subprocess", fake_stream_subprocess)

    result = await CodexSubscription().execute(
        prompt="Return FIX REQUIRED or NO FIX NEEDED.",
        working_dir=tmp_path,
        tools=[],
        mcp_servers=[],
        env={},
    )

    assert result.message == "NO FIX NEEDED"
    assert result.output == "NO FIX NEEDED"
    assert "FIX REQUIRED" not in result.output


@pytest.mark.asyncio
async def test_subscription_execute_extracts_provider_usage_metadata(
    monkeypatch, tmp_path: Path
) -> None:
    async def fake_stream_subprocess(*_args, **_kwargs):
        yield {
            "type": "chunk",
            "stream": "stdout",
            "text": (
                '{"type":"result","result":"final answer",'
                '"model":"claude-sonnet","usage":{"input_tokens":12,'
                '"output_tokens":7,"total_tokens":19},"cost_usd":0.0042}\n'
            ),
            "returncode": None,
        }
        yield {"type": "exit", "stream": None, "text": "", "returncode": 0}

    monkeypatch.setattr(base, "stream_subprocess", fake_stream_subprocess)

    result = await ClaudeCodeSubscription().execute(
        prompt="hello",
        working_dir=tmp_path,
        tools=[],
        mcp_servers=[],
        env={},
    )

    assert result.output == "final answer"
    assert result.thoughts == []
    assert result.usage_metadata == {
        "input_tokens": 12,
        "output_tokens": 7,
        "total_tokens": 19,
        "model": "claude-sonnet",
        "cost_usd": 0.0042,
        "source": "provider_metadata",
    }


@pytest.mark.asyncio
async def test_subscription_execute_extracts_nested_provider_usage_metadata(
    monkeypatch, tmp_path: Path
) -> None:
    async def fake_stream_subprocess(*_args, **_kwargs):
        yield {
            "type": "chunk",
            "stream": "stdout",
            "text": (
                '{"type":"turn.completed","message":{"content":"done",'
                '"metadata":{"model":"gpt-5-codex"},'
                '"token_count":{"inputTokens":33,"outputTokens":12,'
                '"total_tokens":45}}}\n'
            ),
            "returncode": None,
        }
        yield {"type": "exit", "stream": None, "text": "", "returncode": 0}

    monkeypatch.setattr(base, "stream_subprocess", fake_stream_subprocess)

    result = await CodexSubscription().execute(
        prompt="hello",
        working_dir=tmp_path,
        tools=[],
        mcp_servers=[],
        env={},
    )

    assert result.usage_metadata == {
        "input_tokens": 33,
        "output_tokens": 12,
        "total_tokens": 45,
        "model": "gpt-5-codex",
        "source": "provider_metadata",
    }


@pytest.mark.asyncio
async def test_subscription_execute_streams_structured_agent_events(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    streamed: list[str] = []

    async def fake_stream_subprocess(*_args, **_kwargs):
        yield {
            "type": "chunk",
            "stream": "stdout",
            "text": (
                '{"type":"item.completed",'
                '"item":{"type":"agent_message","text":"hello live"}}\n'
            ),
            "returncode": None,
        }
        yield {
            "type": "chunk",
            "stream": "stdout",
            "text": '{"type":"node-4","data":{"message":"final from data"}}\n',
            "returncode": None,
        }
        yield {"type": "exit", "stream": None, "text": "", "returncode": 0}

    monkeypatch.setattr(base, "stream_subprocess", fake_stream_subprocess)

    result = await CodexSubscription().execute(
        prompt="hello",
        working_dir=tmp_path,
        tools=[],
        mcp_servers=[],
        env={},
        on_thought=streamed.append,
    )

    assert streamed == ["hello live", "final from data"]
    assert result.thoughts == streamed
    assert result.message == "final from data"
    assert result.output == "final from data"


@pytest.mark.asyncio
async def test_subscription_execute_streams_claude_message_content(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    streamed: list[str] = []

    async def fake_stream_subprocess(*_args, **_kwargs):
        yield {
            "type": "chunk",
            "stream": "stdout",
            "text": (
                '{"type":"assistant","message":{"content":['
                '{"type":"text","text":"first live"},'
                '{"type":"tool_use","name":"Read"},'
                '{"type":"text","text":"second live"}]}}\n'
            ),
            "returncode": None,
        }
        yield {
            "type": "chunk",
            "stream": "stdout",
            "text": '{"type":"result","result":"final answer"}\n',
            "returncode": None,
        }
        yield {"type": "exit", "stream": None, "text": "", "returncode": 0}

    monkeypatch.setattr(base, "stream_subprocess", fake_stream_subprocess)

    result = await ClaudeCodeSubscription().execute(
        prompt="hello",
        working_dir=tmp_path,
        tools=[],
        mcp_servers=[],
        env={},
        on_thought=streamed.append,
    )

    assert streamed == ["first live\nsecond live"]
    assert result.thoughts == streamed
    assert result.message == "final answer"
    assert result.output == "final answer"


@pytest.mark.asyncio
async def test_subscription_execute_extracts_openai_style_provider_usage_metadata(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def fake_stream_subprocess(
        *_args: object, **_kwargs: object
    ) -> AsyncIterator[dict[str, object]]:
        yield {
            "type": "chunk",
            "stream": "stdout",
            "text": (
                '{"type":"result","result":"ok","provider":"openai",'
                '"model":"gpt-5-codex","usage":{"total_input_tokens":40,'
                '"total_output_tokens":15,"totalTokens":55},'
                '"totalCostUsd":"0.0085"}\n'
            ),
            "returncode": None,
        }
        yield {"type": "exit", "stream": None, "text": "", "returncode": 0}

    monkeypatch.setattr(base, "stream_subprocess", fake_stream_subprocess)

    result = await CodexSubscription().execute(
        prompt="hello",
        working_dir=tmp_path,
        tools=[],
        mcp_servers=[],
        env={},
    )

    assert result.output == "ok"
    assert result.usage_metadata == {
        "input_tokens": 40,
        "output_tokens": 15,
        "total_tokens": 55,
        "cost_usd": 0.0085,
        "model": "gpt-5-codex",
        "provider": "openai",
        "source": "provider_metadata",
    }


@pytest.mark.asyncio
async def test_codex_subscription_execute_uses_prompt_file_instead_of_full_prompt_argv(
    monkeypatch, tmp_path: Path
) -> None:
    long_prompt = "hello\n" + ("x" * 50_000)
    captured: dict[str, object] = {}

    async def fake_stream_subprocess(cmd, *_args, **_kwargs):
        captured["cmd"] = cmd
        prompt_arg = cmd[-1]
        captured["prompt_arg"] = prompt_arg
        prompt_path = Path(prompt_arg.rsplit(": ", 1)[1])
        captured["prompt_path"] = prompt_path
        captured["prompt_file_text"] = prompt_path.read_text(encoding="utf-8")
        yield {"type": "chunk", "stream": "stdout", "text": "done\n", "returncode": None}
        yield {"type": "exit", "stream": None, "text": "", "returncode": 0}

    monkeypatch.setattr(base, "stream_subprocess", fake_stream_subprocess)

    result = await CodexSubscription().execute(
        prompt=long_prompt,
        working_dir=tmp_path,
        tools=[],
        mcp_servers=[],
        env={},
    )

    assert result.success
    assert captured["prompt_file_text"] == long_prompt
    assert "Read the complete Gofer Flow agent prompt" in str(captured["prompt_arg"])
    assert long_prompt not in list(captured["cmd"])  # type: ignore[arg-type]
    assert not Path(captured["prompt_path"]).exists()


@pytest.mark.asyncio
async def test_claude_subscription_execute_uses_prompt_file_instead_of_full_prompt_argv(
    monkeypatch, tmp_path: Path
) -> None:
    long_prompt = "hello\n" + ("x" * 50_000)
    captured: dict[str, object] = {}

    async def fake_stream_subprocess(cmd, *_args, **_kwargs):
        captured["cmd"] = cmd
        prompt_arg = cmd[cmd.index("-p") + 1]
        captured["prompt_arg"] = prompt_arg
        prompt_path = Path(prompt_arg.rsplit(": ", 1)[1])
        captured["prompt_path"] = prompt_path
        captured["prompt_file_text"] = prompt_path.read_text(encoding="utf-8")
        yield {"type": "chunk", "stream": "stdout", "text": "done\n", "returncode": None}
        yield {"type": "exit", "stream": None, "text": "", "returncode": 0}

    monkeypatch.setattr(base, "stream_subprocess", fake_stream_subprocess)

    result = await ClaudeCodeSubscription().execute(
        prompt=long_prompt,
        working_dir=tmp_path,
        tools=[],
        mcp_servers=[],
        env={},
    )

    assert result.success
    assert captured["prompt_file_text"] == long_prompt
    assert "Read the complete Gofer Flow agent prompt" in str(captured["prompt_arg"])
    assert long_prompt not in list(captured["cmd"])  # type: ignore[arg-type]
    assert not Path(captured["prompt_path"]).exists()
