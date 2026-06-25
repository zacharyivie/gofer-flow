from __future__ import annotations

import json
import re
from enum import StrEnum
from typing import TYPE_CHECKING, Any

import networkx as nx
from pydantic import BaseModel, model_validator

from gofer.core.operations import Operation, OperationType

if TYPE_CHECKING:
    from gofer.core.executor import NodeOutput


class EdgeConditionType(StrEnum):
    ALWAYS = "always"
    ON_SUCCESS = "on_success"
    ON_FAILURE = "on_failure"
    OUTPUT_MATCHES = "output_matches"
    AFTER_LOOP = "after_loop"


class EdgeConfig(BaseModel):
    from_node: str
    to_node: str
    condition: EdgeConditionType = EdgeConditionType.ALWAYS
    output_pattern: str | None = None

    def evaluate(self, output: NodeOutput) -> bool:
        match self.condition:
            case EdgeConditionType.ALWAYS:
                return True
            case EdgeConditionType.ON_SUCCESS:
                return output.success
            case EdgeConditionType.ON_FAILURE:
                return not output.success
            case EdgeConditionType.OUTPUT_MATCHES:
                return bool(re.search(self.output_pattern or "", _matchable_output(output)))
            case EdgeConditionType.AFTER_LOOP:
                return False
        return True


def _matchable_output(output: NodeOutput) -> str:
    chunks = [output.output]
    if output.value not in (None, output.output):
        chunks.append(_stringify_match_value(output.value))
    selected = output.data.get("selected") if isinstance(output.data, dict) else None
    if selected not in (None, ""):
        chunks.append(_stringify_match_value(selected))
    return "\n".join(chunk for chunk in chunks if chunk)


def _stringify_match_value(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, default=str, sort_keys=True)


class GraphNode(BaseModel):
    node_id: str
    operation: Operation
    label: str | None = None
    inputs: dict[str, str] = {}
    retry_count: int = 0
    retry_delay_seconds: float = 1.0
    timeout_seconds: float | None = None
    pipe_output: bool = False
    allow_failure: bool = False
    await_all_inputs: bool = True
    on_failure: str = "halt"

    @model_validator(mode="after")
    def normalize_special_label(self) -> GraphNode:
        special_label = {
            OperationType.START: "START",
            OperationType.PASS: "PASS",
            OperationType.FAIL: "FAIL",
        }.get(self.operation.type)
        if special_label:
            self.label = special_label
        return self


class CycleError(ValueError):
    pass


class WorkflowGraph:
    def __init__(self) -> None:
        self._graph: nx.DiGraph = nx.DiGraph()
        self._nodes: dict[str, GraphNode] = {}
        self._edges: dict[tuple[str, str], EdgeConfig] = {}

    def add_node(self, node: GraphNode) -> None:
        self._nodes[node.node_id] = node
        self._graph.add_node(node.node_id)

    def add_edge(self, from_id: str, to_id: str, config: EdgeConfig | None = None) -> None:
        if from_id not in self._nodes:
            raise ValueError(f"Node '{from_id}' not found")
        if to_id not in self._nodes:
            raise ValueError(f"Node '{to_id}' not found")
        self._graph.add_edge(from_id, to_id)
        self._edges[(from_id, to_id)] = config or EdgeConfig(from_node=from_id, to_node=to_id)

    def get_edge_config(self, from_id: str, to_id: str) -> EdgeConfig:
        return self._edges.get((from_id, to_id), EdgeConfig(from_node=from_id, to_node=to_id))

    def topological_generations(self) -> list[list[GraphNode]]:
        try:
            return [
                [self._nodes[nid] for nid in gen]
                for gen in nx.topological_generations(self._graph)
            ]
        except nx.NetworkXUnfeasible:
            return [[node] for node in self._nodes.values()]

    def nodes_in_order(self) -> list[GraphNode]:
        return list(self._nodes.values())

    def validate(self) -> None:
        missing = set(self._graph.nodes) - set(self._nodes)
        if missing:
            raise ValueError(f"Graph references unknown nodes: {missing}")
        special_nodes: dict[OperationType, list[str]] = {
            OperationType.START: [],
            OperationType.PASS: [],
            OperationType.FAIL: [],
        }
        for node_id, node in self._nodes.items():
            if node.operation.type in special_nodes:
                special_nodes[node.operation.type].append(node_id)
        for node_type, node_ids in special_nodes.items():
            if len(node_ids) > 1:
                label = node_type.value.upper()
                raise ValueError(
                    f"Workflow can only contain one {label} node; found {node_ids}"
                )

    def __len__(self) -> int:
        return len(self._nodes)
