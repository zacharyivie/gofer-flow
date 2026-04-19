from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from agentic_task_manager.cli.main import app

runner = CliRunner()

_SIMPLE_TOML = """
[workflow]
id = "simple"
name = "Simple"

[[nodes]]
id = "hello"
type = "bash_command"
command = "echo hello"
"""


def test_workflow_validate_valid(tmp_path: Path) -> None:
    f = tmp_path / "wf.toml"
    f.write_text(_SIMPLE_TOML)
    result = runner.invoke(app, ["workflow", "validate", str(f)])
    assert result.exit_code == 0
    assert "valid" in result.output


def test_workflow_validate_missing_file(tmp_path: Path) -> None:
    result = runner.invoke(app, ["workflow", "validate", str(tmp_path / "missing.toml")])
    assert result.exit_code != 0


def test_workflow_create(tmp_path: Path) -> None:
    result = runner.invoke(
        app, ["workflow", "create", "--name", "My Flow", "--output", str(tmp_path)]
    )
    assert result.exit_code == 0
    created = list(tmp_path.glob("*.toml"))
    assert len(created) == 1


def test_workflow_run_dry_run(tmp_path: Path) -> None:
    f = tmp_path / "wf.toml"
    f.write_text(_SIMPLE_TOML)
    result = runner.invoke(app, ["workflow", "run", str(f), "--dry-run"])
    assert result.exit_code == 0


def test_schedule_add_and_list(tmp_path: Path) -> None:
    db = tmp_path / "sched.db"
    toml = tmp_path / "wf.toml"
    toml.write_text(_SIMPLE_TOML + '\n[workflow.schedule]\ncron_expression = "0 9 * * *"\n')
    result = runner.invoke(app, ["schedule", "add", str(toml), "--db", str(db)])
    assert result.exit_code == 0
    result2 = runner.invoke(app, ["schedule", "list", "--db", str(db)])
    assert "simple" in result2.output


def test_prompts_list(tmp_path: Path) -> None:
    (tmp_path / "sample.md").write_text("# Sample")
    result = runner.invoke(app, ["prompts", "list", "--dir", str(tmp_path)])
    assert result.exit_code == 0
    assert "sample.md" in result.output


def test_prompts_new(tmp_path: Path) -> None:
    result = runner.invoke(app, ["prompts", "new", "--name", "myprompt", "--dir", str(tmp_path)])
    assert result.exit_code == 0
    assert (tmp_path / "myprompt.md").exists()
