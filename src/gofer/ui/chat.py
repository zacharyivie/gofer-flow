from __future__ import annotations

from collections.abc import AsyncIterator
import os
import shutil
import sys
import threading
from hashlib import sha256
from pathlib import Path
from typing import Any, Literal

from gofer.utils.paths import get_data_dir
from gofer.utils.process import run_subprocess, stream_subprocess

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
    binary_path = shutil.which(binary)
    if binary_path is None:
        raise ChatProviderError(f"'{binary}' CLI is not available on PATH")

    resolved_data_dir = data_dir or get_data_dir()
    resolved_working_dir = working_dir or resolved_data_dir
    resolved_working_dir.mkdir(parents=True, exist_ok=True)
    gofer_cli_path = ensure_local_gofer_cli(resolved_data_dir)
    prompt = build_chat_prompt(
        provider=provider,
        model=model,
        messages=messages,
        workflow=workflow,
        gofer_cli_path=gofer_cli_path,
    )
    prompt = _prepare_prompt_for_cli(
        provider=provider,
        binary_path=binary_path,
        data_dir=resolved_data_dir,
        messages=messages,
        prompt=prompt,
        workflow=workflow,
    )
    command = _build_chat_command(
        provider=provider,
        model=model,
        prompt=prompt,
        binary_path=binary_path,
        data_dir=resolved_data_dir,
        working_dir=resolved_working_dir,
    )
    try:
        returncode, stdout, stderr = await run_subprocess(
            command,
            cwd=resolved_working_dir,
            timeout=300,
        )
    except OSError as exc:
        raise ChatProviderError(f"Could not start '{binary}' CLI: {exc}") from exc

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


async def stream_workflow_chat(
    provider: str,
    model: str,
    messages: list[dict[str, str]],
    workflow: dict[str, Any] | None,
    cancel_event: threading.Event | None = None,
    working_dir: Path | None = None,
    data_dir: Path | None = None,
) -> AsyncIterator[dict[str, Any]]:
    if provider not in {"codex", "claude_code"}:
        raise ChatProviderError(f"Unknown provider '{provider}'")

    binary = "codex" if provider == "codex" else "claude"
    binary_path = shutil.which(binary)
    if binary_path is None:
        raise ChatProviderError(f"'{binary}' CLI is not available on PATH")

    resolved_data_dir = data_dir or get_data_dir()
    resolved_working_dir = working_dir or resolved_data_dir
    resolved_working_dir.mkdir(parents=True, exist_ok=True)
    gofer_cli_path = ensure_local_gofer_cli(resolved_data_dir)
    prompt = build_chat_prompt(
        provider=provider,
        model=model,
        messages=messages,
        workflow=workflow,
        gofer_cli_path=gofer_cli_path,
    )
    prompt = _prepare_prompt_for_cli(
        provider=provider,
        binary_path=binary_path,
        data_dir=resolved_data_dir,
        messages=messages,
        prompt=prompt,
        workflow=workflow,
    )
    command = _build_chat_command(
        provider=provider,
        model=model,
        prompt=prompt,
        binary_path=binary_path,
        data_dir=resolved_data_dir,
        working_dir=resolved_working_dir,
    )

    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []
    try:
        async for event in stream_subprocess(
            command,
            cancel_event=cancel_event,
            cwd=resolved_working_dir,
            timeout=300,
        ):
            if event["type"] == "chunk":
                text = event["text"]
                if not text:
                    continue
                if event["stream"] == "stdout":
                    stdout_chunks.append(text)
                else:
                    stderr_chunks.append(text)
                yield {
                    "type": "thought",
                    "provider": provider,
                    "model": model,
                    "stream": event["stream"],
                    "text": text,
                }
                continue

            returncode = event["returncode"] if event["returncode"] is not None else 1
            stdout = "".join(stdout_chunks)
            stderr = "".join(stderr_chunks)
            if returncode != 0:
                yield {
                    "type": "error",
                    "provider": provider,
                    "model": model,
                    "error": stdout or stderr or f"Provider exited with {returncode}",
                }
                return
            yield {
                "type": "final",
                "provider": provider,
                "model": model,
                "message": {
                    "role": "assistant",
                    "body": stdout or stderr,
                },
            }
            return
    except OSError as exc:
        raise ChatProviderError(f"Could not start '{binary}' CLI: {exc}") from exc


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


def ensure_local_gofer_cli(data_dir: Path) -> Path | None:
    """Copy the gof CLI into the active data directory for assistant sandbox access."""
    source = _gofer_cli_source_path()
    destination = local_gofer_cli_path(data_dir, source)
    if source is None or not source.exists():
        return destination if destination.exists() else None

    destination.parent.mkdir(parents=True, exist_ok=True)

    try:
        if source.samefile(destination):
            _make_executable(destination)
            return destination
    except OSError:
        pass

    if destination.exists() and _same_file_signature(source, destination):
        _make_executable(destination)
        return destination

    temp_destination = destination.with_name(f".{destination.name}.tmp")
    try:
        shutil.copy2(source, temp_destination)
        _make_executable(temp_destination)
        os.replace(temp_destination, destination)
    except OSError:
        temp_destination.unlink(missing_ok=True)
        return destination if destination.exists() else None

    return destination


def local_gofer_cli_path(data_dir: Path, source_path: Path | None = None) -> Path:
    if sys.platform == "win32":
        source_suffix = source_path.suffix.lower() if source_path else ".exe"
        executable_name = f"gof{source_suffix}" if source_suffix in {".bat", ".cmd"} else "gof.exe"
    else:
        executable_name = "gof"
    return data_dir / "bin" / executable_name


def _gofer_cli_source_path() -> Path | None:
    configured_path = os.environ.get("GOFER_CLI_SOURCE_PATH")
    if configured_path:
        return Path(configured_path)

    if getattr(sys, "frozen", False):
        return Path(sys.executable)

    resolved = shutil.which("gof")
    return Path(resolved) if resolved else None


def _same_file_signature(left: Path, right: Path) -> bool:
    try:
        left_stat = left.stat()
        right_stat = right.stat()
    except OSError:
        return False
    return (
        left_stat.st_size == right_stat.st_size
        and int(left_stat.st_mtime) == int(right_stat.st_mtime)
    )


def _make_executable(path: Path) -> None:
    if sys.platform == "win32":
        return
    try:
        path.chmod(path.stat().st_mode | 0o755)
    except OSError:
        return


def _build_chat_command(
    provider: str,
    model: str,
    prompt: str,
    binary_path: str | None = None,
    data_dir: Path | None = None,
    working_dir: Path | None = None,
) -> list[str]:
    if provider == "codex":
        data_dir = data_dir or get_data_dir()
        working_dir = working_dir or Path.cwd()
        command = [
            binary_path or "codex",
            "exec",
            "--color",
            "never",
            "--skip-git-repo-check",
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

    data_dir = data_dir or get_data_dir()
    command = [
        binary_path or "claude",
        "--print",
        "--add-dir",
        str(data_dir),
        "-p",
        prompt,
    ]
    if model != "cli-default":
        command += ["--model", model]
    return command


def _prepare_prompt_for_cli(
    *,
    provider: str,
    binary_path: str,
    data_dir: Path,
    messages: list[dict[str, str]],
    prompt: str,
    workflow: dict[str, Any] | None,
) -> str:
    if provider != "codex" or not _uses_windows_command_shim(binary_path):
        return prompt

    workflow_id = _workflow_id_for_chat(workflow)
    prompt_path = workflow_chat_prompt_path(data_dir, workflow_id)
    prompt_path.parent.mkdir(parents=True, exist_ok=True)
    prompt_path.write_text(prompt, encoding="utf-8")
    latest_user_message = _latest_user_message(messages)
    return (
        "Read the complete Gofer Flow assistant prompt, workflow context, and "
        f"conversation from this file: {prompt_path}. Then answer the latest user "
        f"message: {_single_line(latest_user_message)}"
    )


def delete_workflow_chat_prompt(data_dir: Path, workflow_id: str) -> None:
    workflow_chat_prompt_path(data_dir, workflow_id).unlink(missing_ok=True)


def workflow_chat_prompt_path(data_dir: Path, workflow_id: str) -> Path:
    return data_dir / ".gofer-chat-prompts" / f"{_safe_chat_prompt_stem(workflow_id)}.md"


def _workflow_id_for_chat(workflow: dict[str, Any] | None) -> str:
    if isinstance(workflow, dict) and workflow.get("id"):
        return str(workflow["id"])
    return "no-workflow"


def _safe_chat_prompt_stem(workflow_id: str) -> str:
    safe_name = "".join(
        character if character.isalnum() or character in {"-", "_"} else "-"
        for character in workflow_id.strip().lower()
    ).strip("-")
    digest = sha256(workflow_id.encode("utf-8")).hexdigest()[:12]
    return f"{safe_name or 'workflow'}-{digest}"


def _uses_windows_command_shim(binary_path: str) -> bool:
    return Path(binary_path.lower()).suffix in {".cmd", ".bat"}


def _latest_user_message(messages: list[dict[str, str]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            return message.get("body", "")
    return ""


def _single_line(value: str) -> str:
    return " ".join(value.split())


def build_chat_prompt(
    provider: str,
    model: str,
    messages: list[dict[str, str]],
    workflow: dict[str, Any] | None,
    gofer_cli_path: Path | None = None,
) -> str:
    skill_text = _load_skill_text()
    workflow_context = _compact_workflow_context(workflow)
    cli_context = _gofer_cli_prompt_context(gofer_cli_path)
    transcript = "\n".join(
        f"{message.get('role', 'user').upper()}: {message.get('body', '')}"
        for message in messages[-12:]
    )
    return f"""You are the Gofer Flow workflow assistant.

Selected provider: {provider}
Requested model: {model}

{cli_context}

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

Workflow context:
{workflow_context}

Conversation:
{transcript}

Answer the latest user message. Be concrete and concise. If you recommend workflow
changes, reference exact nodes, edges, agents, or TOML fields."""


def _gofer_cli_prompt_context(gofer_cli_path: Path | None) -> str:
    if gofer_cli_path is None:
        return (
            "Gofer Flow CLI: no local gof executable copy was available. If a bare `gof` "
            "command is unavailable, explain that the CLI could not be located."
        )

    return (
        "Gofer Flow CLI: use this exact executable path for all Gofer Flow CLI commands "
        f"instead of relying on PATH: {gofer_cli_path}"
    )


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
        return "No workflows are currently available."

    if isinstance(workflow.get("workflows"), list):
        return _compact_all_workflows_context(workflow)

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


def _compact_all_workflows_context(context: dict[str, Any]) -> str:
    workflows = [
        workflow
        for workflow in context.get("workflows", [])
        if isinstance(workflow, dict)
    ]
    selected_workflow_id = context.get("selectedWorkflowId")
    if not workflows:
        return "\n".join([
            "Selected workflow: none",
            "Existing workflows: none",
            "The user can still ask you to create new Gofer Flow workflows.",
        ])

    lines = [
        f"Selected workflow: {selected_workflow_id or 'none'}",
        f"Existing workflows: {len(workflows)}",
    ]

    for workflow in workflows:
        workflow_id = workflow.get("id")
        selected_marker = " [selected]" if workflow_id == selected_workflow_id else ""
        lines.extend([
            "",
            f"Workflow: {workflow_id} / {workflow.get('name')}{selected_marker}",
            f"Source path: {workflow.get('sourcePath')}",
            f"Status: {workflow.get('status')}",
            f"Description: {workflow.get('description')}",
        ])
        if workflow.get("invalid"):
            lines.append(f"Validation error: {workflow.get('validationError')}")
            continue

        nodes = workflow.get("nodes") or []
        edges = workflow.get("edges") or []
        agents = workflow.get("agents") or {}
        lines.append("Nodes:")
        lines.extend(
            f"- {node.get('id')} ({node.get('type')}): {node.get('meta', '')}"
            for node in nodes
        )
        if not nodes:
            lines.append("- none")
        lines.append("Edges:")
        lines.extend(
            f"- {edge.get('from')} -> {edge.get('to')} [{edge.get('condition', 'always')}]"
            for edge in edges
        )
        if not edges:
            lines.append("- none")
        lines.append("Agents:")
        agent_lines = [
            f"- {agent_id}: {config.get('subscription', 'unknown')}"
            for agent_id, config in agents.items()
            if isinstance(config, dict)
        ]
        lines.extend(agent_lines or ["- none"])

    return "\n".join(lines)
