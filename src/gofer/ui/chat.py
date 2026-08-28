from __future__ import annotations

import json
import os
import shutil
import sys
import threading
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path
from time import monotonic
from typing import Any, Literal, cast

from gofer.core.provider_capabilities import (
    ProviderCapabilityError,
    provider_capabilities_payload,
    resolve_provider_executable,
    validate_provider_selection_async,
)
from gofer.core.resources import DEFAULT_RESOURCE_LIMITS, ResourceLimits, byte_len
from gofer.utils.logging import get_logger
from gofer.utils.paths import get_data_dir
from gofer.utils.process import run_subprocess, stream_subprocess

ProviderName = Literal["codex", "claude_code"]
CHAT_COMPACT_CHAR_LIMIT = 32_000
CHAT_COMPACT_RECENT_MESSAGES = 8
log = get_logger(__name__)


@dataclass
class _ClaudeTraceState:
    blocks: dict[int, dict[str, Any]] = field(default_factory=dict)
    message_id: str | None = None
    message_sequence: int = 0
    streamed_assistant_message: bool = False


class ChatProviderError(ValueError):
    pass


async def run_workflow_chat(
    provider: str,
    model: str,
    messages: list[dict[str, str]],
    workflow: dict[str, Any] | None,
    effort: str | None = None,
    working_dir: Path | None = None,
    data_dir: Path | None = None,
    resource_limits: ResourceLimits | None = None,
) -> dict[str, Any]:
    if provider not in {"codex", "claude_code"}:
        raise ChatProviderError(f"Unknown provider '{provider}'")
    # ``cli-default`` deliberately leaves model selection to the local CLI.
    # It remains supported for existing API clients and cannot be catalog
    # validated because the CLI may choose dynamically.
    if model != "cli-default" or effort:
        try:
            await validate_provider_selection_async(
                provider,
                None if model == "cli-default" else model,
                effort,
            )
        except ProviderCapabilityError as exc:
            raise ChatProviderError(str(exc)) from exc

    binary = "codex" if provider == "codex" else "claude"
    binary_path = resolve_provider_executable(cast(ProviderName, provider))
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
        effort=effort,
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
    extra_paths = _trusted_workflow_paths(workflow, resolved_working_dir)
    command = _build_chat_command(
        provider=provider,
        model=model,
        effort=effort,
        prompt=prompt,
        binary_path=binary_path,
        data_dir=resolved_data_dir,
        working_dir=resolved_working_dir,
        extra_paths=extra_paths,
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

    final_message = _provider_final_message(provider, _json_payloads(stdout))
    return {
        "provider": provider,
        "model": model,
        "effort": effort,
        "message": {
            "role": "assistant",
            "body": final_message or stdout or stderr,
        },
    }


async def stream_workflow_chat(
    provider: str,
    model: str,
    messages: list[dict[str, str]],
    workflow: dict[str, Any] | None,
    effort: str | None = None,
    cancel_event: threading.Event | None = None,
    working_dir: Path | None = None,
    data_dir: Path | None = None,
    resource_limits: ResourceLimits | None = None,
) -> AsyncIterator[dict[str, Any]]:
    if provider not in {"codex", "claude_code"}:
        raise ChatProviderError(f"Unknown provider '{provider}'")
    if model != "cli-default" or effort:
        try:
            await validate_provider_selection_async(
                provider,
                None if model == "cli-default" else model,
                effort,
            )
        except ProviderCapabilityError as exc:
            raise ChatProviderError(str(exc)) from exc

    binary = "codex" if provider == "codex" else "claude"
    binary_path = resolve_provider_executable(cast(ProviderName, provider))
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
        effort=effort,
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
    extra_paths = _trusted_workflow_paths(workflow, resolved_working_dir)
    command = _build_chat_command(
        provider=provider,
        model=model,
        effort=effort,
        prompt=prompt,
        binary_path=binary_path,
        data_dir=resolved_data_dir,
        working_dir=resolved_working_dir,
        extra_paths=extra_paths,
    )

    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []
    stream_buffers = {"stdout": ""}
    provider_payloads: list[dict[str, Any]] = []
    claude_trace_state = _ClaudeTraceState() if provider == "claude_code" else None
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
                chunk_stream = event["stream"]
                if chunk_stream == "stdout":
                    stdout_chunks.append(text)
                elif chunk_stream == "stderr":
                    stderr_chunks.append(text)
                    continue
                else:
                    continue
                complete_lines, stream_buffers[chunk_stream] = _complete_json_lines(
                    stream_buffers[chunk_stream], text
                )
                for line in complete_lines:
                    payload = _json_object(line)
                    if payload is not None:
                        provider_payloads.append(payload)
                        for trace in _provider_trace_entries(provider, payload, claude_trace_state):
                            yield {
                                "type": "thought",
                                "provider": provider,
                                "model": model,
                                "effort": effort,
                                "stream": chunk_stream,
                                "text": trace.get("body") or trace["title"],
                                "trace": trace,
                            }
                        continue
                continue

            returncode = event["returncode"] if event["returncode"] is not None else 1
            stdout = "".join(stdout_chunks)
            stderr = "".join(stderr_chunks)
            for pending_stream, pending in stream_buffers.items():
                if not pending.strip():
                    continue
                payload = _json_object(pending)
                if payload is not None:
                    provider_payloads.append(payload)
                    for trace in _provider_trace_entries(provider, payload, claude_trace_state):
                        yield {
                            "type": "thought",
                            "provider": provider,
                            "model": model,
                            "effort": effort,
                            "stream": pending_stream,
                            "text": trace.get("body") or trace["title"],
                            "trace": trace,
                        }
            if returncode != 0:
                yield {
                    "type": "error",
                    "provider": provider,
                    "model": model,
                    "effort": effort,
                    "error": _provider_error_message(provider_payloads)
                    or stderr
                    or stdout
                    or f"Provider exited with {returncode}",
                }
                return
            yield {
                "type": "final",
                "provider": provider,
                "model": model,
                "effort": effort,
                "message": {
                    "role": "assistant",
                    "body": _provider_final_message(provider, provider_payloads)
                    or stdout
                    or stderr,
                },
            }
            return
    except OSError as exc:
        raise ChatProviderError(f"Could not start '{binary}' CLI: {exc}") from exc


def _complete_json_lines(buffer: str, chunk: str) -> tuple[list[str], str]:
    lines = f"{buffer}{chunk}".split("\n")
    return lines[:-1], lines[-1]


def _json_object(value: str) -> dict[str, Any] | None:
    try:
        payload = json.loads(value.strip())
    except (json.JSONDecodeError, TypeError):
        return None
    return payload if isinstance(payload, dict) else None


def _json_payloads(value: str) -> list[dict[str, Any]]:
    return [payload for line in value.splitlines() if (payload := _json_object(line)) is not None]


def _provider_trace_entries(
    provider: str,
    payload: dict[str, Any],
    claude_state: _ClaudeTraceState | None = None,
) -> list[dict[str, Any]]:
    if provider == "claude_code":
        return _claude_trace_entries(payload, claude_state)
    return _codex_trace_entries(payload)


def _claude_trace_entries(
    payload: dict[str, Any], state: _ClaudeTraceState | None = None
) -> list[dict[str, Any]]:
    if payload.get("type") == "stream_event":
        return _claude_stream_event_trace_entries(payload.get("event"), state)

    if (
        state is not None
        and payload.get("type") == "assistant"
        and state.streamed_assistant_message
    ):
        # Claude emits a complete assistant message after its partial events.
        # The partial path already surfaced those blocks, so do not duplicate them.
        state.streamed_assistant_message = False
        return []

    message = payload.get("message")
    if not isinstance(message, dict):
        return []
    content = message.get("content")
    if not isinstance(content, list):
        return []
    entries: list[dict[str, Any]] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "text":
            body = _trace_text(block.get("text"))
            if body:
                entries.append({"kind": "summary", "title": "Summary", "body": body})
            continue
        if block_type in {"tool_use", "server_tool_use"}:
            tool_name = _trace_text(block.get("name")) or "Tool"
            tool_input = block.get("input")
            entries.append(
                {
                    "id": _trace_text(block.get("id")),
                    "kind": "tool",
                    "title": tool_name,
                    "detail": _tool_detail(tool_name, tool_input),
                    "input": _trace_value(tool_input),
                    "status": "running",
                    "phase": "start",
                }
            )
            continue
        if block_type == "tool_result" or str(block_type).endswith("_tool_result"):
            output = _trace_value(block.get("content"))
            entries.append(
                {
                    "id": _trace_text(block.get("tool_use_id")),
                    "kind": "tool",
                    "title": "Tool result",
                    "output": output,
                    "status": "error" if block.get("is_error") is True else "complete",
                    "phase": "result",
                }
            )
    return entries


def _claude_stream_event_trace_entries(
    raw_event: Any, state: _ClaudeTraceState | None
) -> list[dict[str, Any]]:
    if not isinstance(raw_event, dict) or state is None:
        return []
    event_type = raw_event.get("type")
    if event_type == "message_start":
        state.blocks.clear()
        state.message_sequence += 1
        message = raw_event.get("message")
        state.message_id = _trace_text(message.get("id")) if isinstance(message, dict) else None
        state.streamed_assistant_message = True
        return []

    index = raw_event.get("index")
    if not isinstance(index, int):
        return []

    if event_type == "content_block_start":
        state.streamed_assistant_message = True
        block = raw_event.get("content_block")
        if not isinstance(block, dict):
            return []
        block_type = str(block.get("type") or "")
        if block_type in {"thinking", "redacted_thinking"}:
            trace_id = f"claude-thinking-{state.message_id or state.message_sequence}-{index}"
            state.blocks[index] = {
                "kind": "thinking",
                "id": trace_id,
                "started_at": monotonic(),
            }
            return [
                {
                    "id": trace_id,
                    "kind": "summary",
                    "title": "Thinking",
                    "status": "running",
                    "phase": "start",
                }
            ]
        if block_type == "tool_result" or block_type.endswith("_tool_result"):
            return [
                {
                    "id": _trace_text(block.get("tool_use_id")),
                    "kind": "tool",
                    "title": "Tool result",
                    "output": _trace_value(block.get("content")),
                    "status": "error" if block.get("is_error") is True else "complete",
                    "phase": "result",
                }
            ]
        if block_type == "text":
            state.blocks[index] = {
                "kind": "text",
                "text_parts": [str(block.get("text") or "")],
            }
            return []
        if block_type not in {"tool_use", "server_tool_use"}:
            return []
        tool_name = _trace_text(block.get("name")) or "Tool"
        tool_input = block.get("input")
        state.blocks[index] = {
            "kind": "tool",
            "id": _trace_text(block.get("id")),
            "name": tool_name,
            "input": tool_input,
            "input_parts": [],
        }
        return [
            {
                "id": _trace_text(block.get("id")),
                "kind": "tool",
                "title": tool_name,
                "detail": _tool_detail(tool_name, tool_input),
                "input": _trace_value(tool_input),
                "status": "running",
                "phase": "start",
            }
        ]

    block_state = state.blocks.get(index)
    if not isinstance(block_state, dict):
        return []
    if event_type == "content_block_delta":
        delta = raw_event.get("delta")
        if not isinstance(delta, dict):
            return []
        delta_type = delta.get("type")
        if block_state.get("kind") == "text" and delta_type == "text_delta":
            block_state["text_parts"].append(str(delta.get("text") or ""))
        elif block_state.get("kind") == "tool" and delta_type == "input_json_delta":
            block_state["input_parts"].append(str(delta.get("partial_json") or ""))
        return []
    if event_type != "content_block_stop":
        return []

    state.blocks.pop(index, None)
    if block_state.get("kind") == "thinking":
        started_at = block_state.get("started_at")
        elapsed = monotonic() - started_at if isinstance(started_at, float) else 0
        return [
            {
                "id": _trace_text(block_state.get("id")),
                "kind": "summary",
                "title": "Thought",
                "detail": f"for {max(1, round(elapsed))}s",
                "status": "complete",
                "phase": "result",
            }
        ]
    if block_state.get("kind") == "text":
        body = _trace_text("".join(block_state.get("text_parts") or []))
        return [{"kind": "summary", "title": "Summary", "body": body}] if body else []

    tool_input = _claude_streamed_tool_input(block_state)
    tool_name = _trace_text(block_state.get("name")) or "Tool"
    return [
        {
            "id": _trace_text(block_state.get("id")),
            "kind": "tool",
            "title": tool_name,
            "detail": _tool_detail(tool_name, tool_input),
            "input": _trace_value(tool_input),
            "status": "running",
            "phase": "update",
        }
    ]


def _claude_streamed_tool_input(block_state: dict[str, Any]) -> Any:
    partial_json = "".join(block_state.get("input_parts") or [])
    if not partial_json.strip():
        return block_state.get("input")
    try:
        return json.loads(partial_json)
    except json.JSONDecodeError:
        return partial_json


def _codex_trace_entries(payload: dict[str, Any]) -> list[dict[str, Any]]:
    item = payload.get("item")
    if not isinstance(item, dict):
        return []
    item_type = str(item.get("type") or "")
    item_id = _trace_text(item.get("id"))
    event_type = str(payload.get("type") or "")
    phase = "result" if event_type.endswith("completed") else "start"
    status = _trace_text(item.get("status")) or ("complete" if phase == "result" else "running")

    if item_type in {"agent_reasoning", "reasoning"}:
        summary = item.get("summary_text") or item.get("reasoning_summary") or item.get("summary")
        if summary is None and "raw_content" not in item:
            summary = item.get("text")
        body = _trace_value(summary)
        return (
            [{"kind": "summary", "title": "Summary", "body": body}]
            if body and not _is_provider_metadata_summary(body)
            else []
        )
    if item_type == "command_execution":
        command = _trace_value(item.get("command"))
        return [
            {
                "id": item_id,
                "kind": "tool",
                "title": "Bash",
                "detail": _first_line(command),
                "input": command,
                "output": _trace_value(item.get("aggregated_output") or item.get("output")),
                "status": status,
                "phase": phase,
            }
        ]
    if item_type == "file_change":
        changes = item.get("changes")
        return [
            {
                "id": item_id,
                "kind": "tool",
                "title": "Edit",
                "detail": _file_change_detail(changes),
                "input": _trace_value(changes),
                "status": status,
                "phase": phase,
            }
        ]
    if item_type == "mcp_tool_call":
        tool_name = _trace_text(item.get("tool")) or _trace_text(item.get("name")) or "MCP tool"
        return [
            {
                "id": item_id,
                "kind": "tool",
                "title": tool_name,
                "detail": _trace_text(item.get("server")),
                "input": _trace_value(item.get("arguments") or item.get("input")),
                "output": _trace_value(
                    item.get("result") or item.get("output") or item.get("error")
                ),
                "status": "error" if item.get("error") else status,
                "phase": phase,
            }
        ]
    if item_type in {"web_search", "web_search_call"}:
        query = _trace_value(item.get("query") or item.get("action"))
        return [
            {
                "id": item_id,
                "kind": "tool",
                "title": "Search",
                "detail": _first_line(query),
                "input": query,
                "output": _trace_value(item.get("result") or item.get("output")),
                "status": status,
                "phase": phase,
            }
        ]
    return []


def _provider_final_message(provider: str, payloads: list[dict[str, Any]]) -> str | None:
    if provider == "claude_code":
        for payload in reversed(payloads):
            result = payload.get("result")
            if isinstance(result, str) and result.strip():
                return result
            text = _message_text(payload.get("message"))
            if text:
                return text
        return None
    for payload in reversed(payloads):
        item = payload.get("item")
        if isinstance(item, dict) and item.get("type") == "agent_message":
            text = _trace_value(item.get("text") or item.get("content"))
            if text:
                return text
        result = payload.get("result")
        if isinstance(result, str) and result.strip():
            return result
    return None


def _provider_error_message(payloads: list[dict[str, Any]]) -> str | None:
    for payload in reversed(payloads):
        for key in ("error", "message", "result"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value
    return None


def _message_text(message: Any) -> str | None:
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if not isinstance(content, list):
        return None
    texts = [
        text
        for block in content
        if isinstance(block, dict)
        and block.get("type") == "text"
        and (text := _trace_text(block.get("text")))
    ]
    return "\n".join(texts) if texts else None


def _trace_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return _trace_text(value)
    if isinstance(value, list):
        if all(isinstance(item, str) for item in value):
            return _trace_text("\n".join(value))
        text_parts = [
            text
            for item in value
            if isinstance(item, dict) and (text := _trace_text(item.get("text")))
        ]
        if text_parts:
            return "\n".join(text_parts)
    try:
        return _trace_text(json.dumps(value, ensure_ascii=False, indent=2))
    except (TypeError, ValueError):
        return _trace_text(str(value))


def _trace_text(value: Any, limit: int = 8_000) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    return text if len(text) <= limit else f"{text[:limit].rstrip()}\n…"


def _first_line(value: str | None) -> str | None:
    return value.splitlines()[0] if value else None


def _is_provider_metadata_summary(value: str) -> bool:
    compact = " ".join(value.lower().split())
    return (
        compact.startswith("tokens used ")
        and compact.removeprefix("tokens used ").replace(",", "").isdigit()
    )


def _tool_detail(tool_name: str, tool_input: Any) -> str | None:
    if not isinstance(tool_input, dict):
        return _first_line(_trace_value(tool_input))
    for key in ("description", "file_path", "path", "query", "command", "pattern"):
        if detail := _trace_text(tool_input.get(key)):
            return _first_line(detail)
    return None


def _file_change_detail(changes: Any) -> str | None:
    if not isinstance(changes, list):
        return None
    paths = [
        path
        for change in changes
        if isinstance(change, dict)
        and (path := _trace_text(change.get("path") or change.get("file_path")))
    ]
    return ", ".join(paths[:3]) if paths else None


def provider_payload() -> dict[str, Any]:
    """Backward-compatible alias for the shared provider capability payload."""
    return provider_capabilities_payload()


def ensure_local_gofer_cli(data_dir: Path) -> Path | None:
    """Copy the gof CLI into a trusted helper directory for assistant use."""
    source = _gofer_cli_source_path()
    destination = local_gofer_cli_path(data_dir, source)
    if source is None:
        log.warning("Taskurotta CLI helper unavailable: no authoritative gof executable found")
        return None
    if not source.exists():
        log.warning(
            "Taskurotta CLI helper unavailable: source executable does not exist: %s",
            source,
        )
        return None
    if _is_relative_to(source, data_dir):
        log.warning(
            "Taskurotta CLI helper unavailable: source executable is inside "
            "mutable data directory: %s",
            source,
        )
        return None

    if not _ensure_owner_only_dir(destination.parent):
        log.warning(
            "Taskurotta CLI helper unavailable: could not restrict helper "
            "directory permissions: %s",
            destination.parent,
        )
        return None

    try:
        if source.samefile(destination):
            if _make_owner_executable(destination):
                return destination
            log.warning(
                "Taskurotta CLI helper unavailable: could not restrict helper file permissions: %s",
                destination,
            )
            return None
    except OSError:
        pass

    if destination.exists() and _same_file_hash(source, destination):
        if _make_owner_executable(destination):
            return destination
        log.warning(
            "Taskurotta CLI helper unavailable: could not restrict helper file permissions: %s",
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
            "Taskurotta CLI helper unavailable: could not prepare trusted helper at %s: %s",
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
    extra_paths: list[Path] | None = None,
    effort: str | None = None,
) -> list[str]:
    if provider == "codex":
        data_dir = data_dir or get_data_dir()
        working_dir = working_dir or Path.cwd()
        trusted_paths = _unique_existing_directories([data_dir, *(extra_paths or [])])
        command = [
            binary_path or "codex",
            "exec",
            "--color",
            "never",
            "--skip-git-repo-check",
            "--sandbox",
            "workspace-write",
            "--json",
            "-c",
            'model_reasoning_summary="concise"',
            "--cd",
            str(working_dir),
        ]
        for path in trusted_paths:
            command += ["--add-dir", str(path)]
        if model and model != "cli-default":
            command += ["--model", model]
        if effort:
            command += ["-c", f'model_reasoning_effort="{effort}"']
        command.append(prompt)
        return command

    data_dir = data_dir or get_data_dir()
    trusted_paths = _unique_existing_directories([data_dir, *(extra_paths or [])])
    command = [
        binary_path or "claude",
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "dontAsk",
    ]
    allowed_tools = ["Read", "Edit", "Write"]
    trusted_gofer_cli = local_gofer_cli_path(data_dir)
    if trusted_gofer_cli.is_file():
        allowed_tools.append(f"Bash({trusted_gofer_cli} *)")
    command += ["--allowedTools", *allowed_tools]
    for path in trusted_paths:
        command += ["--add-dir", str(path)]
    command += ["-p", prompt]
    if model and model != "cli-default":
        command += ["--model", model]
    if effort:
        command += ["--effort", effort]
    return command


def _trusted_workflow_paths(
    workflow: dict[str, Any] | None,
    path_base: Path,
) -> list[Path]:
    if not isinstance(workflow, dict):
        return []
    trusted_paths: list[Path] = []
    for entry in workflow.get("filesystemAccess") or []:
        if not isinstance(entry, dict) or not entry.get("path"):
            continue
        if entry.get("read", True) is False or entry.get("write", True) is False:
            continue
        path = Path(str(entry["path"])).expanduser()
        if not path.is_absolute():
            path = path_base / path
        trusted_paths.append(path)
    return trusted_paths


def _unique_existing_directories(paths: list[Path]) -> list[Path]:
    unique_paths: list[Path] = []
    seen: set[Path] = set()
    for raw_path in paths:
        if _looks_like_windows_absolute_path(raw_path):
            resolved = Path(str(raw_path))
            if resolved in seen:
                continue
            seen.add(resolved)
            unique_paths.append(resolved)
            continue
        path = raw_path.expanduser()
        if path.exists() and path.is_file():
            path = path.parent
        elif not path.exists() and path.suffix:
            path = path.parent
        try:
            resolved = path.resolve()
        except OSError:
            continue
        if resolved in seen:
            continue
        seen.add(resolved)
        unique_paths.append(resolved)
    return unique_paths


def _looks_like_windows_absolute_path(path: Path) -> bool:
    value = str(path)
    return len(value) >= 3 and value[1:3] in {":\\", ":/"}


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
        "Read the complete Taskurotta assistant prompt, workflow context, and "
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
    effort: str | None,
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
        effort=effort,
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
    effort: str | None,
    messages: list[dict[str, str]],
    binary_path: str,
    data_dir: Path,
    working_dir: Path,
    limits: ResourceLimits,
) -> str:
    transcript = _messages_transcript(messages)
    prompt = (
        "Compact this Taskurotta workflow assistant conversation for future turns.\n"
        "Preserve user goals, workflow IDs, file paths, commands run, decisions, "
        "errors, unresolved tasks, and important assistant outputs. Omit chatter.\n\n"
        f"{transcript}"
    )
    if byte_len(prompt) > limits.max_chat_prompt_bytes:
        return _fallback_chat_summary(messages)
    command = _build_chat_command(
        provider=provider,
        model=model,
        effort=effort,
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
        raise ChatProviderError(f"Chat prompt exceeds limit {limit} bytes (got {size} bytes)")


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
        f"{transcript[:6_000]}\n\n[...middle omitted during compaction...]\n\n{transcript[-6_000:]}"
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
    return f"""You are the Taskurotta workflow assistant.

Selected provider: {provider}
Requested model: {model}

{cli_context}

You have access to the Taskurotta workflow-builder skill below regardless of local CLI
skill setup. Follow it when answering workflow design, editing, validation, CLI, TOML,
node, edge, agent, prompt, and scheduling questions.

When the user asks you to create or change a workflow, actually edit the workflow TOML
and prompt files with the Taskurotta CLI and filesystem tools available to you. Do not
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
            "Taskurotta CLI automation is unavailable because no verified local `gof` "
            "executable could be prepared. Do not run a stale helper from the Taskurotta data "
            "directory. If a bare `gof` command is unavailable, explain that CLI "
            "validation could not be run."
        )

    return (
        "Taskurotta CLI: use this exact executable path for all Taskurotta CLI commands "
        f"instead of relying on PATH: {gofer_cli_path}"
    )


def _load_skill_text() -> str:
    skill_path = (
        Path(__file__).resolve().parents[3] / "skills" / "gofer-flow-workflow-builder" / "SKILL.md"
    )
    if not skill_path.exists():
        return (
            "Taskurotta skill file was not found. Use the always-available "
            "`gof schema --format json` authoring contract as the fallback."
        )
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
        f"- {node.get('id')} ({node.get('type')}): {node.get('meta', '')}" for node in nodes
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
        workflow for workflow in context.get("workflows", []) if isinstance(workflow, dict)
    ]
    selected_workflow_id = context.get("selectedWorkflowId")
    if not workflows:
        return "\n".join(
            [
                "Selected workflow: none",
                "Existing workflows: none",
                "The user can still ask you to create new Taskurotta workflows.",
            ]
        )

    lines = [
        f"Selected workflow: {selected_workflow_id or 'none'}",
        f"Existing workflows: {len(workflows)}",
    ]

    for workflow in workflows:
        workflow_id = workflow.get("id")
        selected_marker = " [selected]" if workflow_id == selected_workflow_id else ""
        lines.extend(
            [
                "",
                f"Workflow: {workflow_id} / {workflow.get('name')}{selected_marker}",
                f"Source path: {workflow.get('sourcePath')}",
                f"Status: {workflow.get('status')}",
                f"Description: {workflow.get('description')}",
            ]
        )
        if workflow.get("invalid"):
            lines.append(f"Validation error: {workflow.get('validationError')}")
            continue

        nodes = workflow.get("nodes") or []
        edges = workflow.get("edges") or []
        agents = workflow.get("agents") or {}
        lines.append("Nodes:")
        lines.extend(
            f"- {node.get('id')} ({node.get('type')}): {node.get('meta', '')}" for node in nodes
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
