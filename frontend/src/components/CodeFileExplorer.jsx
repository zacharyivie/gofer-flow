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
  Loader2,
  PencilLine,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { PathNameDialog } from "./DagCanvas.jsx";

export default function CodeFileExplorer({
  query = "",
  workflow,
  onFilesystemChange,
  onOpenFile,
}) {
  const rootPath = workflow?.projectRoot ?? "";
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

  const refreshTree = useCallback(async () => {
    setDirectories({});
    setExpanded(new Set(rootPath ? [rootPath] : []));
    if (rootPath) await loadDirectory(rootPath);
  }, [loadDirectory, rootPath]);

  useEffect(() => {
    setSelectedPath(rootPath);
    setClipboardEntry(null);
    setContextMenu(null);
    setGrantRequired(false);
    void refreshTree();
  }, [refreshTree, rootPath]);

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
    () => visibleTreeRows(rootPath, directories, expanded, query),
    [directories, expanded, query, rootPath],
  );
  const selectedEntry = useMemo(
    () => entryForPath(rootPath, directories, selectedPath),
    [directories, rootPath, selectedPath],
  );
  const selectedDirectory = selectedEntry?.isDirectory
    ? selectedEntry.path
    : parentWorkspacePath(selectedEntry?.path || selectedPath || rootPath);

  async function toggleDirectory(entry) {
    setSelectedPath(entry.path);
    if (expanded.has(entry.path)) {
      setExpanded((current) => withoutSetValue(current, entry.path));
      return;
    }
    setExpanded((current) => withSetValue(current, entry.path));
    if (!directories[entry.path]) await loadDirectory(entry.path);
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

  const rootLoading = loadingPaths.has(rootPath);
  return (
    <div className="min-h-0" aria-label="Project file explorer">
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
        className="outline-none"
        role="tree"
        tabIndex={0}
        onContextMenu={(event) => showContextMenu(event)}
        onKeyDown={handleTreeKeyDown}
      >
        <button
          aria-expanded="true"
          aria-selected={selectedPath === rootPath}
          className={`flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-xs font-semibold ${selectedPath === rootPath ? "bg-indigo-100 text-indigo-700" : "text-ink hover:bg-slate-100"}`}
          role="treeitem"
          title={rootPath}
          type="button"
          onClick={() => setSelectedPath(rootPath)}
          onContextMenu={(event) => showContextMenu(event)}
        >
          <ChevronDown className="shrink-0 text-muted" size={12} />
          <FolderOpen className="shrink-0 text-muted" size={13} />
          <span className="truncate">{workflow?.projectName || workspaceBasename(rootPath) || "Project"}</span>
        </button>

        {rootLoading && !directories[rootPath] ? (
          <div className="flex h-14 items-center justify-center gap-2 text-xs text-muted"><Loader2 className="animate-spin" size={13} />Loading files</div>
        ) : null}
        {!rootLoading && directories[rootPath]?.length === 0 ? (
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
                title={entry.path}
                type="button"
                onClick={() => entry.isDirectory ? toggleDirectory(entry) : setSelectedPath(entry.path)}
                onDoubleClick={() => !entry.isDirectory && onOpenFile?.(entry.path)}
                onContextMenu={(event) => showContextMenu(event, entry)}
              >
                {entry.isDirectory ? (
                  isLoading ? <Loader2 className="shrink-0 animate-spin text-muted" size={12} /> : <ChevronDown className={`shrink-0 text-muted transition ${isExpanded ? "" : "-rotate-90"}`} size={12} />
                ) : <span className="w-3 shrink-0" />}
                <ExplorerIcon entry={entry} expanded={isExpanded} />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              </button>
            );
          })}
        </div>
      </div>

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

export function visibleTreeRows(rootPath, directories, expanded, query = "") {
  const rows = [];
  const normalizedQuery = query.trim().toLowerCase();
  function visit(directory, depth) {
    for (const entry of directories[directory] ?? []) {
      if (!normalizedQuery || entry.isDirectory || entry.name.toLowerCase().includes(normalizedQuery)) {
        rows.push({ depth, entry });
      }
      if (entry.isDirectory && expanded.has(entry.path)) visit(entry.path, depth + 1);
    }
  }
  if (rootPath) visit(rootPath, 0);
  return rows;
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
