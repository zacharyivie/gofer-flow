from __future__ import annotations

import pytest

from gofer.core.graph import GraphNode, WorkflowGraph
from gofer.core.operations import BashCommandOperation, OperationType, StartOperation


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


def test_cycles_are_allowed() -> None:
    g = WorkflowGraph()
    for nid in ["a", "b", "c"]:
        g.add_node(_bash_node(nid))
    g.add_edge("a", "b")
    g.add_edge("b", "c")
    g.add_edge("c", "a")
    g.validate()


def test_self_loop_is_allowed() -> None:
    g = WorkflowGraph()
    g.add_node(_bash_node("a"))
    g.add_edge("a", "a")
    g.validate()


def test_special_nodes_must_be_unique() -> None:
    g = WorkflowGraph()
    g.add_node(GraphNode(
        node_id="start-a",
        operation=StartOperation(type=OperationType.START),
    ))
    g.add_node(GraphNode(
        node_id="start-b",
        operation=StartOperation(type=OperationType.START),
    ))

    with pytest.raises(ValueError, match="one START node"):
        g.validate()


def test_special_node_label_is_forced() -> None:
    node = GraphNode(
        node_id="start",
        label="Custom start label",
        operation=StartOperation(type=OperationType.START),
    )

    assert node.label == "START"


def test_edge_to_unknown_node_raises() -> None:
    g = WorkflowGraph()
    g.add_node(_bash_node("a"))
    with pytest.raises(ValueError):
        g.add_edge("a", "nonexistent")
