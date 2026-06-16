from __future__ import annotations

from pathlib import Path

import pytest

from gofer.ui import chat
from gofer.ui.chat import (
    ChatProviderError,
    _build_chat_command,
    build_chat_prompt,
    provider_payload,
    run_workflow_chat,
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
    )

    assert "Gofer Flow Workflow Builder" in prompt
    assert "gof workflow validate" in prompt
    assert "Workflow: daily / Daily" in prompt
    assert "- collect (bash_command): git status" in prompt
    assert "USER: Add a review node" in prompt


def test_provider_payload_lists_codex_and_claude_code() -> None:
    providers = provider_payload()["providers"]

    assert {provider["id"] for provider in providers} == {"codex", "claude_code"}
    assert all("available" in provider for provider in providers)
    assert all(provider["models"] for provider in providers)


def test_build_chat_command_passes_model_flags() -> None:
    codex = _build_chat_command(
        "codex",
        "gpt-5",
        "hello",
        data_dir=Path("/tmp/gofer-data"),
        working_dir=Path("/tmp/project"),
    )
    claude = _build_chat_command("claude_code", "sonnet", "hello")

    assert codex[:2] == ["codex", "exec"]
    assert "--ask-for-approval" not in codex
    assert "--skip-git-repo-check" in codex
    assert option_value(codex, "--sandbox") == "workspace-write"
    assert option_value(codex, "--cd") == "/tmp/project"
    assert option_value(codex, "--add-dir") == "/tmp/gofer-data"
    assert ["--model", "gpt-5"] == codex[-3:-1]
    assert codex[-1] == "hello"
    assert claude == ["claude", "--print", "-p", "hello", "--model", "sonnet"]


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
    )

    assert codex[0] == r"C:\Users\me\AppData\Roaming\npm\codex.cmd"
    assert claude[0] == r"C:\Users\me\AppData\Roaming\npm\claude.cmd"


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


def option_value(command: list[str], option: str) -> str:
    return command[command.index(option) + 1]
