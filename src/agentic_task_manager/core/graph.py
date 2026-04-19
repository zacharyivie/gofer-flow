from __future__ import annotations

from typing import Literal

import networkx as nx
from pydantic import BaseModel

from agentic_task_manager.core.operations import Operation


class GraphNode(BaseModel):
    node_id: str
    operation: Operation
    retry_count: int = 0
    retry_delay_seconds: float = 1.0
    timeout_seconds: float | None = None
    on_failure: Literal["halt", "skip", "continue"] = "halt"


class CycleError(ValueError):
    pass


class WorkflowGraph:
    def __init__(self) -> None:
        self._graph: nx.DiGraph = nx.DiGraph()
        self._nodes: dict[str, GraphNode] = {}

    def add_node(self, node: GraphNode) -> None:
        self._nodes[node.node_id] = node
        self._graph.add_node(node.node_id)

    def add_edge(self, from_id: str, to_id: str) -> None:
        if from_id not in self._nodes:
            raise ValueError(f"Node '{from_id}' not found")
        if to_id not in self._nodes:
            raise ValueError(f"Node '{to_id}' not found")
        self._graph.add_edge(from_id, to_id)
        if not nx.is_directed_acyclic_graph(self._graph):
            self._graph.remove_edge(from_id, to_id)
            raise CycleError(f"Adding edge {from_id!r} → {to_id!r} would create a cycle")

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
