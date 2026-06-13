import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Braces,
  Command,
  GitPullRequestArrow,
  Grip,
  Loader2,
  MousePointer2,
  Play,
  Plus,
  Route,
  Trash2,
} from "lucide-react";

const nodeStyles = {
  agent: {
    icon: Braces,
    accent: "bg-teal-600",
    border: "border-teal-200",
    chip: "bg-teal-50 text-teal-700 border-teal-100",
  },
  bash_command: {
    icon: Command,
    accent: "bg-slate-900",
    border: "border-slate-200",
    chip: "bg-slate-100 text-slate-700 border-slate-200",
  },
  python_script: {
    icon: Route,
    accent: "bg-amber-600",
    border: "border-amber-200",
    chip: "bg-amber-50 text-amber-700 border-amber-100",
  },
  shell_script: {
    icon: Command,
    accent: "bg-sky-700",
    border: "border-sky-200",
    chip: "bg-sky-50 text-sky-700 border-sky-100",
  },
};

const defaultSettings = {
  pipeOutput: false,
  retryCount: 0,
  retryDelaySeconds: 1,
  timeoutSeconds: "",
};

function defaultOperation(type, nodeNumber = 1) {
  switch (type) {
    case "bash_command":
      return {
        type,
        command: "echo hello",
        working_dir: "",
        env: {},
      };
    case "python_script":
      return {
        type,
        script_path: `scripts/step_${nodeNumber}.py`,
        args: [],
        env: {},
      };
    case "shell_script":
      return {
        type,
        script_path: `scripts/step_${nodeNumber}.sh`,
        args: [],
        env: {},
      };
    case "agent":
    default:
      return {
        type: "agent",
        agent_id: `agent-${nodeNumber}`,
        prompt_path: `prompts/agent-${nodeNumber}.md`,
        working_dir: ".",
        dynamic_count: 1,
        input_mapping: {},
        fan_source: null,
      };
  }
}

function defaultAgentConfig(agentId) {
  return {
    agent_id: agentId,
    subscription: "codex",
    working_dir: ".",
    prompt_path: `prompts/${agentId}.md`,
    tools: [],
    mcp_servers: [],
    env: {},
  };
}

function nodeMetaFromOperation(operation = {}) {
  switch (operation.type) {
    case "bash_command":
      return operation.command || "bash command";
    case "python_script":
    case "shell_script":
      return operation.script_path || "script";
    case "agent":
      return operation.prompt_path
        ? `${operation.agent_id || "agent"} · ${operation.prompt_path}`
        : operation.agent_id || "agent";
    default:
      return "operation";
  }
}

export default function DagCanvas({ runState, workflow, onRunWorkflow, onWorkflowChange }) {
  const canvasRef = useRef(null);
  const firstNodeId = workflow.nodes[0]?.id;
  const [selectedNodeId, setSelectedNodeId] = useState(firstNodeId);
  const [draggingNodeId, setDraggingNodeId] = useState(null);
  const [connectFromId, setConnectFromId] = useState(null);

  const selectedNode = workflow.nodes.find((node) => node.id === selectedNodeId);
  const nodesById = useMemo(() => {
    return Object.fromEntries(workflow.nodes.map((node) => [node.id, node]));
  }, [workflow.nodes]);

  useEffect(() => {
    setSelectedNodeId(firstNodeId);
    setConnectFromId(null);
    setDraggingNodeId(null);
  }, [firstNodeId, workflow.id]);

  function updateNode(nodeId, patch) {
    onWorkflowChange({
      ...workflow,
      nodes: workflow.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
    });
  }

  function updateNodeOperation(nodeId, patch) {
    const node = nodesById[nodeId];
    const operation = { ...(node.operation ?? defaultOperation(node.type)), ...patch };
    const nextNodePatch = {
      operation,
      type: operation.type,
      meta: nodeMetaFromOperation(operation),
    };

    if (operation.type === "agent" && patch.agent_id && !workflow.agents?.[patch.agent_id]) {
      onWorkflowChange({
        ...workflow,
        agents: {
          ...(workflow.agents ?? {}),
          [patch.agent_id]: defaultAgentConfig(patch.agent_id),
        },
        nodes: workflow.nodes.map((currentNode) =>
          currentNode.id === nodeId ? { ...currentNode, ...nextNodePatch } : currentNode,
        ),
      });
      return;
    }

    updateNode(nodeId, nextNodePatch);
  }

  function updateNodeSettings(nodeId, patch) {
    const node = nodesById[nodeId];
    updateNode(nodeId, {
      settings: {
        ...defaultSettings,
        ...(node.settings ?? {}),
        ...patch,
      },
    });
  }

  function updateNodeType(nodeId, type) {
    const nextOperation = defaultOperation(type, workflow.nodes.length + 1);
    const nextNode = {
      type,
      operation: nextOperation,
      settings: {
        ...defaultSettings,
        ...(nodesById[nodeId].settings ?? {}),
      },
      meta: nodeMetaFromOperation(nextOperation),
    };
    if (type === "agent" && !workflow.agents?.[nextOperation.agent_id]) {
      onWorkflowChange({
        ...workflow,
        agents: {
          ...(workflow.agents ?? {}),
          [nextOperation.agent_id]: defaultAgentConfig(nextOperation.agent_id),
        },
        nodes: workflow.nodes.map((node) => (node.id === nodeId ? { ...node, ...nextNode } : node)),
      });
      return;
    }
    updateNode(nodeId, nextNode);
  }

  function updateAgentConfig(agentId, patch) {
    const currentAgent = workflow.agents?.[agentId] ?? defaultAgentConfig(agentId);
    onWorkflowChange({
      ...workflow,
      agents: {
        ...(workflow.agents ?? {}),
        [agentId]: {
          ...currentAgent,
          ...patch,
        },
      },
    });
  }

  function addNode() {
    const nextNumber = workflow.nodes.length + 1;
    const newNode = {
      id: `node-${nextNumber}`,
      label: `New Step ${nextNumber}`,
      type: "agent",
      operation: defaultOperation("agent", nextNumber),
      settings: defaultSettings,
      meta: nodeMetaFromOperation(defaultOperation("agent", nextNumber)),
      x: 180 + nextNumber * 34,
      y: 180 + nextNumber * 24,
    };
    onWorkflowChange({
      ...workflow,
      agents: {
        ...(workflow.agents ?? {}),
        [newNode.operation.agent_id]: defaultAgentConfig(newNode.operation.agent_id),
      },
      nodes: [...workflow.nodes, newNode],
    });
    setSelectedNodeId(newNode.id);
  }

  function deleteSelectedNode() {
    if (!selectedNode) return;

    onWorkflowChange({
      ...workflow,
      nodes: workflow.nodes.filter((node) => node.id !== selectedNode.id),
      edges: workflow.edges.filter(
        (edge) => edge.from !== selectedNode.id && edge.to !== selectedNode.id,
      ),
    });
    setSelectedNodeId(workflow.nodes.find((node) => node.id !== selectedNode.id)?.id);
  }

  function handleNodePointerDown(event, nodeId) {
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedNodeId(nodeId);
    setDraggingNodeId(nodeId);
  }

  function handleNodePointerMove(event, nodeId) {
    if (draggingNodeId !== nodeId) return;
    updateNode(nodeId, {
      x: Math.max(24, Math.min(940, nodesById[nodeId].x + event.movementX)),
      y: Math.max(24, Math.min(470, nodesById[nodeId].y + event.movementY)),
    });
  }

  function handleNodePointerUp(event) {
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDraggingNodeId(null);
  }

  function toggleConnection(nodeId) {
    if (!connectFromId) {
      setConnectFromId(nodeId);
      return;
    }

    if (connectFromId === nodeId) {
      setConnectFromId(null);
      return;
    }

    const edgeId = `${connectFromId}-${nodeId}`;
    const edgeExists = workflow.edges.some((edge) => edge.id === edgeId);
    if (!edgeExists) {
      onWorkflowChange({
        ...workflow,
        edges: [
          ...workflow.edges,
          { id: edgeId, from: connectFromId, to: nodeId, label: "new edge" },
        ],
      });
    }
    setConnectFromId(null);
  }

  function deleteEdge(edgeId) {
    onWorkflowChange({
      ...workflow,
      edges: workflow.edges.filter((edge) => edge.id !== edgeId),
    });
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-white px-6">
          <div className="flex items-center gap-2">
            <ToolbarButton title="Select" active={!connectFromId}>
              <MousePointer2 size={16} />
            </ToolbarButton>
            <ToolbarButton title="Connect nodes from a node arrow" active={Boolean(connectFromId)}>
              <GitPullRequestArrow size={16} />
            </ToolbarButton>
            <span
              className={`ml-2 text-sm ${
                runState?.error
                  ? "text-red-600"
                  : runState?.result?.success
                    ? "text-emerald-700"
                    : "text-muted"
              }`}
            >
              {connectFromId
                ? "Connecting edge"
                : runState?.running
                  ? "Running workflow"
                  : runState?.error
                    ? "Run failed"
                    : runState?.result
                      ? runState.result.success
                        ? "Last run passed"
                        : "Last run failed"
                      : "Ready"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={Boolean(runState?.running)}
              title="Run workflow now"
              type="button"
              onClick={() => onRunWorkflow(workflow)}
            >
              {runState?.running ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
              Run
            </button>
            <button
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm font-medium text-slate-700 transition hover:border-slate-300"
              type="button"
              onClick={deleteSelectedNode}
            >
              <Trash2 size={15} />
              Delete
            </button>
            <button
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white transition hover:bg-slate-700"
              type="button"
              onClick={addNode}
            >
              <Plus size={15} />
              Node
            </button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_1px_1px,#d5dee8_1px,transparent_0)] [background-size:22px_22px]">
          <div
            ref={canvasRef}
            className="relative h-[620px] min-w-[1080px]"
            onPointerDown={() => setSelectedNodeId(undefined)}
          >
            <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
              <defs>
                <marker
                  id="arrowhead"
                  markerHeight="10"
                  markerWidth="10"
                  orient="auto"
                  refX="8"
                  refY="3"
                >
                  <path d="M0,0 L0,6 L9,3 z" fill="#718096" />
                </marker>
              </defs>
              {workflow.edges.map((edge) => {
                const from = nodesById[edge.from];
                const to = nodesById[edge.to];
                if (!from || !to) return null;

                const start = { x: from.x + 220, y: from.y + 48 };
                const end = { x: to.x, y: to.y + 48 };
                const middleX = start.x + Math.max(60, (end.x - start.x) / 2);
                const path = `M ${start.x} ${start.y} C ${middleX} ${start.y}, ${middleX} ${end.y}, ${end.x} ${end.y}`;

                return (
                  <g key={edge.id}>
                    <path
                      d={path}
                      fill="none"
                      markerEnd="url(#arrowhead)"
                      stroke="#718096"
                      strokeLinecap="round"
                      strokeWidth="2.5"
                    />
                    <text
                      x={(start.x + end.x) / 2}
                      y={(start.y + end.y) / 2 - 12}
                      className="fill-slate-500 text-[12px] font-medium"
                      textAnchor="middle"
                    >
                      {edge.label}
                    </text>
                  </g>
                );
              })}
            </svg>

            {workflow.nodes.map((node) => (
              <WorkflowNode
                key={node.id}
                connectFromId={connectFromId}
                node={node}
                selected={selectedNodeId === node.id}
                onConnect={toggleConnection}
                onPointerDown={handleNodePointerDown}
                onPointerMove={handleNodePointerMove}
                onPointerUp={handleNodePointerUp}
              />
            ))}
          </div>
        </div>
      </div>

      <Inspector
        agents={workflow.agents ?? {}}
        edges={workflow.edges}
        node={selectedNode}
        onDeleteEdge={deleteEdge}
        onAgentChange={updateAgentConfig}
        onNodeChange={(patch) => updateNode(selectedNode.id, patch)}
        onOperationChange={(patch) => updateNodeOperation(selectedNode.id, patch)}
        onSettingsChange={(patch) => updateNodeSettings(selectedNode.id, patch)}
        onTypeChange={(type) => updateNodeType(selectedNode.id, type)}
      />
    </div>
  );
}

function WorkflowNode({
  connectFromId,
  node,
  selected,
  onConnect,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}) {
  const style = nodeStyles[node.type] ?? nodeStyles.agent;
  const Icon = style.icon;

  return (
    <article
      className={`absolute w-[220px] cursor-grab rounded-lg border bg-white p-3 shadow-node transition active:cursor-grabbing ${
        selected ? "border-teal-500 ring-4 ring-teal-100" : style.border
      } ${connectFromId === node.id ? "ring-4 ring-amber-100" : ""}`}
      style={{ left: node.x, top: node.y }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown(event, node.id);
      }}
      onPointerMove={(event) => onPointerMove(event, node.id)}
      onPointerUp={onPointerUp}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white ${style.accent}`}>
            <Icon size={18} />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{node.label}</h3>
            <p className="mt-1 truncate text-xs text-muted">{node.meta}</p>
          </div>
        </div>
        <Grip size={16} className="shrink-0 text-slate-400" />
      </div>
      <div className="mt-4 flex items-center justify-between gap-2">
        <span className={`rounded-md border px-2 py-1 text-[11px] font-medium ${style.chip}`}>
          {node.type}
        </span>
        <button
          className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted transition hover:border-slate-300 hover:text-ink"
          title="Connect node"
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onConnect(node.id);
          }}
        >
          <ArrowRight size={15} />
        </button>
      </div>
    </article>
  );
}

function Inspector({
  agents,
  edges,
  node,
  onAgentChange,
  onDeleteEdge,
  onNodeChange,
  onOperationChange,
  onSettingsChange,
  onTypeChange,
}) {
  const operation = node?.operation ?? defaultOperation(node?.type ?? "agent");
  const settings = { ...defaultSettings, ...(node?.settings ?? {}) };
  const agentConfig =
    operation.type === "agent"
      ? agents[operation.agent_id] ?? defaultAgentConfig(operation.agent_id || "agent")
      : null;

  return (
    <aside className="workflow-scrollbar w-[340px] shrink-0 overflow-y-auto border-l border-line bg-white">
      <div className="border-b border-line px-4 py-4">
        <h2 className="text-sm font-semibold">Node inspector</h2>
        <p className="mt-1 text-xs text-muted">{node?.id ?? "No selection"}</p>
      </div>

      {node ? (
        <div className="space-y-4 p-4">
          <InspectorSection title="Node">
            <TextField label="ID" value={node.id} readOnly />
            <TextField
              label="Label"
              value={node.label}
              onChange={(value) => onNodeChange({ label: value })}
            />
            <SelectField
              label="Type"
              value={node.type}
              options={[
                ["agent", "Agent"],
                ["bash_command", "Bash command"],
                ["python_script", "Python script"],
                ["shell_script", "Shell script"],
              ]}
              onChange={onTypeChange}
            />
          </InspectorSection>

          <InspectorSection title="Execution">
            <ToggleField
              checked={Boolean(settings.pipeOutput)}
              label="Pipe output"
              onChange={(checked) => onSettingsChange({ pipeOutput: checked })}
            />
            <NumberField
              label="Retry count"
              min="0"
              value={settings.retryCount}
              onChange={(value) => onSettingsChange({ retryCount: value })}
            />
            <NumberField
              label="Retry delay seconds"
              min="0"
              step="0.1"
              value={settings.retryDelaySeconds}
              onChange={(value) => onSettingsChange({ retryDelaySeconds: value })}
            />
            <NumberField
              label="Timeout seconds"
              min="0"
              value={settings.timeoutSeconds ?? ""}
              onChange={(value) => onSettingsChange({ timeoutSeconds: value })}
              placeholder="None"
            />
          </InspectorSection>

          {operation.type === "bash_command" ? (
            <InspectorSection title="Bash command">
              <TextareaField
                label="Command"
                rows={4}
                value={operation.command ?? ""}
                onChange={(value) => onOperationChange({ command: value })}
              />
              <TextField
                label="Working directory"
                value={operation.working_dir ?? ""}
                onChange={(value) => onOperationChange({ working_dir: value })}
                placeholder="."
              />
              <KeyValueField
                label="Environment"
                value={operation.env ?? {}}
                onChange={(value) => onOperationChange({ env: value })}
              />
            </InspectorSection>
          ) : null}

          {operation.type === "python_script" || operation.type === "shell_script" ? (
            <InspectorSection
              title={operation.type === "python_script" ? "Python script" : "Shell script"}
            >
              <TextField
                label="Script path"
                value={operation.script_path ?? ""}
                onChange={(value) => onOperationChange({ script_path: value })}
              />
              <ListField
                label="Arguments"
                value={operation.args ?? []}
                onChange={(value) => onOperationChange({ args: value })}
                placeholder="--flag, value"
              />
              <KeyValueField
                label="Environment"
                value={operation.env ?? {}}
                onChange={(value) => onOperationChange({ env: value })}
              />
            </InspectorSection>
          ) : null}

          {operation.type === "agent" ? (
            <>
              <InspectorSection title="Agent node">
                <TextField
                  label="Agent ID"
                  value={operation.agent_id ?? ""}
                  onChange={(value) => onOperationChange({ agent_id: value })}
                />
                <TextField
                  label="Prompt path"
                  value={operation.prompt_path ?? ""}
                  onChange={(value) => onOperationChange({ prompt_path: value })}
                />
                <TextField
                  label="Working directory"
                  value={operation.working_dir ?? ""}
                  onChange={(value) => onOperationChange({ working_dir: value })}
                />
                <TextField
                  label="Dynamic count"
                  value={String(operation.dynamic_count ?? 1)}
                  onChange={(value) => onOperationChange({ dynamic_count: value })}
                />
                <KeyValueField
                  label="Input mapping"
                  value={operation.input_mapping ?? {}}
                  onChange={(value) => onOperationChange({ input_mapping: value })}
                />
              </InspectorSection>

              <InspectorSection title="Fan-out">
                <SelectField
                  label="Source"
                  value={operation.fan_source?.type ?? "none"}
                  options={[
                    ["none", "None"],
                    ["count", "Count"],
                    ["tabular", "Tabular file"],
                    ["directory", "Directory"],
                  ]}
                  onChange={(value) =>
                    onOperationChange({
                      fan_source: value === "none" ? null : defaultFanSource(value),
                    })
                  }
                />
                {operation.fan_source?.type === "count" ? (
                  <TextField
                    label="Count"
                    value={String(operation.fan_source.count ?? 1)}
                    onChange={(value) =>
                      onOperationChange({
                        fan_source: { ...operation.fan_source, count: value },
                      })
                    }
                  />
                ) : null}
                {operation.fan_source?.type === "tabular" ? (
                  <TextField
                    label="Path"
                    value={operation.fan_source.path ?? ""}
                    onChange={(value) =>
                      onOperationChange({
                        fan_source: { ...operation.fan_source, path: value },
                      })
                    }
                  />
                ) : null}
                {operation.fan_source?.type === "directory" ? (
                  <>
                    <TextField
                      label="Path"
                      value={operation.fan_source.path ?? ""}
                      onChange={(value) =>
                        onOperationChange({
                          fan_source: { ...operation.fan_source, path: value },
                        })
                      }
                    />
                    <TextField
                      label="Glob"
                      value={operation.fan_source.glob ?? "*"}
                      onChange={(value) =>
                        onOperationChange({
                          fan_source: { ...operation.fan_source, glob: value },
                        })
                      }
                    />
                    <ToggleField
                      checked={Boolean(operation.fan_source.include_content)}
                      label="Include content"
                      onChange={(checked) =>
                        onOperationChange({
                          fan_source: { ...operation.fan_source, include_content: checked },
                        })
                      }
                    />
                  </>
                ) : null}
                {operation.fan_source ? (
                  <>
                    <NumberField
                      label="Max concurrency"
                      min="1"
                      value={operation.fan_source.max_concurrency ?? 16}
                      onChange={(value) =>
                        onOperationChange({
                          fan_source: { ...operation.fan_source, max_concurrency: value },
                        })
                      }
                    />
                    <ToggleField
                      checked={Boolean(operation.fan_source.fail_fast)}
                      label="Fail fast"
                      onChange={(checked) =>
                        onOperationChange({
                          fan_source: { ...operation.fan_source, fail_fast: checked },
                        })
                      }
                    />
                  </>
                ) : null}
              </InspectorSection>

              <InspectorSection title="Agent config">
                <SelectField
                  label="Subscription"
                  value={agentConfig.subscription}
                  options={[
                    ["codex", "Codex"],
                    ["claude_code", "Claude Code"],
                  ]}
                  onChange={(value) => onAgentChange(operation.agent_id, { subscription: value })}
                />
                <TextField
                  label="Prompt path"
                  value={agentConfig.prompt_path ?? ""}
                  onChange={(value) => onAgentChange(operation.agent_id, { prompt_path: value })}
                />
                <TextField
                  label="Working directory"
                  value={agentConfig.working_dir ?? ""}
                  onChange={(value) => onAgentChange(operation.agent_id, { working_dir: value })}
                />
                <ListField
                  label="Tools"
                  value={agentConfig.tools ?? []}
                  onChange={(value) => onAgentChange(operation.agent_id, { tools: value })}
                  placeholder="Read, Write, Bash"
                />
                <ListField
                  label="MCP servers"
                  value={agentConfig.mcp_servers ?? []}
                  onChange={(value) => onAgentChange(operation.agent_id, { mcp_servers: value })}
                  placeholder="server-a, server-b"
                />
                <KeyValueField
                  label="Environment"
                  value={agentConfig.env ?? {}}
                  onChange={(value) => onAgentChange(operation.agent_id, { env: value })}
                />
              </InspectorSection>
            </>
          ) : null}

          <div className="rounded-lg border border-line">
            <div className="border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
              Edges
            </div>
            <div className="divide-y divide-line">
              {edges.length ? (
                edges.map((edge) => (
                  <div key={edge.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-slate-700">
                        {edge.from} to {edge.to}
                      </p>
                      <p className="truncate text-[11px] text-muted">{edge.label}</p>
                    </div>
                    <button
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition hover:bg-red-50 hover:text-red-600"
                      title="Delete edge"
                      type="button"
                      onClick={() => onDeleteEdge(edge.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              ) : (
                <p className="px-3 py-4 text-sm text-muted">No edges yet.</p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="p-4 text-sm leading-6 text-muted">No node selected.</div>
      )}
    </aside>
  );
}

function defaultFanSource(type) {
  switch (type) {
    case "count":
      return { type, count: 1, max_concurrency: 16, fail_fast: false };
    case "tabular":
      return { type, path: "data/input.csv", max_concurrency: 16, fail_fast: false };
    case "directory":
      return {
        type,
        path: "data",
        glob: "*",
        include_content: false,
        max_concurrency: 16,
        fail_fast: false,
      };
    default:
      return null;
  }
}

function InspectorSection({ children, title }) {
  return (
    <section className="space-y-3 rounded-lg border border-line p-3">
      <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{title}</h3>
      {children}
    </section>
  );
}

function TextField({ label, onChange, placeholder, readOnly = false, value }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted">{label}</span>
      <input
        className="mt-1 h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-teal-500 read-only:bg-slate-50"
        placeholder={placeholder}
        readOnly={readOnly}
        value={value ?? ""}
        onChange={(event) => onChange?.(event.target.value)}
      />
    </label>
  );
}

function NumberField({ label, min, onChange, placeholder, step = "1", value }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted">{label}</span>
      <input
        className="mt-1 h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-teal-500"
        min={min}
        placeholder={placeholder}
        step={step}
        type="number"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
      />
    </label>
  );
}

function SelectField({ label, onChange, options, value }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted">{label}</span>
      <select
        className="mt-1 h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-teal-500"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([optionValue, labelText]) => (
          <option key={optionValue} value={optionValue}>
            {labelText}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextareaField({ label, onChange, placeholder, rows = 3, value }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted">{label}</span>
      <textarea
        className="mt-1 w-full resize-none rounded-lg border border-line px-3 py-2 text-sm outline-none transition focus:border-teal-500"
        placeholder={placeholder}
        rows={rows}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function ToggleField({ checked, label, onChange }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <input
        checked={checked}
        className="h-4 w-4 accent-teal-700"
        type="checkbox"
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function ListField({ label, onChange, placeholder, value }) {
  return (
    <TextareaField
      label={label}
      placeholder={placeholder}
      rows={2}
      value={(value ?? []).join(", ")}
      onChange={(text) =>
        onChange(
          text
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        )
      }
    />
  );
}

function KeyValueField({ label, onChange, value }) {
  return (
    <TextareaField
      label={label}
      rows={3}
      value={objectToKeyValueText(value)}
      onChange={(text) => onChange(keyValueTextToObject(text))}
    />
  );
}

function objectToKeyValueText(value = {}) {
  return Object.entries(value)
    .map(([key, item]) => `${key}=${item}`)
    .join("\n");
}

function keyValueTextToObject(text) {
  return Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        if (index === -1) {
          return [line, ""];
        }
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}

function ToolbarButton({ active, children, title }) {
  return (
    <button
      className={`grid h-9 w-9 place-items-center rounded-lg border transition ${
        active ? "border-teal-200 bg-teal-50 text-teal-700" : "border-line bg-white text-muted"
      }`}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}
