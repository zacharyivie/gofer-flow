"""Interactive terminal editors for workflow and agent configs."""

from __future__ import annotations

import enum
import io
import shutil
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import questionary
except ImportError:  # pragma: no cover - exercised only in minimal test envs
    questionary = None
from prompt_toolkit import Application
from prompt_toolkit.formatted_text import ANSI
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.key_binding.key_processor import KeyPressEvent
from prompt_toolkit.layout import Layout
from prompt_toolkit.layout.containers import Window
from prompt_toolkit.layout.controls import FormattedTextControl

try:
    from rich.console import Console
    from rich.style import Style
    from rich.text import Text
except ImportError:  # pragma: no cover - exercised only in minimal test envs
    class Style:  # type: ignore[no-redef]
        def __init__(self, **kwargs: Any) -> None:
            self.kwargs = kwargs

    class Text(str):  # type: ignore[no-redef]
        def __new__(cls, text: str = "", style: Style | None = None):
            obj = str.__new__(cls, text)
            obj.style = style
            return obj

        def append(self, text: str, style: Style | None = None) -> None:
            return None

        def stylize(
            self,
            style: Style,
            start: int | None = None,
            end: int | None = None,
        ) -> None:
            return None

    class Console:  # type: ignore[no-redef]
        def __init__(self, file: io.StringIO, **kwargs: Any) -> None:
            self.file = file

        def print(self, line: Any, end: str = "\n", markup: bool = False) -> None:
            self.file.write(f"{line}{end}")

from legacy.gofer.core.agent import AgentConfig
from legacy.gofer.core.graph import CycleError, EdgeConditionType, EdgeConfig, GraphNode
from legacy.gofer.core.operations import (
    AgentOperation,
    BashCommandOperation,
    OperationType,
    PythonScriptOperation,
    ShellScriptOperation,
)
from legacy.gofer.core.workflow import AgenticWorkflow, ScheduleConfig

# ── Field descriptor types ───────────────────────────────────────────────────


_AnyOp = (
    BashCommandOperation | PythonScriptOperation | ShellScriptOperation | AgentOperation
)


class FieldKind(enum.Enum):
    STRING = "string"
    PATH = "path"
    INT = "int"
    FLOAT = "float"
    BOOL = "bool"
    LIST_STR = "list"
    DICT_STR_STR = "dict"
    CHOICE = "choice"


def _no_op_validator(v: Any) -> str | None:  # noqa: ANN401
    return None


@dataclass
class FieldDescriptor:
    key: str
    label: str
    kind: FieldKind
    value: Any  # noqa: ANN401
    optional: bool = False
    choices: list[str] = field(default_factory=list)
    default: Any = None  # noqa: ANN401
    validator: Callable[[Any], str | None] = field(
        default_factory=lambda: _no_op_validator
    )
    read_only: bool = False


@dataclass
class Section:
    title: str
    fields: list[FieldDescriptor]


# ── Value formatting and coercion ────────────────────────────────────────────


def _format_value(fd: FieldDescriptor) -> str:
    v = fd.value
    if v is None:
        return "(none)"
    if fd.kind == FieldKind.LIST_STR:
        items = v if isinstance(v, list) else []
        return ", ".join(str(i) for i in items) if items else "(empty)"
    if fd.kind == FieldKind.DICT_STR_STR:
        d = v if isinstance(v, dict) else {}
        return ", ".join(f"{k}={val}" for k, val in d.items()) if d else "(empty)"
    if fd.kind == FieldKind.BOOL:
        return "yes" if v else "no"
    return str(v)


def _coerce(kind: FieldKind, raw: str) -> Any:  # noqa: ANN401
    match kind:
        case FieldKind.INT:
            return int(raw)
        case FieldKind.FLOAT:
            return float(raw)
        case FieldKind.PATH:
            return Path(raw).expanduser()
        case _:
            return raw


# ── Flat field editor ────────────────────────────────────────────────────────


_LABEL_W = 22
_VALUE_W = 36
_HELP = " [↑↓] Navigate   [Enter] Edit   [Del] Clear   [s] Save   [q] Quit"
_SECTION_WIDTH = 70


class FieldEditorApp:
    def __init__(self, sections: list[Section], title: str = "Editor") -> None:
        self._sections = sections
        self._title = title
        self._flat: list[FieldDescriptor] = [
            fd for sec in sections for fd in sec.fields
        ]
        self._cursor = 0
        self._scroll_offset = 0
        self._error: str | None = None
        self._saved = False

    def run(self) -> bool:
        self._pending_edit: FieldDescriptor | None = None

        while True:
            kb = self._build_key_bindings()
            layout = Layout(
                Window(
                    content=FormattedTextControl(
                        self._get_formatted_text, focusable=True
                    ),
                    wrap_lines=False,
                )
            )
            app: Application[None] = Application(
                layout=layout,
                key_bindings=kb,
                full_screen=True,
                mouse_support=False,
            )
            app.run()

            if self._pending_edit is not None:
                print("\033[2J\033[H", end="", flush=True)
                self._edit_field(self._pending_edit)
                self._pending_edit = None
            else:
                break

        return self._saved

    def _get_formatted_text(self) -> ANSI:
        term = shutil.get_terminal_size(fallback=(120, 40))
        height = max(5, term.lines - 1)
        width = term.columns

        all_lines, cursor_line = self._render_all()

        if cursor_line < self._scroll_offset:
            self._scroll_offset = cursor_line
        elif cursor_line >= self._scroll_offset + height - 2:
            self._scroll_offset = max(0, cursor_line - height + 3)

        visible = all_lines[self._scroll_offset : self._scroll_offset + height]

        buf = io.StringIO()
        console = Console(
            file=buf, force_terminal=True, highlight=False, width=width
        )
        for line in visible:
            console.print(line, end="\n", markup=False)

        return ANSI(buf.getvalue())

    def _render_all(self) -> tuple[list[Text], int]:
        lines: list[Text] = []
        cursor_line = 0
        flat_idx = 0

        lines.append(Text(f"  {self._title}", style=Style(bold=True, color="cyan")))
        lines.append(Text(""))

        for sec in self._sections:
            pad = max(0, _SECTION_WIDTH - len(sec.title) - 5)
            lines.append(
                Text(
                    f"  ── {sec.title} " + "─" * pad,
                    style=Style(dim=True),
                )
            )

            for fd in sec.fields:
                is_cursor = flat_idx == self._cursor
                if is_cursor:
                    cursor_line = len(lines)
                lines.append(self._render_field_row(fd, is_cursor))
                flat_idx += 1

            lines.append(Text(""))

        if self._error:
            lines.append(Text(f"  ✖ {self._error}", style=Style(color="red")))
            lines.append(Text(""))

        lines.append(Text(_HELP, style=Style(dim=True)))
        return lines, cursor_line

    def _render_field_row(self, fd: FieldDescriptor, is_cursor: bool) -> Text:
        cursor_char = "►" if is_cursor else " "
        label = f"{cursor_char} {fd.label}"
        value_str = _format_value(fd)
        kind_tag = (
            "(read-only)"
            if fd.read_only
            else f"{fd.kind.value}{'?' if fd.optional else ''}"
        )

        row = Text()
        row.append(f"  {label:<{_LABEL_W}}")
        row.append(f"  {value_str:<{_VALUE_W}}")
        row.append(f"  {kind_tag}", style=Style(dim=True))

        if is_cursor:
            row.stylize(Style(reverse=True), start=0, end=2 + _LABEL_W + 2 + _VALUE_W)

        if fd.read_only:
            row.stylize(Style(dim=True))

        return row

    def _build_key_bindings(self) -> KeyBindings:
        kb: KeyBindings = KeyBindings()
        total = len(self._flat)

        @kb.add("up")
        @kb.add("k")
        def _up(event: KeyPressEvent) -> None:
            if self._cursor > 0:
                self._cursor -= 1
            self._error = None

        @kb.add("down")
        @kb.add("j")
        def _down(event: KeyPressEvent) -> None:
            if self._cursor < total - 1:
                self._cursor += 1
            self._error = None

        @kb.add("pageup")
        def _pageup(event: KeyPressEvent) -> None:
            self._cursor = max(0, self._cursor - 10)
            self._error = None

        @kb.add("pagedown")
        def _pagedown(event: KeyPressEvent) -> None:
            self._cursor = min(total - 1, self._cursor + 10)
            self._error = None

        @kb.add("enter")
        def _enter(event: KeyPressEvent) -> None:
            fd = self._flat[self._cursor]
            if fd.read_only:
                self._error = f"'{fd.label}' is read-only"
                return
            self._error = None
            self._pending_edit = fd
            event.app.exit()

        @kb.add("delete")
        @kb.add("c-d")
        def _delete(event: KeyPressEvent) -> None:
            fd = self._flat[self._cursor]
            if fd.read_only:
                self._error = f"'{fd.label}' is read-only"
                return
            if not fd.optional:
                self._error = f"'{fd.label}' is required — cannot clear"
                return
            fd.value = None
            self._error = None

        @kb.add("s")
        @kb.add("c-s")
        def _save(event: KeyPressEvent) -> None:
            self._saved = True
            event.app.exit()

        @kb.add("q")
        @kb.add("escape")
        @kb.add("c-c")
        def _quit(event: KeyPressEvent) -> None:
            self._saved = False
            event.app.exit()

        return kb

    def _edit_field(self, fd: FieldDescriptor) -> None:
        _require_questionary()
        try:
            if fd.kind == FieldKind.BOOL:
                result = questionary.confirm(
                    fd.label, default=bool(fd.value)
                ).ask()
                if result is not None:
                    fd.value = result

            elif fd.kind == FieldKind.CHOICE:
                result = questionary.select(
                    fd.label,
                    choices=fd.choices,
                    default=str(fd.value) if fd.value is not None else None,
                ).ask()
                if result is not None:
                    fd.value = result

            elif fd.kind == FieldKind.LIST_STR:
                current = ", ".join(str(x) for x in fd.value) if fd.value else ""
                raw = questionary.text(
                    f"{fd.label} (comma-separated)", default=current
                ).ask()
                if raw is not None:
                    fd.value = [x.strip() for x in raw.split(",") if x.strip()]

            elif fd.kind == FieldKind.DICT_STR_STR:
                d: dict[str, str] = fd.value if isinstance(fd.value, dict) else {}
                current = ", ".join(f"{k}={v}" for k, v in d.items())
                raw = questionary.text(
                    f"{fd.label} (KEY=VALUE, comma-separated)", default=current
                ).ask()
                if raw is not None:
                    fd.value = _parse_dict(raw)

            else:
                current = str(fd.value) if fd.value is not None else ""
                raw = questionary.text(fd.label, default=current).ask()
                if raw is None:
                    return
                if not raw.strip() and fd.optional:
                    fd.value = None
                    return
                try:
                    coerced = _coerce(fd.kind, raw.strip())
                except (ValueError, TypeError) as exc:
                    self._error = f"Invalid value: {exc}"
                    return
                err = fd.validator(coerced)
                if err:
                    self._error = err
                    return
                fd.value = coerced

        except KeyboardInterrupt:
            pass


# ── Workflow editor model ────────────────────────────────────────────────────


class WorkflowMenuRowKind(enum.Enum):
    WORKFLOW_INFO = "workflow_info"
    SECTION_HEADER = "section_header"
    NODE = "node"
    EDGE = "edge"


@dataclass
class WorkflowMenuRow:
    kind: WorkflowMenuRowKind
    title: str
    summary: str = ""
    section: str = "workflow"
    node_id: str | None = None
    edge_key: tuple[str, str] | None = None
    actionable: bool = True


class WorkflowEditorModel:
    def __init__(self, workflow: AgenticWorkflow) -> None:
        self.workflow = workflow

    def menu_rows(self) -> list[WorkflowMenuRow]:
        rows = [
            WorkflowMenuRow(
                kind=WorkflowMenuRowKind.WORKFLOW_INFO,
                title="Workflow Info",
                summary=_workflow_summary(self.workflow),
                section="workflow",
            ),
            WorkflowMenuRow(
                kind=WorkflowMenuRowKind.SECTION_HEADER,
                title="Nodes",
                summary=f"{len(self.workflow.graph._nodes)} total",
                section="nodes",
            ),
        ]

        for node in self.ordered_nodes():
            rows.append(
                WorkflowMenuRow(
                    kind=WorkflowMenuRowKind.NODE,
                    title=node.node_id,
                    summary=_node_summary(node),
                    section="nodes",
                    node_id=node.node_id,
                )
            )

        rows.append(
            WorkflowMenuRow(
                kind=WorkflowMenuRowKind.SECTION_HEADER,
                title="Edges",
                summary=f"{len(self.workflow.graph._edges)} total",
                section="edges",
            )
        )

        for edge in self.ordered_edges():
            rows.append(
                WorkflowMenuRow(
                    kind=WorkflowMenuRowKind.EDGE,
                    title=f"{edge.from_node} -> {edge.to_node}",
                    summary=_edge_summary(edge),
                    section="edges",
                    edge_key=(edge.from_node, edge.to_node),
                )
            )

        return rows

    def ordered_nodes(self) -> list[GraphNode]:
        nodes: list[GraphNode] = []
        for generation in self.workflow.graph.topological_generations():
            nodes.extend(generation)
        return nodes

    def ordered_edges(self) -> list[EdgeConfig]:
        return sorted(
            self.workflow.graph._edges.values(),
            key=lambda edge: (edge.from_node, edge.to_node),
        )

    def update_workflow_info(
        self,
        *,
        name: str,
        cron_expression: str | None,
        timezone: str | None,
    ) -> None:
        schedule = None
        if cron_expression:
            schedule = ScheduleConfig(
                cron_expression=cron_expression,
                timezone=timezone or "UTC",
            )
        self.workflow.config = self.workflow.config.model_copy(
            update={"name": name, "schedule": schedule}
        )

    def add_node(self, node: GraphNode) -> None:
        if node.node_id in self.workflow.graph._nodes:
            raise ValueError(f"Node '{node.node_id}' already exists")
        self.workflow.add_operation(node)

    def update_node(self, node_id: str, node: GraphNode) -> None:
        if node_id not in self.workflow.graph._nodes:
            raise ValueError(f"Node '{node_id}' not found")
        self.workflow.graph._nodes[node_id] = node

    def delete_node(self, node_id: str) -> None:
        if node_id not in self.workflow.graph._nodes:
            raise ValueError(f"Node '{node_id}' not found")

        self.workflow.graph._graph.remove_node(node_id)
        del self.workflow.graph._nodes[node_id]
        self.workflow.graph._edges = {
            key: value
            for key, value in self.workflow.graph._edges.items()
            if node_id not in key
        }

    def add_edge(self, edge: EdgeConfig) -> None:
        self.workflow.graph.add_edge(edge.from_node, edge.to_node, edge)

    def update_edge(
        self,
        old_key: tuple[str, str],
        edge: EdgeConfig,
    ) -> None:
        original = self.workflow.graph._edges.get(old_key)
        if original is None:
            raise ValueError(f"Edge '{old_key[0]} -> {old_key[1]}' not found")

        self.delete_edge(*old_key)
        try:
            self.add_edge(edge)
        except Exception:
            self.workflow.graph.add_edge(original.from_node, original.to_node, original)
            raise

    def delete_edge(self, from_node: str, to_node: str) -> None:
        if (from_node, to_node) not in self.workflow.graph._edges:
            raise ValueError(f"Edge '{from_node} -> {to_node}' not found")
        self.workflow.graph._graph.remove_edge(from_node, to_node)
        del self.workflow.graph._edges[(from_node, to_node)]


# ── Workflow editor app ──────────────────────────────────────────────────────


_MENU_TITLE_W = 26
_MENU_SUMMARY_W = 56
_WORKFLOW_HELP = (
    " [↑↓] Navigate   [Enter] Open   [a] Add   [d] Delete   [s] Save   [q/Esc] Exit"
)


class WorkflowEditorApp:
    def __init__(
        self,
        workflow: AgenticWorkflow,
        title: str = "Workflow Editor",
        detail_editor_factory: Callable[[list[Section], str], Any] | None = None,
    ) -> None:
        self._title = title
        self._model = WorkflowEditorModel(workflow)
        self._detail_editor_factory = detail_editor_factory or (
            lambda sections, editor_title: FieldEditorApp(sections, title=editor_title)
        )
        self._cursor = 0
        self._scroll_offset = 0
        self._error: str | None = None
        self._saved = False
        self._pending_action: Callable[[], None] | None = None

    @property
    def workflow(self) -> AgenticWorkflow:
        return self._model.workflow

    def run(self) -> bool:
        while True:
            kb = self._build_key_bindings()
            layout = Layout(
                Window(
                    content=FormattedTextControl(
                        self._get_formatted_text, focusable=True
                    ),
                    wrap_lines=False,
                )
            )
            app: Application[None] = Application(
                layout=layout,
                key_bindings=kb,
                full_screen=True,
                mouse_support=False,
            )
            app.run()

            if self._pending_action is not None:
                print("\033[2J\033[H", end="", flush=True)
                action = self._pending_action
                self._pending_action = None
                action()
            else:
                break

        return self._saved

    def current_row(self) -> WorkflowMenuRow:
        rows = self._model.menu_rows()
        self._cursor = min(self._cursor, len(rows) - 1)
        return rows[self._cursor]

    def open_selected_detail(self) -> None:
        row = self.current_row()
        self._error = None

        if row.kind == WorkflowMenuRowKind.WORKFLOW_INFO:
            self._edit_workflow_info()
            return
        if row.kind == WorkflowMenuRowKind.NODE and row.node_id is not None:
            self._edit_node(row.node_id)
            return
        if row.kind == WorkflowMenuRowKind.EDGE and row.edge_key is not None:
            self._edit_edge(row.edge_key)
            return
        self._error = f"Use 'a' to add to {row.title}"

    def add_in_current_section(self) -> None:
        row = self.current_row()
        self._error = None

        if row.section == "nodes":
            self._add_node()
            return
        if row.section == "edges":
            self._add_edge()
            return
        self._error = "Workflow info cannot be added here"

    def delete_selected(self) -> None:
        row = self.current_row()
        self._error = None

        if row.kind == WorkflowMenuRowKind.NODE and row.node_id is not None:
            self._delete_node(row.node_id)
            return
        if row.kind == WorkflowMenuRowKind.EDGE and row.edge_key is not None:
            self._delete_edge(row.edge_key)
            return
        self._error = "Select a node or edge to delete"

    def _get_formatted_text(self) -> ANSI:
        term = shutil.get_terminal_size(fallback=(120, 40))
        height = max(5, term.lines - 1)
        width = term.columns

        all_lines, cursor_line = self._render_all()

        if cursor_line < self._scroll_offset:
            self._scroll_offset = cursor_line
        elif cursor_line >= self._scroll_offset + height - 2:
            self._scroll_offset = max(0, cursor_line - height + 3)

        visible = all_lines[self._scroll_offset : self._scroll_offset + height]

        buf = io.StringIO()
        console = Console(
            file=buf, force_terminal=True, highlight=False, width=width
        )
        for line in visible:
            console.print(line, end="\n", markup=False)

        return ANSI(buf.getvalue())

    def _render_all(self) -> tuple[list[Text], int]:
        lines = [Text(f"  {self._title}", style=Style(bold=True, color="cyan")), Text("")]
        cursor_line = 0

        rows = self._model.menu_rows()
        for idx, row in enumerate(rows):
            is_cursor = idx == self._cursor
            if is_cursor:
                cursor_line = len(lines)
            lines.append(self._render_menu_row(row, is_cursor))

        if self._error:
            lines.append(Text(""))
            lines.append(Text(f"  ✖ {self._error}", style=Style(color="red")))

        lines.append(Text(""))
        lines.append(Text(_WORKFLOW_HELP, style=Style(dim=True)))
        return lines, cursor_line

    def _render_menu_row(self, row: WorkflowMenuRow, is_cursor: bool) -> Text:
        text = Text()
        cursor_char = "►" if is_cursor else " "

        if row.kind == WorkflowMenuRowKind.SECTION_HEADER:
            title = f"{cursor_char} {row.title}"
            text.append(f"  {title:<{_MENU_TITLE_W}}")
            text.append(f"  {row.summary}", style=Style(dim=True))
            text.stylize(Style(bold=True, color="cyan"))
        else:
            label = f"{cursor_char} {row.title}"
            text.append(f"  {label:<{_MENU_TITLE_W}}")
            text.append(f"  {row.summary:<{_MENU_SUMMARY_W}}", style=Style(dim=True))

        if is_cursor:
            text.stylize(Style(reverse=True))
        return text

    def _build_key_bindings(self) -> KeyBindings:
        kb: KeyBindings = KeyBindings()

        @kb.add("up")
        @kb.add("k")
        def _up(event: KeyPressEvent) -> None:
            if self._cursor > 0:
                self._cursor -= 1
            self._error = None

        @kb.add("down")
        @kb.add("j")
        def _down(event: KeyPressEvent) -> None:
            if self._cursor < len(self._model.menu_rows()) - 1:
                self._cursor += 1
            self._error = None

        @kb.add("enter")
        def _enter(event: KeyPressEvent) -> None:
            self._pending_action = self.open_selected_detail
            event.app.exit()

        @kb.add("a")
        def _add(event: KeyPressEvent) -> None:
            self._pending_action = self.add_in_current_section
            event.app.exit()

        @kb.add("d")
        @kb.add("delete")
        def _delete(event: KeyPressEvent) -> None:
            self._pending_action = self.delete_selected
            event.app.exit()

        @kb.add("s")
        @kb.add("c-s")
        def _save(event: KeyPressEvent) -> None:
            self._saved = True
            event.app.exit()

        @kb.add("q")
        @kb.add("escape")
        @kb.add("c-c")
        def _quit(event: KeyPressEvent) -> None:
            self._saved = False
            event.app.exit()

        return kb

    def _launch_detail_editor(self, sections: list[Section], title: str) -> bool:
        editor = self._detail_editor_factory(sections, title)
        return bool(editor.run())

    def _edit_workflow_info(self) -> None:
        sections = [_workflow_info_section(self.workflow)]
        if not self._launch_detail_editor(sections, f"Workflow Info: {self.workflow.config.id}"):
            return
        fm = {fd.key: fd.value for fd in sections[0].fields}
        self._model.update_workflow_info(
            name=fm.get("config.name") or self.workflow.config.name,
            cron_expression=fm.get("config.schedule.cron_expression") or None,
            timezone=fm.get("config.schedule.timezone") or "UTC",
        )

    def _edit_node(self, node_id: str) -> None:
        node = self.workflow.graph._nodes[node_id]
        sections = [_node_to_section(node)]
        if not self._launch_detail_editor(sections, f"Node: {node_id}"):
            return
        self._model.update_node(node_id, _sections_to_node(sections, node))

    def _edit_edge(self, edge_key: tuple[str, str]) -> None:
        edge = self.workflow.graph._edges[edge_key]
        sections = [_edge_to_section(edge, list(self.workflow.graph._nodes))]
        if not self._launch_detail_editor(
            sections, f"Edge: {edge.from_node} -> {edge.to_node}"
        ):
            return
        try:
            self._model.update_edge(edge_key, _sections_to_edge(sections))
        except (CycleError, ValueError) as exc:
            self._error = str(exc)

    def _add_node(self) -> None:
        try:
            node = _prompt_for_new_node(self.workflow)
        except ValueError as exc:
            self._error = str(exc)
            return
        if node is None:
            return
        try:
            self._model.add_node(node)
        except ValueError as exc:
            self._error = str(exc)

    def _add_edge(self) -> None:
        if len(self.workflow.graph._nodes) < 2:
            self._error = "At least two nodes are required to add an edge"
            return
        edge = _prompt_for_new_edge(self.workflow)
        if edge is None:
            return
        try:
            self._model.add_edge(edge)
        except (CycleError, ValueError) as exc:
            self._error = str(exc)

    def _delete_node(self, node_id: str) -> None:
        _require_questionary()
        attached = sum(1 for key in self.workflow.graph._edges if node_id in key)
        confirmed = questionary.confirm(
            f"Delete node '{node_id}' and {attached} attached edge(s)?", default=False
        ).ask()
        if not confirmed:
            return
        self._model.delete_node(node_id)
        self._cursor = min(self._cursor, len(self._model.menu_rows()) - 1)

    def _delete_edge(self, edge_key: tuple[str, str]) -> None:
        _require_questionary()
        confirmed = questionary.confirm(
            f"Delete edge '{edge_key[0]} -> {edge_key[1]}'?", default=False
        ).ask()
        if not confirmed:
            return
        self._model.delete_edge(*edge_key)
        self._cursor = min(self._cursor, len(self._model.menu_rows()) - 1)


# ── Workflow detail sections ─────────────────────────────────────────────────


def _workflow_info_section(wf: AgenticWorkflow) -> Section:
    sched = wf.config.schedule
    return Section(
        "Workflow Info",
        [
            FieldDescriptor(
                "config.id", "ID", FieldKind.STRING, wf.config.id, read_only=True
            ),
            FieldDescriptor("config.name", "Name", FieldKind.STRING, wf.config.name),
            FieldDescriptor(
                "config.schedule.cron_expression",
                "Cron Expression",
                FieldKind.STRING,
                sched.cron_expression if sched else None,
                optional=True,
            ),
            FieldDescriptor(
                "config.schedule.timezone",
                "Schedule Timezone",
                FieldKind.STRING,
                sched.timezone if sched else "UTC",
                optional=True,
            ),
        ],
    )


def _node_to_section(node: GraphNode) -> Section:
    op = node.operation
    op_fields = _operation_fields(node.node_id, op)
    shared: list[FieldDescriptor] = [
        FieldDescriptor(
            f"nodes.{node.node_id}.retry_count",
            "Retry Count",
            FieldKind.INT,
            node.retry_count,
            default=0,
        ),
        FieldDescriptor(
            f"nodes.{node.node_id}.retry_delay_seconds",
            "Retry Delay (s)",
            FieldKind.FLOAT,
            node.retry_delay_seconds,
            default=1.0,
        ),
        FieldDescriptor(
            f"nodes.{node.node_id}.timeout_seconds",
            "Timeout (s)",
            FieldKind.FLOAT,
            node.timeout_seconds,
            optional=True,
        ),
        FieldDescriptor(
            f"nodes.{node.node_id}.pipe_output",
            "Pipe Output",
            FieldKind.BOOL,
            node.pipe_output,
            default=False,
        ),
    ]
    return Section(f"Node: {node.node_id} [{op.type}]", op_fields + shared)


def _edge_to_section(edge: EdgeConfig, node_ids: list[str]) -> Section:
    return Section(
        f"Edge: {edge.from_node} -> {edge.to_node}",
        [
            FieldDescriptor(
                "edge.from",
                "From",
                FieldKind.CHOICE,
                edge.from_node,
                choices=node_ids,
            ),
            FieldDescriptor(
                "edge.to",
                "To",
                FieldKind.CHOICE,
                edge.to_node,
                choices=node_ids,
            ),
            FieldDescriptor(
                "edge.condition",
                "Condition",
                FieldKind.CHOICE,
                edge.condition.value,
                choices=[condition.value for condition in EdgeConditionType],
            ),
            FieldDescriptor(
                "edge.output_pattern",
                "Output Pattern",
                FieldKind.STRING,
                edge.output_pattern,
                optional=True,
            ),
        ],
    )


def _operation_fields(node_id: str, op: _AnyOp) -> list[FieldDescriptor]:
    prefix = f"nodes.{node_id}"
    node_id_fd = FieldDescriptor(
        f"{prefix}.node_id", "Node ID", FieldKind.STRING, node_id, read_only=True
    )

    if isinstance(op, BashCommandOperation):
        return [
            node_id_fd,
            FieldDescriptor(f"{prefix}.command", "Command", FieldKind.STRING, op.command),
            FieldDescriptor(
                f"{prefix}.working_dir",
                "Working Dir",
                FieldKind.PATH,
                op.working_dir,
                optional=True,
            ),
            FieldDescriptor(
                f"{prefix}.env", "Environment", FieldKind.DICT_STR_STR, dict(op.env)
            ),
        ]

    if isinstance(op, PythonScriptOperation):
        return [
            node_id_fd,
            FieldDescriptor(
                f"{prefix}.script_path", "Script Path", FieldKind.PATH, op.script_path
            ),
            FieldDescriptor(
                f"{prefix}.args", "Arguments", FieldKind.LIST_STR, list(op.args)
            ),
            FieldDescriptor(
                f"{prefix}.env", "Environment", FieldKind.DICT_STR_STR, dict(op.env)
            ),
        ]

    if isinstance(op, ShellScriptOperation):
        return [
            node_id_fd,
            FieldDescriptor(
                f"{prefix}.script_path", "Script Path", FieldKind.PATH, op.script_path
            ),
            FieldDescriptor(
                f"{prefix}.args", "Arguments", FieldKind.LIST_STR, list(op.args)
            ),
            FieldDescriptor(
                f"{prefix}.env", "Environment", FieldKind.DICT_STR_STR, dict(op.env)
            ),
        ]

    return [
        node_id_fd,
        FieldDescriptor(
            f"{prefix}.agent_id", "Agent ID", FieldKind.STRING, op.agent_id
        ),
        FieldDescriptor(
            f"{prefix}.prompt_path", "Prompt Path", FieldKind.PATH, op.prompt_path
        ),
        FieldDescriptor(
            f"{prefix}.working_dir", "Working Dir", FieldKind.PATH, op.working_dir
        ),
        FieldDescriptor(
            f"{prefix}.dynamic_count",
            "Dynamic Count",
            FieldKind.STRING,
            str(op.dynamic_count),
        ),
        FieldDescriptor(
            f"{prefix}.input_mapping",
            "Input Mapping",
            FieldKind.DICT_STR_STR,
            dict(op.input_mapping),
        ),
    ]


def _sections_to_node(sections: list[Section], node: GraphNode) -> GraphNode:
    fm: dict[str, Any] = {fd.key: fd.value for sec in sections for fd in sec.fields}
    prefix = f"nodes.{node.node_id}"
    op = node.operation

    if isinstance(op, BashCommandOperation):
        new_op: _AnyOp = BashCommandOperation(
            type=op.type,
            command=fm.get(f"{prefix}.command") or op.command,
            working_dir=_as_path_or_none(fm.get(f"{prefix}.working_dir")),
            env=fm.get(f"{prefix}.env") or {},
        )
    elif isinstance(op, PythonScriptOperation):
        new_op = PythonScriptOperation(
            type=op.type,
            script_path=_as_path(fm.get(f"{prefix}.script_path"), op.script_path),
            args=fm.get(f"{prefix}.args") or [],
            env=fm.get(f"{prefix}.env") or {},
        )
    elif isinstance(op, ShellScriptOperation):
        new_op = ShellScriptOperation(
            type=op.type,
            script_path=_as_path(fm.get(f"{prefix}.script_path"), op.script_path),
            args=fm.get(f"{prefix}.args") or [],
            env=fm.get(f"{prefix}.env") or {},
        )
    else:
        new_op = AgentOperation(
            type=op.type,
            agent_id=fm.get(f"{prefix}.agent_id") or op.agent_id,
            prompt_path=_as_path(fm.get(f"{prefix}.prompt_path"), op.prompt_path),
            working_dir=_as_path(fm.get(f"{prefix}.working_dir"), op.working_dir),
            dynamic_count=_parse_dynamic_count(fm.get(f"{prefix}.dynamic_count")),
            input_mapping=fm.get(f"{prefix}.input_mapping") or {},
            fan_source=op.fan_source,
        )

    return node.model_copy(
        update={
            "operation": new_op,
            "retry_count": int(fm.get(f"{prefix}.retry_count") or 0),
            "retry_delay_seconds": float(
                fm.get(f"{prefix}.retry_delay_seconds") or 1.0
            ),
            "timeout_seconds": (
                float(fm[f"{prefix}.timeout_seconds"])
                if fm.get(f"{prefix}.timeout_seconds") is not None
                else None
            ),
            "pipe_output": bool(fm.get(f"{prefix}.pipe_output")),
        }
    )


def _sections_to_edge(sections: list[Section]) -> EdgeConfig:
    fm: dict[str, Any] = {fd.key: fd.value for sec in sections for fd in sec.fields}
    condition = EdgeConditionType(str(fm.get("edge.condition") or "always"))
    output_pattern = fm.get("edge.output_pattern") or None
    if condition != EdgeConditionType.OUTPUT_MATCHES:
        output_pattern = None
    return EdgeConfig(
        from_node=str(fm["edge.from"]),
        to_node=str(fm["edge.to"]),
        condition=condition,
        output_pattern=output_pattern,
    )


# ── Workflow creation prompts ────────────────────────────────────────────────


def _prompt_for_new_node(workflow: AgenticWorkflow) -> GraphNode | None:
    _require_questionary()
    node_id = questionary.text("Node ID:").ask()
    if not node_id:
        return None
    if node_id in workflow.graph._nodes:
        raise ValueError(f"Node '{node_id}' already exists")

    node_type = questionary.select(
        "Node type:",
        choices=[op_type.value for op_type in OperationType],
    ).ask()
    if node_type is None:
        return None

    operation: _AnyOp
    if node_type == OperationType.BASH_COMMAND.value:
        command = questionary.text("Command:").ask()
        if not command:
            return None
        working_dir_raw = questionary.text("Working directory (optional):").ask()
        env_raw = questionary.text("Environment (KEY=VALUE, comma-separated):").ask()
        operation = BashCommandOperation(
            type=OperationType.BASH_COMMAND,
            command=command,
            working_dir=_as_path_or_none(working_dir_raw),
            env=_parse_dict(env_raw),
        )
    elif node_type == OperationType.PYTHON_SCRIPT.value:
        script_path = questionary.text("Script path:").ask()
        if not script_path:
            return None
        args = questionary.text("Arguments (comma-separated, optional):").ask()
        env_raw = questionary.text("Environment (KEY=VALUE, comma-separated):").ask()
        operation = PythonScriptOperation(
            type=OperationType.PYTHON_SCRIPT,
            script_path=Path(script_path).expanduser(),
            args=_parse_list(args),
            env=_parse_dict(env_raw),
        )
    elif node_type == OperationType.SHELL_SCRIPT.value:
        script_path = questionary.text("Script path:").ask()
        if not script_path:
            return None
        args = questionary.text("Arguments (comma-separated, optional):").ask()
        env_raw = questionary.text("Environment (KEY=VALUE, comma-separated):").ask()
        operation = ShellScriptOperation(
            type=OperationType.SHELL_SCRIPT,
            script_path=Path(script_path).expanduser(),
            args=_parse_list(args),
            env=_parse_dict(env_raw),
        )
    else:
        agent_id = questionary.text("Agent ID:").ask()
        prompt_path = questionary.text("Prompt path:").ask()
        working_dir = questionary.text("Working directory:").ask()
        if not agent_id or not prompt_path or not working_dir:
            return None
        dynamic_count = questionary.text("Dynamic count:", default="1").ask()
        input_mapping = questionary.text(
            "Input mapping (KEY=VALUE, comma-separated):"
        ).ask()
        operation = AgentOperation(
            type=OperationType.AGENT,
            agent_id=agent_id,
            prompt_path=Path(prompt_path).expanduser(),
            working_dir=Path(working_dir).expanduser(),
            dynamic_count=_parse_dynamic_count(dynamic_count),
            input_mapping=_parse_dict(input_mapping),
        )

    pipe_output = bool(
        questionary.confirm("Pipe output to next node?", default=False).ask()
    )
    retry_count = int(questionary.text("Retry count:", default="0").ask() or "0")
    retry_delay = float(
        questionary.text("Retry delay in seconds:", default="1.0").ask() or "1.0"
    )
    timeout_raw = questionary.text("Timeout in seconds (optional):").ask()

    return GraphNode(
        node_id=node_id,
        operation=operation,
        pipe_output=pipe_output,
        retry_count=retry_count,
        retry_delay_seconds=retry_delay,
        timeout_seconds=float(timeout_raw) if timeout_raw else None,
    )


def _prompt_for_new_edge(workflow: AgenticWorkflow) -> EdgeConfig | None:
    _require_questionary()
    node_ids = sorted(workflow.graph._nodes)
    from_node = questionary.select("From node:", choices=node_ids).ask()
    if from_node is None:
        return None

    to_choices = [node_id for node_id in node_ids if node_id != from_node]
    to_node = questionary.select("To node:", choices=to_choices).ask()
    if to_node is None:
        return None

    condition_raw = questionary.select(
        "Condition:",
        choices=[condition.value for condition in EdgeConditionType],
        default=EdgeConditionType.ALWAYS.value,
    ).ask()
    if condition_raw is None:
        return None

    condition = EdgeConditionType(condition_raw)
    output_pattern = None
    if condition == EdgeConditionType.OUTPUT_MATCHES:
        output_pattern = questionary.text("Output regex (optional):").ask() or None

    return EdgeConfig(
        from_node=from_node,
        to_node=to_node,
        condition=condition,
        output_pattern=output_pattern,
    )


# ── Agent ↔ sections ──────────────────────────────────────────────────────────


def agent_to_sections(cfg: AgentConfig) -> list[Section]:
    fields: list[FieldDescriptor] = [
        FieldDescriptor(
            "agent.agent_id", "Agent ID", FieldKind.STRING, cfg.agent_id, read_only=True
        ),
        FieldDescriptor(
            "agent.subscription",
            "Subscription",
            FieldKind.CHOICE,
            cfg.subscription,
            choices=["claude_code", "codex"],
        ),
        FieldDescriptor(
            "agent.working_dir", "Working Dir", FieldKind.PATH, cfg.working_dir
        ),
        FieldDescriptor(
            "agent.prompt_path", "Prompt Path", FieldKind.PATH, cfg.prompt_path
        ),
        FieldDescriptor(
            "agent.tools", "Tools", FieldKind.LIST_STR, list(cfg.tools)
        ),
        FieldDescriptor(
            "agent.mcp_servers", "MCP Servers", FieldKind.LIST_STR, list(cfg.mcp_servers)
        ),
        FieldDescriptor(
            "agent.env", "Environment", FieldKind.DICT_STR_STR, dict(cfg.env)
        ),
    ]
    return [Section(f"Agent: {cfg.agent_id}", fields)]


def sections_to_agent(sections: list[Section], cfg: AgentConfig) -> AgentConfig:
    fm: dict[str, Any] = {fd.key: fd.value for sec in sections for fd in sec.fields}
    return cfg.model_copy(
        update={
            "subscription": fm.get("agent.subscription") or cfg.subscription,
            "working_dir": _as_path(fm.get("agent.working_dir"), cfg.working_dir),
            "prompt_path": _as_path(fm.get("agent.prompt_path"), cfg.prompt_path),
            "tools": fm.get("agent.tools") or [],
            "mcp_servers": fm.get("agent.mcp_servers") or [],
            "env": fm.get("agent.env") or {},
        }
    )


# ── Helpers ──────────────────────────────────────────────────────────────────


def _workflow_summary(wf: AgenticWorkflow) -> str:
    schedule = "no schedule"
    if wf.config.schedule:
        schedule = (
            f"{wf.config.schedule.cron_expression} ({wf.config.schedule.timezone})"
        )
    return f"{wf.config.name} | {schedule}"


def _node_summary(node: GraphNode) -> str:
    op = node.operation
    if isinstance(op, BashCommandOperation):
        detail = op.command
    elif isinstance(op, (PythonScriptOperation, ShellScriptOperation)):
        detail = str(op.script_path)
    else:
        detail = op.agent_id
    return f"{op.type} | {detail}"


def _edge_summary(edge: EdgeConfig) -> str:
    summary = f"[{edge.condition.value}]"
    if edge.condition == EdgeConditionType.OUTPUT_MATCHES and edge.output_pattern:
        summary += f" {edge.output_pattern}"
    return summary


def _parse_dict(raw: str | None) -> dict[str, str]:
    result: dict[str, str] = {}
    if not raw:
        return result
    for pair in raw.split(","):
        pair = pair.strip()
        if not pair or "=" not in pair:
            continue
        key, _, value = pair.partition("=")
        result[key.strip()] = value.strip()
    return result


def _parse_list(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def _parse_dynamic_count(raw: Any) -> int | str:  # noqa: ANN401
    if raw is None:
        return 1
    try:
        return int(str(raw))
    except (TypeError, ValueError):
        return str(raw)


def _as_path(raw: Any, fallback: Path) -> Path:  # noqa: ANN401
    if raw is None:
        return fallback
    if isinstance(raw, Path):
        return raw
    return Path(str(raw)).expanduser()


def _as_path_or_none(raw: Any) -> Path | None:  # noqa: ANN401
    if raw is None:
        return None
    if isinstance(raw, Path):
        return raw
    s = str(raw).strip()
    return Path(s).expanduser() if s else None


def _require_questionary() -> None:
    if questionary is None:
        raise ImportError(
            "questionary is required for interactive editing: pip install questionary"
        )
