from __future__ import annotations

from gofer.core.thoughts import summarize_thought


def test_summarize_thought_keeps_short_multiline_excerpt() -> None:
    assert summarize_thought("Read file A.\nChecked file B.") == "Read file A.\nChecked file B."


def test_summarize_thought_prefers_sentence_break_before_limit() -> None:
    value = "First sentence has enough useful context. " + ("second " * 100)

    summary = summarize_thought(value, max_chars=80)

    assert summary == "First sentence has enough useful context.…"


def test_summarize_thought_prefers_line_break_before_limit() -> None:
    value = "Line one has enough useful context.\n" + ("line two " * 100)

    summary = summarize_thought(value, max_chars=80)

    assert summary == "Line one has enough useful context.…"


def test_summarize_thought_excerpts_large_process_output() -> None:
    value = "\n".join(
        [
            "Chunk ID: abc123",
            "Wall time: 0.1 seconds",
            "Process exited with code 0",
            "Original token count: 99999",
            "Output:",
            "src/gofer/core/executor.py:10: first useful line",
            "src/gofer/ui/chat.py:20: second useful line",
            "src/gofer/core/agent.py:30: third useful line",
        ]
    )

    summary = summarize_thought(value, max_chars=90)

    assert summary.startswith("Process output:\nsrc/gofer/core/executor.py:10")
    assert "Chunk ID" not in summary
    assert "Large process output received" not in summary
