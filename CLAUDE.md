# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install for development
pip install -e ".[dev]"

# Run all tests
python -m pytest

# Run specific test category
python -m pytest tests/unit/
python -m pytest tests/integration/
python -m pytest tests/regression/

# Run a single test
python -m pytest tests/unit/test_executor.py::test_name -v

# Type checking (strict mode)
mypy src/

# Linting and formatting
ruff check src/ tests/
ruff format src/ tests/
```

## Architecture

The project is a CLI tool (`gof`) for defining and executing DAG-based agentic workflows. Workflows are defined in TOML and can run bash commands, scripts, or LLM agent calls as nodes in a directed acyclic graph.

**Layer structure:**
- `cli/` — Typer CLI; routes commands to `commands/` submodules (workflow, agent, schedule, prompts, builder)
- `core/` — Domain logic: operations, graph, workflow, executor, scheduler
- `subscriptions/` — ABC for LLM CLI backends (claude, codex); subclasses only override `_build_command()`
- `prompts/` — Markdown prompt templates with `{{var}}` interpolation
- `utils/` — Subprocess runner, XDG paths, name-based registry, logging

**Execution flow:**
1. `AgenticWorkflow.from_file()` deserializes TOML → networkx DAG + agent configs
2. `WorkflowExecutor.run()` groups nodes by topological generation
3. Each generation runs concurrently via `anyio` task groups
4. Node outputs are captured as `NodeOutput` and stored in `ExecutionContext` for downstream interpolation
5. `EdgeConfig.evaluate()` handles conditional edges (ON_SUCCESS, ON_FAILURE, OUTPUT_MATCHES)

**Key patterns:**
- Operations use a Pydantic v2 discriminated union on the `type` field — all TOML deserialization is automatic
- `dynamic_count` on `AgentOperation` nodes enables fan-out at runtime (resolved against prior outputs)
- `WorkflowScheduler` wraps APScheduler with a SQLite job store; persists across restarts via `~/.local/share/gofer/schedules.db`
- Tests use `FakeSubscription` (defined in `tests/conftest.py`) to avoid requiring a real `claude`/`codex` CLI

**TOML workflow format:**
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

## CLAUDE INSTRUCTIONS

- Always verify linting after making code changes using `ruff check src tests --fix`
- Always run `mypy on src tests` after making code changes
