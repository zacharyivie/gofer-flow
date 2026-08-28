import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  Download,
  FolderOpen,
  GitBranch,
  History,
  Loader2,
  Moon,
  MoreVertical,
  Plus,
  PencilLine,
  Play,
  RefreshCw,
  Save,
  Search,
  Send,
  Square,
  Sun,
  Trash2,
  Waypoints,
  X,
} from "lucide-react";
import DagCanvas, { autoLayoutWorkflow } from "../components/DagCanvas.jsx";
import { Dialog } from "../components/Dialog.jsx";
import CodeFileExplorer from "../components/CodeFileExplorer.jsx";
import CodeWorkspace, { applyCodeFilesystemChange } from "../components/CodeWorkspace.jsx";
import {
  ProviderModelEffortFields,
  useProviderCapabilities,
} from "../components/ProviderModelEffortFields.jsx";
import { apiUrl } from "../lib/api.js";

const RETENTION_STORAGE_KEY = "gofer.retentionSettings";
const PROJECT_LABELS_STORAGE_KEY = "gofer.projectLabels";
const DEFAULT_RETENTION_SETTINGS = {
  keepDays: 14,
  keepFailedDays: 30,
  keepLast: 100,
};
const RUN_LOG_TAIL_BYTES = 64 * 1024;

export function prefersReducedMotion() {
  return typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

function loadRetentionSettings() {
  if (typeof window === "undefined") return DEFAULT_RETENTION_SETTINGS;
  try {
    const stored = window.localStorage?.getItem(RETENTION_STORAGE_KEY);
    if (!stored) return DEFAULT_RETENTION_SETTINGS;
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return DEFAULT_RETENTION_SETTINGS;
    return {
      keepDays: Number.isFinite(parsed.keepDays)
        ? parsed.keepDays
        : DEFAULT_RETENTION_SETTINGS.keepDays,
      keepFailedDays: Number.isFinite(parsed.keepFailedDays)
        ? parsed.keepFailedDays
        : DEFAULT_RETENTION_SETTINGS.keepFailedDays,
      keepLast: Number.isFinite(parsed.keepLast)
        ? parsed.keepLast
        : DEFAULT_RETENTION_SETTINGS.keepLast,
    };
  } catch {
    return DEFAULT_RETENTION_SETTINGS;
  }
}

function isBundleFile(file) {
  const name = file?.name?.toLowerCase?.() ?? "";
  return name.endsWith(".zip") || name.endsWith(".gof");
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return window.btoa(binary);
}

function formatBundleImportPreview(plan) {
  const manifest = plan.manifest ?? {};
  const promptPaths = (manifest.includedPaths ?? [])
    .filter((item) => item.kind === "prompt" || item.kind === "prompt_template")
    .map((item) => `${item.path}${item.kind === "prompt_template" ? " (template)" : ""}`);
  const lines = [
    `Import bundle "${plan.workflowName}" as ${plan.workflowId}?`,
    "",
    "Files to create:",
    ...previewLines(plan.filesToCreate),
    "",
    "Files to overwrite:",
    ...previewLines(plan.filesToOverwrite),
    "",
    "Agents and providers:",
    ...previewProviderLines(manifest.providerAssumptions),
    "",
    "Prompts:",
    ...previewLines(promptPaths),
    "",
    "Triggers:",
    ...previewTriggerLines(manifest.triggers),
  ];
  if (plan.conflicts?.length) {
    lines.push("", "Conflicts:", ...plan.conflicts.map((item) => `- ${item.path}: ${item.action}`));
  }
  if (plan.requiredSecrets?.length) {
    lines.push("", "Required secrets:", ...plan.requiredSecrets.map((item) => `- ${item.name}`));
  }
  if (plan.externalRequirements?.length) {
    lines.push(
      "",
      "External requirements:",
      ...plan.externalRequirements.map((item) => `- ${item.path}: ${item.reason}`),
    );
  }
  return lines.join("\n");
}

function previewLines(items = []) {
  return items.length ? items.map((item) => `- ${item}`) : ["- None"];
}

function previewProviderLines(items = []) {
  if (!items.length) return ["- None"];
  return items.map((item) => {
    const details = [item.subscription, item.profile && `profile ${item.profile}`, item.model].filter(
      Boolean,
    );
    return `- ${item.agentId}: ${details.join(", ")}`;
  });
}

function previewTriggerLines(items = []) {
  if (!items.length) return ["- None"];
  return items.map((item) => {
    if (item.type === "schedule") {
      return `- schedule: ${item.cron} (${item.timezone})`;
    }
    if (item.type === "watch") {
      return `- watch: ${item.path} ${item.glob} (${item.mode})`;
    }
    if (item.type === "webhook") {
      const details = [item.source, item.enabled === "true" ? "enabled" : "disabled"];
      if (item.tokenEnv) details.push(`secret ${item.tokenEnv}`);
      if (item.fanoutPath) details.push(`fanout ${item.fanoutPath}`);
      return `- webhook ${item.id}: ${details.join(", ")}`;
    }
    return `- ${item.type ?? "trigger"}`;
  });
}

export default function App() {
  const [workflows, setWorkflows] = useState([]);
  const [promptAgentIds, setPromptAgentIds] = useState([]);
  const [activeWorkflowId, setActiveWorkflowId] = useState();
  const [studioView, setStudioView] = useState("graph");
  const [codeEditorOpened, setCodeEditorOpened] = useState(false);
  const [codeOpenPaths, setCodeOpenPaths] = useState([]);
  const [activeCodePath, setActiveCodePath] = useState("");
  const [radishEditorState, setRadishEditorState] = useState(null);
  const [query, setQuery] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [loadState, setLoadState] = useState({ loading: true, error: "" });
  const [doctorState, setDoctorState] = useState({
    loading: true,
    error: "",
    errors: [],
    warnings: [],
  });
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createState, setCreateState] = useState({ saving: false, error: "" });
  const [exportDialog, setExportDialog] = useState({
    error: "",
    outputPath: "",
    saving: false,
    workflow: null,
  });
  const [workflowTemplates, setWorkflowTemplates] = useState([]);
  const [historyState, setHistoryState] = useState({
    diff: null,
    error: "",
    loading: false,
    open: false,
    revisions: [],
  });
  const [dirtyWorkflowsById, setDirtyWorkflowsById] = useState({});
  const [saveStatesByWorkflowId, setSaveStatesByWorkflowId] = useState({});
  const [topBarNotice, setTopBarNotice] = useState({ type: "", message: "" });
  const [runPreview, setRunPreview] = useState(null);
  const [executionMode, setExecutionMode] = useState("local");
  const [queueState, setQueueState] = useState({ runners: [], runs: [], error: "" });
  const [retentionSettings, setRetentionSettings] = useState(loadRetentionSettings);
  const [updateState, setUpdateState] = useState({
    available: false,
    checking: false,
    error: "",
    info: null,
  });
  const [runState, setRunState] = useState({ running: false, error: "", result: null });
  const [logState, setLogState] = useState({
    loading: false,
    error: "",
    text: "",
    path: null,
    nodeOutputs: null,
    nodeOutputsTruncated: false,
    nodeOutputsMaxBytes: null,
    usageSummary: null,
    runEvents: [],
    runNodes: {},
    runs: [],
    selectedRunId: null,
  });
  const [approvalState, setApprovalState] = useState({
    approvals: [],
    error: "",
    loading: false,
  });
  const [theme, setTheme] = useState(getInitialTheme);
  const [workflowPaneWidth, setWorkflowPaneWidth] = useState(272);
  const [chatPaneWidth, setChatPaneWidth] = useState(380);
  const workflowRevisionsRef = useRef(new Map());
  const dirtyWorkflowsRef = useRef(new Map());
  const saveTimersRef = useRef(new Map());
  const inFlightSavesRef = useRef(new Map());
  const deletedWorkflowIdsRef = useRef(new Set());
  const logRequestRef = useRef(0);
  const radishEditorRef = useRef(null);
  const radishEditorStateRef = useRef(null);
  const radishMetadataSaveTimerRef = useRef(null);
  const radishMetadataPendingRef = useRef(false);
  const activeWorkflow = workflows.find((workflow) => workflow.id === activeWorkflowId) ?? workflows[0];
  const graphWorkflow = useMemo(
    () => radishGraphWorkflow(activeWorkflow, radishEditorState?.document),
    [activeWorkflow, radishEditorState?.document],
  );

  useEffect(() => {
    radishEditorStateRef.current = radishEditorState;
  }, [radishEditorState]);

  useEffect(() => {
    radishMetadataPendingRef.current = false;
    window.clearTimeout(radishMetadataSaveTimerRef.current);
  }, [activeWorkflow?.id]);

  useEffect(() => {
    const sourcePath = activeWorkflow?.sourceFormat === "radish"
      ? activeWorkflow.sourcePath ?? ""
      : "";
    setCodeOpenPaths(sourcePath ? [sourcePath] : []);
    setActiveCodePath(sourcePath);
  }, [activeWorkflow?.id, activeWorkflow?.sourceFormat, activeWorkflow?.sourcePath]);

  useEffect(() => {
    if (studioView === "code" && activeWorkflow?.sourceFormat !== "radish") {
      setStudioView("graph");
    }
  }, [activeWorkflow?.sourceFormat, studioView]);

  useEffect(() => {
    if (codeEditorOpened || activeWorkflow?.sourceFormat !== "radish") return undefined;
    const controller = new AbortController();
    setRadishEditorState({ document: null, error: "", loading: true, saving: false });
    fetch(apiUrl(`/workflows/${encodeURIComponent(activeWorkflow.id)}/document`), {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `Editor API returned ${response.status}`);
        setRadishEditorState({
          document: payload.document,
          error: "",
          loading: false,
          saving: false,
        });
      })
      .catch((error) => {
        if (error?.name === "AbortError") return;
        setRadishEditorState({
          document: null,
          error: error instanceof Error ? error.message : "Unable to load the Radish graph",
          loading: false,
          saving: false,
        });
      });
    return () => controller.abort();
  }, [activeWorkflow?.id, activeWorkflow?.sourceFormat, codeEditorOpened]);

  function changeStudioView(nextView) {
    if (nextView === "code" && activeWorkflow?.sourceFormat !== "radish") return;
    setQuery("");
    setStudioView(nextView);
    if (nextView === "code") setCodeEditorOpened(true);
  }

  function openCodeFile(path) {
    if (!path || activeWorkflow?.sourceFormat !== "radish") return;
    setCodeOpenPaths((current) => current.includes(path) ? current : [...current, path]);
    setActiveCodePath(path);
    setCodeEditorOpened(true);
    setStudioView("code");
  }

  function closeCodeFile(path) {
    if (!path || path === activeWorkflow?.sourcePath) return;
    setCodeOpenPaths((current) => {
      const index = current.indexOf(path);
      const next = current.filter((candidate) => candidate !== path);
      if (activeCodePath === path) {
        setActiveCodePath(next[Math.max(0, index - 1)] ?? activeWorkflow?.sourcePath ?? "");
      }
      return next;
    });
  }

  function handleCodeFilesystemChange(change) {
    applyCodeFilesystemChange(change);
    void loadWorkflows({ silent: true });
    if (!change?.path) return;
    if (change.kind === "rename" && change.sourcePath) {
      setCodeOpenPaths((current) => current.map((path) =>
        replacePathPrefix(path, change.sourcePath, change.path, change.isDirectory),
      ));
      setActiveCodePath((current) =>
        replacePathPrefix(current, change.sourcePath, change.path, change.isDirectory));
    }
    if (change.kind === "delete") {
      setCodeOpenPaths((current) => {
        const next = current.filter((path) => !pathMatchesChange(path, change.path, change.isDirectory));
        if (pathMatchesChange(activeCodePath, change.path, change.isDirectory)) {
          setActiveCodePath(next.at(-1) ?? activeWorkflow?.sourcePath ?? "");
        }
        return next;
      });
    }
  }

  async function mutateActiveRadish(mutations) {
    if (activeWorkflow?.sourceFormat !== "radish" || !mutations?.length) return null;
    if (radishMetadataPendingRef.current) {
      const metadataSaved = await saveRadishMetadataNow(activeWorkflow.id);
      if (!metadataSaved) return null;
    }
    let currentDocument = radishEditorStateRef.current?.document;
    if (!currentDocument) return null;
    if (currentDocument.dirty) {
      currentDocument = await radishEditorRef.current?.save?.();
      if (!currentDocument) {
        setTopBarNotice({
          type: "error",
          message: "Save the current code changes before editing the graph.",
        });
        return null;
      }
    }
    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(activeWorkflow.id)}/document/mutate`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mutations,
            expectedRevision: currentDocument.savedRevision,
          }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? "workflow.rad changed on disk. Reload it before editing the graph."
            : payload.error || `Graph edit returned ${response.status}`,
        );
      }
      const nextState = {
        document: payload.document,
        error: "",
        loading: false,
        saving: false,
      };
      radishEditorStateRef.current = nextState;
      setRadishEditorState(nextState);
      radishEditorRef.current?.acceptDocument?.(payload.document);
      setTopBarNotice({ type: "success", message: "Updated workflow.rad" });
      void loadWorkflows({ silent: true });
      return payload.document;
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to edit workflow.rad",
      });
      return null;
    }
  }

  function updateRadishGraphMetadata(nextWorkflow) {
    const currentState = radishEditorStateRef.current;
    const document = currentState?.document;
    if (!document || activeWorkflow?.sourceFormat !== "radish") return;
    const nodes = Object.fromEntries(
      (nextWorkflow.nodes ?? []).map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]),
    );
    const metadata = {
      ...document.metadata,
      canvas: {
        ...document.metadata.canvas,
        nodes,
      },
    };
    const nextState = {
      ...currentState,
      document: { ...document, metadata },
    };
    radishEditorStateRef.current = nextState;
    setRadishEditorState(nextState);
    radishMetadataPendingRef.current = true;
    window.clearTimeout(radishMetadataSaveTimerRef.current);
    radishMetadataSaveTimerRef.current = window.setTimeout(
      () => void saveRadishMetadataNow(activeWorkflow.id),
      250,
    );
  }

  async function saveRadishMetadataNow(workflowId) {
    window.clearTimeout(radishMetadataSaveTimerRef.current);
    const latestState = radishEditorStateRef.current;
    const latest = latestState?.document;
    if (!latest || !radishMetadataPendingRef.current) return true;
    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflowId)}/metadata`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            metadata: latest.metadata,
            expectedRevision: latest.metadataRevision,
          }),
        },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Metadata save returned ${response.status}`);
      radishMetadataPendingRef.current = false;
      setRadishEditorState((state) => {
        if (!state?.document) return state;
        const saved = {
          ...state,
          document: {
            ...state.document,
            metadata: payload.metadata,
            metadataRevision: payload.metadataRevision,
          },
        };
        radishEditorStateRef.current = saved;
        return saved;
      });
      return true;
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to save graph layout",
      });
      return false;
    }
  }

  const loadWorkflows = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoadState({ loading: true, error: "" });
    }
    try {
      const response = await fetch(apiUrl("/workflows"));
      if (!response.ok) {
        throw new Error(`Workflow API returned ${response.status}`);
      }
      const payload = await response.json();
      const payloadDataDir = payload.dataDir ?? "";
      setPromptAgentIds(payload.promptAgentIds ?? []);
      const listedWorkflows = payload.workflows ?? [];
      const nextWorkflows = listedWorkflows
        .filter(
          (workflow) =>
            payload.authoringLanguage !== "radish" || workflow.sourceFormat === "radish",
        )
        .filter((workflow) => !deletedWorkflowIdsRef.current.has(workflow.id))
        .map((workflow) => summarizeWorkflow(workflow, payloadDataDir));
      setWorkflows((current) => {
        const refreshedWorkflows = nextWorkflows.map((workflow) => {
          const localWorkflow = current.find((candidate) => candidate.id === workflow.id);
          return localWorkflow
            ? summarizeWorkflow(mergeSavedWorkflow(localWorkflow, workflow), payloadDataDir)
            : workflow;
        });
        const mergedWorkflows = silent
          ? [...dirtyWorkflowsRef.current.keys()].reduce((workflowsToMerge, workflowId) => {
              if (deletedWorkflowIdsRef.current.has(workflowId)) return workflowsToMerge;
              const localDirtyWorkflow = current.find((workflow) => workflow.id === workflowId);
              return localDirtyWorkflow
                ? preserveLocalWorkflow(workflowsToMerge, localDirtyWorkflow, payloadDataDir)
                : workflowsToMerge;
            }, refreshedWorkflows)
          : refreshedWorkflows;

        return silent && JSON.stringify(current) === JSON.stringify(mergedWorkflows)
          ? current
          : mergedWorkflows;
      });
      setDataDir(payload.dataDir ?? "");
      setActiveWorkflowId((currentId) => {
        if (nextWorkflows.some((workflow) => workflow.id === currentId)) {
          return currentId;
        }
        return nextWorkflows[0]?.id;
      });
      setLoadState({ loading: false, error: "" });
    } catch (error) {
      if (!silent) {
        setLoadState({
          loading: false,
          error: error instanceof Error ? error.message : "Unable to load workflows",
        });
      }
    }
  }, []);

  const loadWorkflowTemplates = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/workflow-templates"));
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setWorkflowTemplates(payload.templates ?? []);
    } catch {
      setWorkflowTemplates([]);
    }
  }, []);

  const loadDoctor = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setDoctorState((current) => ({ ...current, loading: true, error: "" }));
    }
    try {
      const response = await fetch(apiUrl("/doctor"));
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Doctor API returned ${response.status}`);
      }
      setDoctorState({
        loading: false,
        error: "",
        errors: payload.errors ?? [],
        warnings: payload.warnings ?? [],
      });
    } catch (error) {
      if (!silent) {
        setDoctorState({
          loading: false,
          error: error instanceof Error ? error.message : "Unable to load health checks",
          errors: [],
          warnings: [],
        });
      }
    }
  }, []);

  const loadQueue = useCallback(async ({ silent = false } = {}) => {
    try {
      const response = await fetch(apiUrl("/queue"));
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Queue API returned ${response.status}`);
      }
      setQueueState({
        runners: payload.runners ?? [],
        runs: payload.runs ?? [],
        error: "",
      });
    } catch (error) {
      if (!silent) {
        setQueueState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "Unable to load runners",
        }));
      }
    }
  }, []);

  useEffect(() => {
    loadWorkflows();
  }, [loadWorkflows]);

  useEffect(() => {
    loadWorkflowTemplates();
  }, [loadWorkflowTemplates]);

  useEffect(() => {
    loadDoctor();
    loadQueue();
  }, [loadDoctor, loadQueue]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      loadWorkflows({ silent: true });
      loadDoctor({ silent: true });
      loadQueue({ silent: true });
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [loadDoctor, loadQueue, loadWorkflows]);

  useEffect(() => {
    window.localStorage.setItem("gofer-ui-theme", theme);
  }, [theme]);

  const loadRetentionSettingsForWorkflow = useCallback(async (workflowId) => {
    if (!workflowId) return;
    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflowId)}/retention`),
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      if (payload.settings) {
        setRetentionSettings(payload.settings);
        window.localStorage?.setItem(RETENTION_STORAGE_KEY, JSON.stringify(payload.settings));
      }
    } catch {
      setRetentionSettings(loadRetentionSettings());
    }
  }, []);

  const saveRetentionSettingsForWorkflow = useCallback(async (workflowId, nextSettings) => {
    setRetentionSettings(nextSettings);
    window.localStorage?.setItem(RETENTION_STORAGE_KEY, JSON.stringify(nextSettings));
    if (!workflowId) return;
    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflowId)}/retention`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(nextSettings),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      if (payload.settings) {
        setRetentionSettings(payload.settings);
        window.localStorage?.setItem(RETENTION_STORAGE_KEY, JSON.stringify(payload.settings));
      }
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message:
          error instanceof Error ? error.message : "Unable to save retention settings",
      });
    }
  }, []);

  const checkForUpdates = useCallback(async ({ silent = false } = {}) => {
    if (!window.goferUpdates?.check) return;
    setUpdateState((current) => ({
      ...current,
      checking: true,
      error: silent ? current.error : "",
    }));
    try {
      const info = await window.goferUpdates.check();
      setUpdateState({
        available: Boolean(info?.available),
        checking: false,
        error: "",
        info,
      });
      if (!silent) {
        setTopBarNotice({
          type: info?.available ? "success" : "success",
          message: info?.available
            ? `Taskurotta ${info.info?.version ?? "update"} is available`
            : info?.info?.noReleases
              ? "No published Taskurotta releases yet"
            : "Taskurotta is up to date",
        });
      }
    } catch (error) {
      setUpdateState((current) => ({
        ...current,
        checking: false,
        error: error instanceof Error ? error.message : "Unable to check for updates",
      }));
      if (!silent) {
        setTopBarNotice({
          type: "error",
          message: error instanceof Error ? error.message : "Unable to check for updates",
        });
      }
    }
  }, []);

  useEffect(() => {
    if (!window.goferUpdates?.onState) return undefined;
    const unsubscribe = window.goferUpdates.onState((nextState) => {
      setUpdateState((current) => ({ ...current, ...nextState }));
    });
    window.goferUpdates.getState?.().then((nextState) => {
      setUpdateState((current) => ({ ...current, ...nextState }));
    }).catch(() => {});
    return unsubscribe;
  }, []);

  useEffect(() => {
    checkForUpdates({ silent: true });
  }, [checkForUpdates]);

  async function applyUpdate(update) {
    if (!window.goferUpdates) return;
    try {
      const nextState = update.downloaded
        ? await window.goferUpdates.installDownloaded()
        : await window.goferUpdates.downloadAndInstall();
      setUpdateState((current) => ({ ...current, ...nextState }));
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to apply update",
      });
    }
  }

  useEffect(() => {
    if (!topBarNotice?.message) return undefined;

    const timeoutId = window.setTimeout(() => {
      setTopBarNotice({ type: "", message: "" });
    }, 3500);

    return () => window.clearTimeout(timeoutId);
  }, [topBarNotice?.message]);

  const loadLatestLog = useCallback(async (workflowId, { silent = false } = {}) => {
    const requestId = logRequestRef.current + 1;
    logRequestRef.current = requestId;
    if (!silent) {
      setLogState((current) => ({ ...current, loading: true, error: "" }));
    }
    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflowId)}/logs/latest`),
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      if (requestId !== logRequestRef.current) return;
      const nextText = payload.log?.logText ?? "";
      const nextPath = payload.log?.logPath ?? null;
      const nextNodeOutputs = payload.log?.nodeOutputs ?? null;
      const nextUsageSummary = payload.log?.usageSummary ?? null;
      const nextRunEvents = payload.log?.runEvents ?? [];
      const nextRunNodes = payload.log?.runNodes ?? {};
      setLogState((current) => {
        if (
          current.text === nextText &&
          current.path === nextPath &&
          JSON.stringify(current.nodeOutputs ?? null) === JSON.stringify(nextNodeOutputs) &&
          JSON.stringify(current.usageSummary ?? null) === JSON.stringify(nextUsageSummary) &&
          JSON.stringify(current.runEvents ?? []) === JSON.stringify(nextRunEvents) &&
          JSON.stringify(current.runNodes ?? {}) === JSON.stringify(nextRunNodes) &&
          current.error === "" &&
          current.loading === false
        ) {
          return current;
        }
        return {
          loading: false,
          error: "",
          text: nextText,
          path: nextPath,
          nodeOutputs: nextNodeOutputs,
          nodeOutputsTruncated: Boolean(payload.log?.nodeOutputsTruncated),
          nodeOutputsMaxBytes: payload.log?.nodeOutputsMaxBytes ?? null,
          usageSummary: nextUsageSummary,
          runEvents: nextRunEvents,
          runNodes: nextRunNodes,
          runs: current.runs,
          selectedRunId: null,
        };
      });
    } catch (error) {
      if (requestId !== logRequestRef.current) return;
      if (!silent) {
        setLogState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Unable to load workflow log",
        }));
      }
    }
  }, []);

  const loadRunLogs = useCallback(async (workflowId, { silent = false } = {}) => {
    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflowId)}/logs?limit=100`),
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setLogState((current) => {
        const nextRuns = payload.runs ?? [];
        if (silent && JSON.stringify(current.runs) === JSON.stringify(nextRuns)) {
          return current;
        }
        return { ...current, runs: nextRuns };
      });
    } catch (error) {
      if (!silent) {
        setLogState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "Unable to load workflow runs",
        }));
      }
    }
  }, []);

  const loadRunLog = useCallback(async (workflowId, runId, { silent = false } = {}) => {
    const requestId = logRequestRef.current + 1;
    logRequestRef.current = requestId;
    if (!silent) {
      setLogState((current) => ({
        ...current,
        loading: true,
        error: "",
        selectedRunId: runId,
      }));
    }
    try {
      const params = new URLSearchParams({
        tailBytes: String(RUN_LOG_TAIL_BYTES),
        details: silent ? "0" : "1",
      });
      const response = await fetch(
        apiUrl(
          `/workflows/${encodeURIComponent(workflowId)}/logs/${encodeURIComponent(runId)}?${params}`,
        ),
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      if (requestId !== logRequestRef.current) return;
      setLogState((current) => ({
        ...current,
        loading: false,
        error: "",
        text: payload.log?.logText ?? "",
        path: payload.log?.logPath ?? null,
        nodeOutputs: silent ? current.nodeOutputs : (payload.log?.nodeOutputs ?? null),
        nodeOutputsTruncated: silent
          ? current.nodeOutputsTruncated
          : Boolean(payload.log?.nodeOutputsTruncated),
        nodeOutputsMaxBytes: silent
          ? current.nodeOutputsMaxBytes
          : (payload.log?.nodeOutputsMaxBytes ?? null),
        usageSummary: silent ? current.usageSummary : (payload.log?.usageSummary ?? null),
        runEvents: silent ? current.runEvents : (payload.log?.runEvents ?? []),
        runNodes: silent ? current.runNodes : (payload.log?.runNodes ?? {}),
        selectedRunId: runId,
      }));
    } catch (error) {
      if (requestId !== logRequestRef.current) return;
      if (!silent) {
        setLogState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Unable to load workflow run",
        }));
      }
    }
  }, []);

  const loadApprovals = useCallback(async (workflowId, { silent = false } = {}) => {
    if (!silent) {
      setApprovalState((current) => ({ ...current, loading: true, error: "" }));
    }
    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflowId)}/approvals`),
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setApprovalState({
        approvals: payload.approvals ?? [],
        error: "",
        loading: false,
      });
    } catch (error) {
      if (!silent) {
        setApprovalState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "Unable to load approvals",
          loading: false,
        }));
      }
    }
  }, []);

  useEffect(() => {
    if (!activeWorkflow?.id) {
      setLogState({
        loading: false,
        error: "",
        text: "",
        path: null,
        nodeOutputs: null,
        nodeOutputsTruncated: false,
        nodeOutputsMaxBytes: null,
        usageSummary: null,
        runEvents: [],
        runNodes: {},
        runs: [],
        selectedRunId: null,
      });
      setApprovalState({ approvals: [], error: "", loading: false });
      return;
    }

    loadLatestLog(activeWorkflow.id, { silent: true });
    loadRunLogs(activeWorkflow.id);
    loadApprovals(activeWorkflow.id);
    loadRetentionSettingsForWorkflow(activeWorkflow.id);
  }, [
    activeWorkflow?.id,
    loadApprovals,
    loadLatestLog,
    loadRetentionSettingsForWorkflow,
    loadRunLogs,
  ]);

  useEffect(() => {
    if (!activeWorkflow?.id) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      if (logState.selectedRunId) {
        loadRunLog(activeWorkflow.id, logState.selectedRunId, { silent: true });
      } else {
        loadLatestLog(activeWorkflow.id, { silent: true });
      }
      loadRunLogs(activeWorkflow.id, { silent: true });
      loadApprovals(activeWorkflow.id, { silent: true });
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [
    activeWorkflow?.id,
    loadApprovals,
    loadLatestLog,
    loadRunLog,
    loadRunLogs,
    logState.selectedRunId,
  ]);

  useEffect(() => {
    const saveTimers = saveTimersRef.current;
    let pendingEditsPreserved = false;

    function preservePendingEdits() {
      if (pendingEditsPreserved) return;
      pendingEditsPreserved = true;
      for (const { workflow } of dirtyWorkflowsRef.current.values()) {
        void fetch(apiUrl(`/workflows/${encodeURIComponent(workflow.id)}`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(workflowPayloadForSave(workflow)),
          keepalive: true,
        }).catch(() => {});
      }
    }

    window.addEventListener("beforeunload", preservePendingEdits);
    window.addEventListener("pagehide", preservePendingEdits);
    return () => {
      window.removeEventListener("beforeunload", preservePendingEdits);
      window.removeEventListener("pagehide", preservePendingEdits);
      for (const timerId of saveTimers.values()) {
        window.clearTimeout(timerId);
      }
      saveTimers.clear();
    };
  }, []);

  const filteredWorkflows = useMemo(() => {
    return workflows.filter((workflow) => {
      const text = `${workflow.name} ${workflow.description} ${workflow.tags.join(" ")} ${workflow.projectName ?? ""} ${workflow.projectRoot ?? ""}`;
      return text.toLowerCase().includes(query.toLowerCase());
    });
  }, [query, workflows]);
  const usedAgentIds = useMemo(() => {
    return [
      ...new Set(
        [
          ...promptAgentIds,
          ...workflows.flatMap((workflow) => [
            ...Object.keys(workflow.agents ?? {}),
            ...(workflow.nodes ?? [])
              .map((node) => node.operation?.agent_id)
              .filter(Boolean),
          ]),
        ],
      ),
    ];
  }, [promptAgentIds, workflows]);

  function updateActiveWorkflow(nextWorkflow) {
    const summarizedWorkflow = summarizeWorkflow(nextWorkflow, dataDir);
    setWorkflows((current) =>
      current.map((workflow) =>
        workflow.id === summarizedWorkflow.id ? summarizedWorkflow : workflow,
      ),
    );
    const revision = (workflowRevisionsRef.current.get(summarizedWorkflow.id) ?? 0) + 1;
    workflowRevisionsRef.current.set(summarizedWorkflow.id, revision);
    dirtyWorkflowsRef.current.set(summarizedWorkflow.id, {
      revision,
      workflow: summarizedWorkflow,
    });
    setDirtyWorkflowsById((current) => ({
      ...current,
      [summarizedWorkflow.id]: { revision },
    }));
    setSaveStatesByWorkflowId((current) => ({
      ...current,
      [summarizedWorkflow.id]: { status: "saving", error: "" },
    }));

    const previousTimerId = saveTimersRef.current.get(summarizedWorkflow.id);
    if (previousTimerId) window.clearTimeout(previousTimerId);
    const timerId = window.setTimeout(() => {
      saveTimersRef.current.delete(summarizedWorkflow.id);
      void saveWorkflow(summarizedWorkflow, revision);
    }, 650);
    saveTimersRef.current.set(summarizedWorkflow.id, timerId);
  }

  async function saveWorkflow(workflow, revision) {
    const workflowId = workflow.id;
    const pendingSave = inFlightSavesRef.current.get(workflowId);
    if (pendingSave) {
      try {
        await pendingSave;
      } catch {
        // A newer revision is still allowed to save after an older request fails.
      }
    }

    if (dirtyWorkflowsRef.current.get(workflowId)?.revision !== revision) {
      return undefined;
    }

    setSaveStatesByWorkflowId((current) => ({
      ...current,
      [workflowId]: { status: "saving", error: "" },
    }));
    const saveRequest = persistWorkflow(workflow);
    inFlightSavesRef.current.set(workflowId, saveRequest);
    try {
      const savedWorkflow = await saveRequest;

      if (dirtyWorkflowsRef.current.get(workflowId)?.revision === revision) {
        setWorkflows((current) =>
          current.map((candidate) =>
            candidate.id === savedWorkflow.id
              ? summarizeWorkflow(mergeSavedWorkflow(candidate, savedWorkflow), dataDir)
              : candidate,
          ),
        );
        dirtyWorkflowsRef.current.delete(workflowId);
        setDirtyWorkflowsById((current) => withoutKey(current, workflowId));
        setSaveStatesByWorkflowId((current) => ({
          ...current,
          [workflowId]: { status: "saved", error: "" },
        }));
        return savedWorkflow;
      }
      return undefined;
    } catch (error) {
      if (dirtyWorkflowsRef.current.get(workflowId)?.revision === revision) {
        setSaveStatesByWorkflowId((current) => ({
          ...current,
          [workflowId]: {
            status: "error",
            error: error instanceof Error ? error.message : "Unable to save workflow",
          },
        }));
      }
      return undefined;
    } finally {
      if (inFlightSavesRef.current.get(workflowId) === saveRequest) {
        inFlightSavesRef.current.delete(workflowId);
      }
    }
  }

  function retryWorkflowSave(workflowId) {
    const dirtyWorkflow = dirtyWorkflowsRef.current.get(workflowId);
    if (!dirtyWorkflow) return;
    void saveWorkflow(dirtyWorkflow.workflow, dirtyWorkflow.revision);
  }

  async function persistWorkflow(workflow) {
    const response = await fetch(
      apiUrl(`/workflows/${encodeURIComponent(workflow.id)}`),
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(workflowPayloadForSave(workflow)),
      },
    );
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `Workflow API returned ${response.status}`);
    }
    return payload.workflow;
  }

  async function runWorkflowNow(workflow) {
    const workflowToRun = summarizeWorkflow(workflow, dataDir);
    const dirtyWorkflow = dirtyWorkflowsRef.current.get(workflowToRun.id);
    const pendingTimerId = saveTimersRef.current.get(workflowToRun.id);
    if (pendingTimerId) {
      window.clearTimeout(pendingTimerId);
      saveTimersRef.current.delete(workflowToRun.id);
    }
    setRunState({ running: true, workflowId: workflowToRun.id, error: "", result: null });
    setLogState((current) => ({
      ...current,
      loading: true,
      error: "",
      selectedRunId: null,
    }));
    if (dirtyWorkflow) {
      setSaveStatesByWorkflowId((current) => ({
        ...current,
        [workflowToRun.id]: { status: "saving", error: "" },
      }));
    }

    try {
      let savedWorkflow;
      if (workflowToRun.sourceFormat === "radish") {
        if (radishEditorState?.document?.dirty) {
          const savedDocument = await radishEditorRef.current?.save?.();
          if (!savedDocument) {
            throw new Error("Save workflow.rad before running the workflow.");
          }
        }
        savedWorkflow = workflowToRun;
      } else {
        savedWorkflow = dirtyWorkflow
          ? await saveWorkflow(dirtyWorkflow.workflow, dirtyWorkflow.revision)
          : await persistWorkflow(workflowToRun);
      }
      if (!savedWorkflow) {
        throw new Error("Unable to save workflow before running");
      }
      if (
        workflowToRun.sourceFormat !== "radish" &&
        (!dirtyWorkflow ||
          dirtyWorkflowsRef.current.get(workflowToRun.id)?.revision === dirtyWorkflow.revision)
      ) {
        setWorkflows((current) =>
          current.map((candidate) =>
            candidate.id === savedWorkflow.id
              ? summarizeWorkflow(mergeSavedWorkflow(candidate, savedWorkflow), dataDir)
              : candidate,
          ),
        );
        if (dirtyWorkflow) {
          dirtyWorkflowsRef.current.delete(workflowToRun.id);
          setDirtyWorkflowsById((current) => withoutKey(current, workflowToRun.id));
          setSaveStatesByWorkflowId((current) => ({
            ...current,
            [workflowToRun.id]: { status: "saved", error: "" },
          }));
        }
      }
      const externalAccessWarnings = agentExternalAccessWarnings(savedWorkflow);
      if (externalAccessWarnings.length > 0) {
        const confirmed = window.confirm(
          [
            "Agent filesystem access outside working_dir:",
            "",
            ...externalAccessWarnings.map((warning) => `- ${warning}`),
            "",
            "Run this workflow?",
          ].join("\n"),
        );
        if (!confirmed) {
          setRunState({
            running: false,
            workflowId: savedWorkflow.id,
            error: "",
            result: null,
          });
          setLogState((current) => ({ ...current, loading: false }));
          return;
        }
      }

      const triggerContext = buildRunPreviewTriggerContext(savedWorkflow);
      const initialParameters = initialWorkflowParameters(savedWorkflow);
      const previewRequest = workflowPlanRequest(savedWorkflow.id, triggerContext, initialParameters);
      const previewResponse = await fetch(previewRequest.url, previewRequest.options);
      const previewPayload = await previewResponse.json();
      if (!previewResponse.ok) {
        throw new Error(previewPayload.error || `Workflow API returned ${previewResponse.status}`);
      }
      setRunState({ running: false, workflowId: savedWorkflow.id, error: "", result: null });
      setLogState((current) => ({ ...current, loading: false }));
      setRunPreview({
        workflow: {
          ...savedWorkflow,
          inputs: previewPayload.plan?.inputs ?? savedWorkflow.inputs,
        },
        plan: previewPayload.plan,
        triggerContext,
        parameters: initialParameters,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to run workflow";
      setRunState({ running: false, workflowId: workflowToRun.id, error: message, result: null });
      loadLatestLog(workflowToRun.id, { silent: true });
      loadRunLogs(workflowToRun.id, { silent: true });
    }
  }

  async function executeWorkflowRun(workflow, triggerContext = {}, parameters = {}) {
    setRunPreview(null);
    setRunState({ running: true, workflowId: workflow.id, error: "", result: null });
    setLogState((current) => ({
      ...current,
      loading: true,
      error: "",
      selectedRunId: null,
    }));
    try {
      if (executionMode === "remote") {
        const response = await fetch(apiUrl(`/workflows/${encodeURIComponent(workflow.id)}/queue`), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            trigger: "ui",
            parameters:
              Object.keys(parameters ?? {}).length > 0
                ? { triggerContext, workflowInputs: parameters }
                : { triggerContext },
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || `Queue API returned ${response.status}`);
        }
        setRunState({ running: false, workflowId: workflow.id, error: "", result: payload.run });
        setLogState((current) => ({ ...current, loading: false }));
        setTopBarNotice({
          type: "success",
          message: `Queued ${workflow.name} for remote execution`,
        });
        loadQueue({ silent: true });
        return;
      }
      const runRequest = workflowRunRequest(workflow.id, {
        dryRun: false,
        triggerContext,
        parameters,
      });
      const response = await fetch(runRequest.url, runRequest.options);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setRunState({ running: false, workflowId: workflow.id, error: "", result: payload.run });
      const nextRunStatus =
        payload.run?.status === "stopped"
          ? "Stopped"
          : payload.run?.success
            ? "Success"
            : "Error";
      const nextRunTag =
        payload.run?.status === "stopped" ? "stopped" : payload.run?.success ? "success" : "error";
      setWorkflows((current) =>
        current.map((candidate) =>
          candidate.id === workflow.id
            ? {
                ...candidate,
                status: nextRunStatus,
                tags: [nextRunTag, ...(candidate.tags ?? []).slice(1)],
              }
            : candidate,
        ),
      );
      setLogState({
        loading: false,
        error: "",
        text: payload.run?.logText ?? "",
        path: payload.run?.logPath ?? null,
        nodeOutputs: payload.run?.nodeOutputs ?? null,
        nodeOutputsTruncated: Boolean(payload.run?.nodeOutputsTruncated),
        nodeOutputsMaxBytes: payload.run?.nodeOutputsMaxBytes ?? null,
        usageSummary: payload.run?.usageSummary ?? null,
        runEvents: payload.run?.runEvents ?? [],
        runNodes: payload.run?.runNodes ?? {},
        runs: logState.runs,
        selectedRunId: null,
      });
      if (!payload.run?.success) {
        setTopBarNotice({
          type: "error",
          message: workflowRunFailureMessage(payload.run),
        });
      }
      loadRunLogs(workflow.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to run workflow";
      setRunState({ running: false, workflowId: workflow.id, error: message, result: null });
      loadLatestLog(workflow.id, { silent: true });
      loadRunLogs(workflow.id, { silent: true });
    }
  }

  async function decideApproval(workflow, approval, decision, notes = "", by = "ui") {
    try {
      const response = await fetch(
        apiUrl(
          `/workflows/${encodeURIComponent(workflow.id)}/approvals/${encodeURIComponent(
            approval.runId,
          )}/${encodeURIComponent(approval.nodeId)}/${decision === "approved" ? "approve" : "reject"}`,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ by, notes }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setTopBarNotice({
        type: "success",
        message: decision === "approved" ? "Approval recorded" : "Rejection recorded",
      });
      setApprovalState((current) => ({
        ...current,
        approvals: current.approvals.map((candidate) =>
          candidate.runId === approval.runId && candidate.nodeId === approval.nodeId
            ? (payload.approval ?? {
                ...candidate,
                status: "decided",
                decision: { decision, decidedBy: by, notes },
              })
            : candidate,
        ),
      }));
      loadApprovals(workflow.id, { silent: true });
      loadLatestLog(workflow.id, { silent: true });
      loadRunLogs(workflow.id, { silent: true });
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to record approval",
      });
    }
  }

  async function stopWorkflowRun(workflow) {
    if (!workflow?.id) return;

    setRunState((current) => ({ ...current, stopping: true }));
    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflow.id)}/stop`),
        { method: "POST" },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setTopBarNotice({
        type: payload.stopped ? "success" : "error",
        message: payload.stopped ? "Stopping workflow runs..." : payload.message || "No active run",
      });
      setRunState((current) => ({
        ...current,
        stopping: false,
      }));
      loadWorkflows({ silent: true });
      loadRunLogs(workflow.id, { silent: true });
    } catch (error) {
      setRunState((current) => ({ ...current, stopping: false }));
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to stop workflow run",
      });
    }
  }

  async function stopWorkflowRunLog(workflowId, runId) {
    if (!workflowId || !runId) return;

    try {
      const response = await fetch(
        apiUrl(
          `/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/stop`,
        ),
        { method: "POST" },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setTopBarNotice({
        type: payload.stopped ? "success" : "error",
        message: payload.stopped ? "Stopping workflow run..." : payload.message || "No active run",
      });
      loadRunLogs(workflowId, { silent: true });
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to stop workflow run",
      });
    }
  }

  async function resumeWorkflowRunLog(workflowId, runId, options = {}) {
    if (!workflowId || !runId) return;

    setRunState({ running: true, workflowId, error: "", result: null, resumingRunId: runId });
    setLogState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const request = workflowResumeRequest(workflowId, runId, options);
      const response = await fetch(request.url, request.options);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setRunState({ running: false, workflowId, error: "", result: payload.run });
      setLogState({
        loading: false,
        error: "",
        text: payload.run?.logText ?? "",
        path: payload.run?.logPath ?? null,
        nodeOutputs: payload.run?.nodeOutputs ?? null,
        nodeOutputsTruncated: Boolean(payload.run?.nodeOutputsTruncated),
        nodeOutputsMaxBytes: payload.run?.nodeOutputsMaxBytes ?? null,
        usageSummary: payload.run?.usageSummary ?? null,
        runEvents: payload.run?.runEvents ?? [],
        runNodes: payload.run?.runNodes ?? {},
        runs: logState.runs,
        selectedRunId: null,
      });
      setTopBarNotice({ type: "success", message: "Workflow run resumed" });
      loadWorkflows({ silent: true });
      loadRunLogs(workflowId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to resume workflow run";
      setRunState({ running: false, workflowId, error: message, result: null });
      setLogState((current) => ({ ...current, loading: false, error: message }));
      loadLatestLog(workflowId, { silent: true });
      loadRunLogs(workflowId, { silent: true });
    }
  }

  async function replayWorkflowTriggerLog(workflowId, runId, triggerId = null) {
    if (!workflowId || !runId) return;

    setRunState({ running: true, workflowId, error: "", result: null, resumingRunId: runId });
    setLogState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const request = workflowReplayTriggerRequest(workflowId, runId, triggerId);
      const response = await fetch(request.url, request.options);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      const runPayload = payload.trigger?.run ?? payload.run ?? {};
      setRunState({ running: false, workflowId, error: "", result: runPayload });
      setLogState({
        loading: false,
        error: "",
        text: runPayload.logText ?? "",
        path: runPayload.logPath ?? null,
        nodeOutputs: runPayload.nodeOutputs ?? null,
        nodeOutputsTruncated: Boolean(runPayload.nodeOutputsTruncated),
        nodeOutputsMaxBytes: runPayload.nodeOutputsMaxBytes ?? null,
        usageSummary: runPayload.usageSummary ?? null,
        runEvents: runPayload.runEvents ?? [],
        runNodes: runPayload.runNodes ?? {},
        runs: logState.runs,
        selectedRunId: null,
      });
      setTopBarNotice({ type: "success", message: "Webhook payload replayed" });
      loadWorkflows({ silent: true });
      loadRunLogs(workflowId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to replay webhook payload";
      setRunState({ running: false, workflowId, error: message, result: null });
      setLogState((current) => ({ ...current, loading: false, error: message }));
      loadRunLogs(workflowId, { silent: true });
    }
  }

  async function pruneWorkflowRunLogs(workflowId, options = {}) {
    if (!workflowId) return;
    const dryRun = options.dryRun !== false;
    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflowId)}/logs/prune`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dryRun,
            keepLast: options.keepLast ?? retentionSettings.keepLast,
            keepDays: options.keepDays ?? retentionSettings.keepDays,
            keepFailedDays: options.keepFailedDays ?? retentionSettings.keepFailedDays,
          }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      const count = payload.runs?.length ?? 0;
      setTopBarNotice({
        type: dryRun ? "info" : "success",
        message: dryRun
          ? `Retention preview: ${count} run${count === 1 ? "" : "s"} would be removed`
          : `Retention cleanup removed ${count} run${count === 1 ? "" : "s"}`,
      });
      loadRunLogs(workflowId, { silent: true });
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to prune workflow runs",
      });
    }
  }

  async function createWorkflow(name, options = {}) {
    setCreateState({ saving: true, error: "" });
    try {
      const response = await fetch(apiUrl("/workflows"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          template: options.template || undefined,
          projectRoot: options.projectRoot,
          projectGrantId: options.projectGrantId || undefined,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }

      const nextWorkflow = summarizeWorkflow(payload.workflow, dataDir);
      deletedWorkflowIdsRef.current.delete(nextWorkflow.id);
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

  async function validateWorkflow(workflow) {
    try {
      await persistWorkflow(summarizeWorkflow(workflow, dataDir));
      setTopBarNotice({ type: "success", message: "Workflow is valid" });
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Workflow validation failed",
      });
    }
  }

  async function loadWorkflowHistory(workflowId) {
    setHistoryState((current) => ({ ...current, error: "", loading: true }));
    try {
      const response = await fetch(apiUrl(`/workflows/${encodeURIComponent(workflowId)}/history`));
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setHistoryState((current) => ({
        ...current,
        error: "",
        loading: false,
        revisions: payload.revisions ?? [],
      }));
    } catch (error) {
      setHistoryState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Unable to load workflow history",
        loading: false,
      }));
    }
  }

  async function openWorkflowHistory(workflow) {
    if (!workflow?.id) return;
    setHistoryState({
      diff: null,
      error: "",
      loading: true,
      open: true,
      revisions: [],
    });
    await loadWorkflowHistory(workflow.id);
  }

  async function previewWorkflowRevision(workflowId, revisionId) {
    setHistoryState((current) => ({ ...current, error: "" }));
    try {
      const response = await fetch(
        apiUrl(
          `/workflows/${encodeURIComponent(workflowId)}/history/${encodeURIComponent(revisionId)}/diff`,
        ),
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setHistoryState((current) => ({ ...current, diff: payload }));
    } catch (error) {
      setHistoryState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Unable to load revision diff",
      }));
    }
  }

  async function restoreWorkflowRevision(workflowId, revisionId, { asCopy = false } = {}) {
    const action = asCopy ? "restore this revision as a copy" : "restore this revision";
    if (!window.confirm(`Are you sure you want to ${action}?`)) return;
    setHistoryState((current) => ({ ...current, error: "", loading: true }));
    try {
      const response = await fetch(
        apiUrl(
          `/workflows/${encodeURIComponent(workflowId)}/history/${encodeURIComponent(revisionId)}/restore`,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ asCopy }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      const restored = summarizeWorkflow(payload.workflow, dataDir);
      deletedWorkflowIdsRef.current.delete(restored.id);
      setWorkflows((current) => {
        const withoutRestored = current.filter((candidate) => candidate.id !== restored.id);
        return [...withoutRestored, restored];
      });
      setActiveWorkflowId(restored.id);
      setHistoryState((current) => ({ ...current, loading: false, open: false }));
      setTopBarNotice({
        type: "success",
        message: asCopy ? `Restored ${restored.name} as a copy` : `Restored ${restored.name}`,
      });
      loadWorkflows({ silent: true });
    } catch (error) {
      setHistoryState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Unable to restore workflow revision",
        loading: false,
      }));
    }
  }

  async function importWorkflow(file) {
    if (!file) return;
    try {
      if (isBundleFile(file)) {
        const bundleContent = await fileToBase64(file);
        const previewResponse = await fetch(apiUrl("/workflows/import/preview"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ bundleContent, filename: file.name }),
        });
        const previewPayload = await previewResponse.json();
        if (!previewResponse.ok) {
          throw new Error(previewPayload.error || `Workflow API returned ${previewResponse.status}`);
        }
        const plan = previewPayload.import;
        if (!window.confirm(formatBundleImportPreview(plan))) {
          return;
        }
        const importResponse = await fetch(apiUrl("/workflows/import"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ bundleContent, filename: file.name }),
        });
        const importPayload = await importResponse.json();
        if (!importResponse.ok) {
          throw new Error(importPayload.error || `Workflow API returned ${importResponse.status}`);
        }
        const imported = importPayload.import;
        deletedWorkflowIdsRef.current.delete(imported.workflowId);
        await loadWorkflows({ silent: true });
        setActiveWorkflowId(imported.workflowId);
        setTopBarNotice({ type: "success", message: `Imported ${imported.workflowName}` });
        return;
      }

      const content = await file.text();
      const response = await fetch(apiUrl("/workflows/import"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content, filename: file.name }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }

      const nextWorkflow = summarizeWorkflow(payload.workflow, dataDir);
      deletedWorkflowIdsRef.current.delete(nextWorkflow.id);
      setWorkflows((current) => [...current, nextWorkflow]);
      setActiveWorkflowId(nextWorkflow.id);
      setTopBarNotice({ type: "success", message: `Imported ${nextWorkflow.name}` });
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to import workflow",
      });
    }
  }

  async function exportWorkflow(workflow) {
    if (!workflow) return;
    const defaultPath = `${dataDir ? `${dataDir.replace(/\/$/, "")}/` : ""}${workflow.id}.gof.zip`;
    setExportDialog({
      error: "",
      outputPath: defaultPath,
      saving: false,
      workflow,
    });
  }

  async function confirmExportWorkflow(outputPath) {
    const workflow = exportDialog.workflow;
    if (!workflow || !outputPath.trim()) return;
    setExportDialog((current) => ({ ...current, error: "", saving: true }));
    try {
      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflow.id)}/export`),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ outputPath: outputPath.trim() }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }
      setExportDialog({ error: "", outputPath: "", saving: false, workflow: null });
      setTopBarNotice({ type: "success", message: `Exported bundle to ${payload.bundlePath}` });
    } catch (error) {
      setExportDialog((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Unable to export workflow bundle",
        saving: false,
      }));
    }
  }

  async function deleteWorkflow(workflow) {
    if (!workflow) return;
    if (!window.confirm(`Delete workflow "${workflow.name}"?`)) return;

    try {
      setCreateState({ saving: false, error: "" });
      deletedWorkflowIdsRef.current.add(workflow.id);
      const pendingTimerId = saveTimersRef.current.get(workflow.id);
      if (pendingTimerId) {
        window.clearTimeout(pendingTimerId);
        saveTimersRef.current.delete(workflow.id);
      }
      dirtyWorkflowsRef.current.delete(workflow.id);
      workflowRevisionsRef.current.delete(workflow.id);
      setDirtyWorkflowsById((current) => withoutKey(current, workflow.id));
      setSaveStatesByWorkflowId((current) => withoutKey(current, workflow.id));
      setRunState((current) =>
        current.workflowId === workflow.id
          ? { running: false, error: "", result: null }
          : current,
      );
      setLogState((current) =>
        activeWorkflow?.id === workflow.id
          ? {
              loading: false,
              error: "",
              text: "",
              path: null,
              nodeOutputs: null,
              nodeOutputsTruncated: false,
              nodeOutputsMaxBytes: null,
              usageSummary: null,
              runEvents: [],
              runNodes: {},
              runs: [],
              selectedRunId: null,
            }
          : current,
      );

      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflow.id)}`),
        {
          method: "DELETE",
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }

      const remainingWorkflows = workflows.filter((candidate) => candidate.id !== workflow.id);
      setWorkflows((current) => current.filter((candidate) => candidate.id !== workflow.id));
      setActiveWorkflowId((currentId) =>
        currentId === workflow.id ? remainingWorkflows[0]?.id : currentId,
      );
      setTopBarNotice({ type: "success", message: `Deleted ${workflow.name}` });
    } catch (error) {
      deletedWorkflowIdsRef.current.delete(workflow.id);
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to delete workflow",
      });
    }
  }

  async function renameWorkflow(workflow, nextName) {
    if (!workflow) return;
    if (!nextName || nextName.trim() === workflow.name) return;

    try {
      const dirtyWorkflow = dirtyWorkflowsRef.current.get(workflow.id);
      if (dirtyWorkflow) {
        const savedWorkflow = await saveWorkflow(dirtyWorkflow.workflow, dirtyWorkflow.revision);
        if (!savedWorkflow) return;
      }

      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflow.id)}/rename`),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: nextName.trim() }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }

      const renamed = summarizeWorkflow(payload.workflow, dataDir);
      deletedWorkflowIdsRef.current.delete(renamed.id);
      setWorkflows((current) =>
        current.map((candidate) =>
          candidate.id === workflow.id ? renamed : candidate,
        ),
      );
      setActiveWorkflowId((currentId) =>
        currentId === workflow.id ? renamed.id : currentId,
      );
      setTopBarNotice({ type: "success", message: `Renamed to ${renamed.name}` });
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to rename workflow",
      });
    }
  }

  async function duplicateWorkflow(workflow) {
    if (!workflow) return;

    try {
      const dirtyWorkflow = dirtyWorkflowsRef.current.get(workflow.id);
      if (dirtyWorkflow) {
        const savedWorkflow = await saveWorkflow(dirtyWorkflow.workflow, dirtyWorkflow.revision);
        if (!savedWorkflow) return;
      }

      const response = await fetch(
        apiUrl(`/workflows/${encodeURIComponent(workflow.id)}/duplicate`),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Workflow API returned ${response.status}`);
      }

      const duplicated = summarizeWorkflow(payload.workflow, dataDir);
      deletedWorkflowIdsRef.current.delete(duplicated.id);
      setWorkflows((current) => [...current, duplicated]);
      setActiveWorkflowId(duplicated.id);
      setTopBarNotice({ type: "success", message: `Duplicated ${workflow.name}` });
    } catch (error) {
      setTopBarNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to duplicate workflow",
      });
    }
  }

  return (
    <main
      aria-busy={runState.running || logState.loading || undefined}
      className={`flex h-screen min-h-[720px] min-w-[1180px] bg-canvas text-ink ${theme}`}
    >
      <div aria-atomic="true" aria-live="polite" className="sr-only" role="status">
        {!runState.running && runState.result
          ? runState.result.status === "queued"
            ? "Workflow run queued."
            : `Workflow run completed: ${runState.result.status ?? (runState.result.success ? "success" : "error")}`
          : ""}
      </div>
      <div aria-atomic="true" aria-live="assertive" className="sr-only" role="alert">
        {runState.error}
      </div>
      <WorkflowSidebar
        activeWorkflow={activeWorkflow}
        activeWorkflowId={activeWorkflow?.id}
        loading={loadState.loading}
        query={query}
        runState={runState}
        workflows={filteredWorkflows}
        view={studioView}
        width={workflowPaneWidth}
        onQueryChange={setQuery}
        onCreate={() => {
          setCreateState({ saving: false, error: "" });
          setCreateDialogOpen(true);
        }}
        onDeleteWorkflow={deleteWorkflow}
        onDuplicateWorkflow={duplicateWorkflow}
        onCodeFileOpen={openCodeFile}
        onCodeFilesystemChange={handleCodeFilesystemChange}
        onRefresh={loadWorkflows}
        onRenameWorkflow={renameWorkflow}
        onRunWorkflow={runWorkflowNow}
        onResizeStart={(event) =>
          startPaneResize(event, {
            max: 420,
            min: 240,
            side: "right",
            width: workflowPaneWidth,
            onResize: setWorkflowPaneWidth,
          })
        }
        onResizeKeyDown={(event) =>
          handlePaneResizeKeyDown(event, {
            defaultValue: 272,
            max: 420,
            min: 240,
            onResize: setWorkflowPaneWidth,
            width: workflowPaneWidth,
          })
        }
        onSelect={setActiveWorkflowId}
        onViewChange={changeStudioView}
      />

      <section className="flex min-w-0 flex-1 flex-col border-x border-line bg-[#f9fbfd]">
        {activeWorkflow ? (
          <>
            <TopBar
              editorState={radishEditorState}
              saveState={
                saveStatesByWorkflowId[activeWorkflow.id] ??
                (dirtyWorkflowsById[activeWorkflow.id]
                  ? { status: "saving", error: "" }
                  : undefined)
              }
              theme={theme}
              updateState={updateState}
              workflow={activeWorkflow}
              view={studioView}
              onCheckForUpdates={() => checkForUpdates()}
              onApplyUpdate={() => applyUpdate(updateState)}
              onOpenHistory={() => openWorkflowHistory(activeWorkflow)}
              onSaveRadish={() => radishEditorRef.current?.saveActive?.()}
              onRetrySave={() => retryWorkflowSave(activeWorkflow.id)}
              onToggleTheme={() =>
                setTheme((currentTheme) => (currentTheme === "dark" ? "light" : "dark"))
              }
            />
            {studioView === "graph" ? (
              <WorkflowHealthPanel doctorState={doctorState} workflow={activeWorkflow} />
            ) : null}
            <div className={`${studioView === "graph" ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}>
              <DagCanvas
              dataDir={dataDir}
              logState={logState}
              approvalState={approvalState}
              notice={runState.error ? { type: "error", message: runState.error } : topBarNotice}
              retentionSettings={retentionSettings}
              runState={runState}
              workflow={graphWorkflow}
              radishDocument={radishEditorState?.document}
              usedAgentIds={usedAgentIds}
              onLoadLatestLog={() => loadLatestLog(activeWorkflow.id)}
              onSelectRunLog={(runId) => loadRunLog(activeWorkflow.id, runId)}
              onStopRunLog={(runId) => stopWorkflowRunLog(activeWorkflow.id, runId)}
              onResumeRunLog={(runId, options) =>
                resumeWorkflowRunLog(activeWorkflow.id, runId, options)
              }
              onReplayRunLog={(runId, triggerId) =>
                replayWorkflowTriggerLog(activeWorkflow.id, runId, triggerId)
              }
              onPruneRunLogs={(options) => pruneWorkflowRunLogs(activeWorkflow.id, options)}
              onRetentionSettingsChange={(nextSettings) =>
                saveRetentionSettingsForWorkflow(activeWorkflow.id, nextSettings)
              }
              onImportWorkflow={importWorkflow}
              onExportWorkflow={() => exportWorkflow(activeWorkflow)}
              onRunWorkflow={runWorkflowNow}
              onValidateWorkflow={() => {
                if (activeWorkflow.sourceFormat !== "radish") {
                  validateWorkflow(activeWorkflow);
                  return;
                }
                const document = radishEditorStateRef.current?.document;
                const errors = [
                  ...(document?.diagnostics ?? []),
                  ...(document?.preflight?.diagnostics ?? []),
                ].filter((item) => item.severity === "error");
                setTopBarNotice(
                  errors.length
                    ? { type: "error", message: errors[0].message }
                    : document?.runnable
                      ? { type: "success", message: "Radish compiles and preflight is ready" }
                      : { type: "error", message: "Add at least one runnable node" },
                );
              }}
              onStopWorkflow={stopWorkflowRun}
              onDecideApproval={(approval, decision, notes, by) =>
                decideApproval(activeWorkflow, approval, decision, notes, by)
              }
                onRadishMutation={mutateActiveRadish}
                onWorkflowChange={
                  activeWorkflow.sourceFormat === "radish"
                    ? updateRadishGraphMetadata
                    : updateActiveWorkflow
                }
              />
            </div>
            {codeEditorOpened && activeWorkflow.sourceFormat === "radish" ? (
              <div className={`${studioView === "code" ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}>
                <CodeWorkspace
                  active={studioView === "code"}
                  activePath={activeCodePath}
                  ref={radishEditorRef}
                  openPaths={codeOpenPaths}
                  theme={theme}
                  workflow={activeWorkflow}
                  onActivePathChange={setActiveCodePath}
                  onClosePath={closeCodeFile}
                  onDocumentStateChange={setRadishEditorState}
                />
              </div>
            ) : null}
          </>
        ) : (
          <EmptyWorkspace error={loadState.error} loading={loadState.loading} onRefresh={loadWorkflows} />
        )}
      </section>

      <ChatPane
        width={chatPaneWidth}
        activeWorkflowId={activeWorkflow?.id}
        workflow={activeWorkflow}
        workflows={workflows}
        onResizeStart={(event) =>
          startPaneResize(event, {
            max: 520,
            min: 300,
            side: "left",
            width: chatPaneWidth,
            onResize: setChatPaneWidth,
          })
        }
        onResizeKeyDown={(event) =>
          handlePaneResizeKeyDown(event, {
            defaultValue: 380,
            max: 520,
            min: 300,
            onResize: setChatPaneWidth,
            width: chatPaneWidth,
          })
        }
      />
      {runPreview ? (
        <RunPreviewDialog
          plan={runPreview.plan}
          workflow={runPreview.workflow}
          onCancel={() => setRunPreview(null)}
          initialParameters={runPreview.parameters}
          onRun={(parameters) =>
            executeWorkflowRun(runPreview.workflow, runPreview.triggerContext, parameters)
          }
          executionMode={executionMode}
          onExecutionModeChange={setExecutionMode}
          queueState={queueState}
        />
      ) : null}
      <CreateWorkflowDialog
        defaultProjectRoot={activeWorkflow?.projectRoot ?? ""}
        error={createState.error}
        open={createDialogOpen}
        saving={createState.saving}
        templates={workflowTemplates}
        onClose={() => {
          if (!createState.saving) {
            setCreateDialogOpen(false);
            setCreateState({ saving: false, error: "" });
          }
        }}
        onCreate={createWorkflow}
      />

      <ExportWorkflowDialog
        error={exportDialog.error}
        open={Boolean(exportDialog.workflow)}
        outputPath={exportDialog.outputPath}
        saving={exportDialog.saving}
        workflow={exportDialog.workflow}
        onClose={() => {
          if (!exportDialog.saving) {
            setExportDialog({ error: "", outputPath: "", saving: false, workflow: null });
          }
        }}
        onExport={confirmExportWorkflow}
      />

      {historyState.open && activeWorkflow ? (
        <WorkflowHistoryDialog
          diff={historyState.diff}
          error={historyState.error}
          loading={historyState.loading}
          revisions={historyState.revisions}
          workflow={activeWorkflow}
          onClose={() => setHistoryState((current) => ({ ...current, open: false }))}
          onRefresh={() => loadWorkflowHistory(activeWorkflow.id)}
          onPreview={(revisionId) => previewWorkflowRevision(activeWorkflow.id, revisionId)}
          onRestore={(revisionId, options) =>
            restoreWorkflowRevision(activeWorkflow.id, revisionId, options)
          }
        />
      ) : null}
    </main>
  );
}

export function workflowRunFailureMessage(run) {
  const directError = typeof run?.error === "string" ? run.error : run?.error?.message;
  if (directError) return directError;
  const failedNode = Object.values(run?.runNodes ?? {}).find(
    (node) => node?.status === "error" || node?.status === "failed",
  );
  const nodeError = typeof failedNode?.error === "string"
    ? failedNode.error
    : failedNode?.error?.message ?? failedNode?.message;
  if (nodeError) return nodeError;
  return "Workflow failed. Select the failed node to inspect its output.";
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function paneWidthForKey(
  key,
  width,
  { defaultValue, max, min, shiftKey = false, step = 10 },
) {
  if (key === "Enter") return clampNumber(defaultValue, min, max);
  if (key === "Home") return min;
  if (key === "End") return max;
  const amount = shiftKey ? step * 4 : step;
  if (key === "ArrowLeft") return clampNumber(width - amount, min, max);
  if (key === "ArrowRight") return clampNumber(width + amount, min, max);
  return null;
}

function handlePaneResizeKeyDown(event, options) {
  const nextWidth = paneWidthForKey(event.key, options.width, {
    ...options,
    shiftKey: event.shiftKey,
  });
  if (nextWidth === null) return;
  event.preventDefault();
  options.onResize(nextWidth);
}

function startPaneResize(event, { max, min, onResize, side, width }) {
  event.preventDefault();
  event.stopPropagation();

  const startX = event.clientX;
  const startWidth = width;
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;

  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  function handlePointerMove(moveEvent) {
    const delta = moveEvent.clientX - startX;
    const nextWidth = side === "left" ? startWidth - delta : startWidth + delta;
    onResize(clampNumber(nextWidth, min, max));
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

function getInitialTheme() {
  if (typeof window === "undefined") return "light";
  const savedTheme = window.localStorage.getItem("gofer-ui-theme");
  if (savedTheme === "dark" || savedTheme === "light") {
    return savedTheme;
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function summarizeWorkflow(workflow, dataDir = "") {
  if (workflow.invalid) {
    return {
      ...workflow,
      agents: workflow.agents ?? {},
      nodes: workflow.nodes ?? [],
      edges: workflow.edges ?? [],
      description: workflow.description || `Invalid ${workflow.sourceFormat === "radish" ? "Radish" : "workflow TOML"}: ${workflow.validationError}`,
      status: "Error",
      tags: ["error", "invalid"],
    };
  }
  const agentCount = agentIdsForWorkflow(workflow).length;
  const operationTypes = [...new Set((workflow.nodes ?? []).map((node) => node.type))].sort();
  const status = workflow.status ?? "Ready";
  const watchPath = workflow.watch?.path
    ? resolveDisplayPath(workflow.watch.path, dataDir)
    : "";
  return {
    ...workflow,
    description: `${workflow.nodes.length} nodes, ${workflow.edges.length} edges, ${agentCount} agents.${
      workflow.schedule ? ` Scheduled with ${workflow.schedule.cron_expression}.` : ""
    }${workflow.watch ? ` Watching ${watchPath}.` : ""
    }${Object.values(workflow.webhooks ?? {}).some((config) => config?.enabled) ? " API trigger enabled." : ""
    }`,
    status,
    tags: [status.toLowerCase(), ...operationTypes.slice(0, 2)],
  };
}

export function radishGraphWorkflow(workflow, document) {
  if (
    !workflow ||
    workflow.sourceFormat !== "radish" ||
    !document?.graph ||
    document.workflowId !== workflow.id
  ) {
    return workflow;
  }
  const positions = document.metadata?.canvas?.nodes ?? {};
  const nodes = (document.graph.nodes ?? []).map((node) => {
    const type = String(node.type || "unknown").replaceAll("-", "_");
    const execution = node.execution ?? {};
    return {
      id: node.id,
      label: node.label || node.id,
      type,
      operation: { type, ...(node.configuration ?? {}) },
      settings: {
        allowFailure: Boolean(execution.allow_fail),
        awaitAllInputs: true,
        failFast: false,
        forEach: "",
        maxConcurrency: execution.max_concurrency ?? 1,
        pipeOutput: false,
        retryCount: execution.retry_count ?? 0,
        retryDelaySeconds: (execution.retry_delay_ms ?? 0) / 1000,
        timeoutSeconds:
          execution.timeout_ms === null || execution.timeout_ms === undefined
            ? ""
            : execution.timeout_ms / 1000,
      },
      x: positions[node.id]?.x ?? 0,
      y: positions[node.id]?.y ?? 0,
      radishStatus: node.status,
      radish: node,
    };
  });
  const edges = (document.graph.edges ?? []).map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    condition: edge.mode === "when" ? "output_field" : "always",
    displayLabel:
      edge.mode === "when"
        ? edge.predicateSource
          ? `when ${edge.predicateSource}`
          : "when"
        : edge.mode === "unconditional"
          ? "always"
          : edge.mode,
    mode: edge.mode,
    predicate: edge.predicate,
    predicateSource: edge.predicateSource,
    sourceSpan: edge.sourceSpan,
  }));
  const validationDiagnostics = [
    ...(document.diagnostics ?? []).map((diagnostic) => ({
      ...diagnostic,
      id: diagnostic.code,
      subject: "workflow",
      targetId: workflow.id,
      targetType: "workflow",
    })),
    ...(document.graph.nodes ?? []).flatMap((node) =>
      (node.diagnostics ?? []).map((diagnostic) => ({
        ...diagnostic,
        id: diagnostic.code,
        subject: `node:${node.id}`,
        targetId: node.id,
        targetType: "node",
      })),
    ),
    ...(document.graph.edges ?? [])
      .filter((edge) => edge.status !== "valid")
      .map((edge) => ({
        id: "RADISH_ROUTE_UNRESOLVED",
        message: `Route target ${edge.to} is unresolved.`,
        severity: "error",
        subject: `edge:${edge.id}`,
        targetId: edge.id,
        targetType: "edge",
      })),
  ];
  const laidOut = autoLayoutWorkflow({ ...workflow, nodes, edges });
  return {
    ...workflow,
    ...laidOut,
    invalid: false,
    name: document.workflow?.name || workflow.name,
    nodes: laidOut.nodes.map((node) =>
      positions[node.id]
        ? { ...node, x: positions[node.id].x, y: positions[node.id].y }
        : node,
    ),
    validationDiagnostics,
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

export function mergeSavedWorkflow(localWorkflow, savedWorkflow) {
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

export function preserveLocalWorkflow(remoteWorkflows, localWorkflow, dataDir = "") {
  const foundWorkflow = remoteWorkflows.some((workflow) => workflow.id === localWorkflow.id);
  if (!foundWorkflow) {
    return [...remoteWorkflows, localWorkflow];
  }
  return remoteWorkflows.map((workflow) =>
    workflow.id === localWorkflow.id
      ? summarizeWorkflow({
          ...localWorkflow,
          sourcePath: workflow.sourcePath ?? localWorkflow.sourcePath,
          sourceFormat: workflow.sourceFormat ?? localWorkflow.sourceFormat,
          status: workflow.status ?? localWorkflow.status,
          updatedAt: workflow.updatedAt ?? localWorkflow.updatedAt,
          projectRoot: workflow.projectRoot ?? localWorkflow.projectRoot,
          projectName: workflow.projectRoot
            ? projectNameFromPath(workflow.projectRoot)
            : localWorkflow.projectName,
          workflowRoot: workflow.workflowRoot ?? localWorkflow.workflowRoot,
        }, dataDir)
      : workflow,
  );
}

export function workflowPayloadForSave(workflow) {
  const { parameters, ...canonicalWorkflow } = workflow;
  return {
    ...canonicalWorkflow,
    inputs: workflow.inputs ?? parameters ?? {},
    filesystemAccess: normalizeWorkflowFilesystemAccess(workflow.filesystemAccess),
    nodes: (workflow.nodes ?? []).map((node) => ({
      ...node,
      x: node.x ?? 0,
      y: node.y ?? 0,
    })),
    edges: workflow.edges ?? [],
    agents: workflow.agents ?? {},
  };
}

export function normalizeWorkflowFilesystemAccess(entries = []) {
  const seen = new Set();
  return (entries ?? [])
    .map((entry) => ({
      path: String(entry?.path ?? "").trim(),
      read: entry?.read ?? true,
      write: entry?.write ?? true,
      execute: entry?.execute ?? false,
    }))
    .filter((entry) => {
      const key = entry.path.replace(/\\/g, "/").replace(/\/+$/, "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function workflowPlanRequest(workflowId, triggerContext = {}, parameters = {}) {
  const body = { triggerContext };
  if (Object.keys(parameters ?? {}).length > 0) {
    body.inputs = parameters;
  }
  return {
    url: apiUrl(`/workflows/${encodeURIComponent(workflowId)}/plan`),
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  };
}

export function workflowRunRequest(
  workflowId,
  { dryRun = false, triggerContext = {}, parameters = {} } = {},
) {
  const body = { dryRun, triggerContext };
  if (Object.keys(parameters ?? {}).length > 0) {
    body.inputs = parameters;
  }
  return {
    url: apiUrl(`/workflows/${encodeURIComponent(workflowId)}/run`),
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  };
}

export function workflowResumeRequest(
  workflowId,
  runId,
  { force = false, fromNode = null, onlyNode = null, skipCache = false, triggerContext = {} } = {},
) {
  return {
    url: apiUrl(
      `/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/resume`,
    ),
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ force, fromNode, onlyNode, skipCache, triggerContext }),
    },
  };
}

export function workflowReplayTriggerRequest(workflowId, runId, triggerId = null) {
  const encodedWorkflowId = encodeURIComponent(workflowId);
  const encodedTriggerId = encodeURIComponent(triggerId || "default");
  return {
    url: apiUrl(
      `/workflows/${encodedWorkflowId}/webhooks/${encodedTriggerId}/replay`,
    ),
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ runId }),
    },
  };
}

export function workflowLogUrls(workflowId, runId = null) {
  const encodedWorkflowId = encodeURIComponent(workflowId);
  const selectedParams = new URLSearchParams({
    tailBytes: String(RUN_LOG_TAIL_BYTES),
    details: "0",
  });
  return {
    latest: apiUrl(`/workflows/${encodedWorkflowId}/logs/latest`),
    runs: apiUrl(`/workflows/${encodedWorkflowId}/logs`),
    selected: runId
      ? `${apiUrl(
          `/workflows/${encodedWorkflowId}/logs/${encodeURIComponent(runId)}`,
        )}?${selectedParams}`
      : null,
  };
}

export function chatStreamRequestBody({ effort, provider, model, messages, workflow }) {
  return {
    provider,
    model,
    ...(effort ? { effort } : {}),
    messages,
    workflow,
  };
}

export function workflowIdsAfterDelete(workflows, deletedWorkflowId) {
  return workflows
    .filter((workflow) => workflow.id !== deletedWorkflowId)
    .map((workflow) => workflow.id);
}

export function nextActiveWorkflowIdAfterDelete(workflows, activeWorkflowId, deletedWorkflowId) {
  if (activeWorkflowId !== deletedWorkflowId) return activeWorkflowId;
  return workflows.find((workflow) => workflow.id !== deletedWorkflowId)?.id;
}

function withoutKey(record, key) {
  const nextRecord = { ...record };
  delete nextRecord[key];
  return nextRecord;
}

function isUrlPath(pathValue = "") {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(pathValue));
}

function isAbsolutePath(pathValue = "") {
  const value = String(pathValue);
  return (
    value.startsWith("/") ||
    value.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function resolveDisplayPath(pathValue = "", basePath = "") {
  const value = String(pathValue ?? "").trim();
  if (!value || isUrlPath(value) || isAbsolutePath(value)) {
    return value;
  }
  if (!basePath) return value;
  if (value === ".") return basePath;
  const separator = String(basePath).includes("\\") && !String(basePath).includes("/") ? "\\" : "/";
  return `${String(basePath).replace(/[\\/]+$/, "")}${separator}${value.replace(/^[\\/]+/, "")}`;
}

function replacePathPrefix(path, sourcePath, destinationPath, isDirectory) {
  if (!path || !sourcePath || !destinationPath) return path;
  if (!isDirectory) return path === sourcePath ? destinationPath : path;
  const normalizedPath = String(path).replaceAll("\\", "/");
  const normalizedSource = String(sourcePath).replaceAll("\\", "/").replace(/\/$/, "");
  if (normalizedPath !== normalizedSource && !normalizedPath.startsWith(`${normalizedSource}/`)) {
    return path;
  }
  const suffix = normalizedPath.slice(normalizedSource.length);
  const separator = String(destinationPath).includes("\\") && !String(destinationPath).includes("/")
    ? "\\"
    : "/";
  return `${String(destinationPath).replace(/[\\/]+$/, "")}${suffix.replaceAll("/", separator)}`;
}

function pathMatchesChange(path, changedPath, isDirectory) {
  if (!path || !changedPath) return false;
  if (!isDirectory) return path === changedPath;
  const normalizedPath = String(path).replaceAll("\\", "/");
  const normalizedChanged = String(changedPath).replaceAll("\\", "/").replace(/\/$/, "");
  return normalizedPath === normalizedChanged || normalizedPath.startsWith(`${normalizedChanged}/`);
}

export function WorkflowSidebar({
  activeWorkflow,
  activeWorkflowId,
  loading,
  query,
  runState,
  workflows,
  view = "graph",
  onCodeFileOpen,
  onCodeFilesystemChange,
  onCreate,
  onDeleteWorkflow,
  onDuplicateWorkflow,
  onQueryChange,
  onRefresh,
  onRenameWorkflow,
  onResizeKeyDown,
  onResizeStart,
  onRunWorkflow,
  onSelect,
  onViewChange,
  width,
}) {
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const [projectMenu, setProjectMenu] = useState(null);
  const [copiedProjectRoot, setCopiedProjectRoot] = useState("");
  const [projectLabels, setProjectLabels] = useState(loadProjectLabels);
  const [renamingProjectRoot, setRenamingProjectRoot] = useState("");
  const [projectLabelDraft, setProjectLabelDraft] = useState("");
  const workflowGroups = useMemo(
    () => groupWorkflowsByProject(workflows, projectLabels),
    [projectLabels, workflows],
  );
  const canOpenCode = activeWorkflow?.sourceFormat === "radish";

  useEffect(() => {
    try {
      window.localStorage?.setItem(PROJECT_LABELS_STORAGE_KEY, JSON.stringify(projectLabels));
    } catch {
      // Labels still work for this session when browser storage is unavailable.
    }
  }, [projectLabels]);

  async function copyProjectRoot(root) {
    try {
      await navigator.clipboard.writeText(root);
      setCopiedProjectRoot(root);
      window.setTimeout(() => setCopiedProjectRoot(""), 1400);
    } catch {
      // The menu retains the path as a title so it can still be copied manually.
      return;
    }
    setProjectMenu(null);
  }

  async function openProjectRoot(root) {
    await window.goferDesktop?.workspace?.openPath?.(root);
    setProjectMenu(null);
  }

  useEffect(() => {
    if (!projectMenu) return undefined;
    const close = () => setProjectMenu(null);
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setProjectMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [projectMenu]);

  function showProjectMenu(event, group) {
    event.preventDefault();
    event.stopPropagation();
    setProjectMenu({
      ...projectMenuPosition(event.clientX, event.clientY),
      name: group.name,
      root: group.root,
    });
  }

  function startProjectRename(group) {
    setProjectLabelDraft(group.name);
    setRenamingProjectRoot(group.root);
    setProjectMenu(null);
  }

  function commitProjectRename(root) {
    const label = projectLabelDraft.trim();
    const folderName = projectNameFromPath(root);
    setProjectLabels((current) => {
      if (!label || label === folderName) return withoutKey(current, root);
      return { ...current, [root]: label };
    });
    setRenamingProjectRoot("");
    setProjectLabelDraft("");
  }

  function cancelProjectRename() {
    setRenamingProjectRoot("");
    setProjectLabelDraft("");
  }

  return (
    <aside
      className="studio-sidebar relative flex shrink-0 flex-col border-r border-line bg-white"
      style={{ width }}
    >
      <div
        aria-label="Resize workflows pane"
        aria-orientation="vertical"
        aria-valuemax={420}
        aria-valuemin={240}
        aria-valuenow={width}
        aria-valuetext={`${width} pixels wide`}
        className="absolute right-[-3px] top-0 z-20 h-full w-1.5 cursor-col-resize transition hover:bg-brand/40"
        role="separator"
        tabIndex={0}
        title="Resize workflows pane"
        onKeyDown={onResizeKeyDown}
        onPointerDown={onResizeStart}
      />
      <div className="px-3.5 pb-2 pt-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-brand text-white shadow-sm">
              <Waypoints size={17} />
            </span>
            <div>
              <h1 className="text-[13px] font-semibold leading-tight">Taskurotta</h1>
              <p className="text-[11px] leading-tight text-muted">
                {view === "code" ? "Project files" : "Workflow studio"}
              </p>
            </div>
          </div>
          <button
            className="studio-icon-button grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-slate-100 hover:text-ink"
            title="Refresh workflows"
            type="button"
            onClick={onRefresh}
          >
            {loading ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
          </button>
        </div>

        <div
          aria-label="Studio view"
          className="mt-3 flex h-8 items-center gap-0.5 rounded-lg bg-slate-100 p-0.5"
          role="tablist"
        >
          <button
            aria-selected={view === "graph"}
            className={`flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition ${
              view === "graph"
                ? "bg-white text-ink shadow-sm"
                : "text-muted hover:text-ink"
            }`}
            role="tab"
            type="button"
            onClick={() => onViewChange?.("graph")}
          >
            <Waypoints aria-hidden="true" className={view === "graph" ? "text-brand" : ""} size={13} />
            Graph
          </button>
          <button
            aria-disabled={!canOpenCode}
            aria-selected={view === "code"}
            className={`flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition ${
              view === "code"
                ? "bg-white text-ink shadow-sm"
                : canOpenCode
                  ? "text-muted hover:text-ink"
                  : "cursor-not-allowed text-muted opacity-45"
            }`}
            disabled={!canOpenCode}
            role="tab"
            title={canOpenCode ? "Open code view" : "Code view is available for Radish workflows"}
            type="button"
            onClick={() => onViewChange?.("code")}
          >
            <Code2 aria-hidden="true" className={view === "code" ? "text-brand" : ""} size={13} />
            Code
          </button>
        </div>

        <div className="mt-2.5 flex h-8 items-center gap-2 rounded-lg border border-transparent bg-slate-100 px-2.5 transition focus-within:border-indigo-500 focus-within:bg-white">
          <Search size={14} className="text-muted" />
          <input
            aria-label={view === "code" ? "Search files" : "Search workflows"}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-slate-400"
            placeholder={view === "code" ? "Search files" : "Search workflows"}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
      </div>

      {view === "graph" ? <div className="px-3.5 pb-2">
        <button
          className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-brand px-3 text-xs font-semibold text-white shadow-sm transition hover:bg-indigo-700"
          title="Create workflow"
          type="button"
          onClick={onCreate}
        >
          <Plus size={15} />
          Create workflow
        </button>
      </div> : null}

      <div className="workflow-scrollbar relative flex-1 overflow-y-auto px-2.5 pb-3 pt-1">
        {view === "code" ? (
          <CodeFileExplorer
            query={query}
            workflow={activeWorkflow}
            onFilesystemChange={onCodeFilesystemChange}
            onOpenFile={onCodeFileOpen}
          />
        ) : workflowGroups.length ? (
          workflowGroups.map(({ id, name, items, root }) => {
            const collapsed = Boolean(collapsedGroups[id]);
            return (
              <section
                key={id}
                className="mb-1 rounded-lg"
                aria-label={`${name} workflows`}
                onContextMenu={(event) => showProjectMenu(event, { name, root })}
              >
                <div className="group/folder flex h-8 items-center rounded-lg px-1.5 transition hover:bg-slate-100">
                  <button
                    aria-expanded={!collapsed}
                    className="flex shrink-0 items-center gap-1.5 text-left text-xs font-semibold text-ink"
                    type="button"
                    onClick={() =>
                      setCollapsedGroups((current) => ({ ...current, [id]: !current[id] }))
                    }
                  >
                    <ChevronDown
                      aria-hidden="true"
                      className={`shrink-0 text-muted transition ${collapsed ? "-rotate-90" : ""}`}
                      size={13}
                    />
                    <FolderOpen aria-hidden="true" className="shrink-0 text-muted" size={13} />
                  </button>
                  {renamingProjectRoot === root ? (
                    <input
                      autoFocus
                      aria-label={`Project label for ${projectNameFromPath(root)}`}
                      className="ml-1 h-6 min-w-0 flex-1 rounded-md border border-indigo-300 bg-white px-1.5 text-xs font-semibold text-ink outline-none ring-2 ring-indigo-100"
                      maxLength={120}
                      value={projectLabelDraft}
                      onBlur={() => commitProjectRename(root)}
                      onChange={(event) => setProjectLabelDraft(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") {
                          event.preventDefault();
                          cancelProjectRename();
                        }
                      }}
                    />
                  ) : (
                    <button
                      className="min-w-0 flex-1 truncate pl-1 text-left text-xs font-semibold text-ink"
                      title={`${name}\n${root}`}
                      type="button"
                      onClick={() =>
                        setCollapsedGroups((current) => ({ ...current, [id]: !current[id] }))
                      }
                    >
                      {name}
                    </button>
                  )}
                  <span className="text-[10px] font-medium text-muted">{items.length}</span>
                  <button
                    aria-haspopup="menu"
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted opacity-0 transition hover:bg-white hover:text-ink group-hover/folder:opacity-100 focus:opacity-100"
                    title={`${name} project actions`}
                    type="button"
                    onClick={(event) => {
                      const bounds = event.currentTarget.getBoundingClientRect();
                      event.stopPropagation();
                      setProjectMenu({
                        ...projectMenuPosition(bounds.right, bounds.bottom),
                        name,
                        root,
                      });
                    }}
                  >
                    <MoreVertical size={13} />
                  </button>
                </div>
                {!collapsed ? (
                  <div className="ml-3 space-y-0.5 border-l border-line py-0.5 pl-1.5">
                    {items.map((workflow) => (
                      <WorkflowListItem
                        key={workflow.id}
                        active={workflow.id === activeWorkflowId}
                        status={
                          runState?.running && runState.workflowId === workflow.id
                            ? "Running"
                            : workflow.status
                        }
                        workflow={workflow}
                        onDelete={() => onDeleteWorkflow(workflow)}
                        onDuplicate={() => onDuplicateWorkflow(workflow)}
                        onRename={(name) => onRenameWorkflow(workflow, name)}
                        onRun={() => onRunWorkflow(workflow)}
                        onSelect={() => onSelect(workflow.id)}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })
        ) : (
          <div className="rounded-[10px] border border-dashed border-line bg-slate-50 p-4 text-xs leading-5 text-muted">
            {loading ? "Loading workflows..." : "No workflows found."}
          </div>
        )}
        {projectMenu ? (
          <div
            aria-label={`${projectMenu.name} project actions`}
            className="fixed z-[80] w-52 rounded-lg border border-line bg-white p-1 shadow-panel"
            role="menu"
            style={{ left: projectMenu.x, top: projectMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-ink hover:bg-slate-50"
              role="menuitem"
              type="button"
              onClick={() => startProjectRename(projectMenu)}
            >
              <PencilLine size={14} /> Rename
            </button>
            <button
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-ink hover:bg-slate-50"
              role="menuitem"
              type="button"
              onClick={() => copyProjectRoot(projectMenu.root)}
            >
              {copiedProjectRoot === projectMenu.root ? <Check size={14} /> : <Copy size={14} />}
              {copiedProjectRoot === projectMenu.root ? "Path copied" : "Copy path"}
            </button>
            <button
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-ink hover:bg-slate-50"
              role="menuitem"
              type="button"
              onClick={() => openProjectRoot(projectMenu.root)}
            >
              <FolderOpen size={14} /> Open in file explorer
            </button>
            <p className="truncate px-2.5 pb-1.5 pt-1 font-mono text-[10px] text-muted" title={projectMenu.root}>
              {projectMenu.root}
            </p>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

export function projectMenuPosition(clientX, clientY, viewportWidth = window.innerWidth, viewportHeight = window.innerHeight) {
  const menuWidth = 208;
  const menuHeight = 154;
  const requestedX = Number.isFinite(clientX) ? clientX : 8;
  const requestedY = Number.isFinite(clientY) ? clientY : 8;
  const availableWidth = Number.isFinite(viewportWidth) ? viewportWidth : 1024;
  const availableHeight = Number.isFinite(viewportHeight) ? viewportHeight : 768;
  return {
    x: Math.max(8, Math.min(requestedX, availableWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(requestedY, availableHeight - menuHeight - 8)),
  };
}

export function groupWorkflowsByProject(workflows, projectLabels = {}) {
  const groups = new Map();
  for (const workflow of workflows ?? []) {
    const root = workflow.projectRoot || workflow.sourcePath || "Unregistered";
    const id = `project:${root}`;
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        name: projectLabels[root]?.trim() || projectNameFromPath(root),
        defaultName: projectNameFromPath(root),
        root,
        items: [],
      });
    }
    groups.get(id).items.push(workflow);
  }
  return [...groups.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.root.localeCompare(right.root));
}

export function loadProjectLabels() {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage?.getItem(PROJECT_LABELS_STORAGE_KEY) ?? "{}");
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([root, label]) => root.trim() && typeof label === "string" && label.trim(),
      ),
    );
  } catch {
    return {};
  }
}

function projectNameFromPath(pathValue) {
  const parts = String(pathValue).replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) || "Unregistered";
}

function WorkflowListItem({
  active,
  onDelete,
  onDuplicate,
  onRename,
  onRun,
  onSelect,
  status,
  workflow,
}) {
  const menuRef = useRef(null);
  const nameInputRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(workflow.name);

  useEffect(() => {
    if (!menuOpen) return undefined;

    function handlePointerDown(event) {
      if (menuRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [menuOpen]);

  useEffect(() => {
    setDraftName(workflow.name);
  }, [workflow.name]);

  useEffect(() => {
    if (!renaming) return;
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, [renaming]);

  function commitRename() {
    const nextName = draftName.trim();
    setRenaming(false);
    if (!nextName) {
      setDraftName(workflow.name);
      return;
    }
    if (nextName !== workflow.name) {
      onRename(nextName);
    }
  }

  function cancelRename() {
    setRenaming(false);
    setDraftName(workflow.name);
  }

  return (
    <div
      className={`group relative w-full rounded-lg text-left transition ${
        active
          ? "bg-indigo-50"
          : "bg-transparent hover:bg-slate-100"
      }`}
    >
      <div
        role="button"
        tabIndex={0}
        className="w-full rounded-lg px-2 py-2 pr-8 text-left"
        onClick={() => {
          if (!renaming) {
            onSelect();
          }
        }}
        onKeyDown={(event) => {
          if (!renaming && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            onSelect();
          }
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {renaming ? (
              <input
                ref={nameInputRef}
                className="w-full rounded-md border border-teal-300 bg-white px-2 py-1 text-sm font-semibold text-ink outline-none ring-2 ring-teal-100"
                value={draftName}
                onBlur={commitRename}
                onChange={(event) => setDraftName(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
              />
            ) : (
              <p className={`truncate text-xs font-medium ${active ? "text-indigo-700" : "text-ink"}`}>{workflow.name}</p>
            )}
            <p className="mt-0.5 truncate text-[10px] leading-4 text-muted">{workflow.status ?? "Ready"}</p>
          </div>
          <StatusDot status={status} />
        </div>
      </div>
      <div ref={menuRef} className="absolute right-1 top-1.5">
        <button
          className="grid h-7 w-7 place-items-center rounded-md text-muted opacity-70 transition hover:bg-slate-100 hover:text-ink group-hover:opacity-100 dark:hover:bg-[#2a2a2a]"
          title="Workflow actions"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((current) => !current);
          }}
        >
          <MoreVertical size={14} />
        </button>
        {menuOpen ? (
          <div className="absolute right-0 top-8 z-40 w-48 rounded-lg border border-line bg-white p-1 shadow-panel">
            <button
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50 hover:text-ink dark:hover:bg-[#2a2a2a]"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                onRun();
              }}
            >
              <Play size={15} />
              Run workflow
            </button>
            <button
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50 hover:text-ink dark:hover:bg-[#2a2a2a]"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                setRenaming(true);
              }}
            >
              <PencilLine size={15} />
              Rename workflow
            </button>
            <button
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50 hover:text-ink dark:hover:bg-[#2a2a2a]"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                onDuplicate();
              }}
            >
              <Copy size={15} />
              Duplicate workflow
            </button>
            <div className="my-1 border-t border-line" />
            <button
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-red-700 transition hover:bg-red-50 dark:hover:bg-[#3a2424]"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                onDelete();
              }}
            >
              <Trash2 size={15} />
              Delete workflow
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function TopBar({
  editorState,
  saveState,
  theme,
  updateState,
  workflow,
  view = "graph",
  onApplyUpdate,
  onCheckForUpdates,
  onOpenHistory,
  onRetrySave,
  onSaveRadish,
  onToggleTheme,
}) {
  const nodeCount = workflow.nodes?.length ?? 0;
  const edgeCount = workflow.edges?.length ?? 0;
  const hasUpdateBridge = Boolean(window.goferUpdates?.check);
  const sourceParts = String(workflow.sourcePath ?? "").replaceAll("\\", "/").split("/").filter(Boolean);
  const folderName = sourceParts.length > 1 ? sourceParts.at(-2) : "Unfiled";
  const editorDocument = editorState?.document;
  const editorDiagnostics = [
    ...(editorDocument?.diagnostics ?? []),
    ...(editorDocument?.preflight?.diagnostics ?? []),
  ];
  const editorErrorCount = editorDiagnostics.filter((item) => item.severity === "error").length;
  const editorWarningCount = editorDiagnostics.filter((item) => item.severity === "warning").length;
  const editorLineCount = editorDocument?.source
    ? editorDocument.source.split(/\r\n|\r|\n/).length
    : 0;
  return (
    <header className="studio-topbar flex h-[54px] shrink-0 items-center justify-between border-b border-line bg-white px-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-xs text-muted">
            {view === "code" ? workflow.projectName || folderName : folderName}
          </span>
          <span aria-hidden="true" className="text-muted">/</span>
          <h2 className="truncate text-sm font-semibold">
            {view === "code" ? "workflow.rad" : workflow.name}
          </h2>
        </div>
        <div className="hidden items-center gap-1.5 xl:flex">
          <span className="rounded-full border border-line bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-muted">
            {view === "code"
              ? editorLineCount
                ? `${editorLineCount} lines`
                : "Opening"
              : workflow.invalid
                ? workflow.sourceFormat === "radish"
                  ? "Invalid Radish"
                  : "Invalid TOML"
                : `${nodeCount} nodes`}
          </span>
          {view === "code" && editorErrorCount ? (
            <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700">
              {editorErrorCount} {editorErrorCount === 1 ? "error" : "errors"}
            </span>
          ) : null}
          {view === "code" && editorWarningCount ? (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
              {editorWarningCount} {editorWarningCount === 1 ? "warning" : "warnings"}
            </span>
          ) : null}
          {view === "graph" && !workflow.invalid ? (
            <span className="rounded-full border border-line bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-muted">
              {edgeCount} edges
            </span>
          ) : null}
          {view === "code" && editorDocument ? (
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                editorDocument.dirty
                  ? "border-indigo-200 bg-indigo-50 text-indigo-700"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700"
              }`}
            >
              {editorDocument.dirty ? "Unsaved" : "Saved"}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {view === "graph" ? <WorkflowSaveStatus saveState={saveState} onRetry={onRetrySave} /> : null}
        {view === "code" && editorDocument ? (
          <button
            className="inline-flex h-8 items-center gap-2 rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink transition hover:border-indigo-300 hover:text-indigo-700 disabled:cursor-default disabled:opacity-55"
            disabled={!editorDocument.dirty || editorState?.saving}
            title={editorDocument.dirty ? "Save workflow.rad" : "workflow.rad is saved"}
            type="button"
            onClick={onSaveRadish}
          >
            {editorState?.saving ? (
              <Loader2 aria-hidden="true" className="animate-spin" size={14} />
            ) : editorDocument.dirty ? (
              <Save aria-hidden="true" size={14} />
            ) : (
              <Check aria-hidden="true" size={14} />
            )}
            {editorState?.saving ? "Saving" : editorDocument.dirty ? "Save" : "Saved"}
          </button>
        ) : null}
        {hasUpdateBridge ? (
          updateState?.available ? (
            <button
              className="inline-flex h-8 items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-wait disabled:opacity-70"
              disabled={Boolean(updateState.downloading)}
              title={updateButtonTitle(updateState)}
              type="button"
              onClick={onApplyUpdate}
            >
              {updateState.downloading ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Download size={15} />
              )}
              {updateButtonLabel(updateState)}
            </button>
          ) : (
            <button
              className="studio-icon-button grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-slate-100 hover:text-ink"
              title={
                updateState?.error
                  ? `Update check failed: ${updateState.error}`
                  : "Check for updates"
              }
              type="button"
              onClick={onCheckForUpdates}
            >
              <RefreshCw
                size={16}
                className={updateState?.checking ? "animate-spin" : ""}
              />
            </button>
          )
        ) : null}
        <button
          className="studio-icon-button grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-slate-100 hover:text-ink"
          title="Workflow history"
          type="button"
          onClick={onOpenHistory}
        >
          <History size={16} />
        </button>
        <button
          className="studio-icon-button grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-slate-100 hover:text-ink"
          title={theme === "dark" ? "Light mode" : "Dark mode"}
          type="button"
          onClick={onToggleTheme}
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
    </header>
  );
}

function WorkflowSaveStatus({ saveState, onRetry }) {
  if (!saveState?.status) return null;

  if (saveState.status === "error") {
    return (
      <div
        aria-atomic="true"
        aria-live="assertive"
        className="inline-flex h-9 items-center gap-2 rounded-lg bg-red-50 px-3 text-xs font-medium text-red-800 dark:bg-red-950/40 dark:text-red-200"
        role="alert"
        title={saveState.error || "Unable to save workflow"}
      >
        <AlertCircle aria-hidden="true" size={15} />
        <span>Couldn&apos;t save</span>
        {saveState.error ? (
          <span className="max-w-32 truncate text-red-700 dark:text-red-300">
            {saveState.error}
          </span>
        ) : null}
        <span aria-hidden="true">—</span>
        <button
          className="font-semibold underline underline-offset-2 hover:no-underline"
          type="button"
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      aria-atomic="true"
      aria-busy={saveState.status === "saving" || undefined}
      aria-live="polite"
      className="inline-flex h-9 items-center gap-2 px-2 text-xs font-medium text-muted"
      role="status"
    >
      {saveState.status === "saving" ? (
        <>
          <Loader2 aria-hidden="true" size={15} className="animate-spin" />
          Saving…
        </>
      ) : (
        <>
          <Check aria-hidden="true" size={15} />
          Saved
        </>
      )}
    </div>
  );
}

function updateButtonLabel(updateState) {
  if (updateState?.downloaded) return "Restart to update";
  if (updateState?.downloading) {
    const percent = Math.max(0, Math.min(100, updateState.progress?.percent ?? 0));
    return `Downloading ${Math.round(percent)}%`;
  }
  return `Update ${updateState?.info?.version ?? "available"}`;
}

function updateButtonTitle(updateState) {
  if (updateState?.downloaded) return "Restart Taskurotta and apply the downloaded update";
  if (updateState?.downloading) return "Downloading update";
  return "Download, install, and restart Taskurotta";
}

export function WorkflowHistoryDialog({
  diff,
  error,
  loading,
  revisions,
  workflow,
  onClose,
  onPreview,
  onRefresh,
  onRestore,
}) {
  return (
    <Dialog
      description={`${workflow.name} revision history`}
      onClose={onClose}
      panelClassName="flex max-h-[86vh] w-full max-w-[920px] flex-col rounded-lg border border-line bg-white shadow-panel"
      panelProps={{ "aria-busy": loading || undefined }}
      title="Workflow history"
    >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">Workflow history</h2>
            <p className="truncate text-xs text-muted">
              {workflow.name} · {workflow.id}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted transition hover:bg-slate-50 hover:text-ink"
              title="Refresh history"
              type="button"
              onClick={onRefresh}
            >
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-slate-100 hover:text-ink"
              title="Close"
              type="button"
              onClick={onClose}
            >
              <X size={17} />
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)] overflow-hidden">
          <div className="workflow-scrollbar min-h-0 overflow-y-auto border-r border-line">
            {error ? (
              <div className="border-b border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
                {error}
              </div>
            ) : null}
            {loading && !revisions.length ? (
              <div className="px-4 py-6 text-sm text-muted">Loading history...</div>
            ) : null}
            {!loading && !revisions.length ? (
              <div className="px-4 py-6 text-sm text-muted">No revisions found.</div>
            ) : null}
            {revisions.map((revision) => (
              <div key={revision.revisionId} className="border-b border-line px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">
                      {formatRevisionDate(revision.createdAt)}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {revision.source} · {revision.author}
                    </p>
                  </div>
                  <button
                    className="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-muted transition hover:bg-slate-50 hover:text-ink"
                    type="button"
                    onClick={() => onPreview(revision.revisionId)}
                  >
                    Diff
                  </button>
                </div>
                <ul className="mt-2 space-y-1 text-xs text-slate-600">
                  {(revision.summary ?? []).slice(0, 4).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <div className="mt-3 flex gap-2">
                  <button
                    className="rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                    type="button"
                    onClick={() => onRestore(revision.revisionId)}
                  >
                    Restore
                  </button>
                  <button
                    className="rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                    type="button"
                    onClick={() => onRestore(revision.revisionId, { asCopy: true })}
                  >
                    Restore as copy
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="min-h-0 overflow-hidden">
            {diff ? (
              <div className="flex h-full flex-col">
                <div className="border-b border-line px-4 py-3">
                  <p className="text-sm font-semibold">Revision diff</p>
                  <p className="mt-1 text-xs text-muted">
                    {(diff.summary ?? []).join("; ") || "No material changes"}
                  </p>
                </div>
                <pre className="workflow-scrollbar min-h-0 flex-1 overflow-auto bg-[#0f172a] p-4 text-xs leading-5 text-slate-100">
                  {diff.tomlDiff || "No TOML diff."}
                </pre>
              </div>
            ) : (
              <div className="grid h-full place-items-center px-8 text-center text-sm text-muted">
                Select a revision diff to inspect TOML and graph-level changes.
              </div>
            )}
          </div>
        </div>
    </Dialog>
  );
}

function formatRevisionDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function ChatPane({ activeWorkflowId, onResizeKeyDown, onResizeStart, width, workflow, workflows }) {
  const chatScrollRef = useRef(null);
  const conversationMenuRef = useRef(null);
  const [draft, setDraft] = useState("");
  const [providerId, setProviderId] = useState("codex");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const {
    capabilities: providers,
    error: providerDiscoveryError,
    loading: providersLoading,
    refresh: refreshProviders,
  } = useProviderCapabilities();
  const [threads, setThreads] = useState(loadChatThreads);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [messagesByThread, setMessagesByThread] = useState({});
  const [chatStateByThread, setChatStateByThread] = useState({});
  const [chatAnnouncementByThread, setChatAnnouncementByThread] = useState({});
  const [backgroundChatAnnouncement, setBackgroundChatAnnouncement] = useState("");
  const [showTypingByThread, setShowTypingByThread] = useState({});
  const [typingDelayByThread, setTypingDelayByThread] = useState({});
  const [expandedThoughtGroups, setExpandedThoughtGroups] = useState({});
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false);
  const chatAbortControllersRef = useRef({});
  const deletedChatThreadIdsRef = useRef(new Set());
  const activeThreadIdRef = useRef(null);
  const workflowName = workflow?.name ?? "All workflows";
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const messages = useMemo(
    () =>
      activeThreadId
        ? messagesByThread[activeThreadId] ?? loadChatMessages(chatStorageKeyFor(activeThreadId))
        : [],
    [activeThreadId, messagesByThread],
  );
  const chatState = activeThreadId
    ? chatStateByThread[activeThreadId] ?? { sending: false, error: "" }
    : { sending: false, error: "" };
  const chatAnnouncement = activeThreadId
    ? chatAnnouncementByThread[activeThreadId] ?? ""
    : "";
  const showTypingIndicator = Boolean(activeThreadId && showTypingByThread[activeThreadId]);
  const typingDelayKey = activeThreadId ? typingDelayByThread[activeThreadId] ?? 0 : 0;
  const workflowContext = useMemo(
    () => ({
      id: activeThreadId ? `workflow-assistant:${activeThreadId}` : "workflow-assistant",
      chatThreadId: activeThreadId,
      selectedWorkflowId: activeWorkflowId ?? null,
      workflows: workflows ?? [],
    }),
    [activeThreadId, activeWorkflowId, workflows],
  );
  const chatItems = useMemo(() => buildChatItems(messages), [messages]);

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  useEffect(() => {
    const current = providers.find((provider) => provider.id === providerId);
    const nextProvider =
      (current?.available && current.discoveryStatus === "ready" && current) ??
      providers.find((provider) => provider.available && provider.discoveryStatus === "ready");
    if (!nextProvider) return;
    const nextModel =
      nextProvider.models?.find((item) => item.id === nextProvider.defaultModel) ??
      nextProvider.models?.[0];
    if (!nextModel) return;
    if (providerId !== nextProvider.id) setProviderId(nextProvider.id);
    if (!nextProvider.models?.some((item) => item.id === model)) setModel(nextModel.id);
    if (effort && !nextModel.efforts?.some((item) => item.id === effort)) {
      setEffort(nextModel.defaultEffort ?? "");
    }
  }, [effort, model, providerId, providers]);

  useEffect(() => {
    if (!activeThreadId) {
      setDraft("");
      setConversationMenuOpen(false);
      return;
    }

    setMessagesByThread((current) =>
      current[activeThreadId]
        ? current
        : {
            ...current,
            [activeThreadId]: loadChatMessages(chatStorageKeyFor(activeThreadId)),
          },
    );
    setDraft("");
    setExpandedThoughtGroups({});
    setConversationMenuOpen(false);
  }, [activeThreadId]);

  useEffect(() => {
    if (!activeThreadId) return undefined;

    if (!chatState.sending) {
      setShowTypingByThread((current) => ({ ...current, [activeThreadId]: false }));
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setShowTypingByThread((current) => ({ ...current, [activeThreadId]: true }));
    }, 2000);

    return () => window.clearTimeout(timeoutId);
  }, [activeThreadId, chatState.sending, typingDelayKey]);

  useEffect(() => {
    if (!conversationMenuOpen) return undefined;

    function handlePointerDown(event) {
      if (conversationMenuRef.current?.contains(event.target)) return;
      setConversationMenuOpen(false);
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [conversationMenuOpen]);

  useEffect(() => {
    if (!showTypingIndicator) return;

    window.requestAnimationFrame(() => {
      scrollElementIntoView("typing-indicator");
    });
  }, [showTypingIndicator]);

  async function sendMessage() {
    const text = draft.trim();
    if (!text || chatState.sending) return;
    const targetThreadId = activeThreadId ?? createThread();
    const targetThreadTitle =
      activeThread?.title && activeThread.title !== "New thread"
        ? activeThread.title
        : threadTitleFromMessage(text);
    deletedChatThreadIdsRef.current.delete(targetThreadId);

    const userMessage = {
      id: uniqueClientId(),
      role: "user",
      body: text,
    };
    const nextMessages = [...messages, userMessage];
    updateThreadMessages(targetThreadId, nextMessages);
    updateThreadTitleFromMessage(targetThreadId, text);
    setDraft("");
    setChatStateByThread((current) => ({
      ...current,
      [targetThreadId]: { sending: true, error: "", hasNewResponse: false },
    }));
    setBackgroundChatAnnouncement("");
    setChatAnnouncementByThread((current) => ({ ...current, [targetThreadId]: "" }));
    const thoughtGroupId = uniqueClientId();
    window.requestAnimationFrame(() => {
      scrollMessageNearTop(userMessage.id);
    });

    function appendAssistantMessage(body, kind = "final", extra = {}) {
      if (deletedChatThreadIdsRef.current.has(targetThreadId)) return;
      const assistantMessageId = uniqueClientId();
      updateThreadMessages(targetThreadId, (current) => {
        const currentMessages = kind === "final"
          ? removeTrailingDuplicateOutputThought(current, body, thoughtGroupId)
          : current;
        return [
          ...currentMessages,
          {
            id: assistantMessageId,
            role: "assistant",
            kind,
            body,
            ...extra,
          },
        ];
      });
      window.requestAnimationFrame(() => {
        scrollElementIntoView(
          kind === "thought" && extra.groupId
            ? `thought-group-${extra.groupId}`
            : assistantMessageId,
        );
      });
    }

    function restartTypingDelay() {
      if (deletedChatThreadIdsRef.current.has(targetThreadId)) return;
      setShowTypingByThread((current) => ({ ...current, [targetThreadId]: false }));
      setTypingDelayByThread((current) => ({
        ...current,
        [targetThreadId]: (current[targetThreadId] ?? 0) + 1,
      }));
    }

    const abortController = new AbortController();
    chatAbortControllersRef.current[targetThreadId] = abortController;
    try {
      const response = await fetch(apiUrl("/chat/stream"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: abortController.signal,
        body: JSON.stringify(chatStreamRequestBody({
          provider: providerId,
          model,
          effort: effort || undefined,
          messages: nextMessages.map(({ role, body }) => ({ role, body })),
          workflow: {
            ...workflowContext,
            id: `workflow-assistant:${targetThreadId}`,
            chatThreadId: targetThreadId,
          },
        })),
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || `Chat API returned ${response.status}`);
      }
      if (!response.body) {
        throw new Error("Chat API did not provide a response stream");
      }

      let finalReceived = false;
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const event = parseChatStreamEvent(line);
            if (!event) continue;

            if (event.type === "thought") {
              const thought = String(event.text ?? "").trim();
              if (!thought) continue;
              appendAssistantMessage(thought, "thought", {
                groupId: thoughtGroupId,
                trace: event.trace && typeof event.trace === "object" ? event.trace : undefined,
              });
              restartTypingDelay();
            } else if (event.type === "compaction") {
              const compactedMessages = Array.isArray(event.messages)
                ? event.messages
                : null;
              if (compactedMessages) {
                updateThreadMessages(targetThreadId, compactedMessages);
              } else {
                appendAssistantMessage(
                  event.message || "Compacting workflow assistant context",
                  "system",
                  { role: "system" },
                );
              }
              restartTypingDelay();
            } else if (event.type === "final") {
              finalReceived = true;
              const body = event.message?.body ?? "";
              if (body.trim()) {
                appendAssistantMessage(body, "final");
              }
            } else if (event.type === "error") {
              throw new Error(event.error || "Workflow assistant failed");
            }
          }
        }
        if (done) break;
      }

      if (buffer.trim()) {
        const event = parseChatStreamEvent(buffer);
        if (event?.type === "final") {
          finalReceived = true;
          const body = event.message?.body ?? "";
          if (body.trim()) appendAssistantMessage(body, "final");
        } else if (event?.type === "error") {
          throw new Error(event.error || "Workflow assistant failed");
        }
      }

      if (!finalReceived) {
        throw new Error("Workflow assistant stream ended without a final response");
      }
      if (deletedChatThreadIdsRef.current.has(targetThreadId)) return;
      setChatStateByThread((current) => ({
        ...current,
        [targetThreadId]: {
          sending: false,
          error: "",
          hasNewResponse: activeThreadIdRef.current !== targetThreadId,
        },
      }));
      if (activeThreadIdRef.current !== targetThreadId) {
        setBackgroundChatAnnouncement(`Assistant response complete in ${targetThreadTitle}.`);
      }
      setChatAnnouncementByThread((current) => ({
        ...current,
        [targetThreadId]: "Workflow assistant response complete.",
      }));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (deletedChatThreadIdsRef.current.has(targetThreadId)) return;
        appendAssistantMessage("Workflow assistant stopped.", "final");
        setChatStateByThread((current) => ({
          ...current,
          [targetThreadId]: { sending: false, error: "", hasNewResponse: false },
        }));
        setChatAnnouncementByThread((current) => ({
          ...current,
          [targetThreadId]: "Workflow assistant stopped.",
        }));
        return;
      }
      if (deletedChatThreadIdsRef.current.has(targetThreadId)) return;
      setChatStateByThread((current) => ({
        ...current,
        [targetThreadId]: {
          sending: false,
          hasNewResponse: false,
          error: error instanceof Error ? error.message : "Unable to send message",
        },
      }));
    } finally {
      if (chatAbortControllersRef.current[targetThreadId] === abortController) {
        delete chatAbortControllersRef.current[targetThreadId];
      }
    }
  }

  function stopAssistant(threadId) {
    chatAbortControllersRef.current[threadId]?.abort();
    setShowTypingByThread((current) => ({ ...current, [threadId]: false }));
  }

  function updateThreadMessages(threadId, nextValue) {
    if (deletedChatThreadIdsRef.current.has(threadId)) return;
    setMessagesByThread((current) => {
      const currentMessages =
        current[threadId] ?? loadChatMessages(chatStorageKeyFor(threadId));
      const nextMessages =
        typeof nextValue === "function" ? nextValue(currentMessages) : nextValue;
      window.localStorage.setItem(chatStorageKeyFor(threadId), JSON.stringify(nextMessages));
      return { ...current, [threadId]: nextMessages };
    });
  }

  function createThread() {
    const now = new Date().toISOString();
    const thread = {
      id: uniqueClientId(),
      title: "New thread",
      createdAt: now,
      updatedAt: now,
    };
    const nextThreads = [thread, ...threads];
    persistChatThreads(nextThreads);
    setThreads(nextThreads);
    activeThreadIdRef.current = thread.id;
    setActiveThreadId(thread.id);
    setDraft("");
    return thread.id;
  }

  function openThread(threadId) {
    activeThreadIdRef.current = threadId;
    setActiveThreadId(threadId);
    setChatStateByThread((current) => {
      const threadState = current[threadId];
      if (!threadState?.hasNewResponse) return current;
      return {
        ...current,
        [threadId]: { ...threadState, hasNewResponse: false },
      };
    });
  }

  function showThreadList() {
    activeThreadIdRef.current = null;
    setActiveThreadId(null);
    setConversationMenuOpen(false);
  }

  function updateThreadTitleFromMessage(threadId, message) {
    setThreads((currentThreads) => {
      const nextThreads = currentThreads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              title: thread.title === "New thread" ? threadTitleFromMessage(message) : thread.title,
              updatedAt: new Date().toISOString(),
            }
          : thread,
      );
      persistChatThreads(nextThreads);
      return nextThreads;
    });
  }

  async function deleteThread(threadId) {
    deletedChatThreadIdsRef.current.add(threadId);
    chatAbortControllersRef.current[threadId]?.abort();
    delete chatAbortControllersRef.current[threadId];
    const nextThreads = threads.filter((thread) => thread.id !== threadId);
    persistChatThreads(nextThreads);
    setThreads(nextThreads);
    window.localStorage.removeItem(chatStorageKeyFor(threadId));
    setMessagesByThread((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    setChatStateByThread((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    setShowTypingByThread((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    setTypingDelayByThread((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    if (activeThreadId === threadId) {
      activeThreadIdRef.current = null;
      setActiveThreadId(null);
    }
    setExpandedThoughtGroups({});
    setConversationMenuOpen(false);

    try {
      const response = await fetch(
        apiUrl(`/chat/threads/${encodeURIComponent(threadId)}`),
        { method: "DELETE" },
      );
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || `Chat API returned ${response.status}`);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to delete chat handoff file";
      if (!deletedChatThreadIdsRef.current.has(threadId) && activeThreadId === threadId) {
        setChatStateByThread((current) => ({
          ...current,
          [threadId]: { sending: false, error: message },
        }));
      }
    }
  }

  function scrollMessageNearTop(messageId) {
    const scrollContainer = chatScrollRef.current;
    const messageElement = scrollContainer?.querySelector(`[data-message-id="${messageId}"]`);
    if (!scrollContainer || !messageElement) return;

    scrollContainer.scrollTo({
      top: messageElement.offsetTop - 12,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }

  function scrollElementIntoView(elementId) {
    const scrollContainer = chatScrollRef.current;
    const element = scrollContainer?.querySelector(`[data-message-id="${elementId}"]`);
    if (!scrollContainer || !element) return;

    element.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "nearest",
    });
  }

  return (
    <aside
      aria-busy={chatState.sending || undefined}
      className="studio-chat relative flex shrink-0 flex-col border-l border-line bg-white"
      style={{ width }}
    >
      <div aria-atomic="true" aria-live="polite" className="sr-only" role="status">
        {chatAnnouncement}
      </div>
      <div aria-atomic="true" aria-live="polite" className="sr-only" role="status">
        {backgroundChatAnnouncement}
      </div>
      <div aria-atomic="true" aria-live="assertive" className="sr-only" role="alert">
        {chatState.error}
      </div>
      <div
        aria-label="Resize chat pane"
        aria-orientation="vertical"
        aria-valuemax={520}
        aria-valuemin={300}
        aria-valuenow={width}
        aria-valuetext={`${width} pixels wide`}
        className="absolute left-[-3px] top-0 z-20 h-full w-1.5 cursor-col-resize transition hover:bg-brand/40"
        role="separator"
        tabIndex={0}
        title="Resize chat pane"
        onKeyDown={onResizeKeyDown}
        onPointerDown={onResizeStart}
      />
      <div className="flex h-[54px] shrink-0 items-center justify-between border-b border-line px-3.5">
        <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-muted">
          {activeThread ? (
            <button
              aria-label="Back to recent threads"
              className="studio-icon-button -ml-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-slate-100 hover:text-ink"
              title="Back to recent threads"
              type="button"
              onClick={showThreadList}
            >
              <ArrowLeft aria-hidden="true" size={16} />
            </button>
          ) : null}
          <GitBranch aria-hidden="true" size={14} />
          <span className="truncate">{workflow ? `Scoped to ${workflowName}` : "All workflows"}</span>
        </div>
        <div ref={conversationMenuRef} className="relative flex items-center gap-1">
          <button
            aria-label="New thread"
            className="studio-icon-button grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-slate-100 hover:text-ink"
            title="New thread"
            type="button"
            onClick={createThread}
          >
            <Plus aria-hidden="true" size={17} />
          </button>
          <button
            aria-expanded={conversationMenuOpen}
            aria-label="Recent threads"
            className="studio-icon-button grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-slate-100 hover:text-ink"
            title="Recent threads"
            type="button"
            onClick={() => setConversationMenuOpen((current) => !current)}
          >
            <History aria-hidden="true" size={16} />
          </button>
          {conversationMenuOpen ? (
            <div className="absolute right-0 top-9 z-50 max-h-80 w-72 overflow-y-auto rounded-[14px] border border-line bg-white p-1.5 shadow-panel">
              <p className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.06em] text-muted">Recent threads</p>
              <ThreadList
                activityByThread={chatStateByThread}
                threads={threads}
                activeThreadId={activeThreadId}
                onDelete={deleteThread}
                onOpen={openThread}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div
        ref={chatScrollRef}
        className="workflow-scrollbar flex-1 space-y-4 overflow-y-auto px-3.5 py-4"
      >
        {!activeThread ? (
          <div className="min-h-full" data-assistant-home>
            <div className="px-6 pb-8 pt-10 text-center">
              <span className="mx-auto grid h-9 w-9 place-items-center rounded-[10px] bg-indigo-50 text-indigo-600">
                <Bot size={18} />
              </span>
              <h2 className="mt-3 text-sm font-semibold text-ink">Workflow assistant</h2>
              <p className="mt-1 text-xs leading-5 text-muted">Ask about the selected workflow or describe a change.</p>
            </div>
            <section aria-labelledby="assistant-home-recent" className="border-t border-line pt-3">
              <h3 id="assistant-home-recent" className="px-2 pb-2 text-xs font-semibold text-muted">
                Recent threads
              </h3>
              <ThreadList
                activityByThread={chatStateByThread}
                threads={threads}
                activeThreadId={activeThreadId}
                onDelete={deleteThread}
                onOpen={openThread}
              />
            </section>
          </div>
        ) : (
          <>
            {chatItems.map((item) =>
              item.type === "thought-group" ? (
                <ThoughtGroup
                  key={item.id}
                  expanded={expandedThoughtGroups[item.id] !== false}
                  thoughts={item.thoughts}
                  onToggle={() =>
                    setExpandedThoughtGroups((current) => ({
                      ...current,
                      [item.id]: current[item.id] === false,
                    }))
                  }
                />
              ) : (
                <ChatMessageBubble key={item.message.id} message={item.message} />
              ),
            )}
            {showTypingIndicator ? <TypingIndicator /> : null}
            {chatState.error ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 text-red-700">
                {chatState.error}
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="relative shrink-0 border-t border-line p-3">
          <ProviderModelEffortFields
            capabilities={providers}
            className="mb-2"
            disabled={providersLoading}
            effort={effort}
            model={model}
            provider={providerId}
            onChange={(patch) => {
              if (patch.provider !== undefined) setProviderId(patch.provider);
              if (patch.model !== undefined) setModel(patch.model);
              if (patch.effort !== undefined) setEffort(patch.effort);
            }}
            onRefresh={refreshProviders}
          />
          {providerDiscoveryError ? (
            <p className="mb-2 text-xs text-red-600">{providerDiscoveryError}</p>
          ) : null}
          <div
            data-chat-composer
            className="relative min-h-28 overflow-hidden rounded-[14px] border border-line bg-white transition focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/10"
          >
            <textarea
              className="block h-28 max-h-32 w-full resize-none bg-transparent px-3 pb-12 pr-12 pt-3 text-sm leading-5 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:text-muted"
              disabled={chatState.sending}
              placeholder="Message this workflow"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendMessage();
                }
              }}
            />
            <button
                className={`absolute bottom-2 right-2 z-10 grid h-8 w-8 place-items-center rounded-lg transition disabled:cursor-not-allowed disabled:opacity-60 ${
                  chatState.sending
                    ? "border border-line bg-white text-red-600 hover:border-red-200 hover:bg-red-50"
                    : "bg-brand text-white hover:bg-indigo-700"
                }`}
                disabled={!chatState.sending && !draft.trim()}
                title={chatState.sending ? "Stop workflow assistant" : "Send message"}
                type="button"
                onClick={() =>
                  chatState.sending
                    ? activeThreadId && stopAssistant(activeThreadId)
                    : sendMessage()
                }
              >
                {chatState.sending ? (
                  <Square size={13} fill="currentColor" strokeWidth={1.7} />
                ) : (
                  <Send size={15} />
                )}
              </button>
          </div>
          <p className="mt-1.5 px-1 text-[10px] text-muted">Enter to send · Shift+Enter for a new line</p>
      </div>
    </aside>
  );
}

function ThreadList({ activeThreadId, activityByThread = {}, onDelete, onOpen, threads }) {
  if (threads.length) {
    return (
      <div className="space-y-1">
          {threads.map((thread) => (
            <div
              key={thread.id}
              className={`group flex items-center gap-1 rounded-lg p-1 transition ${
                thread.id === activeThreadId ? "bg-indigo-50" : "hover:bg-slate-50"
              }`}
            >
              <button
                className="min-w-0 flex-1 px-2 py-1.5 text-left"
                type="button"
                onClick={() => onOpen(thread.id)}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <div className="min-w-0 flex-1 truncate text-xs font-medium text-ink">
                    {thread.title}
                  </div>
                  <ThreadActivityIndicator state={activityByThread[thread.id]} />
                </div>
                <div className="mt-0.5 text-[10px] text-muted">{formatThreadDate(thread.updatedAt)}</div>
              </button>
              <button
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted opacity-70 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
                title="Delete thread"
                type="button"
                onClick={() => onDelete(thread.id)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
      </div>
    );
  }

  return (
    <p className="px-2 py-4 text-center text-xs text-muted">No thread history yet.</p>
  );
}

function ThreadActivityIndicator({ state }) {
  if (state?.sending) {
    return (
      <span
        className="grid h-4 w-4 shrink-0 place-items-center text-brand"
        title="Assistant response running"
      >
        <Loader2 aria-hidden="true" className="animate-spin" size={13} />
        <span className="sr-only">Running</span>
      </span>
    );
  }

  if (state?.hasNewResponse) {
    return (
      <span
        className="grid h-4 w-4 shrink-0 place-items-center"
        title="Assistant response complete"
      >
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-blue-500" />
        <span className="sr-only">Completed</span>
      </span>
    );
  }

  return null;
}

function TypingIndicator() {
  return (
    <div className="flex justify-start" data-message-id="typing-indicator" role="status">
      <div className="max-w-[86%] rounded-lg border border-line bg-white px-3 py-2 text-sm leading-6 text-slate-700 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">Workflow assistant is typing</span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.2s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.1s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" />
          </span>
        </div>
      </div>
    </div>
  );
}

function ChatMessageBubble({ message }) {
  const isSystem = message.role === "system" || message.kind === "system";
  const isUser = message.role === "user";
  return (
    <div
      data-message-id={message.id}
      className={`flex ${
        isSystem ? "justify-center" : message.role === "user" ? "justify-end" : "justify-start"
      }`}
    >
      <div
        className={`${isSystem ? "max-w-[86%]" : "w-full min-w-0"} rounded-lg px-3 py-2 text-sm leading-6 ${
          isSystem
            ? "border border-line bg-slate-50 text-xs font-medium text-muted"
            : message.role === "user"
            ? "bg-brand text-white"
            : "border border-line bg-white text-slate-700 shadow-sm"
        }`}
      >
        {isSystem ? (
          <span className="whitespace-pre-wrap">{message.body}</span>
        ) : (
          <MarkdownMessage inverse={isUser} value={message.body} />
        )}
      </div>
    </div>
  );
}

function MarkdownMessage({ compact = false, inverse = false, value }) {
  const blocks = parseMinimalMarkdown(value);
  return (
    <div className={`min-w-0 break-words ${compact ? "space-y-2" : "space-y-3"}`}>
      {blocks.map((block, blockIndex) => {
        const key = `${block.type}-${blockIndex}`;
        if (block.type === "code") {
          return (
            <pre
              key={key}
              className={`workflow-scrollbar max-w-full overflow-auto rounded-md border px-3 py-2 font-mono text-[11px] leading-5 ${
                inverse
                  ? "border-white/20 bg-black/20 text-white"
                  : "border-line bg-slate-50 text-slate-700 dark:bg-[#111113]"
              }`}
            >
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.type === "heading") {
          const Heading = `h${block.level}`;
          return (
            <Heading key={key} className="font-semibold leading-5 text-inherit">
              <MarkdownInline inverse={inverse} tokens={block.tokens} />
            </Heading>
          );
        }
        if (block.type === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List
              key={key}
              className={`ml-5 space-y-1 ${block.ordered ? "list-decimal" : "list-disc"}`}
            >
              {block.items.map((tokens, itemIndex) => (
                <li key={`${key}-${itemIndex}`}>
                  <MarkdownInline inverse={inverse} tokens={tokens} />
                </li>
              ))}
            </List>
          );
        }
        if (block.type === "quote") {
          return (
            <blockquote
              key={key}
              className={`border-l pl-3 ${inverse ? "border-white/40" : "border-line text-muted"}`}
            >
              <MarkdownInline inverse={inverse} tokens={block.tokens} />
            </blockquote>
          );
        }
        return (
          <p key={key}>
            <MarkdownInline inverse={inverse} tokens={block.tokens} />
          </p>
        );
      })}
    </div>
  );
}

function MarkdownInline({ inverse, tokens }) {
  return tokens.map((token, index) => {
    const key = `${token.type}-${index}`;
    if (token.type === "code") {
      return (
        <code
          key={key}
          className={`rounded px-1 py-0.5 font-mono text-[0.9em] ${
            inverse ? "bg-white/15 text-white" : "bg-slate-100 text-ink dark:bg-[#2a2a2e]"
          }`}
        >
          {token.text}
        </code>
      );
    }
    if (token.type === "strong") return <strong key={key}>{token.text}</strong>;
    if (token.type === "emphasis") return <em key={key}>{token.text}</em>;
    if (token.type === "link") {
      return (
        <a
          key={key}
          className={`underline underline-offset-2 ${inverse ? "text-white" : "text-brand"}`}
          href={token.href}
          rel="noreferrer"
          target="_blank"
        >
          {token.text}
        </a>
      );
    }
    return token.text;
  });
}

function ThoughtGroup({ expanded, onToggle, thoughts }) {
  const trace = buildThoughtTrace(thoughts);
  const count = trace.length;

  if (!count) return null;

  return (
    <div className="flex justify-start" data-message-id={thoughts[0]?.groupAnchorId}>
      <div className="w-full min-w-0 text-sm text-slate-700 dark:text-[#d4d4d4]">
        <button
          className="flex w-full items-center justify-between gap-3 rounded-md px-1 py-1.5 text-left transition hover:text-ink"
          type="button"
          onClick={onToggle}
        >
          <span className="min-w-0 text-xs font-semibold text-ink">
            {expanded ? "Hide thoughts" : "Show thoughts"}
            <span className="ml-1.5 font-normal text-muted">{count}</span>
          </span>
          <span className="grid h-6 w-6 place-items-center rounded-md text-muted transition">
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </span>
        </button>
        <div
          className={`grid transition-all duration-200 ease-out ${
            expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
          }`}
        >
          <div className="overflow-hidden">
            <div className="px-1 pb-1 pt-2">
              {trace.map((entry, index) => (
                <div
                  key={entry.key}
                  className={`relative ml-1 border-l border-line pl-5 ${
                    index === trace.length - 1 ? "pb-1" : "pb-4"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`absolute -left-[4.5px] top-1 h-2 w-2 rounded-full border border-white dark:border-[#18181a] ${
                      entry.kind === "tool" && entry.status !== "error"
                        ? "bg-emerald-500"
                        : entry.status === "error"
                        ? "bg-red-500"
                        : "bg-slate-400"
                    }`}
                  />
                  {entry.kind === "tool" || !entry.body ? (
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs leading-5">
                      {entry.title ? (
                        <span className="font-semibold text-ink">{entry.title}</span>
                      ) : null}
                      {entry.detail ? (
                        <span className="min-w-0 break-words text-muted">{entry.detail}</span>
                      ) : null}
                    </div>
                  ) : null}
                  {entry.kind === "summary" && entry.body ? (
                    <div className="text-xs leading-5 text-slate-600 dark:text-[#b9b9b9]">
                      <MarkdownMessage compact value={entry.body} />
                    </div>
                  ) : null}
                  {entry.kind === "tool" && (entry.input || entry.output) ? (
                    <div className="mt-2 overflow-hidden rounded-md border border-line bg-white dark:bg-[#181818]">
                      {entry.input ? <TracePayload label="In" value={entry.input} /> : null}
                      {entry.output ? <TracePayload label="Out" value={entry.output} divided={Boolean(entry.input)} /> : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TracePayload({ divided = false, label, value }) {
  return (
    <div className={`grid grid-cols-[2rem_minmax(0,1fr)] gap-2 px-2.5 py-2 ${divided ? "border-t border-line" : ""}`}>
      <span className="pt-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted">
        {label}
      </span>
      <pre className="workflow-scrollbar max-h-40 min-w-0 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-slate-600 dark:text-[#b9b9b9]">
        {value}
      </pre>
    </div>
  );
}

const chatThreadsStorageKey = "gofer-flow-chat-threads";

export function loadChatThreads() {
  try {
    const storedThreads = JSON.parse(window.localStorage.getItem(chatThreadsStorageKey) || "[]");
    if (
      Array.isArray(storedThreads) &&
      storedThreads.every((thread) => thread?.id && typeof thread.title === "string")
    ) {
      return storedThreads;
    }
  } catch {
    return [];
  }
  return [];
}

export function persistChatThreads(threads) {
  window.localStorage.setItem(chatThreadsStorageKey, JSON.stringify(threads));
}

export function threadTitleFromMessage(message) {
  const words = message.trim().split(/\s+/).slice(0, 8);
  const title = words.join(" ");
  return title.length < message.trim().length ? `${title}...` : title || "New thread";
}

function formatThreadDate(value) {
  if (!value) return "No messages yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No messages yet";
  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function defaultChatMessages() {
  return [];
}

export function chatStorageKeyFor(threadId) {
  return `gofer-flow-chat-thread:${threadId}`;
}

function loadChatMessages(storageKey) {
  try {
    const storedMessages = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    if (
      Array.isArray(storedMessages) &&
      storedMessages.every((message) => message?.role && typeof message.body === "string")
    ) {
      return storedMessages;
    }
  } catch {
    return defaultChatMessages();
  }
  return defaultChatMessages();
}

export function buildChatItems(messages) {
  const items = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (message.kind === "memory") {
      index += 1;
      continue;
    }
    if (message.kind !== "thought") {
      items.push({ type: "message", message });
      index += 1;
      continue;
    }

    const groupId = message.groupId || `legacy-${message.id}`;
    const thoughts = [];
    while (
      index < messages.length &&
      messages[index].kind === "thought" &&
      (messages[index].groupId || `legacy-${messages[index].id}`) === groupId
    ) {
      thoughts.push({
        ...messages[index],
        groupAnchorId: `thought-group-${groupId}`,
      });
      index += 1;
    }
    const nextMessage = messages[index];
    while (isDuplicateOutputThought(thoughts.at(-1), nextMessage)) thoughts.pop();
    if (thoughts.length) {
      items.push({
        id: `thought-group-${groupId}`,
        type: "thought-group",
        thoughts,
      });
    }
  }

  return items;
}

export function removeTrailingDuplicateOutputThought(messages, finalBody, groupId) {
  const finalMessage = { role: "assistant", kind: "final", body: finalBody };
  return messages.filter((message) => {
    if (message.groupId !== groupId || message.kind !== "thought") return true;
    if (isDuplicateOutputThought(message, finalMessage)) return false;
    const body = message.trace?.body ?? message.body;
    return message.trace?.kind === "tool" || !isProviderMetadataSummary(body);
  });
}

function isDuplicateOutputThought(thought, finalMessage) {
  if (!thought || thought.kind !== "thought" || finalMessage?.role !== "assistant") return false;
  if (finalMessage.kind === "thought" || finalMessage.kind === "memory") return false;
  if (thought.trace?.kind === "tool") return false;
  const thoughtBody = normalizeMarkdownText(thought.trace?.body ?? thought.body);
  const finalBody = normalizeMarkdownText(finalMessage.body);
  if (!thoughtBody || !finalBody) return false;
  if (thoughtBody === finalBody) return true;
  const untruncatedThought = thoughtBody.replace(/(?:\.{3}|…)$/, "").trim();
  return untruncatedThought.length >= 48 && finalBody.startsWith(untruncatedThought);
}

export function buildThoughtTrace(thoughts) {
  const entries = [];
  const traceIndexes = new Map();

  for (const thought of thoughts) {
    const hasStructuredTrace = Boolean(thought?.trace && typeof thought.trace === "object");
    const rawTrace = hasStructuredTrace
      ? thought.trace
      : { kind: "summary", title: "Thought", body: thought?.body };
    const kind = rawTrace.kind === "tool" ? "tool" : "summary";
    const traceId = rawTrace.id ? String(rawTrace.id) : "";
    const entry = {
      key: traceId ? `trace-${traceId}` : thought?.id || `trace-${entries.length}`,
      id: traceId,
      kind,
      title: kind === "summary"
        ? String(rawTrace.title || "")
        : String(rawTrace.title || "Tool"),
      detail: rawTrace.detail ? String(rawTrace.detail) : "",
      body: rawTrace.body
        ? String(rawTrace.body)
        : kind === "summary" && !hasStructuredTrace
        ? String(thought?.body || "")
        : "",
      input: rawTrace.input ? String(rawTrace.input) : "",
      output: rawTrace.output ? String(rawTrace.output) : "",
      status: String(rawTrace.status || ""),
    };

    if (kind === "summary" && isProviderMetadataSummary(entry.body)) continue;

    if (!traceId || !traceIndexes.has(traceId)) {
      if (traceId) traceIndexes.set(traceId, entries.length);
      entries.push(entry);
      continue;
    }

    const existingIndex = traceIndexes.get(traceId);
    const existing = entries[existingIndex];
    entries[existingIndex] = {
      ...existing,
      title: kind === "summary"
        ? entry.title || existing.title
        : existing.title === "Tool result"
        ? entry.title
        : existing.title,
      detail: entry.detail || existing.detail,
      body: entry.body || existing.body,
      input: existing.input || entry.input,
      output: entry.output || existing.output,
      status: entry.status || existing.status,
    };
  }

  return entries;
}

function isProviderMetadataSummary(value) {
  const compact = String(value ?? "").trim().replace(/\s+/g, " ");
  return /^(?:tokens? used\s*:?[\s]*)[\d,]+$/i.test(compact) ||
    /^[\d,]+\s+tokens? used$/i.test(compact);
}

export function normalizeMarkdownText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, "")
    .replace(/\[([^\]]+)\]\([^\s)]+\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseMinimalMarkdown(value) {
  const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: fence[1].trim(), text: code.join("\n") });
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        tokens: parseInlineMarkdown(heading[2]),
      });
      index += 1;
      continue;
    }

    const listItem = line.match(/^\s*(?:(\d+)[.)]|[-+*])\s+(.+)$/);
    if (listItem) {
      const ordered = Boolean(listItem[1]);
      const items = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*(?:(\d+)[.)]|[-+*])\s+(.+)$/);
        if (!match || Boolean(match[1]) !== ordered) break;
        items.push(parseInlineMarkdown(match[2]));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      const quoteLines = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*>\s?(.*)$/);
        if (!match) break;
        quoteLines.push(match[1]);
        index += 1;
      }
      blocks.push({ type: "quote", tokens: parseInlineMarkdown(quoteLines.join(" ")) });
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", tokens: parseInlineMarkdown(paragraph.join(" ")) });
  }

  return blocks;
}

function isMarkdownBlockStart(line) {
  return /^\s*```/.test(line) ||
    /^\s{0,3}#{1,3}\s+/.test(line) ||
    /^\s*(?:(?:\d+)[.)]|[-+*])\s+/.test(line) ||
    /^\s*>/.test(line);
}

function parseInlineMarkdown(value) {
  const tokens = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > cursor) tokens.push({ type: "text", text: value.slice(cursor, match.index) });
    const token = match[0];
    if (token.startsWith("`")) {
      tokens.push({ type: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**")) {
      tokens.push({ type: "strong", text: token.slice(2, -2) });
    } else if (token.startsWith("*")) {
      tokens.push({ type: "emphasis", text: token.slice(1, -1) });
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = safeMarkdownHref(link?.[2]);
      if (link && href) tokens.push({ type: "link", text: link[1], href });
      else tokens.push({ type: "text", text: token });
    }
    cursor = match.index + token.length;
  }
  if (cursor < value.length) tokens.push({ type: "text", text: value.slice(cursor) });
  return tokens.length ? tokens : [{ type: "text", text: value }];
}

function safeMarkdownHref(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

export function parseChatStreamEvent(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function uniqueClientId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatPreviewValue(value) {
  if (value && typeof value === "object") {
    if (typeof value.path === "string") return value.path;
    if (typeof value.name === "string") return value.name;
    return JSON.stringify(value);
  }
  return String(value);
}

function formatFanOutCount(fanOut) {
  if (!fanOut || fanOut.count == null) return "unknown";
  if (fanOut.countExact === false) {
    return `at least ${fanOut.countLowerBound ?? fanOut.count}`;
  }
  return String(fanOut.count);
}

function formatTriggerContextItems(triggerContext) {
  if (!triggerContext || typeof triggerContext !== "object") return [];
  const items = [];
  if (triggerContext.schedule) {
    const schedule = triggerContext.schedule;
    items.push(
      `Schedule: ${schedule.cron_expression ?? schedule.cron ?? "configured"} timezone=${schedule.timezone ?? "local"}`,
    );
  }
  if (triggerContext.watch) {
    const watch = triggerContext.watch;
    items.push(
      `Watch: ${watch.path ?? ""} glob=${watch.glob ?? "*"} mode=${watch.mode ?? "batch"}`,
    );
  }
  if (triggerContext.runContinuously) {
    items.push("Run continuously: enabled");
  }
  if (triggerContext.provided) {
    items.push(`Provided trigger context: ${JSON.stringify(triggerContext.provided)}`);
  }
  return items;
}

function buildRunPreviewTriggerContext(workflow) {
  const triggerContext = {};
  if (workflow.schedule) {
    triggerContext.schedule = workflow.schedule;
  }
  if (workflow.watch) {
    triggerContext.watch = workflow.watch;
  }
  if (workflow.runContinuously) {
    triggerContext.runContinuously = true;
  }
  return triggerContext;
}

function initialWorkflowParameters(workflow) {
  const values = {};
  for (const [name, spec] of Object.entries(workflow.inputs ?? workflow.parameters ?? {})) {
    if (spec.default !== undefined && spec.default !== null) {
      values[name] = spec.default;
    } else if (spec.type === "boolean") {
      values[name] = false;
    } else {
      values[name] = "";
    }
  }
  return values;
}

function validateWorkflowParameters(workflow, values) {
  const errors = {};
  for (const [name, spec] of Object.entries(workflow.inputs ?? workflow.parameters ?? {})) {
    const value = values[name];
    if (spec.required && (value === undefined || value === null || value === "")) {
      errors[name] = "Required";
      continue;
    }
    if (value === undefined || value === null || value === "") continue;
    if (spec.type === "number" && Number.isNaN(Number(value))) {
      errors[name] = "Enter a number";
    }
    if (spec.type === "enum" && Array.isArray(spec.choices) && !spec.choices.includes(value)) {
      errors[name] = "Choose a valid option";
    }
  }
  return errors;
}

export function RunPreviewDialog({
  plan,
  workflow,
  onCancel,
  onRun,
  initialParameters = {},
  executionMode = "local",
  onExecutionModeChange = () => {},
  queueState = { runners: [] },
}) {
  const parameterSchema = workflow.inputs ?? workflow.parameters ?? {};
  const [parameters, setParameters] = useState(() => ({
    ...initialWorkflowParameters(workflow),
    ...initialParameters,
  }));
  const [parameterErrors, setParameterErrors] = useState({});
  const warnings = plan?.warnings ?? [];
  const blockingDiagnostics = plan?.blockingDiagnostics ?? [];
  const destructiveActions = plan?.destructiveActions ?? [];
  const providers = plan?.providerRequirements ?? [];
  const requiredSecrets = plan?.requiredSecrets ?? [];
  const bindings = plan?.bindings ?? [];
  const triggerItems = formatTriggerContextItems(plan?.triggerContext);
  const generations = plan?.generations ?? [];
  const filesystemAccess = workflow.filesystemAccess ?? [];

  return (
    <Dialog
      description={`Review execution details for ${workflow.name}`}
      onClose={onCancel}
      panelClassName="flex max-h-[86vh] w-full max-w-[760px] flex-col rounded-lg border border-line bg-white shadow-panel"
      title={`Run preview: ${workflow.name}`}
    >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">Run preview: {workflow.name}</h2>
            <p className="text-xs text-muted">{workflow.id}</p>
          </div>
          <button
            className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-slate-100 hover:text-ink"
            title="Close"
            type="button"
            onClick={onCancel}
          >
            <X size={17} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
          {blockingDiagnostics.length > 0 ? (
            <PreviewSection title="Cannot run" tone="danger" items={blockingDiagnostics} />
          ) : null}
          {destructiveActions.length > 0 ? (
            <PreviewSection title="Destructive actions" tone="danger" items={destructiveActions} />
          ) : null}
          {warnings.length > 0 ? (
            <PreviewSection title="Warnings" tone="warning" items={warnings} />
          ) : null}
          {requiredSecrets.length > 0 ? (
            <PreviewSection title="Required secrets" items={requiredSecrets} />
          ) : null}
          {triggerItems.length > 0 ? (
            <PreviewSection title="Trigger context" items={triggerItems} />
          ) : null}
          {filesystemAccess.length > 0 ? (
            <PreviewSection
              title="Filesystem access"
              items={normalizeWorkflowFilesystemAccess(filesystemAccess).map((entry) => {
                const permissions = [
                  entry.read ? "read" : null,
                  entry.write ? "write" : null,
                  entry.execute ? "execute" : null,
                ].filter(Boolean);
                return `${entry.path}: ${permissions.length > 0 ? permissions.join(", ") : "no access"}`;
              })}
            />
          ) : null}
          {Object.keys(parameterSchema).length > 0 ? (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase text-muted">
                Run inputs
              </h3>
              <div className="space-y-3 rounded-lg border border-line bg-slate-50 p-3">
                {Object.entries(parameterSchema).map(([name, spec]) => (
                  <RunParameterField
                    key={name}
                    name={name}
                    spec={spec}
                    value={parameters[name]}
                    error={parameterErrors[name]}
                    onChange={(value) =>
                      setParameters((current) => ({ ...current, [name]: value }))
                    }
                  />
                ))}
              </div>
            </section>
          ) : null}
          {providers.length > 0 ? (
            <PreviewSection
              title="Provider CLI requirements"
              items={providers.map((provider) => {
                const profile = provider.profile ? ` profile=${provider.profile}` : "";
                const model = provider.model ? ` model=${provider.model}` : "";
                const timeout =
                  provider.timeout !== undefined && provider.timeout !== null
                    ? ` timeout=${provider.timeout}s`
                    : "";
                const extraPaths = provider.extraPaths?.length
                  ? ` extra_paths=${provider.extraPaths.join(", ")}`
                  : "";
                const binary = provider.binary ?? "unknown";
                const availability = provider.available ? "available" : "missing";
                return `${provider.agentId}: ${provider.subscription} binary=${binary} (${availability}) cwd=${provider.workingDir}${profile}${model}${timeout}${extraPaths}`;
              })}
            />
          ) : null}
          {bindings.length > 0 ? <BindingPreviewSection bindings={bindings} /> : null}

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase text-muted">
              Execution target
            </h3>
            <div className="inline-flex rounded-lg border border-line bg-slate-50 p-1">
              <button
                className={`rounded-md px-3 py-1.5 text-sm ${
                  executionMode === "local" ? "bg-white font-semibold shadow-sm" : "text-muted"
                }`}
                type="button"
                onClick={() => onExecutionModeChange("local")}
              >
                Local
              </button>
              <button
                className={`rounded-md px-3 py-1.5 text-sm ${
                  executionMode === "remote" ? "bg-white font-semibold shadow-sm" : "text-muted"
                }`}
                type="button"
                onClick={() => onExecutionModeChange("remote")}
              >
                Remote
              </button>
            </div>
            {executionMode === "remote" ? (
              <p className="mt-2 text-xs text-muted">
                {(queueState.runners ?? []).length
                  ? `${queueState.runners.length} runner${queueState.runners.length === 1 ? "" : "s"} registered`
                  : "No runners registered yet"}
              </p>
            ) : null}
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase text-muted">
              Execution order
            </h3>
            <div className="space-y-2">
              {generations.map((generation) => (
                <details
                  key={generation.index}
                  className="rounded-lg border border-line bg-slate-50 px-3 py-2"
                  open={generation.index === 0}
                >
                  <summary className="cursor-pointer text-sm font-semibold">
                    Generation {generation.index} · {(generation.nodes ?? []).length} node
                    {(generation.nodes ?? []).length === 1 ? "" : "s"}
                  </summary>
                  <div className="mt-2 space-y-2">
                    {(generation.nodes ?? []).map((node) => (
                      <div
                        key={node.id}
                        className="rounded-md border border-line bg-white px-3 py-2 text-sm"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-semibold">{node.id}</p>
                            <p className="break-words text-xs text-muted">{node.detail}</p>
                          </div>
                          <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-xs text-muted">
                            {node.type}
                          </span>
                        </div>
                        {(node.sideEffects ?? []).length > 0 ? (
                          <p className="mt-2 text-xs text-slate-600">
                            {(node.sideEffects ?? []).join("; ")}
                          </p>
                        ) : null}
                        {node.workingDir ? (
                          <p className="mt-2 break-words text-xs text-slate-600">
                            Working directory: {node.workingDir}
                          </p>
                        ) : null}
                        {node.fanOut ? (
                          <div className="mt-2 text-xs text-slate-600">
                            <p>
                              Fan-out {node.fanOut.sourceType}:{" "}
                              {formatFanOutCount(node.fanOut)} item
                              {node.fanOut.count === 1 && node.fanOut.countExact !== false
                                ? ""
                                : "s"}
                            </p>
                            {(node.fanOut.sampleItems ?? []).length > 0 ? (
                              <ul className="mt-1 space-y-0.5">
                                {(node.fanOut.sampleItems ?? []).map((sample, index) => (
                                  <li key={`${node.id}-sample-${index}`}>
                                    Sample: {formatPreviewValue(sample)}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        ) : null}
                        {(node.bindings ?? []).length > 0 ? (
                          <div className="mt-2 text-xs text-slate-600">
                            <p className="font-medium text-ink">Runtime bindings</p>
                            <ul className="mt-1 space-y-1">
                              {(node.bindings ?? []).map((binding) => (
                                <li key={binding.id} className="break-words">
                                  <span className="font-medium">{binding.destinationField}</span>
                                  {" ← "}
                                  <code>{binding.expression}</code>
                                  {` · ${binding.status} · ${binding.resolutionPhase}`}
                                  {binding.readiness ? ` · secret ${binding.readiness}` : ""}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </section>
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
          <button className="btn-ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn-primary inline-flex items-center justify-center gap-2 whitespace-nowrap"
            disabled={plan?.runnable === false}
            title={plan?.runnable === false ? "Resolve the blocking preflight errors first" : "Run workflow"}
            type="button"
            onClick={() => {
              const errors = validateWorkflowParameters(workflow, parameters);
              setParameterErrors(errors);
              if (Object.keys(errors).length === 0) {
                onRun(parameters);
              }
            }}
          >
            Run workflow
          </button>
        </div>
    </Dialog>
  );
}

function BindingPreviewSection({ bindings }) {
  const hasShellConsumer = bindings.some((binding) =>
    ["shell", "process-or-shell"].includes(binding.consumer),
  );
  return (
    <section>
      <div className="mb-2">
        <h3 className="text-xs font-semibold uppercase text-muted">Runtime bindings</h3>
        <p className="mt-1 text-xs text-slate-600">
          Deferred values resolve automatically at the phase shown below.
          {hasShellConsumer
            ? " Taskurotta resolves {{...}} first; the shell owns expressions such as ${FILE_NAME}."
            : ""}
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-slate-50">
        <ul className="divide-y divide-slate-200">
          {bindings.map((binding) => {
            const isError = ["invalid", "type-incompatible"].includes(binding.status);
            return (
              <li key={binding.id} className="px-3 py-2.5 text-xs">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="min-w-0 break-words text-sm font-medium text-ink">
                    {binding.destinationNode}.{binding.destinationField}
                  </p>
                  <span className={isError ? "font-semibold text-red-700" : "font-medium text-cyan-700"}>
                    {binding.status}
                  </span>
                </div>
                <p className="mt-1 break-words text-slate-600">
                  <code>{binding.expression}</code>
                  {` from ${binding.producer} · ${binding.sourceType} → ${binding.destinationType} · ${binding.resolutionPhase}`}
                  {binding.coercion === "string" ? " · string coercion" : ""}
                  {binding.readiness ? ` · secret ${binding.readiness}` : ""}
                </p>
                {binding.message ? <p className="mt-1 text-red-700">{binding.message}</p> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function RunParameterField({ error, name, onChange, spec, value }) {
  const id = `run-param-${name}`;
  const label = spec.label || name;
  const commonClass =
    "mt-1 w-full rounded-md border border-line bg-white px-3 py-2 text-sm outline-none focus:border-teal-500";
  const inputType =
    spec.type === "number"
      ? "number"
      : spec.type === "date"
        ? "date"
        : spec.type === "time"
          ? "time"
          : spec.type === "datetime"
            ? "datetime-local"
            : spec.type === "secret"
              ? "password"
              : "text";
  return (
    <label className="block text-sm" htmlFor={id}>
      <span className="font-medium">
        {label}
        {spec.required ? <span className="text-rose-600"> *</span> : null}
      </span>
      {spec.description ? (
        <span className="mt-0.5 block text-xs text-muted">{spec.description}</span>
      ) : null}
      {spec.type === "boolean" ? (
        <input
          id={id}
          className="mt-2 h-4 w-4 rounded border-line"
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
      ) : spec.type === "enum" ? (
        <select
          id={id}
          className={commonClass}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Select...</option>
          {(spec.choices ?? []).map((choice) => (
            <option key={String(choice)} value={choice}>
              {String(choice)}
            </option>
          ))}
        </select>
      ) : spec.type === "text" || spec.type === "multiline" ? (
        <textarea
          id={id}
          className={`${commonClass} min-h-24 resize-y`}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          className={commonClass}
          type={inputType}
          value={value ?? ""}
          min={spec.min}
          max={spec.max}
          pattern={spec.pattern}
          onChange={(event) => {
            const nextValue = spec.type === "number" ? event.target.value : event.target.value;
            onChange(nextValue);
          }}
        />
      )}
      {spec.type === "file" || spec.type === "folder" ? (
        <span className="mt-1 block text-xs text-muted">
          Enter a path accessible to the runner.
        </span>
      ) : null}
      {error ? <span className="mt-1 block text-xs text-rose-700">{error}</span> : null}
    </label>
  );
}

function PreviewSection({ title, items, tone = "default" }) {
  const toneClass =
    tone === "danger"
      ? "border-red-200 bg-red-50 text-red-800"
      : tone === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-line bg-slate-50 text-slate-700";

  return (
    <section className={`rounded-lg border px-3 py-2 ${toneClass}`}>
      <h3 className="text-xs font-semibold uppercase">{title}</h3>
      <ul className="mt-2 space-y-1 text-sm">
        {items.map((item) => (
          <li key={item}>- {item}</li>
        ))}
      </ul>
    </section>
  );
}

export function CreateWorkflowDialog({
  defaultProjectRoot = "",
  error,
  open,
  saving,
  templates,
  onClose,
  onCreate,
}) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState("blank");
  const [templateName, setTemplateName] = useState("");
  const [projectRoot, setProjectRoot] = useState("");
  const [projectError, setProjectError] = useState("");
  const [pickingProject, setPickingProject] = useState(false);

  const selectedTemplate = templates.find((item) => item.name === templateName) ?? null;

  useEffect(() => {
    if (open) {
      setName("");
      setMode("blank");
      setTemplateName("");
      setProjectRoot(defaultProjectRoot);
      setProjectError("");
      setPickingProject(false);
    }
  }, [defaultProjectRoot, open]);

  if (!open) return null;

  function handleSubmit(event) {
    event.preventDefault();
    const selectedProject = projectRoot.trim();
    if (!selectedProject) {
      setProjectError("Choose the project folder that will own this workflow.");
      return;
    }
    onCreate(name, {
      projectRoot: selectedProject,
      projectGrantId: window.goferDesktop?.workspace?.pathGrantForApi?.(selectedProject) ?? "",
      template: mode === "template" ? templateName : "",
    });
  }

  async function pickProjectFolder() {
    if (!window.goferDesktop?.workspace?.selectPath) {
      setProjectError("Native folder selection is available in the desktop app.");
      return;
    }
    setPickingProject(true);
    setProjectError("");
    try {
      const selected = await window.goferDesktop.workspace.selectPath({
        currentPath: projectRoot || defaultProjectRoot,
        directoryOnly: true,
      });
      if (selected) setProjectRoot(selected);
    } catch (selectionError) {
      setProjectError(
        selectionError instanceof Error
          ? selectionError.message
          : "Unable to open the project folder picker.",
      );
    } finally {
      setPickingProject(false);
    }
  }

  return (
    <Dialog
      description="Create a workflow inside a project folder"
      onClose={onClose}
      panelClassName="w-full max-w-[560px] rounded-lg border border-line bg-white shadow-panel"
      panelProps={{ "aria-busy": saving || undefined }}
      title="New workflow"
    >
      <form onSubmit={handleSubmit}>
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">New workflow</h2>
            <p className="text-xs text-muted">Stored under the project&apos;s .taskurotta folder</p>
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

        <div className="space-y-4 px-5 py-5">
          <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-1">
            <button
              className={`h-9 rounded-md text-sm font-medium transition ${
                mode === "blank" ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
              disabled={saving}
              type="button"
              onClick={() => setMode("blank")}
            >
              Blank
            </button>
            <button
              className={`h-9 rounded-md text-sm font-medium transition ${
                mode === "template" ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"
              } disabled:cursor-not-allowed disabled:opacity-50`}
              disabled
              title="Templates will return after they have been migrated to Radish"
              type="button"
              onClick={() => {
                setMode("template");
                setTemplateName((current) => current || templates[0]?.name || "");
              }}
            >
              Template
            </button>
          </div>
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
          <div>
            <span className="text-xs font-medium text-muted">Project folder</span>
            <div className="mt-1 flex gap-2">
              <input
                aria-describedby={projectError ? "project-folder-error" : "project-folder-hint"}
                className="h-10 min-w-0 flex-1 rounded-lg border border-line px-3 font-mono text-xs outline-none transition focus:border-indigo-500"
                disabled={saving || pickingProject}
                placeholder="Choose a repository or project folder"
                value={projectRoot}
                onChange={(event) => {
                  setProjectRoot(event.target.value);
                  setProjectError("");
                }}
              />
              <button
                className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={saving || pickingProject}
                type="button"
                onClick={pickProjectFolder}
              >
                {pickingProject ? <Loader2 size={15} className="animate-spin" /> : <FolderOpen size={15} />}
                Browse
              </button>
            </div>
            {projectError ? (
              <p className="mt-1 text-xs text-rose-700" id="project-folder-error" role="alert">
                {projectError}
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted" id="project-folder-hint">
                Taskurotta will create .taskurotta/&lt;workflow-id&gt; inside this folder.
              </p>
            )}
          </div>
          {mode === "template" ? (
            <>
              <label className="block">
                <span className="text-xs font-medium text-muted">Template</span>
                <select
                  className="mt-1 h-10 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none transition focus:border-teal-500"
                  disabled={saving}
                  value={templateName}
                  onChange={(event) => setTemplateName(event.target.value)}
                >
                  <option value="" disabled>
                    Select a template
                  </option>
                  {templates.map((template) => (
                    <option key={template.name} value={template.name}>
                      {template.title}
                    </option>
                  ))}
                </select>
              </label>
              {selectedTemplate ? (
                <div className="rounded-lg border border-line bg-slate-50 px-3 py-3 text-sm">
                  <div className="font-medium text-ink">{selectedTemplate.purpose}</div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <TemplatePreviewList
                      title="Inputs"
                      items={(selectedTemplate.required_inputs ?? []).map(
                        (item) => `${item.name} (${item.type ?? "string"})`,
                      )}
                    />
                    <TemplatePreviewList
                      title="Providers"
                      items={(selectedTemplate.provider_assumptions ?? []).map(
                        (item) => `${item.agentId}: ${item.subscription}`,
                      )}
                    />
                    <TemplatePreviewList
                      title="Nodes"
                      items={(selectedTemplate.generated_nodes ?? []).map(
                        (item) => `${item.id} (${item.type})`,
                      )}
                    />
                    <TemplatePreviewList
                      title="Assets"
                      items={(selectedTemplate.assets ?? []).map((item) => item.path)}
                    />
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  Template previews are unavailable.
                </div>
              )}
            </>
          ) : null}
          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 text-red-700" role="alert">
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
            disabled={saving || !projectRoot.trim() || (mode === "blank" && !name.trim()) || (mode === "template" && !templateName)}
            type="submit"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            Create
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ExportWorkflowDialog({
  error,
  open,
  outputPath,
  saving,
  workflow,
  onClose,
  onExport,
}) {
  const [draftPath, setDraftPath] = useState(outputPath || "");

  useEffect(() => {
    if (open) {
      setDraftPath(outputPath || "");
    }
  }, [open, outputPath]);

  if (!open) return null;

  function handleSubmit(event) {
    event.preventDefault();
    onExport(draftPath);
  }

  return (
    <Dialog
      description={workflow?.name ? `Create a portable bundle for ${workflow.name}` : "Create a portable workflow bundle"}
      onClose={onClose}
      panelClassName="w-full max-w-[600px] rounded-lg border border-line bg-white shadow-panel"
      panelProps={{ "aria-busy": saving || undefined }}
      title="Export workflow bundle"
    >
      <form onSubmit={handleSubmit}>
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Export workflow bundle</h2>
            <p className="text-xs text-muted">
              {workflow?.name ? `Create a portable bundle for ${workflow.name}` : "Create a portable workflow bundle"}
            </p>
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

        <div className="space-y-4 px-5 py-5">
          <label className="block">
            <span className="text-xs font-medium text-muted">Output path</span>
            <input
              autoFocus
              className="mt-1 h-10 w-full rounded-lg border border-line px-3 text-sm outline-none transition focus:border-teal-500"
              disabled={saving}
              placeholder="/path/to/workflow.gof.zip"
              value={draftPath}
              onChange={(event) => setDraftPath(event.target.value)}
            />
          </label>
          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 text-red-700" role="alert">
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
            disabled={saving || !draftPath.trim()}
            title="Confirm workflow export"
            type="submit"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
            Export
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function TemplatePreviewList({ title, items }) {
  const visibleItems = items?.length ? items.slice(0, 4) : ["None"];
  return (
    <div>
      <div className="text-xs font-semibold text-muted">{title}</div>
      <ul className="mt-1 space-y-1 text-xs leading-5 text-slate-700">
        {visibleItems.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
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
          {error || "Create or save a workflow TOML file in the Taskurotta data directory."}
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

function WorkflowHealthPanel({ doctorState, workflow }) {
  const globalErrors = doctorState?.errors ?? [];
  const globalWarnings = doctorState?.warnings ?? [];
  const workflowErrors = workflow?.healthErrors ?? [];
  const workflowWarnings = workflow?.healthWarnings ?? [];
  const validationErrors = workflow?.validationErrors ?? [];
  const validationWarnings = workflow?.validationWarnings ?? [];
  const errors = [...globalErrors, ...workflowErrors, ...validationErrors];
  const warnings = [...globalWarnings, ...workflowWarnings, ...validationWarnings];
  const diagnostics = [...errors, ...warnings].filter((diagnostic) =>
    diagnostic?.severity === "error" || diagnostic?.severity === "warning",
  );
  const diagnosticKey = diagnostics
    .map((diagnostic) =>
      [
        diagnostic.id,
        diagnostic.subject ?? "",
        diagnostic.severity,
        diagnostic.message,
      ].join(":"),
    )
    .join("|");
  const [dismissedDiagnosticKey, setDismissedDiagnosticKey] = useState("");
  const [dismissedDoctorError, setDismissedDoctorError] = useState("");
  if (doctorState?.loading && !diagnostics.length) {
    return (
      <section className="border-b border-line bg-white px-5 py-2">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={15} className="animate-spin" />
          <span>Checking environment health...</span>
        </div>
      </section>
    );
  }
  if (doctorState?.error && !diagnostics.length) {
    if (dismissedDoctorError === doctorState.error) {
      return null;
    }
    return (
      <section className="border-b border-amber-200 bg-amber-50 px-5 py-2">
        <div className="flex items-center gap-2 text-sm text-amber-800">
          <AlertCircle size={15} className="shrink-0" />
          <span className="min-w-0 flex-1">{doctorState.error}</span>
          <button
            type="button"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-amber-800 transition hover:bg-amber-100 hover:text-amber-950"
            title="Hide environment warning"
            aria-label="Hide environment warning"
            onClick={() => setDismissedDoctorError(doctorState.error)}
          >
            <X size={16} />
          </button>
        </div>
      </section>
    );
  }
  if (!diagnostics.length) {
    return null;
  }
  if (diagnostics.length && dismissedDiagnosticKey === diagnosticKey) {
    return null;
  }

  const errorCount = errors.length;
  return (
    <section
      className={`border-b px-5 py-3 ${
        errorCount ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"
      }`}
    >
      <div className="flex items-start gap-3">
        <AlertCircle
          className={`mt-0.5 shrink-0 ${errorCount ? "text-red-600" : "text-amber-700"}`}
          size={17}
        />
        <div className="min-w-0 flex-1">
          <h2 className={`text-sm font-semibold ${errorCount ? "text-red-800" : "text-amber-900"}`}>
            {errorCount ? "Environment setup needs attention" : "Environment setup warnings"}
          </h2>
          <ul className={`mt-1 space-y-1 text-sm leading-5 ${errorCount ? "text-red-700" : "text-amber-800"}`}>
            {diagnostics.slice(0, 3).map((diagnostic, index) => (
              <li key={`${diagnostic.id}-${diagnostic.subject ?? "workflow"}-${index}`}>
                {diagnostic.message}
              </li>
            ))}
          </ul>
          {diagnostics.length > 3 ? (
            <p className={`mt-1 text-xs ${errorCount ? "text-red-700" : "text-amber-800"}`}>
              {diagnostics.length - 3} more issue{diagnostics.length === 4 ? "" : "s"} shown in workflow settings.
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-md transition ${
            errorCount
              ? "text-red-700 hover:bg-red-100 hover:text-red-900"
              : "text-amber-800 hover:bg-amber-100 hover:text-amber-950"
          }`}
          title="Hide environment warning"
          aria-label="Hide environment warning"
          onClick={() => setDismissedDiagnosticKey(diagnosticKey)}
        >
          <X size={16} />
        </button>
      </div>
    </section>
  );
}

function agentExternalAccessWarnings(workflow) {
  return (workflow?.resourceWarnings ?? []).filter((warning) =>
    String(warning).includes("grants provider filesystem access outside working_dir"),
  );
}

function StatusDot({ status }) {
  const normalizedStatus = status || "Ready";
  const color = {
    Ready: "bg-emerald-500",
    Success: "bg-emerald-500",
    Error: "bg-red-500",
    Stopped: "bg-amber-500",
  }[normalizedStatus] ?? "bg-emerald-500";
  const running = normalizedStatus === "Running";

  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium ${
        running
          ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-sky-700/70 dark:bg-sky-950/70 dark:text-sky-200"
          : "border-line bg-white text-slate-600"
      }`}
    >
      {running ? (
        <Loader2 size={11} className="animate-spin text-blue-600 dark:text-sky-300" />
      ) : (
        <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
      )}
      {normalizedStatus}
    </span>
  );
}
