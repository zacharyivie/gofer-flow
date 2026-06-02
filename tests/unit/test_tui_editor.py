"""Unit tests for tui_editor pure functions and workflow editor model behavior."""

from __future__ import annotations

from pathlib import Path

import pytest

from gofer.cli.tui_editor import (
    FieldDescriptor,
    FieldEditorApp,
    FieldKind,
    Section,
    WorkflowEditorApp,
    WorkflowEditorModel,
    WorkflowMenuRowKind,
    _as_path,
    _as_path_or_none,
    _coerce,
    _format_value,
    _node_to_section,
    _sections_to_edge,
    _sections_to_node,
    _workflow_info_section,
    agent_to_sections,
    sections_to_agent,
)
from gofer.core.agent import AgentConfig
from gofer.core.graph import CycleError, EdgeConditionType, EdgeConfig, GraphNode
from gofer.core.operations import (
    AgentOperation,
    BashCommandOperation,
    OperationType,
    PythonScriptOperation,
    ShellScriptOperation,
)
from gofer.core.workflow import AgenticWorkflow, ScheduleConfig, WorkflowConfig


def _bash_workflow() -> AgenticWorkflow:
    wf = AgenticWorkflow(WorkflowConfig(id="wf1", name="Workflow One"))
    wf.add_operation(
        GraphNode(
            node_id="step1",
            operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="echo hi"),
        )
    )
    wf.add_operation(
        GraphNode(
            node_id="step2",
            operation=BashCommandOperation(
                type=OperationType.BASH_COMMAND,
                command="echo bye",
                working_dir=Path("/tmp"),
                env={"FOO": "bar"},
            ),
            retry_count=2,
            timeout_seconds=30.0,
        )
    )
    wf.then(
        "step1",
        "step2",
        EdgeConfig(
            from_node="step1",
            to_node="step2",
            condition=EdgeConditionType.ON_SUCCESS,
        ),
    )
    return wf


def _agent_config() -> AgentConfig:
    return AgentConfig(
        agent_id="myagent",
        subscription="claude_code",
        working_dir=Path("/home/user"),
        prompt_path=Path("/home/user/prompt.md"),
        tools=["bash", "read"],
        mcp_servers=["filesystem"],
        env={"DEBUG": "1"},
    )


class _FakeDetailEditor:
    def __init__(
        self,
        sections: list[Section],
        title: str,
        mutate: callable | None = None,
        should_save: bool = True,
    ) -> None:
        self.sections = sections
        self.title = title
        self._mutate = mutate
        self._should_save = should_save

    def run(self) -> bool:
        if self._mutate is not None:
            self._mutate(self.sections, self.title)
        return self._should_save


def test_format_value_none() -> None:
    fd = FieldDescriptor("k", "L", FieldKind.STRING, None, optional=True)
    assert _format_value(fd) == "(none)"


def test_format_value_string() -> None:
    fd = FieldDescriptor("k", "L", FieldKind.STRING, "hello")
    assert _format_value(fd) == "hello"


def test_format_value_bool_true() -> None:
    fd = FieldDescriptor("k", "L", FieldKind.BOOL, True)
    assert _format_value(fd) == "yes"


def test_format_value_bool_false() -> None:
    fd = FieldDescriptor("k", "L", FieldKind.BOOL, False)
    assert _format_value(fd) == "no"


def test_format_value_list_str() -> None:
    fd = FieldDescriptor("k", "L", FieldKind.LIST_STR, ["a", "b", "c"])
    assert _format_value(fd) == "a, b, c"


def test_format_value_list_empty() -> None:
    fd = FieldDescriptor("k", "L", FieldKind.LIST_STR, [])
    assert _format_value(fd) == "(empty)"


def test_format_value_dict() -> None:
    fd = FieldDescriptor("k", "L", FieldKind.DICT_STR_STR, {"X": "1", "Y": "2"})
    assert _format_value(fd) == "X=1, Y=2"


def test_format_value_dict_empty() -> None:
    fd = FieldDescriptor("k", "L", FieldKind.DICT_STR_STR, {})
    assert _format_value(fd) == "(empty)"


def test_coerce_int() -> None:
    assert _coerce(FieldKind.INT, "42") == 42


def test_coerce_float() -> None:
    assert _coerce(FieldKind.FLOAT, "3.14") == pytest.approx(3.14)


def test_coerce_path() -> None:
    result = _coerce(FieldKind.PATH, "/tmp/foo")
    assert result == Path("/tmp/foo")


def test_coerce_string() -> None:
    assert _coerce(FieldKind.STRING, "hello") == "hello"


def test_coerce_int_invalid() -> None:
    with pytest.raises(ValueError):
        _coerce(FieldKind.INT, "notanint")


def test_as_path_from_path() -> None:
    p = Path("/a/b")
    assert _as_path(p, Path("/fallback")) == p


def test_as_path_from_string() -> None:
    assert _as_path("/a/b", Path("/fallback")) == Path("/a/b")


def test_as_path_none_returns_fallback() -> None:
    assert _as_path(None, Path("/fallback")) == Path("/fallback")


def test_as_path_or_none_none() -> None:
    assert _as_path_or_none(None) is None


def test_as_path_or_none_empty_string() -> None:
    assert _as_path_or_none("") is None


def test_as_path_or_none_valid() -> None:
    assert _as_path_or_none("/tmp") == Path("/tmp")


def test_workflow_menu_rows_order() -> None:
    model = WorkflowEditorModel(_bash_workflow())

    rows = model.menu_rows()

    assert rows[0].kind == WorkflowMenuRowKind.WORKFLOW_INFO
    assert rows[1].kind == WorkflowMenuRowKind.SECTION_HEADER
    assert rows[1].title == "Nodes"
    assert [row.node_id for row in rows if row.kind == WorkflowMenuRowKind.NODE] == [
        "step1",
        "step2",
    ]
    edges = [row for row in rows if row.kind == WorkflowMenuRowKind.EDGE]
    assert len(edges) == 1
    assert edges[0].title == "step1 -> step2"


def test_workflow_menu_nodes_not_expanded_into_fields() -> None:
    model = WorkflowEditorModel(_bash_workflow())

    rows = [row for row in model.menu_rows() if row.kind == WorkflowMenuRowKind.NODE]

    assert len(rows) == 2
    assert all("command" not in row.title for row in rows)


def test_workflow_menu_edges_listed_one_per_row() -> None:
    wf = _bash_workflow()
    wf.add_operation(
        GraphNode(
            node_id="step3",
            operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="echo done"),
        )
    )
    wf.then("step2", "step3")

    rows = [row for row in WorkflowEditorModel(wf).menu_rows() if row.kind == WorkflowMenuRowKind.EDGE]

    assert [row.title for row in rows] == ["step1 -> step2", "step2 -> step3"]


def test_workflow_info_edit_updates_config() -> None:
    wf = _bash_workflow()
    model = WorkflowEditorModel(wf)

    model.update_workflow_info(
        name="Updated Workflow",
        cron_expression="0 8 * * 1",
        timezone="US/Eastern",
    )

    assert wf.config.name == "Updated Workflow"
    assert wf.config.schedule is not None
    assert wf.config.schedule.cron_expression == "0 8 * * 1"
    assert wf.config.schedule.timezone == "US/Eastern"


def test_add_node_inserts_graph_node() -> None:
    wf = _bash_workflow()
    model = WorkflowEditorModel(wf)

    model.add_node(
        GraphNode(
            node_id="step3",
            operation=PythonScriptOperation(
                type=OperationType.PYTHON_SCRIPT,
                script_path=Path("/scripts/run.py"),
                args=["--flag"],
            ),
            pipe_output=True,
        )
    )

    node = wf.graph._nodes["step3"]
    assert isinstance(node.operation, PythonScriptOperation)
    assert node.pipe_output is True


def test_delete_node_removes_attached_edges() -> None:
    wf = _bash_workflow()
    wf.add_operation(
        GraphNode(
            node_id="step3",
            operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="echo done"),
        )
    )
    wf.then("step2", "step3")
    model = WorkflowEditorModel(wf)

    model.delete_node("step2")

    assert "step2" not in wf.graph._nodes
    assert ("step1", "step2") not in wf.graph._edges
    assert ("step2", "step3") not in wf.graph._edges


def test_edit_node_updates_operation_and_shared_fields() -> None:
    wf = _bash_workflow()
    node = wf.graph._nodes["step2"]
    section = _node_to_section(node)
    fm = {fd.key: fd for fd in section.fields}
    fm["nodes.step2.command"].value = "echo changed"
    fm["nodes.step2.retry_count"].value = 5
    fm["nodes.step2.pipe_output"].value = True

    updated = _sections_to_node([section], node)
    WorkflowEditorModel(wf).update_node("step2", updated)

    changed = wf.graph._nodes["step2"]
    assert isinstance(changed.operation, BashCommandOperation)
    assert changed.operation.command == "echo changed"
    assert changed.retry_count == 5
    assert changed.pipe_output is True


def test_add_edge_stores_expected_config() -> None:
    wf = _bash_workflow()
    wf.add_operation(
        GraphNode(
            node_id="step3",
            operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="echo done"),
        )
    )
    model = WorkflowEditorModel(wf)

    model.add_edge(
        EdgeConfig(
            from_node="step2",
            to_node="step3",
            condition=EdgeConditionType.OUTPUT_MATCHES,
            output_pattern="ok",
        )
    )

    edge = wf.graph._edges[("step2", "step3")]
    assert edge.condition == EdgeConditionType.OUTPUT_MATCHES
    assert edge.output_pattern == "ok"


def test_edit_edge_updates_condition_and_pattern() -> None:
    wf = _bash_workflow()
    edge = wf.graph._edges[("step1", "step2")]
    section = Section(
        "Edge",
        [
            FieldDescriptor("edge.from", "From", FieldKind.CHOICE, "step1", choices=["step1", "step2"]),
            FieldDescriptor("edge.to", "To", FieldKind.CHOICE, "step2", choices=["step1", "step2"]),
            FieldDescriptor(
                "edge.condition",
                "Condition",
                FieldKind.CHOICE,
                EdgeConditionType.OUTPUT_MATCHES.value,
                choices=[condition.value for condition in EdgeConditionType],
            ),
            FieldDescriptor("edge.output_pattern", "Output Pattern", FieldKind.STRING, "done", optional=True),
        ],
    )

    WorkflowEditorModel(wf).update_edge(("step1", "step2"), _sections_to_edge([section]))

    updated = wf.graph._edges[("step1", "step2")]
    assert updated.condition == EdgeConditionType.OUTPUT_MATCHES
    assert updated.output_pattern == "done"
    assert edge.from_node == "step1"


def test_add_edge_rejects_cycles() -> None:
    wf = _bash_workflow()
    model = WorkflowEditorModel(wf)

    with pytest.raises(CycleError):
        model.add_edge(EdgeConfig(from_node="step2", to_node="step1"))


def test_edit_edge_rejects_cycles() -> None:
    wf = _bash_workflow()
    wf.add_operation(
        GraphNode(
            node_id="step3",
            operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="echo done"),
        )
    )
    wf.then("step2", "step3")
    model = WorkflowEditorModel(wf)

    with pytest.raises(CycleError):
        model.update_edge(
            ("step2", "step3"),
            EdgeConfig(from_node="step3", to_node="step1"),
        )

    assert ("step2", "step3") in wf.graph._edges


def test_enter_on_node_opens_node_detail() -> None:
    captured: list[str] = []

    def factory(sections: list[Section], title: str) -> _FakeDetailEditor:
        return _FakeDetailEditor(sections, title, mutate=None, should_save=False)

    app = WorkflowEditorApp(_bash_workflow(), detail_editor_factory=factory)
    app._cursor = 2
    app.open_selected_detail()

    row = app.current_row()
    assert row.kind == WorkflowMenuRowKind.NODE
    section = _node_to_section(app.workflow.graph._nodes["step1"])
    captured.append(section.title)
    assert captured == ["Node: step1 [bash_command]"]


def test_enter_on_workflow_info_opens_detail() -> None:
    titles: list[str] = []

    def factory(sections: list[Section], title: str) -> _FakeDetailEditor:
        titles.append(title)
        return _FakeDetailEditor(sections, title, should_save=False)

    app = WorkflowEditorApp(_bash_workflow(), detail_editor_factory=factory)
    app._cursor = 0
    app.open_selected_detail()

    assert titles == ["Workflow Info: wf1"]


def test_save_and_cancel_semantics_leave_original_workflow_unchanged() -> None:
    original = _bash_workflow()
    editable = _bash_workflow()

    def mutate_name(sections: list[Section], title: str) -> None:
        section = sections[0]
        next(fd for fd in section.fields if fd.key == "config.name").value = "Edited"

    app = WorkflowEditorApp(
        editable,
        detail_editor_factory=lambda sections, title: _FakeDetailEditor(
            sections, title, mutate=mutate_name, should_save=True
        ),
    )
    app.open_selected_detail()

    assert editable.config.name == "Edited"
    assert original.config.name == "Workflow One"

    cancelled = _bash_workflow()
    cancel_app = WorkflowEditorApp(
        cancelled,
        detail_editor_factory=lambda sections, title: _FakeDetailEditor(
            sections, title, mutate=mutate_name, should_save=False
        ),
    )
    cancel_app.open_selected_detail()

    assert cancelled.config.name == "Workflow One"


def test_workflow_info_section_id_read_only() -> None:
    section = _workflow_info_section(_bash_workflow())
    id_field = next(fd for fd in section.fields if fd.key == "config.id")
    assert id_field.read_only is True


def test_sections_to_node_agent_operation_round_trip() -> None:
    node = GraphNode(
        node_id="agent-node",
        operation=AgentOperation(
            type=OperationType.AGENT,
            agent_id="agent-1",
            prompt_path=Path("/prompts/prompt.md"),
            working_dir=Path("/work"),
            dynamic_count=3,
        ),
    )
    section = _node_to_section(node)

    updated = _sections_to_node([section], node)

    assert isinstance(updated.operation, AgentOperation)
    assert updated.operation.agent_id == "agent-1"
    assert updated.operation.dynamic_count == 3


def test_agent_to_sections_structure() -> None:
    cfg = _agent_config()
    sections = agent_to_sections(cfg)
    assert len(sections) == 1
    keys = {fd.key for fd in sections[0].fields}
    assert "agent.agent_id" in keys
    assert "agent.subscription" in keys
    assert "agent.tools" in keys
    assert "agent.env" in keys


def test_agent_to_sections_agent_id_readonly() -> None:
    cfg = _agent_config()
    sections = agent_to_sections(cfg)
    id_fd = next(fd for fd in sections[0].fields if fd.key == "agent.agent_id")
    assert id_fd.read_only is True


def test_agent_to_sections_values() -> None:
    cfg = _agent_config()
    sections = agent_to_sections(cfg)
    fm = {fd.key: fd.value for fd in sections[0].fields}
    assert fm["agent.subscription"] == "claude_code"
    assert fm["agent.tools"] == ["bash", "read"]
    assert fm["agent.env"] == {"DEBUG": "1"}


def test_sections_to_agent_roundtrip() -> None:
    cfg = _agent_config()
    sections = agent_to_sections(cfg)
    result = sections_to_agent(sections, cfg)
    assert result.subscription == cfg.subscription
    assert result.working_dir == cfg.working_dir
    assert result.tools == cfg.tools
    assert result.env == cfg.env


def test_sections_to_agent_updates_subscription() -> None:
    cfg = _agent_config()
    sections = agent_to_sections(cfg)
    sub_fd = next(fd for fd in sections[0].fields if fd.key == "agent.subscription")
    sub_fd.value = "codex"
    result = sections_to_agent(sections, cfg)
    assert result.subscription == "codex"


def test_sections_to_agent_updates_tools() -> None:
    cfg = _agent_config()
    sections = agent_to_sections(cfg)
    tools_fd = next(fd for fd in sections[0].fields if fd.key == "agent.tools")
    tools_fd.value = ["bash", "read", "write"]
    result = sections_to_agent(sections, cfg)
    assert result.tools == ["bash", "read", "write"]


def test_field_editor_flat_count() -> None:
    sections = [
        Section("A", [
            FieldDescriptor("a.x", "X", FieldKind.STRING, "foo"),
            FieldDescriptor("a.y", "Y", FieldKind.INT, 1),
        ]),
        Section("B", [
            FieldDescriptor("b.z", "Z", FieldKind.BOOL, True),
        ]),
    ]
    app = FieldEditorApp(sections, title="Test")
    assert len(app._flat) == 3


def test_field_editor_initial_cursor() -> None:
    sections = [Section("A", [FieldDescriptor("k", "L", FieldKind.STRING, "v")])]
    app = FieldEditorApp(sections, title="T")
    assert app._cursor == 0
    assert app._saved is False
