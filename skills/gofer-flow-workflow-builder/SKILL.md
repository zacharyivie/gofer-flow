---
name: gofer-flow-workflow-builder
description: Create, modify, validate, and dry-run Gofer Flow workflows from a user's natural-language request using the Gofer Flow CLI and TOML workflow format. Use when an agent needs to design an end-to-end Gofer Flow workflow with command, script, first-class file I/O, prompt-file, local-search, common LLM task, open-resource, or Codex/Claude Code agent nodes; configure agents, prompts, skills, edges, schedules, file/folder watchers, retries, recursive loops, fan-out, and validation; or translate an automation request into a runnable `gof workflow` file.
---

# Gofer Flow Workflow Builder

Use this skill to turn a user's automation request into a real Gofer Flow workflow. Prefer non-interactive CLI commands for creation, discovery, mutation, validation, preview, and dry runs. Edit TOML directly only when the CLI does not expose the required setting. The interactive builder is useful for humans but is inefficient for coding agents.

## Workflow

1. Clarify only what is necessary: manual trigger, cron schedule, file/folder watcher, required inputs, expected output, whether real execution is allowed, and whether agent nodes should use `codex` or `claude_code`.
2. Inspect existing assets:
   - `gof workflow list`
   - `gof agent list`
   - `gof workflow show <id>` for relevant existing workflows
3. Create a scaffold:
   - `gof workflow create --name "<Workflow Name>"`
   - Use `--data-dir <path>` only when the user or tests require an isolated data directory.
4. Configure the workflow with non-interactive CLI commands whenever possible:
   - `gof workflow set-info <workflow> --name "<Label>" --max-total-node-runs 100`
   - `gof workflow set-schedule <workflow> --cron "0 9 * * 1-5" --timezone UTC`
   - `gof workflow set-watch <workflow> --path <path> --glob "*" --mode fanout`
   - `gof workflow add-agent <workflow> --id <agent-id> --subscription codex --working-dir . --prompt-path prompts/agent.md`
   - `gof workflow add-node <workflow> --id <node-id> --type <node-type> ...`
   - `gof workflow add-edge <workflow> --from <from-node> --to <to-node> --condition on_success`
   - `gof workflow import <path/to/workflow.toml>` when the user provides a TOML file.
5. Edit TOML directly only for unsupported fields, then validate immediately.
6. Validate and preview:
   - `gof workflow validate <workflow-id-or-path>`
   - `gof workflow show <workflow-id-or-path>`
   - `gof workflow run <workflow-id-or-path> --dry-run`
7. Do not run without `--dry-run` unless the user explicitly authorizes real execution.

## Design Rules

- Build a graph with clear node IDs in lowercase kebab-case or snake_case. Cycles and self-edges are supported for bounded recursive workflows.
- Keep node boundaries meaningful: one command/script/agent responsibility per node.
- Use `pipe_output = true` when downstream nodes should receive predecessor output on stdin or agent prompt context.
- Prefer explicit edges. Use conditions only when the user asks for branching or failure handling.
- For recursive workflows, set a sensible `[workflow].max_total_node_runs` value and ensure loop exit edges are based on `output_matches`, `on_success`, or `on_failure`.
- Use existing scripts/prompts when present. Create prompt files only when needed.
- Use `prompt_file` nodes when a workflow should generate or refresh reusable prompt files from templates and variables.
- Use `common_llm_task` nodes for standard review/summarize/explain/extract/rewrite/classify work instead of creating a bespoke prompt file.
- Use `local_vectorize` followed by `local_search` when a workflow needs offline local search over files before an agent step.
- Use `skill_name` on an `agent` node when the user wants to invoke a Codex/Claude Code skill directly. The agent prompt becomes `/skill_name`, so `prompt_path` can be omitted on that node.
- Never require real LLM provider CLIs in tests; validate with `--dry-run`.

## Preferred CLI Recipes

For "watch this folder and summarize files that are added or changed" requests, use the built-in recipe first. Do not scan the whole watched directory. The watcher provides the changed file events, and the agent node fans out over only those events.

```bash
gof workflow recipe watch-folder-summarize \
  --name "Summarize New Files" \
  --watch-path /path/to/folder \
  --glob "*" \
  --provider codex \
  --working-dir . \
  --max-concurrency 4
```

This creates:

- `[workflow.watch]` with `mode = "fanout"`.
- A `summarizer` agent using the selected provider.
- An agent node with `fan_source = { type = "trigger_events", include_content = true }`.
- A prompt that receives `{{kind}}`, `{{path}}`, `{{name}}`, and `{{file_content}}`.

For custom watched workflows, compose the same behavior with lower-level commands:

```bash
gof workflow create --name "Custom Watcher"
gof workflow set-watch custom-watcher --path /path/to/folder --glob "*.md" --mode fanout
gof workflow add-agent custom-watcher --id summarizer --subscription codex --working-dir . --prompt-path prompts/summarizer.md
gof workflow add-node custom-watcher \
  --id summarize-added-files \
  --type agent \
  --agent-id summarizer \
  --prompt-path prompts/summarizer.md \
  --working-dir . \
  --fan-source trigger-events \
  --fan-include-content \
  --fan-max-concurrency 4
```

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

File/folder watcher:

```toml
[workflow.watch]
path = "inputs"
glob = "*.txt"
recursive = false
debounce_seconds = 1.0
mode = "batch" # batch, queue, or fanout
max_concurrency = 1
```

Watcher mode guidance:

- `batch`: one workflow run receives all changed files in `trigger.events`.
- `queue`: one workflow run per changed file; each run gets one event in `trigger.event` and `trigger.events[0]`.
- `fanout`: one workflow run receives all changed files and should usually use `fan_source = { type = "trigger_events" }` on an agent node.

Recursive safety:

```toml
[workflow]
id = "review-loop"
name = "Review Loop"
max_total_node_runs = 100
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

`read_file`:

```toml
[[nodes]]
id = "read-input"
type = "read_file"
path = "data/input.txt"
encoding = "utf-8"
errors = "strict"
pipe_output = true
```

`write_file`:

```toml
[[nodes]]
id = "write-summary"
type = "write_file"
path = "data/summary.txt"
content = ""
encoding = "utf-8"
create_dirs = true
overwrite = true
append = false
```

Leave `content = ""` and use `pipe_output = true` on the predecessor when the node should write upstream output.

`copy_file`:

```toml
[[nodes]]
id = "copy-report"
type = "copy_file"
source_path = "data/report.txt"
destination_path = "archive/report.txt"
create_dirs = true
overwrite = false
```

`move_file`:

```toml
[[nodes]]
id = "archive-report"
type = "move_file"
source_path = "data/report.txt"
destination_path = "archive/report.txt"
create_dirs = true
overwrite = false
```

`delete_file`:

```toml
[[nodes]]
id = "delete-temp"
type = "delete_file"
path = "tmp/work.txt"
use_trash = true
recursive = false
missing_ok = false
```

Prefer `use_trash = true` unless the user explicitly requests permanent deletion.

`open_resource`:

```toml
[[nodes]]
id = "open-report"
type = "open_resource"
target = "data/summary.txt"
resource_type = "auto" # auto, file, folder, url, app
args = []
```

`prompt_file`:

```toml
[[nodes]]
id = "make-review-prompt"
type = "prompt_file"
output_path = "prompts/reviewer.md"
template = "Review this context:\n\n{{_piped_input}}\n\nFocus on {{focus}}."
variables = { focus = "security and correctness" }
encoding = "utf-8"
create_dirs = true
overwrite = true
```

Use `template_path = "templates/reviewer.md"` instead of inline `template` when the template is a file.

`common_llm_task`:

```toml
[[nodes]]
id = "summarize"
type = "common_llm_task"
agent_id = "summarizer"
task = "summarize" # review, summarize, explain, extract, rewrite, classify
target = "README.md"
instructions = "Focus on setup steps and assumptions."
working_dir = "."
input_mapping = {}
```

`local_vectorize` and `local_search`:

```toml
[[nodes]]
id = "index-docs"
type = "local_vectorize"
source_path = "docs"
index_path = "indexes/docs.json"
glob = "**/*"
recursive = true
chunk_size = 1200
chunk_overlap = 120
encoding = "utf-8"

[[nodes]]
id = "search-docs"
type = "local_search"
index_path = "indexes/docs.json"
query = "workflow file watcher fanout"
top_k = 5
pipe_output = true
```

Local search is dependency-free and runs offline. It produces JSON search results that can be piped into an agent node.

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

Skill invocation agent node:

```toml
[[nodes]]
id = "use-workflow-builder-skill"
type = "agent"
agent_id = "builder"
working_dir = "."
skill_name = "gofer-flow-workflow-builder"
```

This sends `/gofer-flow-workflow-builder` to the configured Codex or Claude Code agent. Omit `prompt_path` on the node when using `skill_name`.

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

File watcher trigger events:

```toml
fan_source = { type = "trigger_events", include_content = true, max_concurrency = 4, fail_fast = false }
```

Trigger context variables:

- `trigger.events_json`: JSON array of all changed file events.
- `trigger.events.0.path`: path of the first changed file.
- `trigger.event.path`: path of the current single event in `queue` mode.
- Each event has `kind`, `path`, `name`, `directory`, `size`, and `mtime_ns`.

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

Useful operational commands:

```bash
gof workflow logs list <workflow-id-or-path>
gof workflow logs latest <workflow-id-or-path>
gof workflow logs show <workflow-id-or-path> <run-log-id>
gof workflow stop <workflow-id-or-path>
gof workflow rm <workflow-id-or-path> --yes
```

`gof workflow rm` removes the workflow TOML plus associated logs, chat handoff state, and stop marker state.

## Execution Safety

- Use `--dry-run` by default.
- Ask before running commands that mutate the repository, call external services, send notifications, deploy, trade, delete files, or invoke real LLM provider CLIs.
- If the user requested real execution, run `gof workflow run <workflow-id-or-path>` only after validation and preview pass.
