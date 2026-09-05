import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  Eye,
  FileCode2,
  FileJson2,
  FileText,
  FolderOpen,
  Globe,
  GitCompareArrows,
  Loader2,
  PencilLine,
  Save,
  X,
} from "lucide-react";
import { diagnosticsToMarkers, diagnosticToMarker } from "../lib/radishRanges.js";
import {
  DEFAULT_APP_SETTINGS,
  matchesCommand,
  matchesKeybinding,
  settingBinding,
} from "../lib/settings.js";
import taskurottaIcon from "../assets/taskurotta-icon.svg";
import { Dialog } from "./Dialog.jsx";
import MarkdownContent from "./MarkdownContent.jsx";
import IntegratedBrowser, { HtmlModeToggle } from "./IntegratedBrowser.jsx";

const textEditorSessions = new Map();
const discardedSessionPaths = new Set();
export const FILE_AUTOSAVE_DELAY_MS = 1000;

export function codeCloseProtection(dirtyPaths, autosaveEnabled) {
  if (!dirtyPaths.length) return "close";
  return autosaveEnabled ? "confirm-discard" : "prompt-to-save";
}

export function applyCodeFilesystemChange(change) {
  if (!change?.path) return;
  if (change.kind === "create") {
    discardedSessionPaths.delete(change.path);
    textEditorSessions.delete(change.path);
    return;
  }
  if (change.kind === "delete") {
    for (const path of textEditorSessions.keys()) {
      if (!pathMatchesChange(path, change.path, change.isDirectory)) continue;
      discardedSessionPaths.add(path);
      textEditorSessions.delete(path);
    }
    discardedSessionPaths.add(change.path);
    return;
  }
  if (change.kind !== "rename" || !change.sourcePath) return;
  for (const [path, session] of [...textEditorSessions.entries()]) {
    const nextPath = replacePathPrefix(path, change.sourcePath, change.path, change.isDirectory);
    if (nextPath === path) continue;
    discardedSessionPaths.add(path);
    discardedSessionPaths.delete(nextPath);
    textEditorSessions.delete(path);
    textEditorSessions.set(nextPath, session);
  }
}

const CodeWorkspace = forwardRef(function CodeWorkspace({
  active,
  activePath,
  openPaths,
  navigationRequest,
  previewPath,
  recentPaths = [],
  radishDocument,
  radishDirty = false,
  settings = DEFAULT_APP_SETTINGS,
  theme,
  workflow,
  onActivePathChange,
  onClosePath,
  onClosePaths,
  onBrowserStateChange,
  onDocumentStateChange,
  onActiveDocumentStateChange,
  onNewFile,
  onOpenMarkdownPath,
  onOpenBrowser,
  onOpenFile,
  onOpenProject,
  onOpenPath,
  onOpenPathsChange,
  onPinPath,
  onRadishContentChange,
  onRadishDiscard,
  onRadishSaved,
  onSettingChange,
  saveBeforeClosePaths = [],
  browserTabs = {},
}, ref) {
  const textEditorRefs = useRef(new Map());
  const workspaceRef = useRef(null);
  const tabMenuRef = useRef(null);
  const tabMenuFirstActionRef = useRef(null);
  const draggedPathRef = useRef("");
  const documentPathOrderRef = useRef(openPaths);
  const [fileStates, setFileStates] = useState({});
  const [browserViewStates, setBrowserViewStates] = useState({});
  const [documentModes, setDocumentModes] = useState({});
  const [diffOnOpenPaths, setDiffOnOpenPaths] = useState(() => new Set());
  const [tabMenu, setTabMenu] = useState(null);
  const [unsavedClosePrompt, setUnsavedClosePrompt] = useState(null);
  const [draggedPath, setDraggedPath] = useState("");
  const [splitGroup, setSplitGroup] = useState(null);
  const [primaryActivePath, setPrimaryActivePath] = useState("");
  const [splitActivePath, setSplitActivePath] = useState("");
  const sourcePath = workflow?.sourcePath ?? "";
  const currentPath = activePath || openPaths[0] || "";
  const localOpenPaths = openPaths.filter((path) => !browserTabs[path]);
  const splitPaths = useMemo(
    () => (splitGroup ? splitGroup.paths.filter((path) => openPaths.includes(path)) : []),
    [openPaths, splitGroup],
  );
  const primaryGroupPaths = useMemo(
    () => openPaths.filter((path) => !splitPaths.includes(path)),
    [openPaths, splitPaths],
  );
  // Electron tears down a webview guest when its mounted ancestor moves in the DOM.
  // Keep document order stable while the tab strips follow the user's chosen order.
  const documentPaths = stableCodeDocumentPaths(documentPathOrderRef.current, openPaths);
  const primaryPath = primaryGroupPaths.includes(currentPath)
    ? currentPath
    : (primaryGroupPaths.includes(primaryActivePath) ? primaryActivePath : primaryGroupPaths[0] ?? "");
  const splitPath = splitPaths.includes(currentPath)
    ? currentPath
    : (splitPaths.includes(splitActivePath) ? splitActivePath : splitPaths[0] ?? "");

  useLayoutEffect(() => {
    documentPathOrderRef.current = documentPaths;
  }, [documentPaths]);

  function beginTabDrag(event, path) {
    draggedPathRef.current = path;
    setDraggedPath(path);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/x-taskurotta-tab", path);
    event.dataTransfer.setData("text/plain", path);
  }

  function endTabDrag() {
    draggedPathRef.current = "";
    setDraggedPath("");
  }

  function draggedTabFrom(event) {
    return event.dataTransfer.getData("text/x-taskurotta-tab")
      || event.dataTransfer.getData("text/plain")
      || draggedPathRef.current;
  }

  useEffect(() => {
    if (primaryGroupPaths.includes(currentPath)) setPrimaryActivePath(currentPath);
  }, [currentPath, primaryGroupPaths]);

  useEffect(() => {
    if (splitPaths.includes(currentPath)) setSplitActivePath(currentPath);
  }, [currentPath, splitPaths]);

  useEffect(() => {
    if (!splitGroup) return;
    const remaining = splitGroup.paths.filter((path) => openPaths.includes(path));
    const primaryRemaining = openPaths.filter((path) => !remaining.includes(path));
    if (!remaining.length || !primaryRemaining.length) {
      setSplitGroup(null);
      return;
    }
    if (remaining.length !== splitGroup.paths.length) {
      setSplitGroup((current) => (current ? { ...current, paths: remaining } : null));
    }
  }, [openPaths, splitGroup]);

  function moveTab(source, target, targetIsSplit) {
    if (!source) return;
    const sourceIsSplit = splitPaths.includes(source);
    if (source !== target) onOpenPathsChange?.(reorderCodeTabs(openPaths, source, target));
    if (sourceIsSplit === targetIsSplit) return;
    if (targetIsSplit) {
      setSplitGroup((current) => current
        ? { ...current, paths: current.paths.includes(source) ? current.paths : [...current.paths, source] }
        : { paths: [source], side: "right" });
    } else {
      setSplitGroup((current) => {
        if (!current) return current;
        const paths = current.paths.filter((path) => path !== source);
        return paths.length ? { ...current, paths } : null;
      });
    }
  }

  function addToSplitGroup(path, side) {
    if (!path) return;
    setSplitGroup((current) => {
      if (!current) return { paths: [path], side };
      const paths = current.paths.includes(path) ? current.paths : [...current.paths, path];
      return { paths, side };
    });
  }

  useEffect(() => {
    if (!currentPath || browserTabs[currentPath]) {
      onActiveDocumentStateChange?.(null);
      return;
    }
    onActiveDocumentStateChange?.({
      content: null,
      dirty: false,
      error: "",
      loading: true,
      saving: false,
      ...fileStates[currentPath],
      path: currentPath,
    });
  }, [browserTabs, currentPath, fileStates, onActiveDocumentStateChange]);

  const finishClosingWorkspacePaths = useCallback((targets, discardRadish = false) => {
    for (const path of targets) textEditorRefs.current.get(path)?.discard?.();
    setBrowserViewStates((current) => Object.fromEntries(
      Object.entries(current).filter(([path]) => !targets.includes(path)),
    ));
    setDocumentModes((current) => Object.fromEntries(
      Object.entries(current).filter(([path]) => !targets.includes(path)),
    ));
    if (onClosePaths) onClosePaths(targets);
    else for (const path of targets) onClosePath?.(path);
    if (discardRadish) onRadishDiscard?.();
    setTabMenu(null);
  }, [onClosePath, onClosePaths, onRadishDiscard]);

  const closeWorkspacePaths = useCallback(async (paths) => {
    const targets = [...new Set(paths)].filter((path) => openPaths.includes(path));
    if (!targets.length) return;
    const dirtyPaths = targets.filter((path) => (
      path === sourcePath ? radishDirty : Boolean(fileStates[path]?.dirty)
    ));
    const requiredSavePaths = dirtyPaths.filter((path) => saveBeforeClosePaths.includes(path));
    if (requiredSavePaths.length) {
      const results = await Promise.all(requiredSavePaths.map(
        (path) => textEditorRefs.current.get(path)?.save?.() ?? false,
      ));
      if (results.some((result) => !result)) return;
    }
    const remainingDirtyPaths = dirtyPaths.filter((path) => !requiredSavePaths.includes(path));
    const protection = codeCloseProtection(remainingDirtyPaths, settings.general.autosave);
    if (protection === "prompt-to-save") {
      setTabMenu(null);
      setUnsavedClosePrompt({ dirtyPaths: remainingDirtyPaths, error: "", saving: false, targets });
      return;
    }
    if (protection === "confirm-discard") {
      const message = targets.length === 1
        ? `Close ${fileName(targets[0])} without saving your changes?`
        : `Close ${targets.length} files? Unsaved changes in ${remainingDirtyPaths.length} file${remainingDirtyPaths.length === 1 ? "" : "s"} will be discarded.`;
      if (!window.confirm(message)) return;
    }
    finishClosingWorkspacePaths(targets, remainingDirtyPaths.includes(sourcePath));
  }, [fileStates, finishClosingWorkspacePaths, openPaths, radishDirty, saveBeforeClosePaths, settings.general.autosave, sourcePath]);

  const saveAndClosePromptedPaths = useCallback(async () => {
    if (!unsavedClosePrompt || unsavedClosePrompt.saving) return;
    const { dirtyPaths, targets } = unsavedClosePrompt;
    setUnsavedClosePrompt((current) => current ? { ...current, error: "", saving: true } : null);
    const results = await Promise.all(dirtyPaths.map(
      (path) => textEditorRefs.current.get(path)?.save?.() ?? null,
    ));
    if (results.some((result) => !result)) {
      setUnsavedClosePrompt((current) => current ? {
        ...current,
        error: "Taskurotta couldn't save every file. Fix the error in the editor, then try again.",
        saving: false,
      } : null);
      return;
    }
    setUnsavedClosePrompt(null);
    finishClosingWorkspacePaths(targets);
  }, [finishClosingWorkspacePaths, unsavedClosePrompt]);

  const closeWorkspacePath = useCallback((path) => {
    void closeWorkspacePaths([path]);
  }, [closeWorkspacePaths]);

  useEffect(() => {
    if (!tabMenu) return undefined;
    tabMenuFirstActionRef.current?.focus();
    function dismissMenu(event) {
      if (tabMenuRef.current?.contains(event.target)) return;
      setTabMenu(null);
    }
    function dismissWithEscape(event) {
      if (event.key === "Escape") setTabMenu(null);
    }
    window.addEventListener("pointerdown", dismissMenu);
    window.addEventListener("keydown", dismissWithEscape);
    return () => {
      window.removeEventListener("pointerdown", dismissMenu);
      window.removeEventListener("keydown", dismissWithEscape);
    };
  }, [tabMenu]);

  useEffect(() => {
    if (!navigationRequest?.path || !navigationRequest.lineNumber) return;
    setDocumentModes((current) => current[navigationRequest.path] === "edit"
      ? current
      : { ...current, [navigationRequest.path]: "edit" });
  }, [navigationRequest]);

  useImperativeHandle(
    ref,
    () => ({
      acceptDocument: (document) =>
        textEditorRefs.current.get(sourcePath)?.acceptContent?.(document?.source ?? ""),
      closeActive: () => {
        closeWorkspacePath(currentPath);
      },
      revealDiagnostic: (diagnostic) =>
        textEditorRefs.current.get(sourcePath)?.revealDiagnostic?.(diagnostic),
      runCommand: (command) => textEditorRefs.current.get(currentPath)?.runCommand?.(command),
      save: () => textEditorRefs.current.get(sourcePath)?.save?.(),
      saveActive: () => textEditorRefs.current.get(currentPath)?.save?.(),
    }),
    [closeWorkspacePath, currentPath, sourcePath],
  );

  useEffect(() => {
    if (!active) return undefined;
    window.addEventListener("keydown", handleWorkspaceKeyDown, true);
    return () => window.removeEventListener("keydown", handleWorkspaceKeyDown, true);
  });

  function handleWorkspaceKeyDown(event) {
    if (event.defaultPrevented) return;
    const target = event.target;
    const targetIsDocument = !target
      || target === window
      || target === document
      || target === document.body
      || target === document.documentElement;
    if (!targetIsDocument && !workspaceRef.current?.contains(target)) return;
    if (target?.closest?.("[role='dialog'], [role='menu']")) return;
    const action = codeWorkspaceShortcutAction(event, {
      active,
      browserActive: Boolean(browserTabs[currentPath]),
      currentPath,
      settings,
    });
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === "new") {
      onNewFile?.();
      return;
    }
    if (action === "save") {
      void textEditorRefs.current.get(currentPath)?.save?.();
      return;
    }
    if (action === "toggle-word-wrap") {
      onSettingChange?.("editor.wordWrap", !settings.editor.wordWrap);
      return;
    }
    if (action === "next-tab" || action === "previous-tab") {
      const groupPaths = splitPaths.includes(currentPath) ? splitPaths : primaryGroupPaths;
      const nextPath = adjacentCodeTab(
        groupPaths,
        currentPath,
        action === "previous-tab" ? -1 : 1,
      );
      if (nextPath) onActivePathChange?.(nextPath);
      return;
    }
    if (action === "new-browser-tab") {
      onOpenBrowser?.({ newTab: true });
      return;
    }
    closeWorkspacePath(currentPath);
  }

  function openTabMenu(event, path, groupPaths) {
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const requestedLeft = event.clientX || bounds.left + 12;
    const requestedTop = event.clientY || bounds.bottom - 2;
    onActivePathChange?.(path);
    setTabMenu({
      groupPaths,
      left: Math.max(8, Math.min(requestedLeft, window.innerWidth - 184)),
      path,
      top: Math.max(8, Math.min(requestedTop, window.innerHeight - 188)),
    });
  }

  function renderTabStrip(paths, activeForGroup, isSplit, column) {
    return (
      <div
        aria-label={isSplit ? "Split editor tabs" : "Editor tabs"}
        className={`tab-strip-scrollbar flex h-9 min-w-0 items-center overflow-x-auto overflow-y-hidden border-b border-line bg-slate-50 ${column === 2 ? "border-l" : ""}`}
        role="tablist"
        style={{ gridColumn: column, gridRow: 1 }}
        onDragOver={(event) => {
          if (!draggedPathRef.current) return;
          event.preventDefault();
        }}
        onDrop={(event) => {
          if (!draggedPathRef.current) return;
          event.preventDefault();
          const source = draggedTabFrom(event);
          const target = paths[paths.length - 1] ?? source;
          if (source) moveTab(source, target, isSplit);
          endTabDrag();
        }}
      >
        {paths.map((path) => {
          const browserTab = browserTabs[path];
          const browserViewState = browserViewStates[path];
          const tabMetadata = browserViewTabMetadata(browserTab, browserViewState);
          const selected = path === activeForGroup;
          const isRadish = !browserTab && path === sourcePath;
          const dirty = isRadish ? radishDirty : fileStates[path]?.dirty;
          const preview = !browserTab && path === previewPath;
          const folderLabel = browserTab ? "" : duplicateTabFolder(path, localOpenPaths);
          const label = codeTabLabel(path, tabMetadata);
          const title = tabMetadata
            ? [label, tabMetadata.url].filter(Boolean).join("\n")
            : path;
          return (
            <div
              key={path}
              className={`group relative flex h-full w-48 shrink-0 items-center border-r border-line text-xs ${selected ? "bg-white font-semibold text-ink" : "text-muted hover:bg-white/70 hover:text-ink"}`}
              title={title}
              onContextMenu={(event) => openTabMenu(event, path, paths)}
              onDragOver={(event) => {
                if (!draggedPathRef.current || draggedPathRef.current === path) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const source = draggedTabFrom(event);
                if (source) moveTab(source, path, isSplit);
                endTabDrag();
              }}
            >
              <button
                aria-selected={selected}
                className="flex h-full min-w-0 flex-1 items-center gap-2 py-0 pl-3 pr-2 text-left"
                draggable
                role="tab"
                type="button"
                onClick={() => onActivePathChange?.(path)}
                onDoubleClick={() => onPinPath?.(path)}
                onDragEnd={endTabDrag}
                onDragStart={(event) => beginTabDrag(event, path)}
              >
                <FileTypeIcon browserTab={tabMetadata} path={path} />
                <span className={`flex min-w-0 flex-col justify-center ${preview ? "italic" : ""}`}>
                  {folderLabel ? (
                    <span className="max-w-full truncate text-[9px] font-normal leading-[11px] text-muted">
                      {folderLabel}
                    </span>
                  ) : null}
                  <span className="max-w-full truncate leading-[14px]">{label}</span>
                </span>
                {dirty ? <span aria-label="Unsaved changes" className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" /> : null}
              </button>
              <button
                aria-label={`Close ${label}`}
                className="mr-1 grid h-5 w-5 shrink-0 place-items-center rounded text-muted opacity-0 hover:bg-slate-100 hover:text-ink focus:opacity-100 group-hover:opacity-100"
                draggable={false}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  closeWorkspacePath(path);
                }}
              ><X size={12} /></button>
              {selected ? <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-brand" /> : null}
            </div>
          );
        })}
      </div>
    );
  }

  function renderDocuments(paths) {
    return paths.map((path) => {
      const inSplitGroup = splitPaths.includes(path);
      const groupPaths = inSplitGroup ? splitPaths : primaryGroupPaths;
      const activeForGroup = inSplitGroup ? splitPath : primaryPath;
      const column = splitGroup?.side === "left"
        ? (inSplitGroup ? 1 : 2)
        : (inSplitGroup ? 2 : 1);
      const browserTab = browserTabs[path];
      const html = !browserTab && isHtmlPath(path);
      const image = !browserTab && isImagePath(path);
      const pdf = !browserTab && isPdfPath(path);
      const svg = !browserTab && isSvgPath(path);
      const mode = codeDocumentMode(path, documentModes, settings.editor);
      const selected = activeForGroup === path;
      return (
        <div
          key={path}
          aria-hidden={!selected}
          className={`flex min-h-0 min-w-0 flex-col ${selected ? "visible z-10" : "invisible z-0 pointer-events-none"} ${splitGroup && column === 2 ? "border-l border-line" : ""}`}
          style={{ gridColumn: column, gridRow: 2 }}
        >
          {browserTab || pdf || (html && mode === "preview") ? (
            <PreviewBrowser
              active={active && currentPath === path}
              applicationKeybindings={settings.keybindings}
              clientId={browserTab ? path : `html:${path}`}
              dragActive={Boolean(draggedPath)}
              focusLocationOnCreate={browserTab?.focusLocation === true}
              initialUrl={browserTab?.url || "about:blank"}
              localPath={browserTab ? "" : path}
              openBrowserBinding={settingBinding(settings, "browser.open")}
              searchUrl={settings.browser.searchUrl}
              diffPath={html ? path : ""}
              showModeToggle={html}
              onClose={() => closeWorkspacePath(path)}
              onCycleTab={(direction) => {
                const nextPath = adjacentCodeTab(groupPaths, path, direction);
                if (nextPath) onActivePathChange?.(nextPath);
              }}
              onNewTab={() => onOpenBrowser?.({ newTab: true })}
              onModeChange={(nextMode) => {
                setDocumentModes((current) => ({ ...current, [path]: nextMode }));
                if (nextMode === "preview") {
                  setDiffOnOpenPaths((current) => withoutSetValue(current, path));
                }
                if (nextMode === "edit") {
                  setBrowserViewStates((current) => {
                    const next = { ...current };
                    delete next[path];
                    return next;
                  });
                  onPinPath?.(path);
                }
              }}
              onShowDiff={() => {
                setDiffOnOpenPaths((current) => withSetValue(current, path));
                setDocumentModes((current) => ({ ...current, [path]: "edit" }));
                onPinPath?.(path);
              }}
              onStateChange={(nextState) => {
                setBrowserViewStates((current) => ({
                  ...current,
                  [path]: { ...current[path], ...nextState },
                }));
                if (browserTab) onBrowserStateChange?.(path, nextState);
              }}
            />
          ) : image ? (
            <ImagePreview path={path} />
          ) : (
          <TextCodeEditor
            active={active && currentPath === path}
            diagnostics={path === sourcePath
              ? [
                  ...(radishDocument?.diagnostics ?? []),
                  ...(radishDocument?.preflight?.diagnostics ?? []),
                ]
              : []}
            editing={mode === "edit"}
            html={html}
            initialDiffMode={diffOnOpenPaths.has(path)}
            markdown={isMarkdownPath(path)}
            svg={svg}
            navigationRequest={navigationRequest?.path === path ? navigationRequest : null}
            path={path}
            autosaveEnabled={settings.general.autosave}
            editorSettings={settings.editor}
            ref={(editor) => {
              if (editor) textEditorRefs.current.set(path, editor);
              else textEditorRefs.current.delete(path);
            }}
            theme={theme}
            onModeChange={(mode) => {
              setDocumentModes((current) => ({ ...current, [path]: mode }));
              if (mode === "preview") {
                setDiffOnOpenPaths((current) => withoutSetValue(current, path));
              }
              if (mode === "edit") onPinPath?.(path);
            }}
            onOpenRelativeLink={(href) => {
              if (onOpenMarkdownPath) {
                onOpenMarkdownPath(href, path);
                return;
              }
              const targetPath = resolveMarkdownLinkPath(path, href);
              if (targetPath) onOpenPath?.(targetPath, { preview: true });
            }}
            onStateChange={(nextState) => {
              setFileStates((current) => ({ ...current, [path]: nextState }));
              if (nextState.dirty) onPinPath?.(path);
              if (path === sourcePath) {
                const currentDocument = radishDocument;
                onDocumentStateChange?.({
                  document: nextState.content == null
                    ? currentDocument
                    : {
                        ...(currentDocument ?? {}),
                        diagnostics: currentDocument?.diagnostics ?? [],
                        dirty: nextState.dirty,
                        preflight: currentDocument?.preflight ?? { diagnostics: [] },
                        source: nextState.content,
                      },
                  error: nextState.error,
                  loading: nextState.loading,
                  saving: nextState.saving,
                });
              }
            }}
            onSaved={path === sourcePath ? onRadishSaved : undefined}
            onContentChange={path === sourcePath ? onRadishContentChange : undefined}
          />
          )}
        </div>
      );
    });
  }

  return (
    <section
      ref={workspaceRef}
      className="flex min-h-0 flex-1 flex-col bg-white"
      aria-label="Code workspace"
    >
      <div
        className="relative grid min-h-0 flex-1"
        style={{
          gridTemplateColumns: splitGroup && splitPaths.length
            ? "minmax(0, 1fr) minmax(0, 1fr)"
            : "minmax(0, 1fr)",
          gridTemplateRows: currentPath ? "2.25rem minmax(0, 1fr)" : "minmax(0, 1fr)",
        }}
      >
        {draggedPath && openPaths.length > 1 ? (
          <>
            <SplitDropZone side="left" onDrop={() => { addToSplitGroup(draggedPathRef.current, "left"); endTabDrag(); }} />
            <SplitDropZone side="right" onDrop={() => { addToSplitGroup(draggedPathRef.current, "right"); endTabDrag(); }} />
          </>
        ) : null}
        {primaryGroupPaths.length ? renderTabStrip(
          primaryGroupPaths,
          primaryPath,
          false,
          splitGroup?.side === "left" ? 2 : 1,
        ) : null}
        {splitGroup && splitPaths.length ? renderTabStrip(
          splitPaths,
          splitPath,
          true,
          splitGroup.side === "left" ? 1 : 2,
        ) : null}
        {renderDocuments(documentPaths)}
        {!currentPath ? (
          <div className="min-h-0 overflow-y-auto px-8 pb-10 pt-12" style={{ gridColumn: 1, gridRow: 1 }}>
            <div className="mx-auto w-full max-w-2xl">
              <div className="mx-auto max-w-sm">
                <p className="text-center text-sm font-semibold text-ink">Getting Started</p>
                <p className="mt-1 text-center text-xs leading-5 text-muted">
                  Open a project, a single file, or a browser tab.
                </p>
                <div className="mt-4 space-y-2">
                  <EmptyWorkspaceAction icon={FolderOpen} label="Open Project" shortcut="Ctrl+K, Ctrl+O" onClick={onOpenProject} />
                  <EmptyWorkspaceAction icon={FileText} label="Open File" shortcut="Ctrl+O" onClick={onOpenFile} />
                  <EmptyWorkspaceAction icon={Globe} label="Open Browser" shortcut="Ctrl+J" onClick={() => onOpenBrowser?.()} />
                </div>
              </div>
              {recentPaths.length ? (
                <section aria-labelledby="recent-files-heading" className="mt-10">
                  <h2 id="recent-files-heading" className="mb-3 text-xs font-semibold text-ink">
                    Recent files
                  </h2>
                  <div className="grid grid-cols-2 gap-3">
                    {recentPaths.map((path) => (
                      <RecentFileCard key={path} path={path} onOpen={() => onOpenPath?.(path)} />
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {tabMenu ? (
        <div
          ref={tabMenuRef}
          aria-label={`${fileName(tabMenu.path)} tab actions`}
          className="fixed z-[100] w-44 rounded-md border border-line bg-white p-1 text-[11px] text-ink shadow-lg"
          role="menu"
          style={{ left: tabMenu.left, top: tabMenu.top }}
        >
          <button
            className="flex h-7 w-full items-center rounded px-2 text-left hover:bg-slate-100 disabled:cursor-default disabled:text-muted disabled:hover:bg-transparent"
            disabled={Boolean(browserTabs[tabMenu.path]) || tabMenu.path !== previewPath}
            role="menuitem"
            type="button"
            onClick={() => {
              onPinPath?.(tabMenu.path);
              setTabMenu(null);
            }}
          >
            Pin file
          </button>
          <div className="my-1 border-t border-line" role="separator" />
          <button
            ref={tabMenuFirstActionRef}
            className="flex h-7 w-full items-center rounded px-2 text-left hover:bg-slate-100"
            role="menuitem"
            type="button"
            onClick={() => closeWorkspacePaths(fileTabCloseTargets(tabMenu.groupPaths, tabMenu.path, "close"))}
          >
            Close
          </button>
          <button
            className="flex h-7 w-full items-center rounded px-2 text-left hover:bg-slate-100 disabled:cursor-default disabled:text-muted disabled:hover:bg-transparent"
            disabled={tabMenu.groupPaths.length < 2}
            role="menuitem"
            type="button"
            onClick={() => closeWorkspacePaths(fileTabCloseTargets(tabMenu.groupPaths, tabMenu.path, "others"))}
          >
            Close others
          </button>
          <button
            className="flex h-7 w-full items-center rounded px-2 text-left hover:bg-slate-100 disabled:cursor-default disabled:text-muted disabled:hover:bg-transparent"
            disabled={tabMenu.groupPaths.indexOf(tabMenu.path) >= tabMenu.groupPaths.length - 1}
            role="menuitem"
            type="button"
            onClick={() => closeWorkspacePaths(fileTabCloseTargets(tabMenu.groupPaths, tabMenu.path, "right"))}
          >
            Close to the right
          </button>
          <button
            className="flex h-7 w-full items-center rounded px-2 text-left hover:bg-slate-100"
            role="menuitem"
            type="button"
            onClick={() => closeWorkspacePaths(fileTabCloseTargets(tabMenu.groupPaths, tabMenu.path, "all"))}
          >
            Close all
          </button>
        </div>
      ) : null}
      {unsavedClosePrompt ? (
        <UnsavedChangesDialog
          dirtyPaths={unsavedClosePrompt.dirtyPaths}
          error={unsavedClosePrompt.error}
          saving={unsavedClosePrompt.saving}
          onCancel={() => {
            if (!unsavedClosePrompt.saving) setUnsavedClosePrompt(null);
          }}
          onDiscard={() => {
            if (unsavedClosePrompt.saving) return;
            const { dirtyPaths, targets } = unsavedClosePrompt;
            setUnsavedClosePrompt(null);
            finishClosingWorkspacePaths(targets, dirtyPaths.includes(sourcePath));
          }}
          onSave={() => void saveAndClosePromptedPaths()}
        />
      ) : null}
    </section>
  );
});

export function UnsavedChangesDialog({
  dirtyPaths,
  error = "",
  onCancel,
  onDiscard,
  onSave,
  saving = false,
}) {
  const fileCount = dirtyPaths.length;
  const title = fileCount === 1
    ? `Save changes to ${fileName(dirtyPaths[0])}?`
    : `Save changes to ${fileCount} files?`;
  const description = fileCount === 1
    ? "Your changes will be lost if you don't save them."
    : `Changes in ${fileCount} files will be lost if you don't save them.`;
  return (
    <Dialog
      description={description}
      onClose={onCancel}
      panelClassName="w-full max-w-md rounded-xl border border-line bg-white p-5 text-ink shadow-xl"
      title={title}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
          <AlertTriangle aria-hidden="true" size={17} />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold leading-5">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-muted">{description}</p>
        </div>
      </div>
      {error ? (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-xs leading-5 text-red-700 dark:bg-red-950/40 dark:text-red-300" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button
          className="h-8 rounded-md px-3 text-xs font-medium text-ink hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50"
          disabled={saving}
          type="button"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="h-8 rounded-md px-3 text-xs font-medium text-red-700 hover:bg-red-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-600 disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-950/40"
          disabled={saving}
          type="button"
          onClick={onDiscard}
        >
          Discard changes
        </button>
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand px-3 text-xs font-semibold text-white hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60"
          data-dialog-initial-focus
          disabled={saving}
          type="button"
          onClick={onSave}
        >
          {saving ? <Loader2 aria-hidden="true" className="animate-spin" size={13} /> : <Save aria-hidden="true" size={13} />}
          {saving ? "Saving" : fileCount === 1 ? "Save" : "Save all"}
        </button>
      </div>
    </Dialog>
  );
}

function PreviewBrowser({ diffPath = "", ...props }) {
  const [diffAvailable, setDiffAvailable] = useState(false);
  useEffect(() => {
    if (!diffPath) {
      setDiffAvailable(false);
      return undefined;
    }
    let disposed = false;
    const readBaseline = window.goferDesktop?.workspace?.gitFileBaseline;
    if (!readBaseline) return undefined;
    readBaseline(diffPath).then((baseline) => {
      if (!disposed) setDiffAvailable(Boolean(baseline?.tracked && baseline?.changed));
    }).catch(() => {
      if (!disposed) setDiffAvailable(false);
    });
    return () => {
      disposed = true;
    };
  }, [diffPath]);
  return <IntegratedBrowser {...props} showDiffButton={diffAvailable} />;
}

function EmptyWorkspaceAction({ icon: Icon, label, onClick, shortcut }) {
  return (
    <button
      className="flex h-10 w-full items-center gap-2 rounded-md border border-line bg-white px-3 text-left text-xs font-medium text-ink transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
      type="button"
      onClick={onClick}
    >
      <Icon aria-hidden="true" className="text-muted" size={15} />
      <span className="flex-1">{label}</span>
      <span className="text-[10px] font-normal text-muted">{shortcut}</span>
    </button>
  );
}

function RecentFileCard({ onOpen, path }) {
  const parentPath = String(path ?? "").replace(/[\\/][^\\/]+$/, "");
  return (
    <button
      className="group flex min-w-0 items-center gap-3 rounded-lg border border-line bg-white px-3 py-3 text-left transition hover:border-slate-300 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand dark:hover:bg-[#252526]"
      title={path}
      type="button"
      onClick={onOpen}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-slate-100 text-muted transition group-hover:text-ink dark:bg-[#252526]">
        <FileTypeIcon path={path} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold text-ink">{fileName(path)}</span>
        <span className="mt-0.5 block truncate text-[10px] leading-4 text-muted">{parentPath}</span>
      </span>
    </button>
  );
}

function SplitDropZone({ onDrop, side }) {
  return (
    <div
      aria-label={`Split editor ${side}`}
      className={`z-40 m-2 flex w-[22%] items-center justify-center rounded-md border border-indigo-400 bg-indigo-100/80 text-xs font-semibold text-indigo-700 ${side === "left" ? "justify-self-start" : "justify-self-end"}`}
      style={{ gridColumn: "1 / -1", gridRow: 2 }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDrop();
      }}
    >
      Split {side}
    </div>
  );
}


const TextCodeEditor = forwardRef(function TextCodeEditor({
  active,
  autosaveEnabled = true,
  diagnostics = [],
  editing = true,
  editorSettings = DEFAULT_APP_SETTINGS.editor,
  html = false,
  initialDiffMode = false,
  markdown = false,
  svg = false,
  navigationRequest = null,
  path,
  theme,
  onModeChange,
  onOpenRelativeLink,
  onSaved,
  onContentChange,
  onStateChange,
}, ref) {
  const containerRef = useRef(null);
  const editorRef = useRef(null);
  const diffEditorRef = useRef(null);
  const decorationIdsRef = useRef([]);
  const monacoRef = useRef(null);
  const modelRef = useRef(null);
  const originalModelRef = useRef(null);
  const savedContentRef = useRef("");
  const savingRef = useRef(false);
  const autosaveTimerRef = useRef(null);
  const scheduleAutosaveRef = useRef(() => {});
  const editableRef = useRef(false);
  const diagnosticsRef = useRef(diagnostics);
  const editorSettingsRef = useRef(editorSettings);
  const gitBaselineRef = useRef(null);
  const onContentChangeRef = useRef(onContentChange);
  const onSavedRef = useRef(onSaved);
  const onStateChangeRef = useRef(onStateChange);
  const navigationRequestRef = useRef(navigationRequest);
  const [diffMode, setDiffMode] = useState(initialDiffMode);
  const [gitBaseline, setGitBaseline] = useState(null);
  const [state, setState] = useState({
    content: null,
    dirty: false,
    error: "",
    loading: true,
    saving: false,
  });

  const refreshGitBaseline = useCallback(async () => {
    const readBaseline = window.goferDesktop?.workspace?.gitFileBaseline;
    if (!readBaseline) {
      setGitBaseline(null);
      return null;
    }
    try {
      const baseline = await readBaseline(path);
      setGitBaseline(baseline?.tracked ? baseline : null);
      if (!baseline?.changed) setDiffMode(false);
      return baseline;
    } catch {
      setGitBaseline(null);
      setDiffMode(false);
      return null;
    }
  }, [path]);

  useEffect(() => {
    void refreshGitBaseline();
  }, [refreshGitBaseline]);

  useEffect(() => {
    const refresh = () => void refreshGitBaseline();
    const interval = window.setInterval(refresh, 2000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refreshGitBaseline]);

  useEffect(() => {
    gitBaselineRef.current = gitBaseline;
  }, [gitBaseline]);

  const save = useCallback(async () => {
    const model = modelRef.current;
    if (!model || !editableRef.current || savingRef.current) return null;
    const content = model.getValue();
    if (content === savedContentRef.current) return true;
    let fileWritten = false;
    window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = null;
    savingRef.current = true;
    setState((current) => ({ ...current, error: "", saving: true }));
    try {
      const writeTextFile = window.goferDesktop?.textFiles?.write;
      if (!writeTextFile) throw new Error("The desktop file editor is unavailable.");
      await writeTextFile({ targetPath: path, content });
      fileWritten = true;
      savedContentRef.current = content;
      const currentContent = model.getValue();
      textEditorSessions.set(path, {
        content: currentContent,
        savedContent: content,
        viewState: editorRef.current?.saveViewState() ?? null,
      });
      const savedResult = await onSavedRef.current?.(content);
      void refreshGitBaseline();
      setState({
        content: currentContent,
        dirty: currentContent !== content,
        error: "",
        loading: false,
        saving: false,
      });
      return savedResult ?? true;
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Unable to save file",
        saving: false,
      }));
      return null;
    } finally {
      savingRef.current = false;
      if (fileWritten && model.getValue() !== savedContentRef.current) {
        scheduleAutosaveRef.current();
      }
    }
  }, [path, refreshGitBaseline]);

  useEffect(() => {
    scheduleAutosaveRef.current = () => {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
      if (!autosaveEnabled) return;
      autosaveTimerRef.current = window.setTimeout(() => {
        autosaveTimerRef.current = null;
        if (savingRef.current) {
          scheduleAutosaveRef.current();
          return;
        }
        void save();
      }, editorSettings.autosaveDelay);
    };
    if (!autosaveEnabled) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, [autosaveEnabled, editorSettings.autosaveDelay, save]);

  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  useEffect(() => {
    onContentChangeRef.current = onContentChange;
  }, [onContentChange]);

  useEffect(() => {
    diagnosticsRef.current = diagnostics;
  }, [diagnostics]);

  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  useEffect(() => {
    navigationRequestRef.current = navigationRequest;
    revealEditorLocation(editorRef.current, navigationRequest);
  }, [navigationRequest]);

  useEffect(() => {
    onStateChangeRef.current?.(state);
  }, [state]);

  useImperativeHandle(ref, () => ({
    acceptContent: (content) => {
      const model = modelRef.current;
      if (!model) return;
      savedContentRef.current = content;
      model.setValue(content);
      textEditorSessions.set(path, {
        content,
        savedContent: content,
        viewState: editorRef.current?.saveViewState() ?? null,
      });
      setState({ content, dirty: false, error: "", loading: false, saving: false });
    },
    discard: () => {
      discardedSessionPaths.add(path);
      textEditorSessions.delete(path);
    },
    revealDiagnostic: (diagnostic) => {
      const monaco = monacoRef.current;
      const model = modelRef.current;
      const editor = editorRef.current;
      if (!monaco || !model || !editor) return;
      const marker = diagnosticToMarker(monaco, model, model.getValue(), diagnostic);
      editor.revealRangeInCenter(marker);
      editor.setPosition({ lineNumber: marker.startLineNumber, column: marker.startColumn });
      editor.focus();
    },
    runCommand: (command) => {
      const editor = editorRef.current;
      if (!editor) return false;
      const commandIds = {
        "edit.undo": "undo",
        "edit.redo": "redo",
        "edit.cut": "editor.action.clipboardCutAction",
        "edit.copy": "editor.action.clipboardCopyAction",
        "edit.paste": "editor.action.clipboardPasteAction",
        "edit.find": "actions.find",
        "edit.replace": "editor.action.startFindReplaceAction",
        "selection.selectAll": "editor.action.selectAll",
        "selection.expand": "editor.action.smartSelect.expand",
        "selection.shrink": "editor.action.smartSelect.shrink",
        "selection.copyLineUp": "editor.action.copyLinesUpAction",
        "selection.copyLineDown": "editor.action.copyLinesDownAction",
        "selection.moveLineUp": "editor.action.moveLinesUpAction",
        "selection.moveLineDown": "editor.action.moveLinesDownAction",
        "selection.addCursorAbove": "editor.action.insertCursorAbove",
        "selection.addCursorBelow": "editor.action.insertCursorBelow",
        "edit.toggleLineComment": "editor.action.commentLine",
        "edit.formatDocument": "editor.action.formatDocument",
      };
      const commandId = commandIds[command];
      if (!commandId) return false;
      editor.focus();
      editor.trigger("taskurotta-menu", commandId, null);
      return true;
    },
    save,
  }), [path, save]);

  useEffect(() => {
    let disposed = false;
    let contentListener;
    let resizeObserver;
    import("../lib/monaco.js").then(({ loadRadishMonaco }) => {
      if (disposed || !containerRef.current) return;
      const monaco = loadRadishMonaco();
      monacoRef.current = monaco;
      const session = textEditorSessions.get(path);
      const initialGitBaseline = gitBaselineRef.current;
      const model = monaco.editor.createModel(
        session?.content ?? "",
        languageForPath(path),
        monaco.Uri.parse(`file://${encodeURI(path)}`),
      );
      modelRef.current = model;
      monaco.editor.setModelMarkers(
        model,
        "radish",
        diagnosticsToMarkers(monaco, model, model.getValue(), diagnosticsRef.current),
      );
      const initialEditorSettings = editorSettingsRef.current;
      const editorOptions = {
        automaticLayout: false,
        cursorBlinking: "smooth",
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
        fontSize: initialEditorSettings.fontSize,
        folding: true,
        glyphMargin: true,
        lineHeight: initialEditorSettings.lineHeight,
        minimap: { enabled: initialEditorSettings.minimap, maxColumn: 80, renderCharacters: false },
        padding: { top: 12, bottom: 20 },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: initialEditorSettings.tabSize,
        theme: theme === "dark" ? "gofer-radish-dark" : "gofer-radish-light",
        wordWrap: initialEditorSettings.wordWrap ? "on" : "off",
      };
      let editor;
      if (diffMode && initialGitBaseline?.changed) {
        const originalModel = monaco.editor.createModel(
          initialGitBaseline.content ?? "",
          languageForPath(path),
          monaco.Uri.parse(`git-head://${encodeURI(path)}`),
        );
        originalModelRef.current = originalModel;
        const diffEditor = monaco.editor.createDiffEditor(
          containerRef.current,
          codeDiffEditorOptions(editorOptions),
        );
        diffEditor.setModel({ modified: model, original: originalModel });
        diffEditorRef.current = diffEditor;
        editor = diffEditor.getModifiedEditor();
      } else {
        editor = monaco.editor.create(containerRef.current, { ...editorOptions, model });
      }
      editorRef.current = editor;
      decorationIdsRef.current = editor.deltaDecorations(
        [],
        trackedChangeDecorations(initialGitBaseline, diffMode),
      );
      contentListener = model.onDidChangeContent(() => {
        const content = model.getValue();
        textEditorSessions.set(path, {
          content,
          savedContent: savedContentRef.current,
          viewState: editor.saveViewState(),
        });
        setState((current) => ({
          ...current,
          content,
          dirty: content !== savedContentRef.current,
          error: "",
        }));
        if (editableRef.current) {
          onContentChangeRef.current?.(content);
          scheduleAutosaveRef.current();
        }
      });
      resizeObserver = new ResizeObserver(() => (diffEditorRef.current ?? editor).layout());
      resizeObserver.observe(containerRef.current);

      if (session) {
        editableRef.current = true;
        savedContentRef.current = session.savedContent;
        editor.restoreViewState(session.viewState);
        setState({
          content: session.content,
          dirty: session.content !== session.savedContent,
          error: "",
          loading: false,
          saving: false,
        });
        revealEditorLocation(editor, navigationRequestRef.current);
        return;
      }
      const readTextFile = window.goferDesktop?.textFiles?.read;
      if (!readTextFile) {
        editableRef.current = false;
        editor.updateOptions({ readOnly: true });
        setState({
          content: null,
          dirty: false,
          error: "The desktop file editor is unavailable.",
          loading: false,
          saving: false,
        });
        return;
      }
      readTextFile(path).then((payload) => {
        if (disposed) return;
        const content = payload?.content ?? "";
        editableRef.current = true;
        savedContentRef.current = content;
        model.setValue(content);
        textEditorSessions.set(path, { content, savedContent: content, viewState: null });
        setState({ content, dirty: false, error: "", loading: false, saving: false });
        revealEditorLocation(editor, navigationRequestRef.current);
      }).catch((error) => {
        if (disposed) return;
        editableRef.current = false;
        editor.updateOptions({ readOnly: true });
        setState({
          content: null,
          dirty: false,
          error: error instanceof Error ? error.message : "Unable to open file",
          loading: false,
          saving: false,
        });
      });
    });
    return () => {
      disposed = true;
      window.clearTimeout(autosaveTimerRef.current);
      if (modelRef.current && editableRef.current) {
        if (discardedSessionPaths.has(path)) {
          discardedSessionPaths.delete(path);
        } else {
          textEditorSessions.set(path, {
            content: modelRef.current.getValue(),
            savedContent: savedContentRef.current,
            viewState: editorRef.current?.saveViewState() ?? null,
          });
        }
      }
      contentListener?.dispose();
      resizeObserver?.disconnect();
      decorationIdsRef.current = [];
      if (diffEditorRef.current) diffEditorRef.current.dispose();
      else editorRef.current?.dispose();
      originalModelRef.current?.dispose();
      modelRef.current?.dispose();
      editorRef.current = null;
      diffEditorRef.current = null;
      modelRef.current = null;
      monacoRef.current = null;
      originalModelRef.current = null;
    };
  }, [diffMode, path, save, theme]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    decorationIdsRef.current = editor.deltaDecorations(
      decorationIdsRef.current,
      trackedChangeDecorations(gitBaseline, diffMode),
    );
  }, [diffMode, gitBaseline]);

  useEffect(() => {
    editorSettingsRef.current = editorSettings;
    editorRef.current?.updateOptions({
      fontSize: editorSettings.fontSize,
      lineHeight: editorSettings.lineHeight,
      minimap: { enabled: editorSettings.minimap, maxColumn: 80, renderCharacters: false },
      tabSize: editorSettings.tabSize,
      wordWrap: editorSettings.wordWrap ? "on" : "off",
    });
  }, [editorSettings]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const model = modelRef.current;
    if (!monaco || !model) return;
    monaco.editor.setModelMarkers(
      model,
      "radish",
      diagnosticsToMarkers(monaco, model, model.getValue(), diagnostics),
    );
  }, [diagnostics]);

  useEffect(() => {
    const monacoTheme = theme === "dark" ? "gofer-radish-dark" : "gofer-radish-light";
    import("../lib/monaco.js").then(({ loadRadishMonaco }) => loadRadishMonaco().editor.setTheme(monacoTheme));
  }, [theme]);

  useEffect(() => {
    if (!editing) {
      if (editorRef.current?.hasTextFocus()) document.activeElement?.blur?.();
      return;
    }
    if (!active) return;
    window.requestAnimationFrame(() => {
      editorRef.current?.layout();
      editorRef.current?.focus();
    });
  }, [active, editing]);

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-white" aria-label={`${fileName(path)} editor`}>
      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          aria-hidden={!editing}
          className={`absolute inset-0 ${editing ? "visible" : "invisible pointer-events-none"}`}
        />
        {markdown && !editing && !state.loading && state.content != null ? (
          <MarkdownPreview
            content={state.content ?? ""}
            path={path}
            onEdit={() => onModeChange?.("edit")}
            onOpenRelativeLink={onOpenRelativeLink}
          />
        ) : null}
        {svg && !editing && !state.loading && state.content != null ? (
          <SvgPreview content={state.content} path={path} onEdit={() => onModeChange?.("edit")} />
        ) : null}
        {markdown ? (
          <MarkdownModeToggle
            disabled={state.loading || state.content == null}
            editing={editing}
            onModeChange={onModeChange}
          />
        ) : null}
        {html ? (
          <div className="absolute right-4 top-3 z-20">
            <HtmlModeToggle editing={editing} onModeChange={onModeChange} />
          </div>
        ) : null}
        {svg ? (
          <DocumentModeToggle
            disabled={state.loading || state.content == null}
            editing={editing}
            label="SVG"
            onModeChange={onModeChange}
          />
        ) : null}
        {gitBaseline?.changed ? (
          <button
            aria-label={diffMode ? "Hide file diff" : "Show file diff"}
            aria-pressed={diffMode}
            className={`absolute top-3 z-20 inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-[11px] font-semibold shadow-sm transition ${
              markdown || html || svg ? "right-20" : "right-4"
            } ${
              diffMode
                ? "bg-brand text-white"
                : "bg-white text-ink hover:bg-slate-50 dark:bg-[#252526] dark:hover:bg-[#333337]"
            }`}
            title={diffMode ? "Hide file diff" : "Compare with HEAD"}
            type="button"
            onClick={() => {
              if (!diffMode && !editing) onModeChange?.("edit");
              setDiffMode((current) => !current);
            }}
          >
            <GitCompareArrows aria-hidden="true" size={13} />
            Diff
          </button>
        ) : null}
        {state.loading ? (
          <div className="absolute inset-0 z-10 grid place-items-center bg-white/90 text-sm text-muted dark:bg-[#19191b]/90">
            <span className="flex items-center gap-2"><Loader2 className="animate-spin" size={16} />Opening {fileName(path)}</span>
          </div>
        ) : null}
        {state.error ? (
          <div className="absolute bottom-3 left-3 right-3 z-10 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
            <AlertTriangle className="shrink-0" size={14} />
            <span className="min-w-0 flex-1 break-words">{state.error}</span>
          </div>
        ) : null}
      </div>
      <div className="flex h-6 shrink-0 items-center justify-end gap-3 border-t border-line bg-white px-3 text-[10px] text-muted">
        <span>{languageLabel(languageForPath(path))}</span>
        <span>Spaces: 2</span>
      </div>
    </section>
  );
});

export function MarkdownPreview({ content, path, onEdit, onOpenRelativeLink }) {
  return (
    <article
      aria-label={`${fileName(path)} Markdown preview`}
      className="workflow-scrollbar absolute inset-0 overflow-auto bg-white px-8 pb-16 pt-12 text-sm text-slate-700 dark:bg-[#19191b] dark:text-[#d4d4d4]"
      title="Double-click to edit"
      onDoubleClick={(event) => {
        if (event.target.closest?.("a, button, input")) return;
        onEdit?.();
      }}
    >
      <MarkdownContent
        className="mx-auto w-full max-w-[76ch]"
        value={content}
        onOpenRelativeLink={onOpenRelativeLink}
      />
    </article>
  );
}

export function MarkdownModeToggle({ disabled = false, editing, onModeChange }) {
  return (
    <div
      aria-label="Markdown view mode"
      className="absolute right-4 top-3 z-20 flex items-center rounded-lg border border-line bg-white p-0.5 shadow-sm dark:bg-[#252526]"
      role="group"
    >
      <button
        aria-label="Preview Markdown"
        aria-pressed={!editing}
        className={`grid h-7 w-7 place-items-center rounded-md transition ${
          !editing ? "bg-slate-100 text-ink dark:bg-[#333337]" : "text-muted hover:text-ink"
        }`}
        disabled={disabled}
        title="Preview Markdown"
        type="button"
        onClick={() => onModeChange?.("preview")}
      >
        <Eye size={14} />
      </button>
      <button
        aria-label="Edit Markdown"
        aria-pressed={editing}
        className={`grid h-7 w-7 place-items-center rounded-md transition ${
          editing ? "bg-slate-100 text-ink dark:bg-[#333337]" : "text-muted hover:text-ink"
        }`}
        disabled={disabled}
        title="Edit Markdown"
        type="button"
        onClick={() => onModeChange?.("edit")}
      >
        <PencilLine size={14} />
      </button>
    </div>
  );
}

export function DocumentModeToggle({ disabled = false, editing, label, onModeChange }) {
  return (
    <div
      aria-label={`${label} view mode`}
      className="absolute right-4 top-3 z-20 flex items-center rounded-lg border border-line bg-white p-0.5 shadow-sm dark:bg-[#252526]"
      role="group"
    >
      <button
        aria-label={`Preview ${label}`}
        aria-pressed={!editing}
        className={`grid h-7 w-7 place-items-center rounded-md transition ${!editing ? "bg-slate-100 text-ink dark:bg-[#333337]" : "text-muted hover:text-ink"}`}
        disabled={disabled}
        title={`Preview ${label}`}
        type="button"
        onClick={() => onModeChange?.("preview")}
      ><Eye size={14} /></button>
      <button
        aria-label={`Edit ${label}`}
        aria-pressed={editing}
        className={`grid h-7 w-7 place-items-center rounded-md transition ${editing ? "bg-slate-100 text-ink dark:bg-[#333337]" : "text-muted hover:text-ink"}`}
        disabled={disabled}
        title={`Edit ${label}`}
        type="button"
        onClick={() => onModeChange?.("edit")}
      ><PencilLine size={14} /></button>
    </div>
  );
}

export function SvgPreview({ content, path, onEdit }) {
  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content ?? "")}`;
  return (
    <div
      aria-label={`${fileName(path)} SVG preview`}
      className="absolute inset-0 grid place-items-center overflow-auto bg-[linear-gradient(45deg,#f4f4f5_25%,transparent_25%),linear-gradient(-45deg,#f4f4f5_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#f4f4f5_75%),linear-gradient(-45deg,transparent_75%,#f4f4f5_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0] p-12 dark:bg-[#19191b]"
      title="Double-click to edit"
      onDoubleClick={onEdit}
    >
      <img alt={`Preview of ${fileName(path)}`} className="max-h-full max-w-full" src={source} />
    </div>
  );
}

export function ImagePreview({ path }) {
  const [state, setState] = useState({ dataUrl: "", error: "", loading: true });
  useEffect(() => {
    let disposed = false;
    const readPreview = window.goferDesktop?.textFiles?.readPreview;
    if (!readPreview) {
      setState({ dataUrl: "", error: "Image preview is unavailable.", loading: false });
      return undefined;
    }
    readPreview(path).then((payload) => {
      if (!disposed) setState({ dataUrl: payload?.dataUrl ?? "", error: "", loading: false });
    }).catch((error) => {
      if (!disposed) setState({
        dataUrl: "",
        error: error instanceof Error ? error.message : "Unable to preview image",
        loading: false,
      });
    });
    return () => { disposed = true; };
  }, [path]);
  return (
    <section className="relative grid min-h-0 flex-1 place-items-center overflow-auto bg-slate-50 p-8 dark:bg-[#19191b]" aria-label={`${fileName(path)} image preview`}>
      {state.loading ? <span className="flex items-center gap-2 text-sm text-muted"><Loader2 className="animate-spin" size={16} />Opening {fileName(path)}</span> : null}
      {state.error ? <div className="flex items-center gap-2 text-sm text-red-700" role="alert"><AlertTriangle size={16} />{state.error}</div> : null}
      {state.dataUrl ? <img alt={`Preview of ${fileName(path)}`} className="max-h-full max-w-full object-contain" src={state.dataUrl} /> : null}
    </section>
  );
}

export function codeWorkspaceShortcutAction(event, options = {}) {
  if (!options.active || event.repeat) return null;
  if (
    event.ctrlKey
    && !event.altKey
    && !event.metaKey
    && String(event.key ?? "").toLowerCase() === "tab"
    && options.currentPath
  ) return event.shiftKey ? "previous-tab" : "next-tab";
  if (
    options.browserActive
    && matchesKeybinding(event, "Mod+KeyT")
  ) return "new-browser-tab";
  if (matchesCommand(event, options.settings, "file.new")) return "new";
  if (matchesCommand(event, options.settings, "file.save") && options.currentPath) return "save";
  if (matchesCommand(event, options.settings, "file.close") && options.currentPath) return "close";
  if (matchesCommand(event, options.settings, "editor.toggleWordWrap")) return "toggle-word-wrap";
  return null;
}

export function trackedChangeDecorations(baseline, diffMode = false) {
  if (diffMode || !baseline?.changed) return [];
  return (baseline.hunks ?? []).map((hunk) => ({
    options: {
      description: "Git tracked change",
      isWholeLine: true,
      linesDecorationsClassName: "tracked-change-line",
    },
    range: {
      endColumn: 1,
      endLineNumber: hunk.endLine,
      startColumn: 1,
      startLineNumber: hunk.startLine,
    },
  }));
}

export function codeDiffEditorOptions(editorOptions = {}) {
  return {
    ...editorOptions,
    diffAlgorithm: "advanced",
    enableSplitViewResizing: true,
    ignoreTrimWhitespace: false,
    originalEditable: false,
    renderSideBySide: true,
    renderWhitespace: "all",
  };
}

export function fileTabCloseTargets(openPaths, path, action) {
  const index = openPaths.indexOf(path);
  if (index < 0) return [];
  if (action === "others") return openPaths.filter((candidate) => candidate !== path);
  if (action === "right") return openPaths.slice(index + 1);
  if (action === "all") return [...openPaths];
  return [path];
}

export function reorderCodeTabs(openPaths, sourcePath, targetPath) {
  const sourceIndex = openPaths.indexOf(sourcePath);
  const targetIndex = openPaths.indexOf(targetPath);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return [...openPaths];
  const next = [...openPaths];
  const [source] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, source);
  return next;
}

export function stableCodeDocumentPaths(previousPaths, openPaths) {
  const openPathSet = new Set(openPaths);
  const previousPathSet = new Set(previousPaths);
  return [
    ...previousPaths.filter((path) => openPathSet.has(path)),
    ...openPaths.filter((path) => !previousPathSet.has(path)),
  ];
}

export function adjacentCodeTab(openPaths, currentPath, direction = 1) {
  if (!openPaths.length) return "";
  const currentIndex = openPaths.indexOf(currentPath);
  if (currentIndex < 0) return openPaths[0];
  return openPaths[(currentIndex + direction + openPaths.length) % openPaths.length];
}

function FileTypeIcon({ browserTab, path }) {
  const favicon = browserTabFavicon(browserTab);
  const [faviconFailed, setFaviconFailed] = useState(false);
  useEffect(() => setFaviconFailed(false), [favicon]);
  if (browserTab && favicon && !faviconFailed) {
    return (
      <img
        alt=""
        className="h-3.5 w-3.5 shrink-0 object-contain"
        draggable={false}
        src={favicon}
        onError={() => setFaviconFailed(true)}
      />
    );
  }
  if (browserTab) return <Globe aria-hidden="true" className="shrink-0 text-brand" size={14} />;
  if (path.toLowerCase().endsWith(".json")) return <FileJson2 aria-hidden="true" className="shrink-0 text-amber-600" size={14} />;
  if (languageForPath(path) !== "plaintext") return <FileCode2 aria-hidden="true" className="shrink-0 text-brand" size={14} />;
  return <FileText aria-hidden="true" className="shrink-0 text-muted" size={14} />;
}

export function languageForPath(path) {
  const name = fileName(path).toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const languages = {
    ".bash": "shell", ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cs": "csharp",
    ".css": "css", ".go": "go", ".h": "c", ".hpp": "cpp", ".html": "html",
    ".ini": "ini", ".java": "java", ".js": "javascript", ".json": "json",
    ".jsx": "javascript", ".markdown": "markdown", ".md": "markdown",
    ".mdown": "markdown", ".mjs": "javascript", ".mkd": "markdown", ".php": "php",
    ".ps1": "powershell", ".py": "python", ".rb": "ruby", ".rs": "rust",
    ".rad": "radish",
    ".scss": "scss", ".sh": "shell", ".sql": "sql", ".svg": "xml", ".toml": "ini",
    ".ts": "typescript", ".tsx": "typescript", ".txt": "plaintext", ".xml": "xml",
    ".yaml": "yaml", ".yml": "yaml", ".zsh": "shell",
  };
  if (name === "dockerfile") return "dockerfile";
  return languages[extension] ?? "plaintext";
}

export function isMarkdownPath(path) {
  return languageForPath(path) === "markdown";
}

export function isHtmlPath(path) {
  return [".htm", ".html"].some((extension) => String(path ?? "").toLowerCase().endsWith(extension));
}

export function isSvgPath(path) {
  return String(path ?? "").toLowerCase().endsWith(".svg");
}

export function isPdfPath(path) {
  return String(path ?? "").toLowerCase().endsWith(".pdf");
}

export function isImagePath(path) {
  return [".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".webp"]
    .some((extension) => String(path ?? "").toLowerCase().endsWith(extension));
}

export function codeDocumentMode(
  path,
  documentModes = {},
  editorSettings = DEFAULT_APP_SETTINGS.editor,
) {
  if (!isMarkdownPath(path) && !isHtmlPath(path) && !isSvgPath(path)) return "edit";
  if (documentModes[path] === "edit" || documentModes[path] === "preview") {
    return documentModes[path];
  }
  if (isMarkdownPath(path)) return editorSettings.markdownDefault;
  if (isHtmlPath(path)) return editorSettings.htmlDefault;
  return "preview";
}

export function browserTabLabel(tab = {}) {
  const title = String(tab.title ?? "").trim();
  if (title) return title;
  const url = String(tab.url ?? "").trim();
  if (!url || url === "about:blank") return "New Tab";
  if (url === "taskurotta://home") return "Taskurotta";
  try {
    return new URL(url).hostname.replace(/^www\./i, "") || url;
  } catch {
    return url;
  }
}

export function browserTabFavicon(tab = {}) {
  const favicon = String(tab?.favicon ?? "").trim();
  if (/^(?:https?:|file:|data:image\/)/i.test(favicon)) return favicon;
  return String(tab?.url ?? "").trim() === "taskurotta://home" ? taskurottaIcon : "";
}

export function browserViewTabMetadata(browserTab, viewState) {
  if (browserTab) return viewState ? { ...browserTab, ...viewState } : browserTab;
  const title = String(viewState?.title ?? "").trim();
  const url = String(viewState?.url ?? "").trim();
  return title || /^https?:/i.test(url) ? viewState : null;
}

export function codeTabLabel(path, browserTab) {
  return browserTab ? browserTabLabel(browserTab) : fileName(path);
}

export function resolveMarkdownLinkPath(sourcePath, href) {
  if (/^file:/i.test(String(href ?? ""))) {
    return filePathFromMarkdownUrl(href, sourcePath);
  }
  const rawTarget = String(href ?? "").split(/[?#]/, 1)[0];
  const windowsAbsolute = /^[a-z]:[\\/]/i.test(rawTarget);
  if (!rawTarget || (!windowsAbsolute && /^[a-z][a-z\d+.-]*:/i.test(rawTarget))) return "";
  let target;
  try {
    target = decodeURIComponent(rawTarget).replaceAll("\\", "/");
  } catch {
    target = rawTarget.replaceAll("\\", "/");
  }
  const source = String(sourcePath ?? "").replaceAll("\\", "/");
  const separator = String(sourcePath).includes("\\") && !String(sourcePath).includes("/")
    ? "\\"
    : "/";
  const absolute = target.startsWith("/") || /^[a-z]:\//i.test(target);
  const parts = absolute
    ? []
    : source.split("/").slice(0, -1).filter(Boolean);
  const prefix = target.startsWith("/") || source.startsWith("/") ? "/" : "";

  for (const segment of target.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length && !/^[a-z]:$/i.test(parts.at(-1))) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `${prefix}${parts.join("/")}`.replaceAll("/", separator);
}

export function markdownFileLinkTarget(sourcePath, href) {
  const resolvedPath = resolveMarkdownLinkPath(sourcePath, href);
  if (!resolvedPath) return null;
  const location = resolvedPath.match(/:([1-9]\d*)(?::([1-9]\d*))?$/);
  if (!location) return { column: 1, lineNumber: null, path: resolvedPath };
  return {
    column: location[2] ? Number(location[2]) : 1,
    lineNumber: Number(location[1]),
    path: resolvedPath.slice(0, -location[0].length),
  };
}

export function filePathFromMarkdownUrl(href, sourcePath = "") {
  try {
    const url = new URL(String(href ?? ""));
    if (url.protocol !== "file:") return "";
    const hostname = url.hostname && url.hostname !== "localhost" ? url.hostname : "";
    let targetPath = decodeURIComponent(url.pathname);
    if (hostname) targetPath = `//${hostname}${targetPath}`;
    if (/^\/[a-z]:\//i.test(targetPath)) targetPath = targetPath.slice(1);
    const windowsPath = /^[a-z]:\//i.test(targetPath)
      || (String(sourcePath).includes("\\") && !String(sourcePath).includes("/"));
    return windowsPath ? targetPath.replaceAll("/", "\\") : targetPath;
  } catch {
    return "";
  }
}

export async function resolveMarkdownFileLinkTarget(sourcePath, href, getPathInfo) {
  const target = markdownFileLinkTarget(sourcePath, href);
  if (!target) return null;
  if (!getPathInfo) return target;
  const info = await getPathInfo(target.path);
  if (!info?.isFile) throw new Error(`The link does not point to a file: ${target.path}`);
  return { ...target, path: info.path || target.path };
}

export async function resolveMarkdownFileTarget(sourcePath, href, getPathInfo) {
  return (await resolveMarkdownFileLinkTarget(sourcePath, href, getPathInfo))?.path ?? "";
}

export function revealEditorLocation(editor, target) {
  if (!editor || !Number.isInteger(target?.lineNumber) || target.lineNumber < 1) return false;
  const position = {
    column: Number.isInteger(target.column) && target.column > 0 ? target.column : 1,
    lineNumber: target.lineNumber,
  };
  editor.revealPositionInCenter(position);
  editor.setPosition(position);
  editor.focus();
  return true;
}

function languageLabel(language) {
  return language === "plaintext" ? "Plain text" : language;
}

function fileName(path) {
  return String(path ?? "").split(/[\\/]/).filter(Boolean).at(-1) ?? "Untitled";
}

export function duplicateTabFolder(path, openPaths) {
  const name = fileName(path);
  if (openPaths.filter((candidate) => fileName(candidate) === name).length < 2) return "";
  return String(path ?? "").split(/[\\/]/).filter(Boolean).at(-2) ?? "";
}

function replacePathPrefix(path, sourcePath, destinationPath, isDirectory) {
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
  if (!isDirectory) return path === changedPath;
  const normalizedPath = String(path).replaceAll("\\", "/");
  const normalizedChanged = String(changedPath).replaceAll("\\", "/").replace(/\/$/, "");
  return normalizedPath === normalizedChanged || normalizedPath.startsWith(`${normalizedChanged}/`);
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

export default CodeWorkspace;
