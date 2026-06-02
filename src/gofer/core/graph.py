from __future__ import annotations

import re
from enum import StrEnum
from typing import TYPE_CHECKING

import networkx as nx
from pydantic import BaseModel

from legacy.gofer.core.operations import Operation

if TYPE_CHECKING:
    from legacy.gofer.core.executor import NodeOutput


class EdgeConditionType(StrEnum):
    ALWAYS = "always"
    ON_SUCCESS = "on_success"
    ON_FAILURE = "on_failure"
    OUTPUT_MATCHES = "output_matches"


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
                return bool(re.search(self.output_pattern or "", output.output))
        return True


class GraphNode(BaseModel):
    node_id: str
    operation: Operation
    retry_count: int = 0
    retry_delay_seconds: float = 1.0
    timeout_seconds: float | None = None
    pipe_output: bool = False
    on_failure: str = "halt"


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
        if not nx.is_directed_acyclic_graph(self._graph):
            self._graph.remove_edge(from_id, to_id)
            raise CycleError(f"Adding edge {from_id!r} → {to_id!r} would create a cycle")
        self._edges[(from_id, to_id)] = config or EdgeConfig(from_node=from_id, to_node=to_id)

    def get_edge_config(self, from_id: str, to_id: str) -> EdgeConfig:
        return self._edges.get((from_id, to_id), EdgeConfig(from_node=from_id, to_node=to_id))

    def topological_generations(self) -> list[list[GraphNode]]:
        return [
            [self._nodes[nid] for nid in gen]
            for gen in nx.topological_generations(self._graph)
        ]

    def validate(self) -> None:
        if not nx.is_directed_acyclic_graph(self._graph):
            raise CycleError("Workflow graph contains a cycle")
        missing = set(self._graph.nodes) - set(self._nodes)
        if missing:
            raise ValueError(f"Graph references unknown nodes: {missing}")

    def __len__(self) -> int:
        return len(self._nodes)
