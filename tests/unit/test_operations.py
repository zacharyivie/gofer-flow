from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

from gofer.core.operations import (
    AgentOperation,
    BashCommandOperation,
    CommonLlmTaskOperation,
    CopyFileOperation,
    DeleteFileOperation,
    LocalSearchOperation,
    LocalVectorizeOperation,
    MoveFileOperation,
    OpenResourceOperation,
    Operation,
    OperationType,
    PromptFileOperation,
    PythonScriptOperation,
    ReadFileOperation,
    ShellScriptOperation,
    TriggerEventsFanSource,
    WriteFileOperation,
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


def test_agent_operation_allows_skill_without_prompt_path() -> None:
    op = AgentOperation(
        type=OperationType.AGENT,
        agent_id="builder",
        working_dir=Path("/srv/repo"),
        skill_name="gofer-flow-workflow-builder",
    )
    assert op.prompt_path is None
    assert op.skill_name == "gofer-flow-workflow-builder"


def test_agent_operation_dynamic_count_string() -> None:
    op = AgentOperation(
        type=OperationType.AGENT,
        agent_id="a",
        prompt_path=Path("p.md"),
        working_dir=Path("/tmp"),
        dynamic_count="{{prev.output.count}}",
    )
    assert op.dynamic_count == "{{prev.output.count}}"


def test_file_io_operations_roundtrip() -> None:
    operations = [
        ReadFileOperation(type=OperationType.READ_FILE, path=Path("input.txt")),
        WriteFileOperation(type=OperationType.WRITE_FILE, path=Path("output.txt")),
        CopyFileOperation(
            type=OperationType.COPY_FILE,
            source_path=Path("input.txt"),
            destination_path=Path("output.txt"),
        ),
        MoveFileOperation(
            type=OperationType.MOVE_FILE,
            source_path=Path("old.txt"),
            destination_path=Path("new.txt"),
        ),
        DeleteFileOperation(type=OperationType.DELETE_FILE, path=Path("old.txt")),
        OpenResourceOperation(type=OperationType.OPEN_RESOURCE, target="https://example.com"),
        AgentOperation(
            type=OperationType.AGENT,
            agent_id="a",
            prompt_path=Path("p.md"),
            working_dir=Path("."),
            fan_source=TriggerEventsFanSource(type="trigger_events"),
        ),
        PromptFileOperation(
            type=OperationType.PROMPT_FILE,
            output_path=Path("prompts/generated.md"),
            template="Hello {{name}}",
            variables={"name": "world"},
        ),
        CommonLlmTaskOperation(
            type=OperationType.COMMON_LLM_TASK,
            agent_id="reviewer",
            task="review",
            working_dir=Path("."),
        ),
        LocalVectorizeOperation(
            type=OperationType.LOCAL_VECTORIZE,
            source_path=Path("docs"),
            index_path=Path("indexes/docs.json"),
        ),
        LocalSearchOperation(
            type=OperationType.LOCAL_SEARCH,
            index_path=Path("indexes/docs.json"),
            query="hello",
        ),
    ]

    for operation in operations:
        parsed = adapter.validate_python(operation.model_dump())
        assert type(parsed) is type(operation)


def test_invalid_discriminator_raises() -> None:
    with pytest.raises((ValidationError, KeyError)):
        adapter.validate_python({"type": "unknown_type"})
