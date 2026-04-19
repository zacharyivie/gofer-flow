from __future__ import annotations

from pathlib import Path

from agentic_task_manager.core.agent import AgentConfig
from agentic_task_manager.core.workflow import AgenticWorkflow
from agentic_task_manager.utils.paths import get_data_dir


def _workflow_files(data_dir: Path | None = None) -> list[Path]:
    base = data_dir or get_data_dir()
    if not base.exists():
        return []
    return sorted(base.glob("*.toml"))


def list_all_agents(data_dir: Path | None = None) -> list[tuple[AgenticWorkflow, AgentConfig]]:
    """Return (workflow, agent_config) pairs for every agent in the data dir."""
    results: list[tuple[AgenticWorkflow, AgentConfig]] = []
    for path in _workflow_files(data_dir):
        try:
            wf = AgenticWorkflow.from_file(path)
        except Exception:
            continue
        for cfg in wf.agents.values():
            results.append((wf, cfg))
    return results


def find_agent(
    agent_id: str, data_dir: Path | None = None
) -> tuple[AgenticWorkflow, AgentConfig]:
    """Find an agent by ID across all workflow files. Raises KeyError if not found."""
    for wf, cfg in list_all_agents(data_dir):
        if cfg.agent_id == agent_id:
            return wf, cfg
    raise KeyError(f"Agent '{agent_id}' not found in {data_dir or get_data_dir()}")


def find_workflow(workflow_id: str, data_dir: Path | None = None) -> AgenticWorkflow:
    """Find a workflow by ID or file stem. Raises KeyError if not found."""
    base = data_dir or get_data_dir()

    # Try exact file stem first
    candidate = base / f"{workflow_id}.toml"
    if candidate.exists():
        return AgenticWorkflow.from_file(candidate)

    # Fall back to scanning workflow IDs
    for path in _workflow_files(data_dir):
        try:
            wf = AgenticWorkflow.from_file(path)
        except Exception:
            continue
        if wf.config.id == workflow_id:
            return wf

    raise KeyError(f"Workflow '{workflow_id}' not found in {base}")
