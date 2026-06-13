# Gofer Flow

Gofer Flow is a Python CLI tool for defining and running DAG-based agentic workflows. Workflows are written in TOML and can combine shell commands, scripts, and LLM agent calls into a directed acyclic graph.

The installed command is `gof`.

## What It Can Do

- Run workflow nodes in topological order, with independent nodes in the same generation running concurrently.
- Execute `bash_command`, `shell_script`, `python_script`, and `agent` nodes.
- Use Claude Code or Codex as agent backends through their local CLIs.
- Validate workflow DAGs and reject cycles.
- Show workflow structure in the terminal.
- Create workflow scaffolds and build workflows through an interactive wizard.
- Edit agents and workflows in an interactive terminal editor.
- Store named workflows and agents in the user data directory.
- Run a single named agent outside a workflow.
- Schedule workflows with cron expressions through APScheduler and a SQLite job store.
- Fan out agent nodes across a fixed count, rows in tabular files, or files in a directory.
- Pass outputs between nodes through prompt interpolation, explicit input mappings, or piped stdin.
- Retry nodes, set timeouts, and conditionally traverse edges based on success, failure, or output regex matches.

## Requirements

- Python 3.11 or newer
- Node.js 20 or newer if you want to run the React workflow studio
- One or both local agent CLIs if you want to run agent nodes:
  - `claude` for `claude_code` subscriptions
  - `codex` for `codex` subscriptions

Script and command nodes do not require an LLM provider CLI.

## Setup

Install the project in editable mode with development dependencies:

```bash
pip install -e ".[dev]"
```

Install optional Excel support if you want tabular fan-out from `.xlsx` files:

```bash
pip install -e ".[dev,xlsx]"
```

Confirm the CLI is available:

```bash
gof --help
```

Run the React workflow studio:

```bash
gof ui serve

# In another shell:
cd frontend
npm install
npm run dev
```

## Data Directory

By default, Gofer Flow stores workflows, agent files, prompts, scheduler state, and scheduler PID files in the OS user data directory:

- Linux: `$XDG_DATA_HOME/gofer` or `~/.local/share/gofer`
- macOS: `~/Library/Application Support/gofer`
- Windows: `%APPDATA%\gofer`

Many commands also include a hidden `--data-dir` option used by tests and automation.

## Workflow Commands

```bash
# Create a minimal workflow TOML scaffold
gof workflow create --name "Daily Analysis"

# Build a workflow interactively
gof workflow build

# Save an interactively built workflow somewhere specific
gof workflow build --output ./daily-analysis.toml

# List stored workflows
gof workflow list

# Validate a stored workflow ID or TOML path
gof workflow validate daily-analysis
gof workflow validate ./daily-analysis.toml

# Show the workflow DAG
gof workflow show daily-analysis

# Run a workflow
gof workflow run daily-analysis
gof workflow run ./daily-analysis.toml

# Simulate a workflow without executing nodes
gof workflow run daily-analysis --dry-run

# Print node output while running
gof workflow run daily-analysis --verbose

# Edit a workflow interactively
gof workflow edit daily-analysis

# Delete a stored workflow
gof workflow rm daily-analysis
gof workflow rm daily-analysis --yes
```

Workflows can be resolved by stored workflow ID or by a direct `.toml` path.

## Agent Commands

```bash
# Create an agent interactively or with flags
gof agent create
gof agent create \
  --name "Reviewer" \
  --subscription codex \
  --working-dir . \
  --prompt "Review the current repository changes."

# List all agents
gof agent list

# List agents for one workflow
gof agent list --workflow daily-analysis

# Run a named agent directly
gof agent run reviewer

# Edit an agent interactively
gof agent edit reviewer

# Edit an agent with flags
gof agent edit reviewer --subscription claude_code --tools "Read,Write"

# Remove an agent from its workflow
gof agent rm reviewer
gof agent rm reviewer --yes
```

Agent subscriptions currently support:

- `claude_code`, which runs `claude --print -p <prompt>`
- `codex`, which runs `codex --quiet -p <prompt>`

Agent prompts can be inline text or a path to a Markdown file. Inline prompts are written to the managed `prompts/` directory.

## Schedule Commands

Workflows can include schedule metadata:

```toml
[workflow.schedule]
cron_expression = "0 9 * * 1-5"
timezone = "UTC"
```

Schedule management:

```bash
# Add a workflow TOML file to the scheduler database
gof schedule add ./daily-analysis.toml

# List scheduled workflows
gof schedule list

# Remove a scheduled workflow
gof schedule remove daily-analysis

# Start the scheduler in the background
gof schedule start

# Start the scheduler in the foreground
gof schedule start --foreground

# Stop the background scheduler
gof schedule stop
```

The default scheduler database is `schedules.db` in the Gofer data directory. You can override it with `--db`.

## Workflow TOML

A minimal command-only workflow:

```toml
[workflow]
id = "hello"
name = "Hello Workflow"

[[nodes]]
id = "step-one"
type = "bash_command"
command = "echo hello"

[[nodes]]
id = "step-two"
type = "bash_command"
command = "echo world"

[[edges]]
from = "step-one"
to = "step-two"
```

A workflow with an agent node:

```toml
[workflow]
id = "analysis"
name = "Analysis"

[agents.reviewer]
subscription = "codex"
working_dir = "."
prompt_path = "prompts/reviewer.md"
tools = []
mcp_servers = []
env = {}

[[nodes]]
id = "collect"
type = "bash_command"
command = "git diff --stat"
pipe_output = true

[[nodes]]
id = "review"
type = "agent"
agent_id = "reviewer"
prompt_path = "prompts/reviewer.md"
working_dir = "."

[[edges]]
from = "collect"
to = "review"
```

Prompt files support `{{var}}` interpolation from the context passed to an agent. When a predecessor node has `pipe_output = true`, its output is prepended to downstream agent prompts and sent to downstream script or command nodes as stdin.

## Node Types

### `bash_command`

Runs a command through `bash -c`.

```toml
[[nodes]]
id = "list-files"
type = "bash_command"
command = "find . -maxdepth 2 -type f"
working_dir = "."
env = { EXAMPLE = "1" }
```

### `python_script`

Runs a Python script with optional arguments.

```toml
[[nodes]]
id = "transform"
type = "python_script"
script_path = "scripts/transform.py"
args = ["--format", "json"]
env = {}
```

### `shell_script`

Runs a shell script with `bash`.

```toml
[[nodes]]
id = "deploy"
type = "shell_script"
script_path = "scripts/deploy.sh"
args = ["staging"]
```

### `agent`

Runs a configured LLM agent.

```toml
[[nodes]]
id = "summarize"
type = "agent"
agent_id = "summarizer"
prompt_path = "prompts/summarize.md"
working_dir = "."
input_mapping = { diff = "collect" }
```

## Node Controls

All node types can use these graph-level controls:

```toml
[[nodes]]
id = "fragile-step"
type = "bash_command"
command = "curl -f https://example.com"
retry_count = 2
retry_delay_seconds = 3
timeout_seconds = 30
pipe_output = true
```

- `retry_count`: number of retries after the first failed attempt.
- `retry_delay_seconds`: delay between retry attempts.
- `timeout_seconds`: subprocess timeout.
- `pipe_output`: makes the node output available as stdin or prepended prompt text for downstream nodes.

## Conditional Edges

Edges default to `always`. They can also run only on success, only on failure, or when output matches a regex.

```toml
[[edges]]
from = "test"
to = "deploy"
condition = "on_success"

[[edges]]
from = "test"
to = "notify"
condition = "on_failure"

[[edges]]
from = "scan"
to = "investigate"
condition = "output_matches"
output_pattern = "CRITICAL|HIGH"
```

Supported conditions:

- `always`
- `on_success`
- `on_failure`
- `output_matches`

## Agent Fan-Out

Agent nodes can run multiple instances concurrently.

Fixed count:

```toml
[[nodes]]
id = "parallel-review"
type = "agent"
agent_id = "reviewer"
prompt_path = "prompts/review.md"
working_dir = "."

[nodes.fan_source]
type = "count"
count = 4
max_concurrency = 2
fail_fast = false
```

Rows from `.csv`, `.jsonl`, or `.xlsx`:

```toml
[[nodes]]
id = "process-rows"
type = "agent"
agent_id = "row-worker"
prompt_path = "prompts/row.md"
working_dir = "."

[nodes.fan_source]
type = "tabular"
path = "data/items.csv"
max_concurrency = 8
fail_fast = true
```

Files in a directory:

```toml
[[nodes]]
id = "process-files"
type = "agent"
agent_id = "file-worker"
prompt_path = "prompts/file.md"
working_dir = "."

[nodes.fan_source]
type = "directory"
path = "docs"
glob = "*.md"
include_content = true
max_concurrency = 4
fail_fast = false
```

Fan-out context includes:

- Count fan-out: `{{index}}`
- Tabular fan-out: each column by name, plus `_row` containing the whole row as JSON
- Directory fan-out: `{{file_path}}`, `{{file_name}}`, and optionally `{{file_content}}`

## Development

Run checks after code changes:

```bash
ruff check src tests --fix
mypy src tests
python -m pytest
```

Run focused tests while developing:

```bash
python -m pytest tests/unit/
python -m pytest tests/integration/
python -m pytest tests/regression/
python -m pytest tests/unit/test_executor.py::test_name -v
```

The test suite uses `FakeSubscription` from `tests/conftest.py`, so tests do not require real Claude Code or Codex CLI access.
