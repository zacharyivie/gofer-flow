# AgenticTaskManager — Implementation Plan

## Project Overview

A Python CLI tool (`atm`) for creating and scheduling agentic workflows. Workflows are directed acyclic graphs whose nodes can be bash commands, Python/shell scripts, or LLM-backed agents (Claude Code / Codex CLI). Workflows can be run on demand or on a cron schedule.

---

## Project Structure

```
AgenticTaskManager/
├── pyproject.toml
├── prompts/                          # Built-in prompt library (markdown files)
│   └── examples/
├── src/
│   └── agentic_task_manager/
│       ├── cli/
│       │   ├── main.py               # Typer entry point (`atm`)
│       │   └── commands/
│       │       ├── agent.py
│       │       ├── workflow.py
│       │       ├── schedule.py
│       │       └── prompts.py
│       ├── core/
│       │   ├── agent.py              # Agent + AgentConfig + AgentResult
│       │   ├── workflow.py           # AgenticWorkflow + WorkflowConfig
│       │   ├── graph.py              # WorkflowGraph (wraps networkx.DiGraph)
│       │   ├── executor.py           # WorkflowExecutor (anyio task groups)
│       │   ├── scheduler.py          # WorkflowScheduler (APScheduler + SQLite)
│       │   └── operations.py         # Pydantic discriminated union of operation types
│       ├── subscriptions/
│       │   ├── base.py               # Abstract Subscription (shared subprocess logic)
│       │   ├── claude_code.py        # ClaudeCodeSubscription — invokes `claude` CLI
│       │   └── codex.py              # CodexSubscription — invokes `codex` CLI
│       ├── prompts/
│       │   └── manager.py            # PromptManager — discovery + {{var}} interpolation
│       └── utils/
│           ├── logging.py
│           └── process.py            # Async subprocess helper
└── tests/
    ├── conftest.py                   # FakeSubscription fixture
    ├── unit/
    │   ├── test_operations.py
    │   ├── test_graph.py
    │   ├── test_agent.py
    │   ├── test_executor.py
    │   ├── test_scheduler.py
    │   ├── test_subscriptions.py
    │   └── test_prompt_manager.py
    ├── integration/
    │   ├── test_workflow_execution.py
    │   └── test_scheduler_trigger.py
    └── regression/
        └── test_end_to_end.py
```

---

## Dependencies

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "agentic-task-manager"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "typer[all]>=0.12",
    "apscheduler>=3.10",
    "networkx>=3.3",
    "pydantic>=2.7",
    "pydantic-settings>=2.3",
    "rich>=13.7",
    "anyio>=4.4",
    "python-dotenv>=1.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.2",
    "pytest-asyncio>=0.23",
    "pytest-cov>=5.0",
    "pytest-mock>=3.14",
    "mypy>=1.10",
    "ruff>=0.4",
]

[project.scripts]
atm = "agentic_task_manager.cli.main:app"

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]

[tool.mypy]
strict = true
python_version = "3.11"
```

---

## Core Class Interfaces

### `operations.py` — Pydantic discriminated union

All graph node operation types. The discriminated union enables Pydantic to deserialize TOML/JSON workflow files automatically.

```python
class OperationType(str, Enum):
    PYTHON_SCRIPT = "python_script"
    SHELL_SCRIPT  = "shell_script"
    BASH_COMMAND  = "bash_command"
    AGENT         = "agent"

class PythonScriptOperation(BaseModel):
    type: Literal[OperationType.PYTHON_SCRIPT]
    script_path: Path
    args: list[str] = []
    env: dict[str, str] = {}

class ShellScriptOperation(BaseModel):
    type: Literal[OperationType.SHELL_SCRIPT]
    script_path: Path
    args: list[str] = []
    env: dict[str, str] = {}

class BashCommandOperation(BaseModel):
    type: Literal[OperationType.BASH_COMMAND]
    command: str
    working_dir: Path | None = None
    env: dict[str, str] = {}

class AgentOperation(BaseModel):
    type: Literal[OperationType.AGENT]
    agent_id: str
    prompt_path: Path
    working_dir: Path
    dynamic_count: int | str = 1   # int or "{{prev.output.count}}" — resolved at runtime
    input_mapping: dict[str, str] = {}

Operation = Annotated[
    Union[PythonScriptOperation, ShellScriptOperation, BashCommandOperation, AgentOperation],
    Field(discriminator="type"),
]
```

### `graph.py` — `WorkflowGraph`

Thin wrapper around `networkx.DiGraph`. Cycle detection is enforced on every `add_edge` call.

```python
class GraphNode(BaseModel):
    node_id: str
    operation: Operation
    retry_count: int = 0
    retry_delay_seconds: float = 1.0
    timeout_seconds: float | None = None
    on_failure: Literal["halt", "skip", "continue"] = "halt"

class WorkflowGraph:
    def add_node(self, node: GraphNode) -> None: ...
    def add_edge(self, from_id: str, to_id: str) -> None: ...  # raises on cycle
    def topological_generations(self) -> list[list[GraphNode]]: ...  # nodes safe to run in parallel
    def validate(self) -> None: ...
```

### `agent.py` — `Agent`

```python
class AgentConfig(BaseModel):
    agent_id: str
    subscription: Literal["claude_code", "codex"]  # selects which CLI to use
    working_dir: Path
    prompt_path: Path
    tools: list[str] = []
    mcp_servers: list[str] = []
    env: dict[str, str] = {}

class AgentResult(BaseModel):
    agent_id: str
    success: bool
    output: str
    exit_code: int
    duration_seconds: float

class Agent:
    def __init__(self, config: AgentConfig, subscription: Subscription) -> None: ...
    async def run(self, context: dict | None = None) -> AgentResult: ...
```

### `subscriptions/base.py` — `Subscription` (ABC)

Shared subprocess invocation lives in the base class. Subclasses only implement `_build_command` and `is_available`.

```python
class Subscription(ABC):
    async def execute(self, prompt, working_dir, tools, mcp_servers, env) -> AgentResult:
        cmd = self._build_command(prompt, tools, mcp_servers)
        return await run_subprocess(cmd, cwd=working_dir, env=env)

    @abstractmethod
    def _build_command(self, prompt: str, tools: list[str], mcp_servers: list[str]) -> list[str]: ...

    @abstractmethod
    def is_available(self) -> bool: ...
```

`ClaudeCodeSubscription._build_command` → `["claude", "--print", "-p", prompt, ...]`
`CodexSubscription._build_command` → equivalent Codex CLI invocation

### `executor.py` — `WorkflowExecutor`

```python
class WorkflowExecutor:
    async def run(self) -> ExecutionResult:
        for generation in self._workflow.graph.topological_generations():
            async with anyio.create_task_group() as tg:
                for node in generation:
                    tg.start_soon(self._run_node, node, ctx)
```

- `dynamic_count` as a string is evaluated against `ExecutionContext.node_outputs` at runtime
- Multiple agents from `dynamic_count > 1` are spawned in a nested task group

### `scheduler.py` — `WorkflowScheduler`

- `APScheduler BackgroundScheduler` with `SQLAlchemyJobStore` (SQLite) — jobs survive restarts
- `add_workflow(wf)` registers cron from `wf.config.schedule.cron_expression`
- `coalesce=True`, `max_instances=1` by default

### `workflow.py` — `AgenticWorkflow`

```python
class AgenticWorkflow:
    def add_operation(self, node: GraphNode) -> "AgenticWorkflow": ...  # fluent builder
    def then(self, from_id: str, to_id: str) -> "AgenticWorkflow": ...
    def validate(self) -> None: ...
    @classmethod
    def from_file(cls, path: Path) -> "AgenticWorkflow": ...  # deserialize TOML
    def to_file(self, path: Path) -> None: ...                # serialize to TOML
```

---

## Workflow Definition Format (TOML)

```toml
[workflow]
id = "daily-summary"
name = "Daily Repository Summary"

[workflow.schedule]
cron_expression = "0 9 * * 1-5"
timezone = "UTC"

[agents.summarizer]
subscription = "claude_code"
working_dir = "/srv/repos/myproject"
prompt_path = "prompts/summarize.md"
tools = ["Bash", "Read", "Write"]

[[nodes]]
id = "fetch-commits"
type = "bash_command"
command = "git log --since=yesterday --oneline > /tmp/commits.txt"

[[nodes]]
id = "summarize"
type = "agent"
agent_id = "summarizer"
dynamic_count = 1

[[edges]]
from = "fetch-commits"
to = "summarize"
```

---

## CLI Commands

```
atm workflow run      <file> [--dry-run]
atm workflow validate <file>
atm workflow create   --name <name>

atm agent run         --agent-id <id> --workflow <file>
atm agent list        --workflow <file>

atm schedule add      <workflow-file>
atm schedule remove   <workflow-id>
atm schedule list
atm schedule start    [--daemon]

atm prompts list      [--dir <path>]
atm prompts show      <name>
atm prompts new       --name <name>
```

---

## Prompts Management

- `PromptManager` scans `prompts/` directories for `*.md` files
- `load(path, context)` performs lightweight `{{key.nested}}` interpolation — no Jinja2 dependency
- `context` is populated from `ExecutionContext.node_outputs` of prior nodes

---

## Testing Strategy

### `FakeSubscription` (`conftest.py`)

Implements `Subscription`; records calls; returns configurable output. Eliminates the need for a real CLI install in tests.

```python
class FakeSubscription(Subscription):
    def __init__(self, output: str = "ok", exit_code: int = 0) -> None:
        self.calls: list[dict] = []

    def _build_command(self, prompt, tools, mcp_servers) -> list[str]:
        return ["fake"]

    def is_available(self) -> bool:
        return True

    async def execute(self, prompt, working_dir, tools, mcp_servers, env) -> AgentResult:
        self.calls.append({"prompt": prompt, "working_dir": working_dir})
        return AgentResult(...)
```

### Unit Tests (one file per module)

- `test_graph.py`: cycle detection, parallel generation grouping
- `test_operations.py`: Pydantic validation, TOML round-trip
- `test_agent.py`: delegates to subscription, prompt interpolation applied
- `test_executor.py`: generation ordering, dynamic count expansion, failure modes
- `test_scheduler.py`: add/remove/list lifecycle (mock APScheduler)
- `test_subscriptions.py`: correct command construction, `is_available` checks
- `test_prompt_manager.py`: discovery, `{{var}}` interpolation edge cases

### Integration Tests

- `test_workflow_execution.py`: multi-node workflow, real anyio task groups, `FakeSubscription`
- `test_scheduler_trigger.py`: add → list → remove lifecycle

### Regression Test (`test_end_to_end.py`)

1. Write complete TOML workflow to `tmp_path`
2. Load with `AgenticWorkflow.from_file()`
3. Execute with `WorkflowExecutor`
4. Assert all node outputs present and correct
5. Schedule; confirm appears in list
6. Remove; confirm gone

---

## Phased Roadmap

| Phase | Deliverables |
|---|---|
| 1 — Foundation | `pyproject.toml`, `operations.py`, `graph.py`, `utils/process.py`, unit tests |
| 2 — Subscriptions & Agent | `subscriptions/base.py`, `claude_code.py`, `codex.py` (stub), `prompts/manager.py`, `core/agent.py`, unit tests |
| 3 — Workflow & Executor | `core/workflow.py`, `core/executor.py`, TOML serde, integration tests |
| 4 — Scheduler | `core/scheduler.py`, APScheduler + SQLite, integration tests |
| 5 — CLI | `cli/main.py` + all command modules, Rich output, Typer CliRunner tests |
| 6 — Hardening | Regression test, `--dry-run` pass, structured logging, `mypy --strict`, `ruff` |

---

## Key Design Decisions

| Decision | Choice | Reason |
|---|---|---|
| Graph | `networkx` | Cycle detection + `topological_generations` out of the box |
| Concurrency | `anyio` task groups | Structured concurrency; backend-agnostic |
| Validation | Pydantic v2 | Free TOML/JSON serde; strict typing |
| CLI backend abstraction | `Subscription` base class | Shared subprocess logic; only command construction differs per CLI |
| Scheduling persistence | APScheduler + SQLite | Survives restarts; no external service needed |
| CLI framework | Typer + Rich | Type-hint driven; clean terminal output |
| Config format | TOML | Human-readable; Python 3.11 stdlib (`tomllib`) |
| Dynamic agent fan-out | `dynamic_count` on `AgentOperation` | Runtime expansion without graph rewriting |
