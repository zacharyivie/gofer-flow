from __future__ import annotations

import pytest

from agentic_task_manager.core.graph import CycleError, GraphNode, WorkflowGraph
from agentic_task_manager.core.operations import BashCommandOperation, OperationType


def _bash_node(node_id: str, command: str = "echo ok") -> GraphNode:
    return GraphNode(
        node_id=node_id,
        operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command=command),
    )


def test_add_and_retrieve_nodes() -> None:
    g = WorkflowGraph()
    g.add_node(_bash_node("a"))
    g.add_node(_bash_node("b"))
    assert len(g) == 2


def test_topological_generations_linear() -> None:
    g = WorkflowGraph()
    for nid in ["a", "b", "c"]:
        g.add_node(_bash_node(nid))
    g.add_edge("a", "b")
    g.add_edge("b", "c")
    gens = g.topological_generations()
    assert len(gens) == 3
    assert gens[0][0].node_id == "a"
    assert gens[2][0].node_id == "c"


def test_topological_generations_parallel() -> None:
    g = WorkflowGraph()
    for nid in ["root", "left", "right", "merge"]:
        g.add_node(_bash_node(nid))
    g.add_edge("root", "left")
    g.add_edge("root", "right")
    g.add_edge("left", "merge")
    g.add_edge("right", "merge")
    gens = g.topological_generations()
    parallel_ids = {n.node_id for n in gens[1]}
    assert parallel_ids == {"left", "right"}


def test_cycle_detection() -> None:
    g = WorkflowGraph()
    for nid in ["a", "b", "c"]:
        g.add_node(_bash_node(nid))
    g.add_edge("a", "b")
    g.add_edge("b", "c")
    with pytest.raises(CycleError):
        g.add_edge("c", "a")


def test_self_loop_raises() -> None:
    g = WorkflowGraph()
    g.add_node(_bash_node("a"))
    with pytest.raises(CycleError):
        g.add_edge("a", "a")


def test_edge_to_unknown_node_raises() -> None:
    g = WorkflowGraph()
    g.add_node(_bash_node("a"))
    with pytest.raises(ValueError):
        g.add_edge("a", "nonexistent")
