from __future__ import annotations

import json
from pathlib import Path

import anyio
import pytest

from gofer.core.agent import AgentConfig, AgentResult
from gofer.core.executor import WorkflowExecutor, _load_tabular, _resolve_fan_items
from gofer.core.graph import GraphNode
from gofer.core.operations import (
    AgentOperation,
    CountFanSource,
    DirectoryFanSource,
    OperationType,
    TabularFanSource,
)
from gofer.core.workflow import AgenticWorkflow, WorkflowConfig
from tests.conftest import FakeSubscription

# ── _load_tabular ─────────────────────────────────────────────────────────────


def test_load_tabular_jsonl(tmp_path: Path) -> None:
    f = tmp_path / "data.jsonl"
    f.write_text('{"name": "alice", "age": 30}\n{"name": "bob", "age": 25}\n')
    rows = _load_tabular(f)
    assert rows == [
        {"name": "alice", "age": 30, "_row": '{"name": "alice", "age": 30}'},
        {"name": "bob", "age": 25, "_row": '{"name": "bob", "age": 25}'},
    ]


def test_load_tabular_csv(tmp_path: Path) -> None:
    f = tmp_path / "data.csv"
    f.write_text("name,age\nalice,30\nbob,25\n")
    rows = _load_tabular(f)
    assert rows == [
        {"name": "alice", "age": "30", "_row": '{"name": "alice", "age": "30"}'},
        {"name": "bob", "age": "25", "_row": '{"name": "bob", "age": "25"}'},
    ]


def test_load_tabular_unsupported_format(tmp_path: Path) -> None:
    f = tmp_path / "data.tsv"
    f.write_text("name\talice\n")
    with pytest.raises(ValueError, match="Unsupported tabular format"):
        _load_tabular(f)


def test_load_tabular_jsonl_skips_blank_lines(tmp_path: Path) -> None:
    f = tmp_path / "data.jsonl"
    f.write_text('{"x": 1}\n\n{"x": 2}\n')
    rows = _load_tabular(f)
    assert len(rows) == 2


# ── _resolve_fan_items ────────────────────────────────────────────────────────


def test_resolve_fan_items_count() -> None:
    from gofer.core.executor import ExecutionContext
    ctx = ExecutionContext()
    items = _resolve_fan_items(CountFanSource(type="count", count=3), ctx)
    assert items == [{"index": "0"}, {"index": "1"}, {"index": "2"}]


def test_resolve_fan_items_directory(tmp_path: Path) -> None:
    from gofer.core.executor import ExecutionContext
    (tmp_path / "a.py").write_text("pass")
    (tmp_path / "b.py").write_text("pass")
    (tmp_path / "skip.txt").write_text("skip")
    ctx = ExecutionContext()
    source = DirectoryFanSource(type="directory", path=tmp_path, glob="*.py")
    items = _resolve_fan_items(source, ctx)
    assert len(items) == 2
    names = {i["file_name"] for i in items}
    assert names == {"a.py", "b.py"}
    assert "file_content" not in items[0]


def test_resolve_fan_items_directory_include_content(tmp_path: Path) -> None:
    from gofer.core.executor import ExecutionContext
    (tmp_path / "hello.txt").write_text("hello world")
    ctx = ExecutionContext()
    source = DirectoryFanSource(type="directory", path=tmp_path, include_content=True)
    items = _resolve_fan_items(source, ctx)
    assert items[0]["file_content"] == "hello world"


# ── Executor integration ──────────────────────────────────────────────────────


def _make_agent_workflow(tmp_path: Path, sub: FakeSubscription) -> tuple[AgenticWorkflow, str]:
    prompt = tmp_path / "prompt.md"
    prompt.write_text("Process: {{file_name}}")
    wf = AgenticWorkflow(WorkflowConfig(id="fw", name="Fan Test"))
    wf.register_agent(AgentConfig(
        agent_id="proc",
        subscription="claude_code",
        working_dir=tmp_path,
        prompt_path=prompt,
    ))
    return wf, "claude_code"


async def test_tabular_fan_out_spawns_one_agent_per_row(tmp_path: Path) -> None:
    sub = FakeSubscription(output="done")
    wf, sub_name = _make_agent_workflow(tmp_path, sub)

    data = tmp_path / "input.jsonl"
    data.write_text('{"file_name": "r1"}\n{"file_name": "r2"}\n{"file_name": "r3"}\n')

    prompt = tmp_path / "prompt.md"
    wf.add_operation(GraphNode(
        node_id="fan",
        operation=AgentOperation(
            type=OperationType.AGENT,
            agent_id="proc",
            prompt_path=prompt,
            working_dir=tmp_path,
            fan_source=TabularFanSource(type="tabular", path=data, max_concurrency=2),
        ),
    ))
    result = await WorkflowExecutor(wf, {sub_name: sub}).run()
    assert result.success
    assert len(sub.calls) == 3


async def test_directory_fan_out_spawns_one_agent_per_file(tmp_path: Path) -> None:
    sub = FakeSubscription(output="done")
    wf, sub_name = _make_agent_workflow(tmp_path, sub)

    files_dir = tmp_path / "files"
    files_dir.mkdir()
    for i in range(4):
        (files_dir / f"file{i}.txt").write_text(f"content {i}")

    prompt = tmp_path / "prompt.md"
    wf.add_operation(GraphNode(
        node_id="fan",
        operation=AgentOperation(
            type=OperationType.AGENT,
            agent_id="proc",
            prompt_path=prompt,
            working_dir=tmp_path,
            fan_source=DirectoryFanSource(type="directory", path=files_dir, max_concurrency=2),
        ),
    ))
    result = await WorkflowExecutor(wf, {sub_name: sub}).run()
    assert result.success
    assert len(sub.calls) == 4


async def test_fan_out_max_concurrency_respected(tmp_path: Path) -> None:
    concurrency_log: list[int] = []
    active: list[int] = [0]

    class TrackingSubscription(FakeSubscription):
        async def execute(
            self,
            prompt: str,
            working_dir: Path,
            tools: list[str],
            mcp_servers: list[str],
            env: dict[str, str],
            timeout: float | None = None,
        ) -> AgentResult:
            active[0] += 1
            concurrency_log.append(active[0])
            await anyio.sleep(0)
            active[0] -= 1
            return await super().execute(prompt, working_dir, tools, mcp_servers, env, timeout)

    sub = TrackingSubscription()
    wf, sub_name = _make_agent_workflow(tmp_path, sub)

    data = tmp_path / "input.jsonl"
    data.write_text("\n".join(json.dumps({"i": k}) for k in range(10)) + "\n")

    prompt = tmp_path / "prompt.md"
    wf.add_operation(GraphNode(
        node_id="fan",
        operation=AgentOperation(
            type=OperationType.AGENT,
            agent_id="proc",
            prompt_path=prompt,
            working_dir=tmp_path,
            fan_source=TabularFanSource(type="tabular", path=data, max_concurrency=3),
        ),
    ))
    await WorkflowExecutor(wf, {sub_name: sub}).run()
    assert max(concurrency_log) <= 3


async def test_fan_out_fail_fast(tmp_path: Path) -> None:
    class FailingSubscription(FakeSubscription):
        async def execute(
            self,
            prompt: str,
            working_dir: Path,
            tools: list[str],
            mcp_servers: list[str],
            env: dict[str, str],
            timeout: float | None = None,
        ) -> AgentResult:
            raise RuntimeError("boom")

    sub = FailingSubscription()
    wf, sub_name = _make_agent_workflow(tmp_path, sub)

    data = tmp_path / "input.jsonl"
    data.write_text('{"x": 1}\n{"x": 2}\n{"x": 3}\n')

    prompt = tmp_path / "prompt.md"
    wf.add_operation(GraphNode(
        node_id="fan",
        operation=AgentOperation(
            type=OperationType.AGENT,
            agent_id="proc",
            prompt_path=prompt,
            working_dir=tmp_path,
            fan_source=TabularFanSource(
                type="tabular", path=data, fail_fast=True, max_concurrency=1
            ),
        ),
    ))
    result = await WorkflowExecutor(wf, {sub_name: sub}).run()
    assert not result.success
