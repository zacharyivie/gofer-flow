"""Interactive arrow-key TUI editor for workflow and agent configs."""

from __future__ import annotations

import enum
import io
import shutil
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import questionary
from prompt_toolkit import Application
from prompt_toolkit.formatted_text import ANSI
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.key_binding.key_processor import KeyPressEvent
from prompt_toolkit.layout import Layout
from prompt_toolkit.layout.containers import Window
from prompt_toolkit.layout.controls import FormattedTextControl
from rich.console import Console
from rich.style import Style
from rich.text import Text

from agentic_task_manager.core.agent import AgentConfig
from agentic_task_manager.core.graph import GraphNode
from agentic_task_manager.core.operations import (
    AgentOperation,
    BashCommandOperation,
    PythonScriptOperation,
    ShellScriptOperation,
)
from agentic_task_manager.core.workflow import AgenticWorkflow, ScheduleConfig

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


# ── TUI Application ──────────────────────────────────────────────────────────

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
                # Clear screen so only the active prompt is visible
                print("\033[2J\033[H", end="", flush=True)
                self._edit_field(self._pending_edit)
                self._pending_edit = None
                # Loop back to re-enter the full-screen app
            else:
                break

        return self._saved

    # ── Rendering ────────────────────────────────────────────────────────────

    def _get_formatted_text(self) -> ANSI:
        term = shutil.get_terminal_size(fallback=(120, 40))
        height = max(5, term.lines - 1)
        width = term.columns

        all_lines, cursor_line = self._render_all()

        # Keep cursor in view
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

        # Title
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

    # ── Key bindings ─────────────────────────────────────────────────────────

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

    # ── Field editing ─────────────────────────────────────────────────────────

    def _edit_field(self, fd: FieldDescriptor) -> None:
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
                    parsed: dict[str, str] = {}
                    for pair in raw.split(","):
                        pair = pair.strip()
                        if "=" in pair:
                            k, _, v = pair.partition("=")
                            parsed[k.strip()] = v.strip()
                    fd.value = parsed

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


# ── Workflow ↔ sections ───────────────────────────────────────────────────────


def workflow_to_sections(wf: AgenticWorkflow) -> list[Section]:
    sched = wf.config.schedule
    wf_fields: list[FieldDescriptor] = [
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
    ]
    sections: list[Section] = [Section("Workflow", wf_fields)]

    for gen in wf.graph.topological_generations():
        for node in gen:
            sections.append(_node_to_section(node))

    return sections


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


def _operation_fields(
    node_id: str,
    op: BashCommandOperation | PythonScriptOperation | ShellScriptOperation | AgentOperation,
) -> list[FieldDescriptor]:
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

    # AgentOperation
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


def sections_to_workflow(sections: list[Section], wf: AgenticWorkflow) -> None:
    fm: dict[str, Any] = {fd.key: fd.value for sec in sections for fd in sec.fields}

    new_name: str = fm.get("config.name") or wf.config.name
    cron: str | None = fm.get("config.schedule.cron_expression") or None
    tz: str = fm.get("config.schedule.timezone") or "UTC"
    schedule = ScheduleConfig(cron_expression=cron, timezone=tz) if cron else None
    wf.config = wf.config.model_copy(update={"name": new_name, "schedule": schedule})

    for gen in wf.graph.topological_generations():
        for node in gen:
            nid = node.node_id
            p = f"nodes.{nid}"
            op = node.operation

            if isinstance(op, BashCommandOperation):
                wd_raw = fm.get(f"{p}.working_dir")
                new_op: _AnyOp = BashCommandOperation(
                    type=op.type,
                    command=fm.get(f"{p}.command") or op.command,
                    working_dir=_as_path_or_none(wd_raw),
                    env=fm.get(f"{p}.env") or {},
                )
            elif isinstance(op, PythonScriptOperation):
                new_op = PythonScriptOperation(
                    type=op.type,
                    script_path=_as_path(fm.get(f"{p}.script_path"), op.script_path),
                    args=fm.get(f"{p}.args") or [],
                    env=fm.get(f"{p}.env") or {},
                )
            elif isinstance(op, ShellScriptOperation):
                new_op = ShellScriptOperation(
                    type=op.type,
                    script_path=_as_path(fm.get(f"{p}.script_path"), op.script_path),
                    args=fm.get(f"{p}.args") or [],
                    env=fm.get(f"{p}.env") or {},
                )
            else:
                dc_raw = fm.get(f"{p}.dynamic_count", "1")
                dc: int | str
                try:
                    dc = int(str(dc_raw))
                except (ValueError, TypeError):
                    dc = str(dc_raw)
                new_op = AgentOperation(
                    type=op.type,
                    agent_id=fm.get(f"{p}.agent_id") or op.agent_id,
                    prompt_path=_as_path(fm.get(f"{p}.prompt_path"), op.prompt_path),
                    working_dir=_as_path(fm.get(f"{p}.working_dir"), op.working_dir),
                    dynamic_count=dc,
                    input_mapping=fm.get(f"{p}.input_mapping") or {},
                    fan_source=op.fan_source,
                )

            rc = fm.get(f"{p}.retry_count")
            rd = fm.get(f"{p}.retry_delay_seconds")
            ts = fm.get(f"{p}.timeout_seconds")
            po = fm.get(f"{p}.pipe_output")

            wf.graph._nodes[nid] = node.model_copy(
                update={
                    "operation": new_op,
                    "retry_count": int(rc) if rc is not None else 0,
                    "retry_delay_seconds": float(rd) if rd is not None else 1.0,
                    "timeout_seconds": float(ts) if ts is not None else None,
                    "pipe_output": bool(po) if po is not None else False,
                }
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
