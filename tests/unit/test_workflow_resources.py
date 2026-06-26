from __future__ import annotations

from pathlib import Path

import pytest

from gofer.core.graph import GraphNode
from gofer.core.operations import (
    DirectoryFanSource,
    LocalVectorizeOperation,
    LoopOperation,
    OperationType,
)
from gofer.core.resources import ResourceLimits
from gofer.core.workflow import AgenticWorkflow, WatchConfig, WorkflowConfig


def test_validate_surfaces_resource_risk_warnings(tmp_path: Path) -> None:
    docs = tmp_path / "docs"
    docs.mkdir()
    for index in range(3):
        (docs / f"{index}.txt").write_text("x")
    workflow = AgenticWorkflow(
        WorkflowConfig(
            id="resource-warnings",
            name="Resource Warnings",
            watch=WatchConfig(path=docs, max_concurrency=8),
            resource_limits=ResourceLimits(max_fanout_items=2, max_files_scanned=2),
        )
    )
    workflow.add_operation(GraphNode(
        node_id="fanout",
        operation=LoopOperation(
            type=OperationType.LOOP,
            source=DirectoryFanSource(
                type="directory",
                path=docs,
                glob="*.txt",
                include_content=True,
            ),
        ),
    ))
    workflow.add_operation(GraphNode(
        node_id="index",
        operation=LocalVectorizeOperation(
            type=OperationType.LOCAL_VECTORIZE,
            source_path=docs,
            index_path=tmp_path / "index.json",
            glob="*.txt",
        ),
    ))

    with pytest.warns(UserWarning) as warnings:
        workflow.validate()

    messages = "\n".join(str(warning.message) for warning in warnings)
    assert "directory fan-out includes file content" in messages
    assert "may exceed max_fanout_items=2" in messages
    assert "local_vectorize scans local files" in messages
    assert "may exceed max_files_scanned=2" in messages
    assert "oldest queued event batches are dropped on overflow" in messages
    assert "will be capped by global max_watcher_concurrency=2" in messages
