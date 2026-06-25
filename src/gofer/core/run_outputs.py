from __future__ import annotations

import json
from typing import Any, cast

from gofer.core.operations import OperationType

RUN_NODE_OUTPUTS_SUFFIX = ".outputs.json"


def write_run_node_outputs_payload(result: Any, limits: Any) -> None:
    if result.log_path is None:
        return
    payload = {
        "workflowId": result.workflow_id,
        "runId": result.log_path.name,
        "nodeOutputs": {
            node_id: run_sidecar_node_output_contract(output)
            for node_id, output in result.node_outputs.items()
        },
        "usageSummary": result.usage_summary,
        "nodeOutputsTruncated": False,
        "nodeOutputsMaxBytes": limits.max_api_log_response_bytes,
    }
    result.log_path.with_suffix(RUN_NODE_OUTPUTS_SUFFIX).write_text(
        json.dumps(payload, default=str),
        encoding="utf-8",
    )


def run_sidecar_node_output_contract(output: Any) -> dict[str, object]:
    contract = cast(dict[str, object], output.contract())
    output_type = str(contract.get("type") or "")
    if output_type in {
        str(OperationType.AGENT),
        str(OperationType.COMMON_LLM_TASK),
    }:
        data = contract.get("data")
        if isinstance(data, dict):
            contract["data"] = redact_prompt_fields(data)
    return contract


def redact_prompt_fields(value: object) -> object:
    if isinstance(value, dict):
        redacted: dict[str, object] = {}
        for key, item in value.items():
            if str(key).lower() == "prompt":
                redacted[str(key)] = "***"
            else:
                redacted[str(key)] = redact_prompt_fields(item)
        return redacted
    if isinstance(value, list):
        return [redact_prompt_fields(item) for item in value]
    return value
