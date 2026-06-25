from __future__ import annotations

import csv
import hashlib
import importlib.metadata
import json
import os
import re
import shlex
import shutil
import sys
import threading
import time
import urllib.parse
import webbrowser
from collections import deque
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, Protocol, cast

import anyio

from gofer.core.agent import (
    Agent,
    AgentConfig,
    AgentResult,
    configured_extra_paths,
    format_agent_memory,
)
from gofer.core.approvals import (
    ApprovalDecisionValue,
    ApprovalRequest,
    ApprovalStore,
    DesktopNotificationAdapter,
    Notification,
    NotificationAdapter,
    wait_for_decision,
)
from gofer.core.graph import EdgeConditionType, GraphNode, WorkflowGraph
from gofer.core.http import HttpClient, HttpRequest, UrllibHttpClient, append_query_params
from gofer.core.llm_prompts import common_llm_task_prompt
from gofer.core.operations import (
    AgentOperation,
    ApprovalGateOperation,
    BashCommandOperation,
    BreakOperation,
    CommonLlmTaskOperation,
    CopyFileOperation,
    CountFanSource,
    DeleteFileOperation,
    DirectoryFanSource,
    FailOperation,
    FanSource,
    FileOperation,
    FolderOperation,
    HttpRequestOperation,
    InfiniteFanSource,
    LocalSearchOperation,
    LocalVectorizeOperation,
    LoopOperation,
    MoveFileOperation,
    NotificationOperation,
    OpenResourceOperation,
    OperationType,
    PassOperation,
    PromptFileOperation,
    PythonScriptOperation,
    ReadFileOperation,
    ShellScriptOperation,
    StartOperation,
    TabularFanSource,
    TriggerEventsFanSource,
    WriteFileOperation,
)
from gofer.core.resources import (
    DEFAULT_RESOURCE_LIMITS,
    ResourceLimitError,
    ResourceLimits,
    byte_len,
    read_text_limited,
    require_limit,
    truncate_text_bytes,
)
from gofer.core.usage import (
    LlmUsageEstimate,
    LlmUsageTotals,
    budget_violations,
    estimate_tokens,
    summarize_node_outputs,
    usage_from_metadata,
)
from gofer.core.workflow import AgenticWorkflow
from gofer.prompts.manager import PromptManager
from gofer.subscriptions.base import Subscription
from gofer.utils.logging import get_logger
from gofer.utils.paths import get_data_dir
from gofer.utils.process import run_subprocess
from gofer.utils.run_state import clear_workflow_stop, workflow_run_stop_path

log = get_logger(__name__)
AGENT_MEMORY_COMPACT_CHAR_LIMIT = 32_000
AGENT_MEMORY_RECENT_TURNS = 8
SECRET_REF_PATTERN = re.compile(
    r"^\{\{\s*secret\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$"
    r"|^secret:([A-Za-z_][A-Za-z0-9_]*)$"
)
SECRET_INTERPOLATION_PATTERN = re.compile(r"\{\{\s*secret\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
TEMPLATE_INTERPOLATION_PATTERN = re.compile(r"\{\{\s*([^}]+)\s*\}\}")
SENSITIVE_FIELD_NAMES = {
    "authorization",
    "cookie",
    "x-api-key",
    "api-key",
    "token",
    "password",
    "secret",
}


def command_shell_args(command: str) -> list[str]:
    if sys.platform == "win32":
        return [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ]
    return ["bash", "-c", command]


def open_resource_args(
    target: str,
    resource_type: str = "auto",
    args: list[str] | None = None,
) -> list[str]:
    if resource_type == "app":
        return [target, *(args or [])]
    if sys.platform == "win32":
        return ["cmd", "/c", "start", "", target]
    if sys.platform == "darwin":
        return ["open", target]
    return ["xdg-open", target]


def _secret_name(value: str) -> str | None:
    match = SECRET_REF_PATTERN.match(value.strip())
    if match is None:
        return None
    return match.group(1) or match.group(2)


def _read_secret(name: str) -> str:
    env_names = [f"GOFER_SECRET_{name}", name]
    for env_name in env_names:
        if env_name in os.environ:
            return os.environ[env_name]
    raise ValueError(f"Missing secret: {name}")


def _replace_secret_tokens(value: str) -> str:
    return SECRET_INTERPOLATION_PATTERN.sub(
        lambda match: _read_secret(match.group(1)),
        value,
    )


def _is_sensitive_field(path: str, configured: set[str]) -> bool:
    normalized = path.lower()
    if normalized in configured:
        return True
    name = normalized.rsplit(".", maxsplit=1)[-1]
    return name in SENSITIVE_FIELD_NAMES or any(token in name for token in ("token", "secret"))


def _secret_reference_names(value: object) -> set[str]:
    if not isinstance(value, str):
        return set()
    match = SECRET_REF_PATTERN.match(value.strip())
    names = {match.group(1) or match.group(2)} if match is not None else set()
    names.update(match.group(1) for match in SECRET_INTERPOLATION_PATTERN.finditer(value))
    return names


def _collect_secret_values(value: object) -> set[str]:
    values: set[str] = set()
    if isinstance(value, str):
        for name in _secret_reference_names(value):
            values.add(_read_secret(name))
    elif isinstance(value, dict):
        for item in value.values():
            values.update(_collect_secret_values(item))
    elif isinstance(value, list):
        for item in value:
            values.update(_collect_secret_values(item))
    return {value for value in values if value}


def _collect_leaf_strings(value: object) -> set[str]:
    if isinstance(value, str):
        return {value} if value else set()
    if isinstance(value, dict):
        values: set[str] = set()
        for item in value.values():
            values.update(_collect_leaf_strings(item))
        return values
    if isinstance(value, list):
        list_values: set[str] = set()
        for item in value:
            list_values.update(_collect_leaf_strings(item))
        return list_values
    if value is None:
        return set()
    text = str(value)
    return {text} if text else set()


def _resolve_template_reference(
    template_context: dict[str, object],
    reference: str,
) -> object | None:
    value: object = template_context
    for part in reference.strip().split("."):
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


def _collect_sensitive_template_values(
    value: object,
    configured: set[str],
    template_context: dict[str, object],
    path: str = "",
    active: bool = False,
) -> set[str]:
    path_is_sensitive = active or (bool(path) and _is_sensitive_field(path, configured))
    if isinstance(value, str):
        if not path_is_sensitive:
            return set()
        values: set[str] = set()
        for match in TEMPLATE_INTERPOLATION_PATTERN.finditer(value):
            resolved = _resolve_template_reference(template_context, match.group(1))
            values.update(_collect_leaf_strings(resolved))
        return values
    if isinstance(value, dict):
        dict_values: set[str] = set()
        for key, item in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            dict_values.update(
                _collect_sensitive_template_values(
                    item,
                    configured,
                    template_context,
                    child_path,
                    path_is_sensitive,
                )
            )
        return dict_values
    if isinstance(value, list):
        list_values: set[str] = set()
        for item in value:
            list_values.update(
                _collect_sensitive_template_values(
                    item,
                    configured,
                    template_context,
                    path,
                    path_is_sensitive,
                )
            )
        return list_values
    return set()


def _collect_configured_secret_values(
    value: object,
    configured: set[str],
    path: str = "",
) -> set[str]:
    if isinstance(value, dict):
        values: set[str] = set()
        for key, item in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            if _is_sensitive_field(child_path, configured):
                values.update(_collect_leaf_strings(item))
            else:
                values.update(_collect_configured_secret_values(item, configured, child_path))
        return values
    if isinstance(value, list):
        list_values: set[str] = set()
        for item in value:
            list_values.update(_collect_configured_secret_values(item, configured, path))
        return list_values
    if path and _is_sensitive_field(path, configured):
        return _collect_leaf_strings(value)
    return set()


def _collect_configured_secret_text_values(
    value: str,
    configured: set[str],
) -> set[str]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        values: set[str] = set()

        def collect_key_value(match: re.Match[str]) -> str:
            key = match.group("key")
            if _is_sensitive_field(key, configured):
                item = match.group("value").strip("\"'")
                if item:
                    values.add(item)
            return match.group(0)

        re.sub(
            r"(?:^|[&\s;,])(?P<key>[A-Za-z0-9_.-]+)\s*=\s*"
            r"(?P<value>[^&\s;,]+)",
            collect_key_value,
            value,
        )
        re.sub(
            r"(?:^|[\s{,])['\"]?(?P<key>[A-Za-z0-9_.-]+)['\"]?\s*:\s*"
            r"(?P<quote>['\"]?)(?P<value>[^,'\"}\s]+)(?P=quote)",
            collect_key_value,
            value,
        )
        return values
    return _collect_configured_secret_values(parsed, configured)


def _replace_known_secrets(value: str, secret_values: set[str]) -> str:
    masked = value
    for secret_value in sorted(secret_values, key=len, reverse=True):
        masked = masked.replace(secret_value, "***")
    return masked


def _mask_http_value(
    value: object,
    configured: set[str],
    path: str = "",
    secret_values: set[str] | None = None,
) -> object:
    if isinstance(value, dict):
        masked: dict[str, object] = {}
        for key, item in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            masked[str(key)] = (
                "***"
                if _is_sensitive_field(child_path, configured)
                else _mask_http_value(item, configured, child_path, secret_values)
            )
        return masked
    if isinstance(value, list):
        return [_mask_http_value(item, configured, path, secret_values) for item in value]
    if isinstance(value, str) and secret_values:
        return _replace_known_secrets(value, secret_values)
    return value


def _mask_http_text(
    value: str,
    configured: set[str],
    *,
    secret_values: set[str],
) -> str:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        masked = _replace_known_secrets(value, secret_values)
    else:
        return json.dumps(
            _mask_http_value(parsed, configured, secret_values=secret_values),
            default=str,
        )

    def mask_key_value(match: re.Match[str]) -> str:
        key = match.group("key")
        if not _is_sensitive_field(key, configured):
            return match.group(0)
        quote = match.groupdict().get("quote") or ""
        return f"{match.group('prefix')}{quote}***{quote}"

    masked = re.sub(
        r"(?P<prefix>(?:^|[&\s;,])(?P<key>[A-Za-z0-9_.-]+)\s*=\s*)"
        r"(?P<value>[^&\s;,]+)",
        mask_key_value,
        masked,
    )
    return re.sub(
        r"(?P<prefix>(?:^|[\s{,])['\"]?(?P<key>[A-Za-z0-9_.-]+)['\"]?\s*:\s*)"
        r"(?P<quote>['\"]?)(?P<value>[^,'\"}\s]+)(?P=quote)",
        mask_key_value,
        masked,
    )


def _mask_http_url(
    url: str,
    *,
    configured: set[str],
    secret_values: set[str],
    url_sensitive: bool,
    sensitive_query_keys: set[str],
) -> str:
    if url_sensitive:
        return "***"
    parsed = urllib.parse.urlsplit(url)
    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    masked_pairs = [
        (
            key,
            "***"
            if key.lower() in sensitive_query_keys or _is_sensitive_field(key, configured)
            else _replace_known_secrets(value, secret_values),
        )
        for key, value in query_pairs
    ]
    masked_url = urllib.parse.urlunsplit(
        parsed._replace(query=urllib.parse.urlencode(masked_pairs))
    )
    return _replace_known_secrets(masked_url, secret_values)


def _extract_dotted_path(data: object, path: str) -> object:
    current = data
    for part in path.strip("{}").split("."):
        if part in {"response", ""}:
            continue
        if isinstance(current, list):
            current = current[int(part)]
            continue
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def _remove_path(path: Path, recursive: bool = False) -> None:
    if path.is_dir():
        if not recursive:
            raise IsADirectoryError(f"{path} is a directory; enable recursive delete")
        shutil.rmtree(path)
        return
    path.unlink()


def _prepare_destination(path: Path, create_dirs: bool, overwrite: bool) -> None:
    if create_dirs:
        path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not overwrite:
        raise FileExistsError(f"{path} already exists")


def _copy_path(source: Path, destination: Path, create_dirs: bool, overwrite: bool) -> None:
    _prepare_destination(destination, create_dirs, overwrite)
    if source.is_dir():
        shutil.copytree(source, destination, dirs_exist_ok=overwrite)
        return
    shutil.copy2(source, destination)


def _move_path(source: Path, destination: Path, create_dirs: bool, overwrite: bool) -> None:
    _prepare_destination(destination, create_dirs, overwrite)
    if destination.exists():
        _remove_path(destination, recursive=True)
    shutil.move(str(source), str(destination))


def _trash_path(path: Path) -> Path:
    trash_root = get_data_dir() / "trash"
    trash_root.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().astimezone().strftime("%Y-%m-%dT%H-%M-%S%f%z")
    destination = trash_root / f"{timestamp}-{path.name}"
    shutil.move(str(path), str(destination))
    return destination


def _safe_path_part(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip(".-")
    return safe or "item"


def _file_path_data(path: Path) -> dict[str, object]:
    return {
        "path": str(path),
        "file_path": str(path),
        "file_name": path.name,
        "file_stem": path.stem,
        "file_extension": path.suffix,
        "parent_path": str(path.parent),
        "directory": str(path.parent),
    }


def _resolve_workflow_path(path: Path, path_base: Path | None) -> Path:
    expanded = path.expanduser()
    if expanded.is_absolute() or path_base is None:
        return expanded
    return path_base / expanded


def _folder_path_data(path: Path) -> dict[str, object]:
    return {
        "path": str(path),
        "folder_path": str(path),
        "folder_name": path.name,
        "parent_path": str(path.parent),
        "directory": str(path),
    }


def _turns_size(turns: list[dict[str, str]]) -> int:
    return sum(len(str(turn.get("body", ""))) for turn in turns)


def _turns_transcript(turns: list[dict[str, str]]) -> str:
    return "\n\n".join(
        f"{turn.get('role', 'message').upper()}:\n{turn.get('body', '')}"
        for turn in turns
        if turn.get("body")
    )


def _agent_memory_compaction_prompt(turns: list[dict[str, str]]) -> str:
    transcript = _turns_transcript(turns)
    return (
        "Compact this Gofer Flow agent-node conversation memory for future node runs.\n"
        "Preserve durable goals, decisions, file paths, commands, inputs, outputs, "
        "errors, unresolved tasks, and details required to continue the workflow. "
        "Omit chatter and redundant text.\n\n"
        f"{transcript}"
    )


async def _summarize_agent_turns(
    turns: list[dict[str, str]],
    agent_config: AgentConfig,
    subscription: Subscription,
    cancel_event: threading.Event | None,
) -> str:
    prompt = _agent_memory_compaction_prompt(turns)
    try:
        result = await subscription.execute(
            prompt=prompt,
            working_dir=agent_config.working_dir,
            tools=agent_config.tools,
            mcp_servers=agent_config.mcp_servers,
            env=agent_config.env,
            timeout=180,
            cancel_event=cancel_event,
            extra_paths=configured_extra_paths(agent_config),
        )
    except Exception:  # noqa: BLE001
        return _fallback_turn_summary(turns)
    if not result.success:
        return _fallback_turn_summary(turns)
    summary = (result.message or result.output).strip()
    return summary or _fallback_turn_summary(turns)


def _fallback_turn_summary(turns: list[dict[str, str]]) -> str:
    transcript = _turns_transcript(turns)
    if len(transcript) <= 12_000:
        return transcript
    return (
        f"{transcript[:6_000]}\n\n[...middle omitted during compaction...]\n\n{transcript[-6_000:]}"
    )


def _load_tabular(
    path: Path,
    max_items: int | None = None,
    max_file_read_bytes: int | None = None,
    max_aggregate_read_bytes: int | None = None,
) -> list[dict[str, object]]:
    suffix = path.suffix.lower()
    if max_file_read_bytes is not None:
        require_limit(path.stat().st_size, max_file_read_bytes, f"{path} size")
    aggregate_bytes = 0

    def _with_row(row: dict[str, object]) -> dict[str, object]:
        return {**row, "_row": json.dumps(row)}

    def _append_row(
        rows: list[dict[str, object]],
        row: dict[str, object],
    ) -> None:
        nonlocal aggregate_bytes
        if max_items is not None and len(rows) >= max_items:
            raise ResourceLimitError(f"tabular fan-out exceeded limit {max_items} items")
        item = _with_row(row)
        row_bytes = byte_len(json.dumps(item, default=str))
        if max_file_read_bytes is not None:
            require_limit(row_bytes, max_file_read_bytes, "tabular fan-out row")
        aggregate_bytes += row_bytes
        if max_aggregate_read_bytes is not None and aggregate_bytes > max_aggregate_read_bytes:
            raise ResourceLimitError(
                "tabular fan-out content exceeded aggregate limit "
                f"{max_aggregate_read_bytes} bytes (got {aggregate_bytes} bytes)"
            )
        rows.append(item)

    if suffix == ".jsonl":
        jsonl_rows: list[dict[str, object]] = []
        with path.open() as f:
            for line in f:
                line = line.strip()
                if line:
                    if max_items is not None and len(jsonl_rows) >= max_items:
                        raise ResourceLimitError(
                            f"tabular fan-out exceeded limit {max_items} items"
                        )
                    _append_row(jsonl_rows, json.loads(line))
        return jsonl_rows
    if suffix == ".csv":
        csv_rows: list[dict[str, object]] = []
        with path.open(newline="") as f:
            for row in csv.DictReader(f):
                _append_row(csv_rows, dict(row))
        return csv_rows
    if suffix == ".xlsx":
        try:
            import openpyxl
        except ImportError as exc:
            raise ImportError(
                "openpyxl is required for .xlsx support: pip install 'gofer-flow[xlsx]'"
            ) from exc
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        try:
            ws = wb.active
            rows_iter = ws.iter_rows(values_only=True)
            headers = [str(h) for h in next(rows_iter)]
            xlsx_rows: list[dict[str, object]] = []
            for row in rows_iter:
                _append_row(xlsx_rows, dict(zip(headers, row)))
            return xlsx_rows
        finally:
            wb.close()
    raise ValueError(f"Unsupported tabular format: {suffix!r}. Use .jsonl, .csv, or .xlsx")


def _token_vector(text: str) -> dict[str, float]:
    tokens = re.findall(r"[A-Za-z0-9_]{2,}", text.lower())
    vector: dict[str, float] = {}
    for token in tokens:
        key = hashlib.blake2b(token.encode("utf-8"), digest_size=4).hexdigest()
        vector[key] = vector.get(key, 0.0) + 1.0
    norm = sum(value * value for value in vector.values()) ** 0.5
    if norm:
        vector = {key: value / norm for key, value in vector.items()}
    return vector


def _cosine_similarity(left: dict[str, float], right: dict[str, float]) -> float:
    if len(left) > len(right):
        left, right = right, left
    return sum(value * right.get(key, 0.0) for key, value in left.items())


class LocalVectorStrategy(Protocol):
    embedding_strategy: str
    search_strategy: str

    def embed(self, text: str) -> dict[str, float]: ...

    def score(self, query_vector: dict[str, float], entry_vector: object) -> float: ...


@dataclass(frozen=True)
class HashTokenCosineStrategy:
    embedding_strategy: str = "hash_token_v1"
    search_strategy: str = "cosine_v1"

    def embed(self, text: str) -> dict[str, float]:
        return _token_vector(text)

    def score(self, query_vector: dict[str, float], entry_vector: object) -> float:
        if not isinstance(entry_vector, dict):
            return 0.0
        return _cosine_similarity(query_vector, cast(dict[str, float], entry_vector))


def _chunk_text(text: str, chunk_size: int, chunk_overlap: int) -> list[str]:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be greater than zero")
    overlap = max(0, min(chunk_overlap, chunk_size - 1))
    chunks = []
    start = 0
    while start < len(text):
        chunks.append(text[start : start + chunk_size])
        start += chunk_size - overlap
    return chunks or [""]


VECTOR_INDEX_VERSION = 2
VECTOR_EMBEDDING_STRATEGY = "hash_token_v1"
VECTOR_SEARCH_STRATEGY = "cosine_v1"
LOCAL_VECTOR_STRATEGIES: dict[tuple[str, str], LocalVectorStrategy] = {
    (VECTOR_EMBEDDING_STRATEGY, VECTOR_SEARCH_STRATEGY): cast(
        LocalVectorStrategy,
        HashTokenCosineStrategy(),
    ),
}


def _local_vector_strategy(
    embedding_strategy: str,
    search_strategy: str,
) -> LocalVectorStrategy:
    strategy = LOCAL_VECTOR_STRATEGIES.get((embedding_strategy, search_strategy))
    if strategy is None:
        raise ValueError(
            "Unsupported local vector strategy: "
            f"embedding={embedding_strategy!r}, search={search_strategy!r}"
        )
    return strategy


def _gofer_version() -> str:
    try:
        return importlib.metadata.version("gofer-flow")
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


def _hash_file(path: Path, max_bytes: int) -> str:
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            total += len(block)
            if total > max_bytes:
                raise ResourceLimitError(
                    f"{path} size exceeded limit {max_bytes} bytes (got {total} bytes)"
                )
            digest.update(block)
    return digest.hexdigest()


def _vector_file_id(path: Path) -> str:
    return str(path.resolve(strict=False))


def _default_vector_entries_path(index_path: Path) -> Path:
    return index_path.with_name(f"{index_path.name}.entries.jsonl")


def _vector_entries_path(index_path: Path, index: dict[str, Any] | None = None) -> Path:
    if index:
        entries_file = index.get("entries_file")
        if isinstance(entries_file, str) and entries_file:
            path = Path(entries_file)
            return path if path.is_absolute() else index_path.parent / path
    return _default_vector_entries_path(index_path)


def _iter_vector_sidecar_entries(
    entries_path: Path,
    max_bytes: int,
) -> Iterator[dict[str, Any]]:
    consumed = 0
    try:
        with entries_path.open(encoding="utf-8") as file:
            for line_number, line in enumerate(file, start=1):
                consumed += byte_len(line)
                if consumed > max_bytes:
                    raise ResourceLimitError(
                        f"local vector index entries exceeded limit {max_bytes} bytes"
                    )
                if not line.strip():
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ValueError(
                        f"Invalid vector index entries JSONL: {entries_path}:{line_number}"
                    ) from exc
                if not isinstance(entry, dict):
                    raise ValueError(
                        f"Invalid vector index entry: {entries_path}:{line_number}"
                    )
                yield entry
    except FileNotFoundError as exc:
        raise ValueError(f"Missing vector index entries file: {entries_path}") from exc


def _iter_vector_index_entries(
    index_path: Path,
    index: dict[str, Any] | None,
    max_bytes: int,
) -> Iterator[dict[str, Any]]:
    if not index:
        return
    entries = index.get("entries")
    if isinstance(entries, list):
        for entry in entries:
            if isinstance(entry, dict):
                yield entry
        return
    if isinstance(index.get("entries_file"), str):
        yield from _iter_vector_sidecar_entries(
            _vector_entries_path(index_path, index),
            max_bytes,
        )


def _vector_index_disk_size(index_path: Path, index: dict[str, Any] | None) -> int:
    size = index_path.stat().st_size if index_path.exists() else 0
    entries_file = index.get("entries_file") if isinstance(index, dict) else None
    if isinstance(entries_file, str):
        entries_path = _vector_entries_path(index_path, index)
        if entries_path.exists():
            size += entries_path.stat().st_size
    return size


def _write_vector_entry(file: Any, entry: dict[str, object]) -> int:
    line = json.dumps(entry, default=str) + "\n"
    file.write(line)
    return byte_len(line)


def _load_vector_index(
    index_path: Path,
    max_bytes: int,
    *,
    include_entries: bool = True,
) -> dict[str, Any] | None:
    if not index_path.exists():
        return None
    try:
        index_text = read_text_limited(index_path, max_bytes=max_bytes)
        index = json.loads(index_text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid vector index JSON: {index_path}") from exc
    if not isinstance(index, dict):
        raise ValueError(f"Invalid vector index format: {index_path}")
    entries = index.get("entries")
    if entries is not None and not isinstance(entries, list):
        raise ValueError(f"Invalid vector index entries: {index_path}")
    if include_entries and entries is None and isinstance(index.get("entries_file"), str):
        index["entries"] = list(
            _iter_vector_sidecar_entries(
                _vector_entries_path(index_path, index),
                max_bytes,
            )
        )
    return index


def _vector_index_metadata(
    op: LocalVectorizeOperation,
    source_path: Path,
) -> dict[str, object]:
    return {
        "source_root": str(source_path),
        "glob": op.glob,
        "recursive": op.recursive,
        "chunk_size": op.chunk_size,
        "chunk_overlap": op.chunk_overlap,
        "encoding": op.encoding,
        "gofer_version": _gofer_version(),
        "embedding_strategy": op.embedding_strategy,
        "search_strategy": op.search_strategy,
    }


def _vector_index_compatible(
    index: dict[str, Any] | None,
    metadata: dict[str, object],
) -> bool:
    if not index or index.get("version") != VECTOR_INDEX_VERSION:
        return False
    existing = index.get("metadata")
    if not isinstance(existing, dict):
        return False
    compared_keys = (
        "source_root",
        "glob",
        "recursive",
        "chunk_size",
        "chunk_overlap",
        "encoding",
        "embedding_strategy",
        "search_strategy",
    )
    return all(existing.get(key) == metadata.get(key) for key in compared_keys)


def _vector_index_file_records(index: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    if not index:
        return {}
    files = index.get("files")
    if not isinstance(files, dict):
        return {}
    return {str(file_id): record for file_id, record in files.items() if isinstance(record, dict)}


def _vector_index_entries_by_file(index: dict[str, Any] | None) -> dict[str, list[dict[str, Any]]]:
    entries_by_file: dict[str, list[dict[str, Any]]] = {}
    if not index:
        return entries_by_file
    for entry in index.get("entries", []):
        if not isinstance(entry, dict):
            continue
        file_id = entry.get("file_id")
        if not isinstance(file_id, str):
            path = entry.get("path")
            file_id = str(path) if path is not None else ""
        if file_id:
            entries_by_file.setdefault(file_id, []).append(entry)
    return entries_by_file


def _resolve_fan_items(
    source: FanSource,
    ctx: ExecutionContext,
    limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS,
    path_base: Path | None = None,
) -> list[dict[str, object]]:
    if isinstance(source, CountFanSource):
        count = ctx.resolve_dynamic_count(source.count)
        if count > limits.max_fanout_items:
            raise ResourceLimitError(
                f"count fan-out exceeded limit {limits.max_fanout_items} items (got {count})"
            )
        return [{"index": str(i)} for i in range(count)]
    if isinstance(source, TabularFanSource):
        path = _resolve_workflow_path(source.path, path_base)
        return _load_tabular(
            path,
            max_items=limits.max_fanout_items,
            max_file_read_bytes=limits.max_file_read_bytes,
            max_aggregate_read_bytes=limits.max_aggregate_read_bytes,
        )
    if isinstance(source, DirectoryFanSource):
        source_path = _resolve_workflow_path(source.path, path_base)
        items: list[dict[str, object]] = []
        aggregate_bytes = 0
        scanned = 0
        for p in source_path.glob(source.glob):
            scanned += 1
            if scanned > limits.max_files_scanned:
                raise ResourceLimitError(
                    f"directory fan-out scan exceeded limit {limits.max_files_scanned} paths"
                )
            if p.is_file():
                if len(items) >= limits.max_fanout_items:
                    raise ResourceLimitError(
                        f"directory fan-out exceeded limit {limits.max_fanout_items} items"
                    )
                entry: dict[str, object] = {
                    **_file_path_data(p),
                }
                if source.include_content:
                    size = p.stat().st_size
                    require_limit(size, limits.max_file_read_bytes, f"{p} size")
                    aggregate_bytes += size
                    if aggregate_bytes > limits.max_aggregate_read_bytes:
                        raise ResourceLimitError(
                            "directory fan-out content exceeded aggregate limit "
                            f"{limits.max_aggregate_read_bytes} bytes "
                            f"(got {aggregate_bytes} bytes)"
                        )
                    entry["file_content"] = p.read_text(errors="replace")
                items.append(entry)
        return sorted(items, key=lambda item: str(item.get("path", "")))
    if isinstance(source, TriggerEventsFanSource):
        events = ctx.trigger.get("events", [])
        if not isinstance(events, list):
            return []
        items = []
        aggregate_bytes = 0
        for idx, event in enumerate(events):
            if len(items) >= limits.max_fanout_items:
                raise ResourceLimitError(
                    f"trigger-event fan-out exceeded limit {limits.max_fanout_items} items"
                )
            if not isinstance(event, dict):
                continue
            item = {
                **event,
                "index": str(idx),
                "event_json": json.dumps(event),
            }
            event_path_value = event.get("path")
            if event_path_value:
                event_path = Path(str(event_path_value))
                item.update(_file_path_data(event_path))
                item.setdefault("name", event_path.name)
                item.setdefault("directory", str(event_path.parent))
            if source.include_content and event_path_value:
                file_path = Path(str(event_path_value))
                if file_path.exists() and file_path.is_file():
                    size = file_path.stat().st_size
                    require_limit(size, limits.max_file_read_bytes, f"{file_path} size")
                    aggregate_bytes += size
                    if aggregate_bytes > limits.max_aggregate_read_bytes:
                        raise ResourceLimitError(
                            "trigger-event fan-out content exceeded aggregate limit "
                            f"{limits.max_aggregate_read_bytes} bytes "
                            f"(got {aggregate_bytes} bytes)"
                        )
                    item["file_content"] = file_path.read_text(errors="replace")
            items.append(item)
        return items
    if isinstance(source, InfiniteFanSource):
        return []
    raise ValueError(f"Unknown fan source type: {source}")  # pragma: no cover


@dataclass
class QueuedNode:
    node_id: str
    after_loop_origin: str | None = None
    loop_origin: str | None = None
    loop_item: dict[str, object] | None = None
    loop_index: int | None = None
    loop_items: list[dict[str, object]] | None = None
    loop_infinite: bool = False
    loop_max_concurrency: int = 16
    loop_fail_fast: bool = False

    @property
    def key(self) -> tuple[str, str | None, int | None]:
        return (self.node_id, self.loop_origin or self.after_loop_origin, self.loop_index)


@dataclass
class NodeOutput:
    node_id: str
    success: bool
    output: str
    exit_code: int
    duration_seconds: float
    skipped: bool = False
    fan_outputs: list[tuple[str, str]] = field(default_factory=list)
    terminal_status: str | None = None
    loop_items: list[dict[str, object]] | None = None
    loop_infinite: bool = False
    loop_max_concurrency: int = 16
    loop_fail_fast: bool = False
    type: str = ""
    text: str | None = None
    value: object | None = None
    data: dict[str, object] = field(default_factory=dict)
    items: list[object] = field(default_factory=list)
    error: str | None = None

    def __post_init__(self) -> None:
        if self.text is None:
            self.text = self.output
        if self.value is None:
            self.value = self.text
        if not self.success and self.error is None:
            self.error = self.output

    def contract(self) -> dict[str, object]:
        return {
            "node_id": self.node_id,
            "type": self.type,
            "success": self.success,
            "text": self.text or "",
            "output": self.output,
            "value": self.value,
            "data": self.data,
            "items": self.items,
            "error": self.error,
            "exit_code": self.exit_code,
            "duration_seconds": self.duration_seconds,
            "skipped": self.skipped,
            "terminal_status": self.terminal_status,
            "loop_items": self.loop_items,
            "loop_infinite": self.loop_infinite,
            "loop_max_concurrency": self.loop_max_concurrency,
            "loop_fail_fast": self.loop_fail_fast,
        }


class LlmBudgetBlockedError(Exception):
    def __init__(self, violations: list[str]) -> None:
        super().__init__("; ".join(violations))
        self.violations = violations


@dataclass
class ExecutionContext:
    node_outputs: dict[str, NodeOutput] = field(default_factory=dict)
    node_runs: dict[str, list[NodeOutput]] = field(default_factory=dict)
    trigger: dict[str, Any] = field(default_factory=dict)

    def record(self, output: NodeOutput) -> None:
        self.node_outputs[output.node_id] = output
        self.node_runs.setdefault(output.node_id, []).append(output)

    def resolve_dynamic_count(self, value: int | str | None) -> int:
        if value is None:
            return 1
        if isinstance(value, int):
            return value
        if not str(value).strip():
            return 1
        if str(value).strip().isdigit():
            return int(str(value).strip())
        parts = value.strip("{}").split(".")
        obj: Any = {k: v.contract() for k, v in self.node_outputs.items()}
        for part in parts:
            if not isinstance(obj, dict):
                raise ValueError(f"Cannot resolve dynamic_count path: {value!r}")
            obj = obj.get(part)
        if obj is None:
            raise ValueError(f"Cannot resolve dynamic_count path: {value!r}")
        return int(obj)

    def resolve_path(self, value: str) -> object:
        return self.resolve_path_with_loop(value, None)

    def resolve_path_with_loop(
        self,
        value: str,
        loop_item: dict[str, object] | None = None,
        current_node_id: str | None = None,
        graph: WorkflowGraph | None = None,
    ) -> object:
        if value in self.node_outputs:
            return self.node_outputs[value].output
        parts = value.strip("{}").split(".")
        if parts and parts[0] == "trigger":
            obj: Any = self.trigger
            parts = parts[1:]
        elif parts and parts[0] == "loop":
            obj = {"current": loop_item or {}, **(loop_item or {})}
            parts = parts[1:]
        elif parts and parts[0] == "previous":
            if current_node_id is None or graph is None:
                obj = {}
            else:
                predecessors = [
                    self.node_outputs[pid]
                    for pid in graph._graph.predecessors(current_node_id)
                    if pid in self.node_outputs
                ]
                obj = predecessors[-1].contract() if predecessors else {}
            parts = parts[1:]
        else:
            obj = {k: v.contract() for k, v in self.node_outputs.items()}
        for part in parts:
            if isinstance(obj, list):
                obj = obj[int(part)]
                continue
            if not isinstance(obj, dict):
                raise ValueError(f"Cannot resolve path: {value!r}")
            obj = obj.get(part)
        return "" if obj is None else obj

    def predecessor_outputs(self, node_id: str, graph: WorkflowGraph) -> list[NodeOutput]:
        return [
            self.node_outputs[pid]
            for pid in graph._graph.predecessors(node_id)
            if pid in self.node_outputs
        ]


@dataclass
class ExecutionResult:
    workflow_id: str
    success: bool
    node_outputs: dict[str, NodeOutput]
    duration_seconds: float
    node_runs: dict[str, list[NodeOutput]] = field(default_factory=dict)
    log_path: Path | None = None
    usage_summary: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class LlmUsageReservation:
    usage: LlmUsageEstimate


class WorkflowRunLog:
    def __init__(
        self,
        workflow_id: str,
        base_dir: Path | None = None,
        limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS,
        existing_path: Path | None = None,
    ) -> None:
        self.workflow_id = workflow_id
        self._limits = limits
        self._node_log_bytes: dict[tuple[str, int | None, int | None], int] = {}
        self._node_log_omissions: set[tuple[tuple[str, int | None, int | None], str]] = set()
        self._active_node_runs: dict[str, tuple[int | None, int | None]] = {}
        self._run_log_bytes = 0
        self.started_at = datetime.now().astimezone()
        if existing_path is not None:
            self.path = existing_path
            self.events_path = self.path.with_suffix(".events.json")
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self.path.exists():
                self._run_log_bytes = byte_len(self.path.read_text(encoding="utf-8"))
            return
        timestamp = self.started_at.strftime("%Y-%m-%dT%H-%M-%S%f%z")
        root = base_dir or get_data_dir() / "logs"
        self.path = root / workflow_id / f"{timestamp}.log"
        self.events_path = self.path.with_suffix(".events.json")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._append(f"{self._now()} - {self.workflow_id} started successfully\n")
        self._write_events_payload({"events": [], "nodes": {}})

    def info(self, message: str) -> None:
        self._write("INFO", message)

    def error(self, message: str) -> None:
        self._write("ERROR", message)

    def node(self, node_id: str, message: str) -> None:
        self._write("NODE", f"{node_id} - {message}")

    def begin_node_attempt(self, node_id: str, run_number: int, attempt: int) -> None:
        self._active_node_runs[node_id] = (run_number, attempt)

    def node_output(self, node_id: str, label: str, value: str) -> None:
        if not value:
            return
        self._write_node_event(node_id, label, value)

    def node_agent_event(self, node_id: str, label: str, value: str) -> None:
        if not value:
            return
        if not value.rstrip("\n").splitlines():
            return
        self._write_node_event(node_id, label, value)

    def complete(
        self,
        success: bool,
        reason: str | None = None,
        *,
        terminal_status: Literal["completed", "failed", "stopped"] | None = None,
    ) -> None:
        status = terminal_status or ("completed" if success else "failed")
        if status == "completed":
            self.info(f"{self.workflow_id} completed successfully")
            message = reason or "completed successfully"
        elif status == "stopped":
            message = reason or "stopped by user"
            self.info(f"{self.workflow_id} {message}")
        else:
            self.error(f"{self.workflow_id} failed due to {reason or 'unknown error'}")
            message = reason or "failed"
        self.event("workflow", status, message=message, success=success)

    def event(
        self,
        node_id: str,
        status: str,
        *,
        attempt: int | None = None,
        run_number: int | None = None,
        message: str = "",
        duration_seconds: float | None = None,
        exit_code: int | None = None,
        success: bool | None = None,
        skipped: bool = False,
        fan_out_item: dict[str, object] | None = None,
        data: dict[str, object] | None = None,
    ) -> None:
        payload = self._read_events_payload()
        events = payload.setdefault("events", [])
        nodes = payload.setdefault("nodes", {})
        if not isinstance(events, list) or not isinstance(nodes, dict):
            payload = {"events": [], "nodes": {}}
            events = payload["events"]
            nodes = payload["nodes"]
        events_list = cast(list[dict[str, object]], events)
        nodes_by_id = cast(dict[str, object], nodes)
        occurred_at = self._now()
        event = {
            "nodeId": node_id,
            "status": status,
            "occurredAt": occurred_at,
            "attempt": attempt,
            "runNumber": run_number,
            "message": message,
            "durationSeconds": duration_seconds,
            "exitCode": exit_code,
            "success": success,
            "skipped": skipped,
            "fanOutItem": fan_out_item,
            "data": data or {},
        }
        events_list.append({key: value for key, value in event.items() if value is not None})
        if node_id != "workflow":
            node_state = nodes_by_id.setdefault(node_id, {"nodeId": node_id, "attempts": []})
            if isinstance(node_state, dict):
                if status != "edge_decision":
                    node_state.update(
                        {
                            "nodeId": node_id,
                            "status": status,
                            "updatedAt": occurred_at,
                            "durationSeconds": duration_seconds,
                            "exitCode": exit_code,
                            "success": success,
                            "skipped": skipped,
                            "message": message,
                        }
                    )
                if status == "started":
                    attempts = node_state.setdefault("attempts", [])
                    if isinstance(attempts, list):
                        attempts.append(
                            {
                                "attempt": attempt,
                                "runNumber": run_number,
                                "startedAt": occurred_at,
                                "fanOutItem": fan_out_item,
                                "inputs": (data or {}).get("inputs", {}),
                            }
                        )
                if status in {"completed", "failed", "stopped"}:
                    attempts = node_state.setdefault("attempts", [])
                    if isinstance(attempts, list) and attempts:
                        matching_attempt = self._matching_attempt(
                            attempts,
                            attempt=attempt,
                            run_number=run_number,
                            fan_out_item=fan_out_item,
                        )
                        matching_attempt.update(
                            {
                                "finishedAt": occurred_at,
                                "durationSeconds": duration_seconds,
                                "exitCode": exit_code,
                                "success": success,
                                "output": (data or {}).get("output", ""),
                                "error": (data or {}).get("error", ""),
                            }
                        )
                        for detail_key in ("inputs", "stdout", "stderr", "message", "prompt"):
                            if data and detail_key in data:
                                matching_attempt[detail_key] = data[detail_key]
                        if fan_out_item is not None:
                            aggregate_status, aggregate_success = self._fan_out_attempt_status(
                                attempts,
                                fallback_status=status,
                            )
                            node_state["status"] = aggregate_status
                            node_state["success"] = aggregate_success
                if data:
                    existing_data = cast(dict[str, object], node_state.get("data", {}))
                    if status == "edge_decision":
                        decisions = existing_data.setdefault("edgeDecisions", [])
                        if isinstance(decisions, list):
                            decisions.append(data)
                    else:
                        existing_data.update(data)
                    node_state["data"] = existing_data
        self._write_events_payload(payload)

    def update_node_data(self, node_id: str, data: dict[str, object]) -> None:
        payload = self._read_events_payload()
        nodes = payload.setdefault("nodes", {})
        if not isinstance(nodes, dict):
            return
        node_state = nodes.setdefault(node_id, {"nodeId": node_id, "attempts": []})
        if not isinstance(node_state, dict):
            return
        existing_data = cast(dict[str, object], node_state.get("data", {}))
        existing_data.update(data)
        node_state["data"] = existing_data
        node_state["updatedAt"] = self._now()
        self._write_events_payload(payload)

    @staticmethod
    def _matching_attempt(
        attempts: list[object],
        *,
        attempt: int | None,
        run_number: int | None,
        fan_out_item: dict[str, object] | None,
    ) -> dict[str, object]:
        for candidate in reversed(attempts):
            if not isinstance(candidate, dict):
                continue
            if candidate.get("finishedAt") is not None:
                continue
            if attempt is not None and candidate.get("attempt") != attempt:
                continue
            if run_number is not None and candidate.get("runNumber") != run_number:
                continue
            if candidate.get("fanOutItem") != fan_out_item:
                continue
            return candidate
        for candidate in reversed(attempts):
            if isinstance(candidate, dict):
                return candidate
        attempts.append({})
        return cast(dict[str, object], attempts[-1])

    @staticmethod
    def _fan_out_attempt_status(
        attempts: list[object],
        *,
        fallback_status: str,
    ) -> tuple[str, bool | None]:
        fan_attempts = [
            attempt
            for attempt in attempts
            if isinstance(attempt, dict) and attempt.get("fanOutItem") is not None
        ]
        if not fan_attempts:
            return fallback_status, None
        if any(attempt.get("finishedAt") is None for attempt in fan_attempts):
            return "started", None
        if any(attempt.get("success") is False for attempt in fan_attempts):
            return "failed", False
        if all(attempt.get("success") is True for attempt in fan_attempts):
            return "completed", True
        return fallback_status, None

    def _write(self, level: str, message: str) -> None:
        self._append(f"{self._now()} - {level} - {message}\n")

    def _node_log_key(self, node_id: str) -> tuple[str, int | None, int | None]:
        run_number, attempt = self._active_node_runs.get(node_id, (None, None))
        return (node_id, run_number, attempt)

    def _write_node_event(self, node_id: str, label: str, value: str) -> None:
        body = "".join(f"{line}\n" for line in value.rstrip("\n").splitlines())
        if not body:
            return
        if label == "AGENT_THOUGHT":
            body = self._truncate_agent_thought(
                body,
                self._limits.max_log_message_bytes,
                f"{node_id} {label}",
            )
        body = self._fit_node_body(node_id, body, label)
        if not body:
            return
        self._write("NODE", f"{node_id} - {label}:")
        self._append_node_body(node_id, body)

    def _fit_node_body(self, node_id: str, body: str, label: str) -> str:
        key = self._node_log_key(node_id)
        remaining_node = self._limits.max_log_bytes_per_node - self._node_log_bytes.get(key, 0)
        remaining_run = self._limits.max_log_bytes_per_run - self._run_log_bytes
        limit = max(0, min(remaining_node, remaining_run))
        if limit <= 0:
            self._write_node_omission_line(node_id, label)
            return ""
        body = truncate_text_bytes(body, limit, f"{node_id} {label}")
        return self._ensure_body_newline(body, limit)

    def _truncate_agent_thought(self, body: str, max_bytes: int, label: str) -> str:
        if byte_len(body) <= max_bytes:
            return self._ensure_body_newline(body, max_bytes)
        if max_bytes <= 0:
            return ""
        suffix = f"\n[{label} truncated at {max_bytes} bytes]\n".encode()
        encoded = body.encode("utf-8", errors="replace")
        head_size = max(0, max_bytes - len(suffix))
        return (encoded[:head_size] + suffix)[:max_bytes].decode("utf-8", errors="replace")

    def _ensure_body_newline(self, body: str, max_bytes: int) -> str:
        if body.endswith("\n"):
            return body
        if max_bytes <= 0:
            return ""
        if byte_len(body) < max_bytes:
            return body + "\n"
        encoded = body.encode("utf-8", errors="replace")
        return (encoded[: max_bytes - 1] + b"\n").decode("utf-8", errors="replace")

    def _append_node_body(self, node_id: str, body: str) -> None:
        key = self._node_log_key(node_id)
        written = self._append(body)
        self._node_log_bytes[key] = self._node_log_bytes.get(key, 0) + written

    def _write_node_omission_line(self, node_id: str, label: str) -> None:
        key = (self._node_log_key(node_id), label)
        if key in self._node_log_omissions:
            return
        self._node_log_omissions.add(key)
        self.node(
            node_id,
            f"{label} omitted; log limit exceeded "
            f"(node limit {self._limits.max_log_bytes_per_node} bytes, "
            f"run limit {self._limits.max_log_bytes_per_run} bytes)",
        )

    def _append(self, text: str) -> int:
        remaining_run = self._limits.max_log_bytes_per_run - self._run_log_bytes
        if remaining_run <= 0:
            return 0
        text = truncate_text_bytes(text, remaining_run, "run log")
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(text)
        written = byte_len(text)
        self._run_log_bytes += written
        return written

    def _read_events_payload(self) -> dict[str, object]:
        if not self.events_path.exists():
            return {"events": [], "nodes": {}}
        try:
            payload = json.loads(self.events_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"events": [], "nodes": {}}
        return payload if isinstance(payload, dict) else {"events": [], "nodes": {}}

    def _write_events_payload(self, payload: dict[str, object]) -> None:
        payload = {
            "workflowId": self.workflow_id,
            "runId": self.path.name,
            "logPath": str(self.path),
            "startedAt": self.started_at.isoformat(),
            **payload,
        }
        text = json.dumps(payload, default=str)
        tmp_path = self.events_path.with_name(
            f".{self.events_path.name}.{os.getpid()}.{threading.get_ident()}.{time.monotonic_ns()}.tmp"
        )
        tmp_path.write_text(text, encoding="utf-8")
        os.replace(tmp_path, self.events_path)

    def _now(self) -> str:
        return datetime.now().astimezone().isoformat(timespec="seconds")


class WorkflowExecutor:
    def __init__(
        self,
        workflow: AgenticWorkflow,
        subscriptions: dict[str, Subscription],
        dry_run: bool = False,
        log_base_dir: Path | None = None,
        workflow_path: Path | None = None,
        max_total_node_runs: int | None = None,
        cancel_event: threading.Event | None = None,
        stop_file: Path | None = None,
        http_client: HttpClient | None = None,
        approval_store: ApprovalStore | None = None,
        notification_adapter: NotificationAdapter | None = None,
    ) -> None:
        self._workflow = workflow
        self._subscriptions = subscriptions
        self._dry_run = dry_run
        self._log_base_dir = log_base_dir
        self._workflow_path = workflow_path
        self._path_base = workflow_path.parent if workflow_path is not None else None
        self._max_total_node_runs = max_total_node_runs or workflow.config.max_total_node_runs
        self._pass_cancel_event = cancel_event is not None or stop_file is not None
        self._cancel_event = cancel_event or threading.Event()
        self._stop_file = stop_file
        self._run_stop_file: Path | None = None
        self._stop_monitor_done = threading.Event()
        self._trigger_context: dict[str, Any] = {}
        self._run_log: WorkflowRunLog | None = None
        self._agent_run_memory: dict[str, list[dict[str, str]]] = {}
        self._llm_usage_lock = anyio.Lock()
        self._llm_usage_totals = LlmUsageTotals()
        self._node_llm_usage_totals: dict[str, LlmUsageTotals] = {}
        self._limits = workflow.config.resource_limits
        self._http_client = http_client or UrllibHttpClient()
        data_dir = log_base_dir.parent if log_base_dir is not None else None
        self._approval_store = approval_store or ApprovalStore(data_dir)
        self._notification_adapter = notification_adapter or DesktopNotificationAdapter()

    def with_trigger_context(self, trigger_context: dict[str, Any]) -> WorkflowExecutor:
        self._trigger_context = trigger_context
        return self

    def _log(self) -> WorkflowRunLog:
        if self._run_log is None:
            raise RuntimeError("Workflow run log has not been initialized")
        return self._run_log

    def _log_agent_result(
        self,
        node_id: str,
        result: AgentResult,
        prefix: str = "",
    ) -> None:
        for thought in result.thoughts:
            value = f"{prefix}{thought}" if prefix else thought
            self._log().node_agent_event(
                node_id,
                "AGENT_THOUGHT",
                value,
            )
        message = result.message if result.message is not None else result.output
        if prefix:
            message = f"{prefix}{message}"
        self._log().node_agent_event(
            node_id,
            "AGENT_MESSAGE",
            message,
        )

    def _agent_prompt_for_budget(
        self,
        agent_config: AgentConfig,
        context: dict[str, object],
        prompt_override: str | None,
        memory: list[dict[str, str]] | None = None,
    ) -> str:
        prompt_text = (
            PromptManager._interpolate(prompt_override, context)
            if prompt_override is not None
            else PromptManager().load(agent_config.prompt_path, context)
            if agent_config.prompt_path is not None
            else ""
        )
        if piped := context.get("_piped_input"):
            prompt_text = f"{piped}\n\n{prompt_text}"
        if file_content := context.get("file_content"):
            prompt_text = f"{prompt_text}\n\n{file_content}"
        if row := context.get("_row"):
            prompt_text = f"{prompt_text}\n\n{row}"
        if memory:
            prompt_text = format_agent_memory(memory, prompt_text)
        return prompt_text

    async def _reserve_agent_call(
        self,
        node_id: str,
        op: AgentOperation | CommonLlmTaskOperation,
        prompt: str | None,
    ) -> tuple[list[str], LlmUsageReservation | None]:
        async with self._llm_usage_lock:
            pricing = (
                self._workflow.agents[op.agent_id].pricing
                if op.agent_id in self._workflow.agents
                else None
            )
            prompt_tokens = estimate_tokens(prompt, pricing)
            prompt_cost = (
                prompt_tokens * pricing.input_cost_per_1k_tokens / 1000
                if pricing is not None
                else 0.0
            )
            workflow_preview = LlmUsageTotals(
                agent_calls=self._llm_usage_totals.agent_calls + 1,
                input_tokens=self._llm_usage_totals.input_tokens + prompt_tokens,
                output_tokens=self._llm_usage_totals.output_tokens,
                total_tokens=self._llm_usage_totals.total_tokens + prompt_tokens,
                estimated_cost=self._llm_usage_totals.estimated_cost + prompt_cost,
                agent_time_seconds=self._llm_usage_totals.agent_time_seconds,
            )
            node_totals = self._node_llm_usage_totals.setdefault(
                node_id,
                LlmUsageTotals(),
            )
            node_preview = LlmUsageTotals(
                agent_calls=node_totals.agent_calls + 1,
                input_tokens=node_totals.input_tokens + prompt_tokens,
                output_tokens=node_totals.output_tokens,
                total_tokens=node_totals.total_tokens + prompt_tokens,
                estimated_cost=node_totals.estimated_cost + prompt_cost,
                agent_time_seconds=node_totals.agent_time_seconds,
            )
            violations = [
                *budget_violations(
                    workflow_preview,
                    self._workflow.config.llm_budget,
                    scope="workflow LLM budget",
                ),
                *budget_violations(
                    node_preview,
                    op.llm_budget,
                    scope=f"node '{node_id}' LLM budget",
                ),
            ]
            violations.extend(
                self._agent_time_exhausted_violations_locked(
                    node_id,
                    op,
                    node_totals,
                )
            )
            if violations:
                return violations, None
            self._llm_usage_totals.agent_calls += 1
            self._llm_usage_totals.input_tokens += prompt_tokens
            self._llm_usage_totals.total_tokens += prompt_tokens
            self._llm_usage_totals.estimated_cost += prompt_cost
            node_totals.agent_calls += 1
            node_totals.input_tokens += prompt_tokens
            node_totals.total_tokens += prompt_tokens
            node_totals.estimated_cost += prompt_cost
            reservation = LlmUsageReservation(
                LlmUsageEstimate(
                    provider=(
                        self._workflow.agents[op.agent_id].subscription
                        if op.agent_id in self._workflow.agents
                        else op.agent_id
                    ),
                    profile=(
                        self._workflow.agents[op.agent_id].profile
                        if op.agent_id in self._workflow.agents
                        else None
                    ),
                    model=(
                        self._workflow.agents[op.agent_id].model
                        if op.agent_id in self._workflow.agents
                        else None
                    ),
                    prompt_length=len(prompt or ""),
                    output_length=0,
                    input_tokens=prompt_tokens,
                    output_tokens=0,
                    total_tokens=prompt_tokens,
                    estimated_cost=prompt_cost,
                    duration_seconds=0.0,
                    estimated=True,
                    source="budget_reservation",
                )
            )
            return [], reservation

    def _agent_time_exhausted_violations_locked(
        self,
        node_id: str,
        op: AgentOperation | CommonLlmTaskOperation,
        node_totals: LlmUsageTotals,
    ) -> list[str]:
        violations = []
        workflow_budget = self._workflow.config.llm_budget.max_agent_time_seconds
        if (
            workflow_budget is not None
            and self._llm_usage_totals.agent_time_seconds >= workflow_budget
        ):
            violations.append(
                "workflow LLM budget max_agent_time_seconds exhausted "
                f"({self._llm_usage_totals.agent_time_seconds:.2f} >= "
                f"{workflow_budget:.2f})"
            )
        node_budget = op.llm_budget.max_agent_time_seconds
        if node_budget is not None and node_totals.agent_time_seconds >= node_budget:
            violations.append(
                f"node '{node_id}' LLM budget max_agent_time_seconds exhausted "
                f"({node_totals.agent_time_seconds:.2f} >= {node_budget:.2f})"
            )
        return violations

    async def _remaining_agent_time_timeout(
        self,
        node_id: str,
        op: AgentOperation | CommonLlmTaskOperation,
    ) -> float | None:
        async with self._llm_usage_lock:
            timeouts = []
            workflow_budget = self._workflow.config.llm_budget.max_agent_time_seconds
            if workflow_budget is not None:
                timeouts.append(
                    max(0.0, workflow_budget - self._llm_usage_totals.agent_time_seconds)
                )
            node_budget = op.llm_budget.max_agent_time_seconds
            if node_budget is not None:
                node_totals = self._node_llm_usage_totals.setdefault(
                    node_id,
                    LlmUsageTotals(),
                )
                timeouts.append(max(0.0, node_budget - node_totals.agent_time_seconds))
            return min(timeouts) if timeouts else None

    async def _record_agent_usage(
        self,
        node_id: str,
        op: AgentOperation | CommonLlmTaskOperation,
        usage: LlmUsageEstimate,
        reservation: LlmUsageReservation | None = None,
    ) -> list[str]:
        async with self._llm_usage_lock:
            node_totals = self._node_llm_usage_totals.setdefault(
                node_id,
                LlmUsageTotals(),
            )
            if reservation is not None:
                self._llm_usage_totals.subtract(reservation.usage)
                node_totals.subtract(reservation.usage)
            self._llm_usage_totals.add(usage)
            node_totals.add(usage)
            return [
                *budget_violations(
                    self._llm_usage_totals,
                    self._workflow.config.llm_budget,
                    scope="workflow LLM budget",
                ),
                *budget_violations(
                    node_totals,
                    op.llm_budget,
                    scope=f"node '{node_id}' LLM budget",
                ),
            ]

    def _agent_memory(self, node_id: str, mode: str) -> list[dict[str, str]]:
        if mode == "run":
            return list(self._agent_run_memory.get(node_id, []))
        if mode == "all":
            return self._load_agent_memory(node_id)
        return []

    def _remember_agent_result(self, node_id: str, mode: str, result: AgentResult) -> None:
        if mode not in {"run", "all"}:
            return
        message = result.message if result.message is not None else result.output
        if not result.prompt and not message:
            return
        turns = self._agent_memory(node_id, mode)
        if result.prompt:
            turns.append({"role": "user", "body": result.prompt})
        if message:
            turns.append({"role": "assistant", "body": message})
        turns = turns[-40:]
        if mode == "run":
            self._agent_run_memory[node_id] = turns
        else:
            self._save_agent_memory(node_id, turns)

    def _agent_memory_path(self, node_id: str) -> Path:
        base = self._log_base_dir.parent if self._log_base_dir is not None else get_data_dir()
        workflow_id = _safe_path_part(self._workflow.config.id)
        safe_node_id = _safe_path_part(node_id)
        return base / "agent-memory" / workflow_id / f"{safe_node_id}.json"

    def _load_agent_memory(self, node_id: str) -> list[dict[str, str]]:
        path = self._agent_memory_path(node_id)
        if not path.exists():
            return []
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        if not isinstance(loaded, list):
            return []
        turns = []
        for item in loaded:
            if not isinstance(item, dict):
                continue
            role = str(item.get("role", "")).strip()
            body = str(item.get("body", "")).strip()
            if role and body:
                turns.append({"role": role, "body": body})
        return turns

    def _save_agent_memory(self, node_id: str, turns: list[dict[str, str]]) -> None:
        path = self._agent_memory_path(node_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(turns, indent=2), encoding="utf-8")

    async def _compact_agent_memory_if_needed(
        self,
        node_id: str,
        op: AgentOperation | CommonLlmTaskOperation,
        mode: str,
        turns: list[dict[str, str]],
        agent_config: AgentConfig,
        subscription: Subscription,
    ) -> list[dict[str, str]]:
        if mode not in {"run", "all"}:
            return turns
        if _turns_size(turns) <= AGENT_MEMORY_COMPACT_CHAR_LIMIT:
            return turns

        self._log().info(f"Compacting agent context for agent node {node_id}")
        recent = turns[-AGENT_MEMORY_RECENT_TURNS:]
        older = turns[:-AGENT_MEMORY_RECENT_TURNS]
        compaction_prompt = _agent_memory_compaction_prompt(older)
        (
            budget_violations_before_call,
            usage_reservation,
        ) = await self._reserve_agent_call(
            node_id,
            op,
            compaction_prompt,
        )
        if budget_violations_before_call:
            raise LlmBudgetBlockedError(budget_violations_before_call)

        started_at = time.monotonic()
        output_for_usage = ""
        metadata: dict[str, object] = {}
        try:
            timeout = await self._remaining_agent_time_timeout(node_id, op)
            effective_timeout = min(180.0, timeout) if timeout is not None else 180.0
            result = await subscription.execute(
                prompt=compaction_prompt,
                working_dir=agent_config.working_dir,
                tools=agent_config.tools,
                mcp_servers=agent_config.mcp_servers,
                env=agent_config.env,
                timeout=effective_timeout,
                cancel_event=self._cancel_event if self._pass_cancel_event else None,
                extra_paths=configured_extra_paths(agent_config),
                max_output_bytes=self._limits.max_subprocess_output_bytes,
            )
            output_for_usage = result.output
            metadata = result.usage_metadata
            summary = (
                (result.message or result.output).strip()
                if result.success
                else _fallback_turn_summary(older)
            )
            if not summary:
                summary = _fallback_turn_summary(older)
        except Exception:  # noqa: BLE001
            summary = _fallback_turn_summary(older)

        usage = usage_from_metadata(
            provider=agent_config.subscription,
            profile=agent_config.profile,
            model=agent_config.model,
            prompt=compaction_prompt,
            output=output_for_usage,
            duration_seconds=time.monotonic() - started_at,
            pricing=agent_config.pricing,
            metadata=metadata,
        )
        budget_violations_after_call = await self._record_agent_usage(
            node_id,
            op,
            usage,
            usage_reservation,
        )
        if budget_violations_after_call:
            self._log().node(
                node_id,
                "LLM budget exceeded during memory compaction: "
                + "; ".join(budget_violations_after_call),
            )
            raise LlmBudgetBlockedError(budget_violations_after_call)

        compacted_turns = [
            {
                "role": "system",
                "body": f"Compacted prior agent node context:\n{summary}",
            },
            *recent,
        ]
        if mode == "run":
            self._agent_run_memory[node_id] = compacted_turns
        else:
            self._save_agent_memory(node_id, compacted_turns)
        return compacted_turns

    def _agent_config_for_operation(
        self,
        agent_config: AgentConfig,
        prompt_path: Path | None,
        working_dir: Path | None,
    ) -> AgentConfig:
        updates: dict[str, Path | list[Path]] = {}
        if self._path_base is not None and agent_config.extra_paths:
            updates["extra_paths"] = [
                _resolve_workflow_path(path, self._path_base) for path in agent_config.extra_paths
            ]
        if prompt_path is not None:
            updates["prompt_path"] = _resolve_workflow_path(prompt_path, self._path_base)
        if working_dir is not None:
            updates["working_dir"] = _resolve_workflow_path(working_dir, self._path_base)
        return agent_config.model_copy(update=updates) if updates else agent_config

    def _trigger_secret_values(self, ctx: ExecutionContext, graph: WorkflowGraph) -> set[str]:
        secret_values: set[str] = set()
        for node in graph.nodes_in_order():
            op = node.operation
            if op.type != OperationType.HTTP_REQUEST:
                continue
            assert isinstance(op, HttpRequestOperation)
            configured_secret_fields = {field.lower() for field in op.secret_fields}
            try:
                template_context = self._template_context(node, ctx, graph)
                rendered_url = str(self._render_http_value(op.url, template_context))
                rendered_headers = cast(
                    dict[str, object],
                    self._render_http_value(op.headers, template_context),
                )
                rendered_params = cast(
                    dict[str, object],
                    self._render_http_value(op.params, template_context),
                )
                rendered_json = self._render_http_value(op.json_payload, template_context)
                rendered_body = self._render_http_value(op.body, template_context)
            except Exception:  # noqa: BLE001
                continue

            if _is_sensitive_field("url", configured_secret_fields):
                secret_values.update(_collect_leaf_strings(rendered_url))
            secret_values.update(
                _collect_sensitive_template_values(
                    op.url,
                    configured_secret_fields,
                    template_context,
                    "url",
                )
            )
            secret_values.update(
                _collect_sensitive_template_values(
                    op.headers,
                    configured_secret_fields,
                    template_context,
                )
            )
            secret_values.update(
                _collect_sensitive_template_values(
                    op.params,
                    configured_secret_fields,
                    template_context,
                )
            )
            secret_values.update(
                _collect_sensitive_template_values(
                    op.json_payload,
                    configured_secret_fields,
                    template_context,
                )
            )
            secret_values.update(
                _collect_sensitive_template_values(
                    op.body,
                    configured_secret_fields,
                    template_context,
                    "body",
                )
            )
            secret_values.update(
                _collect_configured_secret_values(
                    rendered_headers,
                    configured_secret_fields,
                )
            )
            secret_values.update(
                _collect_configured_secret_values(
                    rendered_params,
                    configured_secret_fields,
                )
            )
            secret_values.update(
                _collect_configured_secret_values(
                    rendered_json,
                    configured_secret_fields,
                )
            )
            if isinstance(rendered_body, str):
                secret_values.update(
                    _collect_configured_secret_text_values(
                        rendered_body,
                        configured_secret_fields,
                    )
                )
            else:
                secret_values.update(
                    _collect_configured_secret_values(
                        rendered_body,
                        configured_secret_fields,
                    )
                )
        return {value for value in secret_values if value}

    def _approval_checkpoint_path(self, run_id: str, node_id: str) -> Path:
        return self._approval_store.request_path(
            self._workflow.config.id,
            run_id,
            node_id,
        ).with_suffix(".checkpoint.json")

    def _write_approval_checkpoint(
        self,
        path: Path,
        *,
        node_id: str,
        ctx: ExecutionContext,
        trigger_context: dict[str, object],
    ) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "workflowId": self._workflow.config.id,
                    "nodeId": node_id,
                    "trigger": trigger_context,
                    "nodeOutputs": {
                        output_id: output.contract()
                        for output_id, output in ctx.node_outputs.items()
                    },
                },
                default=str,
            ),
            encoding="utf-8",
        )

    def _refresh_pending_approval_checkpoints(self, ctx: ExecutionContext) -> None:
        if self._run_log is None:
            return
        run_id = self._run_log.path.name
        for request in self._approval_store.list_pending(self._workflow.config.id):
            if request.run_id != run_id or not request.checkpoint_path:
                continue
            self._write_approval_checkpoint(
                Path(request.checkpoint_path),
                node_id=request.node_id,
                ctx=ctx,
                trigger_context=self._trigger_context,
            )

    def _event_preview(self, value: object, limit: int = 4000) -> object:
        if isinstance(value, str):
            return truncate_text_bytes(value, limit, "run event")
        if isinstance(value, dict):
            return {str(key): self._event_preview(item, limit) for key, item in value.items()}
        if isinstance(value, list):
            return [self._event_preview(item, limit) for item in value[:20]]
        return value

    def _node_event_data(
        self,
        output: NodeOutput,
        *,
        edge_decisions: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        output_data = self._event_preview(output.data)
        data: dict[str, object] = {
            "output": self._event_preview(output.output),
            "data": output_data,
            "items": self._event_preview(output.items),
            "error": self._event_preview(output.error or ""),
        }
        if isinstance(output_data, dict):
            for key, value in output_data.items():
                data.setdefault(str(key), value)
        if edge_decisions is not None:
            data["edgeDecisions"] = edge_decisions
        if output.loop_items is not None:
            item_summaries = [
                {
                    "index": index,
                    "item": self._event_preview(item),
                    "status": "queued",
                    "success": None,
                    "nodeId": "",
                    "durationSeconds": 0,
                    "exitCode": None,
                    "output": "",
                    "error": "",
                }
                for index, item in enumerate(output.loop_items)
            ]
            data["fanOut"] = {
                "itemCount": len(output.loop_items),
                "successCount": 0,
                "failureCount": 0,
                "runningCount": 0,
                "items": item_summaries,
                "maxConcurrency": output.loop_max_concurrency,
                "failFast": output.loop_fail_fast,
            }
        return data

    def _skipped_node_event_data(
        self,
        node_id: str,
        graph: WorkflowGraph,
        ctx: ExecutionContext,
    ) -> tuple[str, dict[str, object]]:
        incoming_decisions: list[dict[str, object]] = []
        for upstream_id in graph._graph.predecessors(node_id):
            edge = graph.get_edge_config(upstream_id, node_id)
            output = ctx.node_outputs.get(upstream_id)
            if output is None:
                incoming_decisions.append(
                    {
                        "from": upstream_id,
                        "to": node_id,
                        "condition": str(edge.condition),
                        "outputPattern": edge.output_pattern or "",
                        "matched": False,
                        "reason": f"{upstream_id} did not run",
                    }
                )
                continue
            matched = (
                False
                if edge.condition == EdgeConditionType.AFTER_LOOP
                else edge.evaluate(output)
            )
            incoming_decisions.append(
                {
                    "from": upstream_id,
                    "to": node_id,
                    "condition": str(edge.condition),
                    "outputPattern": edge.output_pattern or "",
                    "matched": matched,
                    "reason": (
                        f"{upstream_id} -> {node_id} matched ({edge.condition})"
                        if matched
                        else f"{upstream_id} -> {node_id} skipped ({edge.condition})"
                    ),
                }
            )

        skipped_edges = [
            decision for decision in incoming_decisions if not bool(decision.get("matched"))
        ]
        if skipped_edges:
            message = str(skipped_edges[0]["reason"])
        elif incoming_decisions:
            message = "node was not reached after incoming conditions matched"
        else:
            message = "node was not reached"
        return message, {
            "skipReason": message,
            "incomingEdgeDecisions": incoming_decisions,
        }

    def _record_unrun_node_events(
        self,
        graph: WorkflowGraph,
        ctx: ExecutionContext,
        run_log: WorkflowRunLog,
        *,
        stopped: bool,
    ) -> None:
        for node_id in graph._nodes:
            if node_id in ctx.node_runs:
                continue
            message, data = self._skipped_node_event_data(node_id, graph, ctx)
            if stopped and not self._has_completed_false_incoming_edge(data):
                message = "stopped by user before node started"
                run_log.node(node_id, "stopped")
                run_log.event(
                    node_id,
                    "stopped",
                    message=message,
                    success=False,
                    data={
                        "stopReason": message,
                        "incomingEdgeDecisions": data.get("incomingEdgeDecisions", []),
                    },
                )
                continue
            run_log.node(node_id, "skipped")
            run_log.event(
                node_id,
                "skipped",
                message=message,
                skipped=True,
                data=data,
            )

    @staticmethod
    def _has_completed_false_incoming_edge(data: dict[str, object]) -> bool:
        decisions = data.get("incomingEdgeDecisions")
        if not isinstance(decisions, list):
            return False
        for decision in decisions:
            if not isinstance(decision, dict):
                continue
            if bool(decision.get("matched")):
                continue
            reason = decision.get("reason")
            if isinstance(reason, str) and reason.endswith(" did not run"):
                continue
            return True
        return False

    def _record_loop_item_output(
        self,
        task: QueuedNode,
        output: NodeOutput,
        loop_item_outputs: dict[str, dict[int, list[NodeOutput]]],
        completed_loop_items: set[tuple[str, int]],
        *,
        terminal: bool,
    ) -> None:
        if task.loop_origin is None or task.loop_index is None or task.loop_items is None:
            return
        origin_outputs = loop_item_outputs.setdefault(task.loop_origin, {})
        item_outputs = origin_outputs.setdefault(task.loop_index, [])
        item_outputs.append(output)
        if terminal:
            completed_loop_items.add((task.loop_origin, task.loop_index))
        self._refresh_loop_fan_out_summary(
            task.loop_origin,
            task.loop_items,
            origin_outputs,
            completed_loop_items,
        )

    def _refresh_loop_fan_out_summary(
        self,
        loop_origin: str,
        loop_items: list[dict[str, object]],
        item_outputs: dict[int, list[NodeOutput]],
        completed_loop_items: set[tuple[str, int]],
    ) -> None:
        run_log = self._run_log
        if run_log is None:
            return
        item_summaries: list[dict[str, object]] = []
        success_count = 0
        failure_count = 0
        for index, item in enumerate(loop_items):
            outputs = item_outputs.get(index, [])
            is_complete = (loop_origin, index) in completed_loop_items
            item_success = bool(outputs) and all(output.success for output in outputs)
            if is_complete and item_success:
                success_count += 1
            elif is_complete:
                failure_count += 1
            last_output = outputs[-1] if outputs else None
            first_error = next(
                (output.error or output.output for output in outputs if not output.success),
                "",
            )
            item_summaries.append(
                {
                    "index": index,
                    "item": self._event_preview(item),
                    "status": (
                        "completed"
                        if is_complete and item_success
                        else "failed"
                        if is_complete
                        else "running"
                        if outputs
                        else "queued"
                    ),
                    "success": item_success if is_complete else None,
                    "nodeId": last_output.node_id if last_output else "",
                    "durationSeconds": sum(output.duration_seconds for output in outputs),
                    "exitCode": last_output.exit_code if last_output else None,
                    "output": self._event_preview(last_output.output if last_output else ""),
                    "error": self._event_preview(first_error),
                }
            )
        run_log.update_node_data(
            loop_origin,
            {
                "fanOut": {
                    "itemCount": len(loop_items),
                    "successCount": success_count,
                    "failureCount": failure_count,
                    "runningCount": sum(
                        1
                        for index in item_outputs
                        if (loop_origin, index) not in completed_loop_items
                    ),
                    "items": item_summaries,
                }
            },
        )

    @staticmethod
    def _node_output_from_contract(node_id: str, data: object) -> NodeOutput:
        if not isinstance(data, dict):
            return NodeOutput(
                node_id=node_id,
                success=True,
                output="",
                exit_code=0,
                duration_seconds=0,
            )
        output_data = data.get("data")
        output_items = data.get("items")
        loop_items = data.get("loop_items")
        return NodeOutput(
            node_id=str(data.get("node_id") or node_id),
            success=bool(data.get("success", True)),
            output=str(data.get("output") or data.get("text") or ""),
            exit_code=int(data.get("exit_code") or 0),
            duration_seconds=float(data.get("duration_seconds") or 0),
            skipped=bool(data.get("skipped", False)),
            terminal_status=(
                str(data.get("terminal_status")) if data.get("terminal_status") else None
            ),
            loop_items=loop_items if isinstance(loop_items, list) else None,
            loop_infinite=bool(data.get("loop_infinite", False)),
            loop_max_concurrency=int(data.get("loop_max_concurrency") or 16),
            loop_fail_fast=bool(data.get("loop_fail_fast", False)),
            type=str(data.get("type") or ""),
            text=str(data.get("text") or data.get("output") or ""),
            value=data.get("value"),
            data=output_data if isinstance(output_data, dict) else {},
            items=output_items if isinstance(output_items, list) else [],
            error=str(data.get("error")) if data.get("error") is not None else None,
        )

    async def run(self) -> ExecutionResult:
        if self._stop_file is not None:
            self._stop_file.unlink(missing_ok=True)
        else:
            data_dir = self._log_base_dir.parent if self._log_base_dir is not None else None
            clear_workflow_stop(self._workflow.config.id, data_dir)
        monitor = self._start_stop_monitor()
        self._run_log = WorkflowRunLog(
            self._workflow.config.id,
            self._log_base_dir,
            self._limits,
        )
        run_log = self._log()
        if self._stop_file is not None:
            data_dir = self._stop_file.parent.parent
            self._run_stop_file = workflow_run_stop_path(
                self._workflow.config.id,
                run_log.path.name,
                data_dir,
            )
            self._run_stop_file.unlink(missing_ok=True)
        ctx = ExecutionContext(trigger=self._trigger_context)
        graph = self._workflow.graph
        start = time.monotonic()
        halted = False
        halt_reason: str | None = None
        terminal_success: bool | None = None
        total_node_runs = 0
        run_counts: dict[str, int] = {}
        completed_loops: set[str] = set()
        queued_after_loop_edges: set[tuple[str, str]] = set()
        started_after_loop_edges: set[tuple[str, str]] = set()
        loop_next_index: dict[str, int] = {}
        loop_item_outputs: dict[str, dict[int, list[NodeOutput]]] = {}
        completed_loop_items: set[tuple[str, int]] = set()
        try:
            run_log.info(f"dry_run={self._dry_run}")
            run_log.info(f"max_total_node_runs={self._max_total_node_runs}")
            if ctx.trigger:
                trigger_text = json.dumps(ctx.trigger, default=str)
                trigger_text = _replace_known_secrets(
                    trigger_text,
                    self._trigger_secret_values(ctx, graph),
                )
                run_log.info(f"trigger={trigger_text}")

            queue: deque[QueuedNode] = deque(
                QueuedNode(node_id) for node_id in self._initial_node_ids(graph)
            )
            for task in queue:
                run_log.event(task.node_id, "queued", message="start node queued")
            queued_tasks = {task.key for task in queue}
            running_tasks: set[tuple[str, str | None, int | None]] = set()
            run_log.info(f"start_nodes={[task.node_id for task in queue]}")

            send, receive = anyio.create_memory_object_stream[tuple[QueuedNode, NodeOutput, bool]](
                1000
            )

            async def run_queued_node(
                task: QueuedNode,
                node: GraphNode,
                run_number: int,
            ) -> None:
                results: dict[str, NodeOutput] = {}
                halt_flag: list[bool] = [False]
                await self._run_node(
                    node,
                    ctx,
                    results,
                    halt_flag,
                    graph,
                    run_number,
                    loop_item=task.loop_item,
                )
                await send.send((task, results[task.node_id], halt_flag[0]))

            async with anyio.create_task_group() as tg:
                async with receive:
                    while (queue or running_tasks) and not halted:
                        while queue and not halted:
                            if self._stop_requested():
                                halted = True
                                halt_reason = "stopped by user"
                                run_log.error(halt_reason)
                                run_log.event(
                                    "workflow",
                                    "stopped",
                                    message=halt_reason,
                                    success=False,
                                )
                                tg.cancel_scope.cancel()
                                break

                            task = queue.popleft()
                            queued_tasks.discard(task.key)
                            if task.loop_origin is not None:
                                active_loop_tasks = sum(
                                    1 for key in running_tasks if key[1] == task.loop_origin
                                )
                                if active_loop_tasks >= task.loop_max_concurrency:
                                    queue.append(task)
                                    queued_tasks.add(task.key)
                                    break
                            if task.after_loop_origin is not None:
                                edge_key = (task.after_loop_origin, task.node_id)
                                if edge_key in started_after_loop_edges:
                                    continue
                                started_after_loop_edges.add(edge_key)
                            node_id = task.node_id
                            node = graph._nodes[node_id]
                            total_node_runs += 1
                            if total_node_runs > self._max_total_node_runs:
                                halted = True
                                halt_reason = (
                                    "maximum node run limit exceeded "
                                    f"({self._max_total_node_runs}); check recursive edges"
                                )
                                run_log.error(halt_reason)
                                tg.cancel_scope.cancel()
                                break

                            run_counts[node_id] = run_counts.get(node_id, 0) + 1
                            run_number = run_counts[node_id]
                            running_tasks.add(task.key)
                            run_log.event(
                                node_id,
                                "queued",
                                run_number=run_number,
                                fan_out_item=task.loop_item,
                                message="node ready to start",
                            )
                            tg.start_soon(run_queued_node, task, node, run_number)

                        if halted or not running_tasks:
                            break

                        task, output, node_halted = await receive.receive()
                        node_id = task.node_id
                        running_tasks.discard(task.key)
                        ctx.record(output)
                        self._refresh_pending_approval_checkpoints(ctx)
                        if output.terminal_status is not None:
                            self._record_loop_item_output(
                                task,
                                output,
                                loop_item_outputs,
                                completed_loop_items,
                                terminal=True,
                            )
                            if output.terminal_status == "break":
                                run_log.info(
                                    output.output.strip()
                                    or f"loop {task.loop_origin or node_id} break triggered"
                                )
                                if task.loop_origin is not None:
                                    queue = deque(
                                        queued
                                        for queued in queue
                                        if queued.loop_origin != task.loop_origin
                                    )
                                    queued_tasks = {queued.key for queued in queue}
                                    self._queue_loop_done_successors(
                                        task.loop_origin,
                                        graph,
                                        queue,
                                        queued_tasks,
                                        running_tasks,
                                        completed_loops,
                                        queued_after_loop_edges,
                                    )
                                continue
                            halted = True
                            terminal_success = output.terminal_status == "pass"
                            halt_reason = output.output.strip() or None
                            tg.cancel_scope.cancel()
                            break
                        if node_halted:
                            if task.loop_origin is None or task.loop_fail_fast:
                                self._record_loop_item_output(
                                    task,
                                    output,
                                    loop_item_outputs,
                                    completed_loop_items,
                                    terminal=True,
                                )
                                halted = True
                                if self._stop_requested():
                                    halt_reason = "stopped by user"
                                tg.cancel_scope.cancel()
                                break

                        scheduled_successors = self._queue_successor_tasks(
                            output,
                            task,
                            graph,
                            ctx,
                            queue,
                            queued_tasks,
                            running_tasks,
                        )
                        self._record_loop_item_output(
                            task,
                            output,
                            loop_item_outputs,
                            completed_loop_items,
                            terminal=not scheduled_successors,
                        )
                        if output.loop_items is not None:
                            loop_next_index.setdefault(
                                output.node_id,
                                min(output.loop_max_concurrency, len(output.loop_items)),
                            )

                        if output.loop_items is not None and not scheduled_successors:
                            self._queue_loop_done_successors(
                                node_id,
                                graph,
                                queue,
                                queued_tasks,
                                running_tasks,
                                completed_loops,
                                queued_after_loop_edges,
                            )

                        if (
                            task.loop_origin
                            and (task.loop_infinite or task.loop_items is not None)
                            and not scheduled_successors
                            and not self._stop_requested()
                        ):
                            iteration_key = (task.loop_origin, task.loop_index)
                            has_iteration_work = any(
                                key[1:] == iteration_key for key in queued_tasks | running_tasks
                            )
                            if not has_iteration_work:
                                next_index = loop_next_index.get(
                                    task.loop_origin,
                                    (task.loop_index or 0) + 1,
                                )
                                if task.loop_items is not None and next_index >= len(
                                    task.loop_items
                                ):
                                    has_loop_work = any(
                                        key[1] == task.loop_origin
                                        for key in queued_tasks | running_tasks
                                    )
                                    if not has_loop_work:
                                        self._queue_loop_done_successors(
                                            task.loop_origin,
                                            graph,
                                            queue,
                                            queued_tasks,
                                            running_tasks,
                                            completed_loops,
                                            queued_after_loop_edges,
                                        )
                                    continue
                                if task.loop_infinite:
                                    next_item: dict[str, object] = {"index": str(next_index)}
                                else:
                                    if task.loop_items is None:
                                        continue
                                    next_item = task.loop_items[next_index]
                                loop_next_index[task.loop_origin] = next_index + 1
                                for successor_id in graph._graph.successors(task.loop_origin):
                                    edge = graph.get_edge_config(task.loop_origin, successor_id)
                                    if edge.condition == EdgeConditionType.AFTER_LOOP:
                                        continue
                                    next_task = QueuedNode(
                                        successor_id,
                                        loop_origin=task.loop_origin,
                                        loop_item=next_item,
                                        loop_index=next_index,
                                        loop_items=task.loop_items,
                                        loop_infinite=task.loop_infinite,
                                        loop_max_concurrency=task.loop_max_concurrency,
                                        loop_fail_fast=task.loop_fail_fast,
                                    )
                                    if (
                                        next_task.key in queued_tasks
                                        or next_task.key in running_tasks
                                    ):
                                        continue
                                    queue.append(next_task)
                                    queued_tasks.add(next_task.key)

            self._record_unrun_node_events(
                graph,
                ctx,
                run_log,
                stopped=halt_reason == "stopped by user" or self._stop_requested(),
            )

            total = time.monotonic() - start
            success = (
                terminal_success
                if terminal_success is not None
                else not halted
                and all(
                    o.success
                    or graph._nodes[o.node_id].allow_failure
                    or (
                        o.type == str(OperationType.APPROVAL_GATE)
                        and self._has_failure_route(graph._nodes[o.node_id], o, graph)
                    )
                    for runs in ctx.node_runs.values()
                    for o in runs
                    if not o.skipped
                )
            )
            reason = None if success else halt_reason or self._failure_reason(ctx.node_outputs)
            terminal_status: Literal["completed", "failed", "stopped"] | None = (
                "stopped" if reason == "stopped by user" else None
            )
            run_log.complete(success, reason, terminal_status=terminal_status)
            return ExecutionResult(
                workflow_id=self._workflow.config.id,
                success=success,
                node_outputs=ctx.node_outputs,
                node_runs=ctx.node_runs,
                duration_seconds=total,
                log_path=run_log.path,
                usage_summary=summarize_node_outputs(ctx.node_outputs, ctx.node_runs),
            )
        except BaseException as exc:
            run_log.complete(False, str(exc))
            raise
        finally:
            self._stop_monitor_done.set()
            if monitor is not None:
                monitor.join(timeout=1)
            if self._stop_file is not None:
                if self._run_stop_file is not None:
                    self._run_stop_file.unlink(missing_ok=True)

    async def resume_from_approval(self, request: ApprovalRequest) -> ExecutionResult | None:
        claimed = self._approval_store.claim_resume(
            request.workflow_id,
            request.run_id,
            request.node_id,
        )
        if claimed is None or claimed.decision is None:
            return None
        try:
            result = await self._resume_from_claimed_approval(claimed)
        except BaseException:
            self._approval_store.release_resume(
                claimed.workflow_id,
                claimed.run_id,
                claimed.node_id,
            )
            raise
        if result is None:
            self._approval_store.release_resume(
                claimed.workflow_id,
                claimed.run_id,
                claimed.node_id,
            )
        return result

    async def _resume_from_claimed_approval(
        self,
        claimed: ApprovalRequest,
    ) -> ExecutionResult | None:
        if claimed.decision is None or not claimed.checkpoint_path:
            return None
        checkpoint_path = Path(claimed.checkpoint_path)
        try:
            checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(checkpoint, dict):
            return None

        log_path = Path(claimed.log_path) if claimed.log_path else None
        self._run_log = WorkflowRunLog(
            self._workflow.config.id,
            self._log_base_dir,
            self._limits,
            existing_path=log_path,
        )
        run_log = self._log()
        checkpoint_trigger = checkpoint.get("trigger")
        ctx = ExecutionContext(
            trigger=checkpoint_trigger if isinstance(checkpoint_trigger, dict) else {}
        )
        saved_outputs = checkpoint.get("nodeOutputs")
        if isinstance(saved_outputs, dict):
            for output_id, output_data in saved_outputs.items():
                ctx.record(self._node_output_from_contract(str(output_id), output_data))

        start = time.monotonic()
        decision = claimed.decision
        approved = decision.decision == "approved"
        output_text = (
            f"approval {decision.decision} by {decision.decided_by}"
            f"{': ' + decision.notes if decision.notes else ''}"
        )
        approve_command = self._approval_command(
            "approve",
            claimed.run_id,
            claimed.node_id,
            claimed.approvers,
        )
        reject_command = self._approval_command(
            "reject",
            claimed.run_id,
            claimed.node_id,
            claimed.approvers,
        )
        approval_output = NodeOutput(
            node_id=claimed.node_id,
            success=approved,
            output=output_text,
            exit_code=0 if approved else 1,
            duration_seconds=0,
            type=str(OperationType.APPROVAL_GATE),
            value=decision.decision,
            data={
                "status": "decided",
                "decision": decision.decision,
                "approved": approved,
                "decidedBy": decision.decided_by,
                "notes": decision.notes,
                "message": claimed.message,
                "runId": claimed.run_id,
                "approvers": list(claimed.approvers),
                "timeoutSeconds": claimed.timeout_seconds,
                "followUpCommand": approve_command,
                "approveCommand": approve_command,
                "rejectCommand": reject_command,
            },
            error=output_text if not approved else None,
        )
        ctx.record(approval_output)
        run_log.node(
            claimed.node_id,
            f"approval decision: decision={decision.decision} by={decision.decided_by}",
        )
        if decision.notes:
            run_log.node_output(claimed.node_id, "approval notes", decision.notes)

        graph = self._workflow.graph
        queue: deque[QueuedNode] = deque()
        queued: set[tuple[str, str | None, int | None]] = set()
        running: set[tuple[str, str | None, int | None]] = set()
        completed_loops: set[str] = set()
        queued_after_loop_edges: set[tuple[str, str]] = set()
        started_after_loop_edges: set[tuple[str, str]] = set()
        loop_next_index: dict[str, int] = {}
        loop_item_outputs: dict[str, dict[int, list[NodeOutput]]] = {}
        completed_loop_items: set[tuple[str, int]] = set()
        self._queue_resume_frontier(graph, ctx, queue, queued, running)
        if approval_output.loop_items is not None:
            loop_next_index.setdefault(
                approval_output.node_id,
                min(approval_output.loop_max_concurrency, len(approval_output.loop_items)),
            )

        halted = False
        terminal_success: bool | None = None
        halt_reason: str | None = None
        run_counts: dict[str, int] = {}
        while queue and not halted:
            task = queue.popleft()
            queued.discard(task.key)
            if (
                task.node_id in ctx.node_outputs
                and task.loop_origin is None
                and task.after_loop_origin is None
            ):
                continue
            if task.after_loop_origin is not None:
                edge_key = (task.after_loop_origin, task.node_id)
                if edge_key in started_after_loop_edges:
                    continue
                started_after_loop_edges.add(edge_key)
            node = graph._nodes[task.node_id]
            run_counts[task.node_id] = run_counts.get(task.node_id, 0) + 1
            run_log.event(
                task.node_id,
                "queued",
                run_number=run_counts[task.node_id],
                fan_out_item=task.loop_item,
                message="node ready to start",
            )
            results: dict[str, NodeOutput] = {}
            halt_flag = [False]
            await self._run_node(
                node,
                ctx,
                results,
                halt_flag,
                graph,
                run_counts[task.node_id],
                loop_item=task.loop_item,
            )
            output = results[task.node_id]
            ctx.record(output)
            if output.terminal_status is not None:
                self._record_loop_item_output(
                    task,
                    output,
                    loop_item_outputs,
                    completed_loop_items,
                    terminal=True,
                )
                halted = True
                terminal_success = output.terminal_status == "pass"
                halt_reason = output.output.strip() or None
                break
            if halt_flag[0]:
                self._record_loop_item_output(
                    task,
                    output,
                    loop_item_outputs,
                    completed_loop_items,
                    terminal=True,
                )
                halted = True
                halt_reason = (
                    "stopped by user" if self._stop_requested() else output.error or output.output
                )
                break
            scheduled_successors = self._queue_successor_tasks(
                output,
                task,
                graph,
                ctx,
                queue,
                queued,
                running,
            )
            self._record_loop_item_output(
                task,
                output,
                loop_item_outputs,
                completed_loop_items,
                terminal=not scheduled_successors,
            )
            if output.loop_items is not None:
                loop_next_index.setdefault(
                    output.node_id,
                    min(output.loop_max_concurrency, len(output.loop_items)),
                )
            if output.loop_items is not None and not scheduled_successors:
                self._queue_loop_done_successors(
                    task.node_id,
                    graph,
                    queue,
                    queued,
                    running,
                    completed_loops,
                    queued_after_loop_edges,
                )

            if (
                task.loop_origin
                and (task.loop_infinite or task.loop_items is not None)
                and not scheduled_successors
                and not self._stop_requested()
            ):
                iteration_key = (task.loop_origin, task.loop_index)
                has_iteration_work = any(key[1:] == iteration_key for key in queued | running)
                if not has_iteration_work:
                    next_index = loop_next_index.get(
                        task.loop_origin,
                        (task.loop_index or 0) + 1,
                    )
                    if task.loop_items is not None and next_index >= len(task.loop_items):
                        has_loop_work = any(key[1] == task.loop_origin for key in queued | running)
                        if not has_loop_work:
                            self._queue_loop_done_successors(
                                task.loop_origin,
                                graph,
                                queue,
                                queued,
                                running,
                                completed_loops,
                                queued_after_loop_edges,
                            )
                        continue
                    if task.loop_infinite:
                        next_item: dict[str, object] = {"index": str(next_index)}
                    else:
                        if task.loop_items is None:
                            continue
                        next_item = task.loop_items[next_index]
                    loop_next_index[task.loop_origin] = next_index + 1
                    for successor_id in graph._graph.successors(task.loop_origin):
                        edge = graph.get_edge_config(task.loop_origin, successor_id)
                        if edge.condition == EdgeConditionType.AFTER_LOOP:
                            continue
                        next_task = QueuedNode(
                            successor_id,
                            loop_origin=task.loop_origin,
                            loop_item=next_item,
                            loop_index=next_index,
                            loop_items=task.loop_items,
                            loop_infinite=task.loop_infinite,
                            loop_max_concurrency=task.loop_max_concurrency,
                            loop_fail_fast=task.loop_fail_fast,
                        )
                        if next_task.key in queued or next_task.key in running:
                            continue
                        queue.append(next_task)
                        queued.add(next_task.key)

        self._record_unrun_node_events(
            graph,
            ctx,
            run_log,
            stopped=halt_reason == "stopped by user" or self._stop_requested(),
        )
        success = (
            terminal_success
            if terminal_success is not None
            else not halted
            and all(
                output.success
                or graph._nodes[output.node_id].allow_failure
                or (
                    output.type == str(OperationType.APPROVAL_GATE)
                    and self._has_failure_route(graph._nodes[output.node_id], output, graph)
                )
                for runs in ctx.node_runs.values()
                for output in runs
                if not output.skipped
            )
        )
        reason = None if success else halt_reason or self._failure_reason(ctx.node_outputs)
        terminal_status: Literal["completed", "failed", "stopped"] | None = (
            "stopped" if reason == "stopped by user" else None
        )
        run_log.complete(success, reason, terminal_status=terminal_status)
        return ExecutionResult(
            workflow_id=self._workflow.config.id,
            success=success,
            node_outputs=ctx.node_outputs,
            node_runs=ctx.node_runs,
            duration_seconds=time.monotonic() - start,
            log_path=run_log.path,
            usage_summary=summarize_node_outputs(ctx.node_outputs, ctx.node_runs),
        )

    def _start_stop_monitor(self) -> threading.Thread | None:
        if self._stop_file is None:
            return None

        def monitor() -> None:
            while not self._stop_monitor_done.wait(0.1):
                if (self._stop_file and self._stop_file.exists()) or (
                    self._run_stop_file and self._run_stop_file.exists()
                ):
                    self._cancel_event.set()
                    return

        thread = threading.Thread(target=monitor, daemon=True)
        thread.start()
        return thread

    def _initial_node_ids(self, graph: WorkflowGraph) -> list[str]:
        roots = [
            node_id
            for node_id in graph._nodes
            if not [pred_id for pred_id in graph._graph.predecessors(node_id) if pred_id != node_id]
        ]
        if roots:
            return roots
        return [next(iter(graph._nodes))] if graph._nodes else []

    def _approval_command(
        self,
        action: Literal["approve", "reject"],
        run_id: str,
        node_id: str,
        approvers: Sequence[str] | None = None,
    ) -> str:
        command = f"gof workflow {action} {run_id} {node_id} --workflow {self._workflow.config.id}"
        if approvers:
            command = f"{command} --by {shlex.quote(str(approvers[0]))}"
        return command

    def _queue_resume_frontier(
        self,
        graph: WorkflowGraph,
        ctx: ExecutionContext,
        queue: deque[QueuedNode],
        queued_tasks: set[tuple[str, str | None, int | None]],
        running_tasks: set[tuple[str, str | None, int | None]],
    ) -> None:
        completed = set(ctx.node_outputs)
        for node_id in self._initial_node_ids(graph):
            if node_id in completed:
                continue
            task = QueuedNode(node_id)
            if task.key in queued_tasks or task.key in running_tasks:
                continue
            queue.append(task)
            queued_tasks.add(task.key)

        for output in list(ctx.node_outputs.values()):
            current_task = QueuedNode(output.node_id)
            before = len(queue)
            self._queue_successor_tasks(
                output,
                current_task,
                graph,
                ctx,
                queue,
                queued_tasks,
                running_tasks,
            )
            if len(queue) == before:
                continue
            filtered = deque(
                task
                for task in queue
                if task.node_id not in completed or task.loop_origin is not None
            )
            if len(filtered) != len(queue):
                queue.clear()
                queue.extend(filtered)
                queued_tasks.clear()
                queued_tasks.update(task.key for task in queue)

    def _all_inputs_ready(
        self,
        node_id: str,
        ctx: ExecutionContext,
        graph: WorkflowGraph,
    ) -> bool:
        for pred_id in graph._graph.predecessors(node_id):
            if pred_id == node_id:
                continue
            output = ctx.node_outputs.get(pred_id)
            if output is None:
                return False
            edge = graph.get_edge_config(pred_id, node_id)
            if not edge.evaluate(output):
                return False
        return True

    def _successor_tasks(
        self,
        successor_id: str,
        output: NodeOutput,
        current_task: QueuedNode,
    ) -> list[QueuedNode]:
        if output.loop_infinite:
            return [
                QueuedNode(
                    successor_id,
                    loop_origin=output.node_id,
                    loop_item={"index": "0"},
                    loop_index=0,
                    loop_items=None,
                    loop_infinite=True,
                    loop_max_concurrency=min(1, self._limits.max_fanout_concurrency),
                    loop_fail_fast=False,
                )
            ]
        if output.loop_items is not None:
            if not output.loop_items:
                return []
            initial_count = min(output.loop_max_concurrency, len(output.loop_items))
            return [
                QueuedNode(
                    successor_id,
                    loop_origin=output.node_id,
                    loop_item=output.loop_items[index],
                    loop_index=index,
                    loop_items=output.loop_items,
                    loop_infinite=False,
                    loop_max_concurrency=output.loop_max_concurrency,
                    loop_fail_fast=output.loop_fail_fast,
                )
                for index in range(initial_count)
            ]
        return [
            QueuedNode(
                successor_id,
                loop_origin=current_task.loop_origin,
                loop_item=current_task.loop_item,
                loop_index=current_task.loop_index,
                loop_items=current_task.loop_items,
                loop_infinite=current_task.loop_infinite,
                loop_max_concurrency=current_task.loop_max_concurrency,
                loop_fail_fast=current_task.loop_fail_fast,
            )
        ]

    def _queue_successor_tasks(
        self,
        output: NodeOutput,
        current_task: QueuedNode,
        graph: WorkflowGraph,
        ctx: ExecutionContext,
        queue: deque[QueuedNode],
        queued_tasks: set[tuple[str, str | None, int | None]],
        running_tasks: set[tuple[str, str | None, int | None]],
    ) -> bool:
        scheduled = False
        for successor_id in graph._graph.successors(output.node_id):
            edge = graph.get_edge_config(output.node_id, successor_id)
            if edge.condition == EdgeConditionType.AFTER_LOOP:
                continue
            matched = edge.evaluate(output)
            self._log().event(
                output.node_id,
                "edge_decision",
                message=(
                    f"{output.node_id} -> {successor_id} "
                    f"{'matched' if matched else 'skipped'} ({edge.condition})"
                ),
                success=matched,
                data={
                    "from": output.node_id,
                    "to": successor_id,
                    "condition": str(edge.condition),
                    "outputPattern": edge.output_pattern or "",
                    "matched": matched,
                },
            )
            if not matched:
                continue
            successor = graph._nodes[successor_id]
            if successor.await_all_inputs and not self._all_inputs_ready(
                successor_id,
                ctx,
                graph,
            ):
                continue
            for successor_task in self._successor_tasks(successor_id, output, current_task):
                if successor_task.key in queued_tasks or successor_task.key in running_tasks:
                    continue
                queue.append(successor_task)
                queued_tasks.add(successor_task.key)
                self._log().event(
                    successor_id,
                    "queued",
                    fan_out_item=successor_task.loop_item,
                    message=f"queued by {output.node_id}",
                    data={"from": output.node_id},
                )
                scheduled = True
        return scheduled

    def _queue_loop_done_successors(
        self,
        loop_node_id: str,
        graph: WorkflowGraph,
        queue: deque[QueuedNode],
        queued_tasks: set[tuple[str, str | None, int | None]],
        running_tasks: set[tuple[str, str | None, int | None]],
        completed_loops: set[str],
        queued_after_loop_edges: set[tuple[str, str]],
    ) -> None:
        if loop_node_id in completed_loops:
            return
        completed_loops.add(loop_node_id)
        for successor_id in graph._graph.successors(loop_node_id):
            edge = graph.get_edge_config(loop_node_id, successor_id)
            if edge.condition != EdgeConditionType.AFTER_LOOP:
                continue
            edge_key = (loop_node_id, successor_id)
            if edge_key in queued_after_loop_edges:
                continue
            queued_after_loop_edges.add(edge_key)
            self._log().event(
                loop_node_id,
                "edge_decision",
                message=f"{loop_node_id} -> {successor_id} matched ({edge.condition})",
                success=True,
                data={
                    "from": loop_node_id,
                    "to": successor_id,
                    "condition": str(edge.condition),
                    "outputPattern": edge.output_pattern or "",
                    "matched": True,
                },
            )
            task = QueuedNode(successor_id, after_loop_origin=loop_node_id)
            if task.key in queued_tasks or task.key in running_tasks:
                continue
            queue.append(task)
            queued_tasks.add(task.key)
            self._log().event(
                successor_id,
                "queued",
                message=f"queued after loop {loop_node_id}",
                data={"from": loop_node_id, "condition": str(edge.condition)},
            )

    async def _run_node(
        self,
        node: GraphNode,
        ctx: ExecutionContext,
        results: dict[str, NodeOutput],
        halt_flag: list[bool],
        graph: WorkflowGraph,
        run_number: int = 1,
        loop_item: dict[str, object] | None = None,
    ) -> None:
        if self._dry_run:
            log.info("[dry-run] would execute node %s", node.node_id)
            self._log().node(
                node.node_id,
                self._run_log_message(run_number, "dry-run would execute"),
            )
            results[node.node_id] = NodeOutput(
                node_id=node.node_id, success=True, output="", exit_code=0, duration_seconds=0.0
            )
            self._log().event(node.node_id, "completed", success=True, message="dry run")
            return

        attempt = 0
        output: NodeOutput | None = None
        while True:
            self._log().begin_node_attempt(node.node_id, run_number, attempt + 1)
            attempt_started = time.monotonic()
            inputs = self._resolve_node_inputs(node, ctx, graph, loop_item)
            self._log().event(
                node.node_id,
                "started",
                attempt=attempt + 1,
                run_number=run_number,
                fan_out_item=loop_item,
                message=f"attempt {attempt + 1} started",
                data={"inputs": self._event_preview(inputs)},
            )
            self._log().node(
                node.node_id,
                self._run_log_message(run_number, f"attempt {attempt + 1} started"),
            )
            try:
                output = await self._execute_operation(node, ctx, graph, loop_item)
            except Exception as exc:  # noqa: BLE001
                self._log().error(f"{node.node_id} raised exception: {exc}")
                output = NodeOutput(
                    node_id=node.node_id,
                    success=False,
                    output=str(exc),
                    exit_code=1,
                    duration_seconds=0.0,
                )
            results[node.node_id] = output
            logged_output = output.output
            if output.type == str(OperationType.HTTP_REQUEST):
                preview = output.data.get("responsePreview")
                if isinstance(preview, dict):
                    preview_body = preview.get("body")
                    if isinstance(preview_body, str):
                        logged_output = preview_body
                elif isinstance(output.data.get("error"), str):
                    logged_output = str(output.data["error"])
            self._log().node_output(node.node_id, "node output", logged_output)
            self._log().node(
                node.node_id,
                self._run_log_message(
                    run_number,
                    f"attempt {attempt + 1} finished success={output.success} "
                    f"exit_code={output.exit_code} duration={output.duration_seconds:.2f}s",
                ),
            )
            status = "completed" if output.success else "failed"
            if self._stop_requested():
                status = "stopped"
            self._log().event(
                node.node_id,
                status,
                attempt=attempt + 1,
                run_number=run_number,
                fan_out_item=loop_item,
                message=(
                    f"attempt {attempt + 1} finished "
                    f"success={output.success} exit_code={output.exit_code}"
                ),
                duration_seconds=output.duration_seconds
                or (time.monotonic() - attempt_started),
                exit_code=output.exit_code,
                success=output.success,
                data=self._node_event_data(output),
            )
            if output.success or attempt >= node.retry_count:
                break
            attempt += 1
            self._log().node(
                node.node_id,
                self._run_log_message(
                    run_number, f"retrying after {node.retry_delay_seconds:.2f}s"
                ),
            )
            self._log().event(
                node.node_id,
                "retried",
                attempt=attempt + 1,
                run_number=run_number,
                message=f"retrying after {node.retry_delay_seconds:.2f}s",
            )
            if self._stop_requested():
                break
            await anyio.sleep(node.retry_delay_seconds)

        if output is not None and not output.success:
            if (
                not node.allow_failure
                and node.on_failure == "halt"
                and not self._has_failure_route(node, output, graph)
            ):
                halt_flag[0] = True

        if self._stop_requested():
            halt_flag[0] = True

    def _run_log_message(self, run_number: int, message: str) -> str:
        if run_number == 1:
            return message
        return f"run {run_number} {message}"

    def _has_failure_route(self, node: GraphNode, output: NodeOutput, graph: WorkflowGraph) -> bool:
        for successor_id in graph._graph.successors(node.node_id):
            edge = graph.get_edge_config(node.node_id, successor_id)
            if edge.condition in {
                EdgeConditionType.ON_FAILURE,
                EdgeConditionType.OUTPUT_MATCHES,
            } and edge.evaluate(output):
                return True
        return False

    def _resolve_piped_outputs(
        self,
        node: GraphNode,
        ctx: ExecutionContext,
        graph: WorkflowGraph,
        loop_item: dict[str, object] | None = None,
    ) -> list[str]:
        piped = []
        for pred_id in graph._graph.predecessors(node.node_id):
            pred_node = graph._nodes.get(pred_id)
            if pred_node is None or not pred_node.pipe_output:
                continue
            if pred_node.operation.type == OperationType.LOOP and loop_item is not None:
                piped.append(json.dumps(loop_item, default=str))
                continue
            if (output := ctx.node_outputs.get(pred_id)) is not None:
                piped.append(output.output)
        return piped

    def _resolve_input_value(
        self,
        node: GraphNode,
        ctx: ExecutionContext,
        graph: WorkflowGraph,
        value: str,
        loop_item: dict[str, object] | None = None,
    ) -> object:
        parts = value.strip("{}").split(".")
        root = parts[0] if parts else ""
        known_roots = {"trigger", "loop", "previous", *ctx.node_outputs.keys()}
        if root not in known_roots:
            return value
        try:
            return ctx.resolve_path_with_loop(
                value,
                loop_item,
                current_node_id=node.node_id,
                graph=graph,
            )
        except Exception:
            return value

    def _resolve_node_inputs(
        self,
        node: GraphNode,
        ctx: ExecutionContext,
        graph: WorkflowGraph,
        loop_item: dict[str, object] | None = None,
    ) -> dict[str, object]:
        return {
            key: self._resolve_input_value(node, ctx, graph, value, loop_item)
            for key, value in node.inputs.items()
        }

    def _input_text(self, value: object) -> str:
        if isinstance(value, str):
            return value
        return json.dumps(value, default=str)

    def _explicit_stdin(
        self,
        node: GraphNode,
        ctx: ExecutionContext,
        graph: WorkflowGraph,
        loop_item: dict[str, object] | None = None,
    ) -> bytes | None:
        inputs = self._resolve_node_inputs(node, ctx, graph, loop_item)
        if "stdin" not in inputs:
            return None
        return self._input_text(inputs["stdin"]).encode()

    def _resolved_env(
        self,
        node: GraphNode,
        ctx: ExecutionContext,
        graph: WorkflowGraph,
        base_env: dict[str, str],
        loop_item: dict[str, object] | None = None,
    ) -> dict[str, str] | None:
        env = dict(base_env)
        if loop_item:
            for key, value in loop_item.items():
                if key.lower() == "path":
                    continue
                if isinstance(value, (str, int, float, bool)):
                    env.setdefault(key.upper(), self._input_text(value))
        for key, value in self._resolve_node_inputs(node, ctx, graph, loop_item).items():
            if key.startswith("env.") and len(key) > 4:
                env[key[4:]] = self._input_text(value)
        return env or None

    def _input_context(
        self,
        node: GraphNode,
        ctx: ExecutionContext,
        graph: WorkflowGraph,
        loop_item: dict[str, object] | None = None,
    ) -> dict[str, object]:
        return {
            key: value
            for key, value in self._resolve_node_inputs(node, ctx, graph, loop_item).items()
            if key != "stdin" and not key.startswith("env.")
        }

    def _template_context(
        self,
        node: GraphNode,
        ctx: ExecutionContext,
        graph: WorkflowGraph,
        loop_item: dict[str, object] | None = None,
    ) -> dict[str, object]:
        run_log = self._log()
        return {
            **{key: output.contract() for key, output in ctx.node_outputs.items()},
            "workflow": {
                "id": self._workflow.config.id,
                "name": self._workflow.config.name,
                "path": str(self._workflow_path) if self._workflow_path else "",
            },
            "run": {
                "id": run_log.path.name,
                "logPath": str(run_log.path),
                "approveCommand": self._approval_command(
                    "approve",
                    run_log.path.name,
                    node.node_id,
                    getattr(node.operation, "approvers", []),
                ),
                "rejectCommand": self._approval_command(
                    "reject",
                    run_log.path.name,
                    node.node_id,
                    getattr(node.operation, "approvers", []),
                ),
            },
            "trigger": ctx.trigger,
            "loop": {"current": loop_item or {}, **(loop_item or {})},
            "previous": (
                ctx.predecessor_outputs(node.node_id, graph)[-1].contract()
                if ctx.predecessor_outputs(node.node_id, graph)
                else {}
            ),
            **self._input_context(node, ctx, graph, loop_item),
        }

    def _render_http_value(
        self,
        value: object,
        template_context: dict[str, object],
    ) -> object:
        if isinstance(value, str):
            secret = _secret_name(value)
            if secret is not None:
                return _read_secret(secret)
            return PromptManager._interpolate(_replace_secret_tokens(value), template_context)
        if isinstance(value, dict):
            return {
                str(key): self._render_http_value(item, template_context)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [self._render_http_value(item, template_context) for item in value]
        return value

    def _http_output_mapping(
        self,
        response_data: dict[str, object],
        mapping: dict[str, str],
    ) -> dict[str, object]:
        selected: dict[str, object] = {}
        for key, path in mapping.items():
            selected[key] = _extract_dotted_path(response_data, path)
        return selected

    def _resolve_pipe_stdin(
        self,
        node: GraphNode,
        ctx: ExecutionContext,
        graph: WorkflowGraph,
        loop_item: dict[str, object] | None = None,
    ) -> bytes | None:
        explicit = self._explicit_stdin(node, ctx, graph, loop_item)
        if explicit is not None:
            return explicit
        piped = self._resolve_piped_outputs(node, ctx, graph, loop_item)
        if not piped:
            return None
        return "\n".join(piped).encode()

    async def _execute_operation(
        self,
        node: GraphNode,
        ctx: ExecutionContext,
        graph: WorkflowGraph,
        loop_item: dict[str, object] | None = None,
    ) -> NodeOutput:
        op = node.operation
        start = time.monotonic()

        if op.type == OperationType.START:
            assert isinstance(op, StartOperation)
            self._log().node(node.node_id, "start")
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output="",
                exit_code=0,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
            )

        if op.type == OperationType.PASS:
            assert isinstance(op, PassOperation)
            message = op.message.strip() or "workflow passed"
            self._log().node(node.node_id, f"pass: {message}")
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=message,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
                terminal_status="pass",
                type=str(op.type),
                data={"message": message},
            )

        if op.type == OperationType.FAIL:
            assert isinstance(op, FailOperation)
            message = op.message.strip() or "workflow failed"
            self._log().node(node.node_id, f"fail: {message}")
            return NodeOutput(
                node_id=node.node_id,
                success=False,
                output=message,
                exit_code=1,
                duration_seconds=time.monotonic() - start,
                terminal_status="fail",
                type=str(op.type),
                data={"message": message},
            )

        if op.type == OperationType.BREAK:
            assert isinstance(op, BreakOperation)
            message = op.message.strip() or "loop break"
            self._log().node(node.node_id, f"break: {message}")
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=message,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
                terminal_status="break",
                type=str(op.type),
                data={"message": message},
            )

        if op.type == OperationType.APPROVAL_GATE:
            assert isinstance(op, ApprovalGateOperation)
            template_context = self._template_context(node, ctx, graph, loop_item)
            message = str(self._render_http_value(op.message, template_context))
            run_id = self._log().path.name
            checkpoint_path = self._approval_checkpoint_path(run_id, node.node_id)
            self._write_approval_checkpoint(
                checkpoint_path,
                node_id=node.node_id,
                ctx=ctx,
                trigger_context=self._trigger_context,
            )
            request = ApprovalRequest(
                workflow_id=self._workflow.config.id,
                run_id=run_id,
                node_id=node.node_id,
                message=message,
                approvers=list(op.approvers),
                timeout_seconds=op.timeout_seconds,
                timeout_decision=op.timeout_decision,
                workflow_path=str(self._workflow_path) if self._workflow_path else None,
                log_path=str(self._log().path),
                checkpoint_path=str(checkpoint_path),
            )
            request_path = self._approval_store.create_or_update(request)
            approve_command = self._approval_command(
                "approve",
                run_id,
                node.node_id,
                op.approvers,
            )
            reject_command = self._approval_command(
                "reject",
                run_id,
                node.node_id,
                op.approvers,
            )
            self._log().node(
                node.node_id,
                f"approval pending: run_id={run_id} request={request_path}",
            )
            self._log().node_output(node.node_id, "approval message", message)
            if op.notify:
                await self._notification_adapter.send(
                    Notification(
                        title=str(
                            self._render_http_value(
                                op.notification_title,
                                template_context,
                            )
                        ),
                        body=(
                            f"{message}\n\n"
                            f"Approve with: {approve_command}\n"
                            f"Reject with: {reject_command}"
                        ),
                    )
                )
            decision = await wait_for_decision(
                self._approval_store,
                self._workflow.config.id,
                run_id,
                node.node_id,
                timeout_seconds=op.timeout_seconds,
            )
            if decision is None:
                decision_value: ApprovalDecisionValue = (
                    "timeout" if op.timeout_decision == "timeout" else "rejected"
                )
                self._approval_store.decide(
                    self._workflow.config.id,
                    run_id,
                    node.node_id,
                    decision_value,
                    decided_by="gofer",
                    notes=f"Timed out after {op.timeout_seconds} seconds",
                )
                decided_by = "gofer"
                notes = f"Timed out after {op.timeout_seconds} seconds"
            else:
                decision_value = decision.decision
                decided_by = decision.decided_by
                notes = decision.notes
            approved = decision_value == "approved"
            output_text = (
                f"approval {decision_value} by {decided_by}{': ' + notes if notes else ''}"
            )
            self._log().node(
                node.node_id,
                f"approval decision: decision={decision_value} by={decided_by}",
            )
            if notes:
                self._log().node_output(node.node_id, "approval notes", notes)
            return NodeOutput(
                node_id=node.node_id,
                success=approved,
                output=output_text,
                exit_code=0 if approved else 1,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                value=decision_value,
                data={
                    "status": "decided",
                    "decision": decision_value,
                    "approved": approved,
                    "decidedBy": decided_by,
                    "notes": notes,
                    "message": message,
                    "runId": run_id,
                    "requestPath": str(request_path),
                    "approvers": list(op.approvers),
                    "timeoutSeconds": op.timeout_seconds,
                    "followUpCommand": approve_command,
                    "approveCommand": approve_command,
                    "rejectCommand": reject_command,
                },
                error=output_text if not approved else None,
            )

        if op.type == OperationType.LOOP:
            assert isinstance(op, LoopOperation)
            if isinstance(op.source, InfiniteFanSource):
                self._log().node(node.node_id, "loop source: infinite")
                return NodeOutput(
                    node_id=node.node_id,
                    success=True,
                    output="infinite loop started",
                    exit_code=0,
                    duration_seconds=time.monotonic() - start,
                    loop_items=[],
                    loop_infinite=True,
                    loop_max_concurrency=1,
                    type=str(op.type),
                    text="infinite loop started",
                )
            items = _resolve_fan_items(op.source, ctx, self._limits, self._path_base)
            output = json.dumps(items, default=str)
            self._log().node(node.node_id, f"loop source: {op.source.type}")
            self._log().node(node.node_id, f"loop items: {len(items)}")
            source_path = getattr(op.source, "path", None)
            resolved_source_path = (
                str(_resolve_workflow_path(source_path, self._path_base))
                if isinstance(source_path, Path)
                else ""
            )
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
                loop_items=items,
                loop_max_concurrency=max(
                    1,
                    min(op.source.max_concurrency, self._limits.max_fanout_concurrency),
                ),
                loop_fail_fast=bool(getattr(op.source, "fail_fast", False)),
                type=str(op.type),
                items=list(items),
                data={
                    "source_type": op.source.type,
                    "count": len(items),
                    "source_path": resolved_source_path,
                    "glob": str(getattr(op.source, "glob", "")),
                    "include_content": bool(getattr(op.source, "include_content", False)),
                    "max_concurrency": int(getattr(op.source, "max_concurrency", 1)),
                    "fail_fast": bool(getattr(op.source, "fail_fast", False)),
                },
            )

        if op.type == OperationType.BASH_COMMAND:
            assert isinstance(op, BashCommandOperation)
            stdin = self._resolve_pipe_stdin(node, ctx, graph, loop_item)
            cmd = command_shell_args(op.command)
            working_dir = (
                _resolve_workflow_path(op.working_dir, self._path_base)
                if op.working_dir is not None
                else None
            )
            self._log().node(node.node_id, f"command: {op.command}")
            self._log().node(node.node_id, f"command shell: {cmd[0]}")
            rc, stdout, stderr = await run_subprocess(
                cmd,
                cancel_event=self._cancel_event,
                cwd=working_dir,
                env=self._resolved_env(node, ctx, graph, op.env, loop_item),
                timeout=node.timeout_seconds,
                stdin=stdin,
                max_output_bytes=self._limits.max_subprocess_output_bytes,
            )
            self._log().node_output(node.node_id, "stdout", stdout)
            self._log().node_output(node.node_id, "stderr", stderr)
            return NodeOutput(
                node_id=node.node_id,
                success=rc == 0,
                output=stdout or stderr,
                exit_code=rc,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                data={"stdout": stdout, "stderr": stderr, "command": op.command},
                error=stderr if rc != 0 else None,
            )

        elif op.type in (OperationType.PYTHON_SCRIPT, OperationType.SHELL_SCRIPT):
            assert isinstance(op, (PythonScriptOperation, ShellScriptOperation))
            interpreter = "python" if op.type == OperationType.PYTHON_SCRIPT else "bash"
            script_path = _resolve_workflow_path(op.script_path, self._path_base)
            cmd = [interpreter, str(script_path)] + list(op.args)
            stdin = self._resolve_pipe_stdin(node, ctx, graph, loop_item)
            self._log().node(node.node_id, f"command: {' '.join(cmd)}")
            rc, stdout, stderr = await run_subprocess(
                cmd,
                cancel_event=self._cancel_event,
                env=self._resolved_env(node, ctx, graph, op.env, loop_item),
                timeout=node.timeout_seconds,
                stdin=stdin,
                max_output_bytes=self._limits.max_subprocess_output_bytes,
            )
            self._log().node_output(node.node_id, "stdout", stdout)
            self._log().node_output(node.node_id, "stderr", stderr)
            return NodeOutput(
                node_id=node.node_id,
                success=rc == 0,
                output=stdout or stderr,
                exit_code=rc,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                data={
                    "stdout": stdout,
                    "stderr": stderr,
                    "script_path": str(script_path),
                },
                error=stderr if rc != 0 else None,
            )

        elif op.type == OperationType.READ_FILE:
            assert isinstance(op, ReadFileOperation)
            path = _resolve_workflow_path(op.path, self._path_base)
            self._log().node(node.node_id, f"read file: {path}")
            content = read_text_limited(
                path,
                encoding=op.encoding,
                errors=op.errors,
                max_bytes=self._limits.max_file_read_bytes,
            )
            self._log().node_output(node.node_id, "file content", content)
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=content,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                data={
                    **_file_path_data(path),
                    "content": content,
                },
            )

        elif op.type == OperationType.WRITE_FILE:
            assert isinstance(op, WriteFileOperation)
            stdin = self._resolve_pipe_stdin(node, ctx, graph, loop_item)
            path = _resolve_workflow_path(op.path, self._path_base)
            content = op.content
            if content == "" and stdin is not None:
                content = stdin.decode(op.encoding)
            _prepare_destination(path, op.create_dirs, op.overwrite or op.append)
            mode = "a" if op.append else "w"
            with path.open(mode, encoding=op.encoding) as fh:
                fh.write(content)
            action = "appended" if op.append else "wrote"
            output = f"{action} {len(content)} characters to {path}"
            self._log().node(node.node_id, output)
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                data={
                    **_file_path_data(path),
                    "content": content,
                    "action": action,
                    "bytes_written": len(content.encode(op.encoding)),
                    "characters_written": len(content),
                },
            )

        elif op.type == OperationType.COPY_FILE:
            assert isinstance(op, CopyFileOperation)
            source_path = _resolve_workflow_path(op.source_path, self._path_base)
            destination_path = _resolve_workflow_path(
                op.destination_path,
                self._path_base,
            )
            _copy_path(source_path, destination_path, op.create_dirs, op.overwrite)
            output = f"copied {source_path} to {destination_path}"
            self._log().node(node.node_id, output)
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                data={
                    "source_path": str(source_path),
                    "destination_path": str(destination_path),
                    "source_name": source_path.name,
                    "destination_name": destination_path.name,
                    "destination_directory": str(destination_path.parent),
                },
            )

        elif op.type == OperationType.MOVE_FILE:
            assert isinstance(op, MoveFileOperation)
            source_path = _resolve_workflow_path(op.source_path, self._path_base)
            destination_path = _resolve_workflow_path(
                op.destination_path,
                self._path_base,
            )
            _move_path(source_path, destination_path, op.create_dirs, op.overwrite)
            output = f"moved {source_path} to {destination_path}"
            self._log().node(node.node_id, output)
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                data={
                    "source_path": str(source_path),
                    "destination_path": str(destination_path),
                    "source_name": source_path.name,
                    "destination_name": destination_path.name,
                    "destination_directory": str(destination_path.parent),
                },
            )

        elif op.type == OperationType.DELETE_FILE:
            assert isinstance(op, DeleteFileOperation)
            path = _resolve_workflow_path(op.path, self._path_base)
            if not path.exists():
                if op.missing_ok:
                    output = f"{path} did not exist"
                    self._log().node(node.node_id, output)
                    return NodeOutput(
                        node_id=node.node_id,
                        success=True,
                        output=output,
                        exit_code=0,
                        duration_seconds=time.monotonic() - start,
                        type=str(op.type),
                        data={"path": str(path), "missing": True},
                    )
                raise FileNotFoundError(path)

            if op.use_trash:
                trash_path = _trash_path(path)
                output = f"moved {path} to trash at {trash_path}"
            else:
                _remove_path(path, recursive=op.recursive)
                output = f"deleted {path}"
            self._log().node(node.node_id, output)
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                data={
                    **(_folder_path_data(path) if path.is_dir() else _file_path_data(path)),
                    "trash_path": str(trash_path) if op.use_trash else "",
                    "deleted": not op.use_trash,
                },
            )

        elif op.type == OperationType.FILE:
            assert isinstance(op, FileOperation)
            path = _resolve_workflow_path(op.path, self._path_base)
            output = str(path)
            self._log().node(node.node_id, f"file path: {output}")
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                data=_file_path_data(path),
            )

        elif op.type == OperationType.FOLDER:
            assert isinstance(op, FolderOperation)
            path = _resolve_workflow_path(op.path, self._path_base)
            output = str(path)
            self._log().node(node.node_id, f"folder path: {output}")
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                data=_folder_path_data(path),
            )

        elif op.type == OperationType.OPEN_RESOURCE:
            assert isinstance(op, OpenResourceOperation)
            target = op.target.strip()
            if not target:
                raise ValueError("Open target is required")
            resource_type = op.resource_type
            self._log().node(node.node_id, f"open {resource_type}: {target}")
            if resource_type in {"auto", "url"} and "://" in target:
                opened = webbrowser.open(target)
                if not opened:
                    raise RuntimeError(f"Could not open URL: {target}")
            elif sys.platform == "win32" and resource_type != "app":
                os.startfile(target)  # type: ignore[attr-defined]
            else:
                cmd = open_resource_args(target, resource_type, op.args)
                rc, stdout, stderr = await run_subprocess(
                    cmd,
                    cancel_event=self._cancel_event,
                    timeout=node.timeout_seconds,
                    max_output_bytes=self._limits.max_subprocess_output_bytes,
                )
                self._log().node_output(node.node_id, "stdout", stdout)
                self._log().node_output(node.node_id, "stderr", stderr)
                if rc != 0:
                    return NodeOutput(
                        node_id=node.node_id,
                        success=False,
                        output=stderr or stdout,
                        exit_code=rc,
                        duration_seconds=time.monotonic() - start,
                        type=str(op.type),
                        data={"target": target, "stdout": stdout, "stderr": stderr},
                        error=stderr or stdout,
                    )
            output = f"opened {target}"
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                data={"target": target, "resource_type": resource_type},
            )

        elif op.type == OperationType.PROMPT_FILE:
            assert isinstance(op, PromptFileOperation)
            if op.template_path is not None:
                template_path = _resolve_workflow_path(op.template_path, self._path_base)
                template = read_text_limited(
                    template_path,
                    encoding=op.encoding,
                    errors="strict",
                    max_bytes=self._limits.max_file_read_bytes,
                )
            else:
                template = op.template
            variables: dict[str, object] = {}
            for key, value in op.variables.items():
                if (
                    "." not in value
                    and value not in ctx.node_outputs
                    and not value.startswith("trigger")
                ):
                    variables[key] = value
                    continue
                try:
                    variables[key] = ctx.resolve_path_with_loop(
                        value,
                        loop_item,
                        current_node_id=node.node_id,
                        graph=graph,
                    )
                except Exception:
                    variables[key] = value
            variables.update(self._input_context(node, ctx, graph, loop_item))
            stdin = self._resolve_pipe_stdin(node, ctx, graph, loop_item)
            if stdin is not None:
                variables["_piped_input"] = stdin.decode(op.encoding)
            rendered = PromptManager._interpolate(template, variables)
            output_path = _resolve_workflow_path(op.output_path, self._path_base)
            _prepare_destination(output_path, op.create_dirs, op.overwrite)
            output_path.write_text(rendered, encoding=op.encoding)
            output = f"wrote prompt file {output_path}"
            self._log().node(node.node_id, output)
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                data={
                    **_file_path_data(output_path),
                    "content": rendered,
                    "inputs": variables,
                    "prompt": rendered,
                },
            )

        elif op.type == OperationType.COMMON_LLM_TASK:
            assert isinstance(op, CommonLlmTaskOperation)
            agent_config = self._workflow.agents.get(op.agent_id)
            if agent_config is None:
                raise ValueError(f"Agent '{op.agent_id}' not registered in workflow")
            sub = self._subscriptions.get(agent_config.subscription)
            if sub is None:
                raise ValueError(f"No subscription for '{agent_config.subscription}'")
            agent_config = self._agent_config_for_operation(
                agent_config,
                None,
                op.working_dir,
            )
            input_ctx = {
                key: self._resolve_input_value(node, ctx, graph, value, loop_item)
                for key, value in op.input_mapping.items()
            }
            input_ctx.update(self._input_context(node, ctx, graph, loop_item))
            stdin = self._resolve_pipe_stdin(node, ctx, graph, loop_item)
            if stdin is not None:
                input_ctx["_piped_input"] = stdin.decode()
            prompt = common_llm_task_prompt(op.task, op.target, op.instructions)
            try:
                memory = await self._compact_agent_memory_if_needed(
                    node.node_id,
                    op,
                    op.memory,
                    self._agent_memory(node.node_id, op.memory),
                    agent_config,
                    sub,
                )
            except LlmBudgetBlockedError as exc:
                message = str(exc)
                self._log().node(
                    node.node_id,
                    f"LLM budget blocked memory compaction: {message}",
                )
                return NodeOutput(
                    node_id=node.node_id,
                    success=False,
                    output=message,
                    exit_code=1,
                    duration_seconds=time.monotonic() - start,
                    type=str(op.type),
                    data={
                        "inputs": input_ctx,
                        "message": message,
                        "agent_id": op.agent_id,
                        "prompt": prompt,
                        "thoughts": [],
                        "budget": {
                            "blocked": True,
                            "violations": exc.violations,
                        },
                    },
                    error=message,
                )
            prompt_for_budget = self._agent_prompt_for_budget(
                agent_config,
                input_ctx,
                prompt,
                memory,
            )
            (
                budget_violations_before_call,
                usage_reservation,
            ) = await self._reserve_agent_call(
                node.node_id,
                op,
                prompt_for_budget,
            )
            if budget_violations_before_call:
                message = "; ".join(budget_violations_before_call)
                self._log().node(node.node_id, f"LLM budget blocked provider call: {message}")
                return NodeOutput(
                    node_id=node.node_id,
                    success=False,
                    output=message,
                    exit_code=1,
                    duration_seconds=time.monotonic() - start,
                    type=str(op.type),
                    data={
                        "inputs": input_ctx,
                        "message": message,
                        "agent_id": op.agent_id,
                        "prompt": prompt_for_budget,
                        "thoughts": [],
                        "budget": {
                            "blocked": True,
                            "violations": budget_violations_before_call,
                        },
                    },
                    error=message,
                )
            agent_timeout = await self._remaining_agent_time_timeout(node.node_id, op)
            result = await Agent(agent_config, sub).run(
                input_ctx,
                cancel_event=self._cancel_event if self._pass_cancel_event else None,
                prompt_override=prompt,
                memory=memory,
                max_output_bytes=self._limits.max_subprocess_output_bytes,
                timeout=agent_timeout,
            )
            self._log_agent_result(node.node_id, result)
            self._remember_agent_result(node.node_id, op.memory, result)
            usage = usage_from_metadata(
                provider=result.provider or agent_config.subscription,
                profile=result.profile or agent_config.profile,
                model=result.model or agent_config.model,
                prompt=result.prompt or prompt,
                output=result.output,
                duration_seconds=result.duration_seconds,
                pricing=agent_config.pricing,
                metadata=result.usage_metadata,
            )
            budget_violations_after_call = await self._record_agent_usage(
                node.node_id,
                op,
                usage,
                usage_reservation,
            )
            if budget_violations_after_call:
                self._log().node(
                    node.node_id,
                    "LLM budget exceeded: " + "; ".join(budget_violations_after_call),
                )
            result_output = result.output
            result_message = result.message if result.message is not None else result.output
            success = result.success and not budget_violations_after_call
            if budget_violations_after_call:
                result_output = "; ".join(budget_violations_after_call)
                result_message = result_output
            return NodeOutput(
                node_id=node.node_id,
                success=success,
                output=result_output,
                exit_code=result.exit_code if success else 1,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                data={
                    "inputs": input_ctx,
                    "message": result_message,
                    "agent_id": op.agent_id,
                    "prompt": result.prompt or prompt,
                    "thoughts": [
                        self._bounded_agent_thought(node.node_id, thought)
                        for thought in result.thoughts
                    ],
                    "usage": usage.model_dump(),
                    "budget": {
                        "violations": budget_violations_after_call,
                        "workflow_totals": self._llm_usage_totals.to_dict(),
                        "node_totals": self._node_llm_usage_totals[
                            node.node_id
                        ].to_dict(),
                    },
                },
                error=result_output if not success else None,
            )

        elif op.type == OperationType.LOCAL_VECTORIZE:
            assert isinstance(op, LocalVectorizeOperation)
            source_path = _resolve_workflow_path(op.source_path, self._path_base)
            index_path = _resolve_workflow_path(op.index_path, self._path_base)
            vector_target = source_path
            iterator = (
                (vector_target.rglob(op.glob) if op.recursive else vector_target.glob(op.glob))
                if vector_target.is_dir()
                else iter([vector_target])
            )
            files: list[Path] = []
            discovered: dict[str, dict[str, object]] = {}
            aggregate_bytes = 0
            for file_path in iterator:
                if not file_path.is_file():
                    continue
                if len(files) >= self._limits.max_files_scanned:
                    raise ResourceLimitError(
                        f"local_vectorize scanned files exceeded limit "
                        f"{self._limits.max_files_scanned}"
                    )
                files.append(file_path)
                stat = file_path.stat()
                size = stat.st_size
                require_limit(size, self._limits.max_file_read_bytes, f"{file_path} size")
                aggregate_bytes += size
                if aggregate_bytes > self._limits.max_aggregate_read_bytes:
                    raise ResourceLimitError(
                        "local_vectorize input exceeded aggregate limit "
                        f"{self._limits.max_aggregate_read_bytes} bytes "
                        f"(got {aggregate_bytes} bytes)"
                    )
                file_id = _vector_file_id(file_path)
                discovered[file_id] = {
                    "path": str(file_path),
                    "mtime_ns": stat.st_mtime_ns,
                    "size": size,
                }

            metadata = _vector_index_metadata(op, source_path)
            strategy = _local_vector_strategy(op.embedding_strategy, op.search_strategy)
            existing_index = (
                None
                if op.mode == "full"
                else _load_vector_index(
                    index_path,
                    self._limits.max_vector_index_bytes,
                    include_entries=False,
                )
            )
            compatible = _vector_index_compatible(existing_index, metadata)
            old_files = _vector_index_file_records(existing_index) if compatible else {}

            file_records: dict[str, dict[str, object]] = {}
            added_files = 0
            updated_files = 0
            unchanged_files = 0
            unreadable_files = 0
            changed_entries_bytes = 0
            temp_changed_entries: Path | None = None
            unchanged_file_ids: set[str] = set()

            def ensure_changed_entries_file() -> Path:
                nonlocal temp_changed_entries
                if temp_changed_entries is None:
                    index_path.parent.mkdir(parents=True, exist_ok=True)
                    temp_changed_entries = index_path.with_name(
                        f".{index_path.name}.{os.getpid()}.changed.jsonl"
                    )
                    temp_changed_entries.write_text("", encoding="utf-8")
                return temp_changed_entries

            for file_id, file_info in discovered.items():
                file_path = Path(str(file_info["path"]))
                try:
                    file_hash = _hash_file(file_path, self._limits.max_file_read_bytes)
                except OSError as exc:
                    unreadable_files += 1
                    self._log().error(f"{node.node_id} could not read {file_path}: {exc}")
                    continue
                file_info["hash"] = file_hash
                old_record = old_files.get(file_id)
                is_file_unchanged = (
                    old_record is not None
                    and old_record.get("mtime_ns") == file_info["mtime_ns"]
                    and old_record.get("size") == file_info["size"]
                    and old_record.get("hash") == file_hash
                )
                if compatible and is_file_unchanged:
                    reused_record = cast(dict[str, object], old_record)
                    file_records[file_id] = {
                        **reused_record,
                        "path": str(file_path),
                    }
                    unchanged_file_ids.add(file_id)
                    unchanged_files += 1
                    continue
                if op.mode == "validate":
                    continue
                try:
                    text = read_text_limited(
                        file_path,
                        encoding=op.encoding,
                        errors="replace",
                        max_bytes=self._limits.max_file_read_bytes,
                    )
                except OSError as exc:
                    unreadable_files += 1
                    self._log().error(f"{node.node_id} could not read {file_path}: {exc}")
                    continue
                chunks = _chunk_text(text, op.chunk_size, op.chunk_overlap)
                file_records[file_id] = {
                    **file_info,
                    "hash": file_hash,
                    "chunk_count": len(chunks),
                }
                with ensure_changed_entries_file().open("a", encoding="utf-8") as entries_file:
                    for chunk_index, chunk in enumerate(chunks):
                        entry = {
                            **_file_path_data(file_path),
                            "file_id": file_id,
                            "chunk": chunk_index,
                            "text": chunk,
                            "vector": strategy.embed(chunk),
                            "metadata": {
                                "file_path": str(file_path),
                                "file_name": file_path.name,
                                "mtime_ns": file_info["mtime_ns"],
                                "size": file_info["size"],
                                "hash": file_hash,
                            },
                        }
                        changed_entries_bytes += _write_vector_entry(entries_file, entry)
                if old_record is None:
                    added_files += 1
                else:
                    updated_files += 1

            deleted_file_ids = sorted(set(old_files) - set(discovered)) if compatible else []
            stale_file_ids = []
            if op.mode == "validate":
                for file_id, file_info in discovered.items():
                    old_record = old_files.get(file_id)
                    if old_record is None:
                        stale_file_ids.append(file_id)
                        continue
                    if (
                        old_record.get("mtime_ns") != file_info["mtime_ns"]
                        or old_record.get("size") != file_info["size"]
                        or old_record.get("hash") != file_info.get("hash")
                    ):
                        stale_file_ids.append(file_id)
                file_records = old_files if compatible else {}
                unchanged_file_ids = set(old_files)
            current = (
                compatible
                and not added_files
                and not updated_files
                and not deleted_file_ids
                and not stale_file_ids
                and not unreadable_files
            )
            existing_metadata = (
                existing_index.get("metadata", {}) if isinstance(existing_index, dict) else {}
            )
            stored_last_update_time = (
                existing_metadata.get("last_update_time")
                if isinstance(existing_metadata, dict)
                and isinstance(existing_metadata.get("last_update_time"), str)
                else None
            )
            should_write = op.mode != "validate" and (op.mode == "full" or not current)
            last_update_time = (
                datetime.now().astimezone().isoformat()
                if should_write
                else stored_last_update_time
                or datetime.now().astimezone().isoformat()
            )
            index_metadata = {
                **metadata,
                "last_update_time": last_update_time,
            }
            chunk_count = 0
            for record in file_records.values():
                record_chunk_count = record.get("chunk_count", 0)
                if isinstance(record_chunk_count, int):
                    chunk_count += record_chunk_count
            index_document_data: dict[str, object] = {
                "version": VECTOR_INDEX_VERSION,
                "source_path": str(source_path),
                "glob": op.glob,
                "metadata": index_metadata,
                "files": file_records,
                "entries_file": _default_vector_entries_path(index_path).name,
                "entry_count": chunk_count,
            }
            exact_index_bytes = (
                _vector_index_disk_size(index_path, existing_index)
                if not should_write
                else byte_len(json.dumps(index_document_data, default=str)) + changed_entries_bytes
            )
            if exact_index_bytes > self._limits.max_vector_index_bytes:
                if temp_changed_entries is not None:
                    temp_changed_entries.unlink(missing_ok=True)
                raise ResourceLimitError(
                    "local_vectorize index exceeded limit "
                    f"{self._limits.max_vector_index_bytes} bytes "
                    f"(got {exact_index_bytes} bytes)"
                )
            if op.mode == "validate":
                status = "current" if current else "stale"
                output = (
                    f"validated {index_path}: {status}; "
                    f"{len(file_records)} indexed files, {chunk_count} chunks, "
                    f"{len(stale_file_ids)} stale/new files, {len(deleted_file_ids)} deleted files"
                )
            else:
                if should_write:
                    index_path.parent.mkdir(parents=True, exist_ok=True)
                    entries_path = _default_vector_entries_path(index_path)
                    temp_entries_path = index_path.with_name(
                        f".{index_path.name}.{os.getpid()}.entries.jsonl"
                    )
                    written_entry_count = 0
                    sidecar_bytes = 0
                    with temp_entries_path.open("w", encoding="utf-8") as entries_file:
                        if compatible and unchanged_file_ids:
                            for entry in _iter_vector_index_entries(
                                index_path,
                                existing_index,
                                self._limits.max_vector_index_bytes,
                            ):
                                entry_file_id = entry.get("file_id")
                                if not isinstance(entry_file_id, str):
                                    entry_path = entry.get("path")
                                    entry_file_id = (
                                        str(entry_path) if entry_path is not None else ""
                                    )
                                if entry_file_id in unchanged_file_ids:
                                    sidecar_bytes += _write_vector_entry(entries_file, entry)
                                    written_entry_count += 1
                        if temp_changed_entries is not None:
                            with temp_changed_entries.open(encoding="utf-8") as changed_file:
                                for line in changed_file:
                                    sidecar_bytes += byte_len(line)
                                    entries_file.write(line)
                                    written_entry_count += 1
                    index_document_data["entry_count"] = written_entry_count
                    exact_index_bytes = (
                        byte_len(json.dumps(index_document_data, default=str)) + sidecar_bytes
                    )
                    if exact_index_bytes > self._limits.max_vector_index_bytes:
                        temp_entries_path.unlink(missing_ok=True)
                        if temp_changed_entries is not None:
                            temp_changed_entries.unlink(missing_ok=True)
                        raise ResourceLimitError(
                            "local_vectorize index exceeded limit "
                            f"{self._limits.max_vector_index_bytes} bytes "
                            f"(got {exact_index_bytes} bytes)"
                        )
                    index_path.write_text(
                        json.dumps(index_document_data, default=str),
                        encoding="utf-8",
                    )
                    temp_entries_path.replace(entries_path)
                    chunk_count = written_entry_count
                    if temp_changed_entries is not None:
                        temp_changed_entries.unlink(missing_ok=True)
                if current:
                    output = (
                        f"index current: {chunk_count} chunks from "
                        f"{len(file_records)} files at {index_path}"
                    )
                else:
                    output = (
                        f"indexed {chunk_count} chunks from {len(file_records)} files to "
                        f"{index_path} ({added_files} added, {updated_files} updated, "
                        f"{len(deleted_file_ids)} deleted, {unchanged_files} unchanged)"
                    )
            status = "current" if current else "stale" if op.mode == "validate" else "updated"
            self._log().node(node.node_id, output)
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                data={
                    "message": output,
                    "source_path": str(source_path),
                    "index_path": str(index_path),
                    "mode": op.mode,
                    "current": current,
                    "status": status,
                    "strategy": op.embedding_strategy,
                    "search_strategy": op.search_strategy,
                    "file_count": len(files),
                    "scanned_file_count": len(files),
                    "indexed_file_count": len(file_records),
                    "chunk_count": chunk_count,
                    "index_size_bytes": exact_index_bytes,
                    "last_update_time": last_update_time,
                    "added_files": added_files,
                    "updated_files": updated_files,
                    "unchanged_files": unchanged_files,
                    "deleted_files": len(deleted_file_ids),
                    "stale_files": len(stale_file_ids),
                    "unreadable_files": unreadable_files,
                    "metadata": index_metadata,
                },
            )

        elif op.type == OperationType.LOCAL_SEARCH:
            assert isinstance(op, LocalSearchOperation)
            index_path = _resolve_workflow_path(op.index_path, self._path_base)
            index = _load_vector_index(index_path, self._limits.max_vector_index_bytes)
            if index is None:
                raise FileNotFoundError(index_path)
            index_metadata = index.get("metadata", {})
            if not isinstance(index_metadata, dict):
                index_metadata = {}
            indexed_embedding_strategy = index_metadata.get("embedding_strategy")
            indexed_search_strategy = index_metadata.get("search_strategy")
            strategy = _local_vector_strategy(
                indexed_embedding_strategy
                if isinstance(indexed_embedding_strategy, str)
                else op.embedding_strategy,
                indexed_search_strategy
                if isinstance(indexed_search_strategy, str)
                else op.search_strategy,
            )
            query_vector = strategy.embed(op.query)
            ranked: list[tuple[float, int, dict[str, Any]]] = []
            for entry in index.get("entries", []):
                if not isinstance(entry, dict):
                    continue
                score = strategy.score(query_vector, entry.get("vector", {}))
                entry_chunk = entry.get("chunk", 0)
                chunk_index = (
                    int(entry_chunk) if isinstance(entry_chunk, int | str | float) else 0
                )
                ranked.append((score, chunk_index, entry))
            ranked.sort(
                key=lambda item: (
                    -item[0],
                    str(item[2].get("path", "")),
                    item[1],
                )
            )
            result_limit = max(1, min(op.top_k, self._limits.max_fanout_items))
            results: list[dict[str, object]] = []
            result_text_bytes = 0
            for score, _chunk_index, entry in ranked:
                if len(results) >= result_limit:
                    break
                if score < op.score_threshold:
                    continue
                text = truncate_text_bytes(
                    str(entry.get("text", "")),
                    self._limits.max_file_read_bytes,
                    label="search result text",
                )
                result_text_bytes += byte_len(text)
                if result_text_bytes > self._limits.max_aggregate_read_bytes:
                    raise ResourceLimitError(
                        "local_search results exceeded aggregate limit "
                        f"{self._limits.max_aggregate_read_bytes} bytes"
                    )
                result_item = {
                    "score": round(score, 4),
                    "path": entry.get("path"),
                    "chunk": entry.get("chunk"),
                    "text": text,
                }
                if op.include_snippets:
                    result_item["snippet"] = text
                if op.include_file_metadata:
                    result_metadata = entry.get("metadata")
                    if isinstance(result_metadata, dict):
                        result_item["metadata"] = result_metadata
                    else:
                        result_item["metadata"] = {
                            key: entry.get(key)
                            for key in ("file_name", "file_extension", "parent_path", "directory")
                            if key in entry
                        }
                results.append(result_item)
            output = json.dumps(results, indent=2)
            message = f"local_search returned {len(results)} results from {index_path}"
            require_limit(
                byte_len(output),
                self._limits.max_aggregate_read_bytes,
                "local_search output",
            )
            self._log().node_output(node.node_id, "search results", output)
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=output,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                items=list(results),
                data={
                    "message": message,
                    "index_path": str(index_path),
                    "query": op.query,
                    "top_k": result_limit,
                    "score_threshold": op.score_threshold,
                    "strategy": strategy.search_strategy,
                    "embedding_strategy": (
                        index_metadata.get("embedding_strategy")
                        if index_metadata
                        else "legacy_hash_token"
                    ),
                    "index_metadata": index_metadata,
                    "results": results,
                },
            )

        elif op.type == OperationType.HTTP_REQUEST:
            assert isinstance(op, HttpRequestOperation)
            template_context = self._template_context(node, ctx, graph, loop_item)
            method = str(self._render_http_value(op.method, template_context)).upper()
            url_template = op.url
            url = str(self._render_http_value(url_template, template_context))
            rendered_headers = cast(
                dict[str, object],
                self._render_http_value(op.headers, template_context),
            )
            headers = {key: str(value) for key, value in rendered_headers.items()}
            rendered_params = cast(
                dict[str, object],
                self._render_http_value(op.params, template_context),
            )
            params = {key: str(value) for key, value in rendered_params.items()}
            url = append_query_params(url, params)
            body: bytes | None = None
            rendered_json = self._render_http_value(op.json_payload, template_context)
            rendered_body = self._render_http_value(op.body, template_context)
            if rendered_json is not None:
                body = json.dumps(rendered_json).encode()
                headers.setdefault("Content-Type", "application/json")
            elif rendered_body not in (None, ""):
                body = str(rendered_body).encode()

            configured_secret_fields = {field.lower() for field in op.secret_fields}
            secret_values = (
                _collect_secret_values(op.url)
                | _collect_secret_values(op.headers)
                | _collect_secret_values(op.params)
                | _collect_secret_values(op.json_payload)
                | _collect_secret_values(op.body)
                | _collect_sensitive_template_values(
                    op.url,
                    configured_secret_fields,
                    template_context,
                    "url",
                )
                | _collect_sensitive_template_values(
                    op.headers,
                    configured_secret_fields,
                    template_context,
                )
                | _collect_sensitive_template_values(
                    op.params,
                    configured_secret_fields,
                    template_context,
                )
                | _collect_sensitive_template_values(
                    op.json_payload,
                    configured_secret_fields,
                    template_context,
                )
                | _collect_sensitive_template_values(
                    op.body,
                    configured_secret_fields,
                    template_context,
                    "body",
                )
                | (
                    _collect_leaf_strings(url)
                    if _is_sensitive_field("url", configured_secret_fields)
                    else set()
                )
                | _collect_configured_secret_values(
                    headers,
                    configured_secret_fields,
                )
                | _collect_configured_secret_values(
                    params,
                    configured_secret_fields,
                )
            )
            if rendered_json is not None:
                secret_values.update(
                    _collect_configured_secret_values(
                        rendered_json,
                        configured_secret_fields,
                    )
                )
            elif isinstance(rendered_body, str):
                secret_values.update(
                    _collect_configured_secret_text_values(
                        rendered_body,
                        configured_secret_fields,
                    )
                )
            else:
                secret_values.update(
                    _collect_configured_secret_values(
                        rendered_body,
                        configured_secret_fields,
                    )
                )
            sensitive_query_keys = {
                key.lower()
                for key, value in op.params.items()
                if _secret_reference_names(value)
                or _is_sensitive_field(key, configured_secret_fields)
            }
            url_is_sensitive = bool(_secret_reference_names(url_template)) or _is_sensitive_field(
                "url",
                configured_secret_fields,
            )
            masked_url = _mask_http_url(
                url,
                configured=configured_secret_fields,
                secret_values=secret_values,
                url_sensitive=url_is_sensitive,
                sensitive_query_keys=sensitive_query_keys,
            )
            masked_headers = _mask_http_value(
                headers,
                configured_secret_fields,
                secret_values=secret_values,
            )
            if rendered_json is not None:
                masked_body = _mask_http_value(
                    rendered_json,
                    configured_secret_fields,
                    secret_values=secret_values,
                )
            elif isinstance(rendered_body, str):
                masked_body = _mask_http_text(
                    rendered_body,
                    configured_secret_fields,
                    secret_values=secret_values,
                )
            else:
                masked_body = _mask_http_value(
                    rendered_body,
                    configured_secret_fields,
                    secret_values=secret_values,
                )
            self._log().node(node.node_id, f"http request: {method} {masked_url}")
            self._log().node_output(
                node.node_id,
                "request",
                json.dumps(
                    {"headers": masked_headers, "body": masked_body},
                    default=str,
                    indent=2,
                ),
            )

            attempts = max(1, op.retry.attempts)
            response = None
            last_error: Exception | None = None
            for attempt in range(1, attempts + 1):
                try:
                    response = await self._http_client.send(
                        HttpRequest(
                            method=method,
                            url=url,
                            headers=headers,
                            body=body,
                            timeout_seconds=op.timeout_seconds,
                        )
                    )
                    last_error = None
                except Exception as exc:  # noqa: BLE001
                    last_error = exc
                    response = None
                    masked_error = _replace_known_secrets(str(exc), secret_values)
                    self._log().node(
                        node.node_id,
                        f"http request error on attempt {attempt}: {masked_error}",
                    )
                    if attempt >= attempts:
                        break
                    if op.retry.backoff_seconds > 0:
                        await anyio.sleep(op.retry.backoff_seconds)
                    continue
                should_retry = attempt < attempts and response.status in set(
                    op.retry.retry_on_statuses
                )
                if not should_retry:
                    break
                if op.retry.backoff_seconds > 0:
                    await anyio.sleep(op.retry.backoff_seconds)

            if response is None:
                error_text = "HTTP request did not produce a response"
                if last_error is not None:
                    error_text = (
                        f"HTTP request failed after {attempts} "
                        f"attempt{'s' if attempts != 1 else ''}: {last_error}"
                    )
                error_text = _replace_known_secrets(error_text, secret_values)
                return NodeOutput(
                    node_id=node.node_id,
                    success=False,
                    output=error_text,
                    exit_code=1,
                    duration_seconds=time.monotonic() - start,
                    type=str(op.type),
                    value=error_text,
                    data={
                        "url": masked_url,
                        "method": method,
                        "attempts": attempts,
                        "error": error_text,
                    },
                    error=error_text,
                )
            body_text = response.body.decode("utf-8", errors="replace")
            parsed_json: object | None = None
            json_error: json.JSONDecodeError | None = None
            if op.response_mode in {"auto", "json"} or op.output_mapping:
                try:
                    parsed_json = json.loads(body_text) if body_text else None
                except json.JSONDecodeError as exc:
                    if op.response_mode == "json":
                        json_error = exc
            response_data: dict[str, object] = {
                "status": response.status,
                "headers": response.headers,
                "body": body_text,
                "json": parsed_json,
            }
            selected = self._http_output_mapping(response_data, op.output_mapping)
            masked_response_headers = cast(
                dict[str, object],
                _mask_http_value(
                    response.headers,
                    configured_secret_fields,
                    secret_values=secret_values,
                ),
            )
            masked_json = _mask_http_value(
                parsed_json,
                configured_secret_fields,
                secret_values=secret_values,
            )
            if parsed_json is not None:
                masked_body_text = json.dumps(masked_json, default=str)
            else:
                masked_body_text = _mask_http_text(
                    body_text,
                    configured_secret_fields,
                    secret_values=secret_values,
                )
            masked_response_data: dict[str, object] = {
                "status": response.status,
                "headers": masked_response_headers,
                "body": masked_body_text,
                "json": masked_json,
            }
            masked_selected = self._http_output_mapping(
                masked_response_data,
                op.output_mapping,
            )
            if op.response_mode == "json" and parsed_json is not None:
                output = json.dumps(parsed_json, default=str)
                output_value: object = parsed_json
            elif op.response_mode == "none":
                output = ""
                output_value = None
            else:
                output = body_text
                output_value = body_text
            success = response.status in set(op.expected_statuses) and json_error is None
            error_text = masked_body_text
            if json_error is not None:
                error_text = (
                    f"Invalid JSON response: {json_error.msg} "
                    f"at line {json_error.lineno} column {json_error.colno}; "
                    f"body={masked_body_text}"
                )
            self._log().node(
                node.node_id,
                f"http response: status={response.status} success={success}",
            )
            self._log().node_output(node.node_id, "response body", masked_body_text)
            return NodeOutput(
                node_id=node.node_id,
                success=success,
                output=output,
                exit_code=0 if success else 1,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                value=output_value,
                data={
                    **response_data,
                    "selected": selected,
                    "responsePreview": {
                        **masked_response_data,
                        "selected": masked_selected,
                        "url": masked_url,
                        "method": method,
                    },
                    "url": masked_url,
                    "method": method,
                },
                error=error_text if not success else None,
            )

        elif op.type == OperationType.NOTIFICATION:
            assert isinstance(op, NotificationOperation)
            template_context = self._template_context(node, ctx, graph, loop_item)
            title = str(self._render_http_value(op.title, template_context))
            notification_body = str(self._render_http_value(op.body, template_context))
            notification = Notification(
                title=title,
                body=notification_body,
                channel=op.channel,
                urgency=op.urgency,
            )
            await self._notification_adapter.send(notification)
            self._log().node(node.node_id, f"notification sent: {op.channel}")
            self._log().node_output(node.node_id, "notification body", notification_body)
            return NodeOutput(
                node_id=node.node_id,
                success=True,
                output=notification_body,
                exit_code=0,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                value=notification_body,
                data={
                    "title": title,
                    "body": notification_body,
                    "channel": op.channel,
                    "urgency": op.urgency,
                },
            )

        elif op.type == OperationType.AGENT:
            assert isinstance(op, AgentOperation)
            agent_config = self._workflow.agents.get(op.agent_id)
            if agent_config is None:
                raise ValueError(f"Agent '{op.agent_id}' not registered in workflow")
            sub = self._subscriptions.get(agent_config.subscription)
            if sub is None:
                raise ValueError(f"No subscription for '{agent_config.subscription}'")
            agent_config = self._agent_config_for_operation(
                agent_config,
                op.prompt_path,
                op.working_dir,
            )

            agent_input_ctx: dict[str, object] = {
                k: self._resolve_input_value(node, ctx, graph, v, loop_item)
                for k, v in op.input_mapping.items()
            }
            explicit_inputs = bool(node.inputs)
            agent_input_ctx.update(self._input_context(node, ctx, graph, loop_item))
            if not explicit_inputs:
                stdin = self._resolve_pipe_stdin(node, ctx, graph, loop_item)
                if stdin is not None:
                    agent_input_ctx["_piped_input"] = stdin.decode()

            prompt_override = f"/{op.skill_name.strip().lstrip('/')}" if op.skill_name else None
            if op.fan_source is not None:
                self._log().node(
                    node.node_id,
                    "agent fan_source is deprecated; use a loop node feeding this agent",
                )
            if op.dynamic_count != 1:
                self._log().node(
                    node.node_id,
                    "agent dynamic_count is deprecated; use a loop node feeding this agent",
                )
            if loop_item and not explicit_inputs:
                agent_input_ctx = {**agent_input_ctx, **loop_item}
            try:
                memory = await self._compact_agent_memory_if_needed(
                    node.node_id,
                    op,
                    op.memory,
                    self._agent_memory(node.node_id, op.memory),
                    agent_config,
                    sub,
                )
            except LlmBudgetBlockedError as exc:
                message = str(exc)
                self._log().node(
                    node.node_id,
                    f"LLM budget blocked memory compaction: {message}",
                )
                return NodeOutput(
                    node_id=node.node_id,
                    success=False,
                    output=message,
                    exit_code=1,
                    duration_seconds=time.monotonic() - start,
                    type=str(op.type),
                    data={
                        "inputs": agent_input_ctx,
                        "message": message,
                        "agent_id": op.agent_id,
                        "prompt": prompt_override or "",
                        "thoughts": [],
                        "budget": {
                            "blocked": True,
                            "violations": exc.violations,
                        },
                    },
                    error=message,
                )
            prompt_for_budget = self._agent_prompt_for_budget(
                agent_config,
                agent_input_ctx,
                prompt_override,
                memory,
            )
            (
                budget_violations_before_call,
                usage_reservation,
            ) = await self._reserve_agent_call(
                node.node_id,
                op,
                prompt_for_budget,
            )
            if budget_violations_before_call:
                message = "; ".join(budget_violations_before_call)
                self._log().node(node.node_id, f"LLM budget blocked provider call: {message}")
                return NodeOutput(
                    node_id=node.node_id,
                    success=False,
                    output=message,
                    exit_code=1,
                    duration_seconds=time.monotonic() - start,
                    type=str(op.type),
                    data={
                        "inputs": agent_input_ctx,
                        "message": message,
                        "agent_id": op.agent_id,
                        "prompt": prompt_for_budget,
                        "thoughts": [],
                        "budget": {
                            "blocked": True,
                            "violations": budget_violations_before_call,
                        },
                    },
                    error=message,
                )
            agent_timeout = await self._remaining_agent_time_timeout(node.node_id, op)
            result = await Agent(agent_config, sub).run(
                agent_input_ctx,
                cancel_event=self._cancel_event if self._pass_cancel_event else None,
                prompt_override=prompt_override,
                memory=memory,
                max_output_bytes=self._limits.max_subprocess_output_bytes,
                timeout=agent_timeout,
            )
            self._log_agent_result(node.node_id, result)
            self._remember_agent_result(node.node_id, op.memory, result)
            usage = usage_from_metadata(
                provider=result.provider or agent_config.subscription,
                profile=result.profile or agent_config.profile,
                model=result.model or agent_config.model,
                prompt=result.prompt or "",
                output=result.output,
                duration_seconds=result.duration_seconds,
                pricing=agent_config.pricing,
                metadata=result.usage_metadata,
            )
            budget_violations_after_call = await self._record_agent_usage(
                node.node_id,
                op,
                usage,
                usage_reservation,
            )
            if budget_violations_after_call:
                self._log().node(
                    node.node_id,
                    "LLM budget exceeded: " + "; ".join(budget_violations_after_call),
                )
            result_output = result.output
            result_message = result.message if result.message is not None else result.output
            success = result.success and not budget_violations_after_call
            if budget_violations_after_call:
                result_output = "; ".join(budget_violations_after_call)
                result_message = result_output
            return NodeOutput(
                node_id=node.node_id,
                success=success,
                output=result_output,
                exit_code=result.exit_code if success else 1,
                duration_seconds=time.monotonic() - start,
                type=str(op.type),
                data={
                    "inputs": agent_input_ctx,
                    "message": result_message,
                    "agent_id": op.agent_id,
                    "prompt": result.prompt or "",
                    "thoughts": [
                        self._bounded_agent_thought(node.node_id, thought)
                        for thought in result.thoughts
                    ],
                    "usage": usage.model_dump(),
                    "budget": {
                        "violations": budget_violations_after_call,
                        "workflow_totals": self._llm_usage_totals.to_dict(),
                        "node_totals": self._node_llm_usage_totals[
                            node.node_id
                        ].to_dict(),
                    },
                },
                error=result_output if not success else None,
            )

        raise ValueError(f"Unknown operation type: {op.type}")

    def _bounded_agent_thought(self, node_id: str, value: str) -> str:
        return truncate_text_bytes(
            value,
            self._limits.max_log_message_bytes,
            f"{node_id} AGENT_THOUGHT",
        )

    def _stop_requested(self) -> bool:
        return bool(
            (self._cancel_event and self._cancel_event.is_set())
            or (self._stop_file and self._stop_file.exists())
            or (self._run_stop_file and self._run_stop_file.exists())
        )

    def _failure_reason(self, outputs: dict[str, NodeOutput]) -> str:
        for node_id, output in outputs.items():
            if not output.success:
                if output.type == str(OperationType.HTTP_REQUEST):
                    detail = (output.error or "").strip()
                    if not detail:
                        preview = output.data.get("responsePreview")
                        if isinstance(preview, dict):
                            preview_body = preview.get("body")
                            if isinstance(preview_body, str):
                                detail = preview_body.strip()
                else:
                    detail = ""
                if not detail:
                    detail = output.output.strip() or f"exit code {output.exit_code}"
                return f"node {node_id} failed: {detail}"
        return "workflow halted before all nodes completed"
