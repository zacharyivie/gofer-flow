from __future__ import annotations

import json
from pathlib import Path

import pytest

from gofer.radish.workspaces import (
    DEFAULT_TASKUROTTAIGNORE,
    RadishWorkspaceError,
    create_registered_workflow,
    discover_registered_workflows,
    find_registered_workflow,
    list_registered_workflows,
)


def test_create_registered_workflow_uses_project_taskurotta_layout(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    registry = tmp_path / "app-data"

    workflow = create_registered_workflow(project, "Review PR", registry_dir=registry)

    expected_root = project / ".taskurotta" / "review-pr"
    assert workflow.workflow_id == "review-pr"
    assert workflow.project_root == project
    assert workflow.workflow_root == expected_root
    assert workflow.entrypoint == expected_root / "workflow.rad"
    assert workflow.entrypoint.read_text(encoding="utf-8") == (
        'Radish: 1\n\nWorkflow:\n  name: "Review PR"\n'
    )
    assert (expected_root / "workflow.metadata.json").read_text(encoding="utf-8").endswith("\n")
    assert (expected_root / ".taskurottaignore").read_text(
        encoding="utf-8"
    ) == DEFAULT_TASKUROTTAIGNORE
    artifacts = list((expected_root / "compiled").glob("*.json"))
    assert len(artifacts) == 1
    assert not (registry / "radish" / "artifacts").exists()
    artifact = json.loads(artifacts[0].read_text(encoding="utf-8"))
    assert artifact["ir"]["workflow"]["id"] == "review-pr"
    assert find_registered_workflow("REVIEW-PR", registry_dir=registry) == workflow


def test_workflow_ids_are_allocated_globally_and_projects_remain_groupable(tmp_path: Path) -> None:
    first_project = tmp_path / "first-project"
    second_project = tmp_path / "second-project"
    first_project.mkdir()
    second_project.mkdir()
    registry = tmp_path / "app-data"

    first = create_registered_workflow(first_project, "Build", registry_dir=registry)
    second = create_registered_workflow(second_project, "Build", registry_dir=registry)
    third = create_registered_workflow(first_project, "Build", registry_dir=registry)

    assert [first.workflow_id, second.workflow_id, third.workflow_id] == [
        "build",
        "build-2",
        "build-3",
    ]
    registered = list_registered_workflows(registry_dir=registry)
    assert {item.project_root for item in registered} == {first_project, second_project}
    registry_document = json.loads(
        (registry / "radish" / "workspace-registry.json").read_text(encoding="utf-8")
    )
    assert [item["id"] for item in registry_document["workflows"]] == [
        "build",
        "build-3",
        "build-2",
    ]


def test_create_registered_workflow_does_not_modify_an_existing_directory(
    tmp_path: Path,
) -> None:
    project = tmp_path / "project"
    existing = project / ".taskurotta" / "build"
    existing.mkdir(parents=True)
    marker = existing / "keep.txt"
    marker.write_text("keep", encoding="utf-8")

    workflow = create_registered_workflow(project, "Build", registry_dir=tmp_path / "app-data")

    assert workflow.workflow_id == "build-2"
    assert marker.read_text(encoding="utf-8") == "keep"


def test_create_registered_workflow_requires_an_existing_project_folder(tmp_path: Path) -> None:
    with pytest.raises(RadishWorkspaceError, match="does not exist"):
        create_registered_workflow(
            tmp_path / "missing",
            "Build",
            registry_dir=tmp_path / "app-data",
        )


def test_discover_registered_workflows_registers_existing_radish_directories(
    tmp_path: Path,
) -> None:
    project = tmp_path / "project"
    taskurotta_workflow = project / ".taskurotta" / "review"
    custom_workflow = project / "automations" / "daily"
    ignored_workflow = project / "node_modules" / "dependency"
    for directory in (taskurotta_workflow, custom_workflow, ignored_workflow):
        directory.mkdir(parents=True)
    source = 'Radish: 1\n\nWorkflow:\n  name: "Existing"\n'
    (taskurotta_workflow / "workflow.rad").write_text(source, encoding="utf-8")
    (taskurotta_workflow / "helper.rad").write_text(source, encoding="utf-8")
    (custom_workflow / "daily.rad").write_text(source, encoding="utf-8")
    (ignored_workflow / "ignored.rad").write_text(source, encoding="utf-8")
    registry = tmp_path / "app-data"

    first = discover_registered_workflows(project, registry_dir=registry)
    second = discover_registered_workflows(project, registry_dir=registry)

    assert [(workflow.workflow_id, workflow.entrypoint) for workflow in first] == [
        ("review", taskurotta_workflow / "workflow.rad"),
        ("daily", custom_workflow / "daily.rad"),
    ]
    assert second == first
    assert list_registered_workflows(registry_dir=registry) == tuple(
        sorted(first, key=lambda workflow: (str(workflow.project_root), workflow.workflow_id))
    )
    assert (taskurotta_workflow / "workflow.rad").read_text(encoding="utf-8") == source
