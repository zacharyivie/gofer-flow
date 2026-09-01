import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as fitAddonPackage from "@xterm/addon-fit";
import * as xtermPackage from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  FolderPlus,
  FolderOpen,
  History,
  Pencil,
  Plus,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react";

import { RunTimelinePanel } from "./DagCanvas.jsx";
import {
  DEFAULT_APP_SETTINGS,
  formatKeybinding,
  matchesCommand,
  settingBinding,
} from "../lib/settings.js";

const { FitAddon } = fitAddonPackage;
const { Terminal: XTerm } = xtermPackage;

const PANEL_MIN_HEIGHT = 140;
const PANEL_MAX_HEIGHT = 480;

export default function UnifiedBottomPanel({
  diagnostics = [],
  onRevealDiagnostic,
  onSettingChange,
  projectRoot = "",
  settings = DEFAULT_APP_SETTINGS,
  theme = "light",
  timelineProps,
}) {
  const hasExplicitPanelSelectionRef = useRef(false);
  const [activeTab, setActiveTab] = useState("timeline");
  const [collapsed, setCollapsed] = useState(true);
  const [height, setHeight] = useState(settings.layout.bottomPanelHeight);
  const [terminalMounted, setTerminalMounted] = useState(false);

  const selectTab = useCallback((tab) => {
    hasExplicitPanelSelectionRef.current = true;
    setActiveTab(tab);
    setCollapsed(false);
    if (tab === "terminal") setTerminalMounted(true);
  }, []);

  const handleTabClick = useCallback((tab) => {
    if (tab === activeTab && !collapsed) {
      setCollapsed(true);
      return;
    }
    selectTab(tab);
  }, [activeTab, collapsed, selectTab]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (!matchesCommand(event, settings, "panel.toggle") || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      if (collapsed) {
        const targetTab = bottomPanelTabForShortcut(
          activeTab,
          hasExplicitPanelSelectionRef.current,
        );
        setActiveTab(targetTab);
        if (targetTab === "terminal") setTerminalMounted(true);
      }
      setCollapsed((current) => !current);
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeTab, collapsed, settings]);

  useEffect(() => {
    setHeight(settings.layout.bottomPanelHeight);
  }, [settings.layout.bottomPanelHeight]);

  function startResize(event) {
    if (collapsed) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    let nextHeight = startHeight;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    function handlePointerMove(moveEvent) {
      nextHeight = clamp(startHeight + startY - moveEvent.clientY, PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT);
      setHeight(nextHeight);
    }

    function handlePointerUp() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      onSettingChange?.("layout.bottomPanelHeight", nextHeight);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  function resizeWithKeyboard(event) {
    if (!["ArrowUp", "ArrowDown", "Home", "End", "Enter"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") {
      setHeight(PANEL_MIN_HEIGHT);
      onSettingChange?.("layout.bottomPanelHeight", PANEL_MIN_HEIGHT);
      return;
    }
    if (event.key === "End") {
      setHeight(PANEL_MAX_HEIGHT);
      onSettingChange?.("layout.bottomPanelHeight", PANEL_MAX_HEIGHT);
      return;
    }
    if (event.key === "Enter") {
      setHeight(DEFAULT_APP_SETTINGS.layout.bottomPanelHeight);
      onSettingChange?.("layout.bottomPanelHeight", DEFAULT_APP_SETTINGS.layout.bottomPanelHeight);
      return;
    }
    const step = event.shiftKey ? 40 : 10;
    const nextHeight = clamp(
      height + (event.key === "ArrowUp" ? step : -step),
      PANEL_MIN_HEIGHT,
      PANEL_MAX_HEIGHT,
    );
    setHeight(nextHeight);
    onSettingChange?.("layout.bottomPanelHeight", nextHeight);
  }

  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;

  return (
    <section
      aria-label="Bottom panel"
      className="relative z-30 shrink-0 overflow-hidden border-t border-line bg-white text-ink transition-[height] duration-150 ease-out"
      style={{ height: collapsed ? 36 : height }}
    >
      {!collapsed ? (
        <div
          aria-label="Resize bottom panel"
          aria-orientation="horizontal"
          aria-valuemax={PANEL_MAX_HEIGHT}
          aria-valuemin={PANEL_MIN_HEIGHT}
          aria-valuenow={height}
          className="absolute left-0 top-[-3px] z-30 h-1.5 w-full cursor-row-resize transition-colors hover:bg-brand/40"
          role="separator"
          tabIndex={0}
          title="Resize bottom panel"
          onKeyDown={resizeWithKeyboard}
          onPointerDown={startResize}
        />
      ) : null}

      <div
        aria-label="Bottom panel views"
        className="flex h-9 cursor-pointer items-stretch border-b border-line bg-[#f9fbfd]"
        role="tablist"
        title={`${collapsed ? "Expand" : "Collapse"} bottom panel`}
        onClick={(event) => {
          if (event.target.closest?.("button")) return;
          setCollapsed((current) => !current);
        }}
      >
        <PanelTab
          active={activeTab === "problems"}
          icon={AlertTriangle}
          label="Problems"
          onClick={() => handleTabClick("problems")}
        >
          {diagnostics.length ? (
            <span className={errorCount ? "text-red-700" : "text-amber-700"}>
              {diagnostics.length}
            </span>
          ) : null}
        </PanelTab>
        <PanelTab
          active={activeTab === "timeline"}
          icon={History}
          label="Run Timeline"
          onClick={() => handleTabClick("timeline")}
        />
        <PanelTab
          active={activeTab === "terminal"}
          icon={TerminalIcon}
          label="Terminal"
          onClick={() => handleTabClick("terminal")}
        />
        <div className="flex-1" />
        <button
          aria-label={collapsed ? "Expand bottom panel" : "Collapse bottom panel"}
          className="grid w-9 place-items-center text-muted transition hover:bg-slate-100 hover:text-ink"
          title={`${collapsed ? "Expand" : "Collapse"} bottom panel (${formatKeybinding(settingBinding(settings, "panel.toggle"))})`}
          type="button"
          onClick={() => setCollapsed((current) => !current)}
        >
          <ChevronDown className={`transition-transform ${collapsed ? "rotate-180" : ""}`} size={15} />
        </button>
      </div>

      <div className="h-[calc(100%-36px)] min-h-0">
        <div className={activeTab === "problems" ? "h-full" : "hidden"} role="tabpanel">
          <ProblemsPanel diagnostics={diagnostics} onRevealDiagnostic={onRevealDiagnostic} />
        </div>
        <div className={activeTab === "timeline" ? "h-full" : "hidden"} role="tabpanel">
          <RunTimelinePanel {...timelineProps} collapsed={false} embedded height={height - 36} />
        </div>
        {terminalMounted ? (
          <div className={activeTab === "terminal" ? "h-full" : "hidden"} role="tabpanel">
            <TerminalWorkspace
              active={!collapsed && activeTab === "terminal"}
              projectRoot={projectRoot}
              settings={settings}
              theme={theme}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function PanelTab({ active, children, icon: Icon, label, onClick }) {
  return (
    <button
      aria-selected={active}
      className={`relative flex h-9 items-center gap-1.5 px-3 text-[11px] font-semibold transition-colors ${active ? "bg-white text-ink" : "text-muted hover:bg-slate-50 hover:text-ink"}`}
      role="tab"
      type="button"
      onClick={onClick}
    >
      <Icon aria-hidden="true" size={13} />
      {label}
      {children}
      {active ? <span className="absolute inset-x-2 top-0 h-0.5 bg-brand" /> : null}
    </button>
  );
}

function ProblemsPanel({ diagnostics, onRevealDiagnostic }) {
  if (!diagnostics.length) {
    return (
      <div className="grid h-full place-items-center px-6 text-xs text-muted">
        No problems in workflow.rad.
      </div>
    );
  }

  return (
    <div className="workflow-scrollbar h-full overflow-y-auto py-1">
      {diagnostics.map((diagnostic, index) => {
        const warning = diagnostic.severity === "warning";
        const Icon = warning ? AlertTriangle : AlertCircle;
        const line = diagnostic.span?.start?.line ?? 1;
        return (
          <button
            key={`${diagnostic.code}-${diagnostic.span?.start?.offset ?? 0}-${index}`}
            className="flex w-full items-start gap-2 px-3 py-2 text-left text-[11px] leading-4 transition hover:bg-slate-50"
            type="button"
            onClick={() => onRevealDiagnostic?.(diagnostic)}
          >
            <Icon aria-hidden="true" className={`mt-0.5 shrink-0 ${warning ? "text-amber-600" : "text-red-600"}`} size={13} />
            <span className="min-w-0 flex-1 text-ink">
              {diagnostic.message}
              {diagnostic.code ? <span className="ml-2 font-mono text-[10px] text-muted">{diagnostic.code}</span> : null}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-muted">workflow.rad:{line}</span>
          </button>
        );
      })}
    </div>
  );
}

function TerminalWorkspace({ active, projectRoot, settings, theme }) {
  const nextTabRef = useRef(1);
  const nextGroupRef = useRef(1);
  const initialTerminalCreatedRef = useRef(false);
  const layoutElementsRef = useRef(new Map());
  const layoutRectsRef = useRef(new Map());
  const menuRef = useRef(null);
  const groupRenameCanceledRef = useRef(false);
  const groupRenameInputRef = useRef(null);
  const renameCanceledRef = useRef(false);
  const renameInputRef = useRef(null);
  const [tabs, setTabs] = useState([]);
  const [activeKey, setActiveKey] = useState(null);
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const [draggedKey, setDraggedKey] = useState(null);
  const [dragOverGroupId, setDragOverGroupId] = useState(null);
  const [groupDefinitions, setGroupDefinitions] = useState([]);
  const [groupMenu, setGroupMenu] = useState(null);
  const [groupRenameDraft, setGroupRenameDraft] = useState("");
  const [renamingGroupId, setRenamingGroupId] = useState(null);
  const [tabMenu, setTabMenu] = useState(null);
  const [renamingKey, setRenamingKey] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");

  const applyShellLabel = useCallback((key, label) => {
    setTabs((current) => current.map((item) => (
      item.key === key && !item.customName
        ? { ...item, label: `${label} ${item.number}` }
        : item
    )));
  }, []);

  const applyWorkingDirectory = useCallback((key, currentDirectory) => {
    setTabs((current) => current.map((item) => (
      item.key === key
        ? {
            ...item,
            currentDirectory,
            folderName: projectFolderName(currentDirectory),
          }
        : item
    )));
  }, []);

  const addTerminal = useCallback((targetProjectPath = projectRoot, targetGroupId = null) => {
    const number = nextTabRef.current;
    nextTabRef.current += 1;
    const key = `terminal-${number}-${Date.now()}`;
    const groupId = targetGroupId || terminalProjectGroupId(targetProjectPath);
    setTabs((current) => [
      ...current,
      {
        customName: false,
        cwd: targetProjectPath,
        folderName: projectFolderName(targetProjectPath),
        key,
        label: `Terminal ${number}`,
        number,
        groupId,
        projectPath: targetProjectPath,
      },
    ]);
    setGroupDefinitions((current) => current.map((group) => (
      group.id === groupId ? { ...group, keepEmpty: false } : group
    )));
    setActiveKey(key);
    setCollapsedGroups((current) => {
      return current[groupId] ? { ...current, [groupId]: false } : current;
    });
  }, [projectRoot]);

  const terminalGroups = groupTerminalTabsByProject(tabs, groupDefinitions);

  useLayoutEffect(() => {
    const nextRects = new Map();
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    for (const [key, element] of layoutElementsRef.current) {
      if (!element?.isConnected) continue;
      const nextRect = element.getBoundingClientRect();
      const previousRect = layoutRectsRef.current.get(key);
      nextRects.set(key, nextRect);
      if (reduceMotion || !previousRect || typeof element.animate !== "function") continue;
      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;
      element.animate(
        [
          { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
          { transform: "translate3d(0, 0, 0)" },
        ],
        { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
      );
    }
    layoutRectsRef.current = nextRects;
  }, [collapsedGroups, groupDefinitions, tabs]);

  useEffect(() => {
    if (!shouldCreateInitialTerminal(active, tabs.length, initialTerminalCreatedRef.current)) return;
    initialTerminalCreatedRef.current = true;
    addTerminal();
  }, [active, addTerminal, tabs.length]);

  useEffect(() => {
    if (!tabMenu && !groupMenu) return undefined;
    function dismissMenu(event) {
      if (menuRef.current?.contains(event.target)) return;
      setGroupMenu(null);
      setTabMenu(null);
    }
    function dismissWithEscape(event) {
      if (event.key !== "Escape") return;
      setGroupMenu(null);
      setTabMenu(null);
    }
    window.addEventListener("pointerdown", dismissMenu);
    window.addEventListener("keydown", dismissWithEscape);
    return () => {
      window.removeEventListener("pointerdown", dismissMenu);
      window.removeEventListener("keydown", dismissWithEscape);
    };
  }, [groupMenu, tabMenu]);

  useEffect(() => {
    if (!renamingKey) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingKey]);

  useEffect(() => {
    if (!renamingGroupId) return;
    groupRenameInputRef.current?.focus();
    groupRenameInputRef.current?.select();
  }, [renamingGroupId]);

  function closeTab(key) {
    const index = tabs.findIndex((tab) => tab.key === key);
    const remaining = tabs.filter((tab) => tab.key !== key);
    setTabs(remaining);
    if (activeKey === key) {
      setActiveKey(remaining[Math.min(index, remaining.length - 1)]?.key ?? null);
    }
    setGroupMenu(null);
    setTabMenu(null);
    setRenamingKey((current) => (current === key ? null : current));
  }

  function registerLayoutElement(key, element) {
    if (element) {
      layoutElementsRef.current.set(key, element);
    } else {
      layoutElementsRef.current.delete(key);
    }
  }

  function addGroup() {
    const number = nextGroupRef.current;
    nextGroupRef.current += 1;
    const id = `custom-group-${number}-${Date.now()}`;
    setGroupDefinitions((current) => [
      ...current,
      {
        id,
        keepEmpty: true,
        name: terminalGroupName(number),
        projectPath: projectRoot,
      },
    ]);
    setCollapsedGroups((current) => ({ ...current, [id]: false }));
    setGroupMenu(null);
  }

  function beginGroupRename(group) {
    groupRenameCanceledRef.current = false;
    setGroupRenameDraft(group.name);
    setRenamingGroupId(group.id);
    setGroupMenu(null);
  }

  function commitGroupRename(group) {
    if (groupRenameCanceledRef.current) {
      groupRenameCanceledRef.current = false;
      setRenamingGroupId(null);
      return;
    }
    const name = groupRenameDraft.trim();
    if (name) {
      setGroupDefinitions((current) => upsertTerminalGroupDefinition(current, {
        id: group.id,
        keepEmpty: group.items.length === 0,
        name,
        projectPath: group.projectPath,
      }));
    }
    setRenamingGroupId(null);
  }

  function removeGroup(groupId) {
    const remaining = terminalTabsAfterDeletingGroup(tabs, groupId);
    setTabs(remaining);
    if (!remaining.some((tab) => tab.key === activeKey)) {
      setActiveKey(remaining[0]?.key ?? null);
    }
    setGroupDefinitions((current) => current.filter((group) => group.id !== groupId));
    setCollapsedGroups((current) => {
      const next = { ...current };
      delete next[groupId];
      return next;
    });
    setGroupMenu(null);
    setRenamingGroupId((current) => (current === groupId ? null : current));
  }

  function moveTerminalToGroup(key, targetGroupId) {
    setTabs((current) => moveTerminalTabToGroup(current, key, targetGroupId));
    setGroupDefinitions((current) => current.map((group) => (
      group.id === targetGroupId ? { ...group, keepEmpty: false } : group
    )));
    setCollapsedGroups((current) => ({ ...current, [targetGroupId]: false }));
    setDraggedKey(null);
    setDragOverGroupId(null);
  }

  function openTabMenu(event, key) {
    event.preventDefault();
    event.stopPropagation();
    setActiveKey(key);
    setGroupMenu(null);
    setTabMenu({
      key,
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - 176)),
      top: Math.max(8, Math.min(event.clientY, window.innerHeight - 84)),
    });
  }

  function openGroupMenu(event, group) {
    event.preventDefault();
    event.stopPropagation();
    setTabMenu(null);
    setGroupMenu({
      id: group.id,
      itemCount: group.items.length,
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - 176)),
      name: group.name,
      projectPath: group.projectPath,
      top: Math.max(8, Math.min(event.clientY, window.innerHeight - 160)),
    });
  }

  function openTerminalListMenu(event) {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    setTabMenu(null);
    setGroupMenu({
      id: null,
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - 176)),
      name: "Terminals",
      projectPath: projectRoot,
      top: Math.max(8, Math.min(event.clientY, window.innerHeight - 56)),
    });
  }

  function beginRename(key) {
    const tab = tabs.find((item) => item.key === key);
    if (!tab) return;
    renameCanceledRef.current = false;
    setRenameDraft(tab.label);
    setRenamingKey(key);
    setTabMenu(null);
  }

  function commitRename(key) {
    if (renameCanceledRef.current) {
      renameCanceledRef.current = false;
      setRenamingKey(null);
      return;
    }
    const label = renameDraft.trim();
    setTabs((current) => current.map((tab) => (
      tab.key === key && label ? { ...tab, customName: true, label } : tab
    )));
    setRenamingKey(null);
  }

  function handleWorkspaceKeyDown(event) {
    const action = terminalWorkspaceShortcutAction(event, {
      active,
      activeKey,
      renaming: event.target?.classList?.contains("terminal-rename-input"),
      settings,
    });
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === "new") {
      addTerminal();
      return;
    }
    closeTab(activeKey);
  }

  return (
    <div className="flex h-full min-h-0 bg-white" onKeyDownCapture={handleWorkspaceKeyDown}>
      <div className="relative min-h-0 min-w-0 flex-1">
        {tabs.map((tab) => (
          <TerminalSession
            key={tab.key}
            active={active && activeKey === tab.key}
            projectRoot={tab.cwd}
            settings={settings}
            tabKey={tab.key}
            theme={theme}
            onCwdChange={applyWorkingDirectory}
            onLabelChange={applyShellLabel}
          />
        ))}
        {!tabs.length ? (
          <div className="grid h-full place-items-center">
            <button className="inline-flex h-8 items-center gap-2 rounded-md border border-line px-3 text-xs font-semibold text-ink hover:bg-slate-50" type="button" onClick={() => addTerminal()}>
              <Plus size={13} />New terminal
            </button>
          </div>
        ) : null}
      </div>

      <aside aria-label="Terminal tabs" className="flex w-52 shrink-0 flex-col border-l border-line bg-slate-50">
        <div className="flex h-8 shrink-0 items-center border-b border-line px-2">
          <span className="min-w-0 flex-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
            Terminals
          </span>
          <button
            aria-label="New terminal"
            className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted transition hover:bg-slate-200/70 hover:text-ink"
            title="New terminal (Ctrl+T)"
            type="button"
            onClick={() => addTerminal()}
          >
            <Plus size={13} />
          </button>
        </div>
        <div
          className="workflow-scrollbar min-h-0 flex-1 overflow-y-auto py-1"
          onContextMenu={openTerminalListMenu}
        >
          {terminalGroups.map((group) => {
            const collapsed = Boolean(collapsedGroups[group.id]);
            return (
              <section
                ref={(element) => registerLayoutElement(`group:${group.id}`, element)}
                key={group.id}
                aria-label={`${group.name} terminals`}
                className={`mb-1 rounded transition-[background-color,box-shadow] duration-150 ${dragOverGroupId === group.id ? "bg-indigo-100/70 shadow-[inset_0_0_0_1px_rgb(99_102_241/0.45)] dark:bg-indigo-950/40" : ""}`}
                onDragEnter={() => {
                  if (!draggedKey || terminalTabGroupId(tabs.find((tab) => tab.key === draggedKey)) === group.id) return;
                  setDragOverGroupId(group.id);
                  if (collapsed) setCollapsedGroups((current) => ({ ...current, [group.id]: false }));
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setDragOverGroupId(null);
                }}
                onDragOver={(event) => {
                  if (!draggedKey || terminalTabGroupId(tabs.find((tab) => tab.key === draggedKey)) === group.id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const key = draggedKey || event.dataTransfer.getData("text/taskurotta-terminal");
                  if (key) moveTerminalToGroup(key, group.id);
                }}
              >
                <div
                  className="group/project flex h-7 items-center rounded px-1.5 transition hover:bg-slate-100"
                  title={`${group.name}\n${group.projectPath}\nRight-click for group actions`}
                  onContextMenu={(event) => openGroupMenu(event, group)}
                >
                  {renamingGroupId === group.id ? (
                    <input
                      ref={groupRenameInputRef}
                      aria-label={`Rename ${group.name} terminal group`}
                      className="terminal-rename-input mx-0.5 h-5 min-w-0 flex-1 rounded border border-brand bg-white px-1.5 text-[10px] font-semibold text-ink outline-none ring-1 ring-brand/20"
                      value={groupRenameDraft}
                      onBlur={() => commitGroupRename(group)}
                      onChange={(event) => setGroupRenameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") {
                          groupRenameCanceledRef.current = true;
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  ) : (
                    <button
                      aria-expanded={!collapsed}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[10px] font-semibold text-ink"
                      type="button"
                      onClick={() => setCollapsedGroups((current) => ({
                        ...current,
                        [group.id]: !current[group.id],
                      }))}
                    >
                      <ChevronDown
                        aria-hidden="true"
                        className={`shrink-0 text-muted transition ${collapsed ? "-rotate-90" : ""}`}
                        size={11}
                      />
                      <FolderOpen aria-hidden="true" className="shrink-0 text-muted" size={11} />
                      <span className="min-w-0 flex-1 truncate">{group.name}</span>
                    </button>
                  )}
                  <span className="text-[9px] font-medium text-muted">{group.items.length}</span>
                </div>
                {!collapsed ? (
                  <div className="ml-3 border-l border-line py-0.5 pl-1">
                    {group.items.map((tab) => (
                      <div
                        ref={(element) => registerLayoutElement(`tab:${tab.key}`, element)}
                        key={tab.key}
                        aria-grabbed={draggedKey === tab.key}
                        className={`group flex h-7 min-w-0 items-center rounded transition-[opacity,background-color,color,box-shadow] duration-150 ${draggedKey === tab.key ? "opacity-40" : "opacity-100"} ${activeKey === tab.key ? "bg-indigo-50 text-indigo-700" : "text-muted hover:bg-slate-100 hover:text-ink"}`}
                        draggable={renamingKey !== tab.key}
                        onDragEnd={() => {
                          setDraggedKey(null);
                          setDragOverGroupId(null);
                        }}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/taskurotta-terminal", tab.key);
                          setDraggedKey(tab.key);
                          setActiveKey(tab.key);
                        }}
                        onContextMenu={(event) => openTabMenu(event, tab.key)}
                      >
                        {renamingKey === tab.key ? (
                          <input
                            ref={renameInputRef}
                            aria-label={`Rename ${tab.label}`}
                            className="terminal-rename-input mx-1.5 h-5 min-w-0 flex-1 rounded border border-brand bg-white px-1.5 text-[11px] text-ink outline-none ring-1 ring-brand/20"
                            value={renameDraft}
                            onBlur={() => commitRename(tab.key)}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") event.currentTarget.blur();
                              if (event.key === "Escape") {
                                renameCanceledRef.current = true;
                                event.currentTarget.blur();
                              }
                            }}
                          />
                        ) : (
                          <button
                            className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-[11px] font-medium"
                            title={`${tab.label} — ${tab.folderName}`}
                            type="button"
                            onClick={() => setActiveKey(tab.key)}
                            onDoubleClick={() => beginRename(tab.key)}
                          >
                            <TerminalIcon aria-hidden="true" className="shrink-0" size={11} />
                            <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                            <span className="max-w-[4rem] shrink truncate text-[9px] font-normal text-muted">
                              {tab.folderName}
                            </span>
                          </button>
                        )}
                        <button
                          aria-label={`Close ${tab.label}`}
                          className="mr-1 grid h-5 w-5 shrink-0 place-items-center rounded text-muted opacity-0 transition hover:bg-slate-200 hover:text-ink focus:opacity-100 group-hover:opacity-100"
                          title="Close terminal (Ctrl+W)"
                          type="button"
                          onClick={() => closeTab(tab.key)}
                        >
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      </aside>

      {groupMenu ? (
        <div
          ref={menuRef}
          aria-label={`${groupMenu.name} terminal group actions`}
          className="fixed z-[100] w-44 rounded-md border border-line bg-white p-1 text-[11px] text-ink shadow-lg"
          role="menu"
          style={{ left: groupMenu.left, top: groupMenu.top }}
        >
          {groupMenu.id ? (
            <>
              <button
                className="flex h-7 w-full items-center gap-2 rounded px-2 text-left hover:bg-slate-100"
                role="menuitem"
                type="button"
                onClick={() => {
                  addTerminal(groupMenu.projectPath, groupMenu.id);
                  setGroupMenu(null);
                }}
              >
                <Plus size={12} />New terminal
              </button>
              <button
                className="flex h-7 w-full items-center gap-2 rounded px-2 text-left hover:bg-slate-100"
                role="menuitem"
                type="button"
                onClick={() => beginGroupRename(groupMenu)}
              >
                <Pencil size={12} />Rename group
              </button>
            </>
          ) : null}
          <button
            className="flex h-7 w-full items-center gap-2 rounded px-2 text-left hover:bg-slate-100"
            role="menuitem"
            type="button"
            onClick={addGroup}
          >
            <FolderPlus size={12} />Add new group
          </button>
          {groupMenu.id ? (
            <>
              <div className="my-1 border-t border-line" role="separator" />
              <button
                className="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-red-700 hover:bg-red-50 dark:text-red-300"
                role="menuitem"
                type="button"
                onClick={() => removeGroup(groupMenu.id)}
              >
                <Trash2 size={12} />
                {groupMenu.itemCount ? "Delete group and terminals" : "Delete group"}
              </button>
              <p className="truncate px-2 pb-1 pt-1 font-mono text-[9px] text-muted" title={groupMenu.projectPath}>
                {groupMenu.projectPath}
              </p>
            </>
          ) : null}
        </div>
      ) : null}

      {tabMenu ? (
        <div
          ref={menuRef}
          className="fixed z-[100] w-40 rounded-md border border-line bg-white p-1 text-[11px] text-ink shadow-lg"
          role="menu"
          style={{ left: tabMenu.left, top: tabMenu.top }}
        >
          <button className="flex h-7 w-full items-center rounded px-2 text-left hover:bg-slate-100" role="menuitem" type="button" onClick={() => beginRename(tabMenu.key)}>
            Rename terminal
          </button>
          <button className="flex h-7 w-full items-center rounded px-2 text-left hover:bg-slate-100" role="menuitem" type="button" onClick={() => closeTab(tabMenu.key)}>
            Close terminal
          </button>
        </div>
      ) : null}
    </div>
  );
}

function TerminalSession({ active, onCwdChange, onLabelChange, projectRoot, settings, tabKey, theme }) {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const fitAddonRef = useRef(null);
  const sessionIdRef = useRef("");
  const activeRef = useRef(active);
  const initialThemeRef = useRef(theme);
  const initialSettingsRef = useRef(settings.terminal);

  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    window.requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      terminalRef.current?.focus();
    });
  }, [active]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = terminalTheme(theme);
  }, [theme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.cursorBlink = settings.terminal.cursorBlink;
    terminal.options.fontSize = settings.terminal.fontSize;
    terminal.options.lineHeight = settings.terminal.lineHeight;
    terminal.options.scrollback = settings.terminal.scrollback;
    fitAddonRef.current?.fit();
  }, [settings.terminal]);

  useEffect(() => {
    const bridge = window.goferTerminal;
    const container = containerRef.current;
    if (!container) return undefined;

    const terminalSettings = initialSettingsRef.current;
    const terminal = new XTerm({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: terminalSettings.cursorBlink,
      cursorStyle: "block",
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: terminalSettings.fontSize,
      lineHeight: terminalSettings.lineHeight,
      scrollback: terminalSettings.scrollback,
      theme: terminalTheme(initialThemeRef.current),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    fitAddon.fit();
    const cwdDisposable = terminal.parser.registerOscHandler(633, (data) => {
      const currentDirectory = terminalDirectoryFromOsc(data);
      if (!currentDirectory) return false;
      onCwdChange?.(tabKey, currentDirectory);
      return true;
    });

    if (!bridge) {
      terminal.writeln("\x1b[33mThe terminal is available in the Taskurotta desktop app.\x1b[0m");
      terminal.options.disableStdin = true;
      return () => {
        cwdDisposable.dispose();
        terminal.dispose();
      };
    }

    const unsubscribeData = bridge.onData((payload) => {
      if (payload?.id === sessionIdRef.current) terminal.write(payload.data ?? "");
    });
    const unsubscribeExit = bridge.onExit((payload) => {
      if (payload?.id !== sessionIdRef.current) return;
      terminal.writeln(`\r\n\x1b[90mProcess exited with code ${payload.exitCode ?? 0}.\x1b[0m`);
      terminal.options.disableStdin = true;
    });
    const inputDisposable = terminal.onData((data) => {
      if (sessionIdRef.current) void bridge.write(sessionIdRef.current, data).catch(() => {});
    });
    terminal.attachCustomKeyEventHandler((event) => {
      const clipboardAction = terminalClipboardShortcutAction(event);
      if (clipboardAction === "copy") {
        void copyTerminalSelection(terminal).catch(() => {});
        return false;
      }
      if (clipboardAction === "paste") {
        void pasteIntoTerminal(bridge, sessionIdRef.current).catch(() => {});
        return false;
      }
      if (
        event.type !== "keydown"
        || !event.ctrlKey
        || event.metaKey
        || event.altKey
        || event.shiftKey
        || event.key.toLowerCase() !== "c"
        || terminal.hasSelection()
        || !sessionIdRef.current
      ) {
        return true;
      }
      void bridge.write(sessionIdRef.current, "\x03").catch(() => {});
      return false;
    });
    const resizeObserver = new ResizeObserver(() => {
      if (!activeRef.current || !container.offsetWidth || !container.offsetHeight) return;
      fitAddon.fit();
      if (sessionIdRef.current) {
        void bridge.resize(sessionIdRef.current, terminal.cols, terminal.rows).catch(() => {});
      }
    });
    resizeObserver.observe(container);

    const sessionLifecycle = createDisposableTerminalSession(bridge, {
      cols: terminal.cols,
      cwd: projectRoot,
      rows: terminal.rows,
    }, {
      onError(error) {
        terminal.writeln(`\x1b[31mCould not start the terminal. ${error instanceof Error ? error.message : String(error)}\x1b[0m`);
        terminal.options.disableStdin = true;
      },
      onReady(session) {
        sessionIdRef.current = session.id;
        onLabelChange?.(tabKey, session.shell);
        onCwdChange?.(tabKey, session.cwd);
        fitAddon.fit();
        void bridge.resize(session.id, terminal.cols, terminal.rows).catch(() => {});
      },
    });

    return () => {
      sessionIdRef.current = "";
      resizeObserver.disconnect();
      inputDisposable.dispose();
      unsubscribeData();
      unsubscribeExit();
      cwdDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      sessionLifecycle.dispose();
    };
  }, [onCwdChange, onLabelChange, projectRoot, tabKey]);

  return (
    <div
      ref={containerRef}
      className={`terminal-host absolute inset-0 px-2 py-1 ${active ? "" : "invisible"}`}
      onPointerDown={() => terminalRef.current?.focus()}
    />
  );
}

function terminalTheme(theme) {
  if (theme === "dark") {
    return {
      background: "#18181a",
      black: "#27272a",
      blue: "#818cf8",
      brightBlack: "#71717a",
      brightBlue: "#a5b4fc",
      brightCyan: "#67e8f9",
      brightGreen: "#86efac",
      brightMagenta: "#d8b4fe",
      brightRed: "#fca5a5",
      brightWhite: "#fafafa",
      brightYellow: "#fde68a",
      cursor: "#a5b4fc",
      cyan: "#22d3ee",
      foreground: "#d4d4d8",
      green: "#4ade80",
      magenta: "#c084fc",
      red: "#f87171",
      selectionBackground: "#4338ca88",
      white: "#e4e4e7",
      yellow: "#facc15",
    };
  }
  return {
    background: "#fbfbfc",
    black: "#27272a",
    blue: "#4f46e5",
    brightBlack: "#71717a",
    brightBlue: "#4338ca",
    brightCyan: "#0e7490",
    brightGreen: "#15803d",
    brightMagenta: "#7c3aed",
    brightRed: "#b91c1c",
    brightWhite: "#18181b",
    brightYellow: "#a16207",
    cursor: "#4f46e5",
    cyan: "#0891b2",
    foreground: "#27272a",
    green: "#16a34a",
    magenta: "#9333ea",
    red: "#dc2626",
    selectionBackground: "#c7d2fe",
    white: "#d4d4d8",
    yellow: "#ca8a04",
  };
}

function projectFolderName(projectRoot) {
  const normalized = String(projectRoot ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) || normalized || "Unregistered";
}

export function terminalDirectoryFromOsc(data) {
  const prefix = "P;Cwd=";
  if (typeof data !== "string" || !data.startsWith(prefix)) return "";
  const currentDirectory = data.slice(prefix.length);
  const containsControlCharacter = [...currentDirectory]
    .some((character) => character.charCodeAt(0) < 32);
  return currentDirectory && !containsControlCharacter ? currentDirectory : "";
}

function terminalProjectGroupId(projectPath) {
  return `project:${projectPath || "Unregistered"}`;
}

export function terminalGroupName(number) {
  return `Group ${number}`;
}

export function terminalTabGroupId(tab) {
  const projectPath = tab?.projectPath ?? tab?.cwd ?? "";
  return tab?.groupId || terminalProjectGroupId(projectPath);
}

export function moveTerminalTabToGroup(tabs = [], key, groupId) {
  let changed = false;
  const next = (tabs ?? []).map((tab) => {
    if (tab.key !== key || terminalTabGroupId(tab) === groupId) return tab;
    changed = true;
    return { ...tab, groupId };
  });
  return changed ? next : tabs;
}

export function terminalTabsAfterDeletingGroup(tabs = [], groupId) {
  return (tabs ?? []).filter((tab) => terminalTabGroupId(tab) !== groupId);
}

export function upsertTerminalGroupDefinition(groups = [], definition) {
  const index = groups.findIndex((group) => group.id === definition.id);
  if (index < 0) return [...groups, definition];
  return groups.map((group) => (group.id === definition.id ? { ...group, ...definition } : group));
}

export function groupTerminalTabsByProject(tabs = [], definitions = []) {
  const groups = new Map();
  const definitionsById = new Map((definitions ?? []).map((group) => [group.id, group]));
  for (const definition of definitions ?? []) {
    if (!definition.keepEmpty) continue;
    groups.set(definition.id, {
      id: definition.id,
      items: [],
      name: definition.name,
      projectPath: definition.projectPath ?? "",
    });
  }
  for (const tab of tabs ?? []) {
    const projectPath = tab.projectPath ?? tab.cwd ?? "";
    const id = terminalTabGroupId(tab);
    const definition = definitionsById.get(id);
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        items: [],
        name: definition?.name || projectFolderName(projectPath),
        projectPath: definition?.projectPath ?? projectPath,
      });
    }
    groups.get(id).items.push(tab);
  }
  return [...groups.values()].sort((left, right) => (
    left.name.localeCompare(right.name) || left.projectPath.localeCompare(right.projectPath)
  ));
}

export function shouldCreateInitialTerminal(active, tabCount, alreadyCreated) {
  return active && tabCount === 0 && !alreadyCreated;
}

export function terminalClipboardShortcutAction(event) {
  if (
    event.type !== "keydown"
    || !event.ctrlKey
    || !event.shiftKey
    || event.metaKey
    || event.altKey
  ) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (key === "c") return "copy";
  if (key === "v") return "paste";
  return null;
}

export async function copyTerminalSelection(
  terminal,
  clipboard = globalThis.navigator?.clipboard,
) {
  const selection = terminal.getSelection();
  if (!selection || typeof clipboard?.writeText !== "function") return false;
  await clipboard.writeText(selection);
  return true;
}

export async function pasteIntoTerminal(
  bridge,
  sessionId,
  clipboard = globalThis.navigator?.clipboard,
) {
  if (!sessionId || typeof clipboard?.readText !== "function") return false;
  const text = await clipboard.readText();
  if (!text) return false;
  await bridge.write(sessionId, text);
  return true;
}

export function isBottomPanelShortcut(event) {
  const backquoteKey = event.code === "Backquote" || event.key === "`";
  return backquoteKey && (event.ctrlKey || event.metaKey) && !event.altKey;
}

export function bottomPanelTabForShortcut(activeTab, hasExplicitPanelSelection) {
  return hasExplicitPanelSelection ? activeTab : "terminal";
}

export function createDisposableTerminalSession(bridge, options, callbacks = {}) {
  let disposed = false;
  let sessionId = "";

  const closeSilently = (id) => Promise.resolve()
    .then(() => bridge.close(id))
    .catch(() => {});

  const settled = Promise.resolve().then(() => (
    disposed ? null : bridge.create(options)
  )).then(async (session) => {
    if (!session) return null;
    if (disposed) {
      await closeSilently(session.id);
      return null;
    }
    sessionId = session.id;
    callbacks.onReady?.(session);
    return session;
  }).catch((error) => {
    if (!disposed) callbacks.onError?.(error);
    return null;
  });

  return {
    dispose() {
      disposed = true;
      const activeSessionId = sessionId;
      sessionId = "";
      if (activeSessionId) void closeSilently(activeSessionId);
    },
    settled,
  };
}

export function terminalWorkspaceShortcutAction(event, options = {}) {
  if (!options.active || options.renaming || event.repeat) return null;
  if (matchesCommand(event, options.settings, "terminal.new")) return "new";
  if (matchesCommand(event, options.settings, "terminal.close") && options.activeKey) return "close";
  return null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
