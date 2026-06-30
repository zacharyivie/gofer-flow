# Agent Instructions

This file provides guidance for AI coding agents, including Codex, Claude Code, and other agent providers, when working in this repository.

## Project Summary

`gofer-flow` is a Python CLI tool (`gof`) for defining and executing DAG-based agentic workflows. Workflows are defined in TOML and can run bash commands, scripts, or LLM agent calls as nodes in a directed acyclic graph.

## Commands

```bash
# Install for development
pip install -e ".[dev]"

# Run all tests
python -m pytest

# Run specific test categories
python -m pytest tests/unit/
python -m pytest tests/integration/
python -m pytest tests/regression/

# Run a single test
python -m pytest tests/unit/test_executor.py::test_name -v

# Type checking
mypy src tests

# Linting and formatting
ruff check src tests --fix
ruff format src tests
```

## Architecture

Layer structure:

- `src/gofer/cli/` - Typer CLI; routes commands to workflow, agent, schedule, and builder command modules.
- `src/gofer/core/` - Domain logic: operations, graph, workflow, executor, and scheduler.
- `src/gofer/subscriptions/` - ABC for LLM CLI backends such as Claude Code and Codex. Subclasses primarily override `_build_command()`.
- `src/gofer/prompts/` - Markdown prompt templates with `{{var}}` interpolation.
- `src/gofer/utils/` - Subprocess runner, XDG paths, name-based registry, and logging.

Execution flow:

1. `AgenticWorkflow.from_file()` deserializes TOML into a NetworkX DAG and agent configs.
2. `WorkflowExecutor.run()` groups nodes by topological generation.
3. Each generation runs concurrently with `anyio` task groups.
4. Node outputs are captured as `NodeOutput` and stored in `ExecutionContext` for downstream interpolation.
5. `EdgeConfig.evaluate()` handles conditional edges: `ON_SUCCESS`, `ON_FAILURE`, and `OUTPUT_MATCHES`.

Key patterns:

- Operations use a Pydantic v2 discriminated union on the `type` field; TOML deserialization should remain automatic.
- `dynamic_count` on `AgentOperation` nodes enables runtime fan-out resolved against prior outputs.
- `WorkflowScheduler` wraps APScheduler with a SQLite job store persisted at `~/.local/share/gofer/schedules.db`.
- Tests use `FakeSubscription` from `tests/conftest.py` to avoid requiring real `claude` or `codex` CLIs.

## TOML Workflow Format

```toml
[workflow]
id = "my-workflow"
name = "My Workflow"

[agents.analyzer]
subscription = "claude_code"

[[nodes]]
id = "step1"
type = "bash_command"
command = "echo hello"

[[nodes]]
id = "step2"
type = "agent"
agent_id = "analyzer"
prompt = "Analyze: {{step1.output}}"

[[edges]]
from = "step1"
to = "step2"
```

## Development Rules

- Prefer the existing module boundaries and patterns before adding new abstractions.
- Keep CLI behavior covered by tests when changing command behavior.
- Keep workflow parsing and execution behavior covered by unit or regression tests when changing operation, graph, executor, or scheduler logic.
- Do not require real LLM provider CLIs in tests; use `FakeSubscription` or another test double.
- Frontend controlled inputs: do not transform or normalize a user-editable value
  on every keystroke when the displayed value is derived from the stored value,
  such as percentages, parsed numbers, paths, JSON, units, or enum-like labels.
  Keep a local draft string while the field is focused and commit on blur or
  Enter, otherwise clearing/backspacing can snap the field back to the previous
  normalized value. Add regression coverage for focus -> clear -> type -> blur
  flows.
- After code changes, run `ruff check src tests --fix`.
- After code changes, run `mypy src tests`.
- Run targeted pytest tests for the changed area; run the full suite when touching shared workflow execution, scheduling, or CLI behavior.
- To run any npm commands make sure you first use nvm to select the correct version of npm for the project.
