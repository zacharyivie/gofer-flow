from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from gofer.cli.main import app

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


def test_agent_create_with_inline_prompt(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        [
            "agent", "create",
            "--name", "Test Agent",
            "--subscription", "claude_code",
            "--working-dir", str(tmp_path),
            "--prompt", "You are a helpful assistant.",
            "--data-dir", str(tmp_path),
        ],
    )
    assert result.exit_code == 0, result.output
    toml_file = tmp_path / "test-agent.toml"
    assert toml_file.exists()
    prompt_file = tmp_path / "prompts" / "test-agent.md"
    assert prompt_file.exists()
    assert prompt_file.read_text() == "You are a helpful assistant."


def test_agent_create_with_prompt_file(tmp_path: Path) -> None:
    prompt_file = tmp_path / "my_prompt.md"
    prompt_file.write_text("# My Prompt\nDo things.")
    result = runner.invoke(
        app,
        [
            "agent", "create",
            "--name", "File Agent",
            "--subscription", "codex",
            "--working-dir", str(tmp_path),
            "--prompt", str(prompt_file),
            "--data-dir", str(tmp_path),
        ],
    )
    assert result.exit_code == 0, result.output
    toml_file = tmp_path / "file-agent.toml"
    assert toml_file.exists()
    # prompt_file should be referenced directly, not copied
    assert not (tmp_path / "prompts" / "file-agent.md").exists()


def test_agent_create_collision_gets_suffix(tmp_path: Path) -> None:
    base_args = [
        "agent", "create",
        "--name", "Dup Agent",
        "--subscription", "claude_code",
        "--working-dir", str(tmp_path),
        "--prompt", "hi",
        "--data-dir", str(tmp_path),
    ]
    runner.invoke(app, base_args)
    result = runner.invoke(app, base_args)
    assert result.exit_code == 0, result.output
    assert (tmp_path / "dup-agent.toml").exists()
    assert (tmp_path / "dup-agent-2.toml").exists()


def test_agent_create_invalid_subscription(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        [
            "agent", "create",
            "--name", "Bad Agent",
            "--subscription", "nonexistent",
            "--working-dir", str(tmp_path),
            "--prompt", "hi",
            "--data-dir", str(tmp_path),
        ],
    )
    assert result.exit_code != 0
    assert "Invalid subscription" in result.output


def test_agent_list_all(tmp_path: Path) -> None:
    runner.invoke(
        app,
        [
            "agent", "create",
            "--name", "List Agent",
            "--subscription", "claude_code",
            "--working-dir", str(tmp_path),
            "--prompt", "hi",
            "--data-dir", str(tmp_path),
        ],
    )
    result = runner.invoke(app, ["agent", "list", "--data-dir", str(tmp_path)])
    assert result.exit_code == 0
    assert "list-agent" in result.output


def test_prompt_list(tmp_path: Path) -> None:
    (tmp_path / "sample.md").write_text("# Sample")
    result = runner.invoke(app, ["prompt", "list", "--dir", str(tmp_path)])
    assert result.exit_code == 0
    assert "sample.md" in result.output


def test_prompt_new(tmp_path: Path) -> None:
    result = runner.invoke(app, ["prompt", "new", "--name", "myprompt", "--dir", str(tmp_path)])
    assert result.exit_code == 0
    assert (tmp_path / "myprompt.md").exists()


def test_plural_commands_are_invalid() -> None:
    for command in ("workflows", "agents", "prompts"):
        result = runner.invoke(app, [command])
        assert result.exit_code != 0
        assert "No such command" in result.output
