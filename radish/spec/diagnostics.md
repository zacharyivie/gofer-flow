# Radish 1 diagnostics

## Stability

Diagnostic codes are part of the Radish 1 tool contract. Wording may improve, but one code
must keep the same cause and severity throughout the language version. Tests assert code,
severity, phase, and source span rather than complete prose.

The machine format is [`../schemas/diagnostic.schema.json`](../schemas/diagnostic.schema.json).
Every diagnostic contains explicit empty arrays and objects for optional collections so
agent correction loops do not need to distinguish omission from emptiness.

Errors prevent IR publication. Warnings permit IR publication. Deployment-preflight
errors do not invalidate compiled IR, but they prevent a run in that environment.

## Lexer and parser codes

| Code | Severity | Meaning |
|---|---|---|
| `RADISH_INVALID_UTF8` | error | Source is not valid UTF-8. |
| `RADISH_INVALID_INDENTATION` | error | Indentation is odd, skips a level, or dedents to an inactive level. |
| `RADISH_INVALID_TOKEN` | error | No Radish token begins at the reported position. |
| `RADISH_UNTERMINATED_STRING` | error | A quoted or block string does not terminate correctly. |
| `RADISH_INVALID_JSON` | error | Embedded JSON is not strict JSON. |
| `RADISH_EXPECTED_TOKEN` | error | The parser expected a grammar token or production. |
| `RADISH_UNEXPECTED_DECLARATION` | error | A declaration is illegal at its document position. |
| `RADISH_UNSUPPORTED_VERSION` | error | The compiler does not support the declared Radish version. |

## Declaration and contract codes

| Code | Severity | Meaning |
|---|---|---|
| `RADISH_MISSING_WORKFLOW_NAME` | error | Workflow `name` is absent or empty. |
| `RADISH_DUPLICATE_IDENTIFIER` | error | Two declarations canonicalize to the same identifier. |
| `RADISH_DUPLICATE_FIELD` | error | A block repeats a field after case normalization. |
| `RADISH_UNKNOWN_FIELD` | error | The language or selected node contract does not declare a field. |
| `RADISH_MISSING_FIELD` | error | A required field is absent. |
| `RADISH_INVALID_FIELD_VALUE` | error | A field value violates its declared type or constraint. |
| `RADISH_MUTUALLY_EXCLUSIVE_FIELDS` | error | Source supplies fields that cannot appear together. |
| `RADISH_UNKNOWN_NODE_TYPE` | error | No compatible built-in or plugin contract matches the type. |
| `RADISH_COMPILER_CAPABILITY_MISSING` | error | A known contract requires a compiler resolution mode that this implementation does not yet support. |
| `RADISH_CONTRACT_INVALID` | error | A node contract fails its meta-schema or contract invariants. |
| `RADISH_PROVIDER_CONTRACT_UNRESOLVED` | error | A required provider contract is unavailable during compilation. |
| `RADISH_BLANK_AGENT_PROMPT` | warning | An Agent has neither meaningful inline prompt text nor a prompt path. |
| `RADISH_SUSPECTED_PLAINTEXT_SECRET` | warning | A credential-shaped field contains plaintext. The source remains legal. |
| `RADISH_PATH_OUTSIDE_PROJECT` | error | A filesystem path is absolute, traverses upward, or escapes the workflow root through an intermediate symlink. |

## Contract-authoring codes

These errors apply when Taskurotta loads built-in or plugin node contracts. They do not
point into a `.rad` file.

| Code | Severity | Meaning |
|---|---|---|
| `RADISH_CONTRACT_JSON_INVALID` | error | A contract file is not a UTF-8 JSON object. |
| `RADISH_CONTRACT_META_SCHEMA_INVALID` | error | The node-contract meta-schema is invalid. |
| `RADISH_CONTRACT_SCHEMA_INVALID` | error | An embedded configuration, input, or output schema is invalid. |
| `RADISH_CONTRACT_SCHEMA_PROFILE_UNSUPPORTED` | error | An input or output schema exceeds Radish Schema Profile 1. |
| `RADISH_CONTRACT_UNKNOWN_DEFAULT_FIELD` | error | A literal or computed default names no configuration field. |
| `RADISH_CONTRACT_DEFAULT_INVALID` | error | A literal default violates its configuration-field schema. |
| `RADISH_CONTRACT_OPTIONAL_FIELD_UNSPECIFIED` | error | An optional runtime field has neither a declared default nor `x-radish-allow-absence: true`. |
| `RADISH_CONTRACT_DUPLICATE_ENTRY` | error | A contract repeats a preflight or static-diagnostic identifier. |
| `RADISH_CONTRACT_DUPLICATE_IDENTITY` | error | Two loaded contracts claim the same node type and version. |

## References, schemas, and bindings

| Code | Severity | Meaning |
|---|---|---|
| `RADISH_UNRESOLVED_REFERENCE` | error | A reference does not resolve in its required namespace. |
| `RADISH_WRONG_REFERENCE_KIND` | error | A resolved symbol is illegal in the field's reference mode. |
| `RADISH_INVALID_JSON_SELECTOR` | error | A case-sensitive member or index does not exist in the source schema. |
| `RADISH_MISSING_INPUT` | error | A required destination input has no same-named binding, authored field, or contract default. |
| `RADISH_BINDING_DEFAULT_REQUIRED` | error | A possibly absent source has no explicit default. |
| `RADISH_BINDING_TYPE_MISMATCH` | error | The source or default schema is not assignable to the destination. |
| `RADISH_SCHEMA_INVALID` | error | A declared schema is not valid Draft 2020-12 JSON Schema. |
| `RADISH_SCHEMA_PROFILE_UNSUPPORTED` | error | A schema uses behavior outside Radish Schema Profile 1. |
| `RADISH_SCHEMA_REFERENCE_FORBIDDEN` | error | A schema contains a remote or project-escaping reference. |
| `RADISH_SCHEMA_REFERENCE_MISSING` | error | A project-local schema reference cannot be loaded. |
| `RADISH_OUTPUT_TYPE_MISMATCH` | error | A public output source is not assignable to its declared schema. |
| `RADISH_REFERENCE_ROOT_REMOVED` | error | Source uses a redundant `workflow.*` or ambiguous `loop.*` reference alias. |
| `RADISH_PROMPT_TEMPLATE_INVALID` | error | An inline prompt contains malformed or unbound placeholders. |
| `RADISH_TEMPLATE_INVALID` | error | A configuration template contains malformed or unbound placeholders. |
| `RADISH_TEMPLATE_TYPE_MISMATCH` | error | An exact-placeholder value is incompatible with its configuration field. |

## Routing, readiness, and terminals

| Code | Severity | Meaning |
|---|---|---|
| `RADISH_UNRESOLVED_NODE` | error | A route, requirement, or control field names an unknown node. |
| `RADISH_DUPLICATE_REQUIREMENT` | error | A `needs` block repeats one canonical node ID. |
| `RADISH_UNREACHABLE_REQUIREMENT` | error | A required node cannot participate in the same activation lineage. |
| `RADISH_INCOMPATIBLE_ACTIVATION_LINEAGE` | error | A producer and consumer can run only in disjoint loop lineages. |
| `RADISH_DUPLICATE_ROUTE` | error | Two routes have the same source, target, and condition. |
| `RADISH_CONTRADICTORY_ROUTE` | error | An unconditional and `otherwise` route contradict each other. |
| `RADISH_UNREACHABLE_FAILURE_ROUTE` | error | `when failed` appears on a node that cannot tolerate failure. |
| `RADISH_PREDICATE_TYPE_MISMATCH` | error | Predicate operands do not support the selected operator. |
| `RADISH_INVALID_REGEX` | error | The right side of `matches` is not a valid regular expression. |
| `RADISH_INVALID_START_ASSERTION` | error | `start: true` appears with `needs`. |
| `RADISH_INVALID_TERMINAL` | error | A terminal conflicts with routes or failure policy. |
| `RADISH_INVALID_BREAK_TARGET` | error | Break does not name a reachable Loop in its activation lineage. |
| `RADISH_INVALID_BREAK_ROUTE` | error | A Break node declares an outgoing route. |

## Workflow composition and lowering

| Code | Severity | Meaning |
|---|---|---|
| `RADISH_CHILD_WORKFLOW_UNRESOLVED` | error | The compiler cannot load the referenced public workflow interface. |
| `RADISH_CHILD_INTERFACE_VERSION_MISMATCH` | error | The requested child interface version is unavailable. |
| `RADISH_WORKFLOW_INTERFACE_VERSION_REQUIRED` | error | A referenced workflow does not declare an interface version. |
| `RADISH_WORKFLOW_RECURSION` | error | A workflow reference resolves back to a workflow already in the compilation stack. |
| `RADISH_WORKFLOW_PATH_INVALID` | error | A child path is not a project-contained `.rad` source path. |
| `RADISH_IR_INVALID` | error | Candidate IR fails its schema or semantic invariants. |
| `RADISH_ARTIFACT_IO_ERROR` | error | The tool cannot read source assets or atomically publish an internal compiled or run artifact. |

## Preflight, runtime, and export

| Code | Severity | Meaning |
|---|---|---|
| `RADISH_PREFLIGHT_CHECK_UNAVAILABLE` | error | IR requires a contract preflight check that this installation cannot execute. |
| `RADISH_PREFLIGHT_HANDLER_UNAVAILABLE` | error | IR references a node runtime handler that this installation cannot execute. |
| `RADISH_PREFLIGHT_CONFIGURATION_INVALID` | error | Deployment-specific configuration needed by a preflight check is invalid. |
| `RADISH_PREFLIGHT_RESOURCE_MISSING` | error | A required prompt, script, executable, directory, or plugin handler is missing. |
| `RADISH_PREFLIGHT_PROVIDER_UNAVAILABLE` | error | The configured provider or model cannot run in this environment. |
| `RADISH_PREFLIGHT_PROFILE_UNAVAILABLE` | error | The selected deployment profile is missing or incompatible. |
| `RADISH_PREFLIGHT_SECRET_UNAVAILABLE` | error | A referenced secret is unavailable. |
| `RADISH_PREFLIGHT_PROMPT_TEMPLATE_INVALID` | error | A prompt file contains malformed or unbound placeholders. |
| `RADISH_PREFLIGHT_CHILD_WORKFLOW_UNAVAILABLE` | error | A compiled child dependency can no longer be loaded. |
| `RADISH_PREFLIGHT_CHILD_WORKFLOW_NOT_READY` | error | A referenced workflow tree failed deployment preflight. |
| `RADISH_WORKFLOW_EMPTY` | error | A compiled workflow has no executable nodes. Preflight and runtime reject the run, but the editor may display the workflow. |
| `RADISH_CLI_INPUT_INVALID` | error | A `gof radish run --input` argument is not a unique `NAME=JSON` assignment. |
| `RADISH_WORKFLOW_INPUT_INVALID` | error | Supplied workflow inputs are missing, unknown, or fail their declared schemas. |
| `RADISH_RUNTIME_COMMAND_FAILED` | error | A command node completed with a nonzero exit status. |
| `RADISH_RUNTIME_CONFIGURATION_ERROR` | error | A runtime handler rejected node configuration that could not be checked statically. |
| `RADISH_RUNTIME_FILESYSTEM_ERROR` | error | A runtime handler could not complete a filesystem operation. |
| `RADISH_RUNTIME_PROVIDER_ERROR` | error | An Agent provider invocation failed after deployment preflight. |
| `RADISH_RUNTIME_OUTPUT_INVALID` | error | A handler's successful value violated the output schema embedded in IR. |
| `RADISH_WORKFLOW_OUTPUT_MISSING` | error | A declared public output had no value when the workflow otherwise completed. |
| `RADISH_WORKFLOW_OUTPUT_INVALID` | error | A resolved public output violated its declared schema. |
| `RADISH_WORKFLOW_INTERFACE_CHANGED` | error | A child's current public interface does not match the caller's frozen resolution. |
| `RADISH_WORKFLOW_DEPENDENCY_CHANGED` | error | A child's compiled implementation does not match the caller's frozen dependency. |
| `RADISH_CHILD_WORKFLOW_COMPILE_FAILED` | error | A child workflow became invalid after its caller was compiled. |
| `RADISH_CHILD_WORKFLOW_FAILED` | error | A child workflow failed without a more specific propagated error. |
| `RADISH_JOIN_UNRESOLVED` | error | Quiescence left a partial join with no possible producer completion. |
| `RADISH_RUN_LIMIT_EXCEEDED` | error | The next node execution would exceed a workflow or node run limit. |
| `RADISH_TIMEOUT` | error | A node or workflow exhausted its configured active-processing timeout. |
| `RADISH_EXPORT_SUSPECTED_SECRET` | warning | Bundle inspection found credential-shaped plaintext or a suspicious file. |

`RADISH_SUSPECTED_PLAINTEXT_SECRET` never becomes a compile error. Export may repeat the
warning as `RADISH_EXPORT_SUSPECTED_SECRET`, but it must not silently rewrite or remove
valid Radish source.

## Primary and related spans

The primary span marks the smallest source range that identifies the problem. A duplicate
declaration points at the later identifier and records the earlier declaration as a
related span. A type mismatch points at the binding value and may relate the destination
input declaration or contract field.

EOF diagnostics use an empty span whose start and end are both the EOF position.

Runtime diagnostics without a live source buffer use the source map embedded in IR. If a
file moved after compilation, the diagnostic still reports the compiled entry-point path
and positions.
