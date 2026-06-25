from __future__ import annotations

import os
import shutil
import sys
import threading
from collections.abc import AsyncIterator
from hashlib import sha256
from pathlib import Path
from typing import Any, Literal

from gofer.core.resources import DEFAULT_RESOURCE_LIMITS, ResourceLimits, byte_len
from gofer.utils.logging import get_logger
from gofer.utils.paths import get_data_dir
from gofer.utils.process import run_subprocess, stream_subprocess

ProviderName = Literal["codex", "claude_code"]
CHAT_COMPACT_CHAR_LIMIT = 32_000
CHAT_COMPACT_RECENT_MESSAGES = 8
log = get_logger(__name__)


class ChatProviderError(ValueError):
    pass


async def run_workflow_chat(
    provider: str,
    model: str,
    messages: list[dict[str, str]],
    workflow: dict[str, Any] | None,
    working_dir: Path | None = None,
    data_dir: Path | None = None,
    resource_limits: ResourceLimits | None = None,
) -> dict[str, Any]:
    if provider not in {"codex", "claude_code"}:
        raise ChatProviderError(f"Unknown provider '{provider}'")

    binary = "codex" if provider == "codex" else "claude"
    binary_path = shutil.which(binary)
    if binary_path is None:
        raise ChatProviderError(f"'{binary}' CLI is not available on PATH")

    resolved_data_dir = data_dir or get_data_dir()
    resolved_working_dir = working_dir or resolved_data_dir
    limits = _limits_from_workflow(workflow, resource_limits)
    resolved_working_dir.mkdir(parents=True, exist_ok=True)
    gofer_cli_path = ensure_local_gofer_cli(resolved_data_dir)
    messages, _ = await _compact_chat_messages_if_needed(
        provider=provider,
        model=model,
        messages=messages,
        binary_path=binary_path,
        data_dir=resolved_data_dir,
        working_dir=resolved_working_dir,
        limits=limits,
    )
    prompt = build_chat_prompt(
        provider=provider,
        model=model,
        messages=messages,
        workflow=workflow,
        gofer_cli_path=gofer_cli_path,
    )
    _ensure_prompt_within_limit(prompt, limits)
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
            max_output_bytes=limits.max_subprocess_output_bytes,
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
    resource_limits: ResourceLimits | None = None,
) -> AsyncIterator[dict[str, Any]]:
    if provider not in {"codex", "claude_code"}:
        raise ChatProviderError(f"Unknown provider '{provider}'")

    binary = "codex" if provider == "codex" else "claude"
    binary_path = shutil.which(binary)
    if binary_path is None:
        raise ChatProviderError(f"'{binary}' CLI is not available on PATH")

    resolved_data_dir = data_dir or get_data_dir()
    resolved_working_dir = working_dir or resolved_data_dir
    limits = _limits_from_workflow(workflow, resource_limits)
    resolved_working_dir.mkdir(parents=True, exist_ok=True)
    gofer_cli_path = ensure_local_gofer_cli(resolved_data_dir)
    messages, compacted = await _compact_chat_messages_if_needed(
        provider=provider,
        model=model,
        messages=messages,
        binary_path=binary_path,
        data_dir=resolved_data_dir,
        working_dir=resolved_working_dir,
        limits=limits,
    )
    if compacted:
        yield {
            "type": "compaction",
            "message": "Compacting workflow assistant context",
            "messages": messages,
        }
    prompt = build_chat_prompt(
        provider=provider,
        model=model,
        messages=messages,
        workflow=workflow,
        gofer_cli_path=gofer_cli_path,
    )
    _ensure_prompt_within_limit(prompt, limits)
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
            max_output_bytes=limits.max_subprocess_output_bytes,
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
    """Copy the gof CLI into a trusted helper directory for assistant use."""
    source = _gofer_cli_source_path()
    destination = local_gofer_cli_path(data_dir, source)
    if source is None:
        log.warning("Gofer CLI helper unavailable: no authoritative gof executable found")
        return None
    if not source.exists():
        log.warning("Gofer CLI helper unavailable: source executable does not exist: %s", source)
        return None
    if _is_relative_to(source, data_dir):
        log.warning(
            "Gofer CLI helper unavailable: source executable is inside mutable data directory: %s",
            source,
        )
        return None

    if not _ensure_owner_only_dir(destination.parent):
        log.warning(
            "Gofer CLI helper unavailable: could not restrict helper directory permissions: %s",
            destination.parent,
        )
        return None

    try:
        if source.samefile(destination):
            if _make_owner_executable(destination):
                return destination
            log.warning(
                "Gofer CLI helper unavailable: could not restrict helper file permissions: %s",
                destination,
            )
            return None
    except OSError:
        pass

    if destination.exists() and _same_file_hash(source, destination):
        if _make_owner_executable(destination):
            return destination
        log.warning(
            "Gofer CLI helper unavailable: could not restrict helper file permissions: %s",
            destination,
        )
        return None

    temp_destination = destination.with_name(f".{destination.name}.tmp")
    try:
        shutil.copy2(source, temp_destination)
        if not _make_owner_executable(temp_destination):
            raise OSError("could not restrict helper file permissions")
        os.replace(temp_destination, destination)
        if not _make_owner_executable(destination):
            raise OSError("could not restrict helper file permissions")
    except OSError as exc:
        log.warning(
            "Gofer CLI helper unavailable: could not prepare trusted helper at %s: %s",
            destination,
            exc,
        )
        temp_destination.unlink(missing_ok=True)
        return None

    return destination


def local_gofer_cli_path(data_dir: Path, source_path: Path | None = None) -> Path:
    if sys.platform == "win32":
        source_suffix = source_path.suffix.lower() if source_path else ".exe"
        executable_name = f"gof{source_suffix}" if source_suffix in {".bat", ".cmd"} else "gof.exe"
    else:
        executable_name = "gof"
    return trusted_gofer_cli_dir(data_dir) / executable_name


def trusted_gofer_cli_dir(data_dir: Path) -> Path:
    return data_dir.resolve().parent / ".gofer-trusted-bin"


def _gofer_cli_source_path() -> Path | None:
    configured_path = os.environ.get("GOFER_CLI_SOURCE_PATH")
    if configured_path:
        return Path(configured_path)

    if getattr(sys, "frozen", False):
        return Path(sys.executable)

    resolved = shutil.which("gof")
    return Path(resolved) if resolved else None


def _same_file_hash(left: Path, right: Path) -> bool:
    left_hash = _file_sha256(left)
    right_hash = _file_sha256(right)
    return left_hash is not None and left_hash == right_hash


def _file_sha256(path: Path) -> str | None:
    digest = sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
    except (OSError, ValueError):
        return False
    return True


def _ensure_owner_only_dir(path: Path) -> bool:
    if sys.platform == "win32":
        path.mkdir(parents=True, exist_ok=True)
        return True
    try:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.chmod(0o700)
    except OSError:
        return False
    return _has_file_mode(path, 0o700)


def _make_owner_executable(path: Path) -> bool:
    if sys.platform == "win32":
        return True
    try:
        path.chmod(0o700)
    except OSError:
        return False
    return _has_file_mode(path, 0o700)


def _has_file_mode(path: Path, mode: int) -> bool:
    try:
        return path.stat().st_mode & 0o777 == mode
    except OSError:
        return False


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


async def _compact_chat_messages_if_needed(
    *,
    provider: str,
    model: str,
    messages: list[dict[str, str]],
    binary_path: str,
    data_dir: Path,
    working_dir: Path,
    limits: ResourceLimits,
) -> tuple[list[dict[str, str]], bool]:
    if _messages_size(messages) <= CHAT_COMPACT_CHAR_LIMIT:
        return messages, False

    recent = messages[-CHAT_COMPACT_RECENT_MESSAGES:]
    older = messages[:-CHAT_COMPACT_RECENT_MESSAGES]
    summary = await _summarize_chat_messages(
        provider=provider,
        model=model,
        messages=older,
        binary_path=binary_path,
        data_dir=data_dir,
        working_dir=working_dir,
        limits=limits,
    )
    compacted_messages = [
        {
            "id": "compaction-notice",
            "role": "system",
            "kind": "system",
            "body": "Compacting workflow assistant context",
        },
        {
            "id": "compacted-context",
            "role": "system",
            "kind": "memory",
            "body": f"Compacted prior workflow assistant context:\n{summary}",
        },
        *recent,
    ]
    return compacted_messages, True


async def _summarize_chat_messages(
    *,
    provider: str,
    model: str,
    messages: list[dict[str, str]],
    binary_path: str,
    data_dir: Path,
    working_dir: Path,
    limits: ResourceLimits,
) -> str:
    transcript = _messages_transcript(messages)
    prompt = (
        "Compact this Gofer Flow workflow assistant conversation for future turns.\n"
        "Preserve user goals, workflow IDs, file paths, commands run, decisions, "
        "errors, unresolved tasks, and important assistant outputs. Omit chatter.\n\n"
        f"{transcript}"
    )
    if byte_len(prompt) > limits.max_chat_prompt_bytes:
        return _fallback_chat_summary(messages)
    command = _build_chat_command(
        provider=provider,
        model=model,
        prompt=prompt,
        binary_path=binary_path,
        data_dir=data_dir,
        working_dir=working_dir,
    )
    try:
        returncode, stdout, stderr = await run_subprocess(
            command,
            cwd=working_dir,
            timeout=180,
            max_output_bytes=limits.max_subprocess_output_bytes,
        )
    except OSError:
        return _fallback_chat_summary(messages)
    if returncode != 0:
        return _fallback_chat_summary(messages)
    summary = (stdout or stderr).strip()
    return summary or _fallback_chat_summary(messages)


def _messages_size(messages: list[dict[str, str]]) -> int:
    return sum(len(str(message.get("body", ""))) for message in messages)


def _ensure_prompt_within_limit(prompt: str, limits: ResourceLimits) -> None:
    size = byte_len(prompt)
    limit = limits.max_chat_prompt_bytes
    if size > limit:
        raise ChatProviderError(
            f"Chat prompt exceeds limit {limit} bytes (got {size} bytes)"
        )


def _limits_from_workflow(
    workflow: dict[str, Any] | None,
    fallback: ResourceLimits | None = None,
) -> ResourceLimits:
    limits = fallback or DEFAULT_RESOURCE_LIMITS
    if not isinstance(workflow, dict):
        return limits
    raw_limits = workflow.get("resourceLimits") or workflow.get("resource_limits")
    if not isinstance(raw_limits, dict):
        return limits
    return ResourceLimits(**{**limits.model_dump(), **raw_limits})


def _messages_transcript(messages: list[dict[str, str]]) -> str:
    return "\n\n".join(
        f"{message.get('role', 'user').upper()}:\n{message.get('body', '')}"
        for message in messages
        if message.get("body")
    )


def _fallback_chat_summary(messages: list[dict[str, str]]) -> str:
    transcript = _messages_transcript(messages)
    if len(transcript) <= 12_000:
        return transcript
    return (
        f"{transcript[:6_000]}\n\n[...middle omitted during compaction...]\n\n"
        f"{transcript[-6_000:]}"
    )


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
            "Gofer Flow CLI automation is unavailable because no verified local `gof` "
            "executable could be prepared. Do not run a stale helper from the Gofer data "
            "directory. If a bare `gof` command is unavailable, explain that CLI "
            "validation could not be run."
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
