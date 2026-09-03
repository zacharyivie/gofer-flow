from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from gofer.radish.bundles import (
    BUNDLE_MANIFEST,
    RadishBundleError,
    export_radish_bundle,
    import_radish_bundle,
    preview_radish_bundle,
)
from gofer.radish.workspaces import create_registered_workflow


def test_radish_bundle_exports_non_ignored_workspace_files(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    registry = tmp_path / "registry"
    workflow = create_registered_workflow(project, "Review", registry_dir=registry)
    (workflow.workflow_root / "scripts").mkdir()
    (workflow.workflow_root / "scripts" / "run.py").write_text("print('ok')\n")
    (workflow.workflow_root / "notes.txt").write_text("include me\n")
    (workflow.workflow_root / "keep.env").write_text("safe fixture\n")
    (workflow.workflow_root / "secret.env").write_text("TOKEN=secret\n")
    (workflow.workflow_root / "cache").mkdir()
    (workflow.workflow_root / "cache" / "result.json").write_text("{}\n")
    (workflow.workflow_root / ".taskurottaignore").write_text(
        "*.env\n!keep.env\ncache/\ncompiled/\n",
        encoding="utf-8",
    )

    bundle = tmp_path / "review.taskurotta"
    preview = export_radish_bundle("review", bundle, registry_dir=registry)

    assert preview.files == (
        ".taskurottaignore",
        "keep.env",
        "notes.txt",
        "scripts/run.py",
        "workflow.metadata.json",
        "workflow.rad",
    )
    with zipfile.ZipFile(bundle) as archive:
        assert sorted(archive.namelist()) == sorted([BUNDLE_MANIFEST, *preview.files])
        manifest = json.loads(archive.read(BUNDLE_MANIFEST))
        assert manifest["workflowId"] == "review"
        assert manifest["files"] == list(preview.files)
        assert "secret.env" not in archive.namelist()
        assert "cache/result.json" not in archive.namelist()


def test_radish_bundle_imports_into_project_and_allocates_conflicting_id(tmp_path: Path) -> None:
    source_project = tmp_path / "source"
    target_project = tmp_path / "target"
    source_project.mkdir()
    target_project.mkdir()
    source_registry = tmp_path / "source-registry"
    target_registry = tmp_path / "target-registry"
    workflow = create_registered_workflow(source_project, "Review", registry_dir=source_registry)
    (workflow.workflow_root / "prompt.md").write_text("Review this.\n", encoding="utf-8")
    bundle = tmp_path / "review.taskurotta"
    export_radish_bundle("review", bundle, registry_dir=source_registry)
    create_registered_workflow(target_project, "Review", registry_dir=target_registry)

    imported = import_radish_bundle(
        bundle,
        target_project,
        registry_dir=target_registry,
    )

    assert imported.workflow_id == "review-2"
    assert imported.name == "Review"
    assert imported.entrypoint.is_file()
    assert (imported.workflow_root / "prompt.md").read_text(encoding="utf-8") == "Review this.\n"
    assert preview_radish_bundle(bundle).workflow_name == "Review"


def test_radish_bundle_rejects_archive_traversal(tmp_path: Path) -> None:
    bundle = tmp_path / "unsafe.taskurotta"
    manifest = {
        "format": "taskurotta-workflow",
        "version": 1,
        "workflowId": "unsafe",
        "workflowName": "Unsafe",
        "files": ["workflow.rad", "../outside.txt"],
    }
    with zipfile.ZipFile(bundle, "w") as archive:
        archive.writestr(BUNDLE_MANIFEST, json.dumps(manifest))
        archive.writestr("workflow.rad", "Radish: 1\n\nWorkflow:\n  name: Unsafe\n")
        archive.writestr("../outside.txt", "nope")

    with pytest.raises(RadishBundleError, match="Unsafe workflow bundle path"):
        preview_radish_bundle(bundle)


def test_radish_bundle_requires_entrypoint_to_survive_ignore_rules(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    registry = tmp_path / "registry"
    workflow = create_registered_workflow(project, "Review", registry_dir=registry)
    (workflow.workflow_root / ".taskurottaignore").write_text("workflow.rad\n")

    with pytest.raises(RadishBundleError, match="excludes required workflow.rad"):
        export_radish_bundle("review", tmp_path / "review.taskurotta", registry_dir=registry)
