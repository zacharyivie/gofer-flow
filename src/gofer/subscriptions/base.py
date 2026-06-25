from __future__ import annotations

import json
import tempfile
import threading
import time
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from gofer.core.agent import AgentResult
from gofer.core.resources import DEFAULT_RESOURCE_LIMITS
from gofer.utils.process import stream_subprocess


class Subscription(ABC):
    async def execute(
        self,
        prompt: str,
        working_dir: Path,
        tools: list[str],
        mcp_servers: list[str],
        env: dict[str, str],
        timeout: float | None = None,
        cancel_event: threading.Event | None = None,
        extra_paths: list[Path] | None = None,
        max_output_bytes: int | None = None,
    ) -> AgentResult:
        start = time.monotonic()
        stdout_chunks: list[str] = []
        stderr_chunks: list[str] = []
        thought_chunks: list[str] = []
        returncode = 1
        with tempfile.TemporaryDirectory(prefix="gofer-agent-prompt-") as prompt_dir:
            prompt_path = Path(prompt_dir) / "prompt.md"
            prompt_path.write_text(prompt, encoding="utf-8")
            prompt_arg = self._prompt_file_instruction(prompt_path)
            cmd = self._build_command(prompt_arg, tools, mcp_servers, extra_paths or [])
            async for event in stream_subprocess(
                cmd,
                cancel_event=cancel_event,
                cwd=working_dir,
                env=env,
                timeout=timeout,
                max_output_bytes=(
                    max_output_bytes
                    if max_output_bytes is not None
                    else DEFAULT_RESOURCE_LIMITS.max_subprocess_output_bytes
                ),
            ):
                if event["type"] == "chunk":
                    text = event["text"]
                    if not text:
                        continue
                    thought_chunks.append(text)
                    if event["stream"] == "stdout":
                        stdout_chunks.append(text)
                    else:
                        stderr_chunks.append(text)
                    continue
                if event["stream"] is None:
                    returncode = event["returncode"] if event["returncode"] is not None else 1
        duration = time.monotonic() - start
        stdout = "".join(stdout_chunks)
        stderr = "".join(stderr_chunks)
        message, usage_metadata = self._parse_provider_output(stdout, stderr)
        thoughts = _non_json_thoughts(thought_chunks)
        return AgentResult(
            agent_id="",
            success=returncode == 0,
            output=message,
            exit_code=returncode,
            duration_seconds=duration,
            thoughts=thoughts,
            message=message,
            usage_metadata=usage_metadata,
        )

    def _prompt_file_instruction(self, prompt_path: Path) -> str:
        return (
            "Read the complete Gofer Flow agent prompt from this file, "
            f"then follow it exactly: {prompt_path}"
        )

    def _parse_provider_output(self, stdout: str, stderr: str) -> tuple[str, dict[str, object]]:
        payloads = _json_payloads(stdout) + _json_payloads(stderr)
        metadata = _usage_metadata_from_payloads(payloads)
        if metadata:
            metadata.setdefault("source", "provider_metadata")
        message = _message_from_payloads(payloads) if payloads else None
        return message or stdout or stderr, metadata

    @abstractmethod
    def _build_command(
        self,
        prompt: str,
        tools: list[str],
        mcp_servers: list[str],
        extra_paths: list[Path] | None = None,
    ) -> list[str]: ...

    @abstractmethod
    def is_available(self) -> bool: ...


def _json_payloads(text: str) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    stripped = text.strip()
    if not stripped:
        return payloads
    try:
        decoded = json.loads(stripped)
    except json.JSONDecodeError:
        decoded = None
    if isinstance(decoded, dict):
        payloads.append(decoded)
        return payloads
    for line in stripped.splitlines():
        try:
            decoded = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(decoded, dict):
            payloads.append(decoded)
    return payloads


def _non_json_thoughts(chunks: list[str]) -> list[str]:
    return [chunk for chunk in chunks if not _json_payloads(chunk)]


def _usage_metadata_from_payloads(payloads: list[dict[str, Any]]) -> dict[str, object]:
    metadata: dict[str, object] = {}
    for payload in payloads:
        for usage in _candidate_usage_dicts(payload):
            _copy_number(
                metadata,
                usage,
                "input_tokens",
                "input_tokens",
                "inputTokens",
                "prompt_tokens",
                "promptTokens",
                "prompt",
                "total_input_tokens",
                "totalInputTokens",
            )
            _copy_number(
                metadata,
                usage,
                "output_tokens",
                "output_tokens",
                "outputTokens",
                "completion_tokens",
                "completionTokens",
                "completion",
                "total_output_tokens",
                "totalOutputTokens",
            )
            _copy_number(metadata, usage, "total_tokens", "total_tokens", "totalTokens")
            _copy_number(
                metadata,
                usage,
                "cost_usd",
                "cost_usd",
                "total_cost_usd",
                "totalCostUsd",
                "total_cost",
                "totalCost",
                "cost",
            )
        for candidate in _candidate_metadata_dicts(payload):
            _copy_text(metadata, candidate, "model", "model")
            _copy_text(metadata, candidate, "profile", "profile")
            _copy_text(metadata, candidate, "provider", "provider")
            _copy_number(
                metadata,
                candidate,
                "cost_usd",
                "cost_usd",
                "total_cost_usd",
                "totalCostUsd",
                "total_cost",
                "totalCost",
                "cost",
            )
    return metadata


def _candidate_usage_dicts(payload: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for key in (
        "usage",
        "usage_metadata",
        "token_usage",
        "tokenUsage",
        "tokens",
        "token_count",
        "tokenCount",
    ):
        value = payload.get(key)
        if isinstance(value, dict):
            candidates.append(value)
    for value in payload.values():
        if isinstance(value, dict):
            candidates.extend(_candidate_usage_dicts(value))
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    candidates.extend(_candidate_usage_dicts(item))
    return candidates


def _candidate_metadata_dicts(payload: dict[str, Any]) -> list[dict[str, Any]]:
    candidates = [payload]
    for value in payload.values():
        if isinstance(value, dict):
            candidates.extend(_candidate_metadata_dicts(value))
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    candidates.extend(_candidate_metadata_dicts(item))
    return candidates


def _message_from_payloads(payloads: list[dict[str, Any]]) -> str | None:
    for payload in reversed(payloads):
        for key in ("result", "output", "text", "message"):
            value = payload.get(key)
            if isinstance(value, str) and value:
                return value
        message = payload.get("message")
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str) and content:
                return content
    return None


def _copy_number(
    target: dict[str, object],
    source: dict[str, Any],
    target_key: str,
    *source_keys: str,
) -> None:
    for key in source_keys:
        value = source.get(key)
        if isinstance(value, int | float) and not isinstance(value, bool):
            target[target_key] = value
            return
        if isinstance(value, str):
            try:
                target[target_key] = float(value) if "." in value else int(value)
                return
            except ValueError:
                continue


def _copy_text(
    target: dict[str, object],
    source: dict[str, Any],
    target_key: str,
    source_key: str,
) -> None:
    value = source.get(source_key)
    if isinstance(value, str) and value:
        target[target_key] = value
