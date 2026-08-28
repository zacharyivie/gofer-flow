from __future__ import annotations

import json
import re
from typing import Any

MAX_THOUGHT_SUMMARY_CHARS = 500


def summarize_thought(value: object, *, max_chars: int = MAX_THOUGHT_SUMMARY_CHARS) -> str:
    """Return a bounded summary excerpt for provider trace output."""
    if value is None:
        return ""
    if isinstance(value, dict):
        return _truncate_clean(_summarize_mapping(value), max_chars)
    text = str(value)
    stripped = text.strip()
    if not stripped:
        return ""

    parsed = _parse_json(stripped)
    if isinstance(parsed, dict):
        return _truncate_clean(_summarize_mapping(parsed), max_chars)
    if isinstance(parsed, list):
        return _truncate_clean(f"Structured trace list with {len(parsed)} items", max_chars)

    return _truncate_clean(_summarize_text(stripped), max_chars)


def _summarize_mapping(payload: dict[str, Any]) -> str:
    payload_type = _string(payload.get("type"))
    if payload_type:
        item = payload.get("item")
        if isinstance(item, dict):
            item_summary = _summarize_mapping(item)
            if payload_type.startswith("item."):
                return item_summary
            return f"{_humanize(payload_type)}: {item_summary}"

        message = payload.get("message")
        if isinstance(message, dict):
            text = _message_text(message)
            if text:
                return f"{_humanize(payload_type)}: {_summarize_text(text)}"
        elif isinstance(message, str) and message:
            return f"{_humanize(payload_type)}: {_summarize_text(message)}"

        result = payload.get("result")
        if isinstance(result, str) and result:
            return f"{_humanize(payload_type)}: {_summarize_text(result)}"

        return _humanize(payload_type)

    item_type = _string(payload.get("type") or payload.get("name"))
    if item_type:
        text = _string(payload.get("text") or payload.get("summary") or payload.get("command"))
        if text:
            return f"{_humanize(item_type)}: {_summarize_text(text)}"

    data = payload.get("data")
    if isinstance(data, dict):
        message = _string(data.get("message"))
        if message:
            return _summarize_text(message)

    keys = ", ".join(str(key) for key in list(payload)[:4])
    suffix = "" if len(payload) <= 4 else f", +{len(payload) - 4} more"
    return f"Structured trace object ({keys}{suffix})"


def _summarize_text(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return ""
    first = lines[0]
    if first.startswith("Chunk ID:") and len(lines) > 1:
        output_lines = _process_output_lines(lines)
        if output_lines:
            return "Process output:\n" + "\n".join(output_lines)
        return "Process output received"
    return "\n".join(lines)


def _message_text(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            text = item.get("text")
            if isinstance(text, str) and text:
                parts.append(text)
        return "\n".join(parts)
    return ""


def _process_output_lines(lines: list[str]) -> list[str]:
    if "Output:" in lines:
        return lines[lines.index("Output:") + 1 :]
    skipped_prefixes = (
        "Chunk ID:",
        "Wall time:",
        "Process exited",
        "Original token count:",
        "Warning: truncated output",
    )
    return [line for line in lines if line != "Output:" and not line.startswith(skipped_prefixes)]


def _parse_json(text: str) -> object | None:
    if not text or text[0] not in "{[":
        return None
    try:
        parsed: object = json.loads(text)
        return parsed
    except json.JSONDecodeError:
        return None


def _truncate_clean(value: str, max_chars: int) -> str:
    text = _normalize_excerpt(value)
    if max_chars <= 0:
        return ""
    if len(text) <= max_chars:
        return text

    limit = max(1, max_chars - 1)
    candidate = text[:limit].rstrip()
    minimum_clean_break = max(20, int(limit * 0.25))
    break_at = _clean_break_index(candidate, minimum_clean_break)
    if break_at is not None:
        candidate = candidate[:break_at].rstrip()
    return f"{candidate}…"


def _normalize_excerpt(value: str) -> str:
    lines = [line.strip() for line in value.strip().splitlines()]
    compacted: list[str] = []
    previous_blank = False
    for line in lines:
        if not line:
            if not previous_blank and compacted:
                compacted.append("")
            previous_blank = True
            continue
        compacted.append(" ".join(line.split()))
        previous_blank = False
    return "\n".join(compacted).strip()


def _clean_break_index(candidate: str, minimum: int) -> int | None:
    line_break = candidate.rfind("\n")
    if line_break >= minimum:
        return line_break

    sentence_match = None
    for match in re.finditer(r"[.!?](?:\s|$)", candidate):
        if match.end() >= minimum:
            sentence_match = match
    if sentence_match is not None:
        return sentence_match.end()

    word_break = candidate.rfind(" ")
    if word_break >= minimum:
        return word_break
    return None


def _humanize(value: str) -> str:
    cleaned = value.replace("_", " ").replace(".", " ").replace("-", " ").strip()
    return cleaned[:1].upper() + cleaned[1:] if cleaned else "Trace"


def _string(value: object) -> str:
    return value if isinstance(value, str) else ""
