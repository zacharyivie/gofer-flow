from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel


class LlmPricing(BaseModel):
    input_cost_per_1k_tokens: float = 0.0
    output_cost_per_1k_tokens: float = 0.0
    chars_per_token: float = 4.0


class LlmUsageBudget(BaseModel):
    max_agent_calls: int | None = None
    max_estimated_tokens: int | None = None
    max_estimated_cost: float | None = None
    max_agent_time_seconds: float | None = None

    def enabled(self) -> bool:
        return any(
            value is not None
            for value in (
                self.max_agent_calls,
                self.max_estimated_tokens,
                self.max_estimated_cost,
                self.max_agent_time_seconds,
            )
        )


class LlmUsageEstimate(BaseModel):
    provider: str
    profile: str | None = None
    model: str | None = None
    prompt_length: int
    output_length: int
    input_tokens: int
    output_tokens: int
    total_tokens: int
    estimated_cost: float
    duration_seconds: float
    estimated: bool = True
    source: str = "fallback_chars_per_token"


@dataclass
class LlmUsageTotals:
    agent_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    estimated_cost: float = 0.0
    agent_time_seconds: float = 0.0

    def add(self, usage: LlmUsageEstimate) -> None:
        self.input_tokens += usage.input_tokens
        self.output_tokens += usage.output_tokens
        self.total_tokens += usage.total_tokens
        self.estimated_cost += usage.estimated_cost
        self.agent_time_seconds += usage.duration_seconds

    def subtract(self, usage: LlmUsageEstimate) -> None:
        self.input_tokens -= usage.input_tokens
        self.output_tokens -= usage.output_tokens
        self.total_tokens -= usage.total_tokens
        self.estimated_cost -= usage.estimated_cost
        self.agent_time_seconds -= usage.duration_seconds

    def to_dict(self) -> dict[str, object]:
        return {
            "agent_calls": self.agent_calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_tokens": self.total_tokens,
            "estimated_cost": self.estimated_cost,
            "agent_time_seconds": self.agent_time_seconds,
        }


def estimate_tokens(text: str | None, pricing: LlmPricing | None = None) -> int:
    if not text:
        return 0
    chars_per_token = (pricing or LlmPricing()).chars_per_token
    if chars_per_token <= 0:
        chars_per_token = 4.0
    return max(1, math.ceil(len(text) / chars_per_token))


def usage_from_metadata(
    *,
    provider: str,
    profile: str | None,
    model: str | None,
    prompt: str | None,
    output: str | None,
    duration_seconds: float,
    pricing: LlmPricing | None = None,
    metadata: dict[str, Any] | None = None,
) -> LlmUsageEstimate:
    metadata = metadata or {}
    source = str(metadata.get("source") or "fallback_chars_per_token")
    exact_input = _int_metadata(
        metadata,
        "input_tokens",
        "inputTokens",
        "prompt_tokens",
        "promptTokens",
        "total_input_tokens",
        "totalInputTokens",
    )
    exact_output = _int_metadata(
        metadata,
        "output_tokens",
        "outputTokens",
        "completion_tokens",
        "completionTokens",
        "total_output_tokens",
        "totalOutputTokens",
    )
    exact_total = _int_metadata(metadata, "total_tokens", "totalTokens")
    input_tokens = exact_input if exact_input is not None else estimate_tokens(prompt, pricing)
    output_tokens = exact_output if exact_output is not None else estimate_tokens(output, pricing)
    total_tokens = exact_total if exact_total is not None else input_tokens + output_tokens
    token_counts_estimated = not (exact_input is not None and exact_output is not None)
    cost = _float_metadata(
        metadata,
        "cost",
        "cost_usd",
        "estimated_cost",
        "estimatedCost",
        "total_cost_usd",
        "totalCostUsd",
        "total_cost",
        "totalCost",
    )
    cost_estimated = cost is None
    if cost is None:
        effective_pricing = pricing or LlmPricing()
        cost = (
            input_tokens * effective_pricing.input_cost_per_1k_tokens
            + output_tokens * effective_pricing.output_cost_per_1k_tokens
        ) / 1000
    estimated = bool(metadata.get("estimated", False)) or token_counts_estimated or cost_estimated
    if estimated and source == "provider_metadata":
        source = "provider_metadata_with_estimates"
    elif estimated:
        source = "fallback_chars_per_token"
    return LlmUsageEstimate(
        provider=str(metadata.get("provider") or provider),
        profile=_str_metadata(metadata, "profile") or profile,
        model=_str_metadata(metadata, "model") or model,
        prompt_length=len(prompt or ""),
        output_length=len(output or ""),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        estimated_cost=cost,
        duration_seconds=duration_seconds,
        estimated=estimated,
        source=source,
    )


def budget_violations(
    totals: LlmUsageTotals,
    budget: LlmUsageBudget | None,
    *,
    scope: str,
) -> list[str]:
    if budget is None:
        return []
    violations = []
    if budget.max_agent_calls is not None and totals.agent_calls > budget.max_agent_calls:
        violations.append(
            f"{scope} max_agent_calls exceeded "
            f"({totals.agent_calls} > {budget.max_agent_calls})"
        )
    if (
        budget.max_estimated_tokens is not None
        and totals.total_tokens > budget.max_estimated_tokens
    ):
        violations.append(
            f"{scope} max_estimated_tokens exceeded "
            f"({totals.total_tokens} > {budget.max_estimated_tokens})"
        )
    if (
        budget.max_estimated_cost is not None
        and totals.estimated_cost > budget.max_estimated_cost
    ):
        violations.append(
            f"{scope} max_estimated_cost exceeded "
            f"({totals.estimated_cost:.6f} > {budget.max_estimated_cost:.6f})"
        )
    if (
        budget.max_agent_time_seconds is not None
        and totals.agent_time_seconds > budget.max_agent_time_seconds
    ):
        violations.append(
            f"{scope} max_agent_time_seconds exceeded "
            f"({totals.agent_time_seconds:.2f} > {budget.max_agent_time_seconds:.2f})"
        )
    return violations


def summarize_node_outputs(
    node_outputs: dict[str, Any],
    node_runs: dict[str, list[Any]] | None = None,
) -> dict[str, object]:
    totals = LlmUsageTotals()
    nodes: list[dict[str, object]] = []
    outputs: list[tuple[str, Any]] = []
    if node_runs is None:
        outputs = list(node_outputs.items())
    else:
        for node_id, runs in node_runs.items():
            outputs.extend((node_id, output) for output in runs)
        for node_id, output in node_outputs.items():
            if node_id not in node_runs:
                outputs.append((node_id, output))

    for node_id, output in outputs:
        data = output.get("data") if isinstance(output, dict) else getattr(output, "data", {})
        if not isinstance(data, dict):
            continue
        budget = data.get("budget")
        budget_violations_ = (
            budget.get("violations", []) if isinstance(budget, dict) else []
        )
        usage = data.get("usage")
        if not isinstance(usage, dict):
            if budget_violations_:
                nodes.append({
                    "node_id": node_id,
                    "agent_id": data.get("agent_id"),
                    "provider": None,
                    "profile": None,
                    "model": None,
                    "prompt_length": 0,
                    "output_length": 0,
                    "total_tokens": 0,
                    "estimated_cost": 0.0,
                    "duration_seconds": 0.0,
                    "estimated": True,
                    "source": None,
                    "budget_violations": budget_violations_,
                })
            continue
        total_tokens = int(usage.get("total_tokens") or usage.get("totalTokens") or 0)
        input_tokens = int(usage.get("input_tokens") or usage.get("inputTokens") or 0)
        output_tokens = int(usage.get("output_tokens") or usage.get("outputTokens") or 0)
        prompt_length = int(usage.get("prompt_length") or usage.get("promptLength") or 0)
        output_length = int(usage.get("output_length") or usage.get("outputLength") or 0)
        cost = float(usage.get("estimated_cost") or usage.get("estimatedCost") or 0.0)
        duration = float(usage.get("duration_seconds") or usage.get("durationSeconds") or 0.0)
        totals.agent_calls += 1
        totals.input_tokens += input_tokens
        totals.output_tokens += output_tokens
        totals.total_tokens += total_tokens
        totals.estimated_cost += cost
        totals.agent_time_seconds += duration
        nodes.append({
            "node_id": node_id,
            "agent_id": data.get("agent_id"),
            "provider": usage.get("provider"),
            "profile": usage.get("profile"),
            "model": usage.get("model"),
            "prompt_length": prompt_length,
            "output_length": output_length,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens,
            "estimated_cost": cost,
            "duration_seconds": duration,
            "estimated": usage.get("estimated", True),
            "source": usage.get("source"),
            "budget_violations": budget_violations_,
        })
    return {
        "totals": totals.to_dict(),
        "nodes": nodes,
        "most_expensive_nodes": sorted(nodes, key=_node_cost, reverse=True)[:5],
        "slowest_nodes": sorted(nodes, key=_node_duration, reverse=True)[:5],
        "budget_failures": [
            node for node in nodes if node.get("budget_violations")
        ],
    }


def _int_metadata(metadata: dict[str, Any], *keys: str) -> int | None:
    for key in keys:
        value = metadata.get(key)
        if value is not None:
            return int(value)
    return None


def _node_cost(node: dict[str, object]) -> float:
    value = node.get("estimated_cost")
    return float(value) if isinstance(value, int | float | str) else 0.0


def _node_duration(node: dict[str, object]) -> float:
    value = node.get("duration_seconds")
    return float(value) if isinstance(value, int | float | str) else 0.0


def _float_metadata(metadata: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = metadata.get(key)
        if value is not None:
            return float(value)
    return None


def _str_metadata(metadata: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = metadata.get(key)
        if value is not None:
            return str(value)
    return None
