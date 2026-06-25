from __future__ import annotations

import pytest

from gofer.core.usage import LlmPricing, usage_from_metadata


def test_usage_from_metadata_accepts_camel_case_token_totals() -> None:
    usage = usage_from_metadata(
        provider="codex",
        profile=None,
        model=None,
        prompt="hello world",
        output="done",
        duration_seconds=1.5,
        metadata={
            "inputTokens": 10,
            "outputTokens": 5,
            "totalTokens": 15,
            "totalCostUsd": "0.0042",
            "source": "provider_metadata",
        },
    )

    assert usage.input_tokens == 10
    assert usage.output_tokens == 5
    assert usage.total_tokens == 15
    assert usage.estimated_cost == pytest.approx(0.0042)
    assert usage.estimated is False
    assert usage.source == "provider_metadata"


def test_usage_from_metadata_marks_local_cost_as_estimated_with_provider_tokens() -> None:
    usage = usage_from_metadata(
        provider="claude_code",
        profile=None,
        model="claude-sonnet",
        prompt="hello world",
        output="done",
        duration_seconds=2.0,
        pricing=LlmPricing(
            input_cost_per_1k_tokens=1.0,
            output_cost_per_1k_tokens=2.0,
        ),
        metadata={
            "input_tokens": 10,
            "output_tokens": 5,
            "total_tokens": 15,
            "source": "provider_metadata",
        },
    )

    assert usage.estimated_cost == pytest.approx(0.02)
    assert usage.estimated is True
    assert usage.source == "provider_metadata_with_estimates"


def test_usage_from_metadata_uses_provider_total_tokens_without_exact_split() -> None:
    usage = usage_from_metadata(
        provider="codex",
        profile=None,
        model=None,
        prompt="hello world",
        output="done",
        duration_seconds=1.0,
        metadata={
            "totalTokens": 42,
            "source": "provider_metadata",
        },
    )

    assert usage.total_tokens == 42
    assert usage.estimated is True
    assert usage.source == "provider_metadata_with_estimates"
