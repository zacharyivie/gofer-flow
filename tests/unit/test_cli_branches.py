from __future__ import annotations

import signal
import threading
from pathlib import Path
from typing import Any, cast

import pytest
from typer.testing import CliRunner

from gofer.cli.commands import schedule as schedule_cmd
from gofer.cli.commands import watch as watch_cmd
from gofer.cli.main import app
from gofer.core.agent import AgentResult
from gofer.core.workflow import AgenticWorkflow
from gofer.ui.chat import workflow_chat_prompt_path

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


def _create_workflow(data_dir: Path, workflow_id: str = "simple") -> Path:
    path = data_dir / f"{workflow_id}.toml"
    path.write_text(
        _SIMPLE_TOML.replace('id = "simple"', f'id = "{workflow_id}"'),
        encoding="utf-8",
    )
    return path


def _create_agent(data_dir: Path, name: str = "Branch Agent") -> str:
    result = runner.invoke(
        app,
        [
            "agent",
            "create",
            "--name",
            name,
            "--subscription",
            "codex",
            "--working-dir",
            str(data_dir),
            "--prompt",
            "hello",
            "--data-dir",
            str(data_dir),
        ],
    )
    assert result.exit_code == 0, result.output
    return name.lower().replace(" ", "-")


class _CliSubscription:
    def __init__(self, success: bool = True, output: str = "agent output") -> None:
        self.calls: list[dict[str, object]] = []
        self.success = success
        self.output = output

    async def execute(
        self,
        prompt: str,
        working_dir: Path,
        tools: list[str],
        mcp_servers: list[str],
        env: dict[str, str],
        timeout: float | None = None,
        cancel_event: threading.Event | None = None,
        extra_paths: list[Path] | None = None,
        max_output_bytes: int | None = None,
    ) -> AgentResult:
        self.calls.append(
            {
                "prompt": prompt,
                "working_dir": working_dir,
                "tools": tools,
                "mcp_servers": mcp_servers,
                "env": env,
                "timeout": timeout,
                "cancel_event": cancel_event,
                "extra_paths": extra_paths or [],
                "max_output_bytes": max_output_bytes,
            }
        )
        return AgentResult(
            agent_id="",
            success=self.success,
            output=self.output,
            exit_code=0 if self.success else 7,
            duration_seconds=0.0,
        )


def test_agent_list_filters_by_workflow_and_reports_missing(tmp_path: Path) -> None:
    agent_id = _create_agent(tmp_path)

    filtered = runner.invoke(
        app, ["agent", "list", "--workflow", agent_id, "--data-dir", str(tmp_path)]
    )
    missing = runner.invoke(
        app, ["agent", "list", "--workflow", "missing", "--data-dir", str(tmp_path)]
    )

    assert filtered.exit_code == 0, filtered.output
    assert agent_id in filtered.output
    assert missing.exit_code == 1
    assert "not found" in missing.output


def test_agent_edit_rejects_invalid_env_and_subscription(tmp_path: Path) -> None:
    agent_id = _create_agent(tmp_path)

    invalid_env = runner.invoke(
        app,
        [
            "agent",
            "edit",
            agent_id,
            "--env",
            "BROKEN",
            "--data-dir",
            str(tmp_path),
        ],
    )
    invalid_sub = runner.invoke(
        app,
        [
            "agent",
            "edit",
            agent_id,
            "--subscription",
            "bad",
            "--data-dir",
            str(tmp_path),
        ],
    )

    assert invalid_env.exit_code == 1
    assert "expected KEY=VALUE" in invalid_env.output
    assert invalid_sub.exit_code == 1
    assert "Invalid subscription" in invalid_sub.output


def test_agent_edit_updates_persisted_config(tmp_path: Path) -> None:
    agent_id = _create_agent(tmp_path)
    work_dir = tmp_path / "work"
    work_dir.mkdir()

    result = runner.invoke(
        app,
        [
            "agent",
            "edit",
            agent_id,
            "--subscription",
            "claude_code",
            "--working-dir",
            str(work_dir),
            "--prompt",
            "updated prompt",
            "--tools",
            "read,write",
            "--mcp-servers",
            "server-a,server-b",
            "--env",
            "A=1",
            "--env",
            "B=2",
            "--data-dir",
            str(tmp_path),
        ],
    )

    assert result.exit_code == 0, result.output
    wf = AgenticWorkflow.from_file(tmp_path / f"{agent_id}.toml")
    cfg = wf.agents[agent_id]
    assert cfg.subscription == "claude_code"
    assert cfg.working_dir == work_dir.resolve()
    prompt_path = cfg.prompt_path
    assert prompt_path is not None
    assert prompt_path.read_text(encoding="utf-8") == "updated prompt"
    assert cfg.tools == ["read", "write"]
    assert cfg.mcp_servers == ["server-a", "server-b"]
    assert cfg.env == {"A": "1", "B": "2"}


def test_agent_edit_interactive_cancel_and_save(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    agent_id = _create_agent(tmp_path)
    import gofer.cli.tui_editor as tui_editor

    class CancelEditor:
        def __init__(self, sections: list[tui_editor.Section], title: str) -> None:
            self.sections = sections

        def run(self) -> bool:
            self.sections[0].fields[1].value = "claude_code"
            return False

    monkeypatch.setattr(tui_editor, "FieldEditorApp", CancelEditor)
    cancelled = runner.invoke(
        app, ["agent", "edit", agent_id, "--data-dir", str(tmp_path)]
    )
    assert cancelled.exit_code == 0, cancelled.output
    assert "Edit cancelled" in cancelled.output
    assert AgenticWorkflow.from_file(tmp_path / f"{agent_id}.toml").agents[
        agent_id
    ].subscription == "codex"

    class SaveEditor:
        def __init__(self, sections: list[tui_editor.Section], title: str) -> None:
            self.sections = sections

        def run(self) -> bool:
            self.sections[0].fields[1].value = "claude_code"
            self.sections[0].fields[4].value = ["inspect"]
            return True

    monkeypatch.setattr(tui_editor, "FieldEditorApp", SaveEditor)
    saved = runner.invoke(
        app, ["agent", "edit", agent_id, "--data-dir", str(tmp_path)]
    )

    assert saved.exit_code == 0, saved.output
    assert "Updated agent" in saved.output
    cfg = AgenticWorkflow.from_file(tmp_path / f"{agent_id}.toml").agents[agent_id]
    assert cfg.subscription == "claude_code"
    assert cfg.tools == ["inspect"]


def test_agent_rm_confirmation_and_managed_prompt_cleanup(tmp_path: Path) -> None:
    cancel_id = _create_agent(tmp_path, "Cancel Agent")
    cancel = runner.invoke(
        app,
        ["agent", "rm", cancel_id, "--data-dir", str(tmp_path)],
        input="n\n",
    )
    assert cancel.exit_code != 0
    assert (tmp_path / f"{cancel_id}.toml").exists()

    remove_id = _create_agent(tmp_path, "Remove Agent")
    prompt_path = tmp_path / "prompts" / f"{remove_id}.md"
    assert prompt_path.exists()
    removed = runner.invoke(
        app, ["agent", "rm", remove_id, "--yes", "--data-dir", str(tmp_path)]
    )

    assert removed.exit_code == 0, removed.output
    assert not (tmp_path / f"{remove_id}.toml").exists()
    assert not prompt_path.exists()


def test_agent_run_success_failure_and_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    agent_id = _create_agent(tmp_path)
    success_sub = _CliSubscription(success=True, output="done")

    from gofer.cli.commands import agent as agent_cmd

    monkeypatch.setattr(agent_cmd, "_SUBSCRIPTIONS", {"codex": success_sub})
    success = runner.invoke(
        app, ["agent", "run", agent_id, "--data-dir", str(tmp_path)]
    )

    failure_sub = _CliSubscription(success=False, output="bad result")
    monkeypatch.setattr(agent_cmd, "_SUBSCRIPTIONS", {"codex": failure_sub})
    failure = runner.invoke(
        app, ["agent", "run", agent_id, "--data-dir", str(tmp_path)]
    )
    missing = runner.invoke(
        app, ["agent", "run", "missing", "--data-dir", str(tmp_path)]
    )

    assert success.exit_code == 0, success.output
    assert "done" in success.output
    assert success_sub.calls
    assert failure.exit_code == 1
    assert "Agent failed (exit 7)" in failure.output
    assert "bad result" in failure.output
    assert missing.exit_code == 1
    assert "not found" in missing.output


def test_agent_run_displays_external_extra_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    agent_id = _create_agent(tmp_path)
    extra_dir = tmp_path.parent / "agent-shared-access"
    extra_dir.mkdir(exist_ok=True)
    wf = AgenticWorkflow.from_file(tmp_path / f"{agent_id}.toml")
    wf.agents[agent_id] = wf.agents[agent_id].model_copy(
        update={"extra_paths": [extra_dir]}
    )
    wf.to_file(tmp_path / f"{agent_id}.toml")
    sub = _CliSubscription(success=True, output="done")

    from gofer.cli.commands import agent as agent_cmd

    monkeypatch.setattr(agent_cmd, "_SUBSCRIPTIONS", {"codex": sub})
    result = runner.invoke(
        app, ["agent", "run", agent_id, "--data-dir", str(tmp_path)]
    )

    assert result.exit_code == 0, result.output
    assert "Agent filesystem access outside working_dir" in result.output
    assert "outside working_dir" in result.output
    assert str(extra_dir.resolve()) in result.output
    assert sub.calls[0]["extra_paths"] == [extra_dir.resolve()]


class _FakeScheduler:
    jobs: list[dict[str, str]] = []
    removed: list[str] = []
    started_paths: list[Path] = []
    shutdowns = 0

    def __init__(self, db_path: Path | None = None) -> None:
        self.db_path = db_path

    def add_workflow(self, workflow: AgenticWorkflow, workflow_path: Path) -> None:
        if workflow.config.schedule is None:
            raise ValueError(
                f"Workflow '{workflow.config.id}' has no schedule configured"
            )
        self.jobs.append(
            {
                "id": workflow.config.id,
                "name": workflow.config.name,
                "next_run": "soon",
            }
        )

    def remove_workflow(self, workflow_id: str) -> None:
        self.removed.append(workflow_id)

    def list_workflows(self) -> list[dict[str, str]]:
        return list(self.jobs)

    def start(self) -> None:
        self.started_paths.append(self.db_path or Path(""))

    def shutdown(self) -> None:
        type(self).shutdowns += 1


@pytest.fixture(autouse=False)
def fake_scheduler(monkeypatch: pytest.MonkeyPatch) -> type[_FakeScheduler]:
    _FakeScheduler.jobs = []
    _FakeScheduler.removed = []
    _FakeScheduler.started_paths = []
    _FakeScheduler.shutdowns = 0
    monkeypatch.setattr(schedule_cmd, "_get_scheduler", lambda db: _FakeScheduler(db))
    return _FakeScheduler


def test_schedule_remove_and_empty_list(
    fake_scheduler: type[_FakeScheduler], tmp_path: Path
) -> None:
    list_result = runner.invoke(
        app, ["schedule", "list", "--db", str(tmp_path / "s.db")]
    )
    remove_result = runner.invoke(
        app, ["schedule", "remove", "old-flow", "--db", str(tmp_path / "s.db")]
    )

    assert list_result.exit_code == 0, list_result.output
    assert "No scheduled workflows" in list_result.output
    assert remove_result.exit_code == 0, remove_result.output
    assert fake_scheduler.removed == ["old-flow"]


def test_schedule_start_foreground_uses_runner(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[Path] = []
    monkeypatch.setattr(schedule_cmd, "_run_foreground", lambda db: calls.append(db))

    result = runner.invoke(
        app, ["schedule", "start", "--foreground", "--db", str(tmp_path / "sched.db")]
    )

    assert result.exit_code == 0, result.output
    assert calls == [tmp_path / "sched.db"]


def test_schedule_background_start_running_and_stale_pid(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    pid_file = data_dir / "scheduler.pid"
    pid_file.write_text("123", encoding="utf-8")
    monkeypatch.setattr(schedule_cmd, "_data_dir", lambda: data_dir)
    monkeypatch.setattr("gofer.cli.commands.schedule.os.kill", lambda pid, sig: None)

    running = runner.invoke(app, ["schedule", "start", "--db", str(tmp_path / "s.db")])
    assert running.exit_code == 1
    assert "already running" in running.output

    pid_file.write_text("456", encoding="utf-8")

    def stale_kill(pid: int, sig: int) -> None:
        raise ProcessLookupError

    class FakePopen:
        pid = 789

        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

    monkeypatch.setattr("gofer.cli.commands.schedule.os.kill", stale_kill)
    monkeypatch.setattr("gofer.cli.commands.schedule.subprocess.Popen", FakePopen)
    stale = runner.invoke(app, ["schedule", "start", "--db", str(tmp_path / "s.db")])

    assert stale.exit_code == 0, stale.output
    assert "PID 789" in stale.output
    assert pid_file.read_text(encoding="utf-8") == "789"


def test_schedule_stop_missing_running_and_stale(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    pid_file = data_dir / "scheduler.pid"
    monkeypatch.setattr(schedule_cmd, "_data_dir", lambda: data_dir)

    missing = runner.invoke(app, ["schedule", "stop"])
    assert missing.exit_code == 1
    assert "No background scheduler" in missing.output

    killed: list[tuple[int, int]] = []
    pid_file.write_text("111", encoding="utf-8")
    monkeypatch.setattr(
        "gofer.cli.commands.schedule.os.kill",
        lambda pid, sig: killed.append((pid, sig)),
    )
    stopped = runner.invoke(app, ["schedule", "stop"])
    assert stopped.exit_code == 0, stopped.output
    assert killed == [(111, signal.SIGTERM)]
    assert not pid_file.exists()

    pid_file.write_text("222", encoding="utf-8")

    def stale_kill(pid: int, sig: int) -> None:
        raise ProcessLookupError

    monkeypatch.setattr("gofer.cli.commands.schedule.os.kill", stale_kill)
    stale = runner.invoke(app, ["schedule", "stop"])
    assert stale.exit_code == 0, stale.output
    assert "was not running" in stale.output
    assert not pid_file.exists()


def test_schedule_add_invalid_workflow_schedule(
    fake_scheduler: type[_FakeScheduler], tmp_path: Path
) -> None:
    workflow = _create_workflow(tmp_path)

    result = runner.invoke(
        app, ["schedule", "add", str(workflow), "--db", str(tmp_path / "s.db")]
    )

    assert result.exit_code == 1
    assert "Schedule failed" in result.output
    assert "no schedule" in result.output


def test_schedule_add_displays_external_agent_access(
    fake_scheduler: type[_FakeScheduler], tmp_path: Path
) -> None:
    work_dir = tmp_path / "work"
    extra_dir = tmp_path / "shared"
    work_dir.mkdir()
    extra_dir.mkdir()
    workflow_path = tmp_path / "scheduled.toml"
    workflow_path.write_text(
        f"""
[workflow]
id = "scheduled"
name = "Scheduled"

[workflow.schedule]
cron_expression = "0 9 * * *"

[agents.reviewer]
subscription = "codex"
working_dir = "{work_dir}"
extra_paths = ["{extra_dir}"]
""".strip(),
        encoding="utf-8",
    )

    result = runner.invoke(
        app, ["schedule", "add", str(workflow_path), "--db", str(tmp_path / "s.db")]
    )

    assert result.exit_code == 0, result.output
    assert "Agent filesystem access outside working_dir" in result.output
    assert "reviewer" in result.output
    assert str(extra_dir) in result.output


class _FakeWatcher:
    instances: list[_FakeWatcher] = []

    def __init__(self, poll_interval_seconds: float) -> None:
        self.poll_interval_seconds = poll_interval_seconds
        self.added: list[str] = []
        self.started = False
        self.shutdown_called = False
        type(self).instances.append(self)

    def add_workflow(self, workflow: AgenticWorkflow, path: Path) -> None:
        if workflow.config.id == "bad-watch":
            raise ValueError("bad watch config")
        self.added.append(workflow.config.id)

    def start(self) -> None:
        self.started = True

    def shutdown(self) -> None:
        self.shutdown_called = True


def test_watch_empty_list_and_invalid_toml_skip(tmp_path: Path) -> None:
    (tmp_path / "bad.toml").write_text("not = [valid", encoding="utf-8")

    result = runner.invoke(app, ["watch", "list", "--data-dir", str(tmp_path)])

    assert result.exit_code == 0, result.output
    assert "No watched workflows" in result.output


def test_watch_start_no_watched_workflows(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _FakeWatcher.instances = []
    _create_workflow(tmp_path)
    monkeypatch.setattr(watch_cmd, "WorkflowWatcher", _FakeWatcher)

    result = runner.invoke(app, ["watch", "start", "--data-dir", str(tmp_path)])

    assert result.exit_code == 1
    assert "No watched workflows found" in result.output


def test_watch_start_shutdowns_on_interrupt(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _FakeWatcher.instances = []
    (tmp_path / "watched.toml").write_text(
        _SIMPLE_TOML
        + '\n[workflow.watch]\npath = "inputs"\nglob = "*.txt"\nmode = "batch"\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(watch_cmd, "WorkflowWatcher", _FakeWatcher)
    monkeypatch.setattr(
        "gofer.cli.commands.watch.time.sleep",
        lambda seconds: (_ for _ in ()).throw(KeyboardInterrupt()),
    )

    result = runner.invoke(app, ["watch", "start", "--data-dir", str(tmp_path)])

    assert result.exit_code == 0, result.output
    watcher = _FakeWatcher.instances[-1]
    assert watcher.started is True
    assert watcher.shutdown_called is True
    assert watcher.added == ["simple"]
    assert "Watcher stopped" in result.output


def test_sync_watchers_skips_invalid_workflows_and_watchers(tmp_path: Path) -> None:
    (tmp_path / "bad.toml").write_text("not = [valid", encoding="utf-8")
    (tmp_path / "ok.toml").write_text(
        _SIMPLE_TOML
        + '\n[workflow.watch]\npath = "inputs"\nglob = "*.txt"\nmode = "batch"\n',
        encoding="utf-8",
    )
    (tmp_path / "bad-watch.toml").write_text(
        _SIMPLE_TOML.replace('id = "simple"', 'id = "bad-watch"')
        + '\n[workflow.watch]\npath = "inputs"\nglob = "*.txt"\nmode = "batch"\n',
        encoding="utf-8",
    )
    watcher = _FakeWatcher(1.0)

    count = watch_cmd._sync_watchers(tmp_path, cast(Any, watcher))

    assert count == 1
    assert watcher.added == ["simple"]


def test_watch_start_displays_external_agent_access(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _FakeWatcher.instances = []
    work_dir = tmp_path / "work"
    extra_dir = tmp_path / "shared"
    watch_dir = tmp_path / "inputs"
    work_dir.mkdir()
    extra_dir.mkdir()
    watch_dir.mkdir()
    (tmp_path / "watched.toml").write_text(
        f"""
[workflow]
id = "watched"
name = "Watched"

[workflow.watch]
path = "{watch_dir}"
glob = "*.txt"
mode = "batch"

[agents.reviewer]
subscription = "codex"
working_dir = "{work_dir}"
extra_paths = ["{extra_dir}"]
""".strip(),
        encoding="utf-8",
    )
    monkeypatch.setattr(watch_cmd, "WorkflowWatcher", _FakeWatcher)
    monkeypatch.setattr(
        "gofer.cli.commands.watch.time.sleep",
        lambda seconds: (_ for _ in ()).throw(KeyboardInterrupt()),
    )

    result = runner.invoke(app, ["watch", "start", "--data-dir", str(tmp_path)])

    assert result.exit_code == 0, result.output
    assert "Agent filesystem access outside working_dir" in result.output
    assert "reviewer" in result.output
    assert str(extra_dir) in result.output


def test_workflow_unresolved_id_and_option_parse_errors(tmp_path: Path) -> None:
    _create_workflow(tmp_path)

    missing = runner.invoke(
        app, ["workflow", "show", "missing", "--data-dir", str(tmp_path)]
    )
    bad_kv = runner.invoke(
        app,
        [
            "workflow",
            "add-node",
            "simple",
            "--id",
            "bad",
            "--type",
            "bash_command",
            "--command",
            "echo hi",
            "--input-map",
            "NOPE",
            "--data-dir",
            str(tmp_path),
        ],
    )
    bad_json = runner.invoke(
        app,
        [
            "workflow",
            "add-node",
            "simple",
            "--id",
            "bad-json",
            "--type",
            "bash_command",
            "--command",
            "echo hi",
            "--input-mapping-json",
            "[]",
            "--data-dir",
            str(tmp_path),
        ],
    )

    assert missing.exit_code == 1
    assert "not found" in missing.output
    assert bad_kv.exit_code != 0
    assert "KEY=VALUE" in bad_kv.output
    assert bad_json.exit_code != 0
    assert "JSON object" in bad_json.output


def test_workflow_dry_run_displays_external_agent_access(tmp_path: Path) -> None:
    work_dir = tmp_path / "work"
    node_work_dir = tmp_path / "node-work"
    extra_dir = work_dir / "workflow-shared-access"
    work_dir.mkdir()
    node_work_dir.mkdir()
    extra_dir.mkdir()
    workflow_path = tmp_path / "agent-access.toml"
    workflow_path.write_text(
        f"""
[workflow]
id = "agent-access"
name = "Agent Access"

[agents.reviewer]
subscription = "codex"
working_dir = "{work_dir}"
extra_paths = ["{extra_dir}"]

[[nodes]]
id = "review"
type = "agent"
agent_id = "reviewer"
working_dir = "{node_work_dir}"
""".strip(),
        encoding="utf-8",
    )

    result = runner.invoke(
        app,
        [
            "workflow",
            "run",
            str(workflow_path),
            "--dry-run",
            "--data-dir",
            str(tmp_path),
        ],
    )

    assert result.exit_code == 0, result.output
    assert "Agent filesystem access outside working_dir" in result.output
    assert "reviewer" in result.output
    assert "extra_paths entry" in result.output
    assert node_work_dir.name in result.output


def test_workflow_rejects_invalid_fan_source_combinations(tmp_path: Path) -> None:
    _create_workflow(tmp_path)

    result = runner.invoke(
        app,
        [
            "workflow",
            "add-node",
            "simple",
            "--id",
            "loop",
            "--type",
            "loop",
            "--fan-source",
            "tabular",
            "--data-dir",
            str(tmp_path),
        ],
    )

    assert result.exit_code == 1
    assert "--fan-path is required" in result.output


def test_workflow_edge_and_node_removal_failures(tmp_path: Path) -> None:
    _create_workflow(tmp_path)

    edge = runner.invoke(
        app,
        [
            "workflow",
            "add-edge",
            "simple",
            "--from",
            "hello",
            "--to",
            "missing",
            "--data-dir",
            str(tmp_path),
        ],
    )
    remove_node = runner.invoke(
        app,
        [
            "workflow",
            "rm-node",
            "simple",
            "--id",
            "missing",
            "--data-dir",
            str(tmp_path),
        ],
    )
    remove_edge = runner.invoke(
        app,
        [
            "workflow",
            "rm-edge",
            "missing",
            "--from",
            "a",
            "--to",
            "b",
            "--data-dir",
            str(tmp_path),
        ],
    )
    missing_edge = runner.invoke(
        app,
        [
            "workflow",
            "rm-edge",
            "simple",
            "--from",
            "hello",
            "--to",
            "missing",
            "--data-dir",
            str(tmp_path),
        ],
    )

    assert edge.exit_code == 1
    assert "Invalid edge config" in edge.output
    assert remove_node.exit_code == 1
    assert "Node 'missing' not found" in remove_node.output
    assert remove_edge.exit_code == 1
    assert "not found" in remove_edge.output
    assert missing_edge.exit_code == 1
    assert "Edge 'hello' -> 'missing' not found" in missing_edge.output


def test_workflow_edit_cancel_save_and_validation_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _create_workflow(tmp_path)
    import gofer.cli.tui_editor as tui_editor

    class CancelEditor:
        def __init__(self, sections: list[Any], title: str) -> None:
            pass

        def run(self) -> bool:
            return False

    monkeypatch.setattr(tui_editor, "FieldEditorApp", CancelEditor)
    cancelled = runner.invoke(
        app, ["workflow", "edit", "simple", "--data-dir", str(tmp_path)]
    )
    assert cancelled.exit_code == 0, cancelled.output
    assert "Edit cancelled" in cancelled.output

    class SaveEditor:
        def __init__(self, sections: list[Any], title: str) -> None:
            pass

        def run(self) -> bool:
            return True

    monkeypatch.setattr(tui_editor, "FieldEditorApp", SaveEditor)
    saved = runner.invoke(
        app, ["workflow", "edit", "simple", "--data-dir", str(tmp_path)]
    )
    assert saved.exit_code == 0, saved.output
    assert "Saved" in saved.output

    def fail_validate(self: AgenticWorkflow, *_args: object) -> None:
        raise ValueError("invalid edit")

    monkeypatch.setattr(AgenticWorkflow, "validate", fail_validate)
    failed = runner.invoke(
        app, ["workflow", "edit", "simple", "--data-dir", str(tmp_path)]
    )
    assert failed.exit_code == 1
    assert "Validation failed: invalid edit" in failed.output


def test_workflow_delete_confirmation_behavior(tmp_path: Path) -> None:
    _create_workflow(tmp_path, "cancel-delete")
    cancelled = runner.invoke(
        app,
        ["workflow", "rm", "cancel-delete", "--data-dir", str(tmp_path)],
        input="n\n",
    )
    assert cancelled.exit_code != 0
    assert (tmp_path / "cancel-delete.toml").exists()

    _create_workflow(tmp_path, "delete-me")
    chat_path = workflow_chat_prompt_path(tmp_path, "delete-me")
    chat_path.parent.mkdir(parents=True)
    chat_path.write_text("chat", encoding="utf-8")
    deleted = runner.invoke(
        app, ["workflow", "rm", "delete-me", "--yes", "--data-dir", str(tmp_path)]
    )

    assert deleted.exit_code == 0, deleted.output
    assert not (tmp_path / "delete-me.toml").exists()
    assert not chat_path.exists()


def test_workflow_log_error_paths(tmp_path: Path) -> None:
    _create_workflow(tmp_path)

    latest_missing_workflow = runner.invoke(
        app, ["workflow", "logs", "latest", "missing", "--data-dir", str(tmp_path)]
    )
    invalid_run_id = runner.invoke(
        app,
        [
            "workflow",
            "logs",
            "show",
            "simple",
            "../bad.log",
            "--data-dir",
            str(tmp_path),
        ],
    )
    list_empty = runner.invoke(
        app, ["workflow", "logs", "list", "simple", "--data-dir", str(tmp_path)]
    )

    assert latest_missing_workflow.exit_code == 1
    assert "not found" in latest_missing_workflow.output
    assert invalid_run_id.exit_code == 1
    assert "Invalid run log id" in invalid_run_id.output
    assert list_empty.exit_code == 0, list_empty.output
    assert "No run logs found" in list_empty.output
