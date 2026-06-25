from __future__ import annotations

from typing import TYPE_CHECKING

from rich.console import Console, ConsoleRenderable, Group, RichCast
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from gofer.core.graph import EdgeConditionType, GraphNode, WorkflowGraph
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
    FileOperation,
    FolderOperation,
    InfiniteFanSource,
    LocalSearchOperation,
    LocalVectorizeOperation,
    LoopOperation,
    MoveFileOperation,
    NotificationOperation,
    OpenResourceOperation,
    Operation,
    PromptFileOperation,
    PythonScriptOperation,
    ReadFileOperation,
    ShellScriptOperation,
    TabularFanSource,
    TriggerEventsFanSource,
    WriteFileOperation,
)

if TYPE_CHECKING:
    from gofer.core.workflow import AgenticWorkflow

_BOX_HEIGHT = 4  # lines per node box (top border + title + detail + bottom border)
_BOX_GAP = 1     # blank lines between boxes in a generation column
_BOX_WIDTH = 26  # inner width of node panel


def render_workflow(wf: AgenticWorkflow, console: Console) -> None:
    _render_header(wf, console)
    _render_dag(wf, console)
    _render_node_table(wf, console)


# ── Header ───────────────────────────────────────────────────────────────────


def _render_header(wf: AgenticWorkflow, console: Console) -> None:
    lines = Text()
    lines.append(wf.config.name, style="bold white")
    lines.append(f"  ({wf.config.id})", style="dim")

    meta_parts = [
        f"{len(wf.graph._nodes)} node{'s' if len(wf.graph._nodes) != 1 else ''}",
        f"{len(wf.agents)} agent{'s' if len(wf.agents) != 1 else ''}",
    ]
    lines.append(f"\n{' · '.join(meta_parts)}", style="dim")

    if wf.config.schedule:
        tz = wf.config.schedule.timezone
        lines.append(f"\nSchedule: {wf.config.schedule.cron_expression} ({tz})", style="dim cyan")

    console.print(Panel(lines, expand=False))


# ── Workflow Graph Visual ────────────────────────────────────────────────────


def _render_dag(wf: AgenticWorkflow, console: Console) -> None:
    generations = wf.graph.topological_generations()
    if not generations:
        console.print("[dim]No nodes.[/dim]")
        return

    grid = Table.grid(padding=(0, 1))
    for i in range(len(generations)):
        grid.add_column(f"gen_{i}", vertical="top")
        if i < len(generations) - 1:
            grid.add_column(f"arrow_{i}", vertical="top")

    cells: list[ConsoleRenderable | RichCast | str] = []
    for i, gen in enumerate(generations):
        boxes: list[Panel] = [_node_box(node) for node in gen]
        cells.append(Group(*boxes))
        if i < len(generations) - 1:
            cells.append(_build_arrow_column(gen, generations[i + 1], wf.graph))

    grid.add_row(*cells)
    console.print(Panel(grid, title="[bold]Workflow Graph[/bold]", expand=False))


def _node_box(node: GraphNode) -> Panel:
    icon, color = _op_icon_color(node.operation)
    detail = _op_detail(node.operation)

    content = Text()
    content.append(f"{icon} ", style=f"bold {color}")
    content.append(node.node_id, style="bold white")
    if detail:
        content.append(f"\n   {detail}", style="dim")

    extra: list[str] = []
    if node.retry_count:
        extra.append(f"retry×{node.retry_count}")
    if node.timeout_seconds is not None:
        extra.append(f"{int(node.timeout_seconds)}s")
    if extra:
        content.append(f"\n   {' · '.join(extra)}", style="dim italic")

    return Panel(content, width=_BOX_WIDTH, padding=(0, 1))


def _op_icon_color(op: Operation) -> tuple[str, str]:
    if isinstance(op, BashCommandOperation):
        return "$", "cyan"
    if isinstance(op, PythonScriptOperation):
        return "py", "green"
    if isinstance(op, ShellScriptOperation):
        return "sh", "yellow"
    if isinstance(op, ReadFileOperation):
        return "r", "blue"
    if isinstance(op, WriteFileOperation):
        return "w", "green"
    if isinstance(op, CopyFileOperation):
        return "cp", "blue"
    if isinstance(op, MoveFileOperation):
        return "mv", "yellow"
    if isinstance(op, DeleteFileOperation):
        return "rm", "red"
    if isinstance(op, FileOperation):
        return "file", "blue"
    if isinstance(op, FolderOperation):
        return "dir", "yellow"
    if isinstance(op, OpenResourceOperation):
        return "↗", "blue"
    if isinstance(op, PromptFileOperation):
        return "pr", "magenta"
    if isinstance(op, CommonLlmTaskOperation):
        return "llm", "magenta"
    if isinstance(op, LocalVectorizeOperation):
        return "idx", "green"
    if isinstance(op, LocalSearchOperation):
        return "srch", "blue"
    if isinstance(op, ApprovalGateOperation):
        return "ok?", "yellow"
    if isinstance(op, NotificationOperation):
        return "bell", "cyan"
    if isinstance(op, AgentOperation):
        return "@", "magenta"
    if isinstance(op, LoopOperation):
        return "loop", "blue"
    if isinstance(op, BreakOperation):
        return "brk", "yellow"
    return "?", "white"


def _op_detail(op: Operation) -> str:
    if isinstance(op, BashCommandOperation):
        cmd = op.command
        return cmd[:28] + "…" if len(cmd) > 29 else cmd
    if isinstance(op, PythonScriptOperation):
        return op.script_path.name
    if isinstance(op, ShellScriptOperation):
        return op.script_path.name
    if isinstance(op, ReadFileOperation):
        return f"read {op.path.name}"
    if isinstance(op, WriteFileOperation):
        return f"write {op.path.name}"
    if isinstance(op, CopyFileOperation):
        return f"{op.source_path.name} → {op.destination_path.name}"
    if isinstance(op, MoveFileOperation):
        return f"{op.source_path.name} → {op.destination_path.name}"
    if isinstance(op, DeleteFileOperation):
        return f"delete {op.path.name}"
    if isinstance(op, FileOperation):
        return op.path.name
    if isinstance(op, FolderOperation):
        return op.path.name
    if isinstance(op, OpenResourceOperation):
        target = op.target
        return target[:28] + "…" if len(target) > 29 else target
    if isinstance(op, PromptFileOperation):
        return f"write {op.output_path.name}"
    if isinstance(op, CommonLlmTaskOperation):
        return f"{op.task} via {op.agent_id}"
    if isinstance(op, LocalVectorizeOperation):
        return f"index {op.source_path.name}"
    if isinstance(op, LocalSearchOperation):
        return f"search {op.index_path.name}"
    if isinstance(op, ApprovalGateOperation):
        return "approval required"
    if isinstance(op, NotificationOperation):
        return op.title[:28] + "…" if len(op.title) > 29 else op.title
    if isinstance(op, AgentOperation):
        if op.skill_name:
            return f"{op.agent_id} /{op.skill_name}"
        return op.agent_id
    if isinstance(op, LoopOperation):
        if isinstance(op.source, TabularFanSource):
            return f"rows in {op.source.path.name}"
        if isinstance(op.source, DirectoryFanSource):
            return f"files in {op.source.path.name}/"
        if isinstance(op.source, CountFanSource):
            return f"×{op.source.count}"
        if isinstance(op.source, TriggerEventsFanSource):
            return "trigger events"
        if isinstance(op.source, InfiniteFanSource):
            return "until BREAK"
    if isinstance(op, BreakOperation):
        return op.message or "break loop"
    return ""


# ── Arrow Column ──────────────────────────────────────────────────────────────


def _condition_label(condition: EdgeConditionType) -> str:
    return {
        EdgeConditionType.ON_SUCCESS: "✓",
        EdgeConditionType.ON_FAILURE: "✗",
        EdgeConditionType.OUTPUT_MATCHES: "~",
        EdgeConditionType.AFTER_LOOP: "↧",
        EdgeConditionType.ALWAYS: " ",
    }[condition]


def _build_arrow_column(
    gen_left: list[GraphNode],
    gen_right: list[GraphNode],
    graph: WorkflowGraph,
    box_height: int = _BOX_HEIGHT,
    box_gap: int = _BOX_GAP,
) -> Text:
    def center_row(i: int) -> int:
        return i * (box_height + box_gap) + 1

    left_ids = [n.node_id for n in gen_left]
    right_ids = [n.node_id for n in gen_right]

    total_left = len(gen_left) * (box_height + box_gap) - box_gap
    total_right = len(gen_right) * (box_height + box_gap) - box_gap
    total_rows = max(total_left, total_right)

    # rows[i] is a list of chars; we'll overlay multiple edges
    rows: list[list[str]] = [[" " for _ in range(9)] for _ in range(total_rows)]

    def set_row(r: int, s: str) -> None:
        if 0 <= r < total_rows:
            for i, ch in enumerate(s):
                if i < 9 and ch != " ":
                    rows[r][i] = ch

    edges = [
        (left_ids.index(u), right_ids.index(v), graph.get_edge_config(u, v).condition)
        for (u, v) in graph._edges
        if u in left_ids and v in right_ids
    ]

    for li, ri, condition in edges:
        src = center_row(li)
        dst = center_row(ri)
        label = _condition_label(condition)

        if src == dst:
            set_row(src, f"──{label}───▶")
        elif src < dst:
            # fan down: ╮ at src, │ down, ╰──▶ at dst
            set_row(src, f"──{label}──╮ ")
            for r in range(src + 1, dst):
                set_row(r, "       │")
            set_row(dst, "       ╰▶")
        else:
            # fan up: ╯ at src, │ up, ╭──▶ at dst
            set_row(src, "       ╯ ")
            for r in range(dst + 1, src):
                set_row(r, "       │")
            set_row(dst, f"──{label}──╭▶")

    lines = ["".join(row) for row in rows]
    return Text("\n".join(lines), style="dim")


# ── Node Detail Table ─────────────────────────────────────────────────────────


def _loop_cell(op: Operation) -> str:
    if not isinstance(op, LoopOperation):
        return "—"
    if isinstance(op.source, TabularFanSource):
        return f"tabular/{op.source.path.suffix.lstrip('.')}"
    if isinstance(op.source, DirectoryFanSource):
        return f"dir glob={op.source.glob}"
    if isinstance(op.source, CountFanSource):
        return f"count={op.source.count}"
    if isinstance(op.source, TriggerEventsFanSource):
        return "trigger events"
    if isinstance(op.source, InfiniteFanSource):
        return "infinite"
    return "—"


def _render_node_table(wf: AgenticWorkflow, console: Console) -> None:
    table = Table(
        "Node", "Type", "Detail", "Loop", "Retry", "Timeout",
        title="[bold]Nodes[/bold]",
        show_lines=False,
        header_style="bold",
    )

    for gen in wf.graph.topological_generations():
        for node in gen:
            op = node.operation
            _, color = _op_icon_color(op)
            op_name = op.type.value.replace("_", " ")
            retry = str(node.retry_count) if node.retry_count else "—"
            timeout = f"{int(node.timeout_seconds)}s" if node.timeout_seconds else "—"
            table.add_row(
                Text(node.node_id, style="bold white"),
                Text(op_name, style=color),
                _op_detail(op),
                _loop_cell(op),
                retry,
                timeout,
            )

    console.print(table)
