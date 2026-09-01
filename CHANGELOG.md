# Changelog

This file records the major user-facing changes in Taskurotta. Releases through
version 0.1.3 used the Gofer Flow name.

## Unreleased

### Added

- Introduced Radish as the workflow authoring language, with a formal grammar,
  lexer, parser, compiler, formatter, semantic validation, diagnostics, and a
  versioned JSON intermediate representation.
- Added machine-readable contracts for providers and every supported Radish
  node, plus conformance fixtures and schemas for ASTs, compiled workflows,
  run records, diagnostics, metadata, and workspace registries.
- Added Radish runtime support for local bindings, interpolation, structured
  outputs, explicit routing, cycles, joins, retries, timeouts, cancellation,
  public workflow interfaces, and nested workflow execution.
- Added project-based workflow storage under `.taskurotta`, portable workflow
  bundles, metadata files, ignore rules, project labels, and workflow discovery.
- Added a Monaco code workspace with Radish diagnostics, graph and code view
  switching, file tabs, project file management, and native file explorer
  actions.
- Brought graph editing, node inspection, workflow settings, approvals, run
  controls, and timeline inspection to Radish workflows.
- Added an integrated terminal, browser, and problems panel, with project-scoped
  terminal groups, browser previews, and configurable keyboard shortcuts.
- Added Git status decorations, deleted-file visibility, commit history, diff
  previews, file preview tabs, split editors, and rendered previews for Markdown,
  HTML, SVG, images, and PDFs.
- Added persistent application settings for appearance, editor behavior, terminal
  behavior, audio devices, data storage, motion, and command keybindings.
- Added assistant file and image attachments, pasted screenshots, local voice
  transcription, GitHub-flavored Markdown, interactive file links, and code-copy
  controls.
- Added reviewable assistant change summaries with live file diffs, shell and edit
  traces, elapsed time, and guarded undo and redo actions.
- Added crash recovery screens with reload, reset, diagnostic copy, and issue
  reporting actions.
- Added `gof radish docs` and bundled the Radish authoring documentation, schemas,
  contracts, and workflow-builder skill in packaged installs.

### Changed

- Renamed the user-facing application from Gofer Flow to Taskurotta.
- Made Radish source files the editable workflow definition while compiled IR
  and run artifacts remain internal implementation details.
- Moved workflow organization from a global workspace model to project folders.
- Discover and register existing Radish workflows when a project opens, including
  projects that do not yet contain a workflow.
- Store compiled artifacts, run logs, and agent memory inside each registered
  workflow directory, with migration from the previous application-data layout.
- Scope assistant threads and file access to their selected project, while keeping
  Code project selection independent from Graph workflow selection.
- Changed the project license from Apache-2.0 to AGPL-3.0-only and updated release
  metadata and repository links.

### Fixed

- Hardened Radish parsing, lowering, contract validation, activation lineage,
  cyclic execution, output resolution, and interpolation behavior.
- Fixed workflow switching, editor saving, graph refresh, node inspector focus,
  type changes, approval rendering, and runtime error reporting in the studio.
- Prevented cancelled frontend requests from producing noisy backend broken-pipe
  tracebacks.
- Fixed dirty Radish edits, stale live-analysis responses, duplicate file tab
  labels, Markdown file navigation, and project-aware editor tab persistence.
- Fixed terminal lifecycle, grouping, clipboard shortcuts, and late session cleanup.

## 0.1.3 - 2026-06-30

### Added

- Added typed workflow parameters, webhook triggers, provider profiles, direct
  API providers, revision history, workflow bundles, and queued runners.
- Added workflow validation with diagnostics and suggested fixes across the CLI
  and desktop app.
- Added resume, rerun, checkpoint, cached-output, and run-history controls.
- Added workflow call nodes with nested execution, validation, planner details,
  and child-run status reporting.
- Expanded the graph editor with undo and redo, canvas groups, node and edge
  editing, grouped input selection, and workflow navigation.
- Added browser-level workflow studio tests and dedicated frontend checks.

### Fixed

- Reduced persisted run data by moving or compacting large prompt, thought,
  input, snapshot, and checkpoint payloads.
- Isolated agent memory between loop items and preserved final outputs when log
  and thought content was truncated.
- Fixed Linux and Windows release builds, frontend test configuration, recursive
  tests, and package version synchronization.
- Improved path-grant checks, toolbar behavior, group opacity persistence, and
  workflow target editing.

## 0.1.2 - 2026-06-25

### Added

- Expanded execution with loops, fan-out controls, concurrent branches,
  start/pass/fail behavior, break handling, run limits, retries, and structured
  node outputs.
- Added file and folder operations, HTTP requests, notifications, approval
  gates, local search and vectorization, prompt files, and common LLM tasks.
- Added agent memory, context compaction, thought streaming, workflow assistant
  threads, and persistent assistant context.
- Expanded CLI workflow editing, planning, health checks, triggers, watches,
  approvals, branch configuration, and provider diagnostics.
- Added secure desktop path grants, file selection and editing, backend failure
  handling, update support, and improved workflow run inspection.

### Fixed

- Improved process-tree termination for stopped and timed-out nodes.
- Fixed agent output preservation, thought truncation, loop execution, node I/O,
  invalid workflow display, and packaged provider CLI execution.
- Made notification and approval failures visible instead of silently ignoring
  them.
- Fixed the frontend test command used by the release.

## 0.1.1 - 2026-06-20

### Added

- Added the original TOML workflow engine with conditional routes, recursive
  execution, concurrent nodes, retries, timeouts, and structured fan-out.
- Added named agents and workflows, background scheduling, file watchers, an
  interactive workflow builder, a terminal editor, and graph rendering.
- Added the React workflow studio and Electron desktop application with workflow
  creation, graph editing, run logs, node status, and assistant chat.
- Added Claude Code and Codex integrations, agent memory, thought capture, and
  workflow assistant tooling.
- Added file and folder resources, local file operations, HTTP and LLM utility
  nodes, workflow import controls, and desktop file management.
- Added standalone CLI and desktop packaging for Linux, Windows, and macOS.

### Fixed

- Kept empty or invalid workflow files visible so they could be repaired.
- Fixed workflow deletion cleanup, run stopping, assistant state, prompt-file
  selection, agent input handling, loop outputs, and node status updates.
- Improved desktop backend IPC, update checks, release packaging, and workflow
  data isolation in tests.
