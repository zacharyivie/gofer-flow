import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  FileCode2,
  FileJson2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  History,
  Loader2,
  PencilLine,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { PathNameDialog } from "./DagCanvas.jsx";
import { DEFAULT_APP_SETTINGS, matchesCommand } from "../lib/settings.js";

export default function CodeFileExplorer({
  activeFilePath = "",
  newFileRequest = 0,
  query = "",
  recentProjects = [],
  settings = DEFAULT_APP_SETTINGS,
  workflow,
  onFilesystemChange,
  onCloseActiveFile,
  onOpenFile,
  onRemoveRecentProject,
  onSelectProject,
}) {
  const rootPath = workflow?.projectRoot ?? "";
  const gitPanelsLoadingRef = useRef(null);
  const gitStatusLoadingRef = useRef(false);
  const lastNewFileRequestRef = useRef(newFileRequest);
  const recentMenuRef = useRef(null);
  const treeRef = useRef(null);
  const [directories, setDirectories] = useState({});
  const [expanded, setExpanded] = useState(() => new Set());
  const [loadingPaths, setLoadingPaths] = useState(() => new Set());
  const [selectedPath, setSelectedPath] = useState(rootPath);
  const [contextMenu, setContextMenu] = useState(null);
  const [clipboardEntry, setClipboardEntry] = useState(null);
  const [copiedPath, setCopiedPath] = useState("");
  const [nameRequest, setNameRequest] = useState(null);
  const [error, setError] = useState("");
  const [grantRequired, setGrantRequired] = useState(false);
  const [recentMenuOpen, setRecentMenuOpen] = useState(false);
  const [sourceControl, setSourceControl] = useState({ active: false, entries: [] });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [gitHistory, setGitHistory] = useState({ active: false, commits: [], loading: false });
  const [expandedCommits, setExpandedCommits] = useState(() => new Set());
  const [copiedCommitHash, setCopiedCommitHash] = useState("");
  const [worktrees, setWorktrees] = useState({ active: false, items: [], loading: false });
  const [worktreeFormOpen, setWorktreeFormOpen] = useState(false);
  const [worktreeBranch, setWorktreeBranch] = useState("");
  const [worktreeFolder, setWorktreeFolder] = useState("");
  const [worktreeCreateBranch, setWorktreeCreateBranch] = useState(false);

  const loadDirectory = useCallback(async (directory, { clearError = true } = {}) => {
    if (!directory) return [];
    if (clearError) setError("");
    setLoadingPaths((current) => withSetValue(current, directory));
    try {
      const payload = await window.goferDesktop?.workspace?.listDirectory?.({
        currentPath: directory,
        create: false,
      });
      if (!payload) throw new Error("The desktop filesystem bridge is unavailable.");
      const entries = payload.entries ?? [];
      setDirectories((current) => ({ ...current, [directory]: entries }));
      if (directory === rootPath) setGrantRequired(false);
      return entries;
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : String(loadError);
      setError(message);
      if (directory === rootPath && /approved|grant|outside/i.test(message)) {
        setGrantRequired(true);
      }
      return [];
    } finally {
      setLoadingPaths((current) => withoutSetValue(current, directory));
    }
  }, [rootPath]);

  const loadSourceControlStatus = useCallback(async () => {
    if (!rootPath || gitStatusLoadingRef.current?.rootPath === rootPath) return;
    const request = { rootPath };
    gitStatusLoadingRef.current = request;
    try {
      const payload = await window.goferDesktop?.workspace?.gitStatus?.(rootPath);
      if (gitStatusLoadingRef.current !== request) return;
      const next = payload?.active
        ? { active: true, entries: payload.entries ?? [] }
        : { active: false, entries: [] };
      setSourceControl((current) => sourceControlSnapshotsEqual(current, next) ? current : next);
    } catch {
      if (gitStatusLoadingRef.current !== request) return;
      setSourceControl({ active: false, entries: [] });
    } finally {
      if (gitStatusLoadingRef.current === request) gitStatusLoadingRef.current = null;
    }
  }, [rootPath]);

  const refreshTree = useCallback(async () => {
    setDirectories({});
    setExpanded(new Set(rootPath ? [rootPath] : []));
    setSourceControl({ active: false, entries: [] });
    if (!rootPath) return;
    try {
      await window.goferDesktop?.workspace?.trustProjectRoot?.(rootPath);
    } catch (trustError) {
      setError(trustError instanceof Error ? trustError.message : String(trustError));
      setGrantRequired(true);
      return;
    }
    await Promise.all([loadDirectory(rootPath), loadSourceControlStatus()]);
  }, [loadDirectory, loadSourceControlStatus, rootPath]);

  const loadGitPanels = useCallback(async () => {
    if (!rootPath || gitPanelsLoadingRef.current?.rootPath === rootPath) return;
    const request = { rootPath };
    gitPanelsLoadingRef.current = request;
    setGitHistory((current) => ({ ...current, loading: true }));
    setWorktrees((current) => ({ ...current, loading: true }));
    try {
      const [historyPayload, worktreePayload] = await Promise.all([
        window.goferDesktop?.workspace?.gitHistory?.(rootPath),
        window.goferDesktop?.workspace?.gitWorktrees?.(rootPath),
      ]);
      if (gitPanelsLoadingRef.current !== request) return;
      setGitHistory({ active: Boolean(historyPayload?.active), commits: historyPayload?.commits ?? [], loading: false });
      setWorktrees({ active: Boolean(worktreePayload?.active), items: worktreePayload?.worktrees ?? [], loading: false });
    } catch (loadError) {
      if (gitPanelsLoadingRef.current !== request) return;
      setGitHistory((current) => ({ ...current, loading: false }));
      setWorktrees((current) => ({ ...current, loading: false }));
      setError(loadError instanceof Error ? loadError.message : "Unable to load Git information");
    } finally {
      if (gitPanelsLoadingRef.current === request) gitPanelsLoadingRef.current = null;
    }
  }, [rootPath]);

  useEffect(() => {
    if (historyOpen) void loadGitPanels();
  }, [historyOpen, loadGitPanels]);

  useEffect(() => {
    setSelectedPath(rootPath);
    setExpandedCommits(new Set());
    setCopiedCommitHash("");
    setClipboardEntry(null);
    setContextMenu(null);
    setGrantRequired(false);
    void refreshTree();
  }, [refreshTree, rootPath]);

  useEffect(() => {
    if (!rootPath) return undefined;
    const refreshStatus = () => void loadSourceControlStatus();
    const interval = window.setInterval(refreshStatus, 2000);
    window.addEventListener("focus", refreshStatus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshStatus);
    };
  }, [loadSourceControlStatus, rootPath]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = () => setContextMenu(null);
    const closeOnEscape = (event) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  const rows = useMemo(
    () => visibleTreeRows(rootPath, directories, expanded, query, sourceControl.entries),
    [directories, expanded, query, rootPath, sourceControl.entries],
  );
  const selectedEntry = useMemo(
    () => entryForPath(rootPath, directories, selectedPath)
      ?? rows.find(({ entry }) => entry.path === selectedPath)?.entry
      ?? null,
    [directories, rootPath, rows, selectedPath],
  );
  const selectedDirectory = selectedEntry?.isDirectory
    ? selectedEntry.path
    : parentWorkspacePath(selectedEntry?.path || selectedPath || rootPath);

  useEffect(() => {
    if (newFileRequest === lastNewFileRequestRef.current) return;
    lastNewFileRequestRef.current = newFileRequest;
    const directory = selectedDirectory || rootPath;
    if (directory) setNameRequest({ directory, kind: "file", mode: "create" });
  }, [newFileRequest, rootPath, selectedDirectory]);

  useEffect(() => {
    if (!recentMenuOpen) return undefined;
    function dismissRecentProjects(event) {
      if (!recentMenuRef.current?.contains(event.target)) setRecentMenuOpen(false);
    }
    function dismissRecentProjectsWithEscape(event) {
      if (event.key === "Escape") setRecentMenuOpen(false);
    }
    window.addEventListener("pointerdown", dismissRecentProjects);
    window.addEventListener("keydown", dismissRecentProjectsWithEscape);
    return () => {
      window.removeEventListener("pointerdown", dismissRecentProjects);
      window.removeEventListener("keydown", dismissRecentProjectsWithEscape);
    };
  }, [recentMenuOpen]);

  async function toggleDirectory(entry) {
    setSelectedPath(entry.path);
    if (expanded.has(entry.path)) {
      setExpanded((current) => withoutSetValue(current, entry.path));
      return;
    }
    setExpanded((current) => withSetValue(current, entry.path));
    if (!directories[entry.path]) {
      if (entry.gitDeleted) {
        setDirectories((current) => ({ ...current, [entry.path]: [] }));
      } else {
        await loadDirectory(entry.path);
      }
    }
  }

  function showContextMenu(event, entry = null) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedPath(entry?.path ?? rootPath);
    setContextMenu({
      ...explorerMenuPosition(event.clientX, event.clientY),
      entry,
      directory: entry
        ? entry.isDirectory
          ? entry.path
          : parentWorkspacePath(entry.path)
        : rootPath,
    });
  }

  function requestCreate(kind, directory = selectedDirectory || rootPath) {
    setContextMenu(null);
    if (!directory) return;
    setNameRequest({ directory, kind, mode: "create" });
  }

  function requestRename(entry = selectedEntry) {
    setContextMenu(null);
    if (!entry || entry.path === rootPath) return;
    setNameRequest({
      directory: parentWorkspacePath(entry.path),
      entry,
      initialName: entry.name,
      kind: entry.isDirectory ? "folder" : "file",
      mode: "rename",
    });
  }

  async function createChild(kind, directory, name) {
    setError("");
    try {
      const result = kind === "file"
        ? await window.goferDesktop?.workspace?.createFile?.({ directory, name })
        : await window.goferDesktop?.workspace?.createFolder?.({ directory, name });
      setExpanded((current) => withSetValue(current, directory));
      await loadDirectory(directory, { clearError: false });
      if (result?.path) setSelectedPath(result.path);
      setNameRequest(null);
      onFilesystemChange?.({
        isDirectory: kind === "folder",
        kind: "create",
        path: result?.path ?? joinWorkspacePath(directory, name),
      });
      if (kind === "file" && result?.path) onOpenFile?.(result.path);
      void loadSourceControlStatus();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : `Unable to create ${kind}`);
    }
  }

  async function renameEntry(entry, name) {
    setError("");
    try {
      const result = await window.goferDesktop?.workspace?.renamePath?.({
        sourcePath: entry.path,
        name,
      });
      const parent = parentWorkspacePath(entry.path);
      discardDirectoryBranch(setDirectories, entry.path);
      await loadDirectory(parent, { clearError: false });
      const destinationPath = result?.path ?? joinWorkspacePath(parent, name);
      setSelectedPath(destinationPath);
      setNameRequest(null);
      onFilesystemChange?.({
        isDirectory: entry.isDirectory,
        kind: "rename",
        path: destinationPath,
        sourcePath: entry.path,
      });
      void loadSourceControlStatus();
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : "Unable to rename path");
    }
  }

  function copyEntry(entry = selectedEntry) {
    setContextMenu(null);
    if (!entry || entry.path === rootPath) return;
    setClipboardEntry(entry);
    treeRef.current?.focus();
  }

  async function pasteEntry(directory = selectedDirectory || rootPath) {
    setContextMenu(null);
    if (!clipboardEntry || !directory) return;
    setError("");
    try {
      const entries = directories[directory] ?? await loadDirectory(directory);
      const name = nextCopyName(clipboardEntry.name, new Set(entries.map((entry) => entry.name)));
      const destinationPath = joinWorkspacePath(directory, name);
      await window.goferDesktop?.workspace?.copyPath?.({
        sourcePath: clipboardEntry.path,
        destinationPath,
      });
      setExpanded((current) => withSetValue(current, directory));
      await loadDirectory(directory, { clearError: false });
      setSelectedPath(destinationPath);
      onFilesystemChange?.({
        isDirectory: clipboardEntry.isDirectory,
        kind: "copy",
        path: destinationPath,
        sourcePath: clipboardEntry.path,
      });
      void loadSourceControlStatus();
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "Unable to paste path");
    }
  }

  async function deleteEntry(entry = selectedEntry) {
    setContextMenu(null);
    if (!entry || entry.path === rootPath) return;
    const kind = entry.isDirectory ? "folder" : "file";
    if (!window.confirm(`Move ${entry.name} to the trash? This ${kind} can be restored from the operating system trash.`)) return;
    setError("");
    try {
      await window.goferDesktop?.workspace?.deletePath?.(entry.path);
      const parent = parentWorkspacePath(entry.path);
      discardDirectoryBranch(setDirectories, entry.path);
      await loadDirectory(parent, { clearError: false });
      setSelectedPath(parent);
      onFilesystemChange?.({
        isDirectory: entry.isDirectory,
        kind: "delete",
        path: entry.path,
      });
      void loadSourceControlStatus();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete path");
    }
  }

  async function copyPath(entry = selectedEntry) {
    setContextMenu(null);
    const path = entry?.path ?? rootPath;
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(path);
      window.setTimeout(() => setCopiedPath(""), 1400);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "Unable to copy path");
    }
  }

  async function copyCommitHash(commit) {
    try {
      await navigator.clipboard.writeText(commit.hash.slice(0, 8));
      setCopiedCommitHash(commit.hash);
      window.setTimeout(() => setCopiedCommitHash(""), 1400);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "Unable to copy commit ID");
    }
  }

  async function openInFileExplorer(entry = selectedEntry) {
    setContextMenu(null);
    const target = entry?.path ?? rootPath;
    if (!target) return;
    try {
      if (entry && !entry.isDirectory) {
        await window.goferDesktop?.workspace?.revealPath?.(target);
      } else {
        await window.goferDesktop?.workspace?.openPath?.(target);
      }
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Unable to open file explorer");
    }
  }

  async function authorizeProjectFolder() {
    try {
      const selected = await window.goferDesktop?.workspace?.selectPath?.({
        currentPath: rootPath,
        directoryOnly: true,
      });
      if (!selected) return;
      if (normalizeWorkspacePath(selected) !== normalizeWorkspacePath(rootPath)) {
        setError(`Choose the registered project folder: ${rootPath}`);
        return;
      }
      setGrantRequired(false);
      await refreshTree();
    } catch (grantError) {
      setError(grantError instanceof Error ? grantError.message : "Unable to authorize project folder");
    }
  }

  async function chooseWorktreeFolder() {
    const selected = await window.goferDesktop?.workspace?.selectPath?.({
      currentPath: parentWorkspacePath(rootPath),
      directoryOnly: true,
    });
    if (selected) setWorktreeFolder(selected);
  }

  async function createWorktree(event) {
    event.preventDefault();
    setError("");
    try {
      const payload = await window.goferDesktop?.workspace?.addWorktree?.({
        branch: worktreeBranch,
        createBranch: worktreeCreateBranch,
        projectRoot: rootPath,
        targetPath: worktreeFolder,
      });
      setWorktrees({ active: true, items: payload?.worktrees ?? [], loading: false });
      setWorktreeFormOpen(false);
      setWorktreeBranch("");
      setWorktreeFolder("");
      onSelectProject?.(payload?.createdPath || worktreeFolder, {
        mainProjectRoot: mainWorktreePath(payload?.worktrees, rootPath),
      });
    } catch (worktreeError) {
      setError(worktreeError instanceof Error ? worktreeError.message : "Unable to add worktree");
    }
  }

  async function removeWorktree(worktree) {
    if (!window.confirm(`Remove the worktree at ${worktree.path}? Git will refuse if it has uncommitted changes.`)) return;
    setError("");
    try {
      const payload = await window.goferDesktop?.workspace?.removeWorktree?.({ projectRoot: rootPath, targetPath: worktree.path });
      setWorktrees({ active: true, items: payload?.worktrees ?? [], loading: false });
    } catch (worktreeError) {
      setError(worktreeError instanceof Error ? worktreeError.message : "Unable to remove worktree");
    }
  }

  function handleTreeKeyDown(event) {
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "c") {
      event.preventDefault();
      copyEntry();
    } else if (modifier && event.key.toLowerCase() === "v") {
      event.preventDefault();
      void pasteEntry();
    } else if (event.key === "F2") {
      event.preventDefault();
      requestRename();
    } else if (event.key === "Delete") {
      event.preventDefault();
      void deleteEntry();
    } else if (event.key === "Enter" && selectedEntry?.isDirectory) {
      event.preventDefault();
      void toggleDirectory(selectedEntry);
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const bounds = treeRef.current?.getBoundingClientRect?.() ?? { left: 8, top: 8 };
      setContextMenu({
        ...explorerMenuPosition(bounds.left + 36, bounds.top + 36),
        entry: selectedEntry?.path === rootPath ? null : selectedEntry,
        directory: selectedDirectory || rootPath,
      });
    }
  }

  function handleExplorerKeyDown(event) {
    const action = explorerShortcutAction(event, { activeFilePath, settings });
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === "new") {
      requestCreate("file");
      return;
    }
    onCloseActiveFile?.(activeFilePath);
  }

  const rootLoading = loadingPaths.has(rootPath);
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      aria-label="Project file explorer"
      onKeyDownCapture={handleExplorerKeyDown}
    >
      <div className="flex h-7 items-center justify-between px-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Explorer</span>
        <div className="flex items-center">
          <button
            aria-label="New file"
            className="grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-slate-100 hover:text-ink"
            title="New file"
            type="button"
            onClick={() => requestCreate("file")}
          ><FilePlus2 size={13} /></button>
          <button
            aria-label="New folder"
            className="grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-slate-100 hover:text-ink"
            title="New folder"
            type="button"
            onClick={() => requestCreate("folder")}
          ><FolderPlus size={13} /></button>
          <button
            aria-label="Refresh files"
            className="grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-slate-100 hover:text-ink"
            title="Refresh files"
            type="button"
            onClick={refreshTree}
          ><RefreshCw className={rootLoading ? "animate-spin" : ""} size={13} /></button>
        </div>
      </div>

      {error ? (
        <div className="mx-1.5 mb-1.5 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] leading-4 text-red-700" role="alert">
          <div className="flex items-start gap-1.5">
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button aria-label="Dismiss file explorer error" className="shrink-0" type="button" onClick={() => setError("")}><X size={12} /></button>
          </div>
          {grantRequired ? (
            <button className="mt-1 font-semibold underline underline-offset-2" type="button" onClick={authorizeProjectFolder}>Grant project access</button>
          ) : null}
        </div>
      ) : null}

      <div
        ref={treeRef}
        aria-label="Project files"
        className="flex min-h-0 flex-1 flex-col outline-none"
        role="tree"
        tabIndex={0}
        onContextMenu={(event) => showContextMenu(event)}
        onKeyDown={handleTreeKeyDown}
      >
        <div ref={recentMenuRef} className="relative z-10 shrink-0 bg-white">
          <button
            aria-expanded={recentMenuOpen}
            aria-haspopup="menu"
            aria-selected={selectedPath === rootPath}
            className={`flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-xs font-semibold ${selectedPath === rootPath ? "bg-indigo-100 text-indigo-700" : "text-ink hover:bg-slate-100"}`}
            role="treeitem"
            title={`${rootPath}\nChoose a recent project`}
            type="button"
            onClick={() => {
              setSelectedPath(rootPath);
              setRecentMenuOpen((current) => !current);
            }}
            onContextMenu={(event) => showContextMenu(event)}
          >
            <ChevronDown className={`shrink-0 text-muted transition ${recentMenuOpen ? "" : "-rotate-90"}`} size={12} />
            <FolderOpen className="shrink-0 text-muted" size={13} />
            <span className="min-w-0 flex-1 truncate">{workflow?.projectName || workspaceBasename(rootPath) || "Project"}</span>
            <SourceControlDecoration
              directory
              path={rootPath}
              projectRoot={rootPath}
              statuses={sourceControl.entries}
            />
          </button>
          {recentMenuOpen ? (
            <div
              aria-label="Recent projects"
              className="absolute left-0 top-8 z-50 w-full min-w-56 rounded-lg border border-line bg-white p-1 shadow-panel"
              role="menu"
            >
              <p className="px-2 py-1 text-[10px] font-semibold text-muted">Recent projects</p>
              {recentProjects.length ? recentProjects.map((project) => (
                <div
                  key={project.root}
                  className={`group flex h-8 items-center rounded-md hover:bg-slate-50 focus-within:bg-slate-50 ${project.root === rootPath ? "bg-indigo-50 font-semibold text-indigo-700" : "text-ink"}`}
                  role="none"
                >
                  <button
                    className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-indigo-600"
                    role="menuitem"
                    title={project.root}
                    type="button"
                    onClick={() => {
                      setRecentMenuOpen(false);
                      onSelectProject?.(project.root);
                    }}
                  >
                    <FolderOpen className="shrink-0 text-muted" size={13} />
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    {project.root === rootPath ? <Check className="shrink-0 group-hover:hidden group-focus-within:hidden" size={12} /> : null}
                  </button>
                  <button
                    aria-label={`Remove ${project.name} from recent projects`}
                    className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded text-muted opacity-0 transition hover:bg-slate-200 hover:text-ink focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600 group-hover:opacity-100 group-focus-within:opacity-100 dark:hover:bg-white/10"
                    role="menuitem"
                    title="Remove from recent projects"
                    type="button"
                    onClick={() => onRemoveRecentProject?.(project.root)}
                  >
                    <X aria-hidden="true" size={13} />
                  </button>
                </div>
              )) : (
                <p className="px-2 py-2 text-xs text-muted">No recent projects</p>
              )}
            </div>
          ) : null}
        </div>

        <div aria-label="Project contents" className="min-h-0 flex-1 overflow-y-auto" role="group">
          {rootLoading && !directories[rootPath] ? (
            <div className="flex h-14 items-center justify-center gap-2 text-xs text-muted"><Loader2 className="animate-spin" size={13} />Loading files</div>
          ) : null}
          {!rootLoading && directories[rootPath]
            && directoryEntriesWithGitChanges(rootPath, rootPath, directories[rootPath], sourceControl.entries).length === 0 ? (
            <p className="px-6 py-3 text-xs text-muted">This project folder is empty.</p>
          ) : null}
          <div className="ml-2 border-l border-line pl-1">
            {rows.map(({ depth, entry }) => {
              const isExpanded = entry.isDirectory && expanded.has(entry.path);
              const isLoading = loadingPaths.has(entry.path);
              const selected = selectedPath === entry.path;
              return (
                <button
                  key={entry.path}
                  aria-expanded={entry.isDirectory ? isExpanded : undefined}
                  aria-selected={selected}
                  className={`flex h-7 w-full items-center gap-1.5 rounded-md pr-1.5 text-left text-xs ${selected ? "bg-indigo-100 font-medium text-indigo-700" : "text-ink hover:bg-slate-100"}`}
                  role="treeitem"
                  style={{ paddingLeft: `${6 + depth * 12}px` }}
                  title={`${entry.path}${entry.gitDeleted ? "\nDeleted from working tree" : ""}`}
                  type="button"
                  onClick={() => {
                    if (entry.isDirectory) {
                      void toggleDirectory(entry);
                      return;
                    }
                    setSelectedPath(entry.path);
                    if (!entry.gitDeleted) onOpenFile?.(entry.path, { preview: true });
                  }}
                  onDoubleClick={() => !entry.isDirectory && !entry.gitDeleted && onOpenFile?.(entry.path)}
                  onContextMenu={(event) => {
                    if (entry.gitDeleted) {
                      event.preventDefault();
                      event.stopPropagation();
                      setSelectedPath(entry.path);
                      return;
                    }
                    showContextMenu(event, entry);
                  }}
                >
                  {entry.isDirectory ? (
                    isLoading ? <Loader2 className="shrink-0 animate-spin text-muted" size={12} /> : <ChevronDown className={`shrink-0 text-muted transition ${isExpanded ? "" : "-rotate-90"}`} size={12} />
                  ) : <span className="w-3 shrink-0" />}
                  <ExplorerIcon entry={entry} expanded={isExpanded} />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <SourceControlDecoration
                    directory={entry.isDirectory}
                    path={entry.path}
                    projectRoot={rootPath}
                    statuses={sourceControl.entries}
                  />
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <section className={`shrink-0 border-t border-line bg-white ${historyOpen ? "h-1/2 min-h-52" : "h-8"}`} aria-label="Git history and worktrees">
        <button
          aria-expanded={historyOpen}
          className="flex h-8 w-full items-center gap-2 px-2 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-muted hover:bg-slate-50"
          type="button"
          onClick={() => setHistoryOpen((current) => !current)}
        >
          <ChevronDown className={`transition ${historyOpen ? "" : "-rotate-90"}`} size={12} />
          <History size={12} />
          <span className="flex-1">Source control</span>
        </button>
        {historyOpen ? (
          <div className="h-[calc(100%-2rem)] overflow-y-auto px-1.5 pb-2">
            <div className="flex h-7 items-center justify-between">
              <span className="text-[10px] font-semibold text-ink">Worktrees</span>
              <button aria-label="Add worktree" className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-slate-100 hover:text-ink" type="button" onClick={() => setWorktreeFormOpen((current) => !current)}><FolderPlus size={12} /></button>
            </div>
            {worktreeFormOpen ? (
              <form className="mb-2 space-y-1.5 rounded-md bg-slate-50 p-2" onSubmit={createWorktree}>
                <input aria-label="Worktree branch" className="h-7 w-full rounded border border-line bg-white px-2 text-[11px] outline-none focus:border-indigo-500" placeholder="Branch name" required value={worktreeBranch} onChange={(event) => setWorktreeBranch(event.target.value)} />
                <button className="flex h-7 w-full items-center gap-1.5 rounded border border-line bg-white px-2 text-left text-[11px] text-muted hover:text-ink" type="button" onClick={chooseWorktreeFolder}><FolderOpen size={12} /><span className="min-w-0 flex-1 truncate">{worktreeFolder || "Choose an empty folder"}</span></button>
                <label className="flex items-center gap-1.5 text-[10px] text-muted"><input checked={worktreeCreateBranch} type="checkbox" onChange={(event) => setWorktreeCreateBranch(event.target.checked)} />Create a new branch</label>
                <button className="h-7 w-full rounded bg-brand text-[11px] font-semibold text-white disabled:opacity-40" disabled={!worktreeBranch.trim() || !worktreeFolder} type="submit">Add worktree</button>
              </form>
            ) : null}
            {worktrees.loading && !worktrees.items.length ? <p className="py-2 text-[11px] text-muted">Loading worktrees...</p> : null}
            {worktrees.items.filter((worktree) => !worktree.missing && !worktree.prunable).map((worktree) => {
              const activeWorktree = normalizeWorkspacePath(worktree.path) === normalizeWorkspacePath(rootPath);
              return (
                <div
                  key={worktree.path}
                  className="group relative flex min-h-8 items-center gap-1 rounded px-1.5 hover:bg-slate-50"
                >
                  {activeWorktree ? <span aria-hidden="true" className="absolute inset-y-1 left-0 w-px bg-brand" /> : null}
                  <GitBranch className="shrink-0 text-muted" size={12} />
                  <button
                    aria-current={activeWorktree ? "page" : undefined}
                    className="min-w-0 flex-1 py-1 text-left"
                    title={worktree.path}
                    type="button"
                    onClick={() => onSelectProject?.(worktree.path, {
                      mainProjectRoot: mainWorktreePath(worktrees.items, rootPath),
                    })}
                  >
                    <span className="block truncate text-[11px] font-medium text-ink">{worktree.branch || "Detached HEAD"}</span>
                    <span className="block truncate text-[9px] text-muted">
                      {workspaceBasename(worktree.path)}
                    </span>
                  </button>
                  {!activeWorktree ? <button aria-label={`Remove ${worktree.branch || "detached"} worktree`} className="grid h-6 w-6 place-items-center rounded text-muted opacity-0 hover:bg-red-50 hover:text-red-700 focus:opacity-100 group-hover:opacity-100" type="button" onClick={() => removeWorktree(worktree)}><Trash2 size={11} /></button> : null}
                </div>
              );
            })}
            <div className="mt-2 flex h-7 items-center gap-1.5 border-t border-line pt-1 text-[10px] font-semibold text-ink">
              <GitCommitHorizontal size={12} />
              <span className="flex-1">Commit history</span>
              <button
                aria-label="Refresh commit history"
                className="grid h-6 w-6 place-items-center rounded text-muted outline-none hover:bg-slate-100 hover:text-ink focus-visible:bg-slate-100 focus-visible:text-ink disabled:cursor-default disabled:opacity-70"
                disabled={gitHistory.loading || worktrees.loading}
                title="Refresh commit history"
                type="button"
                onClick={() => void loadGitPanels()}
              >
                <RefreshCw className={gitHistory.loading || worktrees.loading ? "animate-spin" : ""} size={12} />
              </button>
            </div>
            {gitHistory.loading && !gitHistory.commits.length ? <p className="py-2 text-[11px] text-muted">Loading history...</p> : null}
            {!gitHistory.loading && !gitHistory.active ? <p className="py-2 text-[11px] text-muted">This project is not a Git repository.</p> : null}
            {gitHistory.commits.map((commit) => {
              const isExpanded = expandedCommits.has(commit.hash);
              const isCopied = copiedCommitHash === commit.hash;
              return (
                <div key={commit.hash} className={`rounded-md transition-colors ${isExpanded ? "bg-slate-50" : "hover:bg-slate-50"}`}>
                  <div className="flex items-start rounded-md">
                    <button
                      aria-expanded={isExpanded}
                      className="flex min-w-0 flex-1 items-start gap-1.5 rounded-md px-1.5 py-1.5 text-left outline-none focus-visible:bg-slate-100"
                      type="button"
                      onClick={() => setExpandedCommits((current) => isExpanded
                        ? withoutSetValue(current, commit.hash)
                        : withSetValue(current, commit.hash))}
                    >
                      <ChevronDown className={`mt-0.5 shrink-0 text-muted transition-transform ${isExpanded ? "" : "-rotate-90"}`} size={10} />
                      <span className="min-w-0 flex-1">
                        <span className={`block text-[11px] font-medium leading-4 text-ink ${isExpanded ? "whitespace-pre-wrap break-words" : "truncate"}`}>{isExpanded ? (commit.message || commit.subject) : commit.subject}</span>
                        <span className="flex min-w-0 items-center gap-1.5 text-[9px] leading-3 text-muted">
                          <span className="truncate">{commit.author}</span>
                          <span aria-hidden="true">·</span>
                          <span className="shrink-0">{relativeCommitTime(commit.authoredAt)}</span>
                        </span>
                      </span>
                      <span className="mt-0.5 shrink-0 font-mono text-[9px] leading-3 text-muted">{commit.shortHash}</span>
                    </button>
                    <button
                      aria-label={isCopied ? `Copied commit ID ${commit.shortHash}` : `Copy commit ID ${commit.shortHash}`}
                      className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded text-muted outline-none hover:bg-slate-200 hover:text-ink focus-visible:bg-slate-200 focus-visible:text-ink dark:hover:bg-white/10 dark:focus-visible:bg-white/10"
                      title={isCopied ? "Commit ID copied" : "Copy commit ID"}
                      type="button"
                      onClick={() => void copyCommitHash(commit)}
                    >
                      {isCopied ? <Check size={11} /> : <Copy size={11} />}
                    </button>
                  </div>
                  {isExpanded ? (
                    <div className="ml-5 border-t border-line/80 px-2 pb-2 pt-1.5 text-[10px]">
                      <div className="flex items-center gap-2 font-mono text-[9px]" aria-label={`${commit.insertions ?? 0} insertions, ${commit.deletions ?? 0} deletions`}>
                        <span className="font-medium text-emerald-600">+{commit.insertions ?? 0}</span>
                        <span className="font-medium text-red-600">-{commit.deletions ?? 0}</span>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      {clipboardEntry ? (
        <div className="mx-1.5 mt-2 flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1.5 text-[10px] text-muted">
          <Copy size={11} />
          <span className="min-w-0 flex-1 truncate" title={clipboardEntry.path}>Copied {clipboardEntry.name}</span>
          <button aria-label="Clear copied file" type="button" onClick={() => setClipboardEntry(null)}><X size={11} /></button>
        </div>
      ) : null}

      {contextMenu ? (
        <ExplorerContextMenu
          canPaste={Boolean(clipboardEntry)}
          entry={contextMenu.entry}
          pathCopied={copiedPath === (contextMenu.entry?.path ?? rootPath)}
          x={contextMenu.x}
          y={contextMenu.y}
          onCopy={() => copyEntry(contextMenu.entry)}
          onCopyPath={() => copyPath(contextMenu.entry)}
          onCreateFile={() => requestCreate("file", contextMenu.directory)}
          onCreateFolder={() => requestCreate("folder", contextMenu.directory)}
          onDelete={() => deleteEntry(contextMenu.entry)}
          onOpen={() => openInFileExplorer(contextMenu.entry)}
          onPaste={() => pasteEntry(contextMenu.directory)}
          onRefresh={() => loadDirectory(contextMenu.directory || rootPath)}
          onRename={() => requestRename(contextMenu.entry)}
        />
      ) : null}

      {nameRequest ? (
        <PathNameDialog
          directory={nameRequest.directory}
          initialName={nameRequest.initialName}
          kind={nameRequest.kind}
          mode={nameRequest.mode}
          onClose={() => setNameRequest(null)}
          onSubmit={(name) => nameRequest.mode === "rename"
            ? renameEntry(nameRequest.entry, name)
            : createChild(nameRequest.kind, nameRequest.directory, name)}
        />
      ) : null}
    </div>
  );
}

export function commitMessageBody(commit = {}) {
  const message = String(commit.message ?? "").trim();
  const subject = String(commit.subject ?? "").trim();
  if (!message || message === subject) return "";
  const [firstLine, ...remainingLines] = message.split("\n");
  return firstLine.trim() === subject
    ? remainingLines.join("\n").trim()
    : message;
}

export function relativeCommitTime(authoredAt, now = Date.now()) {
  const elapsed = Math.max(0, now - new Date(authoredAt).getTime());
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(authoredAt).toLocaleDateString();
}

export function explorerShortcutAction(event, options = {}) {
  if (event.repeat) return null;
  if (matchesCommand(event, options.settings, "file.new")) return "new";
  if (matchesCommand(event, options.settings, "file.close") && options.activeFilePath) return "close";
  return null;
}

function ExplorerIcon({ entry, expanded }) {
  if (entry.isDirectory) {
    return expanded
      ? <FolderOpen className="shrink-0 text-muted" size={13} />
      : <Folder className="shrink-0 text-muted" size={13} />;
  }
  const lower = entry.name.toLowerCase();
  if (lower.endsWith(".rad")) return <FileCode2 className="shrink-0 text-brand" size={13} />;
  if (lower.endsWith(".json")) return <FileJson2 className="shrink-0 text-amber-600" size={13} />;
  return <FileText className="shrink-0 text-muted" size={13} />;
}

function SourceControlDecoration({ directory = false, path, projectRoot, statuses }) {
  const status = sourceControlStatusForPath(projectRoot, path, statuses, directory);
  if (!status) return null;
  if (directory) {
    return (
      <span
        aria-label={`${workspaceBasename(path) || "Project"} contains source control changes`}
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-600"
        title="Contains source control changes"
      />
    );
  }
  const presentation = {
    A: { className: "source-control-status--added", label: "Added" },
    D: { className: "source-control-status--deleted", label: "Deleted" },
    M: { className: "source-control-status--modified", label: "Modified" },
    U: { className: "source-control-status--untracked", label: "Untracked" },
  }[status];
  return (
    <span
      aria-label={`${workspaceBasename(path)}: ${presentation.label}`}
      className={`shrink-0 px-0.5 text-[11px] font-semibold ${presentation.className}`}
      title={presentation.label}
    >
      {status}
    </span>
  );
}

function ExplorerContextMenu({
  canPaste,
  entry,
  onCopy,
  onCopyPath,
  onCreateFile,
  onCreateFolder,
  onDelete,
  onOpen,
  onPaste,
  onRefresh,
  onRename,
  pathCopied,
  x,
  y,
}) {
  return (
    <div
      aria-label="File actions"
      className="fixed z-[90] w-56 rounded-lg border border-line bg-white p-1 text-xs shadow-panel"
      role="menu"
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <MenuButton icon={FolderOpen} label="Open in file explorer" onClick={onOpen} />
      <MenuButton icon={pathCopied ? Check : Copy} label={pathCopied ? "Path copied" : "Copy path"} onClick={onCopyPath} />
      {entry ? (
        <>
          <div className="my-1 border-t border-line" />
          <MenuButton icon={PencilLine} label="Rename" shortcut="F2" onClick={onRename} />
          <MenuButton icon={Copy} label="Copy" shortcut="Ctrl+C" onClick={onCopy} />
          <MenuButton danger icon={Trash2} label="Delete" shortcut="Delete" onClick={onDelete} />
        </>
      ) : null}
      <div className="my-1 border-t border-line" />
      <MenuButton disabled={!canPaste} icon={Copy} label="Paste" shortcut="Ctrl+V" onClick={onPaste} />
      <MenuButton icon={FilePlus2} label="New file" onClick={onCreateFile} />
      <MenuButton icon={FolderPlus} label="New folder" onClick={onCreateFolder} />
      <div className="my-1 border-t border-line" />
      <MenuButton icon={RefreshCw} label="Refresh" onClick={onRefresh} />
    </div>
  );
}

function MenuButton({ danger = false, disabled = false, icon: Icon, label, onClick, shortcut = "" }) {
  return (
    <button
      className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${danger ? "text-red-700 hover:bg-red-50" : "text-ink hover:bg-slate-50"}`}
      disabled={disabled}
      role="menuitem"
      type="button"
      onClick={onClick}
    >
      <Icon size={13} />
      <span className="flex-1">{label}</span>
      {shortcut ? <span className="text-[10px] text-muted">{shortcut}</span> : null}
    </button>
  );
}

export function visibleTreeRows(rootPath, directories, expanded, query = "", statuses = []) {
  const rows = [];
  const normalizedQuery = query.trim().toLowerCase();
  function visit(directory, depth) {
    const entries = directoryEntriesWithGitChanges(
      rootPath,
      directory,
      directories[directory] ?? [],
      statuses,
    );
    for (const entry of entries) {
      if (!normalizedQuery || entry.isDirectory || entry.name.toLowerCase().includes(normalizedQuery)) {
        rows.push({ depth, entry });
      }
      if (entry.isDirectory && expanded.has(entry.path)) visit(entry.path, depth + 1);
    }
  }
  if (rootPath) visit(rootPath, 0);
  return rows;
}

export function directoryEntriesWithGitChanges(rootPath, directory, entries = [], statuses = []) {
  const next = [...entries];
  const names = new Set(next.map((entry) => entry.name.toLowerCase()));
  const relativeDirectory = workspaceRelativePath(rootPath, directory);
  const prefix = relativeDirectory ? `${relativeDirectory}/` : "";
  for (const change of statuses) {
    if (!change.path.startsWith(prefix)) continue;
    const remainder = change.path.slice(prefix.length);
    if (!remainder || remainder.startsWith("../")) continue;
    const [name, ...rest] = remainder.split("/");
    if (!name || names.has(name.toLowerCase())) continue;
    const isDirectory = rest.length > 0;
    const childPath = `${prefix}${name}`;
    const relatedChanges = statuses.filter((candidate) => (
      candidate.path === childPath || candidate.path.startsWith(`${childPath}/`)
    ));
    next.push({
      gitDeleted: relatedChanges.length > 0
        && relatedChanges.every((candidate) => candidate.status === "D"),
      hidden: name.startsWith("."),
      isDirectory,
      isFile: !isDirectory,
      name,
      path: joinWorkspacePath(directory, name),
    });
    names.add(name.toLowerCase());
  }
  return next.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

export function sourceControlStatusForPath(rootPath, targetPath, statuses = [], directory = false) {
  const relativePath = workspaceRelativePath(rootPath, targetPath);
  if (directory) {
    const prefix = relativePath ? `${relativePath}/` : "";
    return statuses.some((change) => change.path === relativePath || change.path.startsWith(prefix))
      ? "changed"
      : "";
  }
  return statuses.find((change) => change.path === relativePath)?.status ?? "";
}

function sourceControlSnapshotsEqual(left, right) {
  if (left.active !== right.active || left.entries.length !== right.entries.length) return false;
  return left.entries.every((entry, index) => (
    entry.path === right.entries[index]?.path && entry.status === right.entries[index]?.status
  ));
}

export function nextCopyName(name = "copy", existingNames = new Set()) {
  const dotIndex = name.lastIndexOf(".");
  const base = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  const extension = dotIndex > 0 ? name.slice(dotIndex) : "";
  let index = 1;
  let candidate = `${base} copy${extension}`;
  while (existingNames.has(candidate)) {
    index += 1;
    candidate = `${base} copy ${index}${extension}`;
  }
  return candidate;
}

export function joinWorkspacePath(directory = "", name = "") {
  const separator = directory.includes("\\") && !directory.includes("/") ? "\\" : "/";
  return `${directory.replace(/[\\/]+$/, "")}${separator}${name.replace(/^[\\/]+/, "")}`;
}

export function parentWorkspacePath(value = "") {
  const normalized = value.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (index <= 0) return normalized.slice(0, Math.max(index, 1)) || normalized;
  return normalized.slice(0, index);
}

export function explorerMenuPosition(clientX, clientY, viewportWidth = window.innerWidth, viewportHeight = window.innerHeight) {
  const width = 224;
  const height = 292;
  const availableWidth = Number.isFinite(viewportWidth) ? viewportWidth : 1024;
  const availableHeight = Number.isFinite(viewportHeight) ? viewportHeight : 768;
  return {
    x: Math.max(8, Math.min(Number.isFinite(clientX) ? clientX : 8, availableWidth - width - 8)),
    y: Math.max(8, Math.min(Number.isFinite(clientY) ? clientY : 8, availableHeight - height - 8)),
  };
}

function entryForPath(rootPath, directories, targetPath) {
  if (!targetPath) return null;
  if (targetPath === rootPath) {
    return { isDirectory: true, isFile: false, name: workspaceBasename(rootPath), path: rootPath };
  }
  for (const entries of Object.values(directories)) {
    const match = entries.find((entry) => entry.path === targetPath);
    if (match) return match;
  }
  return null;
}

function workspaceBasename(value = "") {
  const normalized = value.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return normalized.slice(index + 1);
}

export function mainWorktreePath(worktrees = [], fallback = "") {
  return String(worktrees[0]?.path || fallback).trim();
}

function workspaceRelativePath(rootPath = "", targetPath = "") {
  const root = String(rootPath).replace(/\\/g, "/").replace(/\/+$/, "");
  const target = String(targetPath).replace(/\\/g, "/").replace(/\/+$/, "");
  if (target.toLowerCase() === root.toLowerCase()) return "";
  if (!target.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return target;
  return target.slice(root.length + 1);
}

function normalizeWorkspacePath(value = "") {
  return value.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

function withSetValue(current, value) {
  const next = new Set(current);
  next.add(value);
  return next;
}

function withoutSetValue(current, value) {
  const next = new Set(current);
  next.delete(value);
  return next;
}

function discardDirectoryBranch(setDirectories, branchPath) {
  setDirectories((current) => Object.fromEntries(
    Object.entries(current).filter(([directory]) =>
      directory !== branchPath && !normalizeWorkspacePath(directory).startsWith(`${normalizeWorkspacePath(branchPath)}/`)),
  ));
}
