import { useEffect, useMemo, useRef, useState } from "react";
import {
  Braces,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Check,
  ChevronDown,
  ChevronUp,
  Command,
  Download,
  LocateFixed,
  Loader2,
  Play,
  Plus,
  Route,
  Terminal,
  Trash2,
  Upload,
  X,
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
const minZoom = 0.45;
const maxZoom = 1.8;

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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function nextAvailableNodeNumber(nodes) {
  const usedNumbers = new Set(
    nodes
      .map((node) => String(node.id).match(/^node-(\d+)$/)?.[1])
      .filter(Boolean)
      .map(Number),
  );
  let nextNumber = 1;
  while (usedNumbers.has(nextNumber)) {
    nextNumber += 1;
  }
  return nextNumber;
}

function nextAvailableAgentNumber(nodes, agents) {
  const usedNumbers = new Set([
    ...Object.keys(agents ?? {})
      .map((agentId) => String(agentId).match(/^agent-(\d+)$/)?.[1])
      .filter(Boolean)
      .map(Number),
    ...nodes
      .map((node) => String(node.operation?.agent_id ?? "").match(/^agent-(\d+)$/)?.[1])
      .filter(Boolean)
      .map(Number),
  ]);
  let nextNumber = 1;
  while (usedNumbers.has(nextNumber)) {
    nextNumber += 1;
  }
  return nextNumber;
}

export default function DagCanvas({
  logState,
  notice,
  runState,
  workflow,
  onImportWorkflow,
  onRunWorkflow,
  onValidateWorkflow,
  onWorkflowChange,
}) {
  const canvasRef = useRef(null);
  const importInputRef = useRef(null);
  const [selectedNodeId, setSelectedNodeId] = useState();
  const [draggingNodeId, setDraggingNodeId] = useState(null);
  const [panningPointerId, setPanningPointerId] = useState(null);
  const [logCollapsed, setLogCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(340);
  const [logHeight, setLogHeight] = useState(240);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });

  const selectedNode = workflow.nodes.find((node) => node.id === selectedNodeId);
  const runResult = runState?.result?.workflowId === workflow.id ? runState.result : null;
  const selectedNodeOutput = selectedNodeId ? runResult?.nodeOutputs?.[selectedNodeId] : null;
  const workflowLogText =
    logState?.text || runResult?.logText || formatWorkflowRunLog(runResult);
  const displayedLog = selectedNodeId
    ? extractNodeLog(workflowLogText, selectedNodeId) || selectedNodeOutput?.output || ""
    : workflowLogText;
  const logTitle = selectedNodeId ? `${selectedNodeId} last run` : "Workflow log";
  const nodeStatuses = useMemo(() => {
    return getNodeStatuses(workflow.nodes, runResult, workflowLogText);
  }, [runResult, workflow.nodes, workflowLogText]);
  const currentWorkflowRunning = runState?.running && runState.workflowId === workflow.id;
  const nodesById = useMemo(() => {
    return Object.fromEntries(workflow.nodes.map((node) => [node.id, node]));
  }, [workflow.nodes]);

  useEffect(() => {
    setSelectedNodeId(undefined);
    setDraggingNodeId(null);
    setPanningPointerId(null);
    setViewport({ x: 0, y: 0, scale: 1 });
  }, [workflow.id]);

  useEffect(() => {
    if (selectedNodeId && !nodesById[selectedNodeId]) {
      setSelectedNodeId(undefined);
    }
  }, [nodesById, selectedNodeId]);

  useEffect(() => {
    if (!panningPointerId) return undefined;

    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = previousCursor;
    };
  }, [panningPointerId]);

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
    const nextNumber = nextAvailableNodeNumber(workflow.nodes);
    const nextAgentNumber = nextAvailableAgentNumber(workflow.nodes, workflow.agents);
    const nextOperation = defaultOperation("agent", nextAgentNumber);
    const newNode = {
      id: `node-${nextNumber}`,
      label: `New Step ${nextNumber}`,
      type: "agent",
      operation: nextOperation,
      settings: defaultSettings,
      meta: nodeMetaFromOperation(nextOperation),
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
    deleteNode(selectedNode.id);
  }

  function deleteNode(nodeId) {
    onWorkflowChange({
      ...workflow,
      nodes: workflow.nodes.filter((node) => node.id !== nodeId),
      edges: workflow.edges.filter(
        (edge) => edge.from !== nodeId && edge.to !== nodeId,
      ),
    });
    setSelectedNodeId((currentId) =>
      currentId === nodeId ? workflow.nodes.find((node) => node.id !== nodeId)?.id : currentId,
    );
  }

  function handleNodePointerDown(event, nodeId) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedNodeId(nodeId);
    setDraggingNodeId(nodeId);
  }

  function handleNodePointerMove(event, nodeId) {
    if (draggingNodeId !== nodeId) return;
    updateNode(nodeId, {
      x: Math.max(24, Math.min(940, nodesById[nodeId].x + event.movementX / viewport.scale)),
      y: Math.max(24, Math.min(470, nodesById[nodeId].y + event.movementY / viewport.scale)),
    });
  }

  function handleNodePointerUp(event) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraggingNodeId(null);
  }

  function handleCanvasPointerDown(event) {
    if (event.button === 0) {
      setSelectedNodeId(undefined);
    }

    if (event.button === 0 || event.button === 2) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setPanningPointerId(event.pointerId);
    }
  }

  function handleCanvasPointerMove(event) {
    if (panningPointerId !== event.pointerId) return;
    event.preventDefault();
    setViewport((current) => ({
      ...current,
      x: current.x + event.movementX,
      y: current.y + event.movementY,
    }));
  }

  function handleCanvasPointerUp(event) {
    if (panningPointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPanningPointerId(null);
  }

  function handleCanvasWheel(event) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const zoomMultiplier = event.deltaY < 0 ? 1.08 : 0.92;

    setViewport((current) => {
      const nextScale = clamp(current.scale * zoomMultiplier, minZoom, maxZoom);
      const contentX = (pointerX - current.x) / current.scale;
      const contentY = (pointerY - current.y) / current.scale;
      return {
        scale: nextScale,
        x: pointerX - contentX * nextScale,
        y: pointerY - contentY * nextScale,
      };
    });
  }

  function deleteEdge(edgeId) {
    onWorkflowChange({
      ...workflow,
      edges: workflow.edges.filter((edge) => edge.id !== edgeId),
    });
  }

  function addEdge(fromNodeId, toNodeId, condition, outputPattern = null) {
    if (!fromNodeId || !toNodeId) return;

    const nextCondition = condition || "always";
    const nextOutputPattern = nextCondition === "output_matches" ? outputPattern || "" : null;
    onWorkflowChange({
      ...workflow,
      edges: [
        ...workflow.edges,
        {
          id: uniqueEdgeId(workflow.edges, fromNodeId, toNodeId),
          from: fromNodeId,
          to: toNodeId,
          label: edgeLabel(nextCondition, nextOutputPattern),
          condition: nextCondition,
          outputPattern: nextOutputPattern,
        },
      ],
    });
  }

  function updateEdge(edgeId, patch) {
    onWorkflowChange({
      ...workflow,
      edges: workflow.edges.map((edge) => {
        if (edge.id !== edgeId) return edge;
        const nextEdge = { ...edge, ...patch };
        return {
          ...nextEdge,
          label: edgeLabel(nextEdge.condition, nextEdge.outputPattern),
        };
      }),
    });
  }

  function startInspectorResize(event) {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = inspectorWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function handlePointerMove(moveEvent) {
      setInspectorWidth(clamp(startWidth - (moveEvent.clientX - startX), 280, 520));
    }

    function handlePointerUp() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  function startLogResize(event) {
    event.preventDefault();
    event.stopPropagation();

    const startY = event.clientY;
    const startHeight = logHeight;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    function handlePointerMove(moveEvent) {
      setLogHeight(clamp(startHeight + startY - moveEvent.clientY, 140, 420));
    }

    function handlePointerUp() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center justify-start border-b border-line bg-white px-6">
          <div className="flex items-center gap-2">
            <input
              ref={importInputRef}
              accept=".toml"
              className="hidden"
              type="file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  onImportWorkflow(file);
                }
                event.target.value = "";
              }}
            />
            <button
              className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
              disabled={Boolean(currentWorkflowRunning)}
              title="Run workflow now"
              type="button"
              onClick={() => onRunWorkflow(workflow)}
            >
              {currentWorkflowRunning ? <Loader2 size={17} className="animate-spin" /> : <Play size={17} />}
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
              title="Add node"
              type="button"
              onClick={addNode}
            >
              <Plus size={17} />
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
              title="reset view"
              type="button"
              onClick={() => setViewport({ x: 0, y: 0, scale: 1 })}
            >
              <LocateFixed size={17} />
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!selectedNode}
              title="Delete selected node"
              type="button"
              onClick={deleteSelectedNode}
            >
              <Trash2 size={17} />
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
              title="Import workflow TOML"
              type="button"
              onClick={() => importInputRef.current?.click()}
            >
              <Upload size={17} />
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted opacity-50"
              disabled
              title="Export workflow"
              type="button"
            >
              <Download size={17} />
            </button>
            <div className="relative">
              <button
                className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
                title="Validate workflow"
                type="button"
                onClick={onValidateWorkflow}
              >
                <Check size={17} />
              </button>
              {notice?.message ? (
                <div
                  className={`validation-pop absolute left-2 top-11 z-40 min-w-[190px] rounded-lg border px-3 py-2 text-sm font-medium shadow-panel ${
                    notice.type === "error"
                      ? "border-red-200 bg-red-50 text-red-700"
                      : "border-emerald-200 bg-emerald-50 text-emerald-700"
                  }`}
                >
                  {notice.message}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div
          ref={canvasRef}
          className={`relative min-h-0 flex-1 overflow-hidden bg-[#f9fbfd] bg-[radial-gradient(circle_at_1px_1px,#d5dee8_1px,transparent_0)] [touch-action:none] ${
            panningPointerId ? "cursor-grabbing" : "cursor-default"
          }`}
          style={{
            backgroundPosition: `${viewport.x}px ${viewport.y}px`,
            backgroundSize: "22px 22px",
          }}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerUp}
          onPointerCancel={handleCanvasPointerUp}
          onWheel={handleCanvasWheel}
        >
          <div
            className="absolute left-0 top-0 h-[620px] w-[1080px] origin-top-left"
            style={{
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
            }}
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
                node={node}
                selected={selectedNodeId === node.id}
                status={nodeStatuses[node.id]}
                onDelete={deleteNode}
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
          collapsed={inspectorCollapsed}
          node={selectedNode}
          nodes={workflow.nodes}
          workflow={workflow}
          width={inspectorWidth}
          onAddEdge={addEdge}
          onDeleteEdge={deleteEdge}
          onAgentChange={updateAgentConfig}
          onEdgeChange={updateEdge}
          onResizeStart={startInspectorResize}
          onNodeChange={(patch) => updateNode(selectedNode.id, patch)}
          onOperationChange={(patch) => updateNodeOperation(selectedNode.id, patch)}
          onSettingsChange={(patch) => updateNodeSettings(selectedNode.id, patch)}
          onToggleCollapsed={() => setInspectorCollapsed((current) => !current)}
          onTypeChange={(type) => updateNodeType(selectedNode.id, type)}
          onWorkflowChange={(patch) => onWorkflowChange({ ...workflow, ...patch })}
        />
      </div>
      <LogOverlay
        collapsed={logCollapsed}
        error={logState?.error}
        height={logHeight}
        loading={logState?.loading}
        logPath={logState?.path}
        text={displayedLog}
        title={logTitle}
        onResizeStart={startLogResize}
        onToggle={() => setLogCollapsed((current) => !current)}
      />
    </div>
  );
}

function extractNodeLog(logText, nodeId) {
  if (!logText || !nodeId) return "";
  const lines = logText.split("\n");
  const nodePrefix = ` - NODE - ${nodeId} - `;
  const timestampPattern = /^\d{4}-\d{2}-\d{2}T/;
  const selectedLines = [];
  let includeContinuation = false;

  for (const line of lines) {
    if (line.includes(nodePrefix)) {
      selectedLines.push(line);
      includeContinuation = true;
      continue;
    }

    if (timestampPattern.test(line)) {
      includeContinuation = false;
      continue;
    }

    if (includeContinuation) {
      selectedLines.push(line);
    }
  }

  return selectedLines.join("\n").trim();
}

function formatWorkflowRunLog(result) {
  if (!result) return "";

  const lines = [
    `Workflow ${result.workflowId} ${result.success ? "completed successfully" : "failed"}`,
    `Duration: ${Number(result.durationSeconds ?? 0).toFixed(2)}s`,
  ];

  for (const [nodeId, output] of Object.entries(result.nodeOutputs ?? {})) {
    const status = output.success ? "success" : "failed";
    lines.push("");
    lines.push(`${nodeId} - ${status} - exit ${output.exitCode ?? 0}`);
    if (output.output) {
      lines.push(output.output);
    }
    for (const fanOutput of output.fanOutputs ?? []) {
      lines.push("");
      lines.push(`${fanOutput.label}:`);
      lines.push(fanOutput.output);
    }
  }

  return lines.join("\n").trim();
}

function getNodeStatuses(nodes, runResult, logText) {
  const statuses = {};

  if (runResult?.nodeOutputs) {
    for (const [nodeId, output] of Object.entries(runResult.nodeOutputs)) {
      if (output.skipped) {
        statuses[nodeId] = "skipped";
      } else {
        statuses[nodeId] = output.success ? "success" : "error";
      }
    }
  }

  for (const node of nodes) {
    const logStatus = getNodeStatusFromLog(logText, node.id);
    if (logStatus) {
      statuses[node.id] = logStatus;
    }
  }

  return statuses;
}

function getNodeStatusFromLog(logText, nodeId) {
  if (!logText || !nodeId) return null;
  const nodeLines = extractNodeLog(logText, nodeId);
  if (!nodeLines) return null;

  if (nodeLines.includes("skipped")) return "skipped";
  const finishedMatches = [...nodeLines.matchAll(/finished success=(true|false)/gi)];
  if (finishedMatches.length) {
    return finishedMatches.at(-1)?.[1].toLowerCase() === "true" ? "success" : "error";
  }
  if (nodeLines.includes("attempt 1 started")) return "running";
  return null;
}

function LogOverlay({
  collapsed,
  error,
  height,
  loading,
  logPath,
  onResizeStart,
  onToggle,
  text,
  title,
}) {
  const displayText = error
    ? error
    : loading
      ? "Loading log..."
      : text?.trim()
        ? text.trim()
        : "No run log available.";

  return (
    <section
      className="relative z-30 shrink-0 overflow-hidden border-t border-line bg-white text-ink shadow-[0_-12px_30px_rgba(15,23,42,0.08)] transition-[height]"
      style={{ height: collapsed ? 44 : height }}
    >
      {!collapsed ? (
        <div
          className="absolute left-0 top-[-3px] z-20 h-1.5 w-full cursor-row-resize transition hover:bg-brand/40"
          role="separator"
          title="Resize workflow log"
          onPointerDown={onResizeStart}
        />
      ) : null}
      <button
        className="flex h-11 w-full items-center justify-between border-b border-line bg-[#f9fbfd] px-4 text-left transition hover:bg-slate-50"
        title={collapsed ? "Expand log" : "Collapse log"}
        type="button"
        onClick={onToggle}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-teal-100 bg-teal-50 text-teal-700">
            <Terminal size={15} />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{title}</h2>
            {logPath ? <p className="truncate text-[11px] text-muted">{logPath}</p> : null}
          </div>
        </div>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted">
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </button>
      <pre
        className="workflow-scrollbar overflow-auto whitespace-pre-wrap bg-white px-4 py-3 font-mono text-xs leading-5 text-slate-700"
        style={{ height: Math.max(0, height - 44) }}
      >
        {displayText}
      </pre>
    </section>
  );
}

function WorkflowNode({
  node,
  onDelete,
  selected,
  status,
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
      }`}
      style={{ left: node.x, top: node.y }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
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
        <div className="flex shrink-0 items-center gap-2">
          <NodeStatusBadge status={status} />
          <button
            className="grid h-6 w-6 place-items-center rounded-md text-muted transition hover:bg-red-50 hover:text-red-600"
            title="Delete node"
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onDelete(node.id);
            }}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <span className={`rounded-md border px-2 py-1 text-[11px] font-medium ${style.chip}`}>
          {node.type}
        </span>
      </div>
    </article>
  );
}

function NodeStatusBadge({ status }) {
  if (!status) return null;

  if (status === "running") {
    return <Loader2 size={13} className="animate-spin text-muted" />;
  }

  const className = {
    success: "bg-emerald-500",
    error: "bg-red-500",
    skipped: "border border-slate-400 bg-transparent",
  }[status];

  return <span className={`h-2.5 w-2.5 rounded-full ${className}`} />;
}

const edgeConditionOptions = [
  ["always", "Always"],
  ["on_success", "On success"],
  ["on_failure", "On failure"],
  ["output_matches", "Output matches"],
];

const compactEdgeConditionOptions = [
  ["always", "Always"],
  ["on_success", "Success"],
  ["on_failure", "Failure"],
  ["output_matches", "Matches"],
];

function Inspector({
  agents,
  collapsed,
  edges,
  node,
  nodes,
  workflow,
  onAddEdge,
  onAgentChange,
  onDeleteEdge,
  onEdgeChange,
  onNodeChange,
  onOperationChange,
  onResizeStart,
  onSettingsChange,
  onToggleCollapsed,
  onTypeChange,
  onWorkflowChange,
  width,
}) {
  const [workflowSettingsOpen, setWorkflowSettingsOpen] = useState(!node);
  const [nodeInspectorOpen, setNodeInspectorOpen] = useState(Boolean(node));
  const [cronPickerOpen, setCronPickerOpen] = useState(false);
  const [draftEdge, setDraftEdge] = useState(null);
  const operation = node?.operation ?? defaultOperation(node?.type ?? "agent");
  const settings = { ...defaultSettings, ...(node?.settings ?? {}) };
  const agentConfig =
    operation.type === "agent"
      ? agents[operation.agent_id] ?? defaultAgentConfig(operation.agent_id || "agent")
      : null;
  const schedule = workflow.schedule ?? null;
  const connectedEdges = node
    ? edges.filter((edge) => edge.from === node.id || edge.to === node.id)
    : [];

  useEffect(() => {
    setWorkflowSettingsOpen(!node);
    setNodeInspectorOpen(Boolean(node));
    setDraftEdge(null);
  }, [node?.id]);

  function updateWorkflowSchedule(patch) {
    const currentSchedule = schedule ?? { cron_expression: "0 9 * * *", timezone: "UTC" };
    const nextSchedule = { ...currentSchedule, ...patch };
    onWorkflowChange({ schedule: nextSchedule });
  }

  return (
    <aside
      className="relative shrink-0 overflow-visible border-l border-line bg-white transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
      style={{ width: collapsed ? 0 : width }}
    >
      {!collapsed ? (
        <div
          className="absolute left-[-3px] top-0 z-20 h-full w-1.5 cursor-col-resize transition hover:bg-brand/40"
          role="separator"
          title="Resize workflow settings and node inspector"
          onPointerDown={onResizeStart}
        />
      ) : null}
      <button
        className="absolute left-[-15px] top-1/2 z-40 grid h-12 w-7 -translate-y-1/2 place-items-center rounded-full border border-line bg-white text-muted shadow-panel transition hover:-translate-y-1/2 hover:scale-105 hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
        title={
          collapsed
            ? "Show workflow settings and node inspector"
            : "Hide workflow settings and node inspector"
        }
        type="button"
        onClick={onToggleCollapsed}
      >
        {collapsed ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
      </button>

      <div
        className={`workflow-scrollbar h-full overflow-y-auto transition-opacity duration-200 ${
          collapsed ? "pointer-events-none opacity-0" : "opacity-100 delay-100"
        }`}
      >
        <InspectorPanel
          open={workflowSettingsOpen}
          subtitle={workflow.id}
          title="Workflow settings"
          onToggle={() => setWorkflowSettingsOpen((current) => !current)}
        >
          <div className="space-y-4 p-4">
            <InspectorSection title="Workflow">
              <TextField label="ID" value={workflow.id} readOnly />
              <TextField
                label="Label"
                value={workflow.name}
                onChange={(value) => onWorkflowChange({ name: value })}
              />
              {workflow.sourcePath ? (
                <TextField label="Source path" value={workflow.sourcePath} readOnly />
              ) : null}
            </InspectorSection>

            <InspectorSection title="Schedule">
              <ToggleField
                checked={Boolean(schedule)}
                label="Scheduled"
                onChange={(checked) =>
                  onWorkflowChange({
                    schedule: checked
                      ? schedule ?? { cron_expression: "0 9 * * *", timezone: "UTC" }
                      : null,
                  })
                }
              />
              {schedule ? (
                <>
                  <CronExpressionField
                    label="Cron expression"
                    value={schedule.cron_expression ?? ""}
                    onChange={(value) => updateWorkflowSchedule({ cron_expression: value })}
                    placeholder="0 9 * * *"
                    pickerOpen={cronPickerOpen}
                    onPickerOpenChange={setCronPickerOpen}
                  />
                  <TextField
                    label="Timezone"
                    value={schedule.timezone ?? "UTC"}
                    onChange={(value) => updateWorkflowSchedule({ timezone: value })}
                    placeholder="UTC"
                  />
                </>
              ) : (
                <p className="text-sm leading-6 text-muted">
                  Turn scheduling on to persist a cron expression and timezone in the workflow TOML.
                </p>
              )}
            </InspectorSection>
          </div>
        </InspectorPanel>

        {node ? (
          <InspectorPanel
            open={nodeInspectorOpen}
            subtitle={node.id}
            title="Node inspector"
            onToggle={() => setNodeInspectorOpen((current) => !current)}
          >
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

          <InspectorSection title="Edges">
            <div className="space-y-3">
              <div className="grid grid-cols-[1.1fr_1fr_1fr] gap-2 px-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                <span>Type</span>
                <span>To</span>
                <span>From</span>
              </div>

              {connectedEdges.length || draftEdge ? (
                <div className="space-y-2">
                  {connectedEdges.map((edge) => (
                    <ConnectedEdgeEditor
                      key={edge.id}
                      edge={edge}
                      node={node}
                      nodes={nodes}
                      onDelete={() => onDeleteEdge(edge.id)}
                      onUpdate={(patch) => onEdgeChange(edge.id, patch)}
                    />
                  ))}
                  {draftEdge ? (
                    <ConnectedEdgeEditor
                      draft
                      edge={draftEdge}
                      node={node}
                      nodes={nodes}
                      onCancel={() => setDraftEdge(null)}
                      onCreate={(nextEdge) => {
                        onAddEdge(
                          nextEdge.from,
                          nextEdge.to,
                          nextEdge.condition,
                          nextEdge.outputPattern,
                        );
                        setDraftEdge(null);
                      }}
                      onUpdate={setDraftEdge}
                    />
                  ) : null}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-line bg-slate-50 px-3 py-4 text-sm text-muted">
                  This node has no connected edges.
                </p>
              )}
              {!draftEdge ? (
                <button
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-line text-sm font-medium text-muted transition hover:border-slate-300 hover:bg-slate-50 hover:text-ink"
                  type="button"
                  onClick={() =>
                    setDraftEdge({
                      id: "draft-edge",
                      from: "",
                      to: "",
                      condition: "",
                      outputPattern: null,
                    })
                  }
                >
                  <Plus size={15} />
                  Add edge
                </button>
              ) : null}
            </div>
          </InspectorSection>
            </div>
          </InspectorPanel>
        ) : null}
      </div>
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

function ConnectedEdgeEditor({
  draft = false,
  edge,
  node,
  nodes,
  onCancel,
  onCreate,
  onDelete,
  onUpdate,
}) {
  const blankOption = [["", "Select"]];
  const typeValue = edge.condition || (draft ? "" : "always");

  function updateDraft(patch) {
    onUpdate({ ...edge, ...patch });
  }

  function handleTypeChange(value) {
    const patch = {
      condition: value,
      outputPattern: value === "output_matches" ? edge.outputPattern || "" : null,
    };
    if (draft) {
      updateDraft(patch);
      return;
    }
    onUpdate(patch);
  }

  function handleToChange(value) {
    if (!value) {
      if (draft) updateDraft({ to: "", from: "" });
      return;
    }

    if (draft) {
      onCreate({
        ...edge,
        from: node.id,
        to: value,
        condition: edge.condition || "always",
      });
      return;
    }

    onUpdate({ from: node.id, to: value });
  }

  function handleFromChange(value) {
    if (!value) {
      if (draft) updateDraft({ from: "", to: "" });
      return;
    }

    if (draft) {
      onCreate({
        ...edge,
        from: value,
        to: node.id,
        condition: edge.condition || "always",
      });
      return;
    }

    onUpdate({ from: value, to: node.id });
  }

  function handleBlur(event) {
    if (!draft || edge.from || edge.to) return;
    if (event.currentTarget.contains(event.relatedTarget)) return;
    onCancel?.();
  }

  return (
    <div
      className="space-y-2"
      onBlur={handleBlur}
    >
      <div className="grid grid-cols-[1.1fr_1fr_1fr_auto] gap-2">
        <EdgeSelect
          value={typeValue}
          options={draft ? [["", "Select"], ...compactEdgeConditionOptions] : compactEdgeConditionOptions}
          onChange={handleTypeChange}
        />
        <EdgeSelect
          value={edge.to}
          options={
            draft ? [...blankOption, ...nodesForTo(node, nodes)] : endpointOptions(node, nodes, edge.to)
          }
          onChange={handleToChange}
        />
        <EdgeSelect
          value={edge.from}
          options={
            draft
              ? [...blankOption, ...nodesForFrom(node, nodes)]
              : endpointOptions(node, nodes, edge.from)
          }
          onChange={handleFromChange}
        />
        {!draft ? (
          <button
            className="grid h-9 w-8 place-items-center rounded-md text-muted transition hover:bg-red-50 hover:text-red-600"
            title="Delete edge"
            type="button"
            onClick={onDelete}
          >
            <Trash2 size={14} />
          </button>
        ) : (
          <span aria-hidden="true" className="h-9 w-8" />
        )}
      </div>
      {typeValue === "output_matches" ? (
        <InlineTextField
          value={edge.outputPattern ?? ""}
          onChange={(value) =>
            draft ? updateDraft({ outputPattern: value }) : onUpdate({ outputPattern: value })
          }
          placeholder="regex pattern"
        />
      ) : null}
    </div>
  );
}

function endpointOptions(node, nodes, currentValue) {
  return [
    ...(currentValue === node.id ? [[node.id, node.label || node.id]] : []),
    ...nodes
      .filter((candidate) => candidate.id !== node.id)
      .map((candidate) => [candidate.id, candidate.label || candidate.id]),
  ];
}

function nodesForTo(node, nodes) {
  return nodes
    .filter((candidate) => candidate.id !== node.id)
    .map((candidate) => [candidate.id, candidate.label || candidate.id]);
}

function nodesForFrom(node, nodes) {
  return nodes
    .filter((candidate) => candidate.id !== node.id)
    .map((candidate) => [candidate.id, candidate.label || candidate.id]);
}

function uniqueEdgeId(edges, fromNodeId, toNodeId) {
  const baseId = `${fromNodeId}-${toNodeId}`;
  if (!edges.some((edge) => edge.id === baseId)) {
    return baseId;
  }

  let index = 2;
  while (edges.some((edge) => edge.id === `${baseId}-${index}`)) {
    index += 1;
  }
  return `${baseId}-${index}`;
}

function edgeLabel(condition = "always", outputPattern = "") {
  if (condition === "always") return "always";
  if (condition === "output_matches" && outputPattern) return `matches ${outputPattern}`;
  return condition.replaceAll("_", " ");
}

function InspectorPanel({ children, open, subtitle, title, onToggle }) {
  return (
    <section className="border-b border-line">
      <button
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-slate-50"
        type="button"
        onClick={onToggle}
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink">{title}</span>
          <span className="mt-0.5 block truncate text-xs text-muted">{subtitle}</span>
        </span>
        {open ? (
          <ChevronUp className="shrink-0 text-muted" size={16} />
        ) : (
          <ChevronDown className="shrink-0 text-muted" size={16} />
        )}
      </button>
      {open ? children : null}
    </section>
  );
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

function InlineTextField({ onChange, placeholder, value }) {
  return (
    <input
      className="h-9 w-full rounded-lg border border-line bg-white px-2 text-sm outline-none transition placeholder:text-slate-400 focus:border-teal-500"
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function CronExpressionField({
  label,
  onChange,
  onPickerOpenChange,
  pickerOpen,
  placeholder,
  value,
}) {
  const today = new Date();
  const defaultDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(today.getDate()).padStart(2, "0")}`;
  const defaultTime = `${String(today.getHours()).padStart(2, "0")}:00`;
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState(defaultTime);
  const [recurrence, setRecurrence] = useState("weekly");
  const generatedCron = cronFromPicker({ date, recurrence, time });

  return (
    <div className="relative">
      <span className="text-xs font-medium text-muted">{label}</span>
      <div className="mt-1 flex h-10 overflow-hidden rounded-lg border border-line bg-white transition focus-within:border-teal-500">
        <input
          className="min-w-0 flex-1 bg-transparent px-3 text-sm outline-none"
          placeholder={placeholder}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          className="grid w-10 shrink-0 place-items-center border-l border-line text-muted transition hover:bg-slate-50 hover:text-ink"
          title="Pick schedule"
          type="button"
          onClick={() => onPickerOpenChange(!pickerOpen)}
        >
          <CalendarDays size={17} />
        </button>
      </div>

      {pickerOpen ? (
        <div className="absolute right-0 top-[68px] z-40 w-[270px] rounded-lg border border-line bg-white p-3 shadow-panel">
          <div className="space-y-3">
            <label className="block">
              <span className="text-xs font-medium text-muted">Recurrence</span>
              <select
                className="mt-1 h-9 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-teal-500"
                value={recurrence}
                onChange={(event) => setRecurrence(event.target.value)}
              >
                <option value="daily">Daily at this time</option>
                <option value="weekly">Weekly on this weekday</option>
                <option value="monthly">Monthly on this day</option>
                <option value="yearly">Yearly on this date</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-xs font-medium text-muted">Date</span>
                <input
                  className="mt-1 h-9 w-full rounded-lg border border-line bg-white px-2 text-sm outline-none transition focus:border-teal-500"
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-muted">Time</span>
                <input
                  className="mt-1 h-9 w-full rounded-lg border border-line bg-white px-2 text-sm outline-none transition focus:border-teal-500"
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                />
              </label>
            </div>
            <div className="rounded-lg border border-line bg-slate-50 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
                Cron
              </p>
              <p className="mt-1 font-mono text-sm text-ink">{generatedCron}</p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                className="h-8 rounded-lg border border-line px-3 text-sm text-muted transition hover:bg-slate-50 hover:text-ink"
                type="button"
                onClick={() => onPickerOpenChange(false)}
              >
                Cancel
              </button>
              <button
                className="h-8 rounded-lg border border-teal-700 bg-teal-700 px-3 text-sm font-medium text-white transition hover:bg-teal-800"
                type="button"
                onClick={() => {
                  onChange(generatedCron);
                  onPickerOpenChange(false);
                }}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function cronFromPicker({ date, recurrence, time }) {
  const [hour = "0", minute = "0"] = String(time || "00:00").split(":");
  const [, month = "1", day = "1"] = String(date || "").split("-");
  const weekday = date ? new Date(`${date}T00:00:00`).getDay() : "*";
  const cronMinute = Number(minute);
  const cronHour = Number(hour);
  const cronDay = Number(day);
  const cronMonth = Number(month);

  switch (recurrence) {
    case "daily":
      return `${cronMinute} ${cronHour} * * *`;
    case "monthly":
      return `${cronMinute} ${cronHour} ${cronDay} * *`;
    case "yearly":
      return `${cronMinute} ${cronHour} ${cronDay} ${cronMonth} *`;
    case "weekly":
    default:
      return `${cronMinute} ${cronHour} * * ${weekday}`;
  }
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

function EdgeSelect({ onChange, options, value }) {
  const selectedLabel = options.find(([optionValue]) => optionValue === value)?.[1] ?? "";

  return (
    <select
      className="h-9 min-w-0 rounded-lg border border-line bg-white px-1.5 text-xs outline-none transition focus:border-teal-500"
      title={selectedLabel}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map(([optionValue, labelText]) => (
        <option key={optionValue} value={optionValue}>
          {labelText}
        </option>
      ))}
    </select>
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
