# Radish 1 specification

This directory contains the normative source-language definition for Radish 1. Planning
documents explain design history and proposals. When the two disagree, an accepted rule
in this directory controls the compiler.

The specification is still a review draft. Files mark unresolved contract decisions where
the current runtime cannot be translated mechanically.

## Documents

- [lexical-spec.md](lexical-spec.md) defines source encoding, layout, comments, tokens,
  strings, identifiers, numbers, durations, and embedded JSON.
- [grammar.ebnf](grammar.ebnf) defines document, declaration, value, route, binding, and
  predicate syntax.
- [static-semantics.md](static-semantics.md) defines symbol resolution, types, contracts,
  defaults, references, bindings, routes, paths, and compile-time diagnostics.
- [node-contracts.md](node-contracts.md) records the Radish names for every current
  executable node type and maps their fields into the new language.
- [output-contracts.md](output-contracts.md) defines node completion fields, the Radish
  JSON Schema profile, binding compatibility, and public workflow interfaces.
- [lowering.md](lowering.md) defines the exact transformation from a valid semantic AST
  to version 1 JSON IR.
- [diagnostics.md](diagnostics.md) defines stable diagnostic codes and their machine
  representation.
- [editor-protocol.md](editor-protocol.md) defines recovering document analysis, partial
  graph projection, metadata, and revision-checked Studio saves.

The first machine-readable artifacts now live beside the specification:

- [`../schemas/ast.schema.json`](../schemas/ast.schema.json) defines the source-faithful
  strict-parser AST.
- [`../schemas/node-contract.schema.json`](../schemas/node-contract.schema.json) defines
  the common contract format for built-in and future plugin nodes.
- [`../schemas/ir.schema.json`](../schemas/ir.schema.json) defines immutable executor input.
- [`../schemas/diagnostic.schema.json`](../schemas/diagnostic.schema.json) defines compiler,
  preflight, runtime, and export diagnostics.
- [`../schemas/run.schema.json`](../schemas/run.schema.json) defines persisted execution
  results and node-completion events.
- [`../schemas/workspace-registry.schema.json`](../schemas/workspace-registry.schema.json)
  defines persistent cross-project workflow discovery records.
- [`../schemas/workflow-metadata.schema.json`](../schemas/workflow-metadata.schema.json)
  defines versioned, non-execution Studio layout and editor state.
- [`../contracts/`](../contracts/) contains the first representative built-in contracts.

## Current command-line slice

```bash
gof radish create "Review PR" --project ./project-folder
gof radish list
gof radish check ./workflow.rad
gof radish format ./workflow.rad
gof radish compile ./workflow.rad
gof radish inspect-ir ./workflow.rad
gof radish preflight ./workflow.rad
gof radish run ./workflow.rad --input count=3
```

`create` allocates a globally unique static workflow ID, creates
`PROJECT/.taskurotta/ID/workflow.rad` with metadata and ignore defaults, compiles it, and
adds it to the application workflow registry. `list` reads that registry and groups
workflows by their outer project folder. Both accept `--format json`.

Both commands accept `--format json`. Exit status `0` means no error diagnostics. A
language or deployment-preflight error returns `1`. Source, artifact, or command-usage
failures return `2`. Warnings do not change a successful exit status.

`format` canonicalizes a grammatically valid source file and preserves comments. Use
`format --check` in CI or `format --stdout` to avoid changing the file. `compile` validates
and publishes IR only to Taskurotta's internal cache. `inspect-ir` prints that validated IR
for debugging and never creates a source-side IR file.

`check` compiles and caches valid IR internally. `preflight` uses that artifact but checks
the current machine on every invocation. `run` performs both steps, executes the IR, and
writes a versioned run artifact under the application data directory. None of these
commands writes IR beside the source.

`run --input NAME=JSON` accepts one declared workflow input per option. The run artifact
records input names, not supplied values. Exit status `0` means the workflow passed. A
preflight or workflow failure returns `1`. Invalid CLI input or invalid declared workflow
input returns `2`.

JSON output is one object with these required fields:

| Field | Value |
|---|---|
| `command` | `check` or `preflight` |
| `source` | Resolved source path |
| `ok` | `true` when no error diagnostic exists |
| `cache` | `null` before successful compilation, otherwise `hit` and `compilation_fingerprint` |
| `diagnostics` | Complete diagnostic objects conforming to `diagnostic.schema.json` |

Initial valid, invalid, and warning fixtures live in
[`../conformance/`](../conformance/). They fix expected AST, IR, diagnostic codes, and
source spans before parser implementation begins.

## Authority boundaries

The grammar accepts the common shape of a node declaration. A versioned node contract
decides which operation fields are legal, required, optional, or mutually exclusive for a
given `type`. This split lets a future plugin add a node contract without changing the
Radish parser.

The compiler is the authority for acceptance. The editor, formatter, skill, and executor
must not maintain independent interpretations of the language.
