from __future__ import annotations

import io
from pathlib import Path

import pytest
from rich.console import Console
from rich.panel import Panel
from typer.testing import CliRunner

from agentic_task_manager.cli.dag_renderer import (
    _build_arrow_column,
    _condition_label,
    _node_box,
    _op_detail,
    _op_icon_color,
    render_workflow,
)
from agentic_task_manager.cli.main import app
from agentic_task_manager.core.graph import EdgeConditionType, EdgeConfig, GraphNode, WorkflowGraph
from agentic_task_manager.core.operations import (
    AgentOperation,
    BashCommandOperation,
    OperationType,
    PythonScriptOperation,
    ShellScriptOperation,
)
from agentic_task_manager.core.workflow import AgenticWorkflow, WorkflowConfig

runner = CliRunner()


def _console() -> tuple[Console, io.StringIO]:
    buf = io.StringIO()
    return Console(file=buf, force_terminal=False, highlight=False), buf


def _bash_node(node_id: str, command: str = "echo hello") -> GraphNode:
    return GraphNode(
        node_id=node_id,
        operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command=command),
    )


def _agent_node(node_id: str, agent_id: str = "my-agent") -> GraphNode:
    return GraphNode(
        node_id=node_id,
        operation=AgentOperation(
            type=OperationType.AGENT,
            agent_id=agent_id,
            prompt_path=Path("prompts/test.md"),
            working_dir=Path("/tmp"),
        ),
    )


# ── _op_icon_color ────────────────────────────────────────────────────────────


def test_op_icon_color_bash() -> None:
    icon, color = _op_icon_color(BashCommandOperation(type=OperationType.BASH_COMMAND, command="x"))
    assert icon == "$"
    assert color == "cyan"


def test_op_icon_color_python() -> None:
    icon, color = _op_icon_color(
        PythonScriptOperation(type=OperationType.PYTHON_SCRIPT, script_path=Path("x.py"))
    )
    assert icon == "py"
    assert color == "green"


def test_op_icon_color_shell() -> None:
    icon, color = _op_icon_color(
        ShellScriptOperation(type=OperationType.SHELL_SCRIPT, script_path=Path("x.sh"))
    )
    assert icon == "sh"
    assert color == "yellow"


def test_op_icon_color_agent() -> None:
    icon, color = _op_icon_color(
        AgentOperation(
            type=OperationType.AGENT, agent_id="a", prompt_path=Path("p.md"), working_dir=Path("/")
        )
    )
    assert icon == "@"
    assert color == "magenta"


# ── _op_detail ────────────────────────────────────────────────────────────────


def test_op_detail_bash_short() -> None:
    op = BashCommandOperation(type=OperationType.BASH_COMMAND, command="echo hi")
    assert _op_detail(op) == "echo hi"


def test_op_detail_bash_truncation() -> None:
    long_cmd = "echo " + "x" * 60
    detail = _op_detail(BashCommandOperation(type=OperationType.BASH_COMMAND, command=long_cmd))
    assert detail.endswith("…")
    assert len(detail) <= 29


def test_op_detail_python() -> None:
    op = PythonScriptOperation(type=OperationType.PYTHON_SCRIPT, script_path=Path("scripts/run.py"))
    assert _op_detail(op) == "run.py"


def test_op_detail_shell() -> None:
    op = ShellScriptOperation(type=OperationType.SHELL_SCRIPT, script_path=Path("scripts/run.sh"))
    assert _op_detail(op) == "run.sh"


def test_op_detail_agent() -> None:
    op = AgentOperation(
        type=OperationType.AGENT,
        agent_id="summarizer",
        prompt_path=Path("p.md"),
        working_dir=Path("/")
    )
    assert _op_detail(op) == "summarizer"


# ── _condition_label ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("condition,expected", [
    (EdgeConditionType.ON_SUCCESS, "✓"),
    (EdgeConditionType.ON_FAILURE, "✗"),
    (EdgeConditionType.OUTPUT_MATCHES, "~"),
    (EdgeConditionType.ALWAYS, " "),
])
def test_condition_label(condition: EdgeConditionType, expected: str) -> None:
    assert _condition_label(condition) == expected


# ── _node_box ─────────────────────────────────────────────────────────────────


def test_node_box_returns_panel() -> None:
    node = _bash_node("setup")
    box = _node_box(node)
    assert isinstance(box, Panel)


def test_node_box_contains_node_id() -> None:
    node = _bash_node("my-node")
    box = _node_box(node)
    console, buf = _console()
    console.print(box)
    assert "my-node" in buf.getvalue()


def test_node_box_shows_retry_and_timeout() -> None:
    node = GraphNode(
        node_id="retried",
        operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="x"),
        retry_count=3,
        timeout_seconds=60.0,
    )
    console, buf = _console()
    console.print(_node_box(node))
    out = buf.getvalue()
    assert "retry" in out
    assert "60s" in out


# ── _build_arrow_column ───────────────────────────────────────────────────────


def _make_graph_with_edge(
    left_id: str,
    right_id: str,
    condition: EdgeConditionType = EdgeConditionType.ALWAYS,
) -> WorkflowGraph:
    g = WorkflowGraph()
    g.add_node(_bash_node(left_id))
    g.add_node(_bash_node(right_id))
    g.add_edge(
        left_id, right_id, EdgeConfig(from_node=left_id, to_node=right_id, condition=condition)
    )
    return g


def test_build_arrow_column_straight() -> None:
    g = _make_graph_with_edge("a", "b")
    left = [g._nodes["a"]]
    right = [g._nodes["b"]]
    text = _build_arrow_column(left, right, g)
    assert "▶" in text.plain


def test_build_arrow_column_fan_out() -> None:
    g = WorkflowGraph()
    g.add_node(_bash_node("src"))
    g.add_node(_bash_node("dst1"))
    g.add_node(_bash_node("dst2"))
    g.add_edge("src", "dst1", EdgeConfig(from_node="src", to_node="dst1"))
    g.add_edge("src", "dst2", EdgeConfig(from_node="src", to_node="dst2"))

    left = [g._nodes["src"]]
    right = [g._nodes["dst1"], g._nodes["dst2"]]
    text = _build_arrow_column(left, right, g)
    assert "╮" in text.plain
    assert "╰" in text.plain


def test_build_arrow_column_condition_on_success() -> None:
    g = _make_graph_with_edge("a", "b", EdgeConditionType.ON_SUCCESS)
    text = _build_arrow_column([g._nodes["a"]], [g._nodes["b"]], g)
    assert "✓" in text.plain


def test_build_arrow_column_condition_on_failure() -> None:
    g = _make_graph_with_edge("a", "b", EdgeConditionType.ON_FAILURE)
    text = _build_arrow_column([g._nodes["a"]], [g._nodes["b"]], g)
    assert "✗" in text.plain


# ── render_workflow ───────────────────────────────────────────────────────────


def _make_workflow(nodes_edges: list[tuple[str, str]] | None = None) -> AgenticWorkflow:
    wf = AgenticWorkflow(WorkflowConfig(id="test-wf", name="Test Workflow"))
    wf.add_operation(_bash_node("node-a"))
    wf.add_operation(_bash_node("node-b"))
    wf.add_operation(_bash_node("node-c"))
    if nodes_edges is None:
        wf.then("node-a", "node-b")
        wf.then("node-a", "node-c")
    else:
        for u, v in nodes_edges:
            wf.then(u, v)
    return wf


def test_render_workflow_smoke() -> None:
    wf = _make_workflow()
    console, buf = _console()
    render_workflow(wf, console)
    out = buf.getvalue()
    assert "node-a" in out
    assert "node-b" in out
    assert "node-c" in out


def test_render_workflow_shows_name_and_id() -> None:
    wf = _make_workflow()
    console, buf = _console()
    render_workflow(wf, console)
    out = buf.getvalue()
    assert "Test Workflow" in out
    assert "test-wf" in out


def test_render_workflow_with_schedule() -> None:
    from agentic_task_manager.core.workflow import ScheduleConfig

    wf = AgenticWorkflow(
        WorkflowConfig(
            id="sched-wf",
            name="Scheduled",
            schedule=ScheduleConfig(cron_expression="0 9 * * 1-5", timezone="UTC"),
        )
    )
    wf.add_operation(_bash_node("step"))
    console, buf = _console()
    render_workflow(wf, console)
    assert "0 9 * * 1-5" in buf.getvalue()


def test_render_empty_workflow() -> None:
    wf = AgenticWorkflow(WorkflowConfig(id="empty", name="Empty"))
    console, buf = _console()
    render_workflow(wf, console)
    assert "No nodes" in buf.getvalue()


# ── CLI integration ───────────────────────────────────────────────────────────


_SHOW_TOML = """
[workflow]
id = "show-test"
name = "Show Test Workflow"

[[nodes]]
id = "alpha"
type = "bash_command"
command = "echo alpha"

[[nodes]]
id = "beta"
type = "bash_command"
command = "echo beta"

[[edges]]
from = "alpha"
to = "beta"
condition = "on_success"
"""


def test_show_command_exits_zero(tmp_path: Path) -> None:
    f = tmp_path / "wf.toml"
    f.write_text(_SHOW_TOML)
    result = runner.invoke(app, ["workflow", "show", str(f)])
    assert result.exit_code == 0, result.output


def test_show_command_output_contains_nodes(tmp_path: Path) -> None:
    f = tmp_path / "wf.toml"
    f.write_text(_SHOW_TOML)
    result = runner.invoke(app, ["workflow", "show", str(f)])
    assert "alpha" in result.output
    assert "beta" in result.output
    assert "Show Test Workflow" in result.output


def test_show_command_missing_workflow(tmp_path: Path) -> None:
    result = runner.invoke(
        app, ["workflow", "show", "nonexistent-workflow-id", "--data-dir", str(tmp_path)]
    )
    assert result.exit_code != 0
