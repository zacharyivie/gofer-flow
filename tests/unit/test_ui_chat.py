from __future__ import annotations

from pathlib import Path

from gofer.ui.chat import _build_chat_command, build_chat_prompt, provider_payload


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
    assert ["--sandbox", "workspace-write"] == codex[4:6]
    assert ["--cd", "/tmp/project"] == codex[6:8]
    assert ["--add-dir", "/tmp/gofer-data"] == codex[8:10]
    assert ["--model", "gpt-5"] == codex[-3:-1]
    assert codex[-1] == "hello"
    assert claude == ["claude", "--print", "-p", "hello", "--model", "sonnet"]
