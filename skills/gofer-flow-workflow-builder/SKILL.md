---
name: gofer-flow-workflow-builder
description: Create, modify, validate, and dry-run Gofer Flow workflows from a user's natural-language request using the Gofer Flow CLI and TOML workflow format. Use when an agent needs to design an end-to-end Gofer Flow workflow with command, script, first-class file I/O, prompt-file, local-search, common LLM task, open-resource, or Codex/Claude Code agent nodes; configure agents, prompts, skills, edges, schedules, file/folder watchers, retries, recursive loops, fan-out, and validation; or translate an automation request into a runnable `gof workflow` file.
---

# Gofer Flow Workflow Builder

Use this skill to turn a user's automation request into a real Gofer Flow workflow. Prefer non-interactive CLI commands for creation, discovery, mutation, validation, preview, and dry runs. Edit TOML directly only when the CLI does not expose the required setting. The interactive builder is useful for humans but is inefficient for coding agents.

If the surrounding assistant prompt provides a "Gofer Flow CLI" executable path, use that exact path for every CLI command instead of bare `gof`. This avoids PATH and sandbox differences in packaged desktop installs. In examples below, replace `gof` with the provided executable path when one is available.

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
   - `gof workflow set-info <workflow> --run-continuously` to keep exactly one run active; this overrides schedule/watch starts until `--no-run-continuously` or the UI stop button turns it off.
   - `gof workflow set-schedule <workflow> --cron "0 9 * * 1-5" --timezone UTC`
   - `gof workflow set-watch <workflow> --path <path> --glob "*" --mode fanout`
   - `gof workflow add-agent <workflow> --id <agent-id> --subscription codex --working-dir . --prompt-path prompts/agent.md`
   - `gof workflow add-node <workflow> --id <node-id> --type <node-type> ...`
   - Use `gof workflow add-node ... --allow-failure` when a node is expected to fail and should route through `on_failure` edges without failing the overall workflow.
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
- Prefer explicit node inputs over raw piping. Use `gof workflow add-node ... --input stdin=previous.text`, `--input env.FILE_PATH=loop.current.file_path`, or prompt variables like `--input file_path=source.data.file_path` so child nodes can access parent outputs without parsing JSON.
- Use `pipe_output = true` only for simple legacy stdin flows where the whole predecessor text output is the desired input.
- Prefer explicit edges. Use conditions only when the user asks for branching or failure handling.
- For recursive workflows, prefer a `loop` node plus a `break` node. Set a sensible `[workflow].max_total_node_runs` value and ensure loop exit edges are based on `output_matches`, `on_success`, or `on_failure`.
- Use existing scripts/prompts when present. Create prompt files only when needed.
- Use `prompt_file` nodes when a workflow should generate or refresh reusable prompt files from templates and variables.
- Use `common_llm_task` nodes for standard review/summarize/explain/extract/rewrite/classify work instead of creating a bespoke prompt file.
- Use `local_vectorize` followed by `local_search` when a workflow needs offline local search over files before an agent step.
- Use dashboard CLI commands and `dashboard_item` nodes when workflows need durable, human-editable structured state. Do not manually edit dashboard JSON files unless there is no CLI/API alternative.
- Use `skill_name` on an `agent` node when the user wants to invoke a Codex/Claude Code skill directly. The agent prompt becomes `/skill_name`, so `prompt_path` can be omitted on that node.
- Use `--memory run` when an agent node should keep a continuous conversation only within one workflow run. Use `--memory all` when it should remember prior executions across future workflow runs. Leave the default `--memory none` for independent calls.
- Never require real LLM provider CLIs in tests; validate with `--dry-run`.

## Preferred CLI Recipes

For "watch this folder and summarize files that are added or changed" requests, use the built-in recipe first. Do not scan the whole watched directory. The watcher provides the changed file events, and a loop node iterates over only those events before calling the agent.

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
- A `loop` node with `source = { type = "trigger_events", include_content = true }`.
- An agent node connected after the loop.
- A prompt that receives `{{kind}}`, `{{path}}`, `{{name}}`, and `{{file_content}}`.

For custom watched workflows, compose the same behavior with lower-level commands:

```bash
gof workflow create --name "Custom Watcher"
gof workflow set-watch custom-watcher --path /path/to/folder --glob "*.md" --mode fanout
gof workflow add-agent custom-watcher --id summarizer --subscription codex --working-dir . --prompt-path prompts/summarizer.md
gof workflow add-node custom-watcher \
  --id changed-files \
  --type loop \
  --fan-source trigger-events \
  --fan-include-content \
  --fan-max-concurrency 4
gof workflow add-node custom-watcher \
  --id summarize-added-files \
  --type agent \
  --agent-id summarizer \
  --prompt-path prompts/summarizer.md \
  --working-dir .
gof workflow add-edge custom-watcher --from changed-files --to summarize-added-files
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
memory = "none" # none, run, or all

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

Continuous run:

```toml
[workflow]
run_continuously = true
```

Continuous workflows ignore schedule and watcher starts while enabled. They keep
one active run alive, do not allow concurrent runs, and stop only when the user
requests stop, which also disables `run_continuously`.

Watcher mode guidance:

- `batch`: one workflow run receives all changed files in `trigger.events`.
- `queue`: one workflow run per changed file; each run gets one event in `trigger.event` and `trigger.events[0]`.
- `fanout`: one workflow run receives all changed files and should usually use a `loop` node with `source = { type = "trigger_events" }` before the agent node.

## Dashboards

Dashboards are durable local JSON artifacts under the Gofer data directory and are meant to be changed through `gof dashboard` commands or the UI. They contain sections, components, schemas, views, and JSON-backed items. Component IDs are the stable references workflows should use.

Useful commands:

```bash
gof dashboard list
gof dashboard create "Dev Dashboard"
gof dashboard section add "Dev Dashboard" "Ticket Board"
gof dashboard component add-board "Dev Dashboard" "Ticket Board" "Tickets"
gof dashboard component schema set "Dev Dashboard" tickets '{"title":"string","status":{"type":"enum","values":["backlog","todo","in_progress","completed"]}}'
gof dashboard component views set "Dev Dashboard" tickets '[{"title":"Backlog","filter":{"field":"status","operator":"equals","value":"backlog"}}]'
gof dashboard item add "Dev Dashboard" tickets '{"title":"Review ticket","status":"backlog"}'
gof dashboard item list "Dev Dashboard" tickets --filter 'status=backlog' --json
gof dashboard item update "Dev Dashboard" tickets <item-id> '{"status":"in_progress"}'
gof dashboard item move "Dev Dashboard" tickets <item-id> completed
gof dashboard item delete "Dev Dashboard" tickets <item-id>
```

Use the workflow CLI when adding dashboard nodes for users:

```bash
gof workflow add-node review.toml --id read-backlog --type dashboard_item --dashboard "Dev Dashboard" --component tickets --dashboard-action read --filter 'status=backlog'
gof workflow add-node review.toml --id complete-ticket --type dashboard_item --dashboard "Dev Dashboard" --component tickets --dashboard-action move --item-id '{{read-backlog.items.0.id}}' --field status --value-json '"completed"'
```

Workflow nodes can read and mutate dashboard component items:

```toml
[[nodes]]
id = "read-backlog"
type = "dashboard_item"
action = "read"
dashboard = "Dev Dashboard"
component = "tickets"
filter = "status=backlog"

[[nodes]]
id = "complete-ticket"
type = "dashboard_item"
action = "move"
dashboard = "Dev Dashboard"
component = "tickets"
item_id = "{{read-backlog.items.0.id}}"
field = "status"
value = "completed"
```

`read` returns matching JSON items in `items`, `value`, and `data.items`. `add`, `update`, `delete`, and `move` return the affected item in `value` and `data.item`.

Agent nodes can also write structured dashboard updates when the workflow declares the allowed target:

```toml
[[nodes]]
id = "review-ticket"
type = "agent"
agent_id = "reviewer"
working_dir = "."
prompt_path = "prompts/review.md"

[[nodes.dashboard_updates]]
action = "add"
dashboard = "Dev Dashboard"
component = "tickets"
source = "data.dashboard_update"
```

The agent should emit JSON such as `{"dashboard_update":{"item":{"title":"Reviewed","status":"completed"}}}`. Keep dashboard/component targets in workflow config so agent output cannot freely choose arbitrary local dashboard state.

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

`file` and `folder`:

Use these when the workflow needs to pass a local file or folder path as data without reading,
copying, moving, deleting, or opening it. The node output is the configured path string.

```toml
[[nodes]]
id = "source-file"
type = "file"
path = "data/input.txt"
pipe_output = true

[[nodes]]
id = "source-folder"
type = "folder"
path = "data"
pipe_output = true
```

CLI examples:

```bash
gof workflow add-node my-flow --id source-file --type file --path data/input.txt --pipe-output
gof workflow add-node my-flow --id source-folder --type folder --path data --pipe-output
```

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
memory = "run" # none, run, or all
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
memory = "none"
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

Supported conditions: `always`, `on_success`, `on_failure`, `output_matches`, `after_loop`.

## Loop Nodes

Use loop nodes when the user asks to run work for N items, rows, files, watcher events, or indefinitely until a `break` node is reached. Agent nodes do not own fan-out; connect `loop -> child node(s)` and use loop variables in downstream prompts or input mappings. A loop runs the full child chain for one item before starting the next item. For example, `LOOP -> A -> B` runs `A0, B0, A1, B1` until the loop runs out of inputs or a `break` node fires. If a node should run once after the loop finishes, connect it from the loop node with `condition = "after_loop"`.

Fixed count:

```toml
[[nodes]]
id = "research-loop"
type = "loop"
source = { type = "count", count = 5 }

[[nodes]]
id = "research"
type = "agent"
agent_id = "researcher"
prompt_path = "prompts/researcher.md"
working_dir = "."

[[edges]]
from = "research-loop"
to = "research"

[[edges]]
from = "research-loop"
to = "summarize-results"
condition = "after_loop"
```

Tabular rows:

```toml
source = { type = "tabular", path = "data/topics.csv" }
```

Directory files:

```toml
source = { type = "directory", path = "docs", glob = "*.md", include_content = true }
```

File watcher trigger events:

```toml
source = { type = "trigger_events", include_content = true }
```

Indefinite loop until `break`:

```toml
source = { type = "infinite" }
```

Loop variables are available to downstream agent prompts and input mappings as `loop.*`. Prefer `loop.current.*` in explicit node inputs, such as `--input env.FILE_PATH=loop.current.file_path` for shell nodes or `--input file_path=loop.current.file_path` for agent/prompt variables. Loop fields are also merged into agent template context directly, so a directory loop can use `{{file_path}}`, `{{file_name}}`, and `{{file_content}}`. If the loop node has `pipe_output = true`, direct loop child nodes receive the current loop item as JSON on stdin or `_piped_input`, not the full loop item list.

Common node output contract:

- `node-id.text`: the obvious primary text output.
- `node-id.success`: whether the node succeeded.
- `node-id.data.*`: structured fields such as:
  - command/script: `stdout`, `stderr`, `command`, `script_path`
  - file-like nodes: `file_path`, `file_name`, `file_stem`, `file_extension`, `parent_path`, `directory`, `content`
  - folder nodes: `folder_path`, `folder_name`, `parent_path`, `directory`
  - copy/move/delete: `source_path`, `destination_path`, `destination_directory`, `trash_path`, `deleted`
  - loop nodes: `source_type`, `source_path`, `glob`, `count`, `max_concurrency`
  - agent/common LLM task: `message`, `agent_id`, `thoughts`
  - local search/vectorize: `results`, `index_path`, `query`, `file_count`, `chunk_count`
- `node-id.items`: list outputs from loop/search style nodes.
- `previous.text`: primary text output from the direct upstream node.
- `loop.current.*`: current loop item fields such as `index`, `file_path`, `file_name`, `file_stem`, `file_extension`, `directory`, `parent_path`, `file_content`, `_row`, `event_json`, `kind`, `size`, and `mtime_ns`.
- For agent nodes, prefer explicit `--input` mappings when a prompt template controls context. If any explicit node input is configured, Gofer Flow does not automatically prepend the full loop item JSON or merge every loop field into the prompt context.
- Bash/script children of loop nodes also receive scalar loop fields as uppercase environment variables, such as `$FILE_PATH`, `$FILE_NAME`, `$FILE_STEM`, `$FILE_EXTENSION`, `$DIRECTORY`, and `$INDEX`.

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
