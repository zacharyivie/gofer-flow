"""Unit tests for tui_editor pure functions (no TTY required)."""

from __future__ import annotations

from pathlib import Path

import pytest

from gofer.cli.tui_editor import (
    FieldDescriptor,
    FieldEditorApp,
    FieldKind,
    Section,
    _as_path,
    _as_path_or_none,
    _coerce,
    _format_value,
    agent_to_sections,
    sections_to_agent,
    sections_to_workflow,
    workflow_to_sections,
)
from gofer.core.agent import AgentConfig
from gofer.core.graph import GraphNode
from gofer.core.operations import (
    AgentOperation,
    BashCommandOperation,
    HttpRequestOperation,
    HttpRetryPolicy,
    OperationType,
    PythonScriptOperation,
    ShellScriptOperation,
)
from gofer.core.workflow import AgenticWorkflow, ScheduleConfig, WorkflowConfig

# ── Helpers ───────────────────────────────────────────────────────────────────


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
    wf.then("step1", "step2")
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


# ── _format_value ─────────────────────────────────────────────────────────────


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


# ── _coerce ───────────────────────────────────────────────────────────────────


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


# ── _as_path helpers ──────────────────────────────────────────────────────────


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


# ── workflow_to_sections ─────────────────────────────────────────────────────


def test_workflow_to_sections_structure() -> None:
    wf = _bash_workflow()
    sections = workflow_to_sections(wf)

    assert sections[0].title == "Workflow"
    wf_keys = {fd.key for fd in sections[0].fields}
    assert "config.id" in wf_keys
    assert "config.name" in wf_keys
    assert "config.schedule.cron_expression" in wf_keys

    # Two node sections
    node_titles = {s.title for s in sections[1:]}
    assert any("step1" in t for t in node_titles)
    assert any("step2" in t for t in node_titles)


def test_workflow_to_sections_id_readonly() -> None:
    wf = _bash_workflow()
    sections = workflow_to_sections(wf)
    id_fd = next(fd for fd in sections[0].fields if fd.key == "config.id")
    assert id_fd.read_only is True


def test_workflow_to_sections_schedule_optional() -> None:
    wf = _bash_workflow()
    sections = workflow_to_sections(wf)
    cron_fd = next(
        fd for fd in sections[0].fields if fd.key == "config.schedule.cron_expression"
    )
    assert cron_fd.optional is True
    assert cron_fd.value is None


def test_workflow_to_sections_with_schedule() -> None:
    wf = AgenticWorkflow(
        WorkflowConfig(
            id="wf2",
            name="Scheduled",
            schedule=ScheduleConfig(cron_expression="0 9 * * *", timezone="US/Eastern"),
        )
    )
    sections = workflow_to_sections(wf)
    cron_fd = next(
        fd for fd in sections[0].fields if fd.key == "config.schedule.cron_expression"
    )
    assert cron_fd.value == "0 9 * * *"


def test_workflow_to_sections_bash_fields() -> None:
    wf = _bash_workflow()
    sections = workflow_to_sections(wf)
    step2_sec = next(s for s in sections if "step2" in s.title)
    step2_keys = {fd.key for fd in step2_sec.fields}
    assert "nodes.step2.command" in step2_keys
    assert "nodes.step2.retry_count" in step2_keys
    assert "nodes.step2.timeout_seconds" in step2_keys


def test_workflow_to_sections_node_values() -> None:
    wf = _bash_workflow()
    sections = workflow_to_sections(wf)
    step2_sec = next(s for s in sections if "step2" in s.title)
    fm = {fd.key: fd.value for fd in step2_sec.fields}
    assert fm["nodes.step2.command"] == "echo bye"
    assert fm["nodes.step2.retry_count"] == 2
    assert fm["nodes.step2.timeout_seconds"] == 30.0
    assert fm["nodes.step2.env"] == {"FOO": "bar"}


# ── sections_to_workflow ──────────────────────────────────────────────────────


def test_sections_to_workflow_name_change() -> None:
    wf = _bash_workflow()
    sections = workflow_to_sections(wf)
    name_fd = next(fd for fd in sections[0].fields if fd.key == "config.name")
    name_fd.value = "Updated Name"
    sections_to_workflow(sections, wf)
    assert wf.config.name == "Updated Name"


def test_sections_to_workflow_adds_schedule() -> None:
    wf = _bash_workflow()
    sections = workflow_to_sections(wf)
    cron_fd = next(
        fd for fd in sections[0].fields if fd.key == "config.schedule.cron_expression"
    )
    cron_fd.value = "0 8 * * 1"
    sections_to_workflow(sections, wf)
    assert wf.config.schedule is not None
    assert wf.config.schedule.cron_expression == "0 8 * * 1"


def test_sections_to_workflow_clears_schedule() -> None:
    wf = AgenticWorkflow(
        WorkflowConfig(
            id="wf3",
            name="Sched",
            schedule=ScheduleConfig(cron_expression="0 9 * * *"),
        )
    )
    wf.add_operation(
        GraphNode(
            node_id="n1",
            operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="echo"),
        )
    )
    sections = workflow_to_sections(wf)
    cron_fd = next(
        fd for fd in sections[0].fields if fd.key == "config.schedule.cron_expression"
    )
    cron_fd.value = None
    sections_to_workflow(sections, wf)
    assert wf.config.schedule is None


def test_sections_to_workflow_updates_bash_command() -> None:
    wf = _bash_workflow()
    sections = workflow_to_sections(wf)
    step1_sec = next(s for s in sections if "step1" in s.title)
    cmd_fd = next(fd for fd in step1_sec.fields if fd.key == "nodes.step1.command")
    cmd_fd.value = "echo updated"
    sections_to_workflow(sections, wf)
    node = wf.graph._nodes["step1"]
    assert isinstance(node.operation, BashCommandOperation)
    assert node.operation.command == "echo updated"


def test_sections_to_workflow_updates_retry_count() -> None:
    wf = _bash_workflow()
    sections = workflow_to_sections(wf)
    step2_sec = next(s for s in sections if "step2" in s.title)
    rc_fd = next(fd for fd in step2_sec.fields if fd.key == "nodes.step2.retry_count")
    rc_fd.value = 5
    sections_to_workflow(sections, wf)
    assert wf.graph._nodes["step2"].retry_count == 5


def test_workflow_to_sections_python_script() -> None:
    wf = AgenticWorkflow(WorkflowConfig(id="py", name="Py"))
    wf.add_operation(
        GraphNode(
            node_id="pyscript",
            operation=PythonScriptOperation(
                type=OperationType.PYTHON_SCRIPT,
                script_path=Path("/scripts/run.py"),
                args=["--verbose"],
            ),
        )
    )
    sections = workflow_to_sections(wf)
    node_sec = next(s for s in sections if "pyscript" in s.title)
    keys = {fd.key for fd in node_sec.fields}
    assert "nodes.pyscript.script_path" in keys
    assert "nodes.pyscript.args" in keys


def test_workflow_to_sections_shell_script() -> None:
    wf = AgenticWorkflow(WorkflowConfig(id="sh", name="Sh"))
    wf.add_operation(
        GraphNode(
            node_id="shscript",
            operation=ShellScriptOperation(
                type=OperationType.SHELL_SCRIPT,
                script_path=Path("/scripts/run.sh"),
            ),
        )
    )
    sections = workflow_to_sections(wf)
    node_sec = next(s for s in sections if "shscript" in s.title)
    keys = {fd.key for fd in node_sec.fields}
    assert "nodes.shscript.script_path" in keys


def test_workflow_to_sections_agent_operation() -> None:
    wf = AgenticWorkflow(WorkflowConfig(id="ag", name="Ag"))
    wf.add_operation(
        GraphNode(
            node_id="agent_node",
            operation=AgentOperation(
                type=OperationType.AGENT,
                agent_id="myagent",
                prompt_path=Path("/prompts/p.md"),
                working_dir=Path("/work"),
                dynamic_count=3,
            ),
        )
    )
    sections = workflow_to_sections(wf)
    node_sec = next(s for s in sections if "agent_node" in s.title)
    keys = {fd.key for fd in node_sec.fields}
    assert "nodes.agent_node.agent_id" in keys
    assert "nodes.agent_node.prompt_path" in keys
    assert "nodes.agent_node.dynamic_count" in keys


def test_workflow_to_sections_http_request_includes_json_and_retry_controls() -> None:
    wf = AgenticWorkflow(WorkflowConfig(id="http", name="HTTP"))
    wf.add_operation(
        GraphNode(
            node_id="api",
            operation=HttpRequestOperation(
                type=OperationType.HTTP_REQUEST,
                method="POST",
                url="https://api.example.test/issues",
                json={"title": "Bug"},
                retry=HttpRetryPolicy(
                    attempts=3,
                    backoff_seconds=1.5,
                    retry_on_statuses=[429, 503],
                ),
            ),
        )
    )

    sections = workflow_to_sections(wf)
    node_sec = next(s for s in sections if "api" in s.title)
    fm = {fd.key: fd.value for fd in node_sec.fields}

    assert '"title": "Bug"' in fm["nodes.api.json_payload"]
    assert fm["nodes.api.retry.attempts"] == 3
    assert fm["nodes.api.retry.backoff_seconds"] == 1.5
    assert fm["nodes.api.retry.retry_on_statuses"] == ["429", "503"]


def test_sections_to_workflow_updates_http_json_and_retry_policy() -> None:
    wf = AgenticWorkflow(WorkflowConfig(id="http", name="HTTP"))
    wf.add_operation(
        GraphNode(
            node_id="api",
            operation=HttpRequestOperation(
                type=OperationType.HTTP_REQUEST,
                url="https://api.example.test/issues",
            ),
        )
    )
    sections = workflow_to_sections(wf)
    node_sec = next(s for s in sections if "api" in s.title)
    fields = {fd.key: fd for fd in node_sec.fields}
    fields["nodes.api.json_payload"].value = '{"title": "{{previous.output}}"}'
    fields["nodes.api.retry.attempts"].value = 4
    fields["nodes.api.retry.backoff_seconds"].value = 2.0
    fields["nodes.api.retry.retry_on_statuses"].value = ["429", "503"]

    sections_to_workflow(sections, wf)
    op = wf.graph._nodes["api"].operation

    assert isinstance(op, HttpRequestOperation)
    assert op.json_payload == {"title": "{{previous.output}}"}
    assert op.retry.attempts == 4
    assert op.retry.backoff_seconds == 2.0
    assert op.retry.retry_on_statuses == [429, 503]


# ── agent_to_sections / sections_to_agent ────────────────────────────────────


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


# ── FieldEditorApp construction ───────────────────────────────────────────────


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
