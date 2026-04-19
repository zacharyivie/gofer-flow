from __future__ import annotations

from pathlib import Path

from agentic_task_manager.core.executor import WorkflowExecutor
from agentic_task_manager.core.scheduler import WorkflowScheduler
from agentic_task_manager.core.workflow import AgenticWorkflow

_TOML = """
[workflow]
id = "e2e-test"
name = "End-to-End Test"

[workflow.schedule]
cron_expression = "0 9 * * 1-5"
timezone = "UTC"

[[nodes]]
id = "step-one"
type = "bash_command"
command = "echo step-one-output"

[[nodes]]
id = "step-two"
type = "bash_command"
command = "echo step-two-output"

[[edges]]
from = "step-one"
to = "step-two"
"""


async def test_full_workflow_load_execute_schedule(tmp_path: Path) -> None:
    # 1. Write complete TOML workflow
    wf_file = tmp_path / "e2e.toml"
    wf_file.write_text(_TOML)

    # 2. Load with AgenticWorkflow.from_file
    wf = AgenticWorkflow.from_file(wf_file)
    assert wf.config.id == "e2e-test"
    wf.validate()

    # 3. Execute with WorkflowExecutor
    result = await WorkflowExecutor(wf, {}).run()

    # 4. Assert all node outputs present and correct
    assert result.success
    assert "step-one" in result.node_outputs
    assert "step-two" in result.node_outputs
    assert "step-one-output" in result.node_outputs["step-one"].output
    assert "step-two-output" in result.node_outputs["step-two"].output

    # 5. Schedule; confirm appears in list
    db = tmp_path / "sched.db"
    scheduler = WorkflowScheduler(db_path=db)
    scheduler.add_workflow(wf, wf_file)
    jobs = scheduler.list_workflows()
    assert any(j["id"] == "e2e-test" for j in jobs)

    # 6. Remove; confirm gone
    scheduler.remove_workflow("e2e-test")
    jobs = scheduler.list_workflows()
    assert not any(j["id"] == "e2e-test" for j in jobs)
