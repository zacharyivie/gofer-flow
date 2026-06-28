const PATCH_BLOCK_PATTERN = /```(?:gofer-workflow-patch|workflow-patch|json)?\s*([\s\S]*?)```/gi;

const patchOperationLabels = {
  add_node: "Add node",
  update_node: "Update node",
  delete_node: "Delete node",
  add_edge: "Connect nodes",
  delete_edge: "Remove edge",
  upsert_agent: "Change agent",
  delete_agent: "Delete agent",
  set_trigger: "Change trigger",
  set_parameters: "Change parameters",
  set_filesystem_access: "Change filesystem access",
};

const supportedPatchOperations = new Set(Object.keys(patchOperationLabels));

export function extractWorkflowPatch(text) {
  const candidates = [];
  const source = String(text ?? "");
  for (const match of source.matchAll(PATCH_BLOCK_PATTERN)) {
    candidates.push(match[1]);
  }
  candidates.push(source);

  for (const candidate of candidates) {
    const parsed = parsePatchJson(candidate);
    if (!parsed) continue;
    const patch = normalizeWorkflowPatch(parsed);
    if (patch) return { ok: true, patch };
  }
  return { ok: false, error: "No workflow patch found" };
}

function parsePatchJson(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function normalizeWorkflowPatch(value) {
  if (!value || typeof value !== "object") return null;
  if (value.type && value.type !== "gofer.workflow.patch") return null;
  const operations = Array.isArray(value.operations)
    ? value.operations
    : Array.isArray(value.ops)
      ? value.ops
      : null;
  if (!operations) return null;
  return {
    type: "gofer.workflow.patch",
    version: Number(value.version ?? 1),
    title: String(value.title || "Workflow patch"),
    summary: String(value.summary || ""),
    operations: operations.map((operation, index) => ({
      ...operation,
      id: String(operation.id || `hunk-${index + 1}`),
      op: String(operation.op || operation.action || ""),
    })),
  };
}

export function validateWorkflowPatch(patch, workflow) {
  const errors = [];
  if (!patch || patch.type !== "gofer.workflow.patch") {
    errors.push("Patch must be a gofer.workflow.patch object.");
  }
  if (!Array.isArray(patch?.operations) || patch.operations.length === 0) {
    errors.push("Patch must include at least one operation.");
  }
  if (patch?.version !== 1) {
    errors.push("Patch version must be 1.");
  }

  const nodeIds = new Set((workflow?.nodes ?? []).map((node) => node.id));
  const agentIds = new Set(Object.keys(workflow?.agents ?? {}));
  const projectedNodeIds = new Set(nodeIds);

  for (const operation of patch?.operations ?? []) {
    if (!supportedPatchOperations.has(operation.op)) {
      errors.push(`Unsupported patch operation '${operation.op || "unknown"}'.`);
      continue;
    }
    if (operation.op === "add_node") {
      const node = operation.node;
      if (!node?.id || !node?.type || !node?.operation?.type) {
        errors.push("Add node operations require node.id, node.type, and node.operation.type.");
      } else if (projectedNodeIds.has(node.id)) {
        errors.push(`Node '${node.id}' already exists.`);
      } else {
        projectedNodeIds.add(node.id);
      }
      if (node?.operation?.agent_id) agentIds.add(node.operation.agent_id);
    }
    if (operation.op === "update_node" || operation.op === "delete_node") {
      const nodeId = operation.nodeId ?? operation.id;
      if (!nodeIds.has(nodeId)) errors.push(`Node '${nodeId || "unknown"}' does not exist.`);
    }
    if (operation.op === "add_edge") {
      const edge = operation.edge ?? operation;
      if (!projectedNodeIds.has(edge.from)) errors.push(`Edge source '${edge.from}' does not exist.`);
      if (!projectedNodeIds.has(edge.to)) errors.push(`Edge target '${edge.to}' does not exist.`);
      if (edge.condition && !["always", "on_success", "on_failure", "output_matches"].includes(edge.condition)) {
        errors.push(`Edge condition '${edge.condition}' is not supported.`);
      }
    }
    if (operation.op === "delete_edge") {
      const edge = operation.edge ?? operation;
      if (!edge.id && (!edge.from || !edge.to)) {
        errors.push("Delete edge operations require edge.id or from/to.");
      }
    }
    if (operation.op === "upsert_agent") {
      const agentId = operation.agentId ?? operation.agent_id ?? operation.agent?.agent_id;
      if (!agentId) errors.push("Agent operations require agentId.");
    }
    if (operation.op === "delete_agent") {
      const agentId = operation.agentId ?? operation.agent_id;
      if (!agentIds.has(agentId)) errors.push(`Agent '${agentId || "unknown"}' does not exist.`);
    }
    if (operation.op === "set_filesystem_access") {
      const entries = operation.entries ?? operation.filesystemAccess;
      if (!Array.isArray(entries)) {
        errors.push("Filesystem access operations require an entries array.");
      } else if (entries.some((entry) => !String(entry?.path ?? "").trim())) {
        errors.push("Filesystem access entries require non-empty paths.");
      }
    }
    if (operation.run || operation.execute || operation.op.startsWith("run_")) {
      errors.push("Workflow patches cannot run or execute workflows.");
    }
  }

  return { ok: errors.length === 0, errors };
}

export function buildPatchReview(patch, workflow) {
  const validation = validateWorkflowPatch(patch, workflow);
  return {
    ...validation,
    title: patch?.title || "Workflow patch",
    summary: patch?.summary || "",
    hunks: (patch?.operations ?? []).map((operation) => ({
      id: operation.id,
      operation,
      label: patchOperationLabels[operation.op] ?? operation.op,
      risk: patchOperationRisk(operation),
      detail: patchOperationDetail(operation),
    })),
  };
}

export function selectedPatchOperations(patch, selectedIds) {
  const selected = new Set(selectedIds);
  return {
    ...patch,
    operations: (patch.operations ?? []).filter((operation) => selected.has(operation.id)),
  };
}

export function applyWorkflowPatch(workflow, patch) {
  let nextWorkflow = clone(workflow);
  for (const operation of patch.operations ?? []) {
    nextWorkflow = applyPatchOperation(nextWorkflow, operation);
  }
  return nextWorkflow;
}

function applyPatchOperation(workflow, operation) {
  if (operation.op === "add_node") {
    const node = normalizeNode(operation.node);
    return {
      ...workflow,
      agents: agentFromNode(workflow.agents ?? {}, node),
      nodes: [...(workflow.nodes ?? []), node],
    };
  }
  if (operation.op === "update_node") {
    const nodeId = operation.nodeId ?? operation.id;
    return {
      ...workflow,
      nodes: (workflow.nodes ?? []).map((node) => {
        if (node.id !== nodeId) return node;
        const patch = operation.patch ?? {};
        const operationPatch = patch.operation ?? operation.operation ?? {};
        const nextOperation = Object.keys(operationPatch).length
          ? { ...(node.operation ?? {}), ...operationPatch }
          : node.operation;
        return {
          ...node,
          ...patch,
          operation: nextOperation,
          type: nextOperation?.type ?? patch.type ?? node.type,
          meta: patch.meta ?? metaFromOperation(nextOperation),
        };
      }),
    };
  }
  if (operation.op === "delete_node") {
    const nodeId = operation.nodeId ?? operation.id;
    return {
      ...workflow,
      nodes: (workflow.nodes ?? []).filter((node) => node.id !== nodeId),
      edges: (workflow.edges ?? []).filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
      metadata: removeNodeFromGroups(workflow.metadata, nodeId),
    };
  }
  if (operation.op === "add_edge") {
    const edge = normalizeEdge(operation.edge ?? operation, workflow.edges ?? []);
    return { ...workflow, edges: [...(workflow.edges ?? []), edge] };
  }
  if (operation.op === "delete_edge") {
    const edge = operation.edge ?? operation;
    return {
      ...workflow,
      edges: (workflow.edges ?? []).filter((candidate) =>
        edge.id
          ? candidate.id !== edge.id
          : !(candidate.from === edge.from && candidate.to === edge.to),
      ),
    };
  }
  if (operation.op === "upsert_agent") {
    const agentId = operation.agentId ?? operation.agent_id ?? operation.agent?.agent_id;
    const agent = operation.agent ?? operation.config ?? {};
    return {
      ...workflow,
      agents: {
        ...(workflow.agents ?? {}),
        [agentId]: {
          subscription: "codex",
          ...((workflow.agents ?? {})[agentId] ?? {}),
          ...agent,
        },
      },
    };
  }
  if (operation.op === "delete_agent") {
    const agentId = operation.agentId ?? operation.agent_id;
    const agents = { ...(workflow.agents ?? {}) };
    delete agents[agentId];
    return { ...workflow, agents };
  }
  if (operation.op === "set_trigger") {
    const trigger = operation.trigger ?? {};
    return {
      ...workflow,
      schedule: Object.hasOwn(trigger, "schedule") ? trigger.schedule : workflow.schedule,
      watch: Object.hasOwn(trigger, "watch") ? trigger.watch : workflow.watch,
      webhooks: Object.hasOwn(trigger, "webhooks") ? trigger.webhooks : workflow.webhooks,
      runContinuously: Object.hasOwn(trigger, "runContinuously")
        ? Boolean(trigger.runContinuously)
        : workflow.runContinuously,
    };
  }
  if (operation.op === "set_parameters") {
    return { ...workflow, parameters: operation.parameters ?? {} };
  }
  if (operation.op === "set_filesystem_access") {
    return {
      ...workflow,
      filesystemAccess: operation.entries ?? operation.filesystemAccess ?? [],
    };
  }
  return workflow;
}

function normalizeNode(node) {
  const operation = node.operation ?? { type: node.type ?? "bash_command" };
  return {
    label: node.label ?? node.id,
    x: Number.isFinite(node.x) ? node.x : 120,
    y: Number.isFinite(node.y) ? node.y : 120,
    settings: node.settings ?? {},
    meta: node.meta ?? metaFromOperation(operation),
    ...node,
    type: node.type ?? operation.type,
    operation,
  };
}

function normalizeEdge(edge, edges) {
  const condition = edge.condition || "always";
  const outputPattern = condition === "output_matches" ? edge.outputPattern ?? edge.output_pattern ?? "" : null;
  return {
    id: edge.id || uniqueEdgeId(edges, edge.from, edge.to),
    from: edge.from,
    to: edge.to,
    condition,
    outputPattern,
    label: edge.label || edgeLabel(condition, outputPattern),
  };
}

function uniqueEdgeId(edges, from, to) {
  const base = `${from}-${to}`;
  if (!edges.some((edge) => edge.id === base)) return base;
  let index = 2;
  while (edges.some((edge) => edge.id === `${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function edgeLabel(condition, outputPattern) {
  if (condition === "on_success") return "on success";
  if (condition === "on_failure") return "on failure";
  if (condition === "output_matches") return `matches ${outputPattern || "pattern"}`;
  return "always";
}

function agentFromNode(agents, node) {
  const agentId = node.operation?.agent_id;
  if (!agentId || agents[agentId]) return agents;
  return {
    ...agents,
    [agentId]: { subscription: "codex" },
  };
}

function removeNodeFromGroups(metadata, nodeId) {
  if (!metadata?.canvas?.groups) return metadata;
  return {
    ...metadata,
    canvas: {
      ...metadata.canvas,
      groups: metadata.canvas.groups.map((group) => ({
        ...group,
        nodeIds: (group.nodeIds ?? group.node_ids ?? []).filter((id) => id !== nodeId),
      })),
    },
  };
}

function metaFromOperation(operation = {}) {
  return (
    operation.command ||
    operation.path ||
    operation.url ||
    operation.prompt ||
    operation.message ||
    operation.task ||
    operation.type ||
    ""
  );
}

function patchOperationRisk(operation) {
  if (operation.op === "delete_node" || operation.op === "delete_edge" || operation.op === "delete_agent") {
    return "destructive";
  }
  if (operation.op === "set_filesystem_access") return "filesystem";
  if (operation.op === "set_trigger") return "trigger";
  if (operation.op === "set_parameters") {
    return Object.values(operation.parameters ?? {}).some((parameter) => parameter?.type === "secret")
      ? "secret"
      : "workflow";
  }
  if (operation.op === "upsert_agent") return "agent";
  return "graph";
}

function patchOperationDetail(operation) {
  if (operation.op === "add_node") return `${operation.node?.id ?? "node"} (${operation.node?.type ?? "unknown"})`;
  if (operation.op === "update_node") return operation.nodeId ?? operation.id;
  if (operation.op === "delete_node") return operation.nodeId ?? operation.id;
  if (operation.op === "add_edge") {
    const edge = operation.edge ?? operation;
    return `${edge.from} -> ${edge.to}${edge.condition ? ` (${edge.condition})` : ""}`;
  }
  if (operation.op === "delete_edge") {
    const edge = operation.edge ?? operation;
    return edge.id ?? `${edge.from} -> ${edge.to}`;
  }
  if (operation.op === "upsert_agent" || operation.op === "delete_agent") {
    return operation.agentId ?? operation.agent_id ?? operation.agent?.agent_id;
  }
  if (operation.op === "set_trigger") return Object.keys(operation.trigger ?? {}).join(", ") || "trigger settings";
  if (operation.op === "set_parameters") return Object.keys(operation.parameters ?? {}).join(", ") || "parameters";
  if (operation.op === "set_filesystem_access") {
    return (operation.entries ?? operation.filesystemAccess ?? []).map((entry) => entry.path).join(", ");
  }
  return operation.op;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
