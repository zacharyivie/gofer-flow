---
name: gofer-flow-workflow-builder
description: Create, modify, validate, and dry-run Gofer Flow DAG workflows from a user's natural-language request using the Gofer Flow CLI and TOML workflow format. Use when an agent needs to design an end-to-end Gofer Flow workflow with bash, Python, shell, or Codex/Claude Code agent nodes; configure agents, prompts, edges, schedules, retries, fan-out, and validation; or translate an automation request into a runnable `gof workflow` file.
---

# Gofer Flow Workflow Builder

Use this skill to turn a user's automation request into a real Gofer Flow workflow. Prefer CLI commands for creation, discovery, validation, preview, and dry runs. Edit TOML directly when constructing the workflow body; the interactive builder is useful for humans but is inefficient for coding agents.

## Workflow

1. Clarify only what is necessary: trigger/schedule, required inputs, expected output, whether real execution is allowed, and whether agent nodes should use `codex` or `claude_code`.
2. Inspect existing assets:
   - `gof workflow list`
   - `gof agent list`
   - `gof workflow show <id>` for relevant existing workflows
3. Create a scaffold:
   - `gof workflow create --name "<Workflow Name>"`
   - Use `--data-dir <path>` only when the user or tests require an isolated data directory.
4. Locate the generated TOML in the Gofer data directory shown by project docs or CLI output.
5. Edit the TOML to add workflow metadata, agents, nodes, edges, optional schedule, retries, timeouts, fan-out, and input mappings.
6. Validate and preview:
   - `gof workflow validate <workflow-id-or-path>`
   - `gof workflow show <workflow-id-or-path>`
   - `gof workflow run <workflow-id-or-path> --dry-run`
7. Do not run without `--dry-run` unless the user explicitly authorizes real execution.

## Design Rules

- Build a DAG with clear node IDs in lowercase kebab-case or snake_case.
- Keep node boundaries meaningful: one command/script/agent responsibility per node.
- Use `pipe_output = true` when downstream nodes should receive predecessor output on stdin or agent prompt context.
- Prefer explicit edges. Use conditions only when the user asks for branching or failure handling.
- Validate cycles early; Gofer rejects cyclic edges.
- Use existing scripts/prompts when present. Create prompt files only when needed.
- Never require real LLM provider CLIs in tests; validate with `--dry-run`.

## TOML Shape

Minimal workflow:

```toml
[workflow]
id = "daily-review"
name = "Daily Review"

[[nodes]]
id = "collect"
type = "bash_command"
command = "git diff --stat"
pipe_output = true

[agents.reviewer]
subscription = "codex"
working_dir = "."
prompt_path = "prompts/reviewer.md"
tools = []
mcp_servers = []
env = {}

[[nodes]]
id = "review"
type = "agent"
agent_id = "reviewer"
prompt_path = "prompts/reviewer.md"
working_dir = "."

[[edges]]
from = "collect"
to = "review"
condition = "on_success"
```

Schedule:

```toml
[workflow.schedule]
cron_expression = "0 9 * * 1-5"
timezone = "UTC"
```

Agent config:

```toml
[agents.reviewer]
subscription = "codex" # or "claude_code"
working_dir = "."
prompt_path = "prompts/reviewer.md"
tools = ["Read", "Bash"]
mcp_servers = []
env = {}
```

## Node Types

`bash_command`:

```toml
[[nodes]]
id = "collect"
type = "bash_command"
command = "git status --short"
working_dir = "."
env = { MODE = "summary" }
pipe_output = true
retry_count = 1
retry_delay_seconds = 2
timeout_seconds = 60
```

`python_script`:

```toml
[[nodes]]
id = "transform"
type = "python_script"
script_path = "scripts/transform.py"
args = ["--format", "json"]
env = {}
```

`shell_script`:

```toml
[[nodes]]
id = "package"
type = "shell_script"
script_path = "scripts/package.sh"
args = ["--release"]
env = {}
```

`agent`:

```toml
[agents.reviewer]
subscription = "claude_code"
working_dir = "."
prompt_path = "prompts/reviewer.md"
tools = []
mcp_servers = []
env = {}

[[nodes]]
id = "review"
type = "agent"
agent_id = "reviewer"
prompt_path = "prompts/reviewer.md"
working_dir = "."
dynamic_count = 1
input_mapping = { diff = "collect.output" }
```

## Edges

Default edge:

```toml
[[edges]]
from = "collect"
to = "review"
```

Conditional edges:

```toml
[[edges]]
from = "test"
to = "fix"
condition = "on_failure"

[[edges]]
from = "scan"
to = "notify"
condition = "output_matches"
output_pattern = "CRITICAL|HIGH"
```

Supported conditions: `always`, `on_success`, `on_failure`, `output_matches`.

## Fan-Out

Use fan-out on agent nodes when the user asks to run work for N items, rows, or files.

Fixed count:

```toml
[[nodes]]
id = "research"
type = "agent"
agent_id = "researcher"
prompt_path = "prompts/researcher.md"
working_dir = "."
fan_source = { type = "count", count = 5, max_concurrency = 3, fail_fast = false }
```

Tabular rows:

```toml
fan_source = { type = "tabular", path = "data/topics.csv", max_concurrency = 8, fail_fast = false }
```

Directory files:

```toml
fan_source = { type = "directory", path = "docs", glob = "*.md", include_content = true, max_concurrency = 8, fail_fast = false }
```

## Prompt Files

Create prompt files under the managed data directory `prompts/` or a project-local prompt path if the workflow references project files. Prompts can reference context variables such as:

```md
Review this command output:

{{collect.output}}

Mapped input:

{{diff}}
```

Use `input_mapping` to give named prompt variables to an agent node:

```toml
input_mapping = { diff = "collect.output", tests = "test.output" }
```

## CLI Verification

Run these before finishing:

```bash
gof workflow validate <workflow-id-or-path>
gof workflow show <workflow-id-or-path>
gof workflow run <workflow-id-or-path> --dry-run
```

If validation fails, fix the TOML and repeat. If dry-run succeeds, report the workflow ID/path, node list, edge list, agent subscriptions, schedule, and any assumptions.

## Execution Safety

- Use `--dry-run` by default.
- Ask before running commands that mutate the repository, call external services, send notifications, deploy, trade, delete files, or invoke real LLM provider CLIs.
- If the user requested real execution, run `gof workflow run <workflow-id-or-path>` only after validation and preview pass.
