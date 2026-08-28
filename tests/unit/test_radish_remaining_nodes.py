from __future__ import annotations

from pathlib import Path
from typing import Any

import anyio
import pytest

from gofer.core.approvals import ApprovalStore
from gofer.radish.compiler import CompileContext, RadishCompiler
from gofer.radish.diagnostics import RadishCompileError
from gofer.radish.preflight import run_preflight
from gofer.radish.provider_contracts import load_provider_contracts
from gofer.radish.runtime import execute_node
from gofer.radish.workflow_runtime import execute_workflow

PROJECT_ROOT = Path(__file__).parents[2]
RADISH_ROOT = PROJECT_ROOT / "radish"


def compile_source(source: str, project_root: Path) -> dict[str, Any]:
    compiler = RadishCompiler.from_paths(
        schema_root=RADISH_ROOT / "schemas",
        contract_paths=sorted((RADISH_ROOT / "contracts").glob("*.json")),
    )
    providers = load_provider_contracts(
        RADISH_ROOT / "schemas" / "provider-contract.schema.json",
        sorted((RADISH_ROOT / "providers").glob("*.json")),
    )
    return compiler.compile(
        source,
        CompileContext("remaining-nodes", project_root, provider_contracts=providers),
    ).ir


@pytest.mark.anyio
async def test_common_llm_task_uses_provider_and_structured_output(
    tmp_path: Path, fake_subscription: Any
) -> None:
    source = (
        """Radish: 1
Workflow:
  name: Common task
Node summarize:
  type: common-llm-task
  provider: codex
  task: summarize
  target: release notes
  output-schema: """
        '{"type":"object","properties":{"summary":{"type":"string"}},'
        '"required":["summary"],"additionalProperties":false}\n'
    )
    fake_subscription._output = '{"summary":"ready"}'

    result = await execute_node(
        compile_source(source, tmp_path),
        "summarize",
        subscriptions={"codex": fake_subscription},
        data_dir=tmp_path / "data",
    )

    assert result.outcome == "success"
    assert result.output == {"summary": "ready"}
    assert "Summarize" in str(fake_subscription.calls[0]["prompt"])


@pytest.mark.anyio
async def test_local_vectorize_and_search_round_trip(tmp_path: Path) -> None:
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "guide.txt").write_text(
        "Radish workflows compile to JSON IR.", encoding="utf-8"
    )
    source = """Radish: 1
Workflow:
  name: Retrieval
Node index:
  type: local-vectorize
  source-path: docs
  index-path: cache/index.json
  to: search
Node search:
  type: local-search
  index-path: cache/index.json
  query: Radish workflow
  needs:
    - index
"""

    result = await execute_workflow(compile_source(source, tmp_path))

    assert result.outcome == "pass", result
    assert result.latest_node_outputs["index"]["chunk_count"] == 1
    assert result.latest_node_outputs["search"]["count"] == 1
    assert result.latest_node_outputs["search"]["results"][0]["path"].endswith("guide.txt")


@pytest.mark.anyio
async def test_approval_gate_waits_for_external_decision(tmp_path: Path) -> None:
    source = """Radish: 1
Workflow:
  name: Approval
Node approve:
  type: approval-gate
  message: Ship it?
"""
    ir = compile_source(source, tmp_path)
    store = ApprovalStore(tmp_path / "data")
    result_holder: dict[str, Any] = {}

    async def run_gate() -> None:
        result_holder["result"] = await execute_node(
            ir,
            "approve",
            data_dir=tmp_path / "data",
            approval_store=store,
            run_id="test-run",
        )

    async with anyio.create_task_group() as task_group:
        task_group.start_soon(run_gate)
        while not store.list_pending():
            await anyio.sleep(0.01)
        store.decide("remaining-nodes", "test-run", "approve", "approved", decided_by="owner")

    result = result_holder["result"]
    assert result.outcome == "success"
    assert result.output["decision"] == "approved"


@pytest.mark.anyio
async def test_approval_gate_renders_with_local_from_agent_string_output(tmp_path: Path) -> None:
    source = """Radish: 1
Workflow:
  name: Approval with local
Node writer:
  type: agent
  provider: codex
  prompt: Say cat
  to: approve
Node approve:
  type: approval-gate
  with:
    cat: node.writer.output
  message: What should I do? {{cat}}
  needs: writer
"""
    ir = compile_source(source, tmp_path)
    store = ApprovalStore(tmp_path / "data")
    result_holder: dict[str, Any] = {}

    async def run_gate() -> None:
        result_holder["result"] = await execute_node(
            ir,
            "approve",
            node_outputs={"writer": "cat"},
            data_dir=tmp_path / "data",
            approval_store=store,
            run_id="local-run",
        )

    async with anyio.create_task_group() as task_group:
        task_group.start_soon(run_gate)
        while not store.list_pending():
            await anyio.sleep(0.01)
        pending = store.list_pending()[0]
        assert pending.message == "What should I do? cat"
        store.decide(
            "remaining-nodes",
            "local-run",
            "approve",
            "approved",
            decided_by="owner",
        )

    result = result_holder["result"]
    assert result.outcome == "success"
    assert result.output["message"] == "What should I do? cat"


@pytest.mark.anyio
async def test_count_loop_routes_one_activation_per_item(tmp_path: Path) -> None:
    source = """Radish: 1
Workflow:
  name: Count loop
Node repeat:
  type: loop
  source: {"type": "count", "count": 3, "max-concurrency": 2}
  to: capture
Node capture:
  type: bash-command
  command: printf '%s' "$ITEM"
  needs:
    - repeat
  with:
    item: node.repeat.output.index
"""

    result = await execute_workflow(compile_source(source, tmp_path))

    assert result.outcome == "pass", result
    assert [run.node_id for run in result.runs].count("capture") == 3


@pytest.mark.anyio
async def test_break_closes_infinite_loop_lineage(tmp_path: Path) -> None:
    source = """Radish: 1
Workflow:
  name: Break loop
  max-runs: 10
Node repeat:
  type: loop
  source: {"type": "infinite"}
  to: stop
Node stop:
  type: break
  loop: repeat
  needs:
    - repeat
"""

    result = await execute_workflow(compile_source(source, tmp_path))

    assert result.outcome == "pass"
    assert [run.node_id for run in result.runs] == ["repeat", "stop"]
    assert result.runs[-1].result.output["loop"] == "repeat"


def test_loop_defaults_are_frozen_in_ir(tmp_path: Path) -> None:
    source = """Radish: 1
Workflow:
  name: Loop defaults
Node repeat:
  type: loop
  source: {"type": "count"}
"""

    ir = compile_source(source, tmp_path)

    assert ir["nodes"][0]["configuration"]["source"] == {
        "type": "count",
        "count": 1,
        "max_concurrency": 1,
        "fail_fast": False,
    }


def test_loop_directory_source_requires_project_relative_path(tmp_path: Path) -> None:
    missing = """Radish: 1
Workflow:
  name: Missing loop path
Node repeat:
  type: loop
  source: {"type": "directory"}
"""
    escaping = missing.replace(
        '{"type": "directory"}', '{"type": "directory", "path": "../outside"}'
    )

    with pytest.raises(RadishCompileError) as missing_error:
        compile_source(missing, tmp_path)
    with pytest.raises(RadishCompileError) as escaping_error:
        compile_source(escaping, tmp_path)

    assert "RADISH_MISSING_FIELD" in {item.code for item in missing_error.value.diagnostics}
    assert "RADISH_PATH_OUTSIDE_PROJECT" in {item.code for item in escaping_error.value.diagnostics}


@pytest.mark.anyio
async def test_loop_non_fail_fast_finishes_items_then_fails_workflow(tmp_path: Path) -> None:
    source = """Radish: 1
Workflow:
  name: Settled loop failure
Node repeat:
  type: loop
  source: {"type": "count", "count": 3, "max-concurrency": 1}
  to: check
Node check:
  type: bash-command
  command: test "$ITEM" != "1"
  needs:
    - repeat
  with:
    item: node.repeat.output.index
"""

    result = await execute_workflow(compile_source(source, tmp_path))

    assert result.outcome == "failure"
    assert [run.node_id for run in result.runs].count("check") == 3


def test_remaining_node_preflight_checks_resources(tmp_path: Path) -> None:
    source = """Radish: 1
Workflow:
  name: Missing retrieval resources
Node index:
  type: local-vectorize
  source-path: missing-docs
  index-path: cache/index.json
Node search:
  type: local-search
  index-path: missing-index.json
  query: radish
"""

    result = run_preflight(compile_source(source, tmp_path), data_dir=tmp_path / "data")

    assert not result.ready
    assert {item.code for item in result.diagnostics} == {"RADISH_PREFLIGHT_RESOURCE_MISSING"}


@pytest.mark.anyio
async def test_trigger_event_loop_uses_runtime_trigger_channel(tmp_path: Path) -> None:
    source = """Radish: 1
Workflow:
  name: Trigger events
Node repeat:
  type: loop
  source: {"type": "trigger-events"}
  to: capture
Node capture:
  type: bash-command
  command: printf '%s' "$EVENT"
  needs:
    - repeat
  with:
    event: node.repeat.output.kind
"""

    result = await execute_workflow(
        compile_source(source, tmp_path),
        trigger_events=[{"kind": "created"}, {"kind": "modified"}],
    )

    captures = [run for run in result.runs if run.node_id == "capture"]
    assert result.outcome == "pass"
    assert [run.result.output["stdout"] for run in captures] == ["created", "modified"]


@pytest.mark.anyio
async def test_loop_join_state_is_isolated_per_iteration(tmp_path: Path) -> None:
    source = """Radish: 1
Workflow:
  name: Isolated loop joins
Node repeat:
  type: loop
  source: {"type": "count", "count": 2, "max-concurrency": 2}
  to:
    - left
    - right
Node left:
  type: bash-command
  command: if [ "$ITEM" = 0 ]; then sleep 0.1; fi; printf 'L%s' "$ITEM"
  needs:
    - repeat
  with:
    item: node.repeat.output.index
  to: joined
Node right:
  type: bash-command
  command: if [ "$ITEM" = 1 ]; then sleep 0.1; fi; printf 'R%s' "$ITEM"
  needs:
    - repeat
  with:
    item: node.repeat.output.index
  to: joined
Node joined:
  type: bash-command
  command: printf '%s-%s' "$LEFT" "$RIGHT"
  needs:
    - left
    - right
  with:
    left: node.left.output.stdout
    right: node.right.output.stdout
"""

    result = await execute_workflow(compile_source(source, tmp_path))

    joined = [run.result.output["stdout"] for run in result.runs if run.node_id == "joined"]
    assert result.outcome == "pass"
    assert set(joined) == {"L0-R0", "L1-R1"}
