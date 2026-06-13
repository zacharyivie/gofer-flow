import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  CircleDot,
  GitBranch,
  ListFilter,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Waypoints,
  X,
} from "lucide-react";
import DagCanvas from "../components/DagCanvas.jsx";

export default function App() {
  const [workflows, setWorkflows] = useState([]);
  const [activeWorkflowId, setActiveWorkflowId] = useState();
  const [query, setQuery] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [loadState, setLoadState] = useState({ loading: true, error: "" });
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createState, setCreateState] = useState({ saving: false, error: "" });
  const [dirtyWorkflow, setDirtyWorkflow] = useState();
  const [saveState, setSaveState] = useState({ saving: false, error: "" });
  const [runState, setRunState] = useState({ running: false, error: "", result: null });
  const saveRevisionRef = useRef(0);

  async function loadWorkflows() {
    setLoadState({ loading: true, error: "" });
    try {
      const response = await fetch("/api/workflows");
      if (!response.ok) {
        throw new Error(`Workflow API returned ${response.status}`);
      }
      const payload = await response.json();
      const nextWorkflows = (payload.workflows ?? []).map(summarizeWorkflow);
      setWorkflows(nextWorkflows);
      setDataDir(payload.dataDir ?? "");
      setActiveWorkflowId((currentId) => {
        if (nextWorkflows.some((workflow) => workflow.id === currentId)) {
          return currentId;
        }
        return nextWorkflows[0]?.id;
      });
      setLoadState({ loading: false, error: "" });
    } catch (error) {
      setLoadState({
        loading: false,
        error: error instanceof Error ? error.message : "Unable to load workflows",
      });
    }
  }

  useEffect(() => {
    loadWorkflows();
  }, []);

  useEffect(() => {
    if (!dirtyWorkflow) return undefined;

    const workflow = workflows.find((candidate) => candidate.id === dirtyWorkflow.id);
    if (!workflow) return undefined;

    const timeoutId = window.setTimeout(() => {
      saveWorkflow(workflow, dirtyWorkflow.revision);
    }, 650);

    return () => window.clearTimeout(timeoutId);
  }, [dirtyWorkflow, workflows]);

  const filteredWorkflows = useMemo(() => {
    return workflows.filter((workflow) => {
      const text = `${workflow.name} ${workflow.description} ${workflow.tags.join(" ")}`;
      return text.toLowerCase().includes(query.toLowerCase());
    });
  }, [query, workflows]);

  const activeWorkflow = workflows.find((workflow) => workflow.id === activeWorkflowId) ?? workflows[0];

  function updateActiveWorkflow(nextWorkflow) {
    const summarizedWorkflow = summarizeWorkflow(nextWorkflow);
    setWorkflows((current) =>
      current.map((workflow) =>
        workflow.id === summarizedWorkflow.id ? summarizedWorkflow : workflow,
      ),
    );
    saveRevisionRef.current += 1;
    setDirtyWorkflow({ id: summarizedWorkflow.id, revision: saveRevisionRef.current });
  }

  async function saveWorkflow(workflow, revision) {
    setSaveState({ saving: true, error: "" });
    try {
      const savedWorkflow = await persistWorkflow(workflow);

      if (saveRevisionRef.current === revision) {
        setWorkflows((current) =>
          current.map((candidate) =>
            candidate.id === savedWorkflow.id
              ? summarizeWorkflow(mergeSavedWorkflow(candidate, savedWorkflow))
              : candidate,
          ),
        );
        setDirtyWorkflow((current) => (current?.id === workflow.id ? undefined : current));
        setSaveState({ saving: false, error: "" });
      }
    } catch (error) {
      if (saveRevisionRef.current === revision) {
        setSaveState({
          saving: false,
          error: error instanceof Error ? error.message : "Unable to save workflow",
        });
      }
    }
  }

  async function persistWorkflow(workflow) {
    const response = await fetch(`/api/workflows/${encodeURIComponent(workflow.id)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(workflow),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `Workflow API returned ${response.status}`);
    }
    return payload.workflow;
  }

  async function runWorkflowNow(workflow) {
    const workflowToRun = summarizeWorkflow(workflow);
    saveRevisionRef.current += 1;
    setDirtyWorkflow(undefined);
    setRunState({ running: true, error: "", result: null });
    setSaveState({ saving: true, error: "" });

    try {
      const savedWorkflow = await persistWorkflow(workflowToRun);
      setWorkflows((current) =>
        current.map((candidate) =>
          candidate.id === savedWorkflow.id
            ? summarizeWorkflow(mergeSavedWorkflow(candidate, savedWorkflow))
            : candidate,
        ),
      );
      setSaveState({ saving: false, error: "" });

      const response = await fetch(`/api/workflows/${encodeURIComponent(savedWorkflow.id)}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ dryRun: false }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setRunState({ running: false, error: "", result: payload.run });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to run workflow";
      setRunState({ running: false, error: message, result: null });
      setSaveState((current) => ({ ...current, saving: false }));
    }
  }

  async function createWorkflow(name) {
    setCreateState({ saving: true, error: "" });
    try {
      const response = await fetch("/api/workflows", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }

      const nextWorkflow = summarizeWorkflow(payload.workflow);
      setWorkflows((current) => [...current, nextWorkflow]);
      setActiveWorkflowId(nextWorkflow.id);
      setQuery("");
      setCreateDialogOpen(false);
      setCreateState({ saving: false, error: "" });
    } catch (error) {
      setCreateState({
        saving: false,
        error: error instanceof Error ? error.message : "Unable to create workflow",
      });
    }
  }

  return (
    <main className="flex h-screen min-h-[720px] min-w-[1180px] bg-canvas text-ink">
      <WorkflowSidebar
        activeWorkflowId={activeWorkflow?.id}
        dataDir={dataDir}
        loading={loadState.loading}
        query={query}
        workflows={filteredWorkflows}
        onQueryChange={setQuery}
        onCreate={() => setCreateDialogOpen(true)}
        onRefresh={loadWorkflows}
        onSelect={setActiveWorkflowId}
      />

      <section className="flex min-w-0 flex-1 flex-col border-x border-line bg-[#f9fbfd]">
        {activeWorkflow ? (
          <>
            <TopBar saveState={saveState} workflow={activeWorkflow} />
            <DagCanvas
              runState={runState}
              workflow={activeWorkflow}
              onRunWorkflow={runWorkflowNow}
              onWorkflowChange={updateActiveWorkflow}
            />
          </>
        ) : (
          <EmptyWorkspace error={loadState.error} loading={loadState.loading} onRefresh={loadWorkflows} />
        )}
      </section>

      <ChatPane workflow={activeWorkflow} />
      <CreateWorkflowDialog
        error={createState.error}
        open={createDialogOpen}
        saving={createState.saving}
        onClose={() => {
          if (!createState.saving) {
            setCreateDialogOpen(false);
            setCreateState({ saving: false, error: "" });
          }
        }}
        onCreate={createWorkflow}
      />
    </main>
  );
}

function summarizeWorkflow(workflow) {
  const agentCount = agentIdsForWorkflow(workflow).length;
  const operationTypes = [...new Set((workflow.nodes ?? []).map((node) => node.type))].sort();
  const status = workflow.schedule ? "Scheduled" : "Ready";
  return {
    ...workflow,
    description: `${workflow.nodes.length} nodes, ${workflow.edges.length} edges, ${agentCount} agents.${
      workflow.schedule ? ` Scheduled with ${workflow.schedule.cron_expression}.` : ""
    }`,
    status,
    tags: [status.toLowerCase(), ...operationTypes.slice(0, 2)],
  };
}

function agentIdsForWorkflow(workflow) {
  return [
    ...new Set(
      (workflow.nodes ?? [])
        .filter((node) => node.type === "agent")
        .map((node) => node.operation?.agent_id)
        .filter(Boolean),
    ),
  ];
}

function mergeSavedWorkflow(localWorkflow, savedWorkflow) {
  const localNodesById = Object.fromEntries(
    (localWorkflow.nodes ?? []).map((node) => [node.id, node]),
  );
  return {
    ...localWorkflow,
    ...savedWorkflow,
    nodes: (savedWorkflow.nodes ?? []).map((node) => ({
      ...node,
      x: localNodesById[node.id]?.x ?? node.x,
      y: localNodesById[node.id]?.y ?? node.y,
      label: localNodesById[node.id]?.label ?? node.label,
    })),
  };
}

function WorkflowSidebar({
  activeWorkflowId,
  dataDir,
  loading,
  query,
  workflows,
  onCreate,
  onQueryChange,
  onRefresh,
  onSelect,
}) {
  return (
    <aside className="flex w-[292px] shrink-0 flex-col border-r border-line bg-white">
      <div className="border-b border-line px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand text-white">
              <Waypoints size={20} />
            </span>
            <div>
              <h1 className="text-base font-semibold leading-tight">Gofer Flow</h1>
              <p className="text-xs text-muted">Workflow studio</p>
            </div>
          </div>
          <button
            className="grid h-9 w-9 place-items-center rounded-lg border border-line text-muted transition hover:border-slate-300 hover:text-ink"
            title="Refresh workflows"
            type="button"
            onClick={onRefresh}
          >
            {loading ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
          </button>
        </div>

        <div className="mt-5 flex items-center gap-2 rounded-lg border border-line bg-slate-50 px-3 py-2">
          <Search size={16} className="text-muted" />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
            placeholder="Search workflows"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ListFilter size={16} className="text-muted" />
          Workflows
        </div>
        <button
          className="grid h-8 w-8 place-items-center rounded-lg bg-ink text-white transition hover:bg-slate-700"
          title="Create workflow"
          type="button"
          onClick={onCreate}
        >
          <Plus size={16} />
        </button>
      </div>

      <div className="workflow-scrollbar flex-1 space-y-2 overflow-y-auto px-3 pb-4">
        {workflows.length ? (
          workflows.map((workflow) => (
            <button
              key={workflow.id}
              className={`w-full rounded-lg border p-3 text-left transition ${
                workflow.id === activeWorkflowId
                  ? "border-teal-200 bg-teal-50 shadow-sm"
                  : "border-transparent bg-white hover:border-line hover:bg-slate-50"
              }`}
              type="button"
              onClick={() => onSelect(workflow.id)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{workflow.name}</p>
                  <p className="text-clamp-2 mt-1 text-xs leading-5 text-muted">
                    {workflow.description}
                  </p>
                </div>
                <StatusDot status={workflow.status} />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-1.5 text-center text-[11px] font-medium text-slate-600">
                <span className="rounded-md border border-slate-200 bg-white px-1.5 py-1">
                  {workflow.nodes.length} nodes
                </span>
                <span className="rounded-md border border-slate-200 bg-white px-1.5 py-1">
                  {workflow.edges.length} edges
                </span>
                <span className="rounded-md border border-slate-200 bg-white px-1.5 py-1">
                  {agentIdsForWorkflow(workflow).length} agents
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {workflow.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </button>
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-line bg-slate-50 p-4 text-sm leading-6 text-muted">
            {loading ? "Loading workflows..." : "No workflows found."}
          </div>
        )}
      </div>

      {dataDir ? (
        <div className="border-t border-line px-5 py-3 text-xs leading-5 text-muted">
          <span className="block truncate" title={dataDir}>
            {dataDir}
          </span>
        </div>
      ) : null}
    </aside>
  );
}

function TopBar({ saveState, workflow }) {
  return (
    <header className="flex h-[78px] shrink-0 items-center justify-between border-b border-line bg-white px-6">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted">
          <GitBranch size={14} />
          Visual DAG editor
        </div>
        <div className="mt-1 flex items-center gap-3">
          <h2 className="truncate text-xl font-semibold">{workflow.name}</h2>
          <span className="rounded-md border border-line px-2 py-1 text-xs font-medium text-muted">
            {workflow.nodes.length} nodes
          </span>
          <span className="rounded-md border border-line px-2 py-1 text-xs font-medium text-muted">
            {workflow.edges.length} edges
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span
          className={`rounded-md border px-2 py-1 text-xs font-medium ${
            saveState.error
              ? "border-red-200 bg-red-50 text-red-700"
              : saveState.saving
                ? "border-amber-200 bg-amber-50 text-amber-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {saveState.error ? "Save failed" : saveState.saving ? "Saving" : "Saved"}
        </span>
        <button
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm font-medium text-slate-700 transition hover:border-slate-300"
          type="button"
        >
          <Sparkles size={16} />
          Beautify
        </button>
        <button
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-white transition hover:bg-teal-700"
          type="button"
        >
          <Check size={16} />
          Validate
        </button>
      </div>
    </header>
  );
}

function ChatPane({ workflow }) {
  const [draft, setDraft] = useState("");
  const [providers, setProviders] = useState([]);
  const [providerId, setProviderId] = useState("codex");
  const [model, setModel] = useState("cli-default");
  const [chatState, setChatState] = useState({ sending: false, error: "" });
  const workflowName = workflow?.name ?? "No workflow selected";
  const [messages, setMessages] = useState([
    {
      id: "welcome",
      role: "assistant",
      body: "Ask me to explain, edit, validate, or design this workflow. I will use the bundled Gofer Flow workflow-builder skill.",
    },
  ]);

  useEffect(() => {
    async function loadProviders() {
      try {
        const response = await fetch("/api/chat/providers");
        if (!response.ok) return;
        const payload = await response.json();
        const nextProviders = payload.providers ?? [];
        setProviders(nextProviders);
        const availableProvider = nextProviders.find((provider) => provider.available);
        if (availableProvider) {
          setProviderId(availableProvider.id);
          setModel(availableProvider.models?.[0] ?? "cli-default");
        }
      } catch {
        setProviders([]);
      }
    }
    loadProviders();
  }, []);

  const selectedProvider =
    providers.find((provider) => provider.id === providerId) ??
    providers[0] ?? {
      id: "codex",
      name: "Codex",
      available: true,
      models: ["cli-default"],
    };

  async function sendMessage() {
    const text = draft.trim();
    if (!text || chatState.sending) return;

    const userMessage = {
      id: uniqueClientId(),
      role: "user",
      body: text,
    };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setDraft("");
    setChatState({ sending: true, error: "" });

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: providerId,
          model,
          messages: nextMessages.map(({ role, body }) => ({ role, body })),
          workflow,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Chat API returned ${response.status}`);
      }
      setMessages((current) => [
        ...current,
        {
          id: uniqueClientId(),
          role: "assistant",
          body: payload.message?.body ?? "",
        },
      ]);
      setChatState({ sending: false, error: "" });
    } catch (error) {
      setChatState({
        sending: false,
        error: error instanceof Error ? error.message : "Unable to send message",
      });
    }
  }

  return (
    <aside className="flex w-[356px] shrink-0 flex-col border-l border-line bg-white">
      <div className="border-b border-line px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 place-items-center rounded-lg bg-slate-900 text-white">
            {chatState.sending ? <Loader2 size={19} className="animate-spin" /> : <Bot size={19} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold">Workflow assistant</h2>
                <p className="truncate text-xs text-muted">{workflowName}</p>
              </div>
              <span
                className={`shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium ${
                  selectedProvider.available
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-red-200 bg-red-50 text-red-700"
                }`}
              >
                {selectedProvider.available ? "Ready" : "Missing CLI"}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <select
                className="h-9 rounded-lg border border-line bg-white px-2 text-xs outline-none transition focus:border-teal-500"
                value={providerId}
                onChange={(event) => {
                  const nextProvider = providers.find(
                    (provider) => provider.id === event.target.value,
                  );
                  setProviderId(event.target.value);
                  setModel(nextProvider?.models?.[0] ?? "cli-default");
                }}
              >
                {(providers.length ? providers : [selectedProvider]).map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
              <select
                className="h-9 rounded-lg border border-line bg-white px-2 text-xs outline-none transition focus:border-teal-500"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {(selectedProvider.models ?? ["cli-default"]).map((modelName) => (
                  <option key={modelName} value={modelName}>
                    {modelName}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div className="workflow-scrollbar flex-1 space-y-4 overflow-y-auto px-5 py-5">
        <div className="rounded-lg border border-line bg-slate-50 p-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
            <CircleDot size={14} />
            Context
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-700">
            {workflow?.description ?? "Select a workflow to set context."}
          </p>
          <p className="mt-2 text-xs leading-5 text-muted">
            Gofer Flow skill context is injected server-side for every message.
          </p>
        </div>

        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[86%] rounded-lg px-3 py-2 text-sm leading-6 ${
                message.role === "user"
                  ? "bg-brand text-white"
                  : "border border-line bg-white text-slate-700 shadow-sm"
              }`}
            >
              <pre className="whitespace-pre-wrap font-sans">{message.body}</pre>
            </div>
          </div>
        ))}
        {chatState.error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 text-red-700">
            {chatState.error}
          </div>
        ) : null}
      </div>

      <div className="border-t border-line p-4">
        <div className="rounded-lg border border-line bg-slate-50 p-2">
          <textarea
            className="h-20 w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-slate-400"
            placeholder="Ask about this workflow"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                sendMessage();
              }
            }}
          />
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2 text-xs text-muted">
              <MessageSquare size={14} />
              {selectedProvider.name} · {model}
            </div>
            <button
              className="grid h-8 w-8 place-items-center rounded-lg bg-ink text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={chatState.sending || !draft.trim()}
              title="Send message"
              type="button"
              onClick={sendMessage}
            >
              {chatState.sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function uniqueClientId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function CreateWorkflowDialog({ error, open, saving, onClose, onCreate }) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
    }
  }, [open]);

  if (!open) return null;

  function handleSubmit(event) {
    event.preventDefault();
    onCreate(name);
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/30 px-4">
      <form
        className="w-full max-w-[420px] rounded-lg border border-line bg-white shadow-panel"
        onSubmit={handleSubmit}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">New workflow</h2>
            <p className="text-xs text-muted">Stored in the Gofer data directory</p>
          </div>
          <button
            className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-slate-100 hover:text-ink"
            disabled={saving}
            title="Close"
            type="button"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>

        <div className="space-y-3 px-5 py-5">
          <label className="block">
            <span className="text-xs font-medium text-muted">Name</span>
            <input
              autoFocus
              className="mt-1 h-10 w-full rounded-lg border border-line px-3 text-sm outline-none transition focus:border-teal-500"
              disabled={saving}
              placeholder="Daily Analysis"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 text-red-700">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
          <button
            className="h-9 rounded-lg border border-line bg-white px-3 text-sm font-medium text-slate-700 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={saving}
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={saving || !name.trim()}
            type="submit"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            Create
          </button>
        </div>
      </form>
    </div>
  );
}

function EmptyWorkspace({ error, loading, onRefresh }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-md rounded-lg border border-line bg-white p-6 text-center shadow-panel">
        <div className="mx-auto grid h-11 w-11 place-items-center rounded-lg bg-slate-100 text-slate-700">
          {loading ? <Loader2 size={22} className="animate-spin" /> : <AlertCircle size={22} />}
        </div>
        <h2 className="mt-4 text-base font-semibold">
          {loading ? "Loading workflows" : "No workflow selected"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          {error || "Create or save a workflow TOML file in the Gofer data directory."}
        </p>
        <button
          className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-ink px-3 text-sm font-medium text-white transition hover:bg-slate-700"
          type="button"
          onClick={onRefresh}
        >
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>
    </div>
  );
}

function StatusDot({ status }) {
  const color = {
    Ready: "bg-emerald-500",
    Draft: "bg-amber-500",
    Scheduled: "bg-sky-500",
  }[status];

  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-white px-2 py-1 text-[11px] font-medium text-slate-600">
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
      {status}
    </span>
  );
}
