from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from gofer.cli.main import app
from gofer.core.workflow import AgenticWorkflow
from gofer.ui.chat import workflow_chat_prompt_path
from gofer.utils.run_state import workflow_stop_path

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


def test_workflow_add_file_and_folder_nodes(tmp_path: Path) -> None:
    result = runner.invoke(
        app, ["workflow", "create", "--name", "Path Flow", "--output", str(tmp_path)]
    )
    assert result.exit_code == 0, result.output

    commands = [
        [
            "workflow", "add-node", "path-flow",
            "--id", "source-file",
            "--type", "file",
            "--path", "data/input.txt",
            "--data-dir", str(tmp_path),
        ],
        [
            "workflow", "add-node", "path-flow",
            "--id", "source-folder",
            "--type", "folder",
            "--path", "data",
            "--data-dir", str(tmp_path),
        ],
    ]

    for command in commands:
        result = runner.invoke(app, command)
        assert result.exit_code == 0, result.output

    wf = AgenticWorkflow.from_file(tmp_path / "path-flow.toml")
    assert wf.graph._nodes["source-file"].operation.type == "file"
    assert wf.graph._nodes["source-folder"].operation.type == "folder"


def test_workflow_add_node_allows_failure(tmp_path: Path) -> None:
    result = runner.invoke(
        app, ["workflow", "create", "--name", "Allowed Failure", "--output", str(tmp_path)]
    )
    assert result.exit_code == 0, result.output

    result = runner.invoke(
        app,
        [
            "workflow", "add-node", "allowed-failure",
            "--id", "may-fail",
            "--type", "bash_command",
            "--command", "exit 1",
            "--allow-failure",
            "--data-dir", str(tmp_path),
        ],
    )
    assert result.exit_code == 0, result.output

    wf = AgenticWorkflow.from_file(tmp_path / "allowed-failure.toml")
    assert wf.graph._nodes["may-fail"].allow_failure is True


def test_workflow_add_agent_node_supports_memory_option(tmp_path: Path) -> None:
    result = runner.invoke(
        app, ["workflow", "create", "--name", "Memory Flow", "--output", str(tmp_path)]
    )
    assert result.exit_code == 0, result.output

    result = runner.invoke(
        app,
        [
            "workflow", "add-agent", "memory-flow",
            "--id", "agent-1",
            "--subscription", "codex",
            "--working-dir", ".",
            "--prompt-path", "prompts/agent-1.md",
            "--data-dir", str(tmp_path),
        ],
    )
    assert result.exit_code == 0, result.output

    result = runner.invoke(
        app,
        [
            "workflow", "add-node", "memory-flow",
            "--id", "remember",
            "--type", "agent",
            "--agent-id", "agent-1",
            "--prompt-path", "prompts/agent-1.md",
            "--working-dir", ".",
            "--memory", "all",
            "--data-dir", str(tmp_path),
        ],
    )
    assert result.exit_code == 0, result.output

    wf = AgenticWorkflow.from_file(tmp_path / "memory-flow.toml")
    assert wf.graph._nodes["remember"].operation.memory == "all"


def test_workflow_rename_and_duplicate_commands(tmp_path: Path) -> None:
    result = runner.invoke(
        app, ["workflow", "create", "--name", "Original", "--output", str(tmp_path)]
    )
    assert result.exit_code == 0, result.output

    result = runner.invoke(
        app,
        [
            "workflow", "rename", "original",
            "--name", "Renamed",
            "--data-dir", str(tmp_path),
        ],
    )
    assert result.exit_code == 0, result.output
    assert (tmp_path / "original.toml").exists()
    wf = AgenticWorkflow.from_file(tmp_path / "original.toml")
    assert wf.config.id == "original"
    assert wf.config.name == "Renamed"

    result = runner.invoke(
        app,
        [
            "workflow", "duplicate", "original",
            "--data-dir", str(tmp_path),
        ],
    )
    assert result.exit_code == 0, result.output
    assert (tmp_path / "renamed-2.toml").exists()


def test_workflow_set_info_configures_run_continuously(tmp_path: Path) -> None:
    result = runner.invoke(
        app, ["workflow", "create", "--name", "Continuous", "--output", str(tmp_path)]
    )
    assert result.exit_code == 0, result.output

    result = runner.invoke(
        app,
        [
            "workflow", "set-info", "continuous",
            "--run-continuously",
            "--data-dir", str(tmp_path),
        ],
    )
    assert result.exit_code == 0, result.output
    wf = AgenticWorkflow.from_file(tmp_path / "continuous.toml")
    assert wf.config.run_continuously is True

    result = runner.invoke(
        app,
        [
            "workflow", "set-info", "continuous",
            "--no-run-continuously",
            "--data-dir", str(tmp_path),
        ],
    )
    assert result.exit_code == 0, result.output
    wf = AgenticWorkflow.from_file(tmp_path / "continuous.toml")
    assert wf.config.run_continuously is False


def test_workflow_run_rejects_active_continuous_workflow(tmp_path: Path) -> None:
    toml = tmp_path / "continuous.toml"
    toml.write_text(
        _SIMPLE_TOML.replace('id = "simple"', 'id = "continuous"').replace(
            'name = "Simple"',
            'name = "Continuous"\nrun_continuously = true',
        ),
        encoding="utf-8",
    )
    log_dir = tmp_path / "logs" / "continuous"
    log_dir.mkdir(parents=True)
    (log_dir / "2026-06-18T10-00-00-0400.log").write_text(
        "2026-06-18T10:00:00-04:00 - continuous started successfully\n",
        encoding="utf-8",
    )

    result = runner.invoke(
        app, ["workflow", "run", "continuous", "--data-dir", str(tmp_path)]
    )

    assert result.exit_code == 1
    assert "already has an" in result.output
    assert "active run" in result.output


def test_workflow_run_dry_run(tmp_path: Path) -> None:
    f = tmp_path / "wf.toml"
    f.write_text(_SIMPLE_TOML)
    result = runner.invoke(
        app, ["workflow", "run", str(f), "--dry-run", "--data-dir", str(tmp_path)]
    )
    assert result.exit_code == 0


def test_workflow_import_command(tmp_path: Path) -> None:
    source = tmp_path / "source.toml"
    source.write_text(
        """
[workflow]
id = "import-me"
name = "Import Me"

[[nodes]]
id = "hello"
type = "bash_command"
command = "echo hello"
""".strip()
    )
    data_dir = tmp_path / "data"

    result = runner.invoke(
        app, ["workflow", "import", str(source), "--data-dir", str(data_dir)]
    )

    assert result.exit_code == 0, result.output
    assert (data_dir / "import-me.toml").exists()


def test_workflow_rm_cleans_state(tmp_path: Path) -> None:
    result = runner.invoke(
        app, ["workflow", "create", "--name", "Clean Me", "--output", str(tmp_path)]
    )
    assert result.exit_code == 0, result.output
    log_dir = tmp_path / "logs" / "clean-me"
    log_dir.mkdir(parents=True)
    (log_dir / "2026-06-13T10-00-00-0400.log").write_text("old run\n")
    memory_dir = tmp_path / "agent-memory" / "clean-me"
    memory_dir.mkdir(parents=True)
    (memory_dir / "agent-step.json").write_text("[]\n")
    chat_path = workflow_chat_prompt_path(tmp_path, "clean-me")
    chat_path.parent.mkdir(parents=True)
    chat_path.write_text("old chat\n")
    stop_path = workflow_stop_path("clean-me", tmp_path)
    stop_path.parent.mkdir(parents=True)
    stop_path.write_text("stop\n")

    result = runner.invoke(
        app, ["workflow", "rm", "clean-me", "--yes", "--data-dir", str(tmp_path)]
    )

    assert result.exit_code == 0, result.output
    assert not (tmp_path / "clean-me.toml").exists()
    assert not log_dir.exists()
    assert not memory_dir.exists()
    assert not chat_path.exists()
    assert not stop_path.exists()


def test_workflow_logs_commands(tmp_path: Path) -> None:
    toml = tmp_path / "history.toml"
    toml.write_text(_SIMPLE_TOML.replace('id = "simple"', 'id = "history"'))
    log_dir = tmp_path / "logs" / "history"
    log_dir.mkdir(parents=True)
    log = log_dir / "2026-06-13T10-00-00-0400.log"
    log.write_text(
        "2026-06-13T10:00:00-04:00 - history started successfully\n"
        "hello from log\n"
        "2026-06-13T10:00:01-04:00 - INFO - history completed successfully\n"
    )

    list_result = runner.invoke(
        app, ["workflow", "logs", "list", "history", "--data-dir", str(tmp_path)]
    )
    latest_result = runner.invoke(
        app, ["workflow", "logs", "latest", "history", "--data-dir", str(tmp_path)]
    )
    show_result = runner.invoke(
        app,
        ["workflow", "logs", "show", "history", log.name, "--data-dir", str(tmp_path)],
    )

    assert list_result.exit_code == 0, list_result.output
    assert log.name in list_result.output
    assert latest_result.exit_code == 0, latest_result.output
    assert "hello from log" in latest_result.output
    assert show_result.exit_code == 0, show_result.output
    assert "history completed successfully" in show_result.output


def test_workflow_stop_command_writes_stop_marker(tmp_path: Path) -> None:
    toml = tmp_path / "stop-me.toml"
    toml.write_text(_SIMPLE_TOML.replace('id = "simple"', 'id = "stop-me"'))

    result = runner.invoke(
        app, ["workflow", "stop", "stop-me", "--data-dir", str(tmp_path)]
    )

    assert result.exit_code == 0, result.output
    assert workflow_stop_path("stop-me", tmp_path).exists()


def test_schedule_add_and_list(tmp_path: Path) -> None:
    db = tmp_path / "sched.db"
    toml = tmp_path / "wf.toml"
    toml.write_text(_SIMPLE_TOML + '\n[workflow.schedule]\ncron_expression = "0 9 * * *"\n')
    result = runner.invoke(app, ["schedule", "add", str(toml), "--db", str(db)])
    assert result.exit_code == 0
    result2 = runner.invoke(app, ["schedule", "list", "--db", str(db)])
    assert "simple" in result2.output


def test_watch_list_shows_watched_workflows(tmp_path: Path) -> None:
    toml = tmp_path / "watched.toml"
    toml.write_text(
        _SIMPLE_TOML
        + '\n[workflow.watch]\npath = "inputs"\nglob = "*.txt"\nrecursive = true\n'
    )

    result = runner.invoke(app, ["watch", "list", "--data-dir", str(tmp_path)])

    assert result.exit_code == 0
    assert "simple" in result.output
    assert "*.txt" in result.output


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


def test_plural_commands_are_invalid() -> None:
    for command in ("workflows", "agents", "prompts"):
        result = runner.invoke(app, [command])
        assert result.exit_code != 0
        assert "No such command" in result.output


def test_prompt_command_is_invalid() -> None:
    result = runner.invoke(app, ["prompt"])
    assert result.exit_code != 0
    assert "No such command" in result.output


def test_workflow_mutation_commands_configure_agent_fanout(tmp_path: Path) -> None:
    result = runner.invoke(
        app, ["workflow", "create", "--name", "Watch Summaries", "--output", str(tmp_path)]
    )
    assert result.exit_code == 0, result.output

    prompt = tmp_path / "prompts" / "summarizer.md"
    prompt.parent.mkdir()
    prompt.write_text("Summarize {{path}}")

    commands = [
        [
            "workflow", "set-watch", "watch-summaries",
            "--path", str(tmp_path / "incoming"),
            "--glob", "*.md",
            "--mode", "fanout",
            "--data-dir", str(tmp_path),
        ],
        [
            "workflow", "add-agent", "watch-summaries",
            "--id", "summarizer",
            "--subscription", "codex",
            "--working-dir", str(tmp_path),
            "--prompt-path", str(prompt),
            "--data-dir", str(tmp_path),
        ],
        [
            "workflow", "add-node", "watch-summaries",
            "--id", "summarize-added-files",
            "--type", "agent",
            "--agent-id", "summarizer",
            "--prompt-path", str(prompt),
            "--working-dir", str(tmp_path),
            "--fan-source", "trigger-events",
            "--fan-include-content",
            "--fan-max-concurrency", "3",
            "--data-dir", str(tmp_path),
        ],
    ]

    for command in commands:
        result = runner.invoke(app, command)
        assert result.exit_code == 0, result.output

    wf = AgenticWorkflow.from_file(tmp_path / "watch-summaries.toml")
    assert wf.config.watch is not None
    assert wf.config.watch.mode == "fanout"
    assert wf.config.watch.glob == "*.md"
    assert "summarizer" in wf.agents
    node = wf.graph._nodes["summarize-added-files"]
    assert node.operation.type == "agent"
    assert node.operation.fan_source is not None
    assert node.operation.fan_source.type == "trigger_events"
    assert node.operation.fan_source.include_content is True
    assert node.operation.fan_source.max_concurrency == 3


def test_workflow_recipe_watch_folder_summarize(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        [
            "workflow", "recipe", "watch-folder-summarize",
            "--name", "Summarize New Files",
            "--watch-path", str(tmp_path / "incoming"),
            "--glob", "*.txt",
            "--provider", "codex",
            "--working-dir", str(tmp_path),
            "--max-concurrency", "2",
            "--data-dir", str(tmp_path),
        ],
    )

    assert result.exit_code == 0, result.output
    workflow_path = tmp_path / "summarize-new-files.toml"
    prompt_path = tmp_path / "prompts" / "summarize-new-files-summarizer.md"
    assert workflow_path.exists()
    assert prompt_path.exists()

    wf = AgenticWorkflow.from_file(workflow_path)
    assert wf.config.watch is not None
    assert wf.config.watch.path == tmp_path / "incoming"
    assert wf.config.watch.glob == "*.txt"
    assert wf.config.watch.mode == "fanout"
    assert wf.agents["summarizer"].subscription == "codex"
    node = wf.graph._nodes["summarize-added-files"]
    assert node.operation.type == "agent"
    assert node.operation.fan_source is not None
    assert node.operation.fan_source.type == "trigger_events"
    assert node.operation.fan_source.include_content is True
    assert node.operation.fan_source.max_concurrency == 2
