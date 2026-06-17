from __future__ import annotations

from pathlib import Path

import anyio

from gofer.core import executor as executor_module
from gofer.core.agent import AgentConfig
from gofer.core.executor import WorkflowExecutor, command_shell_args
from gofer.core.graph import EdgeConditionType, EdgeConfig, GraphNode
from gofer.core.operations import (
    AgentOperation,
    BashCommandOperation,
    CommonLlmTaskOperation,
    CopyFileOperation,
    DeleteFileOperation,
    LocalSearchOperation,
    LocalVectorizeOperation,
    MoveFileOperation,
    OperationType,
    PythonScriptOperation,
    PromptFileOperation,
    ReadFileOperation,
    TriggerEventsFanSource,
    WriteFileOperation,
)
from gofer.core.workflow import AgenticWorkflow, WorkflowConfig
from tests.conftest import FakeSubscription
from gofer.utils.run_state import request_workflow_stop, workflow_stop_path


def _bash_node(node_id: str, command: str = "true") -> GraphNode:
    return GraphNode(
        node_id=node_id,
        operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command=command),
    )


def _make_workflow(wf_id: str = "test") -> AgenticWorkflow:
    return AgenticWorkflow(WorkflowConfig(id=wf_id, name="Test"))


def test_command_shell_args_uses_bash_off_windows(monkeypatch) -> None:
    monkeypatch.setattr(executor_module.sys, "platform", "linux")

    assert command_shell_args("echo hello") == ["bash", "-c", "echo hello"]


def test_command_shell_args_uses_powershell_on_windows(monkeypatch) -> None:
    monkeypatch.setattr(executor_module.sys, "platform", "win32")

    assert command_shell_args("Write-Output hello") == [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Write-Output hello",
    ]


async def test_single_bash_node_succeeds(tmp_path: Path) -> None:
    wf = _make_workflow()
    wf.add_operation(_bash_node("echo", "echo hello"))
    executor = WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs")
    result = await executor.run()
    assert result.success
    assert "echo" in result.node_outputs


async def test_stop_marker_interrupts_running_workflow(tmp_path: Path) -> None:
    wf = _make_workflow("stop-marker")
    wf.add_operation(_bash_node("sleep", "sleep 5"))
    stop_file = workflow_stop_path("stop-marker", tmp_path)
    run_result = None

    async def run_workflow() -> None:
        nonlocal run_result
        run_result = await WorkflowExecutor(
            wf,
            {},
            log_base_dir=tmp_path / "logs",
            stop_file=stop_file,
        ).run()

    async with anyio.create_task_group() as tg:
        tg.start_soon(run_workflow)
        await anyio.sleep(0.2)
        request_workflow_stop("stop-marker", tmp_path)

    assert run_result is not None
    assert not run_result.success
    assert "stopped by user" in run_result.log_path.read_text()


async def test_linear_execution_order(tmp_path: Path) -> None:
    wf = _make_workflow()
    wf.add_operation(_bash_node("a", "true"))
    wf.add_operation(_bash_node("b", "true"))
    wf.then("a", "b")

    executor = WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs")
    result = await executor.run()
    assert result.success
    assert set(result.node_outputs) == {"a", "b"}


async def test_failure_halts_workflow(tmp_path: Path) -> None:
    wf = _make_workflow()
    wf.add_operation(GraphNode(
        node_id="fail",
        operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="false"),
        on_failure="halt",
    ))
    wf.add_operation(_bash_node("after"))
    wf.then("fail", "after")

    executor = WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs")
    result = await executor.run()
    assert not result.success
    assert "after" not in result.node_outputs


async def test_failure_skip_continues(tmp_path: Path) -> None:
    wf = _make_workflow()
    wf.add_operation(GraphNode(
        node_id="fail",
        operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="false"),
        on_failure="skip",
    ))
    wf.add_operation(_bash_node("after"))
    wf.then("fail", "after")

    executor = WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs")
    result = await executor.run()
    assert "after" in result.node_outputs


async def test_failed_bash_command_routes_to_on_failure_edge(tmp_path: Path) -> None:
    wf = _make_workflow()
    wf.add_operation(_bash_node("fail", "1/0"))
    wf.add_operation(_bash_node("recover", "echo recovered"))
    wf.then(
        "fail",
        "recover",
        EdgeConfig(
            from_node="fail",
            to_node="recover",
            condition=EdgeConditionType.ON_FAILURE,
        ),
    )

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert not result.success
    assert not result.node_outputs["fail"].success
    assert result.node_outputs["recover"].success
    assert "recovered" in result.node_outputs["recover"].output


async def test_uncaught_python_exception_routes_to_on_failure_edge(tmp_path: Path) -> None:
    script = tmp_path / "explode.py"
    script.write_text("1 / 0\n")

    wf = _make_workflow()
    wf.add_operation(GraphNode(
        node_id="explode",
        operation=PythonScriptOperation(
            type=OperationType.PYTHON_SCRIPT,
            script_path=script,
        ),
    ))
    wf.add_operation(_bash_node("recover", "echo python recovered"))
    wf.then(
        "explode",
        "recover",
        EdgeConfig(
            from_node="explode",
            to_node="recover",
            condition=EdgeConditionType.ON_FAILURE,
        ),
    )

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert not result.success
    assert not result.node_outputs["explode"].success
    assert "ZeroDivisionError" in result.node_outputs["explode"].output
    assert result.node_outputs["recover"].success
    assert "python recovered" in result.node_outputs["recover"].output


async def test_read_file_outputs_file_content(tmp_path: Path) -> None:
    source = tmp_path / "input.txt"
    source.write_text("hello from a file")
    wf = _make_workflow()
    wf.add_operation(GraphNode(
        node_id="read",
        operation=ReadFileOperation(type=OperationType.READ_FILE, path=source),
    ))

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert result.success
    assert result.node_outputs["read"].output == "hello from a file"


async def test_write_file_uses_piped_input_when_content_empty(tmp_path: Path) -> None:
    destination = tmp_path / "out" / "result.txt"
    wf = _make_workflow()
    wf.add_operation(GraphNode(
        node_id="produce",
        operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="printf piped"),
        pipe_output=True,
    ))
    wf.add_operation(GraphNode(
        node_id="write",
        operation=WriteFileOperation(type=OperationType.WRITE_FILE, path=destination),
    ))
    wf.then("produce", "write")

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert result.success
    assert destination.read_text() == "piped"
    assert "wrote 5 characters" in result.node_outputs["write"].output


async def test_copy_move_and_delete_file_nodes(tmp_path: Path) -> None:
    source = tmp_path / "source.txt"
    copied = tmp_path / "copied.txt"
    moved = tmp_path / "moved.txt"
    source.write_text("contents")
    wf = _make_workflow()
    wf.add_operation(GraphNode(
        node_id="copy",
        operation=CopyFileOperation(
            type=OperationType.COPY_FILE,
            source_path=source,
            destination_path=copied,
        ),
    ))
    wf.add_operation(GraphNode(
        node_id="move",
        operation=MoveFileOperation(
            type=OperationType.MOVE_FILE,
            source_path=copied,
            destination_path=moved,
        ),
    ))
    wf.add_operation(GraphNode(
        node_id="delete",
        operation=DeleteFileOperation(
            type=OperationType.DELETE_FILE,
            path=moved,
            use_trash=False,
        ),
    ))
    wf.then("copy", "move")
    wf.then("move", "delete")

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert result.success
    assert source.read_text() == "contents"
    assert not copied.exists()
    assert not moved.exists()


async def test_delete_file_uses_gofer_trash_by_default(tmp_path: Path, monkeypatch) -> None:
    data_dir = tmp_path / "data"
    target = tmp_path / "delete-me.txt"
    target.write_text("trash me")
    monkeypatch.setattr("gofer.core.executor.get_data_dir", lambda: data_dir)
    wf = _make_workflow()
    wf.add_operation(GraphNode(
        node_id="trash",
        operation=DeleteFileOperation(type=OperationType.DELETE_FILE, path=target),
    ))

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert result.success
    assert not target.exists()
    trashed = list((data_dir / "trash").iterdir())
    assert len(trashed) == 1
    assert trashed[0].read_text() == "trash me"


async def test_prompt_file_node_renders_template_variables(tmp_path: Path) -> None:
    output = tmp_path / "prompts" / "generated.md"
    wf = _make_workflow()
    wf.add_operation(GraphNode(
        node_id="make-prompt",
        operation=PromptFileOperation(
            type=OperationType.PROMPT_FILE,
            output_path=output,
            template="Summarize {{topic}}",
            variables={"topic": "gofer flow"},
        ),
    ))

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert result.success
    assert output.read_text() == "Summarize gofer flow"


async def test_common_llm_task_uses_agent_subscription(tmp_path: Path) -> None:
    sub = FakeSubscription(output="summary")
    wf = _make_workflow()
    wf.register_agent(AgentConfig(
        agent_id="bot",
        subscription="claude_code",
        working_dir=tmp_path,
        prompt_path=tmp_path / "unused.md",
    ))
    wf.add_operation(GraphNode(
        node_id="summarize",
        operation=CommonLlmTaskOperation(
            type=OperationType.COMMON_LLM_TASK,
            agent_id="bot",
            task="summarize",
            target="README.md",
            working_dir=tmp_path,
        ),
    ))

    result = await WorkflowExecutor(
        wf, {"claude_code": sub}, log_base_dir=tmp_path / "logs"
    ).run()

    assert result.success
    assert result.node_outputs["summarize"].output == "summary"
    assert "Summarize" in str(sub.calls[0]["prompt"])
    assert "README.md" in str(sub.calls[0]["prompt"])


async def test_agent_node_can_call_skill_without_prompt_path(tmp_path: Path) -> None:
    sub = FakeSubscription(output="done")
    wf = _make_workflow()
    wf.register_agent(AgentConfig(
        agent_id="builder",
        subscription="claude_code",
        working_dir=tmp_path,
        prompt_path=tmp_path / "unused.md",
    ))
    wf.add_operation(GraphNode(
        node_id="skill",
        operation=AgentOperation(
            type=OperationType.AGENT,
            agent_id="builder",
            working_dir=tmp_path,
            skill_name="gofer-flow-workflow-builder",
        ),
    ))

    result = await WorkflowExecutor(
        wf, {"claude_code": sub}, log_base_dir=tmp_path / "logs"
    ).run()

    assert result.success
    assert sub.calls[0]["prompt"] == "/gofer-flow-workflow-builder"


async def test_local_vectorize_and_search_nodes(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "a.txt").write_text("alpha beta gofer workflow")
    (docs / "b.txt").write_text("zebra banana")
    index = tmp_path / "index.json"
    wf = _make_workflow()
    wf.add_operation(GraphNode(
        node_id="index",
        operation=LocalVectorizeOperation(
            type=OperationType.LOCAL_VECTORIZE,
            source_path=docs,
            index_path=index,
            glob="*.txt",
        ),
    ))
    wf.add_operation(GraphNode(
        node_id="search",
        operation=LocalSearchOperation(
            type=OperationType.LOCAL_SEARCH,
            index_path=index,
            query="gofer workflow",
            top_k=1,
        ),
    ))
    wf.then("index", "search")

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert result.success
    assert "a.txt" in result.node_outputs["search"].output


async def test_failure_route_runs_after_retries_are_exhausted(tmp_path: Path) -> None:
    wf = _make_workflow()
    wf.add_operation(GraphNode(
        node_id="fail",
        operation=BashCommandOperation(type=OperationType.BASH_COMMAND, command="false"),
        retry_count=2,
        retry_delay_seconds=0,
    ))
    wf.add_operation(_bash_node("recover", "echo recovered after retries"))
    wf.then(
        "fail",
        "recover",
        EdgeConfig(
            from_node="fail",
            to_node="recover",
            condition=EdgeConditionType.ON_FAILURE,
        ),
    )

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert not result.success
    assert result.node_outputs["recover"].success
    assert "recovered after retries" in result.node_outputs["recover"].output
    assert result.log_path is not None
    text = result.log_path.read_text()
    assert "fail - attempt 1 started" in text
    assert "fail - attempt 2 started" in text
    assert "fail - attempt 3 started" in text
    assert text.index("fail - attempt 3 finished") < text.index("recover - attempt 1 started")


async def test_self_loop_repeats_until_output_no_longer_matches(tmp_path: Path) -> None:
    counter = tmp_path / "counter"
    command = (
        f"n=$(cat {counter} 2>/dev/null || echo 0); "
        "n=$((n + 1)); "
        f"echo $n > {counter}; "
        'if [ "$n" -lt 3 ]; then echo retry; else echo done; fi'
    )

    wf = _make_workflow("recursive")
    wf.add_operation(_bash_node("improve", command))
    wf.then(
        "improve",
        "improve",
        EdgeConfig(
            from_node="improve",
            to_node="improve",
            condition=EdgeConditionType.OUTPUT_MATCHES,
            output_pattern="retry",
        ),
    )

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert result.success
    assert result.node_outputs["improve"].output.strip() == "done"
    assert len(result.node_runs["improve"]) == 3
    assert result.log_path is not None
    text = result.log_path.read_text()
    assert "improve - run 2 attempt 1 started" in text
    assert "improve - run 3 attempt 1 finished success=True" in text


async def test_recursive_workflow_stops_at_max_total_node_runs(tmp_path: Path) -> None:
    wf = _make_workflow("runaway")
    wf.add_operation(_bash_node("loop", "echo again"))
    wf.then("loop", "loop")

    result = await WorkflowExecutor(
        wf,
        {},
        log_base_dir=tmp_path / "logs",
        max_total_node_runs=3,
    ).run()

    assert not result.success
    assert result.log_path is not None
    assert "maximum node run limit exceeded" in result.log_path.read_text()


async def test_dry_run_does_not_execute(tmp_path: Path) -> None:
    wf = _make_workflow()
    wf.add_operation(_bash_node("dangerous", "rm -rf /"))
    executor = WorkflowExecutor(wf, {}, dry_run=True, log_base_dir=tmp_path / "logs")
    result = await executor.run()
    assert result.success


async def test_agent_node_uses_subscription(tmp_path: Path) -> None:
    prompt = tmp_path / "p.md"
    prompt.write_text("Do something.")
    sub = FakeSubscription(output="agent output")

    wf = _make_workflow()
    wf.register_agent(AgentConfig(
        agent_id="bot",
        subscription="claude_code",
        working_dir=tmp_path,
        prompt_path=prompt,
    ))
    wf.add_operation(GraphNode(
        node_id="agent-step",
        operation=AgentOperation(
            type=OperationType.AGENT,
            agent_id="bot",
            prompt_path=prompt,
            working_dir=tmp_path,
        ),
    ))
    executor = WorkflowExecutor(wf, {"claude_code": sub}, log_base_dir=tmp_path / "logs")
    result = await executor.run()
    assert result.success
    assert "agent output" in result.node_outputs["agent-step"].output
    assert len(sub.calls) == 1


async def test_agent_input_mapping_can_read_trigger_event_path(tmp_path: Path) -> None:
    prompt = tmp_path / "p.md"
    prompt.write_text("Summarize {{file_path}}.")
    sub = FakeSubscription(output="done")

    wf = _make_workflow()
    wf.register_agent(AgentConfig(
        agent_id="bot",
        subscription="claude_code",
        working_dir=tmp_path,
        prompt_path=prompt,
    ))
    wf.add_operation(GraphNode(
        node_id="agent-step",
        operation=AgentOperation(
            type=OperationType.AGENT,
            agent_id="bot",
            prompt_path=prompt,
            working_dir=tmp_path,
            input_mapping={"file_path": "trigger.events.0.path"},
        ),
    ))
    result = await WorkflowExecutor(
        wf,
        {"claude_code": sub},
        log_base_dir=tmp_path / "logs",
    ).with_trigger_context({
        "type": "file_watch",
        "events": [{"path": str(tmp_path / "input.txt"), "kind": "created"}],
    }).run()

    assert result.success
    assert str(tmp_path / "input.txt") in str(sub.calls[0]["prompt"])


async def test_agent_trigger_events_fan_source_runs_once_per_event(tmp_path: Path) -> None:
    prompt = tmp_path / "p.md"
    prompt.write_text("Summarize {{path}}.")
    sub = FakeSubscription(output="done")

    wf = _make_workflow()
    wf.register_agent(AgentConfig(
        agent_id="bot",
        subscription="claude_code",
        working_dir=tmp_path,
        prompt_path=prompt,
    ))
    wf.add_operation(GraphNode(
        node_id="agent-step",
        operation=AgentOperation(
            type=OperationType.AGENT,
            agent_id="bot",
            prompt_path=prompt,
            working_dir=tmp_path,
            fan_source=TriggerEventsFanSource(type="trigger_events"),
        ),
    ))
    result = await WorkflowExecutor(
        wf,
        {"claude_code": sub},
        log_base_dir=tmp_path / "logs",
    ).with_trigger_context({
        "type": "file_watch",
        "events": [
            {"path": str(tmp_path / "a.txt"), "kind": "created"},
            {"path": str(tmp_path / "b.txt"), "kind": "created"},
        ],
    }).run()

    assert result.success
    assert len(sub.calls) == 2
    prompts = [str(call["prompt"]) for call in sub.calls]
    assert str(tmp_path / "a.txt") in prompts[0]
    assert str(tmp_path / "b.txt") in prompts[1]


async def test_workflow_run_writes_success_log(tmp_path: Path) -> None:
    wf = _make_workflow("logged")
    wf.add_operation(_bash_node("echo", "echo hello"))

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert result.log_path is not None
    assert result.log_path.parent == tmp_path / "logs" / "logged"
    assert result.log_path.exists()
    lines = result.log_path.read_text().splitlines()
    assert lines[0].endswith(" - logged started successfully")
    assert "echo - stdout:" in result.log_path.read_text()
    assert "hello" in result.log_path.read_text()
    assert lines[-1].endswith(" - INFO - logged completed successfully")


async def test_workflow_run_writes_failure_log(tmp_path: Path) -> None:
    wf = _make_workflow("broken")
    wf.add_operation(_bash_node("fail", "echo bad >&2; exit 3"))

    result = await WorkflowExecutor(wf, {}, log_base_dir=tmp_path / "logs").run()

    assert result.log_path is not None
    text = result.log_path.read_text()
    lines = text.splitlines()
    assert not result.success
    assert lines[0].endswith(" - broken started successfully")
    assert "fail - stderr:" in text
    assert "bad" in text
    assert "broken failed due to node fail failed" in lines[-1]
