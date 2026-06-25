from __future__ import annotations

from pathlib import Path

from gofer.cli.commands.schedule import _default_db, _pid_file
from gofer.core.agent import AgentConfig
from gofer.core.executor import WorkflowExecutor
from gofer.core.graph import GraphNode
from gofer.core.operations import DeleteFileOperation, OperationType, PassOperation
from gofer.core.workflow import AgenticWorkflow, WorkflowConfig
from gofer.ui.api import create_workflow_payload, list_workflow_payloads
from gofer.ui.chat import workflow_chat_prompt_path
from gofer.utils.paths import get_data_dir
from gofer.utils.registry import find_workflow, list_all_agents
from gofer.utils.run_state import clear_workflow_stop, request_workflow_stop


def _assert_under(path: Path, base: Path) -> None:
    assert path.resolve().is_relative_to(base.resolve()), f"{path} is not under {base}"


def test_default_data_dir_is_isolated(
    isolated_gofer_data_dir: Path,
) -> None:
    assert get_data_dir() == isolated_gofer_data_dir
    assert isolated_gofer_data_dir.name == "gofer"


def test_run_state_defaults_stay_under_isolated_data_dir(
    isolated_gofer_data_dir: Path,
) -> None:
    stop_path = request_workflow_stop("isolated/default")

    _assert_under(stop_path, isolated_gofer_data_dir)
    assert stop_path == isolated_gofer_data_dir / "run-state" / "isolated_default.stop"
    assert stop_path.exists()

    clear_workflow_stop("isolated/default")

    assert not stop_path.exists()


async def test_executor_default_logs_stay_under_isolated_data_dir(
    isolated_gofer_data_dir: Path,
) -> None:
    workflow = AgenticWorkflow(WorkflowConfig(id="default-logs", name="Default Logs"))
    workflow.add_operation(
        GraphNode(
            node_id="ok",
            operation=PassOperation(type=OperationType.PASS, message="done"),
        )
    )

    result = await WorkflowExecutor(workflow, {}).run()

    assert result.success
    assert result.log_path is not None
    _assert_under(result.log_path, isolated_gofer_data_dir)
    assert result.log_path.parent == isolated_gofer_data_dir / "logs" / "default-logs"
    assert result.log_path.exists()


async def test_default_trash_stays_under_isolated_data_dir(
    tmp_path: Path,
    isolated_gofer_data_dir: Path,
) -> None:
    target = tmp_path / "delete-me.txt"
    target.write_text("trash me", encoding="utf-8")
    workflow = AgenticWorkflow(WorkflowConfig(id="trash-default", name="Trash Default"))
    workflow.add_operation(
        GraphNode(
            node_id="trash",
            operation=DeleteFileOperation(type=OperationType.DELETE_FILE, path=target),
        )
    )

    result = await WorkflowExecutor(workflow, {}, log_base_dir=tmp_path / "logs").run()

    assert result.success
    assert not target.exists()
    trash_root = isolated_gofer_data_dir / "trash"
    trashed = list(trash_root.iterdir())
    assert len(trashed) == 1
    assert trashed[0].read_text(encoding="utf-8") == "trash me"


def test_registry_defaults_stay_under_isolated_data_dir(
    isolated_gofer_data_dir: Path,
) -> None:
    workflow = AgenticWorkflow(WorkflowConfig(id="registered", name="Registered"))
    workflow.register_agent(
        AgentConfig(
            agent_id="writer",
            subscription="codex",
            working_dir=isolated_gofer_data_dir,
        )
    )
    workflow_path = isolated_gofer_data_dir / "registered.toml"
    workflow_path.parent.mkdir(parents=True, exist_ok=True)
    workflow.to_file(workflow_path)

    found = find_workflow("registered")
    agents = list_all_agents()

    assert found.config.id == "registered"
    assert [(wf.config.id, agent.agent_id) for wf, agent in agents] == [
        ("registered", "writer")
    ]


def test_scheduler_default_paths_stay_under_isolated_data_dir(
    isolated_gofer_data_dir: Path,
) -> None:
    db_path = _default_db()
    pid_path = _pid_file()

    assert db_path == isolated_gofer_data_dir / "schedules.db"
    assert pid_path == isolated_gofer_data_dir / "scheduler.pid"


def test_ui_workflow_prompt_and_chat_defaults_stay_under_isolated_data_dir(
    isolated_gofer_data_dir: Path,
) -> None:
    payload = create_workflow_payload("Isolated Workflow")
    prompts_dir = isolated_gofer_data_dir / "prompts"
    prompts_dir.mkdir(parents=True)
    (prompts_dir / "agent-1.md").write_text("Prompt", encoding="utf-8")
    chat_prompt_path = workflow_chat_prompt_path(isolated_gofer_data_dir, payload["id"])

    listed = list_workflow_payloads()

    assert (isolated_gofer_data_dir / "isolated-workflow.toml").exists()
    assert payload["sourcePath"] == "isolated-workflow.toml"
    assert listed["dataDir"] == str(isolated_gofer_data_dir)
    assert listed["promptAgentIds"] == ["agent-1"]
    _assert_under(chat_prompt_path, isolated_gofer_data_dir)
    assert chat_prompt_path.parent == isolated_gofer_data_dir / ".gofer-chat-prompts"
    assert chat_prompt_path.name.startswith("isolated-workflow-")
    assert chat_prompt_path.suffix == ".md"
