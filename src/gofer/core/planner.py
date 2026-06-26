from __future__ import annotations

import csv
import json
import os
import re
import shutil
import urllib.parse
from pathlib import Path
from typing import Any

from gofer.core.agent import configured_extra_paths
from gofer.core.graph import EdgeConditionType, GraphNode
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
from gofer.core.provider_profiles import (
    resolve_provider_settings,
    unresolved_provider_secret_refs,
    validate_provider_settings,
)
from gofer.core.resources import DEFAULT_RESOURCE_LIMITS, ResourceLimits
from gofer.core.usage import LlmUsageBudget, LlmUsageTotals, budget_violations, estimate_tokens
from gofer.core.workflow import AgenticWorkflow

SAMPLE_LIMIT = 5
SECRET_REF_PATTERN = re.compile(
    r"^\{\{\s*secret\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$"
    r"|^secret:([A-Za-z_][A-Za-z0-9_]*)$"
)
SECRET_INTERPOLATION_PATTERN = re.compile(r"\{\{\s*secret\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
SENSITIVE_FIELD_NAMES = {
    "authorization",
    "cookie",
    "x-api-key",
    "api-key",
    "token",
    "password",
    "secret",
}


def build_execution_plan(
    workflow: AgenticWorkflow,
    *,
    workflow_path: Path | None = None,
    data_dir: Path | None = None,
    trigger_context: dict[str, Any] | None = None,
    sample_limit: int = SAMPLE_LIMIT,
) -> dict[str, Any]:
    """Build a read-only preview of workflow execution impact."""
    limits = workflow.config.resource_limits or DEFAULT_RESOURCE_LIMITS
    path_base = workflow_path.parent if workflow_path is not None else None
    profile_data_dir = data_dir if data_dir is not None else path_base
    warnings = workflow.resource_warnings(path_base)
    plan: dict[str, Any] = {
        "workflowId": workflow.config.id,
        "workflowName": workflow.config.name,
        "generations": [],
        "edges": _edge_plan(workflow),
        "warnings": warnings,
        "destructiveActions": [],
        "destructiveActionDetails": [],
        "requiredSecrets": [],
        "providerRequirements": [],
        "projectedLlmUsage": LlmUsageTotals().to_dict(),
        "triggerContext": _trigger_plan(workflow, trigger_context, path_base),
        "unresolvedDynamicValues": [],
    }
    if path_base is not None:
        plan["pathResolutionBase"] = str(path_base)

    secret_names: set[str] = set()
    provider_keys: dict[
        tuple[str, str, str | None, str | None, float | None, str, str | None, bool],
        set[str],
    ] = {}
    dynamic_values: set[str] = set()
    fan_out_multipliers: dict[str, int] = {}

    for generation_index, generation in enumerate(workflow.graph.topological_generations()):
        planned_nodes = []
        for node in generation:
            inherited_fan_out = _inherited_fan_out_multiplier(
                workflow,
                node.node_id,
                fan_out_multipliers,
            )
            node_plan = _node_plan(
                workflow,
                node,
                limits=limits,
                path_base=path_base,
                data_dir=profile_data_dir,
                trigger_context=trigger_context or {},
                sample_limit=sample_limit,
                inherited_fan_out=inherited_fan_out,
            )
            planned_nodes.append(node_plan)
            plan["destructiveActions"].extend(node_plan["destructiveActions"])
            plan["destructiveActionDetails"].extend(
                node_plan["destructiveActionDetails"]
            )
            plan["warnings"].extend(node_plan["warnings"])
            projected_usage = node_plan.get("projectedLlmUsage")
            if isinstance(projected_usage, dict):
                plan["projectedLlmUsage"]["agent_calls"] += int(
                    projected_usage.get("agent_calls") or 0
                )
                plan["projectedLlmUsage"]["input_tokens"] += int(
                    projected_usage.get("input_tokens") or 0
                )
                plan["projectedLlmUsage"]["output_tokens"] += int(
                    projected_usage.get("output_tokens") or 0
                )
                plan["projectedLlmUsage"]["total_tokens"] += int(
                    projected_usage.get("total_tokens") or 0
                )
                plan["projectedLlmUsage"]["estimated_cost"] += float(
                    projected_usage.get("estimated_cost") or 0.0
                )
                plan["projectedLlmUsage"]["agent_time_seconds"] += float(
                    projected_usage.get("agent_time_seconds") or 0.0
                )
            for secret in node_plan["requiredSecrets"]:
                secret_names.add(secret)
            for requirement in node_plan["providerRequirements"]:
                key = (
                    str(requirement["agentId"]),
                    str(requirement["subscription"]),
                    (
                        str(requirement["profile"])
                        if requirement.get("profile") is not None
                        else None
                    ),
                    (
                        str(requirement["model"])
                        if requirement.get("model") is not None
                        else None
                    ),
                    (
                        float(requirement["timeout"])
                        if requirement.get("timeout") is not None
                        else None
                    ),
                    str(requirement["workingDir"]),
                    (
                        str(requirement["binary"])
                        if requirement.get("binary") is not None
                        else None
                    ),
                    bool(requirement["available"]),
                )
                provider_keys.setdefault(key, set()).update(
                    str(path) for path in requirement.get("extraPaths", [])
                )
            dynamic_values.update(node_plan["unresolvedDynamicValues"])
            fan_out_multipliers[node.node_id] = _successor_fan_out_multiplier(
                inherited_fan_out,
                node_plan.get("fanOut"),
            )
        plan["generations"].append({
            "index": generation_index,
            "nodes": planned_nodes,
        })

    plan["warnings"] = sorted(set(plan["warnings"]))
    plan["destructiveActions"] = sorted(set(plan["destructiveActions"]))
    plan["destructiveActionDetails"] = _dedupe_details(
        plan["destructiveActionDetails"]
    )
    plan["requiredSecrets"] = sorted(secret_names)
    plan["providerRequirements"] = []
    for (
        agent_id,
        subscription,
        profile,
        model,
        timeout,
        working_dir,
        binary,
        available,
    ), extra_paths in sorted(provider_keys.items()):
        provider_requirement: dict[str, Any] = {
            "agentId": agent_id,
            "subscription": subscription,
            "workingDir": working_dir,
            "binary": binary,
            "available": available,
            "extraPaths": sorted(extra_paths),
        }
        if profile is not None:
            provider_requirement["profile"] = profile
        if model is not None:
            provider_requirement["model"] = model
        if timeout is not None:
            provider_requirement["timeout"] = timeout
        plan["providerRequirements"].append(provider_requirement)
    plan["unresolvedDynamicValues"] = sorted(dynamic_values)
    budget = workflow.config.llm_budget
    usage = plan["projectedLlmUsage"]
    if budget.max_agent_calls is not None and usage["agent_calls"] > budget.max_agent_calls:
        plan["warnings"].append(
            "Projected LLM usage exceeds workflow max_agent_calls "
            f"({usage['agent_calls']} > {budget.max_agent_calls})"
        )
    if (
        budget.max_estimated_tokens is not None
        and usage["total_tokens"] > budget.max_estimated_tokens
    ):
        plan["warnings"].append(
            "Projected LLM usage exceeds workflow max_estimated_tokens "
            f"({usage['total_tokens']} > {budget.max_estimated_tokens})"
        )
    if (
        budget.max_estimated_cost is not None
        and usage["estimated_cost"] > budget.max_estimated_cost
    ):
        plan["warnings"].append(
            "Projected LLM usage exceeds workflow max_estimated_cost "
            f"({usage['estimated_cost']:.6f} > {budget.max_estimated_cost:.6f})"
        )
    if (
        budget.max_agent_time_seconds is not None
        and usage["agent_time_seconds"] > budget.max_agent_time_seconds
    ):
        plan["warnings"].append(
            "Projected LLM usage exceeds workflow max_agent_time_seconds "
            f"({usage['agent_time_seconds']:.2f} > "
            f"{budget.max_agent_time_seconds:.2f})"
        )
    plan["warnings"] = sorted(set(plan["warnings"]))
    return plan


def _edge_plan(workflow: AgenticWorkflow) -> list[dict[str, Any]]:
    edges = []
    for from_id, to_id in workflow.graph._graph.edges():
        edge = workflow.graph.get_edge_config(from_id, to_id)
        label = edge.condition.value
        if edge.condition == EdgeConditionType.OUTPUT_MATCHES and edge.output_pattern:
            label = f"output_matches:{edge.output_pattern}"
        edges.append({
            "from": from_id,
            "to": to_id,
            "condition": edge.condition.value,
            "label": label,
            "outputPattern": edge.output_pattern,
        })
    return edges


def _inherited_fan_out_multiplier(
    workflow: AgenticWorkflow,
    node_id: str,
    fan_out_multipliers: dict[str, int],
) -> int:
    multiplier = 1
    for predecessor_id in workflow.graph._graph.predecessors(node_id):
        edge = workflow.graph.get_edge_config(predecessor_id, node_id)
        if edge.condition == EdgeConditionType.AFTER_LOOP:
            continue
        multiplier = max(multiplier, fan_out_multipliers.get(predecessor_id, 1))
    return multiplier


def _successor_fan_out_multiplier(
    inherited_fan_out: int,
    fan_out: object,
) -> int:
    if not isinstance(fan_out, dict):
        return inherited_fan_out
    count = fan_out.get("count")
    if not isinstance(count, int):
        return inherited_fan_out
    return inherited_fan_out * max(0, count)


def _trigger_plan(
    workflow: AgenticWorkflow,
    trigger_context: dict[str, Any] | None,
    path_base: Path | None,
) -> dict[str, Any]:
    plan: dict[str, Any] = {}
    if workflow.config.schedule is not None:
        plan["schedule"] = workflow.config.schedule.model_dump()
    if workflow.config.watch is not None:
        watch_path = _resolve_path(workflow.config.watch.path, path_base)
        plan["watch"] = {
            **workflow.config.watch.model_dump(),
            "path": str(watch_path),
        }
    if workflow.config.run_continuously:
        plan["runContinuously"] = True
    if trigger_context:
        plan["provided"] = trigger_context
    return plan


def _node_plan(
    workflow: AgenticWorkflow,
    node: GraphNode,
    *,
    limits: ResourceLimits,
    path_base: Path | None,
    data_dir: Path | None,
    trigger_context: dict[str, Any],
    sample_limit: int,
    inherited_fan_out: int = 1,
) -> dict[str, Any]:
    op = node.operation
    detail = _operation_detail(workflow, node, path_base)
    (
        side_effects,
        side_effect_details,
        destructive_actions,
        destructive_action_details,
        warnings,
    ) = _operation_impact(op, path_base)
    warnings.extend(_agent_registration_warnings(op, workflow))
    fan_out = _fan_out_plan(op, trigger_context, limits, sample_limit, path_base)
    if fan_out is not None:
        warnings.extend(str(warning) for warning in fan_out.get("warnings", []))
    required_secrets = _required_secrets(op, workflow, path_base, data_dir)
    provider_requirements = _provider_requirements(op, workflow, path_base, data_dir)
    projected_llm_usage = _projected_llm_usage(
        op,
        workflow,
        fan_out,
        path_base,
        node.node_id,
        inherited_fan_out,
    )
    if projected_llm_usage is not None and isinstance(
        op,
        (AgentOperation, CommonLlmTaskOperation),
    ):
        warnings.extend(
            _projected_budget_warnings(
                projected_llm_usage,
                op.llm_budget,
                scope=f"node '{node.node_id}' LLM budget",
            )
        )
    for requirement in provider_requirements:
        for error in requirement.get("validationErrors", []):
            warnings.append(str(error))
        if not requirement.get("available"):
            binary = requirement.get("binary") or requirement["subscription"]
            warnings.append(
                f"Provider CLI '{binary}' is not available for agent "
                f"{requirement['agentId']}"
            )
    unresolved = _unresolved_values(node, workflow)

    return {
        "id": node.node_id,
        "label": node.label or node.node_id,
        "type": str(op.type),
        "detail": detail,
        "sideEffects": side_effects,
        "sideEffectDetails": side_effect_details,
        "destructiveActions": destructive_actions,
        "destructiveActionDetails": destructive_action_details,
        "warnings": warnings,
        "fanOut": fan_out,
        "requiredSecrets": required_secrets,
        "providerRequirements": provider_requirements,
        "projectedLlmUsage": projected_llm_usage,
        "workingDir": _working_dir(op, workflow, path_base),
        "retryCount": node.retry_count,
        "timeoutSeconds": node.timeout_seconds,
        "inputs": dict(node.inputs),
        "unresolvedDynamicValues": unresolved,
    }


def _projected_llm_usage(
    op: object,
    workflow: AgenticWorkflow,
    fan_out: dict[str, Any] | None,
    path_base: Path | None,
    node_id: str,
    inherited_fan_out: int = 1,
) -> dict[str, object] | None:
    if not isinstance(op, (AgentOperation, CommonLlmTaskOperation)):
        return None
    agent = workflow.agents.get(op.agent_id)
    if agent is None:
        return None
    call_count = max(0, inherited_fan_out)
    if fan_out is not None and isinstance(fan_out.get("count"), int):
        call_count *= max(0, int(fan_out["count"]))
    prompt_text = _prompt_preview_text(op, workflow, path_base)
    input_tokens = estimate_tokens(prompt_text, agent.pricing) * call_count
    historical = _historical_llm_usage_average(workflow.config.id, node_id, path_base)
    output_tokens = int(round(historical["output_tokens"] * call_count))
    total_tokens = input_tokens + output_tokens
    estimated_cost = (
        input_tokens * agent.pricing.input_cost_per_1k_tokens
        + output_tokens * agent.pricing.output_cost_per_1k_tokens
    ) / 1000
    agent_time_seconds = historical["duration_seconds"] * call_count
    source = (
        "dry_run_prompt_template_with_historical_averages"
        if historical["samples"]
        else "dry_run_prompt_template_chars_per_token"
    )
    return {
        "agent_calls": call_count,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "estimated_cost": estimated_cost,
        "agent_time_seconds": agent_time_seconds,
        "estimated": True,
        "source": source,
        "historical_samples": historical["samples"],
        "provider": agent.subscription,
        "profile": agent.profile,
        "model": agent.model,
    }


def _projected_budget_warnings(
    usage: dict[str, object],
    budget: LlmUsageBudget,
    *,
    scope: str,
) -> list[str]:
    totals = LlmUsageTotals(
        agent_calls=_int_usage_value(usage.get("agent_calls")),
        input_tokens=_int_usage_value(usage.get("input_tokens")),
        output_tokens=_int_usage_value(usage.get("output_tokens")),
        total_tokens=_int_usage_value(usage.get("total_tokens")),
        estimated_cost=_float_usage_value(usage.get("estimated_cost")),
        agent_time_seconds=_float_usage_value(usage.get("agent_time_seconds")),
    )
    return [
        f"Projected {warning}"
        for warning in budget_violations(totals, budget, scope=scope)
    ]


def _int_usage_value(value: object) -> int:
    if isinstance(value, int | float | str):
        return int(value)
    return 0


def _float_usage_value(value: object) -> float:
    if isinstance(value, int | float | str):
        return float(value)
    return 0.0


def _historical_llm_usage_average(
    workflow_id: str,
    node_id: str,
    path_base: Path | None,
) -> dict[str, float]:
    if path_base is None:
        return {"output_tokens": 0.0, "duration_seconds": 0.0, "samples": 0.0}
    log_dir = path_base / "logs" / workflow_id
    samples: list[tuple[int, float]] = []
    try:
        output_paths = sorted(
            log_dir.glob("*.outputs.json"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return {"output_tokens": 0.0, "duration_seconds": 0.0, "samples": 0.0}
    for output_path in output_paths[:20]:
        try:
            payload = json.loads(output_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        summary = payload.get("usageSummary")
        nodes = summary.get("nodes") if isinstance(summary, dict) else None
        if not isinstance(nodes, list):
            continue
        for node_usage in nodes:
            if not isinstance(node_usage, dict) or node_usage.get("node_id") != node_id:
                continue
            samples.append((
                int(node_usage.get("output_tokens") or 0),
                float(node_usage.get("duration_seconds") or 0.0),
            ))
    if not samples:
        return {"output_tokens": 0.0, "duration_seconds": 0.0, "samples": 0.0}
    return {
        "output_tokens": sum(output for output, _ in samples) / len(samples),
        "duration_seconds": sum(duration for _, duration in samples) / len(samples),
        "samples": float(len(samples)),
    }


def _prompt_preview_text(
    op: AgentOperation | CommonLlmTaskOperation,
    workflow: AgenticWorkflow,
    path_base: Path | None,
) -> str:
    if isinstance(op, AgentOperation):
        if op.skill_name:
            return f"/{op.skill_name.strip().lstrip('/')}"
        prompt_path = op.prompt_path
        if prompt_path is None:
            agent = workflow.agents.get(op.agent_id)
            prompt_path = agent.prompt_path if agent is not None else None
        if prompt_path is None:
            return ""
        path = _resolve_path(prompt_path, path_base)
        try:
            return path.read_text(encoding="utf-8")
        except OSError:
            return ""
    return common_llm_task_prompt(op.task, op.target, op.instructions)


def _operation_detail(
    workflow: AgenticWorkflow,
    node: GraphNode,
    path_base: Path | None,
) -> str:
    op = node.operation
    if isinstance(op, BashCommandOperation):
        return op.command
    if isinstance(op, (PythonScriptOperation, ShellScriptOperation)):
        return " ".join([str(_resolve_path(op.script_path, path_base)), *op.args])
    if isinstance(op, ReadFileOperation):
        return str(_resolve_path(op.path, path_base))
    if isinstance(op, WriteFileOperation):
        mode = "append" if op.append else "write"
        return f"{mode} {_resolve_path(op.path, path_base)}"
    if isinstance(op, (CopyFileOperation, MoveFileOperation)):
        return (
            f"{_resolve_path(op.source_path, path_base)} -> "
            f"{_resolve_path(op.destination_path, path_base)}"
        )
    if isinstance(op, DeleteFileOperation):
        return str(_resolve_path(op.path, path_base))
    if isinstance(op, (FileOperation, FolderOperation)):
        return str(_resolve_path(op.path, path_base))
    if isinstance(op, OpenResourceOperation):
        return op.target
    if isinstance(op, PromptFileOperation):
        source = (
            str(_resolve_path(op.template_path, path_base))
            if op.template_path is not None
            else "inline template"
        )
        return f"{source} -> {_resolve_path(op.output_path, path_base)}"
    if isinstance(op, CommonLlmTaskOperation):
        return f"{op.agent_id}:{op.task} {op.target}".strip()
    if isinstance(op, LocalVectorizeOperation):
        return (
            f"{_resolve_path(op.source_path, path_base)} -> "
            f"{_resolve_path(op.index_path, path_base)}"
        )
    if isinstance(op, LocalSearchOperation):
        return f"{_resolve_path(op.index_path, path_base)} top_k={op.top_k}"
    if isinstance(op, HttpRequestOperation):
        parsed = urllib.parse.urlsplit(op.url)
        return f"{op.method.upper()} {parsed.netloc or '<dynamic-host>'}"
    if isinstance(op, ApprovalGateOperation):
        timeout = f" timeout={op.timeout_seconds}s" if op.timeout_seconds else ""
        return f"approval gate{timeout}"
    if isinstance(op, NotificationOperation):
        return f"notify {op.channel}: {op.title}"
    if isinstance(op, AgentOperation):
        parts = [op.agent_id]
        if op.skill_name:
            parts.append(f"skill={op.skill_name}")
        if op.prompt_path:
            parts.append(f"prompt={_resolve_path(op.prompt_path, path_base)}")
        agent = workflow.agents.get(op.agent_id)
        if agent is not None:
            parts.append(f"provider={agent.subscription}")
        return " ".join(parts)
    if isinstance(op, LoopOperation):
        return _fan_source_label(op.source, path_base)
    if isinstance(op, PassOperation):
        return op.message
    if isinstance(op, FailOperation):
        return op.message
    if isinstance(op, BreakOperation):
        return op.message
    if isinstance(op, StartOperation):
        return "start"
    return str(op.type)


def _operation_impact(
    op: object,
    path_base: Path | None,
) -> tuple[list[str], list[dict[str, object]], list[str], list[dict[str, object]], list[str]]:
    side_effects: list[str] = []
    side_effect_details: list[dict[str, object]] = []
    destructive: list[str] = []
    destructive_details: list[dict[str, object]] = []
    warnings: list[str] = []
    if isinstance(op, BashCommandOperation):
        side_effects.append(f"shell command: {op.command}")
        side_effect_details.append({
            "kind": "command",
            "action": "execute",
            "command": op.command,
            "destructive": True,
            "effectsInferred": False,
        })
        destructive.append(f"unknown shell command effects: {op.command}")
        destructive_details.append({
            "kind": "command",
            "action": "unknown_effects",
            "command": op.command,
            "destructive": True,
            "effectsInferred": False,
        })
        warnings.append("Shell command effects cannot be inferred")
    elif isinstance(op, PythonScriptOperation):
        script_path = _resolve_path(op.script_path, path_base)
        side_effects.append(f"python script: {script_path}")
        side_effect_details.append(_path_detail(
            kind="script",
            action="execute_python",
            path=script_path,
            destructive=True,
            effects_inferred=False,
        ))
        destructive.append(f"unknown python script effects: {script_path}")
        destructive_details.append(_path_detail(
            kind="script",
            action="unknown_effects",
            path=script_path,
            destructive=True,
            effects_inferred=False,
        ))
        warnings.append("Script effects cannot be inferred")
        if not script_path.exists():
            warnings.append(f"Missing python script: {script_path}")
    elif isinstance(op, ShellScriptOperation):
        script_path = _resolve_path(op.script_path, path_base)
        side_effects.append(f"shell script: {script_path}")
        side_effect_details.append(_path_detail(
            kind="script",
            action="execute_shell",
            path=script_path,
            destructive=True,
            effects_inferred=False,
        ))
        destructive.append(f"unknown shell script effects: {script_path}")
        destructive_details.append(_path_detail(
            kind="script",
            action="unknown_effects",
            path=script_path,
            destructive=True,
            effects_inferred=False,
        ))
        warnings.append("Script effects cannot be inferred")
        if not script_path.exists():
            warnings.append(f"Missing shell script: {script_path}")
    elif isinstance(op, ReadFileOperation):
        path = _resolve_path(op.path, path_base)
        side_effects.append(f"read file: {path}")
        side_effect_details.append(_path_detail(
            kind="file",
            action="read",
            path=path,
            destructive=False,
        ))
        if not path.exists():
            warnings.append(f"Missing read target: {path}")
    elif isinstance(op, WriteFileOperation):
        path = _resolve_path(op.path, path_base)
        side_effects.append(f"write file: {path}")
        side_effect_details.append(_path_detail(
            kind="file",
            action="append" if op.append else "write",
            path=path,
            destructive=op.append or op.overwrite,
            append=op.append,
            overwrite=op.overwrite,
        ))
        if op.append:
            destructive.append(f"append file: {path}")
            destructive_details.append(_path_detail(
                kind="file",
                action="append",
                path=path,
                destructive=True,
                append=True,
            ))
        elif op.overwrite:
            destructive.append(f"overwrite file: {path}")
            destructive_details.append(_path_detail(
                kind="file",
                action="overwrite",
                path=path,
                destructive=True,
                overwrite=True,
            ))
        else:
            warnings.append(f"Write fails if target exists: {path}")
    elif isinstance(op, CopyFileOperation):
        source_path = _resolve_path(op.source_path, path_base)
        destination_path = _resolve_path(op.destination_path, path_base)
        side_effects.append(f"copy file: {source_path} -> {destination_path}")
        side_effect_details.append(_two_path_detail(
            kind="file",
            action="copy",
            source_path=source_path,
            destination_path=destination_path,
            destructive=op.overwrite,
            overwrite=op.overwrite,
        ))
        if not source_path.exists():
            warnings.append(f"Missing copy source: {source_path}")
        if op.overwrite:
            destructive.append(f"overwrite copy destination: {destination_path}")
            destructive_details.append(_path_detail(
                kind="file",
                action="overwrite_copy_destination",
                path=destination_path,
                destructive=True,
                overwrite=True,
            ))
    elif isinstance(op, MoveFileOperation):
        source_path = _resolve_path(op.source_path, path_base)
        destination_path = _resolve_path(op.destination_path, path_base)
        side_effects.append(f"move file: {source_path} -> {destination_path}")
        side_effect_details.append(_two_path_detail(
            kind="file",
            action="move",
            source_path=source_path,
            destination_path=destination_path,
            destructive=True,
            overwrite=op.overwrite,
        ))
        destructive.append(f"move source: {source_path}")
        destructive_details.append(_two_path_detail(
            kind="file",
            action="move",
            source_path=source_path,
            destination_path=destination_path,
            destructive=True,
            overwrite=op.overwrite,
        ))
        if not source_path.exists():
            warnings.append(f"Missing move source: {source_path}")
        if op.overwrite:
            destructive.append(f"overwrite move destination: {destination_path}")
            destructive_details.append(_path_detail(
                kind="file",
                action="overwrite_move_destination",
                path=destination_path,
                destructive=True,
                overwrite=True,
            ))
    elif isinstance(op, DeleteFileOperation):
        path = _resolve_path(op.path, path_base)
        side_effects.append(f"delete file: {path}")
        action = "recursive delete" if op.recursive else "delete"
        side_effect_details.append(_path_detail(
            kind="file",
            action="delete",
            path=path,
            destructive=True,
            recursive=op.recursive,
            missing_ok=op.missing_ok,
        ))
        destructive.append(f"{action}: {path}")
        destructive_details.append(_path_detail(
            kind="file",
            action="recursive_delete" if op.recursive else "delete",
            path=path,
            destructive=True,
            recursive=op.recursive,
            missing_ok=op.missing_ok,
        ))
        if not path.exists() and not op.missing_ok:
            warnings.append(f"Missing delete target: {path}")
    elif isinstance(op, FileOperation):
        path = _resolve_path(op.path, path_base)
        side_effects.append(f"reference file: {path}")
        side_effect_details.append(_path_detail(
            kind="file",
            action="reference",
            path=path,
            destructive=False,
        ))
        if not path.exists():
            warnings.append(f"Missing file resource: {path}")
    elif isinstance(op, FolderOperation):
        path = _resolve_path(op.path, path_base)
        side_effects.append(f"reference folder: {path}")
        side_effect_details.append(_path_detail(
            kind="folder",
            action="reference",
            path=path,
            destructive=False,
        ))
        if not path.exists():
            warnings.append(f"Missing folder resource: {path}")
    elif isinstance(op, OpenResourceOperation):
        side_effects.append(f"open resource: {op.target}")
        side_effect_details.append({
            "kind": "resource",
            "action": "open",
            "target": op.target,
            "destructive": False,
        })
    elif isinstance(op, PromptFileOperation):
        output_path = _resolve_path(op.output_path, path_base)
        side_effects.append(f"write prompt file: {output_path}")
        detail = _path_detail(
            kind="file",
            action="write_prompt",
            path=output_path,
            destructive=op.overwrite,
            overwrite=op.overwrite,
        )
        if op.template_path is not None:
            detail["sourcePath"] = str(_resolve_path(op.template_path, path_base))
        side_effect_details.append(detail)
        if op.overwrite:
            destructive.append(f"overwrite prompt file: {output_path}")
            destructive_details.append(_path_detail(
                kind="file",
                action="overwrite_prompt",
                path=output_path,
                destructive=True,
                overwrite=True,
            ))
        if op.template_path is not None:
            template_path = _resolve_path(op.template_path, path_base)
            if not template_path.exists():
                warnings.append(f"Missing prompt template: {template_path}")
    elif isinstance(op, CommonLlmTaskOperation):
        side_effects.append(f"provider call: {op.agent_id} {op.task}")
        side_effect_details.append({
            "kind": "provider",
            "action": "call",
            "agentId": op.agent_id,
            "task": op.task,
            "destructive": False,
        })
    elif isinstance(op, LocalVectorizeOperation):
        source_path = _resolve_path(op.source_path, path_base)
        index_path = _resolve_path(op.index_path, path_base)
        side_effects.append(f"scan files: {source_path}")
        side_effect_details.append(_two_path_detail(
            kind="file",
            action="vectorize",
            source_path=source_path,
            destination_path=index_path,
            destructive=True,
        ))
        destructive.append(f"write vector index: {index_path}")
        destructive_details.append(_path_detail(
            kind="file",
            action="write_vector_index",
            path=index_path,
            destructive=True,
        ))
        if not source_path.exists():
            warnings.append(f"Missing vectorize source: {source_path}")
    elif isinstance(op, LocalSearchOperation):
        index_path = _resolve_path(op.index_path, path_base)
        side_effects.append(f"read vector index: {index_path}")
        side_effect_details.append(_path_detail(
            kind="file",
            action="read_vector_index",
            path=index_path,
            destructive=False,
        ))
        if not index_path.exists():
            warnings.append(f"Missing search index: {index_path}")
    elif isinstance(op, HttpRequestOperation):
        parsed = urllib.parse.urlsplit(op.url)
        host = parsed.netloc or "<dynamic-host>"
        configured_secret_fields = {field.lower() for field in op.secret_fields}
        secret_values = _http_plan_secret_values(op, configured_secret_fields)
        side_effects.append(f"http request: {op.method.upper()} {host}")
        side_effect_details.append({
            "kind": "network",
            "action": "http_request",
            "method": op.method.upper(),
            "url": _masked_http_plan_url(
                op,
                configured_secret_fields,
                secret_values,
            ),
            "host": host,
            "params": _masked_http_plan_value(
                op.params,
                configured_secret_fields,
                secret_values=secret_values,
            ),
            "expectedStatuses": list(op.expected_statuses),
            "destructive": op.method.upper() not in {"GET", "HEAD", "OPTIONS"},
            "effectsInferred": True,
        })
        if "{{" in op.url and "}}" in op.url:
            warnings.append(f"HTTP request URL contains unresolved dynamic values: {op.url}")
    elif isinstance(op, ApprovalGateOperation):
        side_effects.append("pause for approval")
        side_effect_details.append({
            "kind": "approval",
            "action": "wait",
            "message": op.message,
            "approvers": list(op.approvers),
            "timeoutSeconds": op.timeout_seconds,
            "timeoutDecision": op.timeout_decision,
            "notify": op.notify,
            "destructive": False,
            "effectsInferred": True,
        })
        warnings.append(f"Workflow pauses for approval at node message: {op.message}")
        if "{{" in op.message and "}}" in op.message:
            warnings.append(
                f"Approval message contains unresolved dynamic values: {op.message}"
            )
    elif isinstance(op, NotificationOperation):
        side_effects.append(f"desktop notification: {op.title}")
        side_effect_details.append({
            "kind": "notification",
            "action": "send",
            "channel": op.channel,
            "title": op.title,
            "body": op.body,
            "urgency": op.urgency,
            "destructive": False,
            "effectsInferred": True,
        })
        if "{{" in op.body and "}}" in op.body:
            warnings.append(
                f"Notification body contains unresolved dynamic values: {op.body}"
            )
    elif isinstance(op, AgentOperation):
        side_effects.append(f"provider call: {op.agent_id}")
        side_effect_details.append({
            "kind": "provider",
            "action": "call",
            "agentId": op.agent_id,
            "destructive": False,
        })
        if op.prompt_path is not None:
            prompt_path = _resolve_path(op.prompt_path, path_base)
            if not prompt_path.exists():
                warnings.append(f"Missing agent prompt file: {prompt_path}")
    return (
        side_effects,
        side_effect_details,
        destructive,
        destructive_details,
        warnings,
    )


def _agent_registration_warnings(op: object, workflow: AgenticWorkflow) -> list[str]:
    if isinstance(op, (AgentOperation, CommonLlmTaskOperation)):
        if op.agent_id not in workflow.agents:
            return [f"Agent '{op.agent_id}' is not registered in workflow"]
    return []


def _fan_out_plan(
    op: object,
    trigger_context: dict[str, Any],
    limits: ResourceLimits,
    sample_limit: int,
    path_base: Path | None,
) -> dict[str, Any] | None:
    source = None
    if isinstance(op, LoopOperation):
        source = op.source
    elif isinstance(op, AgentOperation) and op.fan_source is not None:
        source = op.fan_source
    if source is None:
        if isinstance(op, AgentOperation) and op.dynamic_count != 1:
            return _agent_dynamic_count_plan(op, limits, sample_limit)
        return None

    plan: dict[str, Any] = {
        "sourceType": source.type,
        "maxConcurrency": source.max_concurrency,
        "failFast": source.fail_fast,
        "count": None,
        "countExact": False,
        "countLowerBound": None,
        "sampleItems": [],
        "warnings": [],
    }
    try:
        if isinstance(source, CountFanSource):
            if isinstance(source.count, int):
                count = source.count
                sample: list[dict[str, object]] = [
                    {"index": str(i)} for i in range(min(count, sample_limit))
                ]
            elif isinstance(source.count, str) and source.count.strip().isdigit():
                count = int(source.count.strip())
                sample = [{"index": str(i)} for i in range(min(count, sample_limit))]
            elif source.count in (None, ""):
                count = 1
                sample = [{"index": "0"}]
            else:
                count = None
                sample = []
                plan["warnings"].append(
                    f"Unresolved dynamic count expression: {source.count}"
                )
            plan["count"] = count
            plan["countExact"] = count is not None
            plan["countLowerBound"] = count
            plan["sampleItems"] = sample
        elif isinstance(source, TabularFanSource):
            path = _resolve_path(source.path, path_base)
            if not path.exists():
                plan["warnings"].append(f"Missing tabular fan-out source: {path}")
            else:
                tabular_count, tabular_sample, tabular_warnings, partial = _preview_tabular(
                    path,
                    limits,
                    sample_limit,
                )
                plan["count"] = tabular_count
                plan["countExact"] = not partial
                plan["countLowerBound"] = tabular_count
                plan["sampleItems"] = tabular_sample
                plan["warnings"].extend(tabular_warnings)
            plan["path"] = str(path)
        elif isinstance(source, DirectoryFanSource):
            path = _resolve_path(source.path, path_base)
            plan["path"] = str(path)
            plan["glob"] = source.glob
            plan["includeContent"] = source.include_content
            if not path.exists():
                plan["warnings"].append(f"Missing directory fan-out source: {path}")
            elif not path.is_dir():
                plan["warnings"].append(
                    f"Directory fan-out source is not a directory: {path}"
                )
            else:
                directory_count, directory_sample, directory_warnings, scanned, partial = (
                    _preview_directory(source, path, limits, sample_limit)
                )
                plan["count"] = directory_count
                plan["countExact"] = not partial
                plan["countLowerBound"] = directory_count
                plan["sampleItems"] = directory_sample
                plan["scannedPaths"] = scanned
                plan["warnings"].extend(directory_warnings)
        elif isinstance(source, TriggerEventsFanSource):
            if "events" not in trigger_context:
                plan["count"] = None
                plan["warnings"].append(
                    "No trigger context events provided; trigger-event fan-out "
                    "count cannot be estimated"
                )
            elif isinstance(trigger_context["events"], list):
                count, sample, trigger_warnings = _preview_trigger_events(
                    trigger_context["events"],
                    source,
                    sample_limit,
                )
                plan["count"] = count
                plan["countExact"] = True
                plan["countLowerBound"] = count
                plan["sampleItems"] = sample
                plan["warnings"].extend(trigger_warnings)
                if count > limits.max_fanout_items:
                    plan["warnings"].append(
                        f"Trigger-event fan-out count {count} exceeds limit "
                        f"{limits.max_fanout_items}"
                    )
            else:
                plan["warnings"].append("Trigger context events is not a list")
        elif isinstance(source, InfiniteFanSource):
            plan["count"] = None
            plan["warnings"].append("Infinite fan-out count cannot be estimated")
    except Exception as exc:  # noqa: BLE001
        plan["warnings"].append(f"Fan-out estimate failed: {exc}")
    return plan


def _agent_dynamic_count_plan(
    op: AgentOperation,
    limits: ResourceLimits,
    sample_limit: int,
) -> dict[str, Any]:
    plan: dict[str, Any] = {
        "sourceType": "agent_dynamic_count",
        "maxConcurrency": None,
        "failFast": True,
        "count": None,
        "countExact": False,
        "countLowerBound": None,
        "sampleItems": [],
        "warnings": [
            "agent dynamic_count is deprecated; use a loop node feeding this agent"
        ],
    }
    if isinstance(op.dynamic_count, int):
        count = op.dynamic_count
        plan["count"] = count
        plan["countExact"] = True
        plan["countLowerBound"] = count
        plan["sampleItems"] = [{"index": str(i)} for i in range(min(count, sample_limit))]
        if count > limits.max_fanout_items:
            plan["warnings"].append(
                f"Agent dynamic_count {count} exceeds limit {limits.max_fanout_items}"
            )
    elif isinstance(op.dynamic_count, str) and op.dynamic_count.strip().isdigit():
        count = int(op.dynamic_count.strip())
        plan["count"] = count
        plan["countExact"] = True
        plan["countLowerBound"] = count
        plan["sampleItems"] = [{"index": str(i)} for i in range(min(count, sample_limit))]
        if count > limits.max_fanout_items:
            plan["warnings"].append(
                f"Agent dynamic_count {count} exceeds limit {limits.max_fanout_items}"
            )
    else:
        plan["warnings"].append(
            f"Unresolved dynamic_count expression: {op.dynamic_count}"
        )
    return plan


def _preview_directory(
    source: DirectoryFanSource,
    source_path: Path,
    limits: ResourceLimits,
    sample_limit: int,
) -> tuple[int, list[dict[str, object]], list[str], int, bool]:
    count = 0
    scanned = 0
    partial = False
    sample: list[dict[str, object]] = []
    warnings: list[str] = []

    for path in source_path.glob(source.glob):
        scanned += 1
        if scanned > limits.max_files_scanned:
            partial = True
            warnings.append(
                "Directory fan-out scan exceeded limit "
                f"{limits.max_files_scanned} paths; preview count is partial"
            )
            break
        if not path.is_file():
            continue
        count += 1
        if len(sample) < sample_limit:
            sample.append({
                "path": str(path),
                "name": path.name,
                "sizeBytes": path.stat().st_size,
            })
        if count > limits.max_fanout_items:
            partial = True
            warnings.append(
                f"Directory fan-out count exceeds limit {limits.max_fanout_items} "
                "items; preview count is partial"
            )
            break

    return count, sorted(sample, key=lambda item: str(item["path"])), warnings, scanned, partial


def _preview_tabular(
    path: Path,
    limits: ResourceLimits,
    sample_limit: int,
) -> tuple[int, list[dict[str, object]], list[str], bool]:
    suffix = path.suffix.lower()
    row_limit = limits.max_fanout_items
    scan_limit = max(0, row_limit) + 1
    warnings: list[str] = []
    partial = False

    def _with_row(row: dict[str, object]) -> dict[str, object]:
        return {**row, "_row": json.dumps(row, default=str)}

    def _should_stop(count: int) -> bool:
        nonlocal partial
        if count <= row_limit:
            return False
        partial = True
        warnings.append(
            f"Tabular fan-out count {count} exceeds limit {row_limit}; "
            "preview count is partial"
        )
        return True

    count = 0
    sample: list[dict[str, object]] = []
    if suffix == ".jsonl":
        with path.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                count += 1
                if len(sample) < sample_limit:
                    sample.append(_with_row(row))
                if count >= scan_limit and _should_stop(count):
                    break
        return count, sample, warnings, partial
    if suffix == ".csv":
        with path.open(newline="") as f:
            for row in csv.DictReader(f):
                count += 1
                if len(sample) < sample_limit:
                    sample.append(_with_row(dict(row)))
                if count >= scan_limit and _should_stop(count):
                    break
        return count, sample, warnings, partial
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
            for row in rows_iter:
                item = dict(zip(headers, row))
                count += 1
                if len(sample) < sample_limit:
                    sample.append(_with_row(item))
                if count >= scan_limit and _should_stop(count):
                    break
            return count, sample, warnings, partial
        finally:
            wb.close()
    raise ValueError(f"Unsupported tabular format: {suffix!r}. Use .jsonl, .csv, or .xlsx")


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


def _path_detail(
    *,
    kind: str,
    action: str,
    path: Path,
    destructive: bool,
    effects_inferred: bool = True,
    **extra: object,
) -> dict[str, object]:
    return {
        "kind": kind,
        "action": action,
        "path": str(path),
        "exists": path.exists(),
        "destructive": destructive,
        "effectsInferred": effects_inferred,
        **extra,
    }


def _two_path_detail(
    *,
    kind: str,
    action: str,
    source_path: Path,
    destination_path: Path,
    destructive: bool,
    effects_inferred: bool = True,
    **extra: object,
) -> dict[str, object]:
    return {
        "kind": kind,
        "action": action,
        "sourcePath": str(source_path),
        "sourceExists": source_path.exists(),
        "destinationPath": str(destination_path),
        "destinationExists": destination_path.exists(),
        "destructive": destructive,
        "effectsInferred": effects_inferred,
        **extra,
    }


def _dedupe_details(details: list[dict[str, object]]) -> list[dict[str, object]]:
    deduped: dict[str, dict[str, object]] = {}
    for detail in details:
        deduped[json.dumps(detail, sort_keys=True, default=str)] = detail
    return [deduped[key] for key in sorted(deduped)]


def _preview_trigger_events(
    events: list[object],
    source: TriggerEventsFanSource,
    sample_limit: int,
) -> tuple[int, list[dict[str, object]], list[str]]:
    count = 0
    sample: list[dict[str, object]] = []
    warnings: list[str] = []
    skipped_non_dict = 0
    content_omitted = False

    for idx, event in enumerate(events):
        if not isinstance(event, dict):
            skipped_non_dict += 1
            continue

        count += 1
        if len(sample) >= sample_limit:
            continue

        item: dict[str, object] = {
            **event,
            "index": str(idx),
            "event_json": json.dumps(event, default=str),
        }
        path = event.get("path")
        if path:
            event_path = Path(str(path))
            item.update(_file_path_data(event_path))
            item.setdefault("name", event_path.name)
            item.setdefault("directory", str(event_path.parent))
            if event_path.exists() and event_path.is_file():
                size = event_path.stat().st_size
                item["sizeBytes"] = size
                if source.include_content:
                    item["contentIncluded"] = False
                    content_omitted = True
            elif source.include_content:
                warnings.append(f"Missing trigger event file: {event_path}")
        sample.append(item)

    if skipped_non_dict:
        warnings.append(
            f"Skipped {skipped_non_dict} non-object trigger event"
            f"{'' if skipped_non_dict == 1 else 's'}"
        )
    if content_omitted:
        warnings.append("Trigger event file content omitted from plan preview")
    return count, sample, warnings


def _required_secrets(
    op: object,
    workflow: AgenticWorkflow,
    path_base: Path | None,
    data_dir: Path | None,
) -> list[str]:
    values: dict[str, str] = {}
    profile_secrets: set[str] = set()
    if isinstance(op, (BashCommandOperation, PythonScriptOperation, ShellScriptOperation)):
        values.update(op.env)
    elif isinstance(op, AgentOperation):
        agent = workflow.agents.get(op.agent_id)
        if agent is not None:
            values.update(agent.env)
            settings = resolve_provider_settings(
                agent_subscription=agent.subscription,
                profile_name=agent.profile,
                agent_model=agent.model,
                operation_profile=op.profile,
                operation_model=op.model,
                operation_timeout=op.timeout,
                data_dir=data_dir,
            )
            profile_secrets.update(unresolved_provider_secret_refs(settings))
    elif isinstance(op, CommonLlmTaskOperation):
        agent = workflow.agents.get(op.agent_id)
        if agent is not None:
            values.update(agent.env)
            settings = resolve_provider_settings(
                agent_subscription=agent.subscription,
                profile_name=agent.profile,
                agent_model=agent.model,
                operation_profile=op.profile,
                operation_model=op.model,
                operation_timeout=op.timeout,
                data_dir=data_dir,
            )
            profile_secrets.update(unresolved_provider_secret_refs(settings))
    elif isinstance(op, HttpRequestOperation):
        for field, value in _iter_strings(op.model_dump(by_alias=True)):
            values[field] = value
    return sorted(profile_secrets | {
        secret
        for value in values.values()
        for secret in _secret_reference_names(str(value))
        if secret is not None
        and not os.environ.get(f"GOFER_SECRET_{secret}")
        and not os.environ.get(secret)
    } | {
        value[4:]
        for value in values.values()
        if str(value).startswith("env:") and not os.environ.get(str(value)[4:])
    })


def _provider_requirements(
    op: object,
    workflow: AgenticWorkflow,
    path_base: Path | None,
    data_dir: Path | None,
) -> list[dict[str, Any]]:
    if isinstance(op, (AgentOperation, CommonLlmTaskOperation)):
        agent = workflow.agents.get(op.agent_id)
        if agent is None:
            return []
        settings = resolve_provider_settings(
            agent_subscription=agent.subscription,
            profile_name=agent.profile,
            agent_model=agent.model,
            operation_profile=op.profile,
            operation_model=op.model,
            operation_timeout=op.timeout,
            data_dir=data_dir,
        )
        validation_errors: list[str] = []
        try:
            validate_provider_settings(settings)
        except ValueError as exc:
            validation_errors.append(str(exc))
        extra_paths = _configured_extra_paths(agent, path_base)
        binary = _provider_binary(settings.subscription)
        available = shutil.which(binary) is not None if binary is not None else False
        requirement = {
            "agentId": agent.agent_id,
            "subscription": settings.subscription,
            "profile": settings.profile_name,
            "model": settings.model,
            "timeout": settings.timeout,
            "workingDir": str(_resolve_path(op.working_dir, path_base)),
            "binary": binary,
            "available": available,
            "extraPaths": extra_paths,
        }
        if validation_errors:
            requirement["validationErrors"] = validation_errors
        return [requirement]
    return []


def _provider_binary(subscription: str) -> str | None:
    if subscription == "codex":
        return "codex"
    if subscription == "claude_code":
        return "claude"
    return None


def _configured_extra_paths(
    agent: Any,
    path_base: Path | None,
) -> list[str]:
    if path_base is None:
        try:
            return [str(path) for path in configured_extra_paths(agent)]
        except Exception:
            return [str(path) for path in agent.extra_paths]
    paths: list[str] = []
    for extra_path in agent.extra_paths:
        path = _resolve_path(extra_path, path_base)
        try:
            paths.append(str(path.resolve()))
        except OSError:
            paths.append(str(path))
    return paths


def _working_dir(
    op: object,
    workflow: AgenticWorkflow,
    path_base: Path | None,
) -> str | None:
    if isinstance(op, BashCommandOperation):
        return (
            str(_resolve_path(op.working_dir, path_base))
            if op.working_dir is not None
            else None
        )
    if isinstance(op, (AgentOperation, CommonLlmTaskOperation)):
        return str(_resolve_path(op.working_dir, path_base))
    agent_id = getattr(op, "agent_id", None)
    if isinstance(agent_id, str):
        agent = workflow.agents.get(agent_id)
        if agent is not None:
            return str(_resolve_path(agent.working_dir, path_base))
    return None


def _unresolved_values(node: GraphNode, workflow: AgenticWorkflow) -> list[str]:
    values: list[str] = []
    node_ids = {workflow_node.node_id for workflow_node in workflow.graph.nodes_in_order()}
    for key, value in node.inputs.items():
        if isinstance(value, str) and _is_dynamic_reference(value, node_ids):
            values.append(f"{node.node_id}.inputs.{key}={value}")
    op = node.operation
    if isinstance(op, LoopOperation) and isinstance(op.source, CountFanSource):
        if (
            isinstance(op.source.count, str)
            and op.source.count.strip()
            and not op.source.count.strip().isdigit()
        ):
            values.append(f"{node.node_id}.fan_source.count={op.source.count}")
    if (
        isinstance(op, AgentOperation)
        and isinstance(op.dynamic_count, str)
        and op.dynamic_count.strip()
        and not op.dynamic_count.strip().isdigit()
    ):
        values.append(f"{node.node_id}.dynamic_count={op.dynamic_count}")
    for field, value in _iter_strings(op.model_dump(by_alias=True)):
        if field == "type" or field.endswith(".type"):
            continue
        if "{{" in value and "}}" in value:
            values.append(f"{node.node_id}.{field}={value}")
        elif _is_dynamic_reference(value, node_ids):
            values.append(f"{node.node_id}.{field}={value}")
    return sorted(set(values))


def _is_dynamic_reference(value: str, node_ids: set[str]) -> bool:
    expression = value.strip().strip("{}").strip()
    if not expression:
        return False
    if expression in node_ids:
        return True
    if "." not in expression:
        return False
    root = expression.split(".", 1)[0]
    return root in {"trigger", "params", "loop", "previous", *node_ids}


def _iter_strings(value: Any, prefix: str = "") -> list[tuple[str, str]]:
    if isinstance(value, str):
        return [(prefix, value)]
    if isinstance(value, Path):
        return [(prefix, str(value))]
    if isinstance(value, dict):
        items: list[tuple[str, str]] = []
        for key, nested in value.items():
            next_prefix = f"{prefix}.{key}" if prefix else str(key)
            items.extend(_iter_strings(nested, next_prefix))
        return items
    if isinstance(value, list):
        items = []
        for index, nested in enumerate(value):
            items.extend(_iter_strings(nested, f"{prefix}[{index}]"))
        return items
    return []


def _secret_reference_names(value: str) -> list[str]:
    match = SECRET_REF_PATTERN.match(value.strip())
    names = [match.group(1) or match.group(2)] if match is not None else []
    names.extend(match.group(1) for match in SECRET_INTERPOLATION_PATTERN.finditer(value))
    return names


def _is_sensitive_field(path: str, configured: set[str]) -> bool:
    normalized = path.lower()
    if normalized in configured:
        return True
    name = normalized.rsplit(".", maxsplit=1)[-1]
    return name in SENSITIVE_FIELD_NAMES or any(token in name for token in ("token", "secret"))


def _collect_plan_leaf_strings(value: object) -> set[str]:
    if isinstance(value, str):
        return {value} if value else set()
    if isinstance(value, dict):
        values: set[str] = set()
        for item in value.values():
            values.update(_collect_plan_leaf_strings(item))
        return values
    if isinstance(value, list):
        values = set()
        for item in value:
            values.update(_collect_plan_leaf_strings(item))
        return values
    if value is None:
        return set()
    text = str(value)
    return {text} if text else set()


def _collect_http_plan_secret_values(
    value: object,
    configured: set[str],
    path: str = "",
) -> set[str]:
    if isinstance(value, dict):
        values: set[str] = set()
        for key, item in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            if _is_sensitive_field(child_path, configured):
                values.update(_collect_plan_leaf_strings(item))
            else:
                values.update(
                    _collect_http_plan_secret_values(item, configured, child_path)
                )
        return values
    if isinstance(value, list):
        values = set()
        for item in value:
            values.update(_collect_http_plan_secret_values(item, configured, path))
        return values
    if path and _is_sensitive_field(path, configured):
        return _collect_plan_leaf_strings(value)
    return set()


def _http_plan_secret_values(
    op: HttpRequestOperation,
    configured: set[str],
) -> set[str]:
    values: set[str] = set()
    if _is_sensitive_field("url", configured):
        values.update(_collect_plan_leaf_strings(op.url))
    parsed = urllib.parse.urlsplit(op.url)
    for key, value in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True):
        if _is_sensitive_field(key, configured):
            values.update(_collect_plan_leaf_strings(value))
    values.update(_collect_http_plan_secret_values(op.headers, configured))
    values.update(_collect_http_plan_secret_values(op.params, configured))
    values.update(_collect_http_plan_secret_values(op.json_payload, configured))
    if op.body is not None:
        values.update(_collect_http_plan_secret_values(op.body, configured, "body"))
    return {value for value in values if value}


def _replace_http_plan_secret_values(value: str, secret_values: set[str]) -> str:
    masked = value
    for secret_value in sorted(secret_values, key=len, reverse=True):
        masked = masked.replace(secret_value, "***")
    return masked


def _masked_http_plan_value(
    value: object,
    configured: set[str],
    path: str = "",
    *,
    secret_values: set[str] | None = None,
) -> object:
    if isinstance(value, dict):
        masked: dict[str, object] = {}
        for key, item in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            if _is_sensitive_field(child_path, configured) or (
                isinstance(item, str) and _secret_reference_names(item)
            ):
                masked[str(key)] = "***"
            else:
                masked[str(key)] = _masked_http_plan_value(
                    item,
                    configured,
                    child_path,
                    secret_values=secret_values,
                )
        return masked
    if isinstance(value, list):
        return [
            _masked_http_plan_value(
                item,
                configured,
                path,
                secret_values=secret_values,
            )
            for item in value
        ]
    if isinstance(value, str) and _secret_reference_names(value):
        return "***"
    if isinstance(value, str) and secret_values:
        return _replace_http_plan_secret_values(value, secret_values)
    return value


def _masked_http_plan_url(
    op: HttpRequestOperation,
    configured: set[str],
    secret_values: set[str],
) -> str:
    if _is_sensitive_field("url", configured) or _secret_reference_names(op.url):
        return "***"
    parsed = urllib.parse.urlsplit(op.url)
    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    masked_pairs = [
        (
            key,
            "***"
            if _is_sensitive_field(key, configured) or _secret_reference_names(value)
            else _replace_http_plan_secret_values(value, secret_values),
        )
        for key, value in query_pairs
    ]
    masked_url = urllib.parse.urlunsplit(
        parsed._replace(query=urllib.parse.urlencode(masked_pairs))
    )
    return _replace_http_plan_secret_values(masked_url, secret_values)


def _fan_source_label(source: object, path_base: Path | None) -> str:
    if isinstance(source, CountFanSource):
        return f"count={source.count}"
    if isinstance(source, TabularFanSource):
        return f"tabular {_resolve_path(source.path, path_base)}"
    if isinstance(source, DirectoryFanSource):
        return f"directory {_resolve_path(source.path, path_base)} glob={source.glob}"
    if isinstance(source, TriggerEventsFanSource):
        return "trigger events"
    if isinstance(source, InfiniteFanSource):
        return "infinite"
    return str(source)


def _resolve_path(path: Path, path_base: Path | None) -> Path:
    expanded = path.expanduser()
    if expanded.is_absolute() or path_base is None:
        return expanded
    return path_base / expanded


def plan_to_json(plan: dict[str, Any]) -> str:
    return json.dumps(plan, indent=2, sort_keys=True, default=str)
