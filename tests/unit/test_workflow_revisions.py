from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from gofer.cli.main import app
from gofer.core.revisions import (
    RevisionRetention,
    capture_workflow_revision,
    diff_workflow_revision,
    list_workflow_revisions,
    restore_workflow_revision,
)

runner = CliRunner()


def _write_workflow(path: Path, *, name: str = "History", extra_node: bool = False) -> None:
    extra = ""
    if extra_node:
        extra = """
[[nodes]]
id = "bye"
type = "bash_command"
command = "echo bye"
"""
    path.write_text(
        f"""
[workflow]
id = "history"
name = "{name}"

[[nodes]]
id = "hello"
type = "bash_command"
command = "echo hello"
{extra}
""",
        encoding="utf-8",
    )


def test_revision_creation_coalesces_autosaves_and_summarizes_diff(tmp_path: Path) -> None:
    path = tmp_path / "history.toml"
    _write_workflow(path)

    created = capture_workflow_revision(path, tmp_path, source="create")
    assert created is not None
    assert created.summary == ["workflow created"]

    _write_workflow(path, name="History Edited")
    first_autosave = capture_workflow_revision(path, tmp_path, source="autosave")
    assert first_autosave is not None

    _write_workflow(path, name="History Edited", extra_node=True)
    second_autosave = capture_workflow_revision(path, tmp_path, source="autosave")
    assert second_autosave is not None
    assert second_autosave.revision_id == first_autosave.revision_id

    revisions = list_workflow_revisions("history", tmp_path)
    assert len(revisions) == 2
    assert "node added: bye" in revisions[0].summary


def test_revision_diff_restore_and_restore_as_copy(tmp_path: Path) -> None:
    path = tmp_path / "history.toml"
    _write_workflow(path)
    original = capture_workflow_revision(path, tmp_path, source="create")
    assert original is not None

    _write_workflow(path, name="Changed", extra_node=True)
    changed = capture_workflow_revision(path, tmp_path, source="manual")
    assert changed is not None

    diff = diff_workflow_revision("history", original.revision_id, tmp_path)
    assert "node added: bye" in diff["summary"]
    assert "-name = \"History\"" in diff["tomlDiff"]
    assert "+name = \"Changed\"" in diff["tomlDiff"]

    restored = restore_workflow_revision("history", original.revision_id, tmp_path)
    assert restored["workflowId"] == "history"
    assert "Changed" not in path.read_text(encoding="utf-8")

    copied = restore_workflow_revision(
        "history",
        original.revision_id,
        tmp_path,
        as_copy=True,
    )
    assert copied["workflowId"] == "history-restored"
    assert (tmp_path / "history-restored.toml").exists()


def test_revision_retention_and_secret_masking(tmp_path: Path) -> None:
    path = tmp_path / "history.toml"
    path.write_text(
        """
[workflow]
id = "history"
name = "History"

[[nodes]]
id = "run"
type = "bash_command"
command = "echo hello"

[nodes.env]
PASSWORD = "cleartext-password"
PUBLIC = "visible"
""",
        encoding="utf-8",
    )

    capture_workflow_revision(
        path,
        tmp_path,
        source="create",
        retention=RevisionRetention(max_revisions=1),
    )
    path.write_text(path.read_text(encoding="utf-8").replace("echo hello", "echo bye"))
    capture_workflow_revision(
        path,
        tmp_path,
        source="manual",
        retention=RevisionRetention(max_revisions=1),
    )

    revisions = list_workflow_revisions("history", tmp_path)
    assert len(revisions) == 1
    stored = revisions[0].toml
    assert "cleartext-password" not in stored
    assert "PASSWORD = \"***\"" in stored
    assert "PUBLIC = \"visible\"" in stored


def test_cli_history_diff_and_restore(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        ["workflow", "create", "--name", "History", "--output", str(tmp_path)],
    )
    assert result.exit_code == 0

    path = tmp_path / "history.toml"
    original_name = "History"
    path.write_text(path.read_text(encoding="utf-8").replace(original_name, "Changed"))
    capture_workflow_revision(path, tmp_path, source="manual")

    history = runner.invoke(
        app,
        ["workflow", "history", "history", "--data-dir", str(tmp_path), "--json"],
    )
    assert history.exit_code == 0
    revisions = json.loads(history.output)
    original_revision = revisions[-1]["revisionId"]

    diff = runner.invoke(
        app,
        ["workflow", "diff", "history", original_revision, "--data-dir", str(tmp_path)],
    )
    assert diff.exit_code == 0
    assert "workflow name changed" in diff.output

    restore = runner.invoke(
        app,
        ["workflow", "restore", "history", original_revision, "--data-dir", str(tmp_path)],
    )
    assert restore.exit_code == 0
    assert "Restored" in restore.output
    assert "Changed" not in path.read_text(encoding="utf-8")
