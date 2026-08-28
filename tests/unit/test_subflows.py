from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from gofer.core.bundles import (
    export_workflow_bundle,
    import_workflow_bundle,
    preview_workflow_bundle,
)
from gofer.core.executor import WorkflowExecutor
from gofer.core.planner import build_execution_plan
from gofer.core.revisions import summarize_workflow_diff
from gofer.core.validation import validate_workflow_file
from gofer.core.workflow import AgenticWorkflow
from gofer.ui import api as ui_api


def _write(path: Path, text: str) -> Path:
    path.write_text(text.strip() + "\n", encoding="utf-8")
    return path


def test_subflow_component_parses_and_validates_requirements(tmp_path: Path) -> None:
    component_path = _write(
        tmp_path / "review-component.toml",
        """
        [workflow]
        id = "review-component"
        name = "Review Component"

        [component]
        id = "review-component"
        description = "Review a change"
        version = "1.0.0"
        secret_requirements = ["SLACK_TOKEN"]

        [component.inputs.diff]
        type = "string"
        required = true

        [component.outputs.summary]
        type = "string"
        source = "done.output"

        [[component.filesystem_access]]
        path = "repo"
        read = true
        write = false

        [[component.provider_requirements]]
        agentId = "reviewer"
        subscription = "codex"

        [[nodes]]
        id = "done"
        type = "pass"
        message = "ok"
        """,
    )
    parent_path = _write(
        tmp_path / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-review"
        type = "subflow"
        component_id = "review-component"
        version = "1.0.0"
        parameter_bindings = { diff = "{{trigger.diff}}" }
        output_contract = { summary = "string" }
        secret_requirements = ["EXTRA_TOKEN"]
        """,
    )

    component = AgenticWorkflow.from_file(component_path)
    assert component.component is not None
    assert component.component.id == "review-component"

    report = validate_workflow_file(parent_path, data_dir=tmp_path)
    assert report.ok
    requirements = [
        item for item in report.diagnostics if item.code == "workflow.subflow_requirements"
    ]
    assert requirements
    assert requirements[0].detail is not None
    assert requirements[0].detail["secretRequirements"] == ["EXTRA_TOKEN", "SLACK_TOKEN"]


@pytest.mark.anyio
async def test_subflow_type_only_output_contract_must_be_producible(
    tmp_path: Path,
) -> None:
    _write(
        tmp_path / "component.toml",
        """
        [workflow]
        id = "component"
        name = "Component"

        [component]
        id = "component"
        version = "1.0.0"

        [component.outputs.summary]
        type = "string"

        [[nodes]]
        id = "done"
        type = "pass"
        message = "component complete"
        """,
    )
    parent_path = _write(
        tmp_path / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-component"
        type = "subflow"
        component_id = "component"
        output_contract = { summary = "string" }
        """,
    )

    report = validate_workflow_file(parent_path, data_dir=tmp_path)
    assert any(
        item.code == "workflow.subflow_output_missing" and "summary" in item.message
        for item in report.diagnostics
    )

    result = await WorkflowExecutor(
        AgenticWorkflow.from_file(parent_path),
        {},
        log_base_dir=tmp_path / "logs",
        workflow_path=parent_path,
        data_dir=tmp_path,
    ).run()

    assert not result.success
    assert (
        result.node_outputs["call-component"].output
        == "Subflow did not produce required output(s): summary"
    )


def test_subflow_validation_catches_missing_inputs_outputs_versions_and_cycles(
    tmp_path: Path,
) -> None:
    _write(
        tmp_path / "component-a.toml",
        """
        [workflow]
        id = "component-a"
        name = "A"

        [component]
        id = "component-a"
        version = "1.0.0"

        [component.inputs.required_value]
        type = "string"
        required = true

        [component.outputs.real_output]
        type = "string"

        [[nodes]]
        id = "cycle"
        type = "subflow"
        component_id = "parent"
        """,
    )
    parent_path = _write(
        tmp_path / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [component]
        id = "parent"
        version = "1.0.0"

        [[nodes]]
        id = "call-a"
        type = "subflow"
        component_id = "component-a"
        version = "2.0.0"
        output_contract = { missing = "string" }
        """,
    )

    report = validate_workflow_file(parent_path, data_dir=tmp_path)
    codes = {item.code for item in report.diagnostics}
    assert "workflow.subflow_input_missing" in codes
    assert "workflow.subflow_output_missing" in codes
    assert "workflow.subflow_version_incompatible" in codes
    assert "workflow.subflow_cycle" in codes


def test_subflow_validation_catches_nested_contract_errors(tmp_path: Path) -> None:
    _write(
        tmp_path / "component-b.toml",
        """
        [workflow]
        id = "component-b"
        name = "B"

        [component]
        id = "component-b"
        version = "1.0.0"

        [component.inputs.required_value]
        type = "string"
        required = true

        [component.outputs.real_output]
        type = "string"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )
    _write(
        tmp_path / "component-a.toml",
        """
        [workflow]
        id = "component-a"
        name = "A"

        [component]
        id = "component-a"
        version = "1.0.0"

        [[nodes]]
        id = "call-b"
        type = "subflow"
        component_id = "component-b"
        version = "2.0.0"
        output_contract = { missing = "string" }
        """,
    )
    parent_path = _write(
        tmp_path / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-a"
        type = "subflow"
        component_id = "component-a"
        version = "1.0.0"
        """,
    )

    report = validate_workflow_file(parent_path, data_dir=tmp_path)
    diagnostics = {
        (item.code, item.target_id)
        for item in report.diagnostics
        if item.target_id == "call-a/call-b"
    }
    assert ("workflow.subflow_input_missing", "call-a/call-b") in diagnostics
    assert ("workflow.subflow_output_missing", "call-a/call-b") in diagnostics
    assert ("workflow.subflow_version_incompatible", "call-a/call-b") in diagnostics


@pytest.mark.anyio
async def test_subflow_execution_records_nested_boundaries(tmp_path: Path) -> None:
    _write(
        tmp_path / "component.toml",
        """
        [workflow]
        id = "component"
        name = "Component"

        [component]
        id = "component"
        version = "1.0.0"

        [[nodes]]
        id = "done"
        type = "pass"
        message = "component complete"
        """,
    )
    parent_path = _write(
        tmp_path / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-component"
        type = "subflow"
        component_id = "component"
        version = "1.0.0"
        """,
    )

    workflow = AgenticWorkflow.from_file(parent_path)
    result = await WorkflowExecutor(
        workflow,
        {},
        log_base_dir=tmp_path / "logs",
        workflow_path=parent_path,
        data_dir=tmp_path,
    ).run()

    assert result.success
    events = json.loads(result.log_path.with_suffix(".events.json").read_text(encoding="utf-8"))
    statuses = [
        event["status"] for event in events["events"] if event["nodeId"] == "call-component"
    ]
    assert "subflow_started" in statuses
    assert "subflow_completed" in statuses
    node_data = events["nodes"]["call-component"]["data"]
    assert node_data["component_id"] == "component"
    assert node_data["log_path"]
    assert node_data["message"] == "subflow Component succeeded"


@pytest.mark.anyio
async def test_subflow_source_path_resolves_relative_to_workflow_file(tmp_path: Path) -> None:
    workflows_dir = tmp_path / "workflows"
    components_dir = workflows_dir / "components"
    components_dir.mkdir(parents=True)
    _write(
        components_dir / "review.toml",
        """
        [workflow]
        id = "review-workflow"
        name = "Review"

        [component]
        id = "review"
        version = "1.0.0"

        [[nodes]]
        id = "done"
        type = "pass"
        message = "review complete"
        """,
    )
    parent_path = _write(
        workflows_dir / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-review"
        type = "subflow"
        component_id = "review"
        source_path = "components/review.toml"
        """,
    )

    result = await WorkflowExecutor(
        AgenticWorkflow.from_file(parent_path),
        {},
        log_base_dir=tmp_path / "logs",
        workflow_path=parent_path,
        data_dir=tmp_path,
    ).run()

    assert result.success
    assert result.node_outputs["call-review"].data["component_id"] == "review"


@pytest.mark.anyio
async def test_subflow_component_id_resolves_from_nested_component_directory(
    tmp_path: Path,
) -> None:
    components_dir = tmp_path / "components"
    components_dir.mkdir()
    _write(
        components_dir / "review.toml",
        """
        [workflow]
        id = "review-workflow"
        name = "Review"

        [component]
        id = "review"
        version = "1.0.0"

        [[nodes]]
        id = "done"
        type = "pass"
        message = "review complete"
        """,
    )
    parent_path = _write(
        tmp_path / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-review"
        type = "subflow"
        component_id = "review"
        version = "1.0.0"
        """,
    )

    assert validate_workflow_file(parent_path, data_dir=tmp_path).ok

    result = await WorkflowExecutor(
        AgenticWorkflow.from_file(parent_path),
        {},
        log_base_dir=tmp_path / "logs",
        workflow_path=parent_path,
        data_dir=tmp_path,
    ).run()
    assert result.success
    assert result.node_outputs["call-review"].data["workflow_id"] == "review-workflow"

    bundle_path = tmp_path / "parent.gof.zip"
    manifest = export_workflow_bundle(parent_path, bundle_path)
    assert {
        "path": "components/review.toml",
        "archivePath": "assets/components/review.toml",
        "kind": "subflow",
    } in manifest.included_paths


@pytest.mark.anyio
async def test_subflow_execution_rejects_source_path_component_id_mismatch(
    tmp_path: Path,
) -> None:
    _write(
        tmp_path / "deploy.toml",
        """
        [workflow]
        id = "deploy-workflow"
        name = "Deploy"

        [component]
        id = "deploy"
        version = "1.0.0"

        [[nodes]]
        id = "done"
        type = "pass"
        message = "deploy complete"
        """,
    )
    parent_path = _write(
        tmp_path / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-review"
        type = "subflow"
        component_id = "review"
        source_path = "deploy.toml"
        """,
    )

    result = await WorkflowExecutor(
        AgenticWorkflow.from_file(parent_path),
        {},
        log_base_dir=tmp_path / "logs",
        workflow_path=parent_path,
        data_dir=tmp_path,
    ).run()

    assert not result.success
    assert result.node_outputs["call-review"].output == (
        "Subflow component 'review' does not match source component 'deploy'"
    )


def test_bundle_includes_subflow_and_reports_version_conflict(tmp_path: Path) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    _write(
        source / "component.toml",
        """
        [workflow]
        id = "component"
        name = "Component"

        [component]
        id = "component"
        version = "2.0.0"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )
    parent = _write(
        source / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-component"
        type = "subflow"
        component_id = "component"
        version = "2.0.0"
        """,
    )
    _write(
        target / "component.toml",
        """
        [workflow]
        id = "component"
        name = "Old Component"

        [component]
        id = "component"
        version = "1.0.0"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )

    bundle_path = tmp_path / "parent.gof.zip"
    manifest = export_workflow_bundle(parent, bundle_path)
    assert any(item["kind"] == "subflow" for item in manifest.included_paths)
    with zipfile.ZipFile(bundle_path) as archive:
        assert "assets/component.toml" in archive.namelist()

    plan = preview_workflow_bundle(bundle_path, data_dir=target)
    assert any("component version conflict" in conflict.action for conflict in plan.conflicts)


def test_bundle_skips_same_name_subflow_file_with_mismatched_component_id(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    (source / "components").mkdir(parents=True)
    _write(
        source / "review.toml",
        """
        [workflow]
        id = "deploy"
        name = "Deploy"

        [component]
        id = "deploy"
        version = "1.0.0"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )
    _write(
        source / "components" / "review.toml",
        """
        [workflow]
        id = "review"
        name = "Review"

        [component]
        id = "review"
        version = "1.0.0"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )
    parent = _write(
        source / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-review"
        type = "subflow"
        component_id = "review"
        version = "1.0.0"
        """,
    )

    bundle_path = tmp_path / "parent.gof.zip"
    manifest = export_workflow_bundle(parent, bundle_path)

    included_subflows = {
        item["path"] for item in manifest.included_paths if item["kind"] == "subflow"
    }
    assert included_subflows == {"components/review.toml"}
    with zipfile.ZipFile(bundle_path) as archive:
        assert "assets/components/review.toml" in archive.namelist()
        assert "assets/review.toml" not in archive.namelist()


def test_bundle_includes_nested_subflow_references(tmp_path: Path) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    _write(
        source / "component-b.toml",
        """
        [workflow]
        id = "component-b"
        name = "Component B"

        [component]
        id = "component-b"
        version = "1.0.0"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )
    _write(
        source / "component-a.toml",
        """
        [workflow]
        id = "component-a"
        name = "Component A"

        [component]
        id = "component-a"
        version = "1.0.0"

        [[nodes]]
        id = "call-b"
        type = "subflow"
        component_id = "component-b"
        version = "1.0.0"
        """,
    )
    parent = _write(
        source / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-a"
        type = "subflow"
        component_id = "component-a"
        version = "1.0.0"
        """,
    )

    bundle_path = tmp_path / "parent.gof.zip"
    manifest = export_workflow_bundle(parent, bundle_path)

    included_paths = {item["path"] for item in manifest.included_paths}
    assert {"component-a.toml", "component-b.toml"}.issubset(included_paths)
    with zipfile.ZipFile(bundle_path) as archive:
        assert "assets/component-a.toml" in archive.namelist()
        assert "assets/component-b.toml" in archive.namelist()

    _write(
        target / "component-b.toml",
        """
        [workflow]
        id = "component-b"
        name = "Old Component B"

        [component]
        id = "component-b"
        version = "0.9.0"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )
    plan = preview_workflow_bundle(bundle_path, data_dir=target)
    assert any(
        conflict.path == "component-b.toml" and "component version conflict" in conflict.action
        for conflict in plan.conflicts
    )


def test_bundle_import_rewrites_nested_subflow_component_references(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    (source / "components").mkdir(parents=True)
    target.mkdir()
    _write(
        source / "components" / "component-b.toml",
        """
        [workflow]
        id = "component-b"
        name = "Component B"

        [component]
        id = "component-b"
        version = "1.0.0"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )
    _write(
        source / "component-a.toml",
        """
        [workflow]
        id = "component-a"
        name = "Component A"

        [component]
        id = "component-a"
        version = "1.0.0"

        [[nodes]]
        id = "call-b"
        type = "subflow"
        component_id = "component-b"
        version = "1.0.0"
        """,
    )
    parent = _write(
        source / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-a"
        type = "subflow"
        component_id = "component-a"
        version = "1.0.0"
        """,
    )
    _write(
        target / "component-b.toml",
        """
        [workflow]
        id = "old-component-b"
        name = "Old Component B"

        [component]
        id = "component-b"
        version = "0.9.0"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )

    bundle_path = tmp_path / "parent.gof.zip"
    export_workflow_bundle(parent, bundle_path)
    preview = preview_workflow_bundle(bundle_path, data_dir=target)
    assert preview.path_rewrites == {
        "components/component-b.toml": "bundle-assets/parent/components/component-b.toml"
    }

    plan = import_workflow_bundle(bundle_path, data_dir=target)
    imported_component = AgenticWorkflow.from_file(target / "component-a.toml")
    op = next(
        node.operation
        for node in imported_component.graph.nodes_in_order()
        if node.node_id == "call-b"
    )
    assert op.source_path == Path("bundle-assets/parent/components/component-b.toml")
    assert validate_workflow_file(plan.workflow_path, data_dir=target).ok


def test_bundle_preserves_source_path_subflow_kind_for_conflicts_and_rewrites(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    (source / "components").mkdir(parents=True)
    (target / "components").mkdir(parents=True)
    _write(
        source / "components" / "review.toml",
        """
        [workflow]
        id = "review"
        name = "Review"

        [component]
        id = "review"
        version = "2.0.0"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )
    parent = _write(
        source / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-review"
        type = "subflow"
        component_id = "review"
        version = "2.0.0"
        source_path = "components/review.toml"
        """,
    )
    _write(
        target / "components" / "review.toml",
        """
        [workflow]
        id = "review"
        name = "Old Review"

        [component]
        id = "review"
        version = "1.0.0"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )

    bundle_path = tmp_path / "parent.gof.zip"
    manifest = export_workflow_bundle(parent, bundle_path)

    component_items = [
        item for item in manifest.included_paths if item["path"] == "components/review.toml"
    ]
    assert component_items == [
        {
            "path": "components/review.toml",
            "archivePath": "assets/components/review.toml",
            "kind": "subflow",
        }
    ]
    with zipfile.ZipFile(bundle_path) as archive:
        assert "assets/components/review.toml" in archive.namelist()

    preview = preview_workflow_bundle(bundle_path, data_dir=target)
    assert any(
        conflict.path == "components/review.toml"
        and "component version conflict" in conflict.action
        for conflict in preview.conflicts
    )

    plan = import_workflow_bundle(bundle_path, data_dir=target)
    imported = AgenticWorkflow.from_file(plan.workflow_path)
    op = next(
        node.operation for node in imported.graph.nodes_in_order() if node.node_id == "call-review"
    )
    assert op.source_path == Path("bundle-assets/parent/components/review.toml")
    assert validate_workflow_file(plan.workflow_path, data_dir=target).ok


def test_bundle_import_rewrites_subflow_when_same_component_exists_at_different_path(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    (source / "components").mkdir(parents=True)
    target.mkdir()
    _write(
        source / "components" / "review.toml",
        """
        [workflow]
        id = "review-workflow"
        name = "Review"

        [component]
        id = "review"
        version = "2.0.0"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )
    parent = _write(
        source / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-review"
        type = "subflow"
        component_id = "review"
        version = "2.0.0"
        """,
    )
    _write(
        target / "review.toml",
        """
        [workflow]
        id = "old-review"
        name = "Old Review"

        [component]
        id = "review"
        version = "1.0.0"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )

    bundle_path = tmp_path / "parent.gof.zip"
    export_workflow_bundle(parent, bundle_path)

    preview = preview_workflow_bundle(bundle_path, data_dir=target)
    assert preview.path_rewrites["components/review.toml"] == (
        "bundle-assets/parent/components/review.toml"
    )
    assert any(
        conflict.path == "review.toml" and "component version conflict" in conflict.action
        for conflict in preview.conflicts
    )

    plan = import_workflow_bundle(bundle_path, data_dir=target)
    imported = AgenticWorkflow.from_file(plan.workflow_path)
    op = next(
        node.operation for node in imported.graph.nodes_in_order() if node.node_id == "call-review"
    )
    assert op.source_path == Path("bundle-assets/parent/components/review.toml")
    assert validate_workflow_file(plan.workflow_path, data_dir=target).ok


def test_bundle_import_rewrites_conflicting_subflow_component_reference(tmp_path: Path) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    _write(
        source / "component.toml",
        """
        [workflow]
        id = "component"
        name = "Component"

        [component]
        id = "component"
        version = "2.0.0"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )
    parent = _write(
        source / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-component"
        type = "subflow"
        component_id = "component"
        version = "2.0.0"
        """,
    )
    _write(
        target / "component.toml",
        """
        [workflow]
        id = "component"
        name = "Old Component"

        [component]
        id = "component"
        version = "1.0.0"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )

    bundle_path = tmp_path / "parent.gof.zip"
    export_workflow_bundle(parent, bundle_path)
    plan = import_workflow_bundle(bundle_path, data_dir=target)

    imported = AgenticWorkflow.from_file(plan.workflow_path)
    op = next(
        node.operation
        for node in imported.graph.nodes_in_order()
        if node.node_id == "call-component"
    )
    assert op.source_path == Path("bundle-assets/parent/component.toml")
    assert validate_workflow_file(plan.workflow_path, data_dir=target).ok


def test_subflow_plan_surfaces_component_requirements(tmp_path: Path) -> None:
    _write(
        tmp_path / "component.toml",
        """
        [workflow]
        id = "component"
        name = "Component"

        [component]
        id = "component"
        version = "1.0.0"
        secret_requirements = ["COMPONENT_TOKEN"]

        [[component.filesystem_access]]
        path = "../shared"
        read = true
        write = false

        [[component.provider_requirements]]
        agentId = "reviewer"
        subscription = "codex"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )
    parent = _write(
        tmp_path / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-component"
        type = "subflow"
        component_id = "component"
        version = "1.0.0"
        """,
    )

    workflow = AgenticWorkflow.from_file(parent)
    plan = build_execution_plan(workflow, workflow_path=parent, data_dir=tmp_path)

    assert "COMPONENT_TOKEN" in plan["requiredSecrets"]
    assert plan["providerRequirements"]
    assert plan["providerRequirements"][0]["agentId"] == "reviewer"
    assert plan["filesystemRequirements"]
    assert plan["filesystemRequirements"][0]["path"] == "../shared"
    node_plan = plan["generations"][0]["nodes"][0]
    assert node_plan["providerRequirements"][0]["componentId"] == "component"
    assert node_plan["filesystemRequirements"][0]["componentId"] == "component"


def test_subflow_plan_and_validation_surface_internal_filesystem_requirements(
    tmp_path: Path,
) -> None:
    _write(
        tmp_path / "component.toml",
        """
        [workflow]
        id = "component"
        name = "Component"

        [component]
        id = "component"
        version = "1.0.0"

        [[nodes]]
        id = "read-secret"
        type = "read_file"
        path = "../secret.txt"
        """,
    )
    parent = _write(
        tmp_path / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-component"
        type = "subflow"
        component_id = "component"
        version = "1.0.0"
        """,
    )

    report = validate_workflow_file(parent, data_dir=tmp_path)
    diagnostic = next(
        item for item in report.diagnostics if item.code == "workflow.subflow_requirements"
    )
    assert diagnostic.detail is not None
    filesystem_access = diagnostic.detail["filesystemAccess"]
    assert any(
        item["path"] == "../secret.txt"
        and item["source"] == "internal_node"
        and item["nodeId"] == "read-secret"
        and item["read"] is True
        for item in filesystem_access
    )

    plan = build_execution_plan(
        AgenticWorkflow.from_file(parent),
        workflow_path=parent,
        data_dir=tmp_path,
    )
    assert any(
        requirement["componentId"] == "component"
        and requirement["path"] == "../secret.txt"
        and requirement["source"] == "internal_node"
        and requirement["nodeId"] == "read-secret"
        for requirement in plan["filesystemRequirements"]
    )
    node_plan = plan["generations"][0]["nodes"][0]
    assert any(
        requirement["path"] == "../secret.txt" and requirement["source"] == "internal_node"
        for requirement in node_plan["filesystemRequirements"]
    )


def test_subflow_plan_surfaces_nested_component_requirements(tmp_path: Path) -> None:
    _write(
        tmp_path / "component-b.toml",
        """
        [workflow]
        id = "component-b"
        name = "Component B"

        [component]
        id = "component-b"
        version = "1.0.0"
        secret_requirements = ["B_TOKEN"]

        [[component.filesystem_access]]
        path = "../component-b-data"
        read = true
        write = false

        [[component.provider_requirements]]
        agentId = "component-b-agent"
        subscription = "codex"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )
    _write(
        tmp_path / "component-a.toml",
        """
        [workflow]
        id = "component-a"
        name = "Component A"

        [component]
        id = "component-a"
        version = "1.0.0"

        [[nodes]]
        id = "call-b"
        type = "subflow"
        component_id = "component-b"
        version = "1.0.0"
        """,
    )
    parent = _write(
        tmp_path / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-a"
        type = "subflow"
        component_id = "component-a"
        version = "1.0.0"
        """,
    )

    plan = build_execution_plan(
        AgenticWorkflow.from_file(parent),
        workflow_path=parent,
        data_dir=tmp_path,
    )

    assert "B_TOKEN" in plan["requiredSecrets"]
    assert any(
        requirement["agentId"] == "component-b-agent"
        for requirement in plan["providerRequirements"]
    )
    assert any(
        requirement["componentId"] == "component-b" and requirement["path"] == "../component-b-data"
        for requirement in plan["filesystemRequirements"]
    )
    node_plan = plan["generations"][0]["nodes"][0]
    assert "B_TOKEN" in node_plan["requiredSecrets"]
    assert any(
        requirement["componentId"] == "component-b"
        for requirement in node_plan["providerRequirements"]
    )


def test_ui_payloads_include_nested_subflow_source_files(tmp_path: Path) -> None:
    components_dir = tmp_path / "components"
    components_dir.mkdir()
    _write(
        components_dir / "review.toml",
        """
        [workflow]
        id = "review-workflow"
        name = "Review"

        [component]
        id = "review"
        version = "1.0.0"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )
    _write(
        tmp_path / "parent.toml",
        """
        [workflow]
        id = "parent"
        name = "Parent"

        [[nodes]]
        id = "call-review"
        type = "subflow"
        component_id = "review"
        source_path = "components/review.toml"
        """,
    )

    payload = ui_api.list_workflow_payloads(tmp_path)
    workflows_by_id = {workflow["id"]: workflow for workflow in payload["workflows"]}

    assert workflows_by_id["review-workflow"]["sourcePath"] == "components/review.toml"
    parent_operation = workflows_by_id["parent"]["nodes"][0]["operation"]
    assert parent_operation["component"]["workflowId"] == "review-workflow"
    assert parent_operation["component"]["sourcePath"] == "components/review.toml"


def test_revision_summaries_distinguish_subflow_reference_and_definition() -> None:
    before_parent = """
    [workflow]
    id = "parent"
    name = "Parent"

    [[nodes]]
    id = "call"
    type = "subflow"
    component_id = "review"
    version = "1.0.0"
    """
    after_parent = before_parent.replace('version = "1.0.0"', 'version = "1.1.0"')
    assert "subflow reference changed: call" in summarize_workflow_diff(before_parent, after_parent)

    after_parent_with_bindings = after_parent.replace(
        'version = "1.1.0"',
        'version = "1.1.0"\n    parameter_bindings = { diff = "{{trigger.diff}}" }',
    )
    mixed_changes = summarize_workflow_diff(before_parent, after_parent_with_bindings)
    assert "node changed: call" in mixed_changes
    assert "subflow reference changed: call" not in mixed_changes

    before_component = """
    [workflow]
    id = "review"
    name = "Review"

    [component]
    id = "review"
    version = "1.0.0"
    """
    after_component = before_component.replace('version = "1.0.0"', 'version = "1.1.0"')
    assert "subflow definition changed: review" in summarize_workflow_diff(
        before_component,
        after_component,
    )


def test_ui_payload_round_trips_component_metadata(tmp_path: Path) -> None:
    workflow_path = _write(
        tmp_path / "component.toml",
        """
        [workflow]
        id = "component"
        name = "Component"

        [component]
        id = "component"
        description = "Reusable component"
        version = "1.0.0"

        [component.inputs.value]
        type = "string"

        [component.outputs.result]
        type = "string"

        [[nodes]]
        id = "done"
        type = "pass"
        """,
    )

    payload = ui_api.workflow_to_payload(AgenticWorkflow.from_file(workflow_path), workflow_path)
    assert payload["component"]["id"] == "component"
    reloaded = ui_api.workflow_from_payload(payload)
    assert reloaded.component is not None
    assert reloaded.component.outputs["result"]["type"] == "string"


def test_ui_payload_round_trips_subflow_expanded_state() -> None:
    payload = {
        "id": "parent",
        "name": "Parent",
        "nodes": [
            {
                "id": "call",
                "type": "subflow",
                "operation": {
                    "type": "subflow",
                    "component_id": "component",
                    "expanded": True,
                },
            }
        ],
        "edges": [],
    }

    workflow = ui_api.workflow_from_payload(payload)
    reloaded = ui_api.workflow_to_payload(workflow)

    operation = reloaded["nodes"][0]["operation"]
    assert operation["expanded"] is True
