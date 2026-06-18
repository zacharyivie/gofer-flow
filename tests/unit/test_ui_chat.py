from __future__ import annotations

from pathlib import Path

import pytest

from gofer.ui import chat
from gofer.ui.chat import (
    ChatProviderError,
    _build_chat_command,
    build_chat_prompt,
    ensure_local_gofer_cli,
    provider_payload,
    run_workflow_chat,
    stream_workflow_chat,
)


def test_chat_prompt_includes_gofer_flow_skill_and_workflow_context() -> None:
    prompt = build_chat_prompt(
        provider="codex",
        model="cli-default",
        messages=[{"role": "user", "body": "Add a review node"}],
        workflow={
            "id": "daily",
            "name": "Daily",
            "sourcePath": "/tmp/daily.toml",
            "description": "1 nodes, 0 edges, 0 agents.",
            "nodes": [{"id": "collect", "type": "bash_command", "meta": "git status"}],
            "edges": [],
            "agents": {},
        },
        gofer_cli_path=Path("/tmp/gofer/bin/gof"),
    )

    assert "Gofer Flow Workflow Builder" in prompt
    assert "use this exact executable path" in prompt
    assert "/tmp/gofer/bin/gof" in prompt
    assert "gof workflow validate" in prompt
    assert "Workflow: daily / Daily" in prompt
    assert "- collect (bash_command): git status" in prompt
    assert "USER: Add a review node" in prompt


def test_chat_prompt_includes_all_workflow_context() -> None:
    prompt = build_chat_prompt(
        provider="codex",
        model="cli-default",
        messages=[{"role": "user", "body": "Which workflow is broken?"}],
        workflow={
            "id": "workflow-assistant",
            "selectedWorkflowId": "daily",
            "workflows": [
                {
                    "id": "daily",
                    "name": "Daily",
                    "sourcePath": "/tmp/daily.toml",
                    "status": "Ready",
                    "description": "1 nodes, 0 edges, 0 agents.",
                    "nodes": [{"id": "collect", "type": "bash_command", "meta": "git status"}],
                    "edges": [],
                    "agents": {},
                },
                {
                    "id": "broken",
                    "name": "Broken",
                    "sourcePath": "/tmp/broken.toml",
                    "status": "Error",
                    "description": "Invalid workflow TOML",
                    "invalid": True,
                    "validationError": "expected table",
                },
            ],
        },
        gofer_cli_path=Path("/tmp/gofer/bin/gof"),
    )

    assert "Selected workflow: daily" in prompt
    assert "Existing workflows: 2" in prompt
    assert "Workflow: daily / Daily [selected]" in prompt
    assert "Workflow: broken / Broken" in prompt
    assert "Validation error: expected table" in prompt


def test_chat_prompt_handles_empty_workflow_context() -> None:
    prompt = build_chat_prompt(
        provider="codex",
        model="cli-default",
        messages=[{"role": "user", "body": "Create my first workflow"}],
        workflow={
            "id": "workflow-assistant",
            "selectedWorkflowId": None,
            "workflows": [],
        },
        gofer_cli_path=Path("/tmp/gofer/bin/gof"),
    )

    assert "Selected workflow: none" in prompt
    assert "Existing workflows: none" in prompt
    assert "create new Gofer Flow workflows" in prompt


def test_provider_payload_lists_codex_and_claude_code() -> None:
    providers = provider_payload()["providers"]

    assert {provider["id"] for provider in providers} == {"codex", "claude_code"}
    assert all("available" in provider for provider in providers)
    assert all(provider["models"] for provider in providers)


def test_ensure_local_gofer_cli_copies_source_binary(monkeypatch, tmp_path) -> None:
    source = tmp_path / "source-gof"
    source.write_text("#!/bin/sh\necho gof\n", encoding="utf-8")
    monkeypatch.setattr(chat, "_gofer_cli_source_path", lambda: source)

    copied = ensure_local_gofer_cli(tmp_path / "gofer-data")

    assert copied == tmp_path / "gofer-data" / "bin" / "gof"
    assert copied.read_text(encoding="utf-8") == source.read_text(encoding="utf-8")
    assert copied.stat().st_mode & 0o111


def test_ensure_local_gofer_cli_preserves_windows_command_shim(
    monkeypatch,
    tmp_path,
) -> None:
    source = tmp_path / "gof.cmd"
    source.write_text("@echo off\r\necho gof\r\n", encoding="utf-8")
    monkeypatch.setattr(chat.sys, "platform", "win32")
    monkeypatch.setattr(chat, "_gofer_cli_source_path", lambda: source)

    copied = ensure_local_gofer_cli(tmp_path / "gofer-data")

    assert copied == tmp_path / "gofer-data" / "bin" / "gof.cmd"
    assert copied.read_text(encoding="utf-8") == source.read_text(encoding="utf-8")


def test_build_chat_command_passes_model_flags() -> None:
    codex = _build_chat_command(
        "codex",
        "gpt-5",
        "hello",
        data_dir=Path("/tmp/gofer-data"),
        working_dir=Path("/tmp/project"),
    )
    claude = _build_chat_command(
        "claude_code",
        "sonnet",
        "hello",
        data_dir=Path("/tmp/gofer-data"),
    )

    assert codex[:2] == ["codex", "exec"]
    assert "--ask-for-approval" not in codex
    assert "--skip-git-repo-check" in codex
    assert option_value(codex, "--sandbox") == "workspace-write"
    assert option_value(codex, "--cd") == "/tmp/project"
    assert option_value(codex, "--add-dir") == "/tmp/gofer-data"
    assert ["--model", "gpt-5"] == codex[-3:-1]
    assert codex[-1] == "hello"
    assert claude == [
        "claude",
        "--print",
        "--add-dir",
        "/tmp/gofer-data",
        "-p",
        "hello",
        "--model",
        "sonnet",
    ]


def test_build_chat_command_uses_resolved_binary_paths() -> None:
    codex = _build_chat_command(
        "codex",
        "cli-default",
        "hello",
        binary_path=r"C:\Users\me\AppData\Roaming\npm\codex.cmd",
        data_dir=Path(r"C:\Users\me\AppData\Roaming\gofer"),
        working_dir=Path(r"C:\project"),
    )
    claude = _build_chat_command(
        "claude_code",
        "cli-default",
        "hello",
        binary_path=r"C:\Users\me\AppData\Roaming\npm\claude.cmd",
        data_dir=Path(r"C:\Users\me\AppData\Roaming\gofer"),
    )

    assert codex[0] == r"C:\Users\me\AppData\Roaming\npm\codex.cmd"
    assert claude[0] == r"C:\Users\me\AppData\Roaming\npm\claude.cmd"
    assert option_value(claude, "--add-dir") == r"C:\Users\me\AppData\Roaming\gofer"


@pytest.mark.asyncio
async def test_run_workflow_chat_reports_process_launch_errors(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(chat.shutil, "which", lambda _binary: r"C:\missing\codex.cmd")

    async def fail_to_spawn(*_args, **_kwargs):
        raise FileNotFoundError("missing codex")

    monkeypatch.setattr(chat, "run_subprocess", fail_to_spawn)

    with pytest.raises(ChatProviderError, match="Could not start 'codex' CLI"):
        await run_workflow_chat(
            provider="codex",
            model="cli-default",
            messages=[{"role": "user", "body": "hello"}],
            workflow=None,
            working_dir=tmp_path,
            data_dir=tmp_path,
        )


@pytest.mark.asyncio
async def test_run_workflow_chat_defaults_working_dir_to_data_dir(monkeypatch, tmp_path) -> None:
    captured_command = None
    captured_cwd = None
    data_dir = tmp_path / "gofer-data"
    monkeypatch.setattr(chat.shutil, "which", lambda _binary: "/usr/bin/codex")
    monkeypatch.setattr(chat.Path, "cwd", lambda: Path("/tmp/.mount_Gofer-read-only"))

    async def capture_subprocess(command, **kwargs):
        nonlocal captured_command, captured_cwd
        captured_command = command
        captured_cwd = kwargs.get("cwd")
        return 0, "done", ""

    monkeypatch.setattr(chat, "run_subprocess", capture_subprocess)

    await run_workflow_chat(
        provider="codex",
        model="cli-default",
        messages=[{"role": "user", "body": "hello"}],
        workflow=None,
        data_dir=data_dir,
    )

    assert captured_command is not None
    assert option_value(captured_command, "--cd") == str(data_dir)
    assert captured_cwd == data_dir
    assert data_dir.exists()


@pytest.mark.asyncio
async def test_run_workflow_chat_uses_prompt_file_for_windows_codex_shim(
    monkeypatch,
    tmp_path,
) -> None:
    captured_command = None
    monkeypatch.setattr(chat.shutil, "which", lambda _binary: r"C:\Users\me\AppData\npm\codex.cmd")

    async def capture_subprocess(command, **_kwargs):
        nonlocal captured_command
        captured_command = command
        return 0, "done", ""

    monkeypatch.setattr(chat, "run_subprocess", capture_subprocess)

    await run_workflow_chat(
        provider="codex",
        model="cli-default",
        messages=[{"role": "user", "body": "Create workflow\nwith two nodes"}],
        workflow={"id": "demo-flow", "name": "Demo Flow"},
        working_dir=tmp_path,
        data_dir=tmp_path,
    )

    assert captured_command is not None
    prompt_arg = captured_command[-1]
    assert "Read the complete Gofer Flow assistant prompt" in prompt_arg
    assert "Create workflow with two nodes" in prompt_arg
    assert "\n" not in prompt_arg

    prompt_files = list((tmp_path / ".gofer-chat-prompts").glob("*.md"))
    assert len(prompt_files) == 1
    prompt_text = prompt_files[0].read_text(encoding="utf-8")
    assert "You are the Gofer Flow workflow assistant." in prompt_text
    assert "USER: Create workflow\nwith two nodes" in prompt_text

    await run_workflow_chat(
        provider="codex",
        model="cli-default",
        messages=[{"role": "user", "body": "Now add review"}],
        workflow={"id": "demo-flow", "name": "Demo Flow"},
        working_dir=tmp_path,
        data_dir=tmp_path,
    )

    prompt_files = list((tmp_path / ".gofer-chat-prompts").glob("*.md"))
    assert len(prompt_files) == 1
    prompt_text = prompt_files[0].read_text(encoding="utf-8")
    assert "USER: Now add review" in prompt_text
    assert "USER: Create workflow\nwith two nodes" not in prompt_text


@pytest.mark.asyncio
async def test_stream_workflow_chat_yields_thoughts_and_final(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(chat.shutil, "which", lambda _binary: "/usr/bin/codex")

    async def fake_stream_subprocess(*_args, **_kwargs):
        yield {"type": "chunk", "stream": "stdout", "text": "working\n", "returncode": None}
        yield {"type": "chunk", "stream": "stderr", "text": "checking files\n", "returncode": None}
        yield {"type": "exit", "stream": None, "text": "", "returncode": 0}

    monkeypatch.setattr(chat, "stream_subprocess", fake_stream_subprocess)

    events = [
        event
        async for event in stream_workflow_chat(
            provider="codex",
            model="cli-default",
            messages=[{"role": "user", "body": "hello"}],
            workflow=None,
            working_dir=tmp_path,
            data_dir=tmp_path,
        )
    ]

    assert [event["type"] for event in events] == ["thought", "thought", "final"]
    assert events[0]["text"] == "working\n"
    assert events[1]["stream"] == "stderr"
    assert events[2]["message"]["body"] == "working\n"


@pytest.mark.asyncio
async def test_stream_workflow_chat_passes_cancel_event(monkeypatch, tmp_path) -> None:
    captured_cancel_event = None
    monkeypatch.setattr(chat.shutil, "which", lambda _binary: "/usr/bin/codex")

    async def fake_stream_subprocess(*_args, **kwargs):
        nonlocal captured_cancel_event
        captured_cancel_event = kwargs.get("cancel_event")
        yield {"type": "exit", "stream": None, "text": "", "returncode": 0}

    monkeypatch.setattr(chat, "stream_subprocess", fake_stream_subprocess)

    events = [
        event
        async for event in stream_workflow_chat(
            provider="codex",
            model="cli-default",
            messages=[{"role": "user", "body": "hello"}],
            workflow=None,
            cancel_event=object(),
            working_dir=tmp_path,
            data_dir=tmp_path,
        )
    ]

    assert captured_cancel_event is not None
    assert events[-1]["type"] == "final"


@pytest.mark.asyncio
async def test_stream_workflow_chat_yields_error_on_nonzero_exit(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(chat.shutil, "which", lambda _binary: "/usr/bin/codex")

    async def fake_stream_subprocess(*_args, **_kwargs):
        yield {"type": "chunk", "stream": "stderr", "text": "nope\n", "returncode": None}
        yield {"type": "exit", "stream": None, "text": "", "returncode": 2}

    monkeypatch.setattr(chat, "stream_subprocess", fake_stream_subprocess)

    events = [
        event
        async for event in stream_workflow_chat(
            provider="codex",
            model="cli-default",
            messages=[{"role": "user", "body": "hello"}],
            workflow=None,
            working_dir=tmp_path,
            data_dir=tmp_path,
        )
    ]

    assert [event["type"] for event in events] == ["thought", "error"]
    assert events[-1]["error"] == "nope\n"


def option_value(command: list[str], option: str) -> str:
    return command[command.index(option) + 1]
