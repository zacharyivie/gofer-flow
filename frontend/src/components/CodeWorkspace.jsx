import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { AlertTriangle, FileCode2, FileJson2, FileText, Loader2, Save, X } from "lucide-react";
import RadishEditor from "./RadishEditor.jsx";

const textEditorSessions = new Map();
const discardedSessionPaths = new Set();

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
  theme,
  workflow,
  onActivePathChange,
  onClosePath,
  onDocumentStateChange,
}, ref) {
  const radishRef = useRef(null);
  const textEditorRefs = useRef(new Map());
  const [fileStates, setFileStates] = useState({});
  const sourcePath = workflow?.sourcePath ?? "";
  const currentPath = activePath || sourcePath;

  useImperativeHandle(
    ref,
    () => ({
      acceptDocument: (document) => radishRef.current?.acceptDocument?.(document),
      save: () => radishRef.current?.save?.(),
      saveActive: () => currentPath === sourcePath
        ? radishRef.current?.save?.()
        : textEditorRefs.current.get(currentPath)?.save?.(),
    }),
    [currentPath, sourcePath],
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-white" aria-label="Code workspace">
      <div className="flex h-9 shrink-0 items-center overflow-x-auto border-b border-line bg-slate-50">
        {openPaths.map((path) => {
          const selected = path === currentPath;
          const isRadish = path === sourcePath;
          const dirty = !isRadish && fileStates[path]?.dirty;
          return (
            <div
              key={path}
              aria-selected={selected}
              className={`group relative flex h-full max-w-64 shrink-0 items-center border-r border-line text-xs ${selected ? "bg-white font-semibold text-ink" : "text-muted hover:bg-white/70 hover:text-ink"}`}
              role="tab"
              title={path}
            >
              <button
                className="flex h-full min-w-0 flex-1 items-center gap-2 py-0 pl-3 pr-2 text-left"
                type="button"
                onClick={() => onActivePathChange?.(path)}
              >
                <FileTypeIcon path={path} radish={isRadish} />
                <span className="min-w-0 truncate">{fileName(path)}</span>
                {dirty ? <span aria-label="Unsaved changes" className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" /> : null}
              </button>
              {!isRadish ? (
                <button
                  aria-label={`Close ${fileName(path)}`}
                  className="mr-1 grid h-5 w-5 shrink-0 place-items-center rounded text-muted opacity-0 hover:bg-slate-100 hover:text-ink focus:opacity-100 group-hover:opacity-100"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    requestClosePath(path, dirty, onClosePath);
                  }}
                ><X size={12} /></button>
              ) : null}
              {selected ? <span className="absolute inset-x-0 top-0 h-0.5 bg-brand" /> : null}
            </div>
          );
        })}
      </div>
      <div className="flex h-7 shrink-0 items-center gap-1 overflow-hidden border-b border-line bg-white px-3 text-[11px] text-muted">
        <span className="truncate">{relativeProjectPath(currentPath, workflow?.projectRoot)}</span>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className={`${currentPath === sourcePath ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}>
          <RadishEditor
            active={active && currentPath === sourcePath}
            ref={radishRef}
            showFileChrome={false}
            theme={theme}
            workflow={workflow}
            onDocumentStateChange={onDocumentStateChange}
          />
        </div>
        {openPaths.filter((path) => path !== sourcePath).map((path) => (
          <div key={path} className={`${currentPath === path ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}>
            <TextCodeEditor
              active={active && currentPath === path}
              path={path}
              ref={(editor) => {
                if (editor) textEditorRefs.current.set(path, editor);
                else textEditorRefs.current.delete(path);
              }}
              theme={theme}
              onStateChange={(nextState) => setFileStates((current) => ({
                ...current,
                [path]: nextState,
              }))}
            />
          </div>
        ))}
      </div>
    </section>
  );
});

const TextCodeEditor = forwardRef(function TextCodeEditor({ active, path, theme, onStateChange }, ref) {
  const containerRef = useRef(null);
  const editorRef = useRef(null);
  const modelRef = useRef(null);
  const savedContentRef = useRef("");
  const savingRef = useRef(false);
  const editableRef = useRef(false);
  const onStateChangeRef = useRef(onStateChange);
  const [state, setState] = useState({ dirty: false, error: "", loading: true, saving: false });

  const save = useCallback(async () => {
    const model = modelRef.current;
    if (!model || !editableRef.current || savingRef.current) return;
    const content = model.getValue();
    savingRef.current = true;
    setState((current) => ({ ...current, error: "", saving: true }));
    try {
      await window.goferDesktop?.textFiles?.write?.({ targetPath: path, content });
      savedContentRef.current = content;
      textEditorSessions.set(path, {
        content,
        savedContent: content,
        viewState: editorRef.current?.saveViewState() ?? null,
      });
      setState({ dirty: false, error: "", loading: false, saving: false });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Unable to save file",
        saving: false,
      }));
    } finally {
      savingRef.current = false;
    }
  }, [path]);

  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  useEffect(() => {
    onStateChangeRef.current?.(state);
  }, [state]);

  useImperativeHandle(ref, () => ({ save }), [save]);

  useEffect(() => {
    let disposed = false;
    let contentListener;
    let resizeObserver;
    import("../lib/monaco.js").then(({ loadRadishMonaco }) => {
      if (disposed || !containerRef.current) return;
      const monaco = loadRadishMonaco();
      const session = textEditorSessions.get(path);
      const model = monaco.editor.createModel(
        session?.content ?? "",
        languageForPath(path),
        monaco.Uri.parse(`file://${encodeURI(path)}`),
      );
      modelRef.current = model;
      const editor = monaco.editor.create(containerRef.current, {
        automaticLayout: false,
        cursorBlinking: "smooth",
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
        fontSize: 13,
        folding: true,
        glyphMargin: true,
        lineHeight: 20,
        minimap: { enabled: true, maxColumn: 80, renderCharacters: false },
        model,
        padding: { top: 12, bottom: 20 },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: 2,
        theme: theme === "dark" ? "gofer-radish-dark" : "gofer-radish-light",
        wordWrap: "off",
      });
      editorRef.current = editor;
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
      contentListener = model.onDidChangeContent(() => {
        const content = model.getValue();
        textEditorSessions.set(path, {
          content,
          savedContent: savedContentRef.current,
          viewState: editor.saveViewState(),
        });
        setState((current) => ({
          ...current,
          dirty: content !== savedContentRef.current,
          error: "",
        }));
      });
      resizeObserver = new ResizeObserver(() => editor.layout());
      resizeObserver.observe(containerRef.current);

      if (session) {
        editableRef.current = true;
        savedContentRef.current = session.savedContent;
        editor.restoreViewState(session.viewState);
        setState({
          dirty: session.content !== session.savedContent,
          error: "",
          loading: false,
          saving: false,
        });
        return;
      }
      window.goferDesktop?.textFiles?.read?.(path).then((payload) => {
        if (disposed) return;
        const content = payload?.content ?? "";
        editableRef.current = true;
        savedContentRef.current = content;
        model.setValue(content);
        textEditorSessions.set(path, { content, savedContent: content, viewState: null });
        setState({ dirty: false, error: "", loading: false, saving: false });
      }).catch((error) => {
        if (disposed) return;
        editableRef.current = false;
        editor.updateOptions({ readOnly: true });
        setState({
          dirty: false,
          error: error instanceof Error ? error.message : "Unable to open file",
          loading: false,
          saving: false,
        });
      });
    });
    return () => {
      disposed = true;
      if (modelRef.current) {
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
      editorRef.current?.dispose();
      modelRef.current?.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
  }, [path, save, theme]);

  useEffect(() => {
    const monacoTheme = theme === "dark" ? "gofer-radish-dark" : "gofer-radish-light";
    import("../lib/monaco.js").then(({ loadRadishMonaco }) => loadRadishMonaco().editor.setTheme(monacoTheme));
  }, [theme]);

  useEffect(() => {
    if (active) window.requestAnimationFrame(() => editorRef.current?.layout());
  }, [active]);

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-white" aria-label={`${fileName(path)} editor`}>
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />
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
        <button
          className="inline-flex items-center gap-1 font-semibold text-ink disabled:cursor-not-allowed disabled:text-muted"
          disabled={!state.dirty || state.saving || !editableRef.current}
          title="Save file (Ctrl+S)"
          type="button"
          onClick={() => void save()}
        ><Save size={11} />Save</button>
        <span>{state.saving ? "Saving" : state.dirty ? "Unsaved" : "Saved"}</span>
        <span>{languageLabel(languageForPath(path))}</span>
        <span>Spaces: 2</span>
      </div>
    </section>
  );
});

function requestClosePath(path, dirty, onClosePath) {
  if (dirty && !window.confirm(`Close ${fileName(path)} without saving your changes?`)) return;
  if (dirty) {
    discardedSessionPaths.add(path);
    textEditorSessions.delete(path);
  }
  onClosePath?.(path);
}

function FileTypeIcon({ path, radish }) {
  if (radish) return <span aria-hidden="true" className="grid h-4 min-w-5 place-items-center rounded bg-brand px-1 text-[8px] font-bold text-white">RAD</span>;
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
    ".jsx": "javascript", ".md": "markdown", ".mjs": "javascript", ".php": "php",
    ".ps1": "powershell", ".py": "python", ".rb": "ruby", ".rs": "rust",
    ".scss": "scss", ".sh": "shell", ".sql": "sql", ".svg": "xml", ".toml": "ini",
    ".ts": "typescript", ".tsx": "typescript", ".txt": "plaintext", ".xml": "xml",
    ".yaml": "yaml", ".yml": "yaml", ".zsh": "shell",
  };
  if (name === "dockerfile") return "dockerfile";
  return languages[extension] ?? "plaintext";
}

function languageLabel(language) {
  return language === "plaintext" ? "Plain text" : language;
}

function fileName(path) {
  return String(path ?? "").split(/[\\/]/).filter(Boolean).at(-1) ?? "Untitled";
}

function relativeProjectPath(path, projectRoot) {
  const normalizedPath = String(path ?? "").replaceAll("\\", "/");
  const normalizedRoot = String(projectRoot ?? "").replaceAll("\\", "/").replace(/\/$/, "");
  if (normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1).split("/").join(" / ");
  }
  return normalizedPath.split("/").filter(Boolean).join(" / ");
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

export default CodeWorkspace;
