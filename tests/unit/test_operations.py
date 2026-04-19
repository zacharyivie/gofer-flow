from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

from agentic_task_manager.core.operations import (
    AgentOperation,
    BashCommandOperation,
    Operation,
    OperationType,
    PythonScriptOperation,
    ShellScriptOperation,
)

adapter: TypeAdapter[Operation] = TypeAdapter(Operation)


def test_bash_command_roundtrip() -> None:
    op = BashCommandOperation(type=OperationType.BASH_COMMAND, command="echo hi")
    data = op.model_dump()
    parsed = adapter.validate_python(data)
    assert isinstance(parsed, BashCommandOperation)
    assert parsed.command == "echo hi"


def test_python_script_roundtrip() -> None:
    op = PythonScriptOperation(
        type=OperationType.PYTHON_SCRIPT, script_path=Path("/tmp/foo.py"), args=["--verbose"]
    )
    data = op.model_dump()
    parsed = adapter.validate_python(data)
    assert isinstance(parsed, PythonScriptOperation)
    assert parsed.args == ["--verbose"]


def test_shell_script_roundtrip() -> None:
    op = ShellScriptOperation(
        type=OperationType.SHELL_SCRIPT, script_path=Path("/tmp/bar.sh")
    )
    parsed = adapter.validate_python(op.model_dump())
    assert isinstance(parsed, ShellScriptOperation)


def test_agent_operation_defaults() -> None:
    op = AgentOperation(
        type=OperationType.AGENT,
        agent_id="summarizer",
        prompt_path=Path("prompts/sum.md"),
        working_dir=Path("/srv/repo"),
    )
    assert op.dynamic_count == 1
    assert op.input_mapping == {}


def test_agent_operation_dynamic_count_string() -> None:
    op = AgentOperation(
        type=OperationType.AGENT,
        agent_id="a",
        prompt_path=Path("p.md"),
        working_dir=Path("/tmp"),
        dynamic_count="{{prev.output.count}}",
    )
    assert op.dynamic_count == "{{prev.output.count}}"


def test_invalid_discriminator_raises() -> None:
    with pytest.raises((ValidationError, KeyError)):
        adapter.validate_python({"type": "unknown_type"})
