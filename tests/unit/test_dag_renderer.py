from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import pytest
from rich.console import Console
from rich.panel import Panel
from typer.testing import CliRunner

from gofer.cli.dag_renderer import (
    _build_arrow_column,
    _condition_label,
    _loop_cell,
    _node_box,
    _op_detail,
    _op_icon_color,
    render_workflow,
)
from gofer.cli.main import app
from gofer.core.agent import AgentConfig
from gofer.core.graph import EdgeConditionType, EdgeConfig, GraphNode, WorkflowGraph
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
    InfiniteFanSource,
    LocalSearchOperation,
    LocalVectorizeOperation,
    LoopOperation,
    MoveFileOperation,
    NotificationOperation,
    OpenResourceOperation,
    OperationType,
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
from gofer.core.workflow import AgenticWorkflow, ScheduleConfig, WorkflowConfig

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


@pytest.mark.parametrize(
    ("op", "expected_icon", "expected_color"),
    [
        (StartOperation(type=OperationType.START), "?", "white"),
        (PassOperation(type=OperationType.PASS, message="ok"), "?", "white"),
        (FailOperation(type=OperationType.FAIL, message="bad"), "?", "white"),
        (BreakOperation(type=OperationType.BREAK, message="stop"), "brk", "yellow"),
        (
            LoopOperation(
                type=OperationType.LOOP,
                source=CountFanSource(type="count", count=3),
            ),
            "loop",
            "blue",
        ),
        (BashCommandOperation(type=OperationType.BASH_COMMAND, command="x"), "$", "cyan"),
        (
            PythonScriptOperation(type=OperationType.PYTHON_SCRIPT, script_path=Path("x.py")),
            "py",
            "green",
        ),
        (
            ShellScriptOperation(type=OperationType.SHELL_SCRIPT, script_path=Path("x.sh")),
            "sh",
            "yellow",
        ),
        (ReadFileOperation(type=OperationType.READ_FILE, path=Path("input.txt")), "r", "blue"),
        (
            WriteFileOperation(type=OperationType.WRITE_FILE, path=Path("out.txt")),
            "w",
            "green",
        ),
        (
            CopyFileOperation(
                type=OperationType.COPY_FILE,
                source_path=Path("a.txt"),
                destination_path=Path("b.txt"),
            ),
            "cp",
            "blue",
        ),
        (
            MoveFileOperation(
                type=OperationType.MOVE_FILE,
                source_path=Path("a.txt"),
                destination_path=Path("b.txt"),
            ),
            "mv",
            "yellow",
        ),
        (DeleteFileOperation(type=OperationType.DELETE_FILE, path=Path("old.txt")), "rm", "red"),
        (FileOperation(type=OperationType.FILE, path=Path("data.csv")), "file", "blue"),
        (FolderOperation(type=OperationType.FOLDER, path=Path("data")), "dir", "yellow"),
        (
            OpenResourceOperation(type=OperationType.OPEN_RESOURCE, target="https://example.test"),
            "↗",
            "blue",
        ),
        (
            PromptFileOperation(type=OperationType.PROMPT_FILE, output_path=Path("prompt.md")),
            "pr",
            "magenta",
        ),
        (
            CommonLlmTaskOperation(
                type=OperationType.COMMON_LLM_TASK,
                agent_id="writer",
                task="summarize",
                working_dir=Path("/tmp"),
            ),
            "llm",
            "magenta",
        ),
        (
            LocalVectorizeOperation(
                type=OperationType.LOCAL_VECTORIZE,
                source_path=Path("docs"),
                index_path=Path("index"),
            ),
            "idx",
            "green",
        ),
        (
            LocalSearchOperation(
                type=OperationType.LOCAL_SEARCH,
                index_path=Path("index"),
                query="find it",
            ),
            "srch",
            "blue",
        ),
        (
            ApprovalGateOperation(
                type=OperationType.APPROVAL_GATE,
                message="Approve?",
            ),
            "ok?",
            "yellow",
        ),
        (
            NotificationOperation(type=OperationType.NOTIFICATION, title="Heads up"),
            "bell",
            "cyan",
        ),
        (
            AgentOperation(
                type=OperationType.AGENT,
                agent_id="codex",
                prompt_path=Path("p.md"),
                working_dir=Path("/tmp"),
            ),
            "@",
            "magenta",
        ),
    ],
)
def test_op_icon_color_all_operation_types(
    op: Any,
    expected_icon: str,
    expected_color: str,
) -> None:
    assert _op_icon_color(op) == (expected_icon, expected_color)


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
        working_dir=Path("/"),
    )
    assert _op_detail(op) == "summarizer"


@pytest.mark.parametrize(
    ("op", "expected"),
    [
        (StartOperation(type=OperationType.START), ""),
        (PassOperation(type=OperationType.PASS, message="ok"), ""),
        (FailOperation(type=OperationType.FAIL, message="bad"), ""),
        (BreakOperation(type=OperationType.BREAK, message="stop now"), "stop now"),
        (BreakOperation(type=OperationType.BREAK), "break loop"),
        (
            LoopOperation(
                type=OperationType.LOOP,
                source=TabularFanSource(type="tabular", path=Path("items.csv")),
            ),
            "rows in items.csv",
        ),
        (
            LoopOperation(
                type=OperationType.LOOP,
                source=DirectoryFanSource(type="directory", path=Path("docs")),
            ),
            "files in docs/",
        ),
        (
            LoopOperation(
                type=OperationType.LOOP,
                source=CountFanSource(type="count", count=5),
            ),
            "×5",
        ),
        (
            LoopOperation(
                type=OperationType.LOOP,
                source=TriggerEventsFanSource(type="trigger_events"),
            ),
            "trigger events",
        ),
        (
            LoopOperation(
                type=OperationType.LOOP,
                source=InfiniteFanSource(type="infinite"),
            ),
            "until BREAK",
        ),
        (ReadFileOperation(type=OperationType.READ_FILE, path=Path("input.txt")), "read input.txt"),
        (
            WriteFileOperation(type=OperationType.WRITE_FILE, path=Path("out.txt")),
            "write out.txt",
        ),
        (
            CopyFileOperation(
                type=OperationType.COPY_FILE,
                source_path=Path("a.txt"),
                destination_path=Path("b.txt"),
            ),
            "a.txt → b.txt",
        ),
        (
            MoveFileOperation(
                type=OperationType.MOVE_FILE,
                source_path=Path("a.txt"),
                destination_path=Path("b.txt"),
            ),
            "a.txt → b.txt",
        ),
        (
            DeleteFileOperation(type=OperationType.DELETE_FILE, path=Path("old.txt")),
            "delete old.txt",
        ),
        (FileOperation(type=OperationType.FILE, path=Path("data.csv")), "data.csv"),
        (FolderOperation(type=OperationType.FOLDER, path=Path("reports")), "reports"),
        (
            OpenResourceOperation(type=OperationType.OPEN_RESOURCE, target="https://example.test"),
            "https://example.test",
        ),
        (
            PromptFileOperation(type=OperationType.PROMPT_FILE, output_path=Path("prompt.md")),
            "write prompt.md",
        ),
        (
            CommonLlmTaskOperation(
                type=OperationType.COMMON_LLM_TASK,
                agent_id="writer",
                task="review",
                working_dir=Path("/tmp"),
            ),
            "review via writer",
        ),
        (
            LocalVectorizeOperation(
                type=OperationType.LOCAL_VECTORIZE,
                source_path=Path("docs"),
                index_path=Path("index"),
            ),
            "index docs",
        ),
        (
            LocalSearchOperation(
                type=OperationType.LOCAL_SEARCH,
                index_path=Path("index"),
                query="find it",
            ),
            "search index",
        ),
        (
            ApprovalGateOperation(
                type=OperationType.APPROVAL_GATE,
                message="Approve?",
            ),
            "approval required",
        ),
        (
            NotificationOperation(type=OperationType.NOTIFICATION, title="Heads up"),
            "Heads up",
        ),
        (
            AgentOperation(
                type=OperationType.AGENT,
                agent_id="codex",
                prompt_path=Path("p.md"),
                working_dir=Path("/tmp"),
                skill_name="fix-ci",
            ),
            "codex /fix-ci",
        ),
    ],
)
def test_op_detail_all_operation_types(op: Any, expected: str) -> None:
    assert _op_detail(op) == expected


def test_op_detail_open_resource_truncation() -> None:
    target = "https://example.test/" + ("long/" * 12)
    detail = _op_detail(OpenResourceOperation(type=OperationType.OPEN_RESOURCE, target=target))
    assert detail.endswith("…")
    assert len(detail) <= 29


@pytest.mark.parametrize(
    ("op", "expected"),
    [
        (
            LoopOperation(
                type=OperationType.LOOP,
                source=TabularFanSource(type="tabular", path=Path("items.jsonl")),
            ),
            "tabular/jsonl",
        ),
        (
            LoopOperation(
                type=OperationType.LOOP,
                source=DirectoryFanSource(type="directory", path=Path("docs"), glob="**/*.md"),
            ),
            "dir glob=**/*.md",
        ),
        (
            LoopOperation(
                type=OperationType.LOOP,
                source=CountFanSource(type="count", count=7),
            ),
            "count=7",
        ),
        (
            LoopOperation(
                type=OperationType.LOOP,
                source=TriggerEventsFanSource(type="trigger_events"),
            ),
            "trigger events",
        ),
        (
            LoopOperation(
                type=OperationType.LOOP,
                source=InfiniteFanSource(type="infinite"),
            ),
            "infinite",
        ),
        (BashCommandOperation(type=OperationType.BASH_COMMAND, command="echo hi"), "—"),
    ],
)
def test_loop_cell_supported_sources(op: Any, expected: str) -> None:
    assert _loop_cell(op) == expected


# ── _condition_label ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("condition,expected", [
    (EdgeConditionType.ON_SUCCESS, "✓"),
    (EdgeConditionType.ON_FAILURE, "✗"),
    (EdgeConditionType.OUTPUT_MATCHES, "~"),
    (EdgeConditionType.AFTER_LOOP, "↧"),
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


def test_build_arrow_column_fan_in() -> None:
    g = WorkflowGraph()
    for node_id in ["src1", "src2", "dst"]:
        g.add_node(_bash_node(node_id))
    g.add_edge("src1", "dst", EdgeConfig(from_node="src1", to_node="dst"))
    g.add_edge("src2", "dst", EdgeConfig(from_node="src2", to_node="dst"))

    text = _build_arrow_column([g._nodes["src1"], g._nodes["src2"]], [g._nodes["dst"]], g)

    assert "╯" in text.plain
    assert "╭" in text.plain
    assert "▶" in text.plain


def test_build_arrow_column_downward_routing() -> None:
    g = WorkflowGraph()
    for node_id in ["src", "dst1", "dst2", "dst3"]:
        g.add_node(_bash_node(node_id))
    g.add_edge("src", "dst3", EdgeConfig(from_node="src", to_node="dst3"))

    text = _build_arrow_column(
        [g._nodes["src"]],
        [g._nodes["dst1"], g._nodes["dst2"], g._nodes["dst3"]],
        g,
    )

    assert "╮" in text.plain
    assert "│" in text.plain
    assert "╰▶" in text.plain


def test_build_arrow_column_upward_routing() -> None:
    g = WorkflowGraph()
    for node_id in ["src1", "src2", "src3", "dst"]:
        g.add_node(_bash_node(node_id))
    g.add_edge("src3", "dst", EdgeConfig(from_node="src3", to_node="dst"))

    text = _build_arrow_column(
        [g._nodes["src1"], g._nodes["src2"], g._nodes["src3"]],
        [g._nodes["dst"]],
        g,
    )

    assert "╯" in text.plain
    assert "│" in text.plain
    assert "╭▶" in text.plain


def test_build_arrow_column_overlapping_edges() -> None:
    g = WorkflowGraph()
    for node_id in ["left1", "left2", "right1", "right2", "right3"]:
        g.add_node(_bash_node(node_id))
    g.add_edge("left1", "right3", EdgeConfig(from_node="left1", to_node="right3"))
    g.add_edge("left2", "right3", EdgeConfig(from_node="left2", to_node="right3"))

    text = _build_arrow_column(
        [g._nodes["left1"], g._nodes["left2"]],
        [g._nodes["right1"], g._nodes["right2"], g._nodes["right3"]],
        g,
    )

    assert "╮" in text.plain
    assert "│" in text.plain
    assert "╰▶" in text.plain


def test_build_arrow_column_condition_on_success() -> None:
    g = _make_graph_with_edge("a", "b", EdgeConditionType.ON_SUCCESS)
    text = _build_arrow_column([g._nodes["a"]], [g._nodes["b"]], g)
    assert "✓" in text.plain


def test_build_arrow_column_condition_on_failure() -> None:
    g = _make_graph_with_edge("a", "b", EdgeConditionType.ON_FAILURE)
    text = _build_arrow_column([g._nodes["a"]], [g._nodes["b"]], g)
    assert "✗" in text.plain


def test_build_arrow_column_condition_output_matches() -> None:
    g = _make_graph_with_edge("a", "b", EdgeConditionType.OUTPUT_MATCHES)
    text = _build_arrow_column([g._nodes["a"]], [g._nodes["b"]], g)
    assert "~" in text.plain


def test_build_arrow_column_condition_after_loop() -> None:
    g = _make_graph_with_edge("a", "b", EdgeConditionType.AFTER_LOOP)
    text = _build_arrow_column([g._nodes["a"]], [g._nodes["b"]], g)
    assert "↧" in text.plain


def test_build_arrow_column_condition_always_has_no_status_label() -> None:
    g = _make_graph_with_edge("a", "b", EdgeConditionType.ALWAYS)
    text = _build_arrow_column([g._nodes["a"]], [g._nodes["b"]], g)
    assert "▶" in text.plain
    assert "✓" not in text.plain
    assert "✗" not in text.plain
    assert "~" not in text.plain
    assert "↧" not in text.plain


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


def test_render_workflow_shows_multiple_agents() -> None:
    wf = AgenticWorkflow(WorkflowConfig(id="agent-wf", name="Agent Workflow"))
    wf.register_agent(
        AgentConfig(agent_id="codex", subscription="codex", working_dir=Path("/tmp"))
    )
    wf.register_agent(
        AgentConfig(agent_id="claude", subscription="claude_code", working_dir=Path("/tmp"))
    )
    wf.add_operation(_agent_node("ask-codex", "codex"))

    console, buf = _console()
    render_workflow(wf, console)

    assert "1 node" in buf.getvalue()
    assert "2 agents" in buf.getvalue()


def test_render_workflow_shows_retry_and_timeout() -> None:
    wf = AgenticWorkflow(WorkflowConfig(id="retry-wf", name="Retry Workflow"))
    wf.add_operation(
        GraphNode(
            node_id="fragile",
            operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="exit 1"),
            retry_count=2,
            timeout_seconds=30,
        )
    )

    console, buf = _console()
    render_workflow(wf, console)
    out = buf.getvalue()

    assert "retry" in out
    assert "2" in out
    assert "30s" in out


def test_render_workflow_mixed_operation_table() -> None:
    wf = AgenticWorkflow(WorkflowConfig(id="mixed-wf", name="Mixed Workflow"))
    nodes = [
        GraphNode(
            node_id="read-config",
            operation=ReadFileOperation(type=OperationType.READ_FILE, path=Path("config.toml")),
        ),
        GraphNode(
            node_id="write-report",
            operation=WriteFileOperation(type=OperationType.WRITE_FILE, path=Path("report.md")),
        ),
        GraphNode(
            node_id="copy-artifact",
            operation=CopyFileOperation(
                type=OperationType.COPY_FILE,
                source_path=Path("report.md"),
                destination_path=Path("dist/report.md"),
            ),
        ),
        GraphNode(
            node_id="delete-temp",
            operation=DeleteFileOperation(type=OperationType.DELETE_FILE, path=Path("tmp.txt")),
        ),
        GraphNode(
            node_id="search-index",
            operation=LocalSearchOperation(
                type=OperationType.LOCAL_SEARCH,
                index_path=Path("index"),
                query="needle",
            ),
        ),
    ]
    for node in nodes:
        wf.add_operation(node)

    console, buf = _console()
    render_workflow(wf, console)
    out = buf.getvalue()

    assert "read file" in out
    assert "write report.md" in out
    assert "copy file" in out
    assert "delete tmp.txt" in out
    assert "search index" in out


def test_render_workflow_shows_loop_table_cells() -> None:
    wf = AgenticWorkflow(WorkflowConfig(id="loop-wf", name="Loop Workflow"))
    wf.add_operation(
        GraphNode(
            node_id="each-file",
            operation=LoopOperation(
                type=OperationType.LOOP,
                source=DirectoryFanSource(type="directory", path=Path("docs"), glob="*.md"),
            ),
        )
    )

    console, buf = _console()
    render_workflow(wf, console)

    assert "files in docs/" in buf.getvalue()
    assert "dir glob=*.md" in buf.getvalue()


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
