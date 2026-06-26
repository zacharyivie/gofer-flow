from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel


class ResourceLimitError(ValueError):
    """Raised when workflow-controlled input exceeds a configured resource limit."""


class ResourceLimits(BaseModel):
    max_fanout_items: int = 1000
    max_files_scanned: int = 5000
    max_file_read_bytes: int = 1_048_576
    max_aggregate_read_bytes: int = 32_000_000
    max_vector_index_bytes: int = 50_000_000
    max_log_message_bytes: int = 1_000
    max_log_bytes_per_node: int = 1_048_576
    max_log_bytes_per_run: int = 20_000_000
    max_api_request_body_bytes: int = 1_048_576
    max_api_log_response_bytes: int = 1_048_576
    max_chat_prompt_bytes: int = 128_000
    max_subprocess_output_bytes: int = 2_000_000
    max_watcher_queue_depth: int = 1000
    max_watcher_concurrency: int = 2
    max_fanout_concurrency: int = 1


DEFAULT_RESOURCE_LIMITS = ResourceLimits()


def byte_len(value: str) -> int:
    return len(value.encode("utf-8", errors="replace"))


def require_limit(actual: int, limit: int, label: str) -> None:
    if actual > limit:
        raise ResourceLimitError(f"{label} exceeded limit {limit} bytes (got {actual} bytes)")


def read_text_limited(
    path: Path,
    *,
    encoding: str = "utf-8",
    errors: str = "strict",
    max_bytes: int,
) -> str:
    size = path.stat().st_size
    require_limit(size, max_bytes, f"{path} size")
    return path.read_text(encoding=encoding, errors=errors)


def truncate_text_bytes(value: str, max_bytes: int, label: str = "content") -> str:
    encoded = value.encode("utf-8", errors="replace")
    if len(encoded) <= max_bytes:
        return value
    if max_bytes <= 0:
        return f"[{label} truncated; limit 0 bytes]"
    suffix = f"\n[{label} truncated at {max_bytes} bytes]".encode()
    head_size = max(0, max_bytes - len(suffix))
    truncated = encoded[:head_size] + suffix
    return truncated[:max_bytes].decode("utf-8", errors="replace")


def tail_text_file(path: Path, max_bytes: int) -> tuple[str, bool]:
    size = path.stat().st_size
    with path.open("rb") as fh:
        if size > max_bytes:
            fh.seek(max(0, size - max_bytes))
            data = fh.read(max_bytes)
            return data.decode("utf-8", errors="replace"), True
        return fh.read().decode("utf-8", errors="replace"), False


def read_text_file_range(path: Path, *, offset: int = 0, max_bytes: int) -> tuple[str, int, int]:
    size = path.stat().st_size
    start = max(0, min(offset, size))
    length = max(0, max_bytes)
    with path.open("rb") as fh:
        fh.seek(start)
        data = fh.read(length)
    end = start + len(data)
    return data.decode("utf-8", errors="replace"), start, end
