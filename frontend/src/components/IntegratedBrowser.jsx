import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  GitCompareArrows,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";

export default function IntegratedBrowser({
  active,
  clientId,
  editing = false,
  initialUrl = "about:blank",
  localPath = "",
  onClose,
  onCycleTab,
  onNewTab,
  onShowDiff,
  onModeChange,
  onStateChange,
  openBrowserBinding = "Mod+Alt+Slash",
  searchUrl = "https://www.google.com/search?q={query}",
  showDiffButton = false,
  showModeToggle = false,
}) {
  const addressRef = useRef(null);
  const activeRef = useRef(active);
  const initialUrlRef = useRef(initialUrl);
  const initialOpenBrowserBindingRef = useRef(openBrowserBinding);
  const onCloseRef = useRef(onClose);
  const onCycleTabRef = useRef(onCycleTab);
  const onModeChangeRef = useRef(onModeChange);
  const onNewTabRef = useRef(onNewTab);
  const onStateChangeRef = useRef(onStateChange);
  const placeholderRef = useRef(null);
  const sessionIdRef = useRef("");
  const [addressDraft, setAddressDraft] = useState(displayBrowserUrl(initialUrl));
  const [addressFocused, setAddressFocused] = useState(false);
  const [occluded, setOccluded] = useState(false);
  const [state, setState] = useState({
    canGoBack: false,
    canGoForward: false,
    error: "",
    loading: true,
    title: "",
    url: initialUrl,
  });
  const bridge = window.goferBrowser;

  useEffect(() => {
    activeRef.current = active;
    onCloseRef.current = onClose;
    onCycleTabRef.current = onCycleTab;
    onModeChangeRef.current = onModeChange;
    onNewTabRef.current = onNewTab;
    onStateChangeRef.current = onStateChange;
  }, [active, onClose, onCycleTab, onModeChange, onNewTab, onStateChange]);

  useEffect(() => {
    if (!bridge?.create) {
      setState((current) => ({
        ...current,
        error: "The integrated browser is available in the Taskurotta desktop app.",
        loading: false,
      }));
      return undefined;
    }
    let disposed = false;
    let createdId = "";
    const unsubscribeState = bridge.onState?.((nextState) => {
      if (nextState?.clientId !== clientId) return;
      if (disposed) return;
      if (!browserSessionEventMatches(sessionIdRef.current, nextState)) return;
      setState((current) => ({ ...current, ...nextState }));
      onStateChangeRef.current?.(nextState);
    });
    const unsubscribeCommand = bridge.onCommand?.((command) => {
      if (!activeRef.current || command?.clientId !== clientId) return;
      if (!browserSessionEventMatches(sessionIdRef.current, command)) return;
      if (command?.action === "focus-location") {
        addressRef.current?.focus();
        addressRef.current?.select();
      }
      if (command?.action === "close") onCloseRef.current?.();
      if (command?.action === "next-tab") onCycleTabRef.current?.(1);
      if (command?.action === "previous-tab") onCycleTabRef.current?.(-1);
      if (command?.action === "new-tab") onNewTabRef.current?.();
      if (command?.action === "edit-local-html") onModeChangeRef.current?.("edit");
    });
    bridge.create({
      clientId,
      openBrowserBinding: initialOpenBrowserBindingRef.current,
      path: localPath,
      url: localPath ? "" : initialUrlRef.current,
    })
      .then((nextState) => {
        if (disposed) {
          if (nextState?.id) void bridge.close(nextState.id).catch(() => {});
          return;
        }
        createdId = nextState?.id ?? "";
        sessionIdRef.current = createdId;
        setState((current) => ({ ...current, ...nextState }));
        onStateChangeRef.current?.(nextState);
        if (!localPath && initialUrlRef.current === "about:blank") {
          requestAnimationFrame(() => {
            addressRef.current?.focus();
            addressRef.current?.select();
          });
        }
      })
      .catch((error) => {
        if (disposed) return;
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "Could not open the browser",
          loading: false,
        }));
      });
    return () => {
      disposed = true;
      unsubscribeState?.();
      unsubscribeCommand?.();
      const id = sessionIdRef.current || createdId;
      sessionIdRef.current = "";
      if (id) void bridge.close(id).catch(() => {});
    };
  }, [bridge, clientId, localPath]);

  useEffect(() => {
    const id = sessionIdRef.current;
    if (!id || !bridge?.setPreferences) return;
    void bridge.setPreferences(id, { openBrowserBinding }).catch(() => {});
  }, [bridge, openBrowserBinding, state.id]);

  useEffect(() => {
    if (!active) return undefined;
    function handleBrowserChromeShortcut(event) {
      const action = browserChromeShortcutAction(event, bridge?.platform);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === "focus-location") {
        addressRef.current?.focus();
        addressRef.current?.select();
        return;
      }
      const id = sessionIdRef.current;
      if (!id || !bridge?.[action]) return;
      void bridge[action](id).catch(() => {});
    }
    window.addEventListener("keydown", handleBrowserChromeShortcut, true);
    return () => window.removeEventListener("keydown", handleBrowserChromeShortcut, true);
  }, [active, bridge]);

  useEffect(() => {
    if (!addressFocused) setAddressDraft(displayBrowserUrl(state.url));
  }, [addressFocused, state.url]);

  useEffect(() => {
    if (typeof document.querySelector !== "function") return undefined;
    const updateOcclusion = () => {
      setOccluded(browserElementIsOccluded(
        placeholderRef.current,
        document.querySelectorAll("[role='dialog'], [role='menu']"),
      ));
    };
    updateOcclusion();
    if (typeof MutationObserver === "undefined") return undefined;
    const observer = new MutationObserver(updateOcclusion);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", updateOcclusion);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateOcclusion);
    };
  }, []);

  useLayoutEffect(() => {
    const id = sessionIdRef.current;
    if (!bridge || !id) return undefined;
    const visible = active && !occluded && !state.error;
    void bridge.activate(id, visible).catch(() => {});
    if (!visible || !placeholderRef.current) return undefined;
    const updateBounds = () => {
      const bounds = placeholderRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
      void bridge.setBounds(id, {
        height: bounds.height,
        width: bounds.width,
        x: bounds.left,
        y: bounds.top,
      }).catch(() => {});
    };
    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    observer.observe(placeholderRef.current);
    window.addEventListener("resize", updateBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
      void bridge.activate(id, false).catch(() => {});
    };
  }, [active, bridge, occluded, state.error, state.id]);

  function run(action) {
    const id = sessionIdRef.current;
    if (!id || !bridge?.[action]) return;
    void bridge[action](id).catch(() => {});
  }

  function navigate(event) {
    event.preventDefault();
    const id = sessionIdRef.current;
    if (!id || !addressDraft.trim()) return;
    addressRef.current?.blur();
    setState((current) => ({ ...current, error: "" }));
    void bridge.navigate(id, browserAddress(addressDraft, searchUrl)).catch((error) => {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Could not open that address",
      }));
    });
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-white" aria-label="Integrated browser">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-slate-50 px-2">
        <BrowserButton
          disabled={!state.canGoBack}
          label="Back"
          onClick={() => run("back")}
        ><ArrowLeft size={14} /></BrowserButton>
        <BrowserButton
          disabled={!state.canGoForward}
          label="Forward"
          onClick={() => run("forward")}
        ><ArrowRight size={14} /></BrowserButton>
        <BrowserButton
          label={state.loading ? "Stop loading" : "Reload"}
          onClick={() => run(state.loading ? "stop" : "reload")}
        >{state.loading ? <X size={14} /> : <RefreshCw size={14} />}</BrowserButton>
        <form className="mx-1 flex min-w-0 flex-1" onSubmit={navigate}>
          <div className="relative min-w-0 flex-1">
            {state.loading ? (
              <Loader2 className="absolute left-2.5 top-1/2 -translate-y-1/2 animate-spin text-muted" size={12} />
            ) : null}
            <input
              ref={addressRef}
              aria-label="Browser address"
              className="h-7 w-full rounded-md border border-line bg-white pl-8 pr-3 text-xs text-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/10"
              spellCheck={false}
              value={addressDraft}
              onBlur={() => setAddressFocused(false)}
              onChange={(event) => setAddressDraft(event.target.value)}
              onFocus={(event) => {
                setAddressFocused(true);
                event.currentTarget.select();
              }}
            />
          </div>
        </form>
        <BrowserButton
          disabled={!/^https?:/i.test(state.url ?? "")}
          label="Open in default browser"
          onClick={() => run("openExternal")}
        ><ExternalLink size={14} /></BrowserButton>
        {showModeToggle ? (
          <>
            {showDiffButton ? (
              <BrowserButton label="Compare HTML with HEAD" onClick={onShowDiff}>
                <GitCompareArrows size={14} />
              </BrowserButton>
            ) : null}
            <HtmlModeToggle editing={editing} onModeChange={onModeChange} />
          </>
        ) : null}
      </div>
      <div ref={placeholderRef} className="relative min-h-0 flex-1 bg-white">
        {state.error ? (
          <div className="absolute inset-0 grid place-items-center px-8 text-center">
            <div>
              <p className="text-sm font-semibold text-ink">Could not display this page</p>
              <p className="mt-1 max-w-lg text-xs leading-5 text-muted">{state.error}</p>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function BrowserButton({ children, disabled = false, label, onClick }) {
  return (
    <button
      aria-label={label}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition hover:bg-slate-100 hover:text-ink disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent"
      disabled={disabled}
      title={label}
      type="button"
      onClick={onClick}
    >{children}</button>
  );
}

export function HtmlModeToggle({ editing, onModeChange }) {
  return (
    <div aria-label="HTML view mode" className="ml-1 flex items-center rounded-md border border-line bg-white p-0.5" role="group">
      <button
        aria-label="Browse HTML"
        aria-pressed={!editing}
        className={`h-6 rounded px-2 text-[10px] font-semibold transition ${
          !editing ? "bg-slate-100 text-ink" : "text-muted hover:text-ink"
        }`}
        title="Browse HTML"
        type="button"
        onClick={() => onModeChange?.("preview")}
      >Browse</button>
      <button
        aria-label="Edit HTML"
        aria-pressed={editing}
        className={`h-6 rounded px-2 text-[10px] font-semibold transition ${
          editing ? "bg-slate-100 text-ink" : "text-muted hover:text-ink"
        }`}
        title="Edit HTML"
        type="button"
        onClick={() => onModeChange?.("edit")}
      >Edit</button>
    </div>
  );
}

export function displayBrowserUrl(value) {
  return value === "about:blank" ? "" : String(value ?? "");
}

export function browserAddress(value, searchUrl) {
  const input = String(value ?? "").trim();
  if (!input || browserInputLooksLikeUrl(input)) return input;
  const template = String(searchUrl ?? "");
  if (!template.includes("{query}")) return input;
  return template.replace("{query}", encodeURIComponent(input));
}

function browserInputLooksLikeUrl(input) {
  return /^[a-z][a-z\d+.-]*:/i.test(input)
    || /^(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?(?:[/?#]|$)/i.test(input)
    || /^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(input);
}

export function browserChromeShortcutAction(event, platform = "") {
  if (event.repeat) return "";
  const key = String(event.key ?? "").toLowerCase();
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && key === "d") {
    return "focus-location";
  }
  const primary = platform === "darwin" ? event.metaKey : event.ctrlKey;
  if (primary && !event.altKey && !event.shiftKey && key === "r") return "reload";
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && key === "arrowleft") {
    return "back";
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && key === "arrowright") {
    return "forward";
  }
  return "";
}

export function browserElementIsOccluded(browserElement, overlayElements) {
  if (!browserElement?.getBoundingClientRect) return false;
  const browserBounds = browserElement.getBoundingClientRect();
  if (browserBounds.width <= 0 || browserBounds.height <= 0) return false;
  return Array.from(overlayElements ?? []).some((element) => {
    if (!element?.getBoundingClientRect || element.hidden) return false;
    if (element.getAttribute?.("aria-hidden") === "true") return false;
    const overlayBounds = element.getBoundingClientRect();
    return overlayBounds.width > 0
      && overlayBounds.height > 0
      && overlayBounds.left < browserBounds.right
      && overlayBounds.right > browserBounds.left
      && overlayBounds.top < browserBounds.bottom
      && overlayBounds.bottom > browserBounds.top;
  });
}

export function browserSessionEventMatches(sessionId, event) {
  return Boolean(sessionId && event?.id === sessionId);
}

export function isIntegratedBrowserShortcut(event) {
  if (event.repeat || !event.altKey || event.shiftKey) return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  return event.code === "Slash" || event.key === "/";
}
