from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Literal

from gofer.utils.paths import get_data_dir
from gofer.utils.process import run_subprocess

ProviderName = Literal["codex", "claude_code"]


class ChatProviderError(ValueError):
    pass


async def run_workflow_chat(
    provider: str,
    model: str,
    messages: list[dict[str, str]],
    workflow: dict[str, Any] | None,
    working_dir: Path | None = None,
    data_dir: Path | None = None,
) -> dict[str, Any]:
    if provider not in {"codex", "claude_code"}:
        raise ChatProviderError(f"Unknown provider '{provider}'")

    binary = "codex" if provider == "codex" else "claude"
    if shutil.which(binary) is None:
        raise ChatProviderError(f"'{binary}' CLI is not available on PATH")

    prompt = build_chat_prompt(provider=provider, model=model, messages=messages, workflow=workflow)
    command = _build_chat_command(
        provider=provider,
        model=model,
        prompt=prompt,
        data_dir=data_dir or get_data_dir(),
        working_dir=working_dir or Path.cwd(),
    )
    returncode, stdout, stderr = await run_subprocess(
        command,
        cwd=working_dir or Path.cwd(),
        timeout=300,
    )
    if returncode != 0:
        raise ChatProviderError(stdout or stderr or f"Provider exited with {returncode}")

    return {
        "provider": provider,
        "model": model,
        "message": {
            "role": "assistant",
            "body": stdout or stderr,
        },
    }


def provider_payload() -> dict[str, Any]:
    return {
        "providers": [
            {
                "id": "codex",
                "name": "Codex",
                "available": shutil.which("codex") is not None,
                "models": ["cli-default", "gpt-5", "gpt-5-codex"],
            },
            {
                "id": "claude_code",
                "name": "Claude Code",
                "available": shutil.which("claude") is not None,
                "models": ["cli-default", "sonnet", "opus"],
            },
        ]
    }


def _build_chat_command(
    provider: str,
    model: str,
    prompt: str,
    data_dir: Path | None = None,
    working_dir: Path | None = None,
) -> list[str]:
    if provider == "codex":
        data_dir = data_dir or get_data_dir()
        working_dir = working_dir or Path.cwd()
        command = [
            "codex",
            "exec",
            "--color",
            "never",
            "--sandbox",
            "workspace-write",
            "--cd",
            str(working_dir),
            "--add-dir",
            str(data_dir),
        ]
        if model != "cli-default":
            command += ["--model", model]
        command.append(prompt)
        return command

    command = ["claude", "--print", "-p", prompt]
    if model != "cli-default":
        command += ["--model", model]
    return command


def build_chat_prompt(
    provider: str,
    model: str,
    messages: list[dict[str, str]],
    workflow: dict[str, Any] | None,
) -> str:
    skill_text = _load_skill_text()
    workflow_context = _compact_workflow_context(workflow)
    transcript = "\n".join(
        f"{message.get('role', 'user').upper()}: {message.get('body', '')}"
        for message in messages[-12:]
    )
    return f"""You are the Gofer Flow workflow assistant.

Selected provider: {provider}
Requested model: {model}

You have access to the Gofer Flow workflow-builder skill below regardless of local CLI
skill setup. Follow it when answering workflow design, editing, validation, CLI, TOML,
node, edge, agent, prompt, and scheduling questions.

When the user asks you to create or change a workflow, actually edit the workflow TOML
and prompt files with the Gofer Flow CLI and filesystem tools available to you. Do not
stop at suggesting TOML unless the environment prevents writes. After editing, run the
skill's validation commands and report the exact workflow path and verification result.

<gofer_flow_skill>
{skill_text}
</gofer_flow_skill>

Current workflow context:
{workflow_context}

Conversation:
{transcript}

Answer the latest user message. Be concrete and concise. If you recommend workflow
changes, reference exact nodes, edges, agents, or TOML fields."""


def _load_skill_text() -> str:
    skill_path = (
        Path(__file__).resolve().parents[3]
        / "skills"
        / "gofer-flow-workflow-builder"
        / "SKILL.md"
    )
    if not skill_path.exists():
        return "Gofer Flow skill file was not found."
    return skill_path.read_text()


def _compact_workflow_context(workflow: dict[str, Any] | None) -> str:
    if not workflow:
        return "No workflow selected."

    nodes = workflow.get("nodes") or []
    edges = workflow.get("edges") or []
    agents = workflow.get("agents") or {}
    node_lines = [
        f"- {node.get('id')} ({node.get('type')}): {node.get('meta', '')}"
        for node in nodes
    ]
    edge_lines = [
        f"- {edge.get('from')} -> {edge.get('to')} [{edge.get('condition', 'always')}]"
        for edge in edges
    ]
    agent_lines = [
        f"- {agent_id}: {config.get('subscription', 'unknown')}"
        for agent_id, config in agents.items()
        if isinstance(config, dict)
    ]
    return "\n".join(
        [
            f"Workflow: {workflow.get('id')} / {workflow.get('name')}",
            f"Source path: {workflow.get('sourcePath')}",
            f"Description: {workflow.get('description')}",
            "Nodes:",
            *(node_lines or ["- none"]),
            "Edges:",
            *(edge_lines or ["- none"]),
            "Agents:",
            *(agent_lines or ["- none"]),
        ]
    )
