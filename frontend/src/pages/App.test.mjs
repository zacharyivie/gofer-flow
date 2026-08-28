import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import vm from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const frontendRoot = path.resolve(import.meta.dirname, "../..");
const repoRoot = path.resolve(frontendRoot, "..");
const require = createRequire(import.meta.url);

let viteServer;
let apiUrl;
let appModule;
let canvasModule;
let codeWorkspaceModule;
let dialogModule;
let radishEditorModule;
let radishRangesModule;

before(async () => {
  viteServer = await createServer({
    appType: "custom",
    customLogger: {
      clearScreen() {},
      error() {},
      hasErrorLogged() {
        return false;
      },
      info() {},
      warn() {},
    },
    root: frontendRoot,
    server: { hmr: false, middlewareMode: true, watch: null },
  });
  ({ apiUrl } = await viteServer.ssrLoadModule("/src/lib/api.js"));
  appModule = await viteServer.ssrLoadModule("/src/pages/App.jsx");
  canvasModule = await viteServer.ssrLoadModule("/src/components/DagCanvas.jsx");
  codeWorkspaceModule = await viteServer.ssrLoadModule("/src/components/CodeWorkspace.jsx");
  dialogModule = await viteServer.ssrLoadModule("/src/components/Dialog.jsx");
  radishEditorModule = await viteServer.ssrLoadModule("/src/components/RadishEditor.jsx");
  radishRangesModule = await viteServer.ssrLoadModule("/src/lib/radishRanges.js");
});

after(async () => {
  await viteServer?.close();
});

beforeEach(() => {
  globalThis.window = {
    goferApiBaseUrl: undefined,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  };
});

test("apiUrl normalizes relative paths, HTTP origins, trailing slashes, and prefixed bases", () => {
  globalThis.window.goferApiBaseUrl = undefined;
  assert.equal(apiUrl("workflows"), "/api/workflows");
  assert.equal(apiUrl("/workflows"), "/api/workflows");

  globalThis.window.goferApiBaseUrl = "http://127.0.0.1:8765";
  assert.equal(apiUrl("/workflows"), "http://127.0.0.1:8765/api/workflows");

  globalThis.window.goferApiBaseUrl = "https://localhost:9443/";
  assert.equal(apiUrl("chat/providers"), "https://localhost:9443/api/chat/providers");

  globalThis.window.goferApiBaseUrl = "http://127.0.0.1:8765/api/";
  assert.equal(apiUrl("/workflows/demo/run"), "http://127.0.0.1:8765/api/workflows/demo/run");

  globalThis.window.goferApiBaseUrl = "/custom-api/";
  assert.equal(apiUrl("/workflows"), "/custom-api/workflows");
});

test("shared dialogs trap focus, close with Escape, and restore focus to the opener", async () => {
  function DialogHarness() {
    const [open, setOpen] = React.useState(false);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "button",
        { "aria-label": "Open test dialog", type: "button", onClick: () => setOpen(true) },
        "Open",
      ),
      open
        ? React.createElement(
            dialogModule.Dialog,
            {
              description: "Dialog focus behavior",
              onClose: () => setOpen(false),
              title: "Test dialog",
            },
            React.createElement(
              "button",
              { "aria-label": "First dialog action", type: "button" },
              "First",
            ),
            React.createElement(
              "button",
              { "aria-label": "Last dialog action", type: "button" },
              "Last",
            ),
          )
        : null,
    );
  }

  const dom = await mountReact(
    React.createElement(DialogHarness),
    createFetchMock([]),
  );
  const opener = dom.byLabel("Open test dialog");
  await dom.focus(opener);
  await dom.click(opener);

  const dialog = allElements(dom.container).find(
    (element) => element.getAttribute?.("role") === "dialog",
  );
  assert.ok(dialog);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.ok(dialog.getAttribute("aria-labelledby"));
  assert.ok(dialog.getAttribute("aria-describedby"));

  const first = dom.byLabel("First dialog action");
  const last = dom.byLabel("Last dialog action");
  assert.equal(document.activeElement, first);

  await dom.focus(last);
  await dom.dispatchWindow("keydown", { key: "Tab" });
  assert.equal(document.activeElement, first);

  await dom.focus(first);
  await dom.dispatchWindow("keydown", { key: "Tab", shiftKey: true });
  assert.equal(document.activeElement, last);

  await dom.dispatchWindow("keydown", { key: "Escape" });
  assert.equal(document.activeElement, opener);
  assert.equal(
    allElements(dom.container).some((element) => element.getAttribute?.("role") === "dialog"),
    false,
  );

  await dom.unmount();
});

test("every migrated dialog family uses the shared keyboard and focus contract", async (context) => {
  const approval = {
    workflowId: "demo",
    runId: "run-1",
    nodeId: "approve",
    message: "Approve deployment?",
    status: "pending",
    approvers: ["ops"],
  };
  const cases = [
    {
      name: "workflow history",
      render: (onClose) => React.createElement(appModule.WorkflowHistoryDialog, {
        diff: null,
        error: "",
        loading: false,
        revisions: [],
        workflow: workflowFixture(),
        onClose,
        onPreview() {},
        onRefresh() {},
        onRestore() {},
      }),
    },
    {
      name: "run preview",
      render: (onClose) => React.createElement(appModule.RunPreviewDialog, {
        plan: { generations: [] },
        workflow: workflowFixture(),
        onCancel: onClose,
        onRun() {},
      }),
    },
    {
      name: "create workflow",
      render: (onClose) => React.createElement(appModule.CreateWorkflowDialog, {
        error: "",
        open: true,
        saving: false,
        templates: [],
        onClose,
        onCreate() {},
      }),
    },
    {
      name: "export workflow",
      render: (onClose) => React.createElement(appModule.ExportWorkflowDialog, {
        error: "",
        open: true,
        outputPath: "/tmp/demo.gof.zip",
        saving: false,
        workflow: workflowFixture(),
        onClose,
        onExport() {},
      }),
    },
    {
      name: "node rename",
      render: (onClose) => React.createElement(canvasModule.NodeRenameDialog, {
        initialLabel: "Step",
        onCancel: onClose,
        onRename() {},
      }),
    },
    {
      name: "filesystem trust",
      render: (onClose) => React.createElement(canvasModule.FilesystemTrustPrompt, {
        parentPath: "/workspace",
        onCancel: onClose,
        onConfirm() {},
      }),
    },
    {
      name: "file editor",
      desktop: { textFiles: { read: async () => ({ content: "hello" }) } },
      render: (onClose) => React.createElement(canvasModule.TextFileDialog, {
        mode: "edit",
        path: "/workspace/demo.txt",
        onClose,
      }),
    },
    {
      name: "path picker",
      desktop: {
        workspace: {
          listDirectory: async () => ({
            directory: "/workspace",
            entries: [],
            parent: null,
          }),
        },
      },
      render: (onClose) => React.createElement(canvasModule.PathPickerDialog, {
        currentPath: "/workspace",
        label: "Working directory",
        onClose,
        onSelect() {},
      }),
    },
    {
      name: "path create and rename",
      render: (onClose) => React.createElement(canvasModule.PathNameDialog, {
        directory: "/workspace",
        initialName: "old.txt",
        kind: "file",
        mode: "rename",
        onClose,
        onSubmit: async () => {},
      }),
    },
    {
      name: "approval",
      render: () => React.createElement(canvasModule.ApprovalDecisionOverlay, {
        approval,
        node: { id: "approve", label: "Deploy" },
        onDecideApproval() {},
      }),
    },
  ];

  for (const dialogCase of cases) {
    await context.test(dialogCase.name, async () => {
      await exerciseDialogFamily(dialogCase.render, dialogCase.desktop);
    });
  }
});

test("workflow refresh helpers preserve local edits during silent refresh", () => {
  const remote = [
    {
      id: "demo",
      name: "Remote",
      nodes: [{ id: "step", type: "agent", label: "Remote label", x: 10, y: 20 }],
      edges: [],
      agents: {},
      sourcePath: "/tmp/demo.toml",
      status: "Ready",
    },
  ];
  const local = {
    ...remote[0],
    name: "Unsaved local",
    nodes: [{ id: "step", type: "agent", label: "Local label", x: 99, y: 120 }],
  };

  const preserved = appModule.preserveLocalWorkflow(remote, local, "/data")[0];

  assert.equal(preserved.name, "Unsaved local");
  assert.equal(preserved.sourcePath, "/tmp/demo.toml");
  assert.equal(preserved.nodes[0].label, "Local label");
  assert.equal(preserved.nodes[0].x, 99);
});

test("reduced-motion preference disables smooth scrolling and status animation", () => {
  globalThis.window.matchMedia = (query) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
  });
  assert.equal(appModule.prefersReducedMotion(), true);

  const css = fs.readFileSync(path.join(frontendRoot, "src/styles/index.css"), "utf8");
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /\.animate-bounce[\s\S]*\.animate-spin[\s\S]*animation:\s*none/);
});

test("workflow save payload keeps all filesystem permission combinations and graph positions", () => {
  const permissionCombinations = Array.from({ length: 8 }, (_unused, value) => ({
    path: `/outside/shared-${value}`,
    read: Boolean(value & 4),
    write: Boolean(value & 2),
    execute: Boolean(value & 1),
  }));
  const payload = appModule.workflowPayloadForSave({
    id: "demo",
    name: "Demo",
    filesystemAccess: [
      ...permissionCombinations,
      { path: "/outside/shared-0/", read: true, write: true, execute: true },
      { path: "/outside/defaults" },
      { path: "" },
    ],
    nodes: [
      {
        id: "step",
        type: "bash_command",
        label: "Run",
        operation: { type: "bash_command", command: "echo hi" },
      },
    ],
  });

  assert.deepEqual(payload.edges, []);
  assert.deepEqual(payload.agents, {});
  assert.deepEqual(payload.filesystemAccess, [
    ...permissionCombinations,
    { path: "/outside/defaults", read: true, write: true, execute: false },
  ]);
  assert.equal(payload.nodes[0].x, 0);
  assert.equal(payload.nodes[0].y, 0);
  assert.equal(payload.nodes[0].operation.command, "echo hi");
});

test("filesystem permission controls update each flag independently", async () => {
  const changes = [];
  const workflow = {
    ...workflowFixture(),
    filesystemAccess: [
      { path: "/outside/tools", read: false, write: true, execute: false },
    ],
  };
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      dataDir: "/workspace",
      workflow,
      onWorkflowChange: (nextWorkflow) => changes.push(nextWorkflow),
    }),
    createFetchMock([]),
  );

  await dom.click(dom.byTitle("Show workflow settings and node inspector"));
  assert.equal(dom.byText("Workflow settings").tagName, "H2");
  const workflowSettingsHeader = dom.ancestor(dom.byText("Workflow settings"), "HEADER");
  assert.equal(
    allElements(workflowSettingsHeader).some(
      (element) => element.tagName === "P" && textOf(element) === workflow.id,
    ),
    true,
  );
  assert.equal(
    allElements(dom.container).some(
      (element) => element.tagName === "LABEL" && textOf(element) === "ID",
    ),
    false,
  );
  await dom.click(dom.byText("Access"));

  await dom.change(dom.controlAfterLabel("Read files"), true);
  await dom.change(dom.controlAfterLabel("Write files"), false);
  await dom.change(dom.controlAfterLabel("Execute files"), true);

  assert.deepEqual(changes.at(-1).filesystemAccess, [
    { path: "/outside/tools", read: true, write: false, execute: true },
  ]);
  assert.match(
    dom.text(),
    /Write access allows this workflow to create, change, move, and delete files/,
  );
  assert.match(dom.text(), /Execute access allows this workflow to run programs/);

  await dom.unmount();
});

test("autosave persists edits to two workflows with independent debounces", async () => {
  const fetchMock = createFetchMock([
    jsonResponse("/api/workflows", workflowsPayload([
      workflowFixture({ id: "a", name: "Workflow A", label: "A original" }),
      workflowFixture({ id: "b", name: "Workflow B", label: "B original" }),
    ])),
    saveWorkflowResponse(),
  ]);
  const dom = await mountReact(React.createElement(appModule.default), fetchMock);

  await dom.flush();
  await dom.change(dom.controlAfterLabel("Name"), "A final");
  await dom.click(dom.ancestor(dom.byText("Workflow B"), (node) => node.getAttribute?.("role") === "button"));
  await dom.change(dom.controlAfterLabel("Name"), "B final");
  await dom.flush(650);

  const saves = fetchMock.calls.filter((call) => call.options.method === "PUT");
  assert.equal(saves.length, 2);
  assert.deepEqual(
    saves.map((call) => [call.url, JSON.parse(call.options.body).name]).sort(),
    [
      ["/api/workflows/a", "A final"],
      ["/api/workflows/b", "B final"],
    ],
  );
  assert.match(dom.text(), /Saved/);

  await dom.unmount();
});

test("autosave serializes revisions and ignores a stale response", async () => {
  const firstSave = createDeferred();
  let saveCount = 0;
  const fetchMock = createFetchMock([
    jsonResponse("/api/workflows", workflowsPayload([
      workflowFixture({ id: "demo", name: "Demo", label: "Original" }),
    ])),
    (url, options = {}) => {
      if (url !== "/api/workflows/demo" || options.method !== "PUT") return null;
      saveCount += 1;
      const workflow = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => (saveCount === 1 ? firstSave.promise : { workflow }),
      };
    },
  ]);
  const dom = await mountReact(React.createElement(appModule.default), fetchMock);

  await dom.flush();
  await dom.change(dom.controlAfterLabel("Name"), "First revision");
  await dom.flush(650);
  await dom.change(dom.controlAfterLabel("Name"), "Newest revision");
  await dom.flush(650);
  assert.equal(fetchMock.calls.filter((call) => call.options.method === "PUT").length, 1);

  firstSave.resolve({
    workflow: workflowFixture({ id: "demo", name: "First revision", label: "Original" }),
  });
  await dom.flush();
  await dom.flush();

  assert.equal(dom.controlAfterLabel("Name").value, "Newest revision");
  const saves = fetchMock.calls.filter((call) => call.options.method === "PUT");
  assert.equal(saves.length, 2);
  assert.equal(JSON.parse(saves[1].options.body).name, "Newest revision");
  assert.match(dom.text(), /Saved/);

  await dom.unmount();
});

test("failed autosave remains visible and retryable", async () => {
  let saveCount = 0;
  const fetchMock = createFetchMock([
    jsonResponse("/api/workflows", workflowsPayload([
      workflowFixture({ id: "demo", name: "Demo", label: "Original" }),
    ])),
    (url, options = {}) => {
      if (url !== "/api/workflows/demo" || options.method !== "PUT") return null;
      saveCount += 1;
      const workflow = JSON.parse(options.body);
      return saveCount === 1
        ? { ok: false, status: 500, json: async () => ({ error: "Disk is unavailable" }) }
        : { ok: true, status: 200, json: async () => ({ workflow }) };
    },
  ]);
  const dom = await mountReact(React.createElement(appModule.default), fetchMock);

  await dom.flush();
  await dom.change(dom.controlAfterLabel("Name"), "Recoverable edit");
  assert.match(dom.text(), /Saving…/);
  await dom.flush(650);

  const retryButton = dom.byText("Retry");
  const alert = dom.ancestor(retryButton, (node) => node.getAttribute?.("role") === "alert");
  assert.match(alert.textContent, /Couldn't saveDisk is unavailable—Retry/);
  assert.equal(alert.getAttribute("title"), "Disk is unavailable");
  assert.equal(alert.getAttribute("aria-live"), "assertive");
  assert.equal(alert.getAttribute("aria-atomic"), "true");
  assert.equal(
    matchingLiveRegions(dom.container, {
      politeness: "assertive",
      role: "alert",
      text: "Disk is unavailable",
    }).length,
    1,
  );

  await dom.click(retryButton);
  await dom.flush();
  assert.equal(saveCount, 2);
  assert.match(dom.text(), /Saved/);
  assert.equal(
    matchingLiveRegions(dom.container, {
      politeness: "assertive",
      role: "alert",
      text: "Disk is unavailable",
    }).length,
    0,
  );

  await dom.unmount();
});

test("silent refresh preserves every dirty workflow and updates clean workflows", async () => {
  const pendingSave = createDeferred();
  let workflowLoadCount = 0;
  const initialWorkflows = [
    workflowFixture({ id: "a", name: "Workflow A", label: "A original" }),
    workflowFixture({ id: "b", name: "Workflow B", label: "B original" }),
    workflowFixture({ id: "c", name: "Workflow C", label: "C original" }),
  ];
  const refreshedWorkflows = [
    workflowFixture({ id: "a", name: "A remote", label: "A remote" }),
    workflowFixture({ id: "b", name: "B remote", label: "B remote" }),
    workflowFixture({ id: "c", name: "C refreshed", label: "C refreshed" }),
  ];
  const fetchMock = createFetchMock([
    (url, options = {}) => {
      if (url !== "/api/workflows" || (options.method ?? "GET") !== "GET") return null;
      workflowLoadCount += 1;
      return {
        ok: true,
        status: 200,
        json: async () => workflowsPayload(
          workflowLoadCount === 1 ? initialWorkflows : refreshedWorkflows,
        ),
      };
    },
    (url, options = {}) => {
      if (!url.startsWith("/api/workflows/") || options.method !== "PUT") return null;
      return { ok: true, status: 200, json: async () => pendingSave.promise };
    },
  ]);
  const dom = await mountReact(React.createElement(appModule.default), fetchMock);

  await dom.flush();
  await dom.change(dom.controlAfterLabel("Name"), "A local");
  await dom.click(dom.ancestor(dom.byText("Workflow B"), (node) => node.getAttribute?.("role") === "button"));
  await dom.change(dom.controlAfterLabel("Name"), "B local");
  await dom.click(dom.ancestor(dom.byText("Workflow C"), (node) => node.getAttribute?.("role") === "button"));
  await dom.flush(2000);

  assert.equal(dom.controlAfterLabel("Name").value, "C refreshed");
  await dom.click(dom.ancestor(dom.byText("A local"), (node) => node.getAttribute?.("role") === "button"));
  assert.equal(dom.controlAfterLabel("Name").value, "A local");
  await dom.click(dom.ancestor(dom.byText("B local"), (node) => node.getAttribute?.("role") === "button"));
  assert.equal(dom.controlAfterLabel("Name").value, "B local");

  await dom.unmount();
});

test("page hide preserves pending edits with a keepalive save", async () => {
  const fetchMock = createFetchMock([
    jsonResponse("/api/workflows", workflowsPayload([
      workflowFixture({ id: "demo", name: "Demo", label: "Original" }),
    ])),
    saveWorkflowResponse(),
  ]);
  const dom = await mountReact(React.createElement(appModule.default), fetchMock);

  await dom.flush();
  await dom.change(dom.controlAfterLabel("Name"), "Pending at unload");
  await dom.dispatchWindow("pagehide");

  const unloadSave = fetchMock.calls.find(
    (call) => call.url === "/api/workflows/demo" && call.options.keepalive,
  );
  assert.ok(unloadSave);
  assert.equal(JSON.parse(unloadSave.options.body).name, "Pending at unload");

  await dom.unmount();
});

test("workflow deletion helpers remove the selected workflow and choose the next active ID", () => {
  const workflows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  assert.deepEqual(appModule.workflowIdsAfterDelete(workflows, "b"), ["a", "c"]);
  assert.equal(appModule.nextActiveWorkflowIdAfterDelete(workflows, "b", "b"), "a");
  assert.equal(appModule.nextActiveWorkflowIdAfterDelete(workflows, "c", "b"), "c");
});

test("workflow sidebar groups workflows by registered project folder", () => {
  assert.deepEqual(
    appModule.groupWorkflowsByProject([
      { id: "review", projectRoot: "/workspace/gofer-flow", projectName: "stale-workflow-slug" },
      { id: "release", projectRoot: "/workspace/gofer-flow", projectName: "gofer-flow" },
      { id: "deploy", projectRoot: "/workspace/deployment", projectName: "Deployment" },
    ]).map((group) => ({
      name: group.name,
      ids: group.items.map((workflow) => workflow.id),
    })),
    [
      { name: "deployment", ids: ["deploy"] },
      { name: "gofer-flow", ids: ["review", "release"] },
    ],
  );

  assert.deepEqual(
    appModule.groupWorkflowsByProject(
      [{ id: "review", projectRoot: "/workspace/gofer-flow" }],
      { "/workspace/gofer-flow": "Taskurotta" },
    ).map((group) => ({ name: group.name, root: group.root })),
    [{ name: "Taskurotta", root: "/workspace/gofer-flow" }],
  );
});

test("silent refresh replaces stale local project identity with the registry identity", () => {
  const local = workflowFixture({ id: "review" });
  local.projectRoot = "/app-data/showcase-completed-workflow";
  local.projectName = "showcase-completed-workflow";
  const remote = {
    ...local,
    projectRoot: "/repos/customer-api",
    projectName: "wrong-cached-name",
    workflowRoot: "/repos/customer-api/.taskurotta/review",
  };

  const [preserved] = appModule.preserveLocalWorkflow([remote], local, "/app-data");

  assert.equal(preserved.projectRoot, "/repos/customer-api");
  assert.equal(preserved.projectName, "customer-api");
  assert.equal(preserved.workflowRoot, "/repos/customer-api/.taskurotta/review");
});

test("project folder menus stay inside the desktop viewport", () => {
  assert.deepEqual(appModule.projectMenuPosition(790, 590, 800, 600), { x: 584, y: 438 });
  assert.deepEqual(appModule.projectMenuPosition(-20, -30, 800, 600), { x: 8, y: 8 });
});

test("project context menu renames only the local display label", async () => {
  window.localStorage.removeItem("gofer.projectLabels");
  const dom = await mountReact(
    React.createElement(appModule.WorkflowSidebar, {
      activeWorkflowId: "review",
      loading: false,
      query: "",
      runState: {},
      workflows: [{
        ...workflowFixture({ id: "review", name: "Review PR" }),
        projectRoot: "/workspace/gofer-flow",
      }],
      width: 272,
      onCreate() {},
      onDeleteWorkflow() {},
      onDuplicateWorkflow() {},
      onQueryChange() {},
      onRefresh() {},
      onRenameWorkflow() {},
      onResizeKeyDown() {},
      onResizeStart() {},
      onRunWorkflow() {},
      onSelect() {},
    }),
    createFetchMock([]),
  );
  const section = allElements(dom.container).find((element) => element.tagName === "SECTION");
  const contextEvent = testEvent(section);
  contextEvent.clientX = 100;
  contextEvent.clientY = 100;
  await React.act(async () => reactProps(section).onContextMenu(contextEvent));
  await dom.click(dom.byText("Rename"));
  const input = dom.byLabel("Project label for gofer-flow");
  await dom.change(input, "Taskurotta");
  await dom.blur(input);

  assert.ok(dom.byText("Taskurotta"));
  assert.deepEqual(JSON.parse(window.localStorage.getItem("gofer.projectLabels")), {
    "/workspace/gofer-flow": "Taskurotta",
  });
  await dom.unmount();
  window.localStorage.removeItem("gofer.projectLabels");
});

test("workflow sidebar swaps project workflows for Radish files", async () => {
  const workflow = {
    ...workflowFixture({ id: "review-pr", name: "Review PR" }),
    projectName: "gofer-flow",
    projectRoot: "/workspace/gofer-flow",
    sourceFormat: "radish",
    sourcePath: "/workspace/gofer-flow/.taskurotta/review-pr/workflow.rad",
  };
  const dom = await mountReact(
    React.createElement(appModule.WorkflowSidebar, {
      activeWorkflow: workflow,
      activeWorkflowId: workflow.id,
      loading: false,
      query: "",
      runState: {},
      view: "code",
      workflows: [workflow],
      width: 272,
      onCreate() {},
      onDeleteWorkflow() {},
      onDuplicateWorkflow() {},
      onQueryChange() {},
      onRefresh() {},
      onRenameWorkflow() {},
      onResizeKeyDown() {},
      onResizeStart() {},
      onRunWorkflow() {},
      onSelect() {},
      onViewChange() {},
    }),
    createFetchMock([]),
    {
      desktop: {
        workspace: {
          listDirectory: async ({ currentPath }) => ({
            directory: currentPath,
            parent: path.dirname(currentPath),
            entries: currentPath === "/workspace/gofer-flow"
              ? [
                  { name: ".taskurotta", path: "/workspace/gofer-flow/.taskurotta", isDirectory: true, isFile: false },
                  { name: "README.md", path: "/workspace/gofer-flow/README.md", isDirectory: false, isFile: true },
                ]
              : currentPath === "/workspace/gofer-flow/.taskurotta"
                ? [{ name: "review-pr", path: "/workspace/gofer-flow/.taskurotta/review-pr", isDirectory: true, isFile: false }]
                : currentPath === "/workspace/gofer-flow/.taskurotta/review-pr"
                  ? [
                      { name: "workflow.rad", path: "/workspace/gofer-flow/.taskurotta/review-pr/workflow.rad", isDirectory: false, isFile: true },
                      { name: "workflow.metadata.json", path: "/workspace/gofer-flow/.taskurotta/review-pr/workflow.metadata.json", isDirectory: false, isFile: true },
                    ]
                  : [],
          }),
        },
      },
    },
  );

  await dom.flush();
  assert.equal(dom.byLabel("Search files").getAttribute("placeholder"), "Search files");
  assert.ok(dom.byText("Project files"));
  assert.ok(dom.byText("README.md"));
  await dom.click(dom.ancestor(dom.byText(".taskurotta"), "BUTTON"));
  await dom.flush();
  await dom.click(dom.ancestor(dom.byText("review-pr"), "BUTTON"));
  await dom.flush();
  assert.ok(dom.byText("workflow.rad"));
  assert.ok(dom.byText("workflow.metadata.json"));
  assert.equal(dom.byText("Code").getAttribute("aria-selected"), "true");
  assert.equal(dom.byText("Graph").getAttribute("aria-selected"), "false");
  await dom.unmount();
});

test("Code file explorer creates, copies, pastes, reveals, renames, and trashes paths", async () => {
  const workflow = {
    ...workflowFixture({ id: "review-pr", name: "Review PR" }),
    projectName: "gofer-flow",
    projectRoot: "/workspace/gofer-flow",
    sourceFormat: "radish",
    sourcePath: "/workspace/gofer-flow/.taskurotta/review-pr/workflow.rad",
  };
  const entries = {
    "/workspace/gofer-flow": [
      { name: "docs", path: "/workspace/gofer-flow/docs", isDirectory: true, isFile: false },
      { name: "README.md", path: "/workspace/gofer-flow/README.md", isDirectory: false, isFile: true },
    ],
    "/workspace/gofer-flow/docs": [],
  };
  const calls = [];
  const openedFiles = [];
  const workspace = {
    async listDirectory({ currentPath }) {
      return { directory: currentPath, parent: path.dirname(currentPath), entries: entries[currentPath] ?? [] };
    },
    async createFile({ directory, name }) {
      calls.push(["create", directory, name]);
      const next = { name, path: `${directory}/${name}`, isDirectory: false, isFile: true };
      entries[directory].push(next);
      return next;
    },
    async copyPath({ sourcePath, destinationPath }) {
      calls.push(["copy", sourcePath, destinationPath]);
      const directory = path.dirname(destinationPath);
      entries[directory].push({
        name: path.basename(destinationPath),
        path: destinationPath,
        isDirectory: false,
        isFile: true,
      });
      return { path: destinationPath };
    },
    async deletePath(targetPath) {
      calls.push(["delete", targetPath]);
      for (const directoryEntries of Object.values(entries)) {
        const index = directoryEntries.findIndex((entry) => entry.path === targetPath);
        if (index >= 0) directoryEntries.splice(index, 1);
      }
      return { deleted: true };
    },
    async renamePath({ sourcePath, name }) {
      calls.push(["rename", sourcePath, name]);
      const directory = path.dirname(sourcePath);
      const entry = entries[directory].find((candidate) => candidate.path === sourcePath);
      entry.name = name;
      entry.path = `${directory}/${name}`;
      return { path: entry.path };
    },
    async revealPath(targetPath) {
      calls.push(["reveal", targetPath]);
      return { opened: true };
    },
    async openPath(targetPath) {
      calls.push(["open", targetPath]);
      return { opened: true };
    },
  };
  const dom = await mountReact(
    React.createElement(appModule.WorkflowSidebar, {
      activeWorkflow: workflow,
      activeWorkflowId: workflow.id,
      loading: false,
      query: "",
      runState: {},
      view: "code",
      workflows: [workflow],
      width: 272,
      onCreate() {},
      onCodeFileOpen(targetPath) { openedFiles.push(targetPath); },
      onCodeFilesystemChange() {},
      onDeleteWorkflow() {},
      onDuplicateWorkflow() {},
      onQueryChange() {},
      onRefresh() {},
      onRenameWorkflow() {},
      onResizeKeyDown() {},
      onResizeStart() {},
      onRunWorkflow() {},
      onSelect() {},
      onViewChange() {},
    }),
    createFetchMock([]),
    { desktop: { workspace } },
  );
  const contextMenu = async (element) => {
    const target = dom.ancestor(element, "BUTTON");
    const event = testEvent(element);
    event.clientX = 100;
    event.clientY = 100;
    await React.act(async () => reactProps(target).onContextMenu(event));
  };
  const menuAction = (label) => {
    const menu = dom.byLabel("File actions");
    const labelElement = allElements(menu).find(
      (element) => element.tagName === "SPAN" && directText(element) === label,
    );
    return dom.ancestor(labelElement, "BUTTON");
  };

  await dom.flush();
  const readmeButton = dom.ancestor(dom.byText("README.md"), "BUTTON");
  await React.act(async () => reactProps(readmeButton).onDoubleClick(testEvent(readmeButton)));
  assert.deepEqual(openedFiles, ["/workspace/gofer-flow/README.md"]);

  await dom.click(dom.byTitle("New file"));
  const nameInput = allElements(dom.container).find(
    (element) => element.tagName === "INPUT" && element.getAttribute("placeholder") === "new-file.txt",
  );
  await dom.change(nameInput, "notes.md");
  await React.act(async () => {
    const form = dom.ancestor(nameInput, "FORM");
    await reactProps(form).onSubmit(testEvent(form));
  });
  await dom.flush();
  assert.ok(dom.byText("notes.md"));
  assert.deepEqual(calls[0], ["create", "/workspace/gofer-flow", "notes.md"]);
  assert.equal(openedFiles.at(-1), "/workspace/gofer-flow/notes.md");

  await contextMenu(dom.byText("README.md"));
  await dom.click(menuAction("Copy"));
  await contextMenu(dom.byText("docs"));
  await dom.click(menuAction("Paste"));
  await dom.flush();
  assert.deepEqual(calls.at(-1), ["copy", "/workspace/gofer-flow/README.md", "/workspace/gofer-flow/docs/README copy.md"]);

  await contextMenu(dom.byText("README.md"));
  await dom.click(menuAction("Open in file explorer"));
  assert.deepEqual(calls.at(-1), ["reveal", "/workspace/gofer-flow/README.md"]);

  await contextMenu(dom.byText("notes.md"));
  await dom.click(menuAction("Rename"));
  const renameInput = allElements(dom.container).find(
    (element) => element.tagName === "INPUT" && element.value === "notes.md",
  );
  await dom.change(renameInput, "decisions.md");
  await React.act(async () => {
    const form = dom.ancestor(renameInput, "FORM");
    await reactProps(form).onSubmit(testEvent(form));
  });
  await dom.flush();
  assert.ok(dom.byText("decisions.md"));

  await contextMenu(dom.byText("decisions.md"));
  await dom.click(menuAction("Delete"));
  await dom.flush();
  assert.equal(calls.at(-1)[0], "delete");
  assert.equal(allElements(dom.container).some((element) => textOf(element) === "decisions.md"), false);

  await dom.unmount();
});

test("code workspace maps common project files to Monaco languages", () => {
  assert.equal(codeWorkspaceModule.languageForPath("/repo/src/app.py"), "python");
  assert.equal(codeWorkspaceModule.languageForPath("/repo/src/app.tsx"), "typescript");
  assert.equal(codeWorkspaceModule.languageForPath("/repo/workflow.metadata.json"), "json");
  assert.equal(codeWorkspaceModule.languageForPath("/repo/Dockerfile"), "dockerfile");
  assert.equal(codeWorkspaceModule.languageForPath("/repo/.env"), "plaintext");
});

test("Radish byte spans convert to Monaco text ranges across Unicode", () => {
  const source = "a😀é\nz";
  assert.equal(radishRangesModule.utf8ByteOffsetToTextOffset(source, 0), 0);
  assert.equal(radishRangesModule.utf8ByteOffsetToTextOffset(source, 1), 1);
  assert.equal(radishRangesModule.utf8ByteOffsetToTextOffset(source, 5), 3);
  assert.equal(radishRangesModule.utf8ByteOffsetToTextOffset(source, 7), 4);

  const model = {
    getLineMaxColumn: () => 5,
    getPositionAt(offset) {
      const prefix = source.slice(0, offset);
      const lines = prefix.split("\n");
      return { lineNumber: lines.length, column: lines.at(-1).length + 1 };
    },
  };
  const marker = radishRangesModule.diagnosticToMarker(
    { MarkerSeverity: { Warning: 4, Info: 2, Error: 8 } },
    model,
    source,
    {
      code: "RADISH_TEST",
      message: "Unicode warning",
      severity: "warning",
      span: { start: { offset: 1 }, end: { offset: 7 } },
    },
  );
  assert.deepEqual(marker, {
    code: "RADISH_TEST",
    endColumn: 5,
    endLineNumber: 1,
    message: "Unicode warning",
    severity: 4,
    source: "Radish",
    startColumn: 2,
    startLineNumber: 1,
  });
});

test("Radish editor projection populates the graph with source-backed route details", () => {
  const workflow = {
    ...workflowFixture({ id: "review-pr", name: "Review PR" }),
    sourceFormat: "radish",
    nodes: [],
    edges: [],
  };
  const projected = appModule.radishGraphWorkflow(workflow, {
    workflowId: "review-pr",
    workflow: { name: "Review the PR" },
    metadata: { canvas: { nodes: { prepare: { x: 32, y: 48 } } } },
    graph: {
      nodes: [
        {
          id: "prepare",
          label: "Prepare",
          type: "bash-command",
          configuration: { command: "echo ready" },
          execution: { allow_fail: false, max_concurrency: 1 },
          diagnostics: [],
        },
        {
          id: "review",
          label: "Review",
          type: "agent",
          configuration: { provider: "codex" },
          execution: { allow_fail: false, max_concurrency: 1 },
          diagnostics: [{ code: "RADISH_TEST", message: "Review is incomplete", severity: "error" }],
        },
      ],
      edges: [
        { id: "prepare:route:0", from: "prepare", to: "review", mode: "when", status: "valid" },
      ],
    },
  });

  assert.equal(projected.name, "Review the PR");
  assert.equal(projected.nodes.length, 2);
  assert.equal(projected.edges.length, 1);
  assert.equal(projected.nodes[0].type, "bash_command");
  assert.deepEqual({ x: projected.nodes[0].x, y: projected.nodes[0].y }, { x: 32, y: 48 });
  assert.ok(projected.nodes[1].x > projected.nodes[0].x);
  assert.equal(projected.edges[0].displayLabel, "when");
  assert.equal(projected.validationDiagnostics[0].targetId, "review");
});

test("Radish graph restores selection and emits targeted inspector mutations", async () => {
  const mutations = [];
  const document = {
    workflowId: "radish-inspector",
    source: "Radish: 1\nWorkflow:\n  name: Inspector\nNode prepare:\n  type: bash-command\n  command: echo ready\n",
    workflow: { name: "Inspector", fields: { name: { value: "Inspector" } } },
    nodeContracts: [
      {
        nodeType: "bash-command",
        configurationSchema: {
          type: "object",
          properties: { command: { type: "string" }, working_dir: { type: ["string", "null"] } },
        },
        defaults: { working_dir: null },
      },
    ],
    graph: {
      nodes: [
        {
          id: "prepare",
          label: "prepare",
          type: "bash-command",
          configuration: { command: "echo ready", working_dir: null },
          execution: { allow_fail: false, max_concurrency: 1, retry_count: 0, retry_delay_ms: 1000 },
          authoredFields: { command: { value: "echo ready" }, type: { value: "bash-command" } },
          bindings: [],
          needs: [],
          diagnostics: [],
        },
      ],
      edges: [],
    },
  };
  const workflow = appModule.radishGraphWorkflow(
    { ...workflowFixture({ id: "radish-inspector", name: "Inspector" }), sourceFormat: "radish", nodes: [], edges: [] },
    document,
  );
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      workflow,
      radishDocument: document,
      onRadishMutation(next) {
        mutations.push(next);
        if (next[0]?.kind === "rename_node") {
          const renamedId = next[0].name.toLowerCase();
          return Promise.resolve({
            ...document,
            graph: {
              ...document.graph,
              nodes: document.graph.nodes.map((candidate) =>
                candidate.id === next[0].node
                  ? { ...candidate, id: renamedId, label: renamedId }
                  : candidate,
              ),
            },
            source: document.source.replace("Node prepare:", `Node ${next[0].name}:`),
          });
        }
        return null;
      },
      onWorkflowChange() {},
    }),
    createFetchMock([]),
  );

  await dom.pointer(dom.ancestor(dom.byText("prepare"), "ARTICLE"), "onPointerDown");
  await dom.flush();
  assert.equal(dom.byText("Node inspector").tagName, "H2");
  const id = dom.controlAfterLabel("ID");
  await dom.focus(id);
  await dom.change(id, "");
  assert.equal(id.value, "");
  assert.match(dom.text(), /Enter a node ID/);
  assert.deepEqual(mutations, []);
  await dom.change(id, "prepare-next");
  assert.equal(id.value, "prepare-next");
  assert.equal(globalThis.document.activeElement, id);
  assert.deepEqual(mutations, []);
  await dom.keyDown(id, "Enter");
  await dom.flush();
  assert.deepEqual(mutations, [
    [{ kind: "rename_node", node: "prepare", name: "prepare-next" }],
  ]);
  const renamedId = dom.controlAfterLabel("ID");
  assert.equal(renamedId.value, "prepare-next");
  assert.equal(globalThis.document.activeElement, renamedId);
  assert.equal(dom.byText("Node inspector").tagName, "H2");
  await dom.blur(renamedId);
  assert.equal(mutations.length, 1);
  await dom.click(dom.byText("Action"));
  const command = dom.controlAfterLabel("Command");
  await dom.focus(command);
  await dom.change(command, "echo changed");
  assert.equal(globalThis.document.activeElement, command);
  assert.equal(mutations.length, 1);
  await dom.blur(dom.controlAfterLabel("Command"));

  assert.deepEqual(mutations.at(-1), [
    {
      kind: "set_field",
      target: { node: "prepare-next" },
      field: "command",
      value: "echo changed",
    },
  ]);
  await dom.unmount();
});

test("Radish edits become dirty immediately and the top bar exposes Save", async () => {
  const savedSource = "Radish: 1\n\nWorkflow:\n  name: Demo\n";
  const editedSource = `${savedSource}\nNode prepare:\n  type: bash-command\n  command: echo ready\n`;
  const edited = radishEditorModule.editorDocumentAfterChange(
    { diagnostics: [], dirty: false, source: savedSource },
    editedSource,
    savedSource,
  );
  assert.equal(edited.dirty, true);
  assert.equal(
    radishEditorModule.editorDocumentAfterChange(edited, savedSource, savedSource).dirty,
    false,
  );

  let saveRequests = 0;
  const workflow = {
    ...workflowFixture({ id: "demo", name: "Demo" }),
    projectName: "gofer-flow",
    sourceFormat: "radish",
    sourcePath: "/workspace/gofer-flow/.taskurotta/demo/workflow.rad",
  };
  const dom = await mountReact(
    React.createElement(appModule.TopBar, {
      editorState: { document: edited, saving: false },
      theme: "light",
      updateState: {},
      view: "code",
      workflow,
      onApplyUpdate() {},
      onCheckForUpdates() {},
      onOpenHistory() {},
      onRetrySave() {},
      onSaveRadish() { saveRequests += 1; },
      onToggleTheme() {},
    }),
    createFetchMock([]),
  );
  const save = dom.byText("Save");
  assert.equal(save.disabled, false);
  await dom.click(save);
  assert.equal(saveRequests, 1);
  await dom.unmount();
});

test("create workflow dialog submits the selected project folder", async () => {
  const submissions = [];
  const dom = await mountReact(
    React.createElement(appModule.CreateWorkflowDialog, {
      defaultProjectRoot: "/repos/taskurotta",
      error: "",
      open: true,
      saving: false,
      templates: [],
      onClose() {},
      onCreate: (name, options) => submissions.push({ name, options }),
    }),
    createFetchMock([]),
  );

  await dom.change(dom.controlAfterLabel("Name"), "Review PR");
  await dom.flush();
  await React.act(async () => {
    const form = allElements(dom.container).find((element) => element.tagName === "FORM");
    reactProps(form).onSubmit(testEvent(form));
  });

  assert.deepEqual(submissions, [{
    name: "Review PR",
    options: {
      projectRoot: "/repos/taskurotta",
      projectGrantId: "",
      template: "",
    },
  }]);
  await dom.unmount();
});

test("App keeps the new workflow name field enabled after deleting a workflow", async () => {
  const dom = await mountReact(
    React.createElement(appModule.default),
    createFetchMock([
      jsonResponse("/api/workflows", workflowsPayload([
        workflowFixture({ id: "demo", name: "Demo" }),
        workflowFixture({ id: "other", name: "Other" }),
      ])),
      jsonResponse("/api/provider/capabilities", {
        providers: [{
          id: "codex",
          displayName: "Codex",
          available: true,
          discoveryStatus: "ready",
          defaultModel: "gpt-5.6-sol",
          models: [{
            id: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            defaultEffort: "medium",
            efforts: [{ id: "low", displayName: "Low" }, { id: "medium", displayName: "Medium" }],
          }],
        }],
      }),
      jsonResponse("/api/workflows/demo/logs/latest", {
        log: { logText: "latest demo log", logPath: "/tmp/demo.log" },
      }),
      jsonResponse("/api/workflows/demo/logs?limit=100", { runs: [] }),
      jsonResponse("/api/workflows/demo", { deleted: true }, { method: "DELETE" }),
    ]),
  );

  await dom.flush();
  await dom.click(dom.allByTitle("Workflow actions")[0]);
  await dom.click(dom.byText("Delete workflow"));
  await dom.flush();

  await dom.click(dom.byTitle("Create workflow"));
  const nameInput = dom.controlAfterLabel("Name");

  assert.equal(nameInput.disabled, false);

  await dom.unmount();
});

test("run, plan, and log helpers build backend requests without a real server", () => {
  globalThis.window.goferApiBaseUrl = "http://127.0.0.1:8765";

  const planRequest = appModule.workflowPlanRequest("demo workflow", {
    schedule: { cron_expression: "0 9 * * *" },
  });
  assert.equal(planRequest.url, "http://127.0.0.1:8765/api/workflows/demo%20workflow/plan");
  assert.equal(planRequest.options.method, "POST");
  assert.deepEqual(JSON.parse(planRequest.options.body), {
    triggerContext: { schedule: { cron_expression: "0 9 * * *" } },
  });

  const runRequest = appModule.workflowRunRequest("demo workflow", {
    dryRun: false,
    triggerContext: { watch: { path: "/tmp/inbox" } },
  });
  assert.equal(runRequest.url, "http://127.0.0.1:8765/api/workflows/demo%20workflow/run");
  assert.deepEqual(JSON.parse(runRequest.options.body), {
    dryRun: false,
    triggerContext: { watch: { path: "/tmp/inbox" } },
  });

  const resumeRequest = appModule.workflowResumeRequest("demo workflow", "run/1", {
    fromNode: "step",
    skipCache: true,
  });
  assert.equal(
    resumeRequest.url,
    "http://127.0.0.1:8765/api/workflows/demo%20workflow/runs/run%2F1/resume",
  );
  assert.deepEqual(JSON.parse(resumeRequest.options.body), {
    force: false,
    fromNode: "step",
    onlyNode: null,
    skipCache: true,
    triggerContext: {},
  });

  const replayRequest = appModule.workflowReplayTriggerRequest(
    "demo workflow",
    "run/1",
    "github",
  );
  assert.equal(
    replayRequest.url,
    "http://127.0.0.1:8765/api/workflows/demo%20workflow/webhooks/github/replay",
  );
  assert.equal(replayRequest.options.method, "POST");
  assert.deepEqual(JSON.parse(replayRequest.options.body), { runId: "run/1" });

  assert.deepEqual(appModule.workflowLogUrls("demo workflow", "run/1"), {
    latest: "http://127.0.0.1:8765/api/workflows/demo%20workflow/logs/latest",
    runs: "http://127.0.0.1:8765/api/workflows/demo%20workflow/logs",
    selected:
      "http://127.0.0.1:8765/api/workflows/demo%20workflow/logs/run%2F1?tailBytes=65536&details=0",
  });
});

test("workflow failures prefer the runtime error and fall back to the failed node", () => {
  assert.equal(
    appModule.workflowRunFailureMessage({ error: { message: "grep found no match" } }),
    "grep found no match",
  );
  assert.equal(
    appModule.workflowRunFailureMessage({
      runNodes: { asdf: { status: "error", error: { message: "command not found" } } },
    }),
    "command not found",
  );
  assert.match(appModule.workflowRunFailureMessage({}), /Select the failed node/);
});

test("chat helpers parse stream events, group thoughts, and build request payloads", () => {
  const messages = [
    { id: "u1", role: "user", body: "Summarize this workflow" },
    { id: "t1", role: "assistant", kind: "thought", groupId: "g1", body: "Inspecting nodes" },
    { id: "t2", role: "assistant", kind: "thought", groupId: "g1", body: "Checking edges" },
    { id: "m1", role: "assistant", kind: "memory", body: "hidden" },
    { id: "a1", role: "assistant", body: "Done" },
  ];

  const items = appModule.buildChatItems(messages);
  assert.equal(items[0].type, "message");
  assert.equal(items[1].type, "thought-group");
  assert.equal(items[1].thoughts.length, 2);
  assert.equal(items[2].message.body, "Done");

  const duplicateOutputItems = appModule.buildChatItems([
    { id: "u2", role: "user", body: "Can you do this?" },
    {
      id: "t3",
      role: "assistant",
      kind: "thought",
      groupId: "g2",
      body: "I need filesystem access.",
      trace: { kind: "summary", title: "Thought", body: "I need filesystem access." },
    },
    { id: "a2", role: "assistant", kind: "final", body: "I need filesystem access." },
  ]);
  assert.deepEqual(duplicateOutputItems.map((item) => item.type), ["message", "message"]);

  const retainedTraceItems = appModule.buildChatItems([
    { id: "u3", role: "user", body: "Inspect this" },
    {
      id: "t4",
      role: "assistant",
      kind: "thought",
      groupId: "g3",
      body: "Inspecting files",
      trace: { kind: "summary", title: "Thought", body: "Inspecting files" },
    },
    {
      id: "t5",
      role: "assistant",
      kind: "thought",
      groupId: "g3",
      body: "Inspection complete",
      trace: { kind: "summary", title: "Thought", body: "Inspection complete" },
    },
    { id: "a3", role: "assistant", kind: "final", body: "Inspection complete" },
  ]);
  assert.equal(retainedTraceItems[1].type, "thought-group");
  assert.deepEqual(retainedTraceItems[1].thoughts.map((thought) => thought.body), [
    "Inspecting files",
  ]);

  const streamedMessages = [
    {
      id: "t6",
      role: "assistant",
      kind: "thought",
      groupId: "g4",
      body: "Final answer",
      trace: { kind: "summary", title: "Thought", body: "Final answer" },
    },
  ];
  assert.deepEqual(
    appModule.removeTrailingDuplicateOutputThought(streamedMessages, "Final answer", "g4"),
    [],
  );
  assert.equal(
    appModule.removeTrailingDuplicateOutputThought(streamedMessages, "Different answer", "g4")
      .length,
    1,
  );
  assert.deepEqual(
    appModule.removeTrailingDuplicateOutputThought([
      {
        id: "metadata-thought",
        role: "assistant",
        kind: "thought",
        groupId: "g4",
        body: "tokens used\n15,930",
        trace: { kind: "summary", body: "tokens used\n15,930" },
      },
      ...streamedMessages,
    ], "Final answer", "g4"),
    [],
  );

  const markdownDuplicate = {
    id: "t7",
    role: "assistant",
    kind: "thought",
    groupId: "g5",
    body: "The workflow processes tickets.\n1. `collect` reads files.\n2. `classify` labels them...",
    trace: {
      kind: "summary",
      title: "Thought",
      body: "The workflow processes tickets.\n1. `collect` reads files.\n2. `classify` labels them...",
    },
  };
  assert.deepEqual(
    appModule.removeTrailingDuplicateOutputThought(
      [markdownDuplicate],
      "The workflow processes tickets.\n\n1. `collect` reads files.\n2. `classify` labels them for routing and review.",
      "g5",
    ),
    [],
  );

  const trace = appModule.buildThoughtTrace([
    {
      id: "trace-summary",
      body: "Inspecting nodes",
      trace: { kind: "summary", title: "Thought", body: "Inspecting nodes" },
    },
    {
      id: "trace-tool-start",
      body: "Read",
      trace: {
        id: "tool-1",
        kind: "tool",
        title: "Read",
        detail: "workflow.toml",
        input: "workflow.toml",
        status: "running",
      },
    },
    {
      id: "trace-tool-result",
      body: "Tool result",
      trace: {
        id: "tool-1",
        kind: "tool",
        title: "Tool result",
        output: "[workflow]",
        status: "complete",
      },
    },
  ]);
  assert.equal(trace.length, 2);
  assert.equal(trace[1].title, "Read");
  assert.equal(trace[1].detail, "workflow.toml");
  assert.equal(trace[1].output, "[workflow]");
  assert.equal(trace[0].title, "Thought");
  const thinkingTrace = appModule.buildThoughtTrace([
    {
      id: "thinking-start",
      kind: "thought",
      body: "Thinking",
      trace: {
        id: "claude-thinking-msg-1-0",
        kind: "summary",
        title: "Thinking",
        status: "running",
      },
    },
    {
      id: "thinking-complete",
      kind: "thought",
      body: "Thought",
      trace: {
        id: "claude-thinking-msg-1-0",
        kind: "summary",
        title: "Thought",
        detail: "for 8s",
        status: "complete",
      },
    },
  ]);
  assert.equal(thinkingTrace.length, 1);
  assert.equal(thinkingTrace[0].title, "Thought");
  assert.equal(thinkingTrace[0].detail, "for 8s");
  assert.equal(thinkingTrace[0].body, "");
  assert.equal(thinkingTrace[0].status, "complete");
  assert.deepEqual(appModule.buildThoughtTrace([
    {
      id: "trace-metadata",
      body: "tokens used\n15,930",
      trace: { kind: "summary", title: "Thought", body: "tokens used\n15,930" },
    },
  ]), []);

  const markdownBlocks = appModule.parseMinimalMarkdown(
    "## Result\n\n**Ready** with `workflow.toml`.\n\n1. Read files\n2. Classify tickets\n\n```toml\n[workflow]\nname = \"Demo\"\n```",
  );
  assert.deepEqual(markdownBlocks.map((block) => block.type), [
    "heading",
    "paragraph",
    "list",
    "code",
  ]);
  assert.deepEqual(markdownBlocks[1].tokens.map((token) => token.type), [
    "strong",
    "text",
    "code",
    "text",
  ]);
  assert.equal(markdownBlocks[2].ordered, true);
  assert.equal(markdownBlocks[3].text, '[workflow]\nname = "Demo"');
  assert.equal(
    appModule.normalizeMarkdownText("1. **Run** `collect`\n2. Review"),
    "Run collect Review",
  );

  assert.deepEqual(appModule.parseChatStreamEvent('{"type":"final","message":{"body":"ok"}}'), {
    type: "final",
    message: { body: "ok" },
  });
  assert.equal(appModule.parseChatStreamEvent("not json"), null);
  assert.equal(
    appModule.threadTitleFromMessage("one two three four five six seven eight nine ten"),
    "one two three four five six seven eight...",
  );

  assert.deepEqual(appModule.chatStreamRequestBody({
    provider: "codex",
    model: "cli-default",
    effort: "high",
    messages: [{ role: "user", body: "hi" }],
    workflow: { id: "workflow-assistant:thread-1", chatThreadId: "thread-1" },
  }), {
    provider: "codex",
    model: "cli-default",
    effort: "high",
    messages: [{ role: "user", body: "hi" }],
    workflow: { id: "workflow-assistant:thread-1", chatThreadId: "thread-1" },
  });
});

test("RunPreviewDialog renders grouped warnings, destructive actions, providers, fan-out samples, and node details", () => {
  const plan = {
    workflowId: "preview-demo",
    workflowName: "Preview Demo",
    warnings: ["Missing read target: /workspace/missing.txt"],
    destructiveActions: ["overwrite file: /workspace/out.txt"],
    requiredSecrets: ["OPENAI_API_KEY"],
    providerRequirements: [
      {
        agentId: "reviewer",
        subscription: "codex",
        binary: "codex",
        available: false,
        workingDir: "/workspace/agents",
        profile: "quality",
        model: "gpt-5",
        timeout: 45,
        extraPaths: ["/workspace/shared"],
      },
    ],
    bindings: [
      {
        id: "binding:scan:operation.command:previous.output",
        destinationNode: "scan",
        destinationField: "operation.command",
        expression: "previous.output",
        producer: "previous-predecessor",
        sourceType: "string",
        destinationType: "string",
        resolutionPhase: "upstream-node-completion",
        status: "runtime-bound",
        coercion: "string",
        consumer: "shell",
      },
      {
        id: "binding:scan:operation.env.TOKEN:secret.API_TOKEN",
        destinationNode: "scan",
        destinationField: "operation.env.TOKEN",
        expression: "secret.API_TOKEN",
        producer: "secret-store",
        sourceType: "secret",
        destinationType: "string",
        resolutionPhase: "run-start",
        status: "runtime-bound",
        coercion: "string",
        consumer: "process-or-shell",
        readiness: "present",
      },
    ],
    triggerContext: {
      watch: { path: "/workspace/inbox", glob: "*.md", mode: "fanout" },
    },
    generations: [
      {
        index: 0,
        nodes: [
          {
            id: "scan",
            type: "bash_command",
            detail: "echo scan",
            workingDir: "/workspace/jobs",
            sideEffects: ["shell command: echo scan"],
            fanOut: {
              sourceType: "directory",
              count: 2,
              countExact: false,
              countLowerBound: 2,
              sampleItems: [
                { path: "/workspace/inbox/a.md" },
                { path: "/workspace/inbox/b.md" },
              ],
            },
            bindings: [
              {
                id: "binding:scan:inputs.file:trigger.file",
                destinationField: "inputs.file",
                expression: "trigger.file",
                status: "optional",
                resolutionPhase: "run-start",
              },
            ],
          },
        ],
      },
    ],
  };

  const html = renderToStaticMarkup(
    React.createElement(appModule.RunPreviewDialog, {
      plan,
      workflow: { id: "preview-demo", name: "Preview Demo" },
      onCancel: () => {},
      onRun: () => {},
    }),
  );

  assert.match(html, /Destructive actions/);
  assert.match(html, /overwrite file: \/workspace\/out\.txt/);
  assert.match(html, /Warnings/);
  assert.match(html, /Required secrets/);
  assert.match(html, /OPENAI_API_KEY/);
  assert.match(html, /Provider CLI requirements/);
  assert.match(
    html,
    /reviewer: codex binary=codex \(missing\) cwd=\/workspace\/agents profile=quality model=gpt-5 timeout=45s/,
  );
  assert.match(html, /Trigger context/);
  assert.match(html, /Watch: \/workspace\/inbox glob=\*\.md mode=fanout/);
  assert.match(html, /<details/);
  assert.match(html, /Generation 0/);
  assert.match(html, /Working directory: \/workspace\/jobs/);
  assert.match(html, /Fan-out directory:/);
  assert.match(html, /at least 2 items/);
  assert.match(html, /Sample: \/workspace\/inbox\/a\.md/);
  assert.match(html, /Runtime bindings/);
  assert.match(html, /upstream-node-completion/);
  assert.match(html, /secret present/);
  assert.match(html, /shell owns expressions such as \$\{FILE_NAME\}/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby=/);
  assert.match(html, /aria-describedby=/);
});

test("UsageSummaryStrip renders run cost, expensive nodes, and slow nodes", () => {
  const html = renderToStaticMarkup(
    React.createElement(canvasModule.UsageSummaryStrip, {
      summary: {
        totals: {
          agent_calls: 3,
          total_tokens: 1234,
          estimated_cost: 0.045,
          agent_time_seconds: 9.5,
        },
        most_expensive_nodes: [{ node_id: "review", estimated_cost: 0.04 }],
        slowest_nodes: [{ node_id: "draft", duration_seconds: 8.25 }],
      },
    }),
  );

  assert.match(html, /LLM usage/);
  assert.match(html, /3 calls/);
  assert.match(html, /1,234 tokens/);
  assert.match(html, /cost~\$0\.045000/);
  assert.match(html, /Most expensive: review/);
  assert.match(html, /Slowest: draft/);
});

test("App loads workflows, preserves local edits on silent refreshes, saves errors, deletes workflows, and loads logs", async () => {
  const dom = await mountReact(
    React.createElement(appModule.default),
    createFetchMock([
      jsonResponse("/api/workflows", workflowsPayload([
        workflowFixture({ id: "demo", name: "Demo", label: "Original label" }),
        workflowFixture({ id: "other", name: "Other", label: "Other label" }),
      ])),
      jsonResponse("/api/provider/capabilities", {
        providers: [{
          id: "codex",
          displayName: "Codex",
          available: true,
          discoveryStatus: "ready",
          defaultModel: "gpt-5.6-sol",
          models: [{
            id: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            defaultEffort: "medium",
            efforts: [{ id: "low", displayName: "Low" }, { id: "medium", displayName: "Medium" }],
          }],
        }],
      }),
      jsonResponse("/api/workflows/demo/logs/latest", {
        log: { logText: "latest demo log", logPath: "/tmp/demo.log" },
      }),
      jsonResponse("/api/workflows/demo/logs?limit=100", {
        runs: [{ id: "run-1", status: "success", startedAt: "2026-01-02T03:04:05Z" }],
      }),
      jsonResponse("/api/workflows/demo", { error: "Save rejected" }, { method: "PUT", ok: false, status: 400 }),
      jsonResponse("/api/workflows/demo", { deleted: true }, { method: "DELETE" }),
      jsonResponse("/api/workflows/other/export", {
        bundlePath: "/workspace/other.gof.zip",
      }, { method: "POST" }),
      jsonResponse("/api/workflows", workflowsPayload([
        workflowFixture({ id: "demo", name: "Demo", label: "Remote refreshed label" }),
        workflowFixture({ id: "other", name: "Other", label: "Other label" }),
      ])),
    ]),
  );

  await dom.flush();
  assert.match(dom.text(), /Demo/);
  assert.match(dom.text(), /latest demo log/);
  assert.equal(
    dom.fetchCalls.some((call) => call.url === "/api/workflows/demo/logs/latest"),
    true,
  );

  const labelInput = dom.controlAfterLabel("Name");
  await dom.change(labelInput, "Local unsaved label");
  assert.match(dom.text(), /Local unsaved label/);

  await dom.flush(2100);
  assert.match(dom.text(), /Local unsaved label/);
  assert.doesNotMatch(dom.text(), /Remote refreshed label/);

  await dom.click(dom.byTitle("Validate workflow"));
  await dom.flush();
  assert.match(dom.text(), /Save rejected/);

  await dom.click(dom.ancestor(dom.byText("Other"), (node) => node.getAttribute?.("role") === "button"));
  assert.match(dom.text(), /Other label/);

  await dom.click(dom.allByTitle("Workflow actions")[0]);
  await dom.click(dom.byText("Delete workflow"));
  await dom.flush();
  assert.equal(dom.fetchCalls.some((call) => call.url === "/api/workflows/demo" && call.options.method === "DELETE"), true);
  assert.match(dom.text(), /Other/);

  await dom.click(dom.byTitle("Export workflow bundle"));
  await dom.flush();
  assert.match(dom.text(), /Export workflow bundle/);
  await dom.change(dom.controlAfterLabel("Output path"), "/workspace/other.gof.zip");
  await dom.pointer(dom.ancestor(dom.byTitle("Confirm workflow export"), "FORM"), "onSubmit");
  await dom.flush();
  assert.equal(
    dom.fetchCalls.some(
      (call) =>
        call.url === "/api/workflows/other/export" &&
        call.options.method === "POST" &&
        JSON.parse(call.options.body).outputPath === "/workspace/other.gof.zip",
    ),
    true,
  );
  assert.match(dom.text(), /Exported bundle to \/workspace\/other\.gof\.zip/);

  await dom.unmount();
});

test("App renders run and stop state, opens the run preview, executes runs, and sends chat prompts", async () => {
  const chatStream = streamResponse([
    '{"type":"thought","text":"**Inspecting graph** with [workflow](https://example.com) and `step`.\\n\\n1. Read nodes\\n2. Check edges","trace":{"kind":"summary","title":"Summary","body":"**Inspecting graph** with [workflow](https://example.com) and `step`.\\n\\n1. Read nodes\\n2. Check edges"}}\n',
    '{"type":"thought","text":"Read","trace":{"id":"tool-1","kind":"tool","title":"Read","detail":"workflow.toml","input":"workflow.toml","status":"running"}}\n',
    '{"type":"thought","text":"Read","trace":{"id":"tool-1","kind":"tool","title":"Tool result","output":"[workflow]","status":"complete"}}\n',
    '{"type":"final","message":{"body":"**Looks ready**\\n\\n1. Read files\\n2. Classify tickets"}}\n',
  ]);
  const fetchMock = createFetchMock([
    jsonResponse("/api/workflows", workflowsPayload([
      {
        ...workflowFixture({ id: "demo", name: "Demo", status: "Running" }),
        filesystemAccess: [
          { path: "/outside/input", read: true, write: false, execute: false },
          { path: "/outside/tools", read: false, write: false, execute: true },
        ],
        runs: [{ id: "run-1", status: "running", startedAt: "2026-01-02T03:04:05Z" }],
      },
    ])),
    jsonResponse("/api/provider/capabilities", {
      providers: [{
        id: "codex",
        displayName: "Codex",
        available: true,
        discoveryStatus: "ready",
        defaultModel: "gpt-5.6-sol",
        models: [{
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          defaultEffort: "medium",
          efforts: [{ id: "low", displayName: "Low" }, { id: "medium", displayName: "Medium" }],
        }],
      }],
    }),
    jsonResponse("/api/workflows/demo/logs/latest", {
      log: { logText: "running log", logPath: "/tmp/demo.log" },
    }),
    jsonResponse("/api/workflows/demo/logs?limit=100", {
      runs: [{ id: "run-1", status: "running", startedAt: "2026-01-02T03:04:05Z" }],
    }),
    jsonResponse("/api/workflows/demo", {
      workflow: {
        ...workflowFixture({ id: "demo", name: "Demo", status: "Ready" }),
        filesystemAccess: [
          { path: "/outside/input", read: true, write: false, execute: false },
          { path: "/outside/tools", read: false, write: false, execute: true },
        ],
      },
    }, { method: "PUT" }),
    jsonResponse("/api/workflows/demo/plan", {
      plan: {
        workflowId: "demo",
        workflowName: "Demo",
        warnings: ["shell effects cannot be inferred"],
        destructiveActions: ["delete file: /tmp/out.txt"],
        generations: [{ index: 0, nodes: [{ id: "step", type: "bash_command", detail: "echo hi" }] }],
      },
    }, { method: "POST" }),
    jsonResponse("/api/workflows/demo/run", {
      run: {
        success: false,
        status: "stopped",
        logText: "run stopped",
        logPath: "/tmp/demo.log",
        nodeOutputs: {},
      },
    }, { method: "POST" }),
    jsonResponse("/api/workflows/demo/logs?limit=100", { runs: [] }),
    jsonResponse("/api/workflows/demo/stop", { stopped: true }, { method: "POST" }),
    (url) => (url === "/api/chat/stream" ? chatStream(url) : null),
  ]);
  const dom = await mountReact(React.createElement(appModule.default), fetchMock);

  await dom.flush();
  assert.ok(dom.byLabel("Search workflows"));
  const stopButton = dom.byTitle("Stop all runs");
  assert.equal(stopButton.disabled, false);
  await dom.click(stopButton);
  await dom.flush();
  assert.equal(fetchMock.calls.some((call) => call.url === "/api/workflows/demo/stop"), true);

  await dom.click(dom.byTitle("Start another workflow run"));
  await dom.flush();
  assert.match(dom.text(), /Run preview: Demo/);
  assert.match(dom.text(), /delete file: \/tmp\/out\.txt/);
  assert.match(dom.text(), /\/outside\/input: read/);
  assert.match(dom.text(), /\/outside\/tools: execute/);
  const previewRunButton = dom.ancestor(dom.byText("Run workflow"), "BUTTON");
  assert.match(previewRunButton.getAttribute("class"), /inline-flex/);
  assert.match(previewRunButton.getAttribute("class"), /items-center/);
  assert.match(previewRunButton.getAttribute("class"), /gap-2/);

  await dom.click(previewRunButton);
  await dom.flush();
  assert.match(dom.text(), /run stopped/);
  assert.match(dom.text(), /Stopped/);
  assert.match(dom.text(), /Workflow run completed: stopped/);
  assert.equal(
    matchingLiveRegions(dom.container, {
      politeness: "polite",
      role: "status",
      text: "Workflow run completed: stopped",
    }).length,
    1,
  );
  await dom.flush();
  assert.equal(
    matchingLiveRegions(dom.container, {
      politeness: "polite",
      role: "status",
      text: "Workflow run completed: stopped",
    }).length,
    1,
  );
  const runRequest = fetchMock.calls.find((call) => call.url === "/api/workflows/demo/run");
  assert.deepEqual(JSON.parse(runRequest.options.body), { dryRun: false, triggerContext: {} });

  await dom.change(dom.first("textarea"), "Explain this workflow");
  await dom.click(dom.byTitle("Send message"));
  await dom.flush();
  assert.match(dom.text(), /Explain this workflow/);
  assert.match(dom.text(), /Hide thoughts/);
  assert.match(dom.text(), /Inspecting graph/);
  const thoughtGroup = dom.byText("Hide thoughts").parentNode.parentNode;
  assert.doesNotMatch(textOf(thoughtGroup), /Summary/);
  assert.equal(
    allElements(thoughtGroup).some(
      (element) => element.tagName === "STRONG" && element.textContent === "Inspecting graph",
    ),
    true,
  );
  assert.equal(
    allElements(thoughtGroup).some(
      (element) => element.tagName === "A" && element.getAttribute("href") === "https://example.com/",
    ),
    true,
  );
  assert.equal(
    allElements(thoughtGroup).some(
      (element) => element.tagName === "CODE" && element.textContent === "step",
    ),
    true,
  );
  assert.equal(
    allElements(thoughtGroup).some(
      (element) => element.tagName === "OL" && /Read nodes/.test(element.textContent),
    ),
    true,
  );
  assert.match(dom.text(), /workflow\.toml/);
  assert.match(dom.text(), /\[workflow\]/);
  assert.match(dom.text(), /Looks ready/);
  assert.equal(
    allElements(dom.container).some(
      (element) => element.tagName === "STRONG" && element.textContent === "Looks ready",
    ),
    true,
  );
  assert.equal(
    allElements(dom.container).some(
      (element) => element.tagName === "OL" && /Read files/.test(element.textContent),
    ),
    true,
  );
  assert.match(dom.text(), /Workflow assistant response complete/);
  assert.equal(
    matchingLiveRegions(dom.container, {
      politeness: "polite",
      role: "status",
      text: "Workflow assistant response complete",
    }).length,
    1,
  );
  const chatRequest = fetchMock.calls.find((call) => call.url === "/api/chat/stream");
  assert.equal(JSON.parse(chatRequest.options.body).workflow.selectedWorkflowId, "demo");

  await dom.unmount();
});

test("assistant threads keep streaming after navigation and report running and completed state", async () => {
  const controlledStream = controlledStreamResponse([
    '{"type":"thought","text":"Still working"}\n',
    '{"type":"final","message":{"body":"Background response finished"}}\n',
  ]);
  const fetchMock = createFetchMock([
    jsonResponse("/api/workflows", workflowsPayload([workflowFixture()])),
    jsonResponse("/api/provider/capabilities", {
      providers: [{ id: "codex", displayName: "Codex", available: true, models: [] }],
    }),
    (url) => (url === "/api/chat/stream" ? controlledStream.response(url) : null),
  ]);
  const dom = await mountReact(React.createElement(appModule.default), fetchMock);

  await dom.flush();
  await dom.change(dom.first("textarea"), "Keep tracking this response");
  await dom.click(dom.byTitle("Send message"));
  await dom.flush();
  await dom.click(dom.byTitle("Back to recent threads"));

  assert.equal(dom.byTitle("Assistant response running").tagName, "SPAN");
  assert.match(dom.text(), /Keep tracking this response/);

  controlledStream.releaseNext();
  await dom.flush();
  assert.equal(dom.byTitle("Assistant response running").tagName, "SPAN");

  controlledStream.releaseNext();
  await dom.flush();
  assert.equal(dom.byTitle("Assistant response complete").tagName, "SPAN");
  assert.equal(
    matchingLiveRegions(dom.container, {
      politeness: "polite",
      role: "status",
      text: "Assistant response complete in Keep tracking this response",
    }).length,
    1,
  );

  const completedThreadButton = allElements(dom.container).find(
    (element) =>
      element.tagName === "BUTTON" && textOf(element).includes("Keep tracking this response"),
  );
  assert.ok(completedThreadButton);
  await dom.click(completedThreadButton);
  await dom.flush();
  assert.match(dom.text(), /Background response finished/);

  await dom.click(dom.byTitle("Recent threads"));
  assert.equal(
    allElements(dom.container).some(
      (element) => element.getAttribute?.("title") === "Assistant response complete",
    ),
    false,
  );

  await dom.unmount();
});

test("deleting a background assistant thread disposes its pending stream state", async () => {
  const controlledStream = controlledStreamResponse([
    '{"type":"final","message":{"body":"This must stay deleted"}}\n',
  ]);
  const fetchMock = createFetchMock([
    jsonResponse("/api/workflows", workflowsPayload([workflowFixture()])),
    jsonResponse("/api/provider/capabilities", {
      providers: [{ id: "codex", displayName: "Codex", available: true, models: [] }],
    }),
    (url) => (url === "/api/chat/stream" ? controlledStream.response(url) : null),
  ]);
  const dom = await mountReact(React.createElement(appModule.default), fetchMock);

  await dom.flush();
  await dom.change(dom.first("textarea"), "Delete this running thread");
  await dom.click(dom.byTitle("Send message"));
  await dom.flush();
  const chatRequest = fetchMock.calls.find((call) => call.url === "/api/chat/stream");
  const threadId = JSON.parse(chatRequest.options.body).workflow.chatThreadId;
  await dom.click(dom.byTitle("Back to recent threads"));
  await dom.click(dom.byTitle("Delete thread"));
  await dom.flush();

  controlledStream.releaseNext();
  await dom.flush();

  assert.doesNotMatch(dom.text(), /Delete this running thread/);
  assert.equal(window.localStorage.getItem(appModule.chatStorageKeyFor(threadId)), null);
  assert.equal(dom.allByTitle("Assistant response running").length, 0);
  assert.equal(dom.allByTitle("Assistant response complete").length, 0);

  await dom.unmount();
});

test("assistant activity remains independent across concurrent threads", async () => {
  const firstStream = controlledStreamResponse([
    '{"type":"final","message":{"body":"First finished"}}\n',
  ]);
  const secondStream = controlledStreamResponse([
    '{"type":"final","message":{"body":"Second finished"}}\n',
  ]);
  let streamIndex = 0;
  const fetchMock = createFetchMock([
    jsonResponse("/api/workflows", workflowsPayload([workflowFixture()])),
    jsonResponse("/api/provider/capabilities", {
      providers: [{ id: "codex", displayName: "Codex", available: true, models: [] }],
    }),
    (url) => {
      if (url !== "/api/chat/stream") return null;
      const stream = streamIndex === 0 ? firstStream : secondStream;
      streamIndex += 1;
      return stream.response(url);
    },
  ]);
  const dom = await mountReact(React.createElement(appModule.default), fetchMock);

  await dom.flush();
  await dom.change(dom.first("textarea"), "First background thread");
  await dom.click(dom.byTitle("Send message"));
  await dom.flush();
  await dom.click(dom.byTitle("Back to recent threads"));
  await dom.click(dom.byTitle("New thread"));
  await dom.change(dom.first("textarea"), "Second background thread");
  await dom.click(dom.byTitle("Send message"));
  await dom.flush();
  await dom.click(dom.byTitle("Back to recent threads"));
  assert.equal(dom.allByTitle("Assistant response running").length, 2);

  secondStream.releaseNext();
  await dom.flush();
  assert.equal(dom.allByTitle("Assistant response running").length, 1);
  assert.equal(dom.allByTitle("Assistant response complete").length, 1);

  firstStream.releaseNext();
  await dom.flush();
  assert.equal(dom.allByTitle("Assistant response running").length, 0);
  assert.equal(dom.allByTitle("Assistant response complete").length, 2);

  await dom.unmount();
});

test("assistant errors use one assertive live region and clear on the next request", async () => {
  let chatRequestCount = 0;
  const fetchMock = createFetchMock([
    jsonResponse("/api/workflows", workflowsPayload([workflowFixture()])),
    jsonResponse("/api/provider/capabilities", {
      providers: [{ id: "codex", displayName: "Codex", available: true, models: [] }],
    }),
    (url) => {
      if (url !== "/api/chat/stream") return null;
      chatRequestCount += 1;
      return streamResponse(
        chatRequestCount === 1
          ? ['{"type":"error","error":"Assistant unavailable"}\n']
          : ['{"type":"final","message":{"body":"Recovered"}}\n'],
      )(url);
    },
  ]);
  const dom = await mountReact(React.createElement(appModule.default), fetchMock);

  await dom.flush();
  const composer = dom.first("textarea");
  await dom.change(composer, "First request");
  await dom.click(dom.byTitle("Send message"));
  await dom.flush();

  assert.equal(
    matchingLiveRegions(dom.container, {
      politeness: "assertive",
      role: "alert",
      text: "Assistant unavailable",
    }).length,
    1,
  );
  await dom.flush();
  assert.equal(
    matchingLiveRegions(dom.container, {
      politeness: "assertive",
      role: "alert",
      text: "Assistant unavailable",
    }).length,
    1,
  );

  await dom.change(composer, "Try again");
  await dom.click(dom.byTitle("Send message"));
  await dom.flush();
  assert.equal(
    matchingLiveRegions(dom.container, {
      politeness: "assertive",
      role: "alert",
      text: "Assistant unavailable",
    }).length,
    0,
  );
  assert.equal(
    matchingLiveRegions(dom.container, {
      politeness: "polite",
      role: "status",
      text: "Workflow assistant response complete",
    }).length,
    1,
  );

  await dom.unmount();
});

test("App shows workflow health diagnostics before running", async () => {
  const workflow = {
    ...workflowFixture({ id: "doctor", name: "Doctor" }),
    healthErrors: [
      {
        id: "workflow.provider_cli",
        severity: "error",
        subject: "codex",
        message: "Workflow requires provider CLI 'codex', but it is not on PATH.",
      },
    ],
  };
  const fetchMock = createFetchMock([
    jsonResponse("/api/doctor", {
      errors: [],
      warnings: [
        {
          id: "shell.available",
          severity: "warning",
          message: "Shell executable 'bash' is not on PATH.",
        },
      ],
    }),
    jsonResponse("/api/workflows", workflowsPayload([workflow])),
    jsonResponse("/api/workflows/doctor/logs/latest", { log: null }),
    jsonResponse("/api/workflows/doctor/logs?limit=100", { runs: [] }),
    jsonResponse("/api/workflows/doctor/approvals", { approvals: [] }),
  ]);

  const dom = await mountReact(React.createElement(appModule.default), fetchMock);

  await dom.flush();
  assert.match(dom.text(), /Environment setup needs attention/);
  assert.match(dom.text(), /Shell executable 'bash' is not on PATH/);
  assert.match(dom.text(), /Workflow requires provider CLI 'codex'/);
  assert.equal(fetchMock.calls.some((call) => call.url === "/api/doctor"), true);

  await dom.click(dom.byTitle("Hide environment warning"));
  await dom.flush();
  assert.doesNotMatch(dom.text(), /Environment setup needs attention/);
  assert.doesNotMatch(dom.text(), /Shell executable 'bash' is not on PATH/);

  await dom.unmount();
});

test("App does not show an environment notice when health checks are clean", async () => {
  const fetchMock = createFetchMock([
    jsonResponse("/api/doctor", { errors: [], warnings: [] }),
    jsonResponse("/api/workflows", workflowsPayload([
      workflowFixture({ id: "clean", name: "Clean" }),
    ])),
    jsonResponse("/api/workflows/clean/logs/latest", { log: null }),
    jsonResponse("/api/workflows/clean/logs?limit=100", { runs: [] }),
    jsonResponse("/api/workflows/clean/approvals", { approvals: [] }),
  ]);

  const dom = await mountReact(React.createElement(appModule.default), fetchMock);

  await dom.flush();
  assert.doesNotMatch(dom.text(), /Environment health checks passed/);
  assert.doesNotMatch(dom.text(), /Environment setup/);
  assert.equal(fetchMock.calls.some((call) => call.url === "/api/doctor"), true);

  await dom.unmount();
});

test("App lets users dismiss a doctor load failure warning", async () => {
  const fetchMock = createFetchMock([
    (url) => {
      if (url !== "/api/doctor") return null;
      throw new Error("Unable to reach doctor API");
    },
    jsonResponse("/api/workflows", workflowsPayload([
      workflowFixture({ id: "doctor-error", name: "Doctor Error" }),
    ])),
    jsonResponse("/api/workflows/doctor-error/logs/latest", { log: null }),
    jsonResponse("/api/workflows/doctor-error/logs?limit=100", { runs: [] }),
    jsonResponse("/api/workflows/doctor-error/approvals", { approvals: [] }),
  ]);

  const dom = await mountReact(React.createElement(appModule.default), fetchMock);

  await dom.flush();
  assert.match(dom.text(), /Unable to reach doctor API/);

  await dom.click(dom.byTitle("Hide environment warning"));
  await dom.flush();
  assert.doesNotMatch(dom.text(), /Unable to reach doctor API/);

  await dom.unmount();
});

test("DagCanvas mounted interactions create/select/edit/delete nodes, create edges, persist positions, and use folder pickers", async () => {
  let workflow = {
    ...workflowFixture({ id: "canvas", name: "Canvas", label: "Initial command" }),
    validationBindings: [
      {
        id: "binding:step:operation.command:trigger.name",
        destinationNode: "step",
        destinationField: "operation.command",
        expression: "trigger.name",
        producer: "workflow.trigger",
        sourceType: "unknown",
        destinationType: "string",
        resolutionPhase: "run-start",
        status: "optional",
        coercion: "string",
      },
    ],
  };
  const changes = [];
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      dataDir: "/workspace",
      workflow,
      onWorkflowChange(nextWorkflow) {
        workflow = nextWorkflow;
        changes.push(nextWorkflow);
      },
    }),
    createFetchMock([]),
    {
      desktop: {
        workspace: {
          getPathInfo: async () => ({ isDirectory: true, isFile: false }),
          listDirectory: async ({ currentPath }) => ({
            directory: currentPath === "/workspace/repo" ? "/workspace/repo" : "/workspace",
            parent: currentPath === "/workspace/repo" ? "/workspace" : null,
            entries: currentPath === "/workspace/repo"
              ? []
              : [{ name: "repo", path: "/workspace/repo", isDirectory: true, isFile: false }],
          }),
        },
      },
    },
  );

  await dom.flush();
  await dom.click(dom.byTitle("Add node"));
  assert.equal(changes.at(-1).nodes.length, 2);
  assert.equal(changes.at(-1).nodes[1].type, "agent");

  await dom.pointer(dom.ancestor(dom.byText("Initial command"), "ARTICLE"), "onPointerDown");
  await dom.flush();
  assert.equal(dom.byText("Node inspector").tagName, "H2");
  const nodeInspectorHeader = dom.ancestor(dom.byText("Node inspector"), "HEADER");
  assert.equal(
    allElements(nodeInspectorHeader).some(
      (element) => element.tagName === "P" && textOf(element) === workflow.nodes[0].id,
    ),
    true,
  );
  assert.equal(dom.byTitle("Hide node inspector").tagName, "BUTTON");
  const nodeInspectorTabs = allElements(dom.byLabel("Node inspector sections")).filter(
    (element) => element.getAttribute("role") === "tab",
  );
  assert.deepEqual(
    nodeInspectorTabs.map((tab) => textOf(tab)),
    ["General", "Action", "Inputs", "Run", "Edges"],
  );
  assert.equal(nodeInspectorTabs[0].getAttribute("aria-selected"), "true");
  const nodeInspectorPanel = (id) =>
    allElements(dom.container).find((element) => element.getAttribute("id") === id);
  assert.equal(nodeInspectorPanel("node-tabpanel-action").getAttribute("hidden"), "");
  assert.equal(nodeInspectorPanel("node-tabpanel-general").getAttribute("tabindex"), "0");
  assert.equal(
    nodeInspectorPanel("node-tabpanel-general").contains(dom.controlAfterLabel("Label")),
    true,
  );
  assert.equal(
    allElements(nodeInspectorPanel("node-tabpanel-general")).some(
      (element) => element.tagName === "LABEL" && textOf(element) === "ID",
    ),
    false,
  );
  assert.equal(
    nodeInspectorPanel("node-tabpanel-action").contains(dom.controlAfterLabel("Command")),
    true,
  );
  assert.equal(
    nodeInspectorPanel("node-tabpanel-inputs").textContent.includes("Source output"),
    true,
  );
  assert.equal(
    nodeInspectorPanel("node-tabpanel-run").contains(dom.controlAfterLabel("Pipe output")),
    true,
  );
  assert.equal(
    allElements(nodeInspectorPanel("node-tabpanel-edges")).some(
      (element) => element.tagName === "BUTTON" && textOf(element) === "Add edge",
    ),
    true,
  );
  assert.equal(
    nodeInspectorPanel("node-tabpanel-general").contains(dom.controlAfterLabel("Command")),
    false,
  );
  await dom.keyDown(nodeInspectorTabs[0], "ArrowRight");
  assert.equal(nodeInspectorTabs[1].getAttribute("aria-selected"), "true");
  assert.equal(nodeInspectorTabs[1].getAttribute("tabindex"), "0");
  assert.equal(document.activeElement, nodeInspectorTabs[1]);
  assert.equal(nodeInspectorPanel("node-tabpanel-general").getAttribute("hidden"), "");
  assert.equal(nodeInspectorPanel("node-tabpanel-action").getAttribute("hidden"), null);
  assert.equal(
    allElements(dom.container).some(
      (element) => element.tagName === "BUTTON" && element.contains(dom.byText("Node inspector")),
    ),
    false,
  );
  assert.match(dom.text(), /operation\.commandoptional/);
  assert.match(dom.text(), /trigger\.name from workflow\.trigger/);

  await dom.click(dom.byTitle("Hide node inspector"));
  await dom.click(dom.byTitle("Show workflow settings and node inspector"));
  assert.equal(dom.byText("Workflow settings").tagName, "H2");
  assert.doesNotMatch(
    dom.ancestor(dom.byText("Initial command"), "ARTICLE").getAttribute("class"),
    /border-indigo-500|ring-indigo-100/,
  );

  await dom.pointer(dom.ancestor(dom.byText("Initial command"), "ARTICLE"), "onPointerDown");
  await dom.flush();
  await dom.change(dom.controlAfterLabel("Command"), "echo edited");
  assert.equal(changes.at(-1).nodes[0].operation.command, "echo edited");

  await dom.click(dom.byTitle("Choose working directory"));
  await dom.flush();
  await dom.click(dom.ancestor(dom.byText("repo"), "BUTTON"));
  await dom.flush();
  await dom.click(dom.byText("Choose current folder"));
  assert.equal(changes.at(-1).nodes[0].operation.working_dir, "/workspace/repo");

  const nodeCard = dom.ancestor(dom.byText("Initial command"), "ARTICLE");
  await dom.pointer(nodeCard, "onPointerDown", { clientX: 10, clientY: 10, pointerId: 7 });
  await dom.pointer(nodeCard, "onPointerMove", { clientX: 35, clientY: 45, movementX: 25, movementY: 35, pointerId: 7 });
  await dom.pointer(nodeCard, "onPointerUp", { clientX: 35, clientY: 45, pointerId: 7 });
  assert.equal(changes.at(-1).nodes[0].x, 25);
  assert.equal(changes.at(-1).nodes[0].y, 35);

  await dom.click(dom.byText("Add edge"));
  await dom.change(dom.selectWithOption("node-1"), "node-1");
  assert.equal(changes.at(-1).edges[0].from, "step");
  assert.equal(changes.at(-1).edges[0].to, "node-1");

  await dom.pointer(nodeCard, "onPointerDown", { button: 2, clientX: 80, clientY: 90, pointerId: 8 });
  await dom.pointer(nodeCard, "onContextMenu", { button: 2, clientX: 80, clientY: 90 });
  await dom.click(dom.byText("Duplicate node"));
  assert.equal(changes.at(-1).nodes.length, 3);
  assert.equal(changes.at(-1).nodes.at(-1).label, "Initial command copy");
  assert.equal(changes.at(-1).nodes.at(-1).x, 53);
  assert.equal(changes.at(-1).nodes.at(-1).y, 63);

  await dom.pointer(
    dom.ancestor(dom.byText("Initial command copy"), "ARTICLE"),
    "onContextMenu",
    { button: 2, clientX: 90, clientY: 100 },
  );
  await dom.click(dom.byText("Rename node"));
  await dom.change(dom.controlAfterLabel("Node label"), "Renamed command");
  await dom.pointer(dom.ancestor(dom.byTitle("Confirm node rename"), "FORM"), "onSubmit");
  assert.equal(changes.at(-1).nodes.at(-1).label, "Renamed command");

  await dom.pointer(
    dom.ancestor(dom.byText("Renamed command"), "ARTICLE"),
    "onContextMenu",
    { button: 2, clientX: 90, clientY: 100 },
  );
  await dom.click(dom.byText("Delete node"));
  assert.equal(changes.at(-1).nodes.some((node) => node.label === "Renamed command"), false);

  await dom.pointer(dom.ancestor(dom.byText("Initial command"), "ARTICLE"), "onContextMenu", {
    button: 2,
    clientX: 80,
    clientY: 90,
  });
  await dom.click(dom.byText("Delete node"));
  assert.equal(changes.at(-1).nodes.some((node) => node.id === "step"), false);
  assert.deepEqual(changes.at(-1).edges, []);

  await dom.unmount();
});

test("graph outline supports the complete keyboard node and edge editing flow", async () => {
  let workflow = {
    ...workflowFixture({ id: "keyboard-graph", label: "Collect input" }),
    nodes: [
      {
        id: "collect",
        type: "bash_command",
        label: "Collect input",
        x: 0,
        y: 0,
        operation: { type: "bash_command", command: "echo input" },
      },
      {
        id: "review",
        type: "agent",
        label: "Review input",
        x: 320,
        y: 0,
        operation: { type: "agent", agent_id: "reviewer", prompt: "Review" },
      },
    ],
    edges: [],
  };
  const changes = [];
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      workflow,
      onWorkflowChange(nextWorkflow) {
        workflow = nextWorkflow;
        changes.push(nextWorkflow);
      },
    }),
    createFetchMock([]),
  );

  await dom.click(dom.byTitle("Map"));
  const outline = dom.byLabel("Graph outline");
  const nodeButtons = () => allElements(outline).filter(
    (element) => element.tagName === "BUTTON" && element.getAttribute("aria-label")?.includes("status"),
  );
  assert.equal(nodeButtons().length, 2);
  assert.match(nodeButtons()[0].getAttribute("aria-label"), /0 incoming; 0 outgoing, valid/);

  await dom.focus(nodeButtons()[0]);
  assert.equal(nodeButtons()[0].getAttribute("aria-current"), "true");
  await dom.keyDown(nodeButtons()[0], "c");
  assert.match(dom.text(), /Connecting from Collect input/);
  await dom.keyDown(nodeButtons()[1], "Enter");
  assert.equal(changes.at(-1).edges[0].from, "collect");
  assert.equal(changes.at(-1).edges[0].to, "review");

  const edgeButton = allElements(outline).find(
    (element) => element.tagName === "BUTTON" && element.getAttribute("aria-label")?.startsWith("Collect input to Review input"),
  );
  assert.ok(edgeButton);
  assert.match(edgeButton.getAttribute("aria-label"), /condition always, valid/);
  assert.equal(document.activeElement, edgeButton);
  assert.equal(edgeButton.getAttribute("aria-current"), "true");
  await dom.keyDown(document.activeElement, "Delete");
  assert.deepEqual(changes.at(-1).edges, []);
  assert.equal(document.activeElement, nodeButtons()[0]);
  assert.equal(nodeButtons()[0].getAttribute("aria-current"), "true");

  await dom.keyDown(document.activeElement, "d", { ctrlKey: true });
  assert.equal(changes.at(-1).nodes.length, 3);
  assert.equal(changes.at(-1).nodes.at(-1).label, "Collect input copy");

  const duplicatedButton = nodeButtons().find((button) =>
    button.getAttribute("aria-label")?.startsWith("Collect input copy"),
  );
  assert.equal(document.activeElement, duplicatedButton);
  assert.equal(duplicatedButton.getAttribute("aria-current"), "true");
  await dom.keyDown(document.activeElement, "Delete");
  assert.equal(changes.at(-1).nodes.some((node) => node.label === "Collect input copy"), false);
  assert.equal(document.activeElement.getAttribute("aria-label")?.startsWith("Review input,"), true);
  assert.equal(document.activeElement.getAttribute("aria-current"), "true");

  await dom.unmount();
});

test("edge inspector displays and edits structured-output field relationships", async () => {
  let workflow = {
    ...workflowFixture({ id: "structured-edge", label: "Analyze request" }),
    nodes: [
      {
        id: "analyze",
        type: "agent",
        label: "Analyze request",
        x: 0,
        y: 0,
        operation: { type: "agent", agent_id: "analyzer", prompt: "Analyze" },
      },
      {
        id: "format-high",
        type: "bash_command",
        label: "Format high priority",
        x: 320,
        y: 0,
        operation: { type: "bash_command", command: "printf HIGH" },
      },
    ],
    edges: [
      {
        id: "analyze-format-high",
        from: "analyze",
        to: "format-high",
        condition: "output_field",
        field: "priority",
        operator: "equals",
        value: "high",
        label: 'priority equals "high"',
      },
    ],
  };
  const changes = [];
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      workflow,
      onWorkflowChange(nextWorkflow) {
        workflow = nextWorkflow;
        changes.push(nextWorkflow);
      },
    }),
    createFetchMock([]),
  );

  await dom.click(dom.byTitle("Map"));
  const edgeButton = allElements(dom.byLabel("Graph outline")).find(
    (element) => element.tagName === "BUTTON"
      && element.getAttribute("aria-label")?.startsWith("Analyze request to Format high priority"),
  );
  assert.ok(edgeButton);
  await dom.click(edgeButton);

  const edgeInspector = dom.ancestor(dom.byText("Edge inspector"), "SECTION");
  const inspectorControl = (labelText) => {
    const label = allElements(edgeInspector).find(
      (element) => element.tagName === "LABEL" && textOf(element).includes(labelText),
    );
    assert.ok(label, `Unable to find edge inspector label: ${labelText}`);
    const control = allElements(label).find((element) =>
      ["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName),
    );
    assert.ok(control, `Unable to find edge inspector control: ${labelText}`);
    return control;
  };
  const selectedValue = (select) =>
    [...select.options].find((option) => option.selected)?.value ?? "";

  const typeControl = inspectorControl("Type");
  assert.deepEqual(
    [...typeControl.options].map((option) => option.value),
    ["always", "on_success", "on_failure", "output_matches", "output_field", "after_loop"],
  );
  assert.equal(selectedValue(typeControl), "output_field");
  assert.equal(inspectorControl("Field").value, "priority");
  assert.equal(selectedValue(inspectorControl("Operator")), "equals");
  assert.equal(inspectorControl("Comparison value (JSON)").value, '"high"');

  await dom.change(inspectorControl("Field"), "result.priority");
  assert.equal(changes.at(-1).edges[0].field, "result.priority");
  assert.equal(changes.at(-1).edges[0].label, 'result.priority equals "high"');

  await dom.change(inspectorControl("Operator"), "exists");
  assert.equal(changes.at(-1).edges[0].operator, "exists");
  assert.equal(changes.at(-1).edges[0].label, "result.priority exists");
  assert.doesNotMatch(dom.text(), /Comparison value \(JSON\)/);

  await dom.unmount();
});

test("START nodes open the same tabbed node inspector as every other node type", async () => {
  const workflow = {
    ...workflowFixture({ id: "start-inspector" }),
    nodes: [
      {
        id: "start",
        type: "start",
        label: "START",
        x: 0,
        y: 0,
        operation: { type: "start" },
      },
    ],
  };
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, { workflow, onWorkflowChange() {} }),
    createFetchMock([]),
  );

  await dom.pointer(dom.ancestor(dom.byText("START"), "ARTICLE"), "onPointerDown");
  await dom.flush();

  assert.equal(dom.byText("Node inspector").tagName, "H2");
  assert.equal(dom.byLabel("Node inspector sections").getAttribute("role"), "tablist");
  await dom.click(dom.byText("Action"));
  assert.match(dom.text(), /This node does no work/);
  const actionPanel = allElements(dom.container).find(
    (element) => element.getAttribute("id") === "node-tabpanel-action",
  );
  assert.equal(actionPanel.getAttribute("tabindex"), "0");
  await dom.focus(actionPanel);
  assert.equal(document.activeElement, actionPanel);

  await dom.unmount();
});

test("pane separators expose values and support arrow, boundary, and reset keys", async () => {
  const canvasDom = await mountReact(
    React.createElement(DagCanvasHarness, {
      workflow: workflowFixture({ id: "resizers" }),
      onWorkflowChange() {},
    }),
    createFetchMock([]),
  );
  await canvasDom.click(canvasDom.byTitle("Show workflow settings and node inspector"));
  const inspectorResizer = canvasDom.byLabel("Resize workflow settings and node inspector");
  assert.equal(inspectorResizer.getAttribute("role"), "separator");
  assert.equal(inspectorResizer.getAttribute("aria-orientation"), "vertical");
  assert.equal(inspectorResizer.getAttribute("aria-valuemin"), "280");
  assert.equal(inspectorResizer.getAttribute("aria-valuemax"), "520");
  assert.equal(inspectorResizer.getAttribute("aria-valuenow"), "340");
  await canvasDom.keyDown(inspectorResizer, "ArrowRight");
  assert.equal(inspectorResizer.getAttribute("aria-valuenow"), "350");
  await canvasDom.keyDown(inspectorResizer, "End");
  assert.equal(inspectorResizer.getAttribute("aria-valuenow"), "520");
  await canvasDom.keyDown(inspectorResizer, "Enter");
  assert.equal(inspectorResizer.getAttribute("aria-valuenow"), "340");

  await canvasDom.click(canvasDom.byTitle("Expand log"));
  const logResizer = canvasDom.byLabel("Resize workflow log");
  assert.equal(logResizer.getAttribute("aria-orientation"), "horizontal");
  await canvasDom.keyDown(logResizer, "ArrowUp");
  assert.equal(logResizer.getAttribute("aria-valuenow"), "250");
  await canvasDom.keyDown(logResizer, "Home");
  assert.equal(logResizer.getAttribute("aria-valuenow"), "140");
  await canvasDom.unmount();

  const appDom = await mountReact(
    React.createElement(appModule.default),
    createFetchMock([
      jsonResponse("/api/workflows", workflowsPayload([workflowFixture()])),
    ]),
  );
  await appDom.flush();
  const workflowsResizer = appDom.byLabel("Resize workflows pane");
  const chatResizer = appDom.byLabel("Resize chat pane");
  assert.equal(workflowsResizer.getAttribute("aria-valuenow"), "272");
  await appDom.keyDown(workflowsResizer, "ArrowRight", { shiftKey: true });
  assert.equal(workflowsResizer.getAttribute("aria-valuenow"), "312");
  await appDom.keyDown(workflowsResizer, "Enter");
  assert.equal(workflowsResizer.getAttribute("aria-valuenow"), "272");
  assert.equal(chatResizer.getAttribute("aria-valuemin"), "300");
  await appDom.keyDown(chatResizer, "ArrowLeft");
  assert.equal(chatResizer.getAttribute("aria-valuenow"), "370");
  await appDom.unmount();
});

test("inspector parsed fields keep drafts stable and commit or restore consistently", async () => {
  const changes = { keyValue: [], list: [], number: [], path: [] };
  const dom = await mountReact(
    React.createElement(InspectorDraftHarness, { changes }),
    createFetchMock([]),
  );

  const number = dom.controlAfterLabel("Draft number");
  await dom.focus(number);
  await dom.change(number, "");
  assert.equal(number.value, "");
  assert.deepEqual(changes.number, []);
  await dom.change(number, "-");
  assert.equal(number.value, "-");
  assert.match(dom.text(), /Enter a complete number/);
  await dom.change(number, "-2.5");
  assert.deepEqual(changes.number, []);
  await dom.blur(number);
  assert.deepEqual(changes.number, [-2.5]);

  await dom.focus(number);
  await dom.change(number, "4.");
  assert.equal(number.value, "4.");
  await dom.keyDown(number, "Escape");
  assert.equal(number.value, "-2.5");
  assert.deepEqual(changes.number, [-2.5]);
  await dom.change(number, "3.75");
  await dom.keyDown(number, "Enter");
  assert.deepEqual(changes.number, [-2.5, 3.75]);
  assert.doesNotMatch(dom.text(), /changed elsewhere.*draft is preserved/i);

  await dom.change(number, "-");
  await dom.click(dom.byText("Update number externally"));
  assert.equal(number.value, "-");
  assert.match(dom.text(), /Enter a complete number/);
  assert.match(dom.text(), /changed elsewhere.*draft is preserved/i);
  await dom.keyDown(number, "Escape");
  assert.equal(number.value, "11");

  const list = dom.controlAfterLabel("Draft list");
  await dom.focus(list);
  await dom.change(list, "alpha, beta,");
  assert.equal(list.value, "alpha, beta,");
  assert.deepEqual(changes.list, []);
  await dom.blur(list);
  assert.deepEqual(changes.list, [["alpha", "beta"]]);
  assert.equal(list.value, "alpha, beta");
  await dom.focus(list);
  await dom.change(list, "gamma, delta");
  await dom.keyDown(list, "Enter");
  assert.deepEqual(changes.list.at(-1), ["gamma", "delta"]);
  await dom.change(list, "temporary,");
  await dom.keyDown(list, "Escape");
  assert.equal(list.value, "gamma, delta");
  assert.deepEqual(changes.list, [["alpha", "beta"], ["gamma", "delta"]]);

  const keyValue = dom.controlAfterLabel("Draft key/value");
  await dom.focus(keyValue);
  await dom.change(keyValue, "TOKEN");
  assert.equal(keyValue.value, "TOKEN");
  assert.match(dom.text(), /Line 1 needs an “=”/);
  await dom.blur(keyValue);
  assert.deepEqual(changes.keyValue, []);
  assert.equal(keyValue.value, "TOKEN");
  await dom.focus(keyValue);
  await dom.change(keyValue, "TOKEN=secret\nMODE=");
  await dom.keyDown(keyValue, "Enter");
  assert.deepEqual(changes.keyValue, [{ TOKEN: "secret", MODE: "" }]);
  await dom.change(keyValue, "BROKEN");
  await dom.keyDown(keyValue, "Escape");
  assert.equal(keyValue.value, "TOKEN=secret\nMODE=");

  const pathInput = dom.controlAfterLabel("Draft path");
  assert.equal(pathInput.value, "scripts/run.sh");
  assert.equal(pathInput.getAttribute("title"), "/workspace/scripts/run.sh");
  await dom.focus(pathInput);
  await dom.change(pathInput, "");
  await dom.change(pathInput, "scripts/next.sh");
  assert.equal(pathInput.value, "scripts/next.sh");
  assert.deepEqual(changes.path, []);
  await dom.blur(pathInput);
  assert.deepEqual(changes.path, ["scripts/next.sh"]);
  assert.equal(pathInput.value, "scripts/next.sh");
  await dom.focus(pathInput);
  await dom.change(pathInput, "scripts/entered.sh");
  await dom.keyDown(pathInput, "Enter");
  assert.deepEqual(changes.path, ["scripts/next.sh", "scripts/entered.sh"]);
  assert.equal(pathInput.value, "scripts/entered.sh");
  assert.doesNotMatch(dom.text(), /changed elsewhere.*draft is preserved/i);
  await dom.change(pathInput, "scripts/cancelled.sh");
  await dom.keyDown(pathInput, "Escape");
  assert.equal(pathInput.value, "scripts/entered.sh");
  assert.deepEqual(changes.path, ["scripts/next.sh", "scripts/entered.sh"]);

  await dom.unmount();
});

test("DagCanvas renders pending approvals as a centered graph overlay", async () => {
  const workflow = {
    ...workflowFixture({ id: "approval-canvas", name: "Approval Canvas" }),
    nodes: [
      {
        id: "approve",
        type: "approval_gate",
        label: "Review deployment",
        x: 0,
        y: 0,
        operation: { type: "approval_gate", message: "Approve deployment?" },
      },
    ],
  };
  const decisions = [];
  const approval = {
    workflowId: "approval-canvas",
    runId: "run.log",
    nodeId: "approve",
    message: "Approve deployment?",
    status: "pending",
    approvers: ["ops"],
    requestedAt: "2026-06-25T12:00:00-04:00",
    timeoutSeconds: null,
    timeoutDecision: "timeout",
    decision: null,
  };
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      approvalState: { approvals: [approval], error: "", loading: false },
      dataDir: "/workspace",
      workflow,
      onDecideApproval(nextApproval, decision, notes, approver) {
        decisions.push({ approval: nextApproval, decision, notes, approver });
      },
      onWorkflowChange() {},
    }),
    createFetchMock([]),
  );

  await dom.flush();
  const approvalDialog = allElements(dom.container).find(
    (element) => element.getAttribute?.("role") === "dialog",
  );
  assert.ok(approvalDialog);
  assert.equal(approvalDialog.getAttribute("aria-modal"), "true");
  assert.ok(dom.byText("Approval Required"));
  assert.ok(dom.byText("Review deployment"));
  const approvalMessage = allElements(dom.container).find(
    (element) =>
      element.textContent === "Approve deployment?" &&
      /\btext-ink\b/.test(element.getAttribute?.("class") ?? ""),
  );
  assert.ok(approvalMessage);
  assert.doesNotMatch(approvalMessage.getAttribute("class"), /\btext-slate-800\b/);

  await dom.change(dom.controlAfterLabel("Notes"), "ship it");
  await dom.click(dom.byTitle("Approve pending approval"));

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].approval, approval);
  assert.equal(decisions[0].decision, "approved");
  assert.equal(decisions[0].notes, "ship it");
  assert.equal(decisions[0].approver, "ops");

  await dom.unmount();
});

test("DagCanvas renders inline agent health warnings in the inspector", async () => {
  const workflow = {
    ...workflowFixture({ id: "agent-health", name: "Agent Health", label: "Review" }),
    agents: {
      reviewer: {
        subscription: "codex",
        working_dir: ".",
      },
    },
    healthErrors: [
      {
        id: "workflow.provider_cli",
        severity: "error",
        subject: "codex",
        message: "Workflow requires provider CLI 'codex', but it is not on PATH.",
      },
    ],
    nodes: [
      {
        id: "review",
        type: "agent",
        label: "Review",
        x: 0,
        y: 0,
        operation: {
          type: "agent",
          agent_id: "reviewer",
          working_dir: ".",
        },
      },
    ],
  };

  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      dataDir: "/workspace",
      workflow,
      onWorkflowChange() {},
    }),
    createFetchMock([]),
  );

  await dom.flush();
  await dom.pointer(dom.ancestor(dom.byText("Review"), "ARTICLE"), "onPointerDown");
  await dom.flush();

  assert.match(dom.text(), /Agent config/);
  assert.match(dom.text(), /Workflow requires provider CLI 'codex'/);

  await dom.unmount();
});

test("DagCanvas edits named structured-output schemas without mounting an eager textarea", async () => {
  const changes = [];
  const workflow = workflowFixture({ id: "schemas", name: "Schemas" });
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      dataDir: "/workspace",
      workflow,
      onWorkflowChange(nextWorkflow) {
        changes.push(nextWorkflow);
      },
    }),
    createFetchMock([]),
  );

  await dom.flush();
  assert.equal(
    allElements(dom.container).filter((element) => element.tagName === "TEXTAREA").length,
    0,
  );
  await dom.click(dom.byText("Variables"));
  await dom.flush();
  const schemaEditor = dom.controlAfterLabel("Named output schemas (JSON object)");
  await dom.focus(schemaEditor);
  await dom.change(schemaEditor, "");
  assert.equal(schemaEditor.value, "");
  assert.deepEqual(changes, []);
  await dom.change(
    schemaEditor,
    '{"review_result":{"type":"object","properties":{"verdict":{"type":"string"}}}}',
  );
  assert.deepEqual(changes, []);
  await dom.blur(schemaEditor);

  assert.deepEqual(changes.at(-1).outputSchemas, {
    review_result: {
      type: "object",
      properties: { verdict: { type: "string" } },
    },
  });
  await dom.unmount();
});

test("DagCanvas renders structured run timeline and selected node details", async () => {
  const workflow = workflowFixture({ id: "timeline", name: "Timeline", label: "Run command" });
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      dataDir: "/workspace",
      workflow,
      logState: {
        loading: false,
        error: "",
        text: "legacy log",
        path: "logs/timeline/run.log",
        runs: [],
        runEvents: [
          {
            nodeId: "step",
            status: "started",
            attempt: 1,
            occurredAt: "2026-01-02T03:04:05Z",
            message: "attempt 1 started",
            fanOutItem: { index: "0" },
          },
          {
            nodeId: "step",
            status: "completed",
            attempt: 1,
            occurredAt: "2026-01-02T03:04:06Z",
            message: "attempt 1 finished success=true exit_code=0",
          },
          {
            nodeId: "step",
            status: "reused",
            occurredAt: "2026-01-02T03:04:07Z",
            message: "reused output from resumed run",
          },
        ],
        runNodes: {
          step: {
            nodeId: "step",
            status: "completed",
            durationSeconds: 0.25,
            exitCode: 0,
            attempts: [
              {
                attempt: 1,
                runNumber: 1,
                durationSeconds: 0.25,
                fanOutItem: { index: "0" },
                inputs: { stdin: "hello" },
                output: "ok",
              },
              {
                attempt: 1,
                runNumber: 2,
                durationSeconds: 0.1,
                fanOutItem: { index: "1" },
                inputs: { stdin: "bad" },
                output: "bad item",
                stderr: "stderr detail",
                prompt: "rendered prompt",
              },
            ],
            data: {
              reused: true,
              message: "agent summary message",
              fanOut: {
                itemCount: 2,
                successCount: 1,
                failureCount: 1,
                items: [
                  { index: 0, status: "completed", output: "ok", durationSeconds: 0.25 },
                  {
                    index: 1,
                    status: "failed",
                    output: "bad item",
                    error: "bad item",
                    durationSeconds: 0.1,
                    exitCode: 1,
                  },
                ],
              },
              edgeDecisions: [
                { from: "step", to: "next", condition: "on_success", matched: true },
              ],
            },
          },
        },
        usageSummary: {
          totals: {
            agent_calls: 2,
            total_tokens: 321,
            estimated_cost: 0.012345,
            agent_time_seconds: 1.5,
          },
          most_expensive_nodes: [
            { node_id: "step", estimated_cost: 0.012345, duration_seconds: 1.5 },
          ],
          slowest_nodes: [
            { node_id: "step", estimated_cost: 0.012345, duration_seconds: 1.5 },
          ],
        },
      },
      onWorkflowChange() {},
    }),
    createFetchMock([]),
  );

  await dom.flush();
  assert.match(dom.text(), /Run timeline/);
  assert.match(dom.text(), /LLM usage/);
  assert.match(dom.text(), /321 tokens/);
  assert.match(dom.text(), /Most expensive: step/);
  assert.match(dom.text(), /completed/);
  await dom.pointer(dom.ancestor(dom.byText("Run command"), "ARTICLE"), "onPointerDown");
  await dom.flush();
  assert.match(dom.text(), /Last run/);
  assert.match(dom.text(), /ReusedYes/);
  assert.ok(dom.byTitle("reused"));
  assert.match(dom.text(), /0\.25s/);
  assert.match(dom.text(), /agent summary message/);
  assert.match(dom.text(), /Fan-out items/);
  assert.match(dom.text(), /1: failed/);
  assert.match(dom.text(), /Iteration 1 - Attempt 1/);
  assert.match(dom.text(), /Outputok/);
  await dom.click(dom.byText("Next"));
  assert.match(dom.text(), /Iteration 2 - Attempt 1/);
  assert.match(dom.text(), /OutputStderrPromptbad item/);
  await dom.click(dom.byTitle("Show Stderr"));
  assert.match(dom.text(), /stderr detail/);
  await dom.click(dom.byTitle("Show Prompt"));
  assert.match(dom.text(), /rendered prompt/);
  assert.match(dom.text(), /step -> next/);

  await dom.unmount();
});

test("DagCanvas run history exposes resume and rerun controls", async () => {
  const resumeCalls = [];
  const workflow = workflowFixture({ id: "history-actions", name: "History actions" });
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      dataDir: "/workspace",
      workflow,
      logState: {
        loading: false,
        error: "",
        text: "failed run",
        path: "logs/history-actions/run-1.log",
        runs: [{ id: "run-1.log", status: "error", startedAt: "2026-01-02T03:04:05Z" }],
        selectedRunId: "run-1.log",
      },
      onResumeRunLog(runId, options) {
        resumeCalls.push({ runId, options });
      },
      onWorkflowChange() {},
    }),
    createFetchMock([]),
  );

  await dom.flush();
  await dom.click(dom.byTitle("Select workflow run"));
  assert.match(dom.text(), /Resume/);
  assert.match(dom.text(), /Rerun failed nodes/);
  assert.match(dom.text(), /Rerun from selected node/);

  await dom.click(dom.ancestor(dom.byText("Resume"), "BUTTON"));
  await dom.click(dom.ancestor(dom.byText("Rerun failed nodes"), "BUTTON"));

  await dom.pointer(dom.ancestor(dom.byText("Run command"), "ARTICLE"), "onPointerDown");
  await dom.flush();
  await dom.click(dom.ancestor(dom.byText("Rerun from selected node"), "BUTTON"));

  assert.deepEqual(resumeCalls, [
    { runId: "run-1.log", options: {} },
    { runId: "run-1.log", options: { skipCache: true } },
    { runId: "run-1.log", options: { fromNode: "step" } },
  ]);

  await dom.unmount();
});

test("DagCanvas surfaces webhook trigger state and replay controls", async () => {
  const replayCalls = [];
  const workflow = {
    ...workflowFixture({ id: "hooked", name: "Hooked" }),
    webhooks: {
      github: {
        id: "github",
        enabled: true,
        source: "github",
        fanout_path: "payload.items",
        tokenConfigured: true,
        concurrency_policy: "reject_if_running",
      },
    },
  };
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      dataDir: "/workspace",
      workflow,
      logState: {
        loading: false,
        error: "",
        text: "webhook run",
        path: "logs/hooked/run-1.log",
        runs: [
          {
            id: "run-1.log",
            status: "success",
            startedAt: "2026-01-02T03:04:05Z",
            triggerId: "github",
            triggerType: "webhook",
            hasTriggerReplay: true,
          },
        ],
        selectedRunId: "run-1.log",
      },
      onReplayRunLog(runId, triggerId) {
        replayCalls.push({ runId, triggerId });
      },
      onWorkflowChange() {},
    }),
    createFetchMock([]),
  );

  await dom.click(dom.byText("Triggers"));

  await dom.flush();
  assert.match(dom.text(), /API trigger: github \(github\)/);
  assert.match(dom.text(), /Webhook\/API triggers/);
  assert.match(dom.text(), /Token required/);

  await dom.click(dom.byTitle("Select workflow run"));
  await dom.click(dom.ancestor(dom.byText("Replay webhook payload"), "BUTTON"));
  assert.deepEqual(replayCalls, [{ runId: "run-1.log", triggerId: "github" }]);

  await dom.unmount();
});

test("DagCanvas exposes invocation bindings for triggers and child calls", async () => {
  const workflow = {
    ...workflowFixture({ id: "bindings", name: "Bindings" }),
    schedule: { cron_expression: "0 9 * * *", timezone: "UTC", inputs: {} },
    watch: {
      path: "/workspace/inbox",
      glob: "*",
      recursive: false,
      debounce_seconds: 1,
      mode: "batch",
      max_concurrency: 1,
      inputs: {},
    },
    webhooks: {
      default: {
        id: "default",
        enabled: true,
        source: "webhook",
        input_bindings: {},
      },
    },
    nodes: [
      {
        id: "call-workflow",
        label: "Call workflow",
        type: "workflow",
        operation: canvasModule.defaultOperation("workflow"),
        settings: {},
        x: 0,
        y: 0,
      },
      {
        id: "call-subflow",
        label: "Call subflow",
        type: "subflow",
        operation: canvasModule.defaultOperation("subflow"),
        settings: {},
        x: 260,
        y: 0,
      },
    ],
    edges: [],
  };
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      dataDir: "/workspace",
      workflow,
      onWorkflowChange() {},
    }),
    createFetchMock([]),
  );

  await dom.click(dom.byText("Triggers"));

  await dom.flush();
  assert.ok((dom.text().match(/Invocation inputs \(JSON object\)/g) ?? []).length >= 2);
  assert.match(dom.text(), /Input bindings \(JSON object\)/);

  await dom.pointer(dom.ancestor(dom.byText("Call workflow"), "ARTICLE"), "onPointerDown");
  await dom.flush();
  assert.match(dom.text(), /Workflow ID/);
  assert.match(dom.text(), /Input bindings \(JSON object or quoted exact reference\)/);
  assert.match(dom.text(), /called workflow’s immutable inputs/);

  await dom.pointer(dom.ancestor(dom.byText("Call subflow"), "ARTICLE"), "onPointerDown");
  await dom.flush();
  assert.match(dom.text(), /Component ID/);
  assert.match(dom.text(), /Declared outputs \(JSON object\)/);

  await dom.unmount();
});

test("DagCanvas notification editor exposes every delivery channel configuration", async () => {
  const workflow = {
    ...workflowFixture({ id: "notifications", name: "Notifications" }),
    nodes: [
      {
        id: "notify",
        label: "Notify operators",
        type: "notification",
        operation: canvasModule.defaultOperation("notification"),
        settings: {},
        x: 0,
        y: 0,
      },
    ],
  };
  const changes = [];
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      dataDir: "/workspace",
      workflow,
      onWorkflowChange(nextWorkflow) {
        changes.push(nextWorkflow);
      },
    }),
    createFetchMock([]),
  );

  await dom.pointer(dom.ancestor(dom.byText("Notify operators"), "ARTICLE"), "onPointerDown");
  await dom.change(dom.controlAfterLabel("Channel"), "email");
  await dom.flush();
  assert.ok(dom.controlAfterLabel("From address"));
  assert.ok(dom.controlAfterLabel("Recipients"));
  assert.ok(dom.controlAfterLabel("SMTP host"));
  assert.ok(dom.controlAfterLabel("SMTP password or secret reference"));
  assert.ok(dom.controlAfterLabel("Use STARTTLS"));
  assert.ok(dom.controlAfterLabel("Network allowlist"));

  await dom.change(dom.controlAfterLabel("Channel"), "webhook");
  await dom.flush();
  assert.ok(dom.controlAfterLabel("Webhook URL"));
  assert.ok(dom.controlAfterLabel("Headers"));
  assert.ok(dom.controlAfterLabel("Payload (JSON)"));
  assert.equal(changes.at(-1).nodes[0].operation.channel, "webhook");

  await dom.change(dom.controlAfterLabel("Channel"), "__runtime_reference__");
  await dom.flush();
  const channelReference = dom.controlAfterLabel("Channel reference");
  assert.equal(channelReference.value, "{{inputs.value}}");
  await dom.focus(channelReference);
  await dom.change(channelReference, "{{inputs.channel}}");
  await dom.blur(channelReference);
  assert.equal(changes.at(-1).nodes[0].operation.channel, "{{inputs.channel}}");

  await dom.unmount();
});

test("number fields accept exact runtime references only when enabled", () => {
  assert.deepEqual(canvasModule.parseNumberDraft("{{inputs.timeout}}", 0, true), {
    ok: true,
    value: "{{inputs.timeout}}",
  });
  assert.equal(canvasModule.parseNumberDraft("{{inputs.timeout}}", 0).ok, false);
  assert.equal(canvasModule.parseNumberDraft("{{inputs.timeout}} trailing", 0, true).ok, false);
});

test("DagCanvas authors runtime generic fan-out settings", async () => {
  const workflow = {
    ...workflowFixture({ id: "runtime-fields", name: "Runtime fields" }),
    nodes: [
      {
        id: "fan",
        label: "Fan items",
        type: "pass",
        operation: canvasModule.defaultOperation("pass"),
        settings: {},
        x: 0,
        y: 0,
      },
    ],
  };
  const changes = [];
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      dataDir: "/workspace",
      workflow,
      onWorkflowChange(nextWorkflow) {
        changes.push(nextWorkflow);
      },
    }),
    createFetchMock([]),
  );

  await dom.pointer(dom.ancestor(dom.byText("PASS"), "ARTICLE"), "onPointerDown");
  await dom.change(dom.controlAfterLabel("For each"), "{{inputs.items}}");
  await dom.flush();
  const concurrency = dom.controlAfterLabel("Fan-out max concurrency");
  await dom.focus(concurrency);
  await dom.change(concurrency, "{{inputs.workers}}");
  await dom.blur(concurrency);
  await dom.click(dom.byText("Use an exact runtime reference"));
  await dom.flush();
  const failFast = dom.controlAfterLabel("Fan-out fail fast reference");
  await dom.focus(failFast);
  await dom.change(failFast, "{{inputs.stop_early}}");
  await dom.blur(failFast);
  assert.equal(changes.at(-1).nodes[0].settings.forEach, "{{inputs.items}}");
  assert.equal(changes.at(-1).nodes[0].settings.maxConcurrency, "{{inputs.workers}}");
  assert.equal(changes.at(-1).nodes[0].settings.failFast, "{{inputs.stop_early}}");

  await dom.unmount();
});

test("DagCanvas retention controls send configured cleanup settings", async () => {
  const pruneCalls = [];
  const settingsChanges = [];
  const workflow = workflowFixture({ id: "history-actions", name: "History actions" });
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      dataDir: "/workspace",
      workflow,
      retentionSettings: { keepDays: 7, keepFailedDays: 21, keepLast: 50 },
      logState: {
        loading: false,
        error: "",
        text: "completed run",
        path: "logs/history-actions/run-1.log",
        runs: [{ id: "run-1.log", status: "success", startedAt: "2026-01-02T03:04:05Z" }],
      },
      onPruneRunLogs(options) {
        pruneCalls.push(options);
      },
      onRetentionSettingsChange(nextSettings) {
        settingsChanges.push(nextSettings);
      },
      onWorkflowChange() {},
    }),
    createFetchMock([]),
  );

  await dom.flush();
  await dom.click(dom.byTitle("Expand log"));
  await dom.click(dom.byTitle("Run retention settings"));
  await dom.change(dom.controlAfterLabel("Keep latest runs"), "25");
  await dom.change(dom.controlAfterLabel("Keep runs for days"), "5");
  await dom.change(dom.controlAfterLabel("Keep failed runs for days"), "12");
  const previewButton = allElements(dom.container).find(
    (node) => node.tagName === "BUTTON" && directText(node) === "Preview",
  );
  assert.ok(previewButton, "Unable to find retention preview button");
  await dom.click(previewButton);

  assert.deepEqual(settingsChanges, [
    { keepDays: 7, keepFailedDays: 21, keepLast: 25 },
    { keepDays: 5, keepFailedDays: 21, keepLast: 25 },
    { keepDays: 5, keepFailedDays: 12, keepLast: 25 },
  ]);
  assert.deepEqual(pruneCalls, [
    { dryRun: true, keepDays: 5, keepFailedDays: 12, keepLast: 25 },
  ]);

  await dom.unmount();
});

test("Electron main IPC contract registers real handlers and invokes the wired implementation", async () => {
  const { ipcHandlerDefinitions, registerIpcHandlers } = require("../../electron/ipc-handlers.cjs");
  const registered = new Map();
  const calls = [];
  const wrapped = [];
  const handlers = Object.fromEntries(
    ipcHandlerDefinitions.map(([, handlerName]) => [
      handlerName,
      async (_event, payload) => {
        calls.push({ handlerName, payload });
        return { handlerName, payload };
      },
    ]),
  );

  registerIpcHandlers(
    { handle: (channel, handler) => registered.set(channel, handler) },
    handlers,
    {
      secureHandler: (handler, channel) => {
        wrapped.push(channel);
        return async (event, payload) => {
          if (event?.trusted !== true) {
            throw new Error("untrusted sender");
          }
          return handler(event, payload);
        };
      },
    },
  );

  assert.deepEqual([...registered.keys()].sort(), ipcHandlerDefinitions.map(([channel]) => channel).sort());
  assert.deepEqual(wrapped.sort(), ipcHandlerDefinitions.map(([channel]) => channel).sort());
  await assert.rejects(
    registered.get("gofer:list-directory")({ trusted: false }, { currentPath: "/tmp" }),
    /untrusted sender/,
  );
  assert.deepEqual(await registered.get("gofer:list-directory")({ trusted: true }, { currentPath: "/tmp" }), {
    handlerName: "listDirectory",
    payload: { currentPath: "/tmp" },
  });
  assert.deepEqual(await registered.get("gofer:check-for-updates")({ trusted: true }, undefined), {
    handlerName: "checkForUpdates",
    payload: undefined,
  });
  assert.deepEqual(calls.map((call) => call.handlerName), ["listDirectory", "checkForUpdates"]);
  assert.throws(
    () => registerIpcHandlers({ handle: () => {} }, { ...handlers, listDirectory: undefined }),
    /Missing IPC handler: listDirectory/,
  );
});

test("Electron IPC security validates sender origins and external URL schemes", () => {
  const {
    createIpcSecurity,
    fileUrlForPath,
    isSafeExternalUrl,
    isTrustedSenderUrl,
  } = require("../../electron/security.cjs");
  const appRoot = path.join(repoRoot, "frontend/dist");
  const mainFrame = { url: fileUrlForPath(path.join(appRoot, "index.html")) };
  const mainWebContents = { mainFrame };
  const security = createIpcSecurity({
    appRoot,
    getDataDir: () => repoRoot,
    getMainWebContents: () => mainWebContents,
    isProduction: true,
  });

  assert.equal(
    isTrustedSenderUrl(fileUrlForPath(path.join(appRoot, "index.html")), {
      appRoot,
      isProduction: true,
    }),
    true,
  );
  assert.equal(
    isTrustedSenderUrl(fileUrlForPath(path.join(repoRoot, "README.md")), {
      appRoot,
      isProduction: true,
    }),
    false,
  );
  assert.equal(
    isTrustedSenderUrl("http://127.0.0.1:5173/src/main.jsx", {
      appRoot,
      devServerUrl: "http://127.0.0.1:5173",
      isProduction: false,
    }),
    true,
  );
  assert.equal(
    isTrustedSenderUrl("https://example.com/app", {
      appRoot,
      devServerUrl: "http://127.0.0.1:5173",
      isProduction: false,
    }),
    false,
  );

  assert.equal(isSafeExternalUrl("https://github.com/zacharyivie/gofer-flow"), true);
  assert.equal(isSafeExternalUrl("file:///etc/passwd"), false);
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(
    security.assertTrustedSender({
      sender: mainWebContents,
      senderFrame: mainFrame,
    }),
    true,
  );
  assert.throws(
    () =>
      security.assertTrustedSender({
        sender: mainWebContents,
        senderFrame: { url: mainFrame.url },
      }),
    /unexpected frame/,
  );
  assert.throws(
    () =>
      security.assertTrustedSender({
        sender: { mainFrame },
        senderFrame: mainFrame,
      }),
    /unexpected window/,
  );
});

test("Electron IPC security confines file paths to data dir and explicit grants", async () => {
  const { createIpcSecurity } = require("../../electron/security.cjs");
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gofer-ipc-test-"));
  const dataDir = path.join(tempRoot, "data");
  const outsideDir = path.join(tempRoot, "outside");
  await fs.promises.mkdir(dataDir, { recursive: true });
  await fs.promises.mkdir(outsideDir, { recursive: true });
  await fs.promises.writeFile(path.join(dataDir, "workflow.toml"), "ok", "utf8");
  await fs.promises.writeFile(path.join(outsideDir, "secret.txt"), "no", "utf8");

  const security = createIpcSecurity({
    appRoot: path.join(repoRoot, "frontend/dist"),
    devServerUrl: "http://127.0.0.1:5173",
    getDataDir: () => dataDir,
    isProduction: false,
  });

  assert.equal(security.resolveAllowedPath("workflow.toml", { mustExist: true }), path.join(dataDir, "workflow.toml"));
  assert.equal(security.resolveAllowedPath(path.join(dataDir, "new.toml")), path.join(dataDir, "new.toml"));
  assert.throws(
    () => security.resolveAllowedPath(path.join(outsideDir, "secret.txt"), { mustExist: true }),
    /outside the approved/,
  );

  const symlinkPath = path.join(dataDir, "leak.txt");
  try {
    await fs.promises.symlink(path.join(outsideDir, "secret.txt"), symlinkPath);
    assert.throws(
      () => security.resolveAllowedPath(symlinkPath, { mustExist: true }),
      /outside the approved/,
    );
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") {
      throw error;
    }
  }

  const grant = security.grantPath(outsideDir);
  assert.equal(
    security.resolveAllowedPath(path.join(outsideDir, "secret.txt"), {
      grantId: grant.grantId,
      mustExist: true,
    }),
    path.join(outsideDir, "secret.txt"),
  );
  assert.throws(
    () =>
      security.resolveAllowedPath(path.join(outsideDir, "secret.txt"), {
        grantId: "missing",
        mustExist: true,
      }),
    /invalid or expired/,
  );

  await fs.promises.rm(tempRoot, { force: true, recursive: true });
});

test("Electron registered IPC handlers reject untrusted senders and ungranted paths", async () => {
  const { registerIpcHandlers } = require("../../electron/ipc-handlers.cjs");
  const { createIpcSecurity, fileUrlForPath } = require("../../electron/security.cjs");
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gofer-ipc-handler-"));
  const appRoot = path.join(repoRoot, "frontend/dist");
  const dataDir = path.join(tempRoot, "data");
  const outsideDir = path.join(tempRoot, "outside");
  const dataFile = path.join(dataDir, "workflow.toml");
  const outsideFile = path.join(outsideDir, "secret.txt");
  await fs.promises.mkdir(dataDir, { recursive: true });
  await fs.promises.mkdir(outsideDir, { recursive: true });
  await fs.promises.writeFile(dataFile, "ok", "utf8");
  await fs.promises.writeFile(outsideFile, "secret", "utf8");

  const mainFrame = { url: fileUrlForPath(path.join(appRoot, "index.html")) };
  const mainWebContents = { mainFrame };
  const security = createIpcSecurity({
    appRoot,
    getDataDir: () => dataDir,
    getMainWebContents: () => mainWebContents,
    isProduction: true,
  });
  const registered = new Map();
  const handlers = Object.fromEntries(
    require("../../electron/ipc-handlers.cjs").ipcHandlerDefinitions.map(([, handlerName]) => [
      handlerName,
      async () => ({ ok: true }),
    ]),
  );
  handlers.readTextFile = async (_event, options = {}) => {
    const targetPath = security.resolveAllowedPath(options.targetPath, {
      grantId: options.grantId,
      mustExist: true,
    });
    return {
      content: await fs.promises.readFile(targetPath, "utf8"),
      path: targetPath,
    };
  };
  handlers.writeTextFile = async (_event, options = {}) => {
    const targetPath = security.resolveAllowedPath(options.targetPath, {
      grantId: options.grantId,
    });
    await fs.promises.writeFile(targetPath, options.content, "utf8");
    return { path: targetPath };
  };
  handlers.deletePath = async (_event, options = {}) => {
    const targetPath = security.resolveAllowedPath(options.targetPath, {
      grantId: options.grantId,
      mustExist: true,
    });
    return { path: targetPath };
  };

  registerIpcHandlers(
    { handle: (channel, handler) => registered.set(channel, handler) },
    handlers,
    { secureHandler: (handler) => security.secureHandler(handler) },
  );

  const trustedEvent = { sender: mainWebContents, senderFrame: mainFrame };
  const untrustedEvent = {
    sender: mainWebContents,
    senderFrame: { url: "https://example.com/" },
  };
  await assert.rejects(
    registered.get("gofer:read-text-file")(untrustedEvent, { targetPath: dataFile }),
    /unexpected frame/,
  );
  assert.deepEqual(await registered.get("gofer:read-text-file")(trustedEvent, { targetPath: dataFile }), {
    content: "ok",
    path: dataFile,
  });
  await assert.rejects(
    registered.get("gofer:read-text-file")(trustedEvent, { targetPath: outsideFile }),
    /outside the approved/,
  );
  await assert.rejects(
    registered.get("gofer:write-text-file")(trustedEvent, {
      content: "bad",
      targetPath: outsideFile,
    }),
    /outside the approved/,
  );
  await assert.rejects(
    registered.get("gofer:delete-path")(trustedEvent, { targetPath: outsideFile }),
    /outside the approved/,
  );
  const grant = security.grantPath(outsideDir);
  assert.deepEqual(
    await registered.get("gofer:read-text-file")(trustedEvent, {
      grantId: grant.grantId,
      targetPath: outsideFile,
    }),
    { content: "secret", path: outsideFile },
  );

  await fs.promises.rm(tempRoot, { force: true, recursive: true });
});

test("Electron backend error IPC actions still validate the expected window and main frame", async () => {
  const { registerIpcHandlers } = require("../../electron/ipc-handlers.cjs");
  const { createIpcSecurity, fileUrlForPath } = require("../../electron/security.cjs");
  const appRoot = path.join(repoRoot, "frontend/dist");
  const errorRoot = path.join(repoRoot, "frontend/electron");
  const mainFrame = { url: fileUrlForPath(path.join(appRoot, "index.html")) };
  const errorFrame = { url: fileUrlForPath(path.join(errorRoot, "backend-error.html")) };
  const mainWebContents = { mainFrame };
  const errorWebContents = { mainFrame: errorFrame };
  const mainSecurity = createIpcSecurity({
    appRoots: [appRoot],
    getDataDir: () => repoRoot,
    getMainWebContents: () => mainWebContents,
    isProduction: true,
  });
  const errorSecurity = createIpcSecurity({
    appRoots: [errorRoot],
    getDataDir: () => repoRoot,
    getMainWebContents: () => errorWebContents,
    isProduction: true,
  });
  const registered = new Map();
  const handlers = Object.fromEntries(
    require("../../electron/ipc-handlers.cjs").ipcHandlerDefinitions.map(([, handlerName]) => [
      handlerName,
      async () => ({ handlerName }),
    ]),
  );

  registerIpcHandlers(
    { handle: (channel, handler) => registered.set(channel, handler) },
    handlers,
    {
      secureHandler: (handler, channel) => (event, ...args) => {
        const security = channel === "gofer:restart-backend" || channel === "gofer:open-logs"
          ? errorSecurity
          : mainSecurity;
        return security.secureHandler(handler)(event, ...args);
      },
    },
  );

  await assert.rejects(
    registered.get("gofer:restart-backend")({
      sender: errorWebContents,
      senderFrame: { url: errorFrame.url },
    }),
    /unexpected frame/,
  );
  await assert.rejects(
    registered.get("gofer:restart-backend")({
      sender: mainWebContents,
      senderFrame: mainFrame,
    }),
    /unexpected window/,
  );
  assert.deepEqual(
    await registered.get("gofer:restart-backend")({
      sender: errorWebContents,
      senderFrame: errorFrame,
    }),
    { handlerName: "restartBackend" },
  );
});

test("DagCanvas helpers create default agent nodes and serialize node edits", () => {
  const workflow = { id: "wf", agents: {}, nodes: [], edges: [] };
  const withNode = canvasModule.addDefaultNodeToWorkflow(workflow, {
    usedAgentIds: ["agent-1"],
    x: 40,
    y: 50,
  });

  assert.equal(withNode.nodes[0].id, "node-1");
  assert.equal(withNode.nodes[0].type, "agent");
  assert.equal(withNode.nodes[0].operation.agent_id, "agent-2");
  assert.equal(withNode.nodes[0].x, 40);
  assert.equal(withNode.agents["agent-2"].subscription, "codex");

  const edited = canvasModule.updateWorkflowNodeOperation(withNode, "node-1", {
    prompt_path: "prompts/review.md",
    working_dir: "repo",
  });

  assert.equal(edited.nodes[0].operation.prompt_path, "prompts/review.md");
  assert.equal(edited.nodes[0].operation.working_dir, "repo");
  assert.match(edited.nodes[0].meta, /prompts\/review\.md/);

  const withHttpNode = canvasModule.addDefaultNodeToWorkflow(workflow, {
    type: "http_request",
    x: 80,
    y: 90,
  });
  assert.equal(withHttpNode.nodes[0].type, "http_request");
  assert.equal(withHttpNode.nodes[0].operation.method, "GET");
  assert.equal(withHttpNode.nodes[0].operation.expected_statuses[0], 200);
  assert.match(withHttpNode.nodes[0].meta, /https:\/\/api\.example\.com\/resource/);

  assert.deepEqual(canvasModule.defaultOperation("workflow"), {
    type: "workflow",
    workflow_id: "",
    input_bindings: {},
  });
  assert.deepEqual(canvasModule.defaultOperation("subflow"), {
    type: "subflow",
    component_id: "",
    source_path: "",
    input_bindings: {},
    output_contract: {},
  });
  assert.deepEqual(canvasModule.defaultOperation("notification").expected_statuses, [
    200,
    201,
    202,
    204,
  ]);
  assert.equal(canvasModule.defaultOperation("notification").smtp_port, 587);
});

test("DagCanvas helper duplicates nodes with unique ids and agent configs", () => {
  const workflow = {
    id: "wf",
    agents: {
      "agent-1": { subscription: "codex", model: "gpt-5" },
    },
    nodes: [
      {
        id: "node-1",
        type: "agent",
        label: "Review",
        operation: { type: "agent", agent_id: "agent-1", prompt: "Read this" },
        x: 10,
        y: 20,
      },
    ],
    edges: [],
  };

  const duplicated = canvasModule.duplicateWorkflowNode(workflow, "node-1");

  assert.deepEqual(duplicated.nodes.map((node) => node.id), ["node-1", "node-2"]);
  assert.equal(duplicated.nodes[1].label, "Review copy");
  assert.equal(duplicated.nodes[1].operation.agent_id, "agent-2");
  assert.equal(duplicated.agents["agent-2"].subscription, "codex");
  assert.equal(duplicated.nodes[1].x, 38);
  assert.equal(duplicated.nodes[1].y, 48);
});

test("DagCanvas HTTP JSON body editor preserves nested values and rejects invalid text", () => {
  const body = {
    issue: { title: "Bug", labels: ["api", "urgent"] },
    count: 2,
    active: true,
  };
  const text = canvasModule.formatJsonBodyEditorValue(body);
  assert.match(text, /"labels": \[/);
  assert.deepEqual(canvasModule.parseJsonBodyEditorValue(text), {
    ok: true,
    value: body,
  });
  assert.deepEqual(canvasModule.parseJsonBodyEditorValue(""), {
    ok: true,
    value: null,
  });
  assert.equal(canvasModule.parseJsonBodyEditorValue("{broken").ok, false);
});

test("DagCanvas exposes HTTP response fields as selectable outputs", () => {
  const fields = canvasModule.nodeOutputFields({
    id: "call-api",
    type: "http_request",
    operation: { type: "http_request" },
  });
  const paths = new Set(fields.map(([pathValue]) => pathValue));

  assert(paths.has("data.status"));
  assert(paths.has("data.headers"));
  assert(paths.has("data.body"));
  assert(paths.has("data.json"));
  assert(paths.has("data.selected"));
});

test("DagCanvas exposes approval and notification fields as selectable outputs", () => {
  const approvalFields = canvasModule.nodeOutputFields({
    id: "approval",
    type: "approval_gate",
    operation: { type: "approval_gate" },
  });
  const approvalPaths = new Set(approvalFields.map(([pathValue]) => pathValue));
  assert(approvalPaths.has("data.decision"));
  assert(approvalPaths.has("data.decidedBy"));
  assert(approvalPaths.has("data.notes"));

  const notificationFields = canvasModule.nodeOutputFields({
    id: "notify",
    type: "notification",
    operation: { type: "notification" },
  });
  const notificationPaths = new Set(notificationFields.map(([pathValue]) => pathValue));
  assert(notificationPaths.has("data.title"));
  assert(notificationPaths.has("data.body"));
  assert(notificationPaths.has("data.channel"));
});

test("DagCanvas exposes local vector index and search quality fields", () => {
  const vectorFields = canvasModule.nodeOutputFields({
    id: "index",
    type: "local_vectorize",
    operation: { type: "local_vectorize" },
  });
  const vectorPaths = new Set(vectorFields.map(([pathValue]) => pathValue));
  assert(vectorPaths.has("data.indexed_file_count"));
  assert(vectorPaths.has("data.current"));
  assert(vectorPaths.has("data.stale_files"));
  assert(vectorPaths.has("data.strategy"));

  const searchFields = canvasModule.nodeOutputFields({
    id: "search",
    type: "local_search",
    operation: { type: "local_search" },
  });
  const searchPaths = new Set(searchFields.map(([pathValue]) => pathValue));
  assert(searchPaths.has("data.score_threshold"));
  assert(searchPaths.has("data.strategy"));

  const workflow = {
    id: "wf",
    agents: {},
    nodes: [],
    edges: [],
  };
  const withVector = canvasModule.addDefaultNodeToWorkflow(workflow, {
    type: "local_vectorize",
    x: 0,
    y: 0,
  });
  assert.equal(withVector.nodes[0].operation.mode, "incremental");
  const withSearch = canvasModule.addDefaultNodeToWorkflow(workflow, {
    type: "local_search",
    x: 0,
    y: 0,
  });
  assert.equal(withSearch.nodes[0].operation.score_threshold, 0);
  assert.equal(withSearch.nodes[0].operation.include_snippets, true);
  assert.equal(withSearch.nodes[0].operation.include_file_metadata, true);
});

test("DagCanvas helpers persist graph positions and create/remove edges", () => {
  let workflow = {
    id: "wf",
    agents: {},
    nodes: [
      { id: "a", type: "bash_command", label: "A", operation: { type: "bash_command" }, x: 1, y: 2 },
      { id: "b", type: "agent", label: "B", operation: { type: "agent" }, x: 20, y: 30 },
    ],
    edges: [],
  };

  workflow = canvasModule.moveWorkflowNode(workflow, "a", { x: 9, y: 10 });
  assert.equal(workflow.nodes[0].x, 10);
  assert.equal(workflow.nodes[0].y, 12);

  workflow = canvasModule.addWorkflowEdge(workflow, "a", "b", "output_matches", "ready");
  assert.equal(workflow.edges[0].id, "a-b");
  assert.equal(workflow.edges[0].label, "matches ready");
  assert.equal(workflow.edges[0].outputPattern, "ready");

  const typedWorkflow = canvasModule.addWorkflowEdge(
    { ...workflow, edges: [] },
    "a",
    "b",
    "output_field",
    null,
    "score",
    "greater_than",
    7,
  );
  assert.equal(typedWorkflow.edges[0].label, "score greater than 7");
  assert.equal(
    canvasModule.edgeLabel("output_field", null, "verdict", "equals", "approved"),
    'verdict equals "approved"',
  );
  assert.equal(
    canvasModule.edgeLabel("output_field", null, "findings", "exists", null),
    "findings exists",
  );

  workflow = canvasModule.removeWorkflowNode(workflow, "a");
  assert.deepEqual(workflow.nodes.map((node) => node.id), ["b"]);
  assert.deepEqual(workflow.edges, []);
});

test("DagCanvas layout, search, and fit helpers handle large directed graphs deterministically", () => {
  const workflow = {
    id: "wf",
    agents: {},
    nodes: [
      {
        id: "finalize",
        type: "agent",
        label: "Finalize",
        operation: { type: "agent", agent_id: "writer" },
        x: 300,
        y: 400,
      },
      {
        id: "scan",
        type: "bash_command",
        label: "Scan inbox",
        operation: { type: "bash_command", command: "find inbox" },
        x: 10,
        y: 20,
      },
      {
        id: "read-doc",
        type: "read_file",
        label: "Read spec",
        operation: { type: "read_file", path: "docs/spec.md" },
        x: 40,
        y: 30,
      },
      {
        id: "archive",
        type: "move_file",
        label: "Archive",
        operation: { type: "move_file", destination_path: "archive/spec.md" },
        x: 90,
        y: 10,
      },
    ],
    edges: [
      { id: "scan-read-doc", from: "scan", to: "read-doc" },
      { id: "read-doc-finalize", from: "read-doc", to: "finalize" },
      { id: "scan-archive", from: "scan", to: "archive" },
    ],
  };

  const laidOut = canvasModule.autoLayoutWorkflow(workflow, {
    columnGap: 300,
    rowGap: 120,
    startX: 50,
    startY: 70,
  });
  const byId = Object.fromEntries(laidOut.nodes.map((node) => [node.id, node]));

  assert.equal(byId.scan.x, 50);
  assert.equal(byId["read-doc"].x, 350);
  assert.equal(byId.archive.x, 350);
  assert.equal(byId.finalize.x, 650);
  assert.ok(byId.archive.y < byId["read-doc"].y);
  assert.deepEqual(laidOut.edges, workflow.edges);
  assert.deepEqual(canvasModule.matchingNodeIds(workflow.nodes, "writer"), ["finalize"]);
  assert.deepEqual(canvasModule.matchingNodeIds(workflow.nodes, "docs/spec"), ["read-doc"]);
  assert.deepEqual(canvasModule.matchingNodeIds(workflow.nodes, "move_file"), ["archive"]);

  const fit = canvasModule.fitViewportToNodes(laidOut.nodes, { width: 900, height: 420 }, { padding: 40 });
  assert.ok(fit.scale >= 0.45 && fit.scale <= 1.8);
  assert.equal(Number.isFinite(fit.x), true);
  assert.equal(Number.isFinite(fit.y), true);

  const bounds = canvasModule.graphBounds(laidOut.nodes);
  assert.equal(bounds.left, 50);
  assert.equal(bounds.right, 870);
});

test("selected nodes stack above overlapping nodes, including expanded folders", () => {
  const selectedFolderStack = canvasModule.nodeStackIndex("folder", {
    selectedNodeId: "folder",
    selectedNodeIds: ["folder"],
  });
  const overlappingNodeStack = canvasModule.nodeStackIndex("agent", {
    selectedNodeId: "folder",
    selectedNodeIds: ["folder"],
  });

  assert.ok(selectedFolderStack > overlappingNodeStack);
  assert.ok(
    canvasModule.nodeStackIndex("folder", {
      draggingNodeId: "folder",
      selectedNodeId: "folder",
      selectedNodeIds: ["folder"],
    }) > selectedFolderStack,
  );
  assert.ok(
    canvasModule.nodeStackIndex("secondary", {
      selectedNodeId: "folder",
      selectedNodeIds: ["folder", "secondary"],
    }) > overlappingNodeStack,
  );
});

test("DagCanvas rendered navigation controls auto-layout, fit, and zoom", async () => {
  let workflow = {
    ...workflowFixture({ id: "nav", name: "Navigation", label: "Scan" }),
    nodes: [
      {
        id: "scan",
        type: "bash_command",
        label: "Scan",
        x: 420,
        y: 310,
        operation: { type: "bash_command", command: "find docs", working_dir: "" },
      },
      {
        id: "review",
        type: "agent",
        label: "Review docs",
        x: 40,
        y: 120,
        operation: { type: "agent", agent_id: "reviewer", prompt_path: "prompts/review.md" },
      },
      {
        id: "archive",
        type: "move_file",
        label: "Archive",
        x: 80,
        y: 20,
        operation: { type: "move_file", destination_path: "archive/docs.md" },
      },
    ],
    edges: [
      { id: "scan-review", from: "scan", to: "review", label: "always", condition: "always" },
      { id: "review-archive", from: "review", to: "archive", label: "always", condition: "always" },
    ],
  };
  const changes = [];
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      dataDir: "/workspace",
      notice: { type: "success", message: "Workflow is valid" },
      workflow,
      onWorkflowChange(nextWorkflow) {
        workflow = nextWorkflow;
        changes.push(nextWorkflow);
      },
    }),
    createFetchMock([]),
  );

  const runSelector = dom.byTitle("Select workflow run");
  const toolbar = dom.ancestor(runSelector, (node) => node.getAttribute?.("data-toolbar") === "graph-editor");
  const primaryToolbarRow = dom.ancestor(
    runSelector,
    (node) => node.getAttribute?.("data-toolbar-row") === "primary",
  );
  const secondaryToolbarRow = dom.ancestor(
    dom.byTitle("Auto-layout graph"),
    (node) => node.getAttribute?.("data-toolbar-row") === "secondary",
  );
  const validationButton = dom.byTitle("Validate workflow");
  const validationToolbarRow = dom.ancestor(
    validationButton,
    (node) => node.getAttribute?.("data-toolbar-row") === "primary",
  );
  assert.equal(toolbar.getAttribute("data-toolbar"), "graph-editor");
  assert.equal(validationToolbarRow, primaryToolbarRow);
  assert.equal(primaryToolbarRow.contains(secondaryToolbarRow), false);
  assert.doesNotMatch(secondaryToolbarRow.getAttribute("class"), /flex-wrap/);
  assert.doesNotMatch(toolbar.getAttribute("class"), /overflow-x-auto|workflow-scrollbar/);
  assert.equal(allElements(dom.container).some((element) => element.getAttribute?.("aria-label") === "Search nodes"), false);
  assert.match(dom.byText("Workflow is valid").getAttribute("class"), /right-0/);

  await dom.flush();
  await dom.click(dom.byTitle("Auto-layout graph"));
  assert.deepEqual(changes.at(-1).nodes.map((node) => node.id), ["scan", "review", "archive"]);
  assert.ok(changes.at(-1).nodes[0].x < changes.at(-1).nodes[1].x);
  assert.ok(changes.at(-1).nodes[1].x < changes.at(-1).nodes[2].x);

  await dom.click(dom.byTitle("Fit graph"));
  await dom.click(dom.byTitle("Zoom in"));
  await dom.click(dom.byTitle("Zoom out"));

  const enterFullscreen = dom.byTitle("Enter full screen");
  assert.equal(enterFullscreen.getAttribute("aria-pressed"), "false");
  await dom.click(enterFullscreen);
  const exitFullscreen = dom.byTitle("Exit full screen");
  const fullscreenGraph = dom.ancestor(
    exitFullscreen,
    (node) => node.getAttribute?.("data-graph-fullscreen") === "true",
  );
  assert.match(fullscreenGraph.getAttribute("class"), /fixed inset-0/);
  assert.equal(exitFullscreen.getAttribute("aria-pressed"), "true");
  await dom.dispatchWindow("keydown", { key: "Escape" });
  assert.ok(dom.byTitle("Enter full screen"));

  await dom.click(dom.byTitle("Fit selection"));
  await dom.unmount();
});

test("DagCanvas minimap sits top left, handles translucent dark mode styling, and traps navigation events", async () => {
  const workflow = {
    ...workflowFixture({ id: "minimap", name: "Minimap", label: "Scan" }),
    nodes: [
      {
        id: "scan",
        type: "bash_command",
        label: "Scan",
        x: 40,
        y: 60,
        operation: { type: "bash_command", command: "find docs", working_dir: "" },
      },
      {
        id: "review",
        type: "agent",
        label: "Review docs",
        x: 420,
        y: 260,
        operation: { type: "agent", agent_id: "reviewer", prompt: "Review" },
      },
    ],
  };
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      dataDir: "/workspace",
      workflow,
      onWorkflowChange() {},
    }),
    createFetchMock([]),
  );

  await dom.click(dom.byTitle("Map"));
  const outline = dom.byLabel("Graph outline");
  let outlineWheelStopped = false;
  const outlineWheelEvent = testEvent(outline, {
    deltaY: -100,
    stopPropagation() {
      outlineWheelStopped = true;
    },
  });
  reactProps(outline).onWheel(outlineWheelEvent);
  assert.equal(outlineWheelStopped, true);
  assert.equal(outlineWheelEvent.defaultPrevented, false);

  await dom.click(dom.ancestor(dom.byText("Minimap"), "BUTTON"));
  const minimap = dom.byTitle("Minimap");
  assert.match(minimap.getAttribute("class"), /bg-slate-50/);

  const minimapSurface = minimap.childNodes[0];
  assert.match(minimapSurface.getAttribute("class"), /dark:bg-\[#1b1f22\]\/80/);
  assert.equal(minimapSurface.style.width, "100%");
  assert.equal(minimapSurface.style.height, "100%");
  assert.equal(typeof reactProps(minimapSurface).onPointerLeave, "function");

  const viewportIndicator = minimapSurface.childNodes[minimapSurface.childNodes.length - 1];
  const viewportWidthBeforeWheel = viewportIndicator.style.width;
  let wheelStopped = false;
  const wheelEvent = testEvent(minimapSurface, {
    deltaY: -100,
    stopPropagation() {
      wheelStopped = true;
    },
  });
  await React.act(async () => {
    reactProps(minimapSurface).onWheel(wheelEvent);
  });
  assert.equal(wheelEvent.defaultPrevented, true);
  assert.equal(wheelStopped, true);
  assert.notEqual(viewportIndicator.style.width, viewportWidthBeforeWheel);

  minimapSurface.getBoundingClientRect = () => ({
    bottom: 128,
    height: 128,
    left: 0,
    right: 184,
    top: 0,
    width: 184,
  });
  const bounds = canvasModule.graphBounds(workflow.nodes, 160);
  const minimapScale = Math.min(184 / bounds.width, 128 / bounds.height);
  assert.deepEqual(
    canvasModule.minimapPointToWorld(
      { clientX: 92, clientY: 64 },
      minimapSurface.getBoundingClientRect(),
      bounds,
    ),
    {
      x: bounds.left + 92 / minimapScale,
      y: bounds.top + 64 / minimapScale,
    },
  );
  const clickedWorld = canvasModule.minimapPointToWorld(
    { clientX: 80, clientY: 50 },
    minimapSurface.getBoundingClientRect(),
    bounds,
  );
  await dom.pointer(minimapSurface, "onPointerDown", {
    clientX: 80,
    clientY: 50,
    pointerId: 9,
  });
  const scanCard = allElements(dom.container).find(
    (element) => element.tagName === "ARTICLE" && textOf(element).includes("Scan"),
  );
  const viewportTransform = scanCard.parentNode.style.transform.match(
    /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/,
  );
  assert.ok(viewportTransform);
  assert.ok(Math.abs(Number(viewportTransform[1]) - (480 - clickedWorld.x * 1.08)) < 0.001);
  assert.ok(Math.abs(Number(viewportTransform[2]) - (320 - clickedWorld.y * 1.08)) < 0.001);
  await dom.pointer(minimapSurface, "onPointerMove", {
    clientX: 240,
    clientY: 50,
    pointerId: 9,
  });

  await dom.unmount();
});

test("Electron preload exposes stable desktop and update bridge contracts", async () => {
  const exposed = runPreload({
    argv: ["electron", "preload", "--gofer-api-base-url=http://localhost:9000"],
  });

  assert.equal(exposed.goferApiBaseUrl, "http://localhost:9000");
  assert.deepEqual(Object.keys(exposed.goferDesktop).sort(), [
    "dataDirectory",
    "getDataDir",
    "getDroppedFilePath",
    "grantDroppedPath",
    "textFiles",
    "workspace",
  ]);
  assert.deepEqual(Object.keys(exposed.goferDesktop.workspace).sort(), [
    "copyPath",
    "createFile",
    "createFolder",
    "deletePath",
    "getPathInfo",
    "listDirectory",
    "openPath",
    "pathGrantForApi",
    "renamePath",
    "revealPath",
    "selectPath",
  ]);
  assert.deepEqual(Object.keys(exposed.goferDesktop.textFiles).sort(), ["read", "write"]);
  assert.deepEqual(Object.keys(exposed.goferDesktop.dataDirectory).sort(), ["choose", "get"]);
  assert.deepEqual(Object.keys(exposed.goferUpdates).sort(), [
    "check",
    "downloadAndInstall",
    "getState",
    "installDownloaded",
    "onState",
    "openRelease",
  ]);

  assert.deepEqual(toPlainObject(await exposed.goferDesktop.workspace.listDirectory({ currentPath: 42, create: false })), {
    channel: "gofer:list-directory",
    payload: { currentPath: "", grantId: "", create: false },
  });
  assert.deepEqual(toPlainObject(await exposed.goferDesktop.workspace.copyPath({ sourcePath: "/a", destinationPath: 9 })), {
    channel: "gofer:copy-path",
    payload: { destinationGrantId: "", sourcePath: "/a", sourceGrantId: "", destinationPath: "" },
  });
  assert.equal(
    await exposed.goferDesktop.grantDroppedPath({ path: "/outside/file.txt" }),
    "/outside/file.txt",
  );
});

test("Electron preload keeps file grants private while attaching them to later calls", async () => {
  const calls = [];
  const exposed = runPreload({
    argv: ["electron", "preload"],
    invoke(channel, payload) {
      calls.push({ channel, payload });
      if (channel === "gofer:select-path") {
        return { grantId: "grant-1", path: "/outside/shared" };
      }
      if (channel === "gofer:path-info") {
        return { basename: "shared", grantId: "grant-1", isDirectory: true, path: payload.targetPath };
      }
      return { channel, payload };
    },
  });

  assert.equal(await exposed.goferDesktop.workspace.selectPath({}), "/outside/shared");
  assert.deepEqual(toPlainObject(await exposed.goferDesktop.workspace.getPathInfo("/outside/shared")), {
    basename: "shared",
    isDirectory: true,
    path: "/outside/shared",
  });
  assert.deepEqual(toPlainObject(calls.at(-1)), {
    channel: "gofer:path-info",
    payload: {
      grantId: "grant-1",
      targetPath: "/outside/shared",
    },
  });
  assert.equal(exposed.goferDesktop.workspace.pathGrantForApi("/outside/shared"), "grant-1");
  assert.deepEqual(toPlainObject(await exposed.goferDesktop.workspace.listDirectory({ currentPath: "/outside/shared" })), {
    channel: "gofer:list-directory",
    payload: {
      create: true,
      currentPath: "/outside/shared",
      grantId: "grant-1",
    },
  });
});

test("Electron preload changes data directory through native directory grants", async () => {
  const calls = [];
  const exposed = runPreload({
    argv: ["electron", "preload"],
    invoke(channel, payload) {
      calls.push({ channel, payload });
      if (channel === "gofer:select-path") {
        return { grantId: "grant-data", path: "/outside/gofer-data" };
      }
      if (channel === "gofer:set-data-dir") {
        return { dataDir: payload.dataDir };
      }
      return { channel, payload };
    },
  });

  assert.deepEqual(
    toPlainObject(await exposed.goferDesktop.dataDirectory.choose({ currentPath: "/old-data" })),
    { dataDir: "/outside/gofer-data" },
  );
  assert.deepEqual(toPlainObject(calls), [
    {
      channel: "gofer:select-path",
      payload: { currentPath: "/old-data", directoryOnly: true, grantId: "" },
    },
    {
      channel: "gofer:set-data-dir",
      payload: { dataDir: "/outside/gofer-data", grantId: "grant-data" },
    },
  ]);
});

test("Electron preload rejects unsafe remote API base URLs", () => {
  const exposed = runPreload({
    argv: ["electron", "preload", "--gofer-api-base-url=https://example.com"],
  });

  assert.equal(exposed.goferApiBaseUrl, "http://127.0.0.1:8765");
});

function runPreload({ argv, invoke }) {
  const exposed = {};
  const listeners = new Map();
  const source = fs.readFileSync(path.join(repoRoot, "frontend/electron/preload.cjs"), "utf8");
  const sandbox = {
    URL: globalThis.URL,
    process: { argv },
    require(moduleName) {
      if (moduleName !== "electron") {
        throw new Error(`Unexpected preload require: ${moduleName}`);
      }
      return {
        contextBridge: {
          exposeInMainWorld(key, value) {
            exposed[key] = value;
          },
        },
        ipcRenderer: {
          invoke(channel, payload) {
            return typeof invoke === "function" ? invoke(channel, payload) : { channel, payload };
          },
          on(channel, listener) {
            listeners.set(channel, listener);
          },
          removeListener(channel, listener) {
            if (listeners.get(channel) === listener) {
              listeners.delete(channel);
            }
          },
        },
        webUtils: {
          getPathForFile(file) {
            return file?.path ?? "";
          },
        },
      };
    },
  };

  vm.runInNewContext(source, sandbox, { filename: "preload.cjs" });
  return exposed;
}

function toPlainObject(value) {
  return JSON.parse(JSON.stringify(value));
}

function DagCanvasHarness({
  approvalState,
  dataDir,
  logState,
  notice,
  onDecideApproval,
  onPruneRunLogs,
  onRadishMutation,
  onReplayRunLog,
  onRetentionSettingsChange,
  onResumeRunLog,
  onWorkflowChange,
  retentionSettings,
  radishDocument,
  workflow,
}) {
  const [currentWorkflow, setCurrentWorkflow] = React.useState(workflow);
  const [currentRadishDocument, setCurrentRadishDocument] = React.useState(radishDocument);
  const [currentRetentionSettings, setCurrentRetentionSettings] = React.useState(
    retentionSettings,
  );

  function handleChange(nextWorkflow) {
    setCurrentWorkflow(nextWorkflow);
    onWorkflowChange(nextWorkflow);
  }

  function handleRetentionSettingsChange(nextSettings) {
    setCurrentRetentionSettings(nextSettings);
    onRetentionSettingsChange?.(nextSettings);
  }

  async function handleRadishMutation(mutations) {
    const nextDocument = await onRadishMutation?.(mutations);
    if (nextDocument) {
      setCurrentRadishDocument(nextDocument);
      setCurrentWorkflow((current) => appModule.radishGraphWorkflow(current, nextDocument));
    }
    return nextDocument;
  }

  return React.createElement(canvasModule.default, {
    dataDir,
    logState: logState ?? { loading: false, error: "", text: "", path: null, runs: [] },
    notice,
    retentionSettings: currentRetentionSettings,
    radishDocument: currentRadishDocument,
    approvalState: approvalState ?? { approvals: [], error: "", loading: false },
    runResult: null,
    runState: { running: false },
    usedAgentIds: [],
    workflow: currentWorkflow,
    onImportWorkflow: () => {},
    onLoadLatestLog: () => {},
    onPruneRunLogs: onPruneRunLogs ?? (() => {}),
    onRadishMutation: handleRadishMutation,
    onReplayRunLog: onReplayRunLog ?? (() => {}),
    onRetentionSettingsChange: handleRetentionSettingsChange,
    onResumeRunLog: onResumeRunLog ?? (() => {}),
    onRunWorkflow: () => {},
    onSelectRunLog: () => {},
    onStopRunLog: () => {},
    onStopWorkflow: () => {},
    onValidateWorkflow: () => {},
    onDecideApproval: onDecideApproval ?? (() => {}),
    onWorkflowChange: handleChange,
  });
}

function InspectorDraftHarness({ changes }) {
  const [keyValue, setKeyValue] = React.useState({});
  const [list, setList] = React.useState([]);
  const [number, setNumber] = React.useState(3);
  const [pathValue, setPathValue] = React.useState("scripts/run.sh");

  return React.createElement(
    "div",
    null,
    React.createElement(canvasModule.NumberField, {
      label: "Draft number",
      min: "-10",
      step: "0.1",
      value: number,
      onChange(nextValue) {
        changes.number.push(nextValue);
        setNumber(nextValue);
      },
    }),
    React.createElement(
      "button",
      { type: "button", onClick: () => setNumber(11) },
      "Update number externally",
    ),
    React.createElement(canvasModule.ListField, {
      label: "Draft list",
      value: list,
      onChange(nextValue) {
        changes.list.push(nextValue);
        setList(nextValue);
      },
    }),
    React.createElement(canvasModule.KeyValueField, {
      label: "Draft key/value",
      value: keyValue,
      onChange(nextValue) {
        changes.keyValue.push(nextValue);
        setKeyValue(nextValue);
      },
    }),
    React.createElement(canvasModule.TextField, {
      label: "Draft path",
      pathBasePath: "/workspace",
      pathPicker: true,
      value: pathValue,
      onChange(nextValue) {
        changes.path.push(nextValue);
        setPathValue(nextValue);
      },
    }),
  );
}

function workflowFixture({ id = "demo", name = "Demo", label = "Run command", status = "Ready" } = {}) {
  return {
    id,
    name,
    description: `${name} workflow`,
    status,
    tags: [status.toLowerCase()],
    agents: {},
    edges: [],
    nodes: [
      {
        id: "step",
        type: "bash_command",
        label,
        x: 0,
        y: 0,
        operation: { type: "bash_command", command: "echo hi", working_dir: "" },
      },
    ],
    sourcePath: `/tmp/${id}.toml`,
    projectRoot: "/workspace",
    projectName: "workspace",
  };
}

function workflowsPayload(workflows) {
  return { dataDir: "/workspace", promptAgentIds: [], workflows };
}

function jsonResponse(url, payload, { method = "GET", ok = true, status = ok ? 200 : 500 } = {}) {
  return (requestUrl, options = {}) => {
    if (requestUrl !== url || (options.method ?? "GET") !== method) return null;
    return {
      ok,
      status,
      json: async () => payload,
    };
  };
}

function saveWorkflowResponse() {
  return (url, options = {}) => {
    if (!url.startsWith("/api/workflows/") || options.method !== "PUT") return null;
    const workflow = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ workflow }),
    };
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function streamResponse(chunks) {
  return (url) => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        let index = 0;
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            const value = new TextEncoder().encode(chunks[index]);
            index += 1;
            return { done: false, value };
          },
        };
      },
    },
    json: async () => ({}),
    url,
  });
}

function controlledStreamResponse(chunks) {
  const pendingReads = chunks.map(() => createDeferred());
  return {
    releaseNext() {
      const nextRead = pendingReads.find((deferred) => !deferred.released);
      if (!nextRead) return;
      nextRead.released = true;
      nextRead.resolve();
    },
    response(url) {
      return {
        ok: true,
        status: 200,
        body: {
          getReader() {
            let index = 0;
            return {
              async read() {
                if (index >= chunks.length) return { done: true, value: undefined };
                const deferred = pendingReads[index];
                await deferred.promise;
                const value = new TextEncoder().encode(chunks[index]);
                index += 1;
                return { done: false, value };
              },
            };
          },
        },
        json: async () => ({}),
        url,
      };
    },
  };
}

function createFetchMock(handlers) {
  const calls = [];
  const fetchMock = async (url, options = {}) => {
    calls.push({ url, options });
    for (const handler of handlers) {
      const response = handler(url, options);
      if (response) return response;
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  fetchMock.calls = calls;
  return fetchMock;
}

async function exerciseDialogFamily(renderDialog, desktop = {}) {
  function DialogFamilyHarness() {
    const [open, setOpen] = React.useState(false);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "button",
        {
          "aria-label": "Open dialog family",
          onClick: () => setOpen(true),
          type: "button",
        },
        "Open",
      ),
      open ? renderDialog(() => setOpen(false)) : null,
    );
  }

  const dom = await mountReact(
    React.createElement(DialogFamilyHarness),
    createFetchMock([]),
    { desktop },
  );
  const opener = dom.byLabel("Open dialog family");
  await dom.focus(opener);
  await dom.click(opener);
  await dom.flush();

  const dialog = allElements(dom.container).find(
    (element) => element.getAttribute?.("role") === "dialog",
  );
  assert.ok(dialog, "Expected the family to render a dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.ok(dialog.getAttribute("aria-labelledby"));
  assert.ok(dialog.getAttribute("aria-describedby"));
  assert.equal(dialog.contains(document.activeElement), true, "Initial focus escaped the dialog");

  const focusable = allElements(dialog).filter(
    (element) =>
      !element.disabled &&
      ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(element.tagName),
  );
  assert.ok(focusable.length > 0, "Expected at least one focusable dialog control");
  const first = focusable[0];
  const last = focusable.at(-1);

  await dom.focus(last);
  await dom.dispatchWindow("keydown", { key: "Tab" });
  assert.equal(document.activeElement, first, "Tab did not wrap to the first control");

  await dom.focus(first);
  await dom.dispatchWindow("keydown", { key: "Tab", shiftKey: true });
  assert.equal(document.activeElement, last, "Shift+Tab did not wrap to the last control");

  await dom.dispatchWindow("keydown", { key: "Escape" });
  assert.equal(document.activeElement, opener, "Focus did not return to the opener");
  assert.equal(
    allElements(dom.container).some((element) => element.getAttribute?.("role") === "dialog"),
    false,
    "Escape did not close the dialog",
  );

  await dom.unmount();
}

async function mountReact(element, fetchMock, { desktop = {} } = {}) {
  const dom = installTestDom();
  const { createRoot } = require("react-dom/client");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = fetchMock;
  globalThis.window.fetch = fetchMock;
  globalThis.window.goferApiBaseUrl = undefined;
  globalThis.window.goferDesktop = desktop;
  globalThis.window.goferUpdates = undefined;
  globalThis.window.confirm = () => true;
  globalThis.window.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  globalThis.window.cancelAnimationFrame = () => {};

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await React.act(async () => {
    root.render(element);
  });

  return {
    container,
    fetchCalls: fetchMock.calls,
    async change(elementNode, value) {
      await React.act(async () => {
        elementNode.value = value;
        elementNode.checked = Boolean(value);
        reactProps(elementNode).onChange?.({ target: elementNode, currentTarget: elementNode });
      });
    },
    async click(elementNode) {
      await React.act(async () => {
        reactProps(elementNode).onClick?.(testEvent(elementNode));
      });
    },
    async blur(elementNode) {
      await React.act(async () => {
        reactProps(elementNode).onBlur?.(testEvent(elementNode));
        elementNode.blur();
      });
    },
    async dispatchWindow(type, patch = {}) {
      await React.act(async () => {
        const event = Object.assign(new TestEvent(type), {
          defaultPrevented: false,
          preventDefault() {
            this.defaultPrevented = true;
          },
          stopPropagation() {},
          ...patch,
        });
        for (const listener of document.listeners[type] ?? []) {
          listener(event);
        }
        await Promise.resolve();
      });
    },
    async flush(ms = 0) {
      await React.act(async () => {
        if (ms > 0) {
          dom.runTimers(ms);
        }
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    async focus(elementNode) {
      await React.act(async () => {
        elementNode.focus();
        reactProps(elementNode).onFocus?.(testEvent(elementNode));
      });
    },
    async keyDown(elementNode, key, patch = {}) {
      await React.act(async () => {
        reactProps(elementNode).onKeyDown?.(testEvent(elementNode, { key, ...patch }));
      });
    },
    async pointer(elementNode, handlerName, patch = {}) {
      await React.act(async () => {
        reactProps(elementNode)[handlerName]?.(testEvent(elementNode, patch));
      });
    },
    async unmount() {
      await React.act(async () => {
        root.unmount();
      });
      dom.restore();
    },
    allByTitle(title) {
      return allElements(container).filter((node) => node.getAttribute?.("title") === title);
    },
    ancestor(elementNode, tagNameOrPredicate) {
      let current = elementNode;
      const matches =
        typeof tagNameOrPredicate === "function"
          ? tagNameOrPredicate
          : (node) => node.tagName === tagNameOrPredicate;
      while (current && !matches(current)) {
        current = current.parentNode;
      }
      assert.ok(current, "Unable to find matching ancestor");
      return current;
    },
    byText(text) {
      const match = allElements(container).find((node) =>
        directText(node).includes(text),
      );
      assert.ok(match, `Unable to find text: ${text}`);
      return match;
    },
    byTitle(title) {
      const match = allElements(container).find((node) => node.getAttribute?.("title") === title);
      assert.ok(match, `Unable to find title: ${title}`);
      return match;
    },
    byLabel(label) {
      const match = allElements(container).find((node) => node.getAttribute?.("aria-label") === label);
      assert.ok(match, `Unable to find aria-label: ${label}`);
      return match;
    },
    controlAfterLabel(labelText) {
      const label = allElements(container).find((node) =>
        node.tagName === "LABEL" && textOf(node).includes(labelText),
      );
      assert.ok(label, `Unable to find label: ${labelText}`);
      const control = allElements(label).find((node) =>
        ["INPUT", "SELECT", "TEXTAREA"].includes(node.tagName),
      );
      assert.ok(control, `Unable to find control for label: ${labelText}`);
      return control;
    },
    first(tagName) {
      const match = allElements(container).find((node) => node.tagName === tagName.toUpperCase());
      assert.ok(match, `Unable to find ${tagName}`);
      return match;
    },
    selectWithOption(value) {
      const match = allElements(container).find(
        (node) => node.tagName === "SELECT" && [...(node.options ?? [])].some((option) => option.value === value),
      );
      assert.ok(match, `Unable to find select with option: ${value}`);
      return match;
    },
    text() {
      return textOf(container);
    },
  };
}

function testEvent(target, patch = {}) {
  return {
    button: 0,
    buttons: 1,
    clientX: 0,
    clientY: 0,
    currentTarget: target,
    defaultPrevented: false,
    pointerId: 1,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
    target,
    ...patch,
  };
}

function reactProps(node) {
  const key = Object.keys(node).find((candidate) => candidate.startsWith("__reactProps$"));
  assert.ok(key, `No React props found on ${node.tagName ?? node.nodeName}`);
  return node[key];
}

function installTestDom() {
  const previousNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previous = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    HTMLElement: globalThis.HTMLElement,
    HTMLIFrameElement: globalThis.HTMLIFrameElement,
    Node: globalThis.Node,
    SVGElement: globalThis.SVGElement,
    window: globalThis.window,
  };
  const timers = [];
  const windowObject = {};
  const documentObject = new TestDocument(windowObject);
  Object.assign(windowObject, {
    document: documentObject,
    Event: TestEvent,
    HTMLElement: TestElement,
    HTMLIFrameElement: TestElement,
    Node: TestNode,
    SVGElement: TestElement,
    addEventListener: (...args) => documentObject.addEventListener(...args),
    clearInterval: (id) => clearTimer(timers, id),
    clearTimeout: (id) => clearTimer(timers, id),
    getComputedStyle: () => ({}),
    localStorage: createStorage(),
    navigator: { clipboard: { writeText: async () => {} }, userAgent: "node-test" },
    removeEventListener: (...args) => documentObject.removeEventListener(...args),
    scrollTo: () => {},
    setInterval: (callback, delay) => addTimer(timers, callback, delay, true),
    setTimeout: (callback, delay) => addTimer(timers, callback, delay, false),
  });

  globalThis.window = windowObject;
  globalThis.document = documentObject;
  globalThis.HTMLElement = TestElement;
  globalThis.HTMLIFrameElement = TestElement;
  globalThis.Node = TestNode;
  globalThis.SVGElement = TestElement;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: windowObject.navigator,
    writable: true,
  });

  return {
    restore() {
      Object.assign(globalThis, previous);
      if (previousNavigatorDescriptor) {
        Object.defineProperty(globalThis, "navigator", previousNavigatorDescriptor);
      } else {
        delete globalThis.navigator;
      }
    },
    runTimers(ms) {
      const runnable = timers.filter((timer) => timer.delay <= ms);
      for (const timer of runnable) {
        timer.callback();
        if (!timer.repeating) {
          clearTimer(timers, timer.id);
        }
      }
    },
  };
}

function addTimer(timers, callback, delay = 0, repeating = false) {
  const timer = { callback, delay, id: timers.length + 1, repeating };
  timers.push(timer);
  return timer.id;
}

function clearTimer(timers, id) {
  const index = timers.findIndex((timer) => timer.id === id);
  if (index >= 0) timers.splice(index, 1);
}

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

class TestNode {
  constructor() {
    this.childNodes = [];
    this.listeners = {};
    this.parentNode = null;
  }

  appendChild(node) {
    return this.insertBefore(node, null);
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  addEventListener(type, listener) {
    this.listeners[type] = [...(this.listeners[type] ?? []), listener];
  }

  removeEventListener(type, listener) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((candidate) => candidate !== listener);
  }

  insertBefore(node, beforeNode) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    if (beforeNode === null || beforeNode === undefined) {
      this.childNodes.push(node);
    } else {
      this.childNodes.splice(this.childNodes.indexOf(beforeNode), 0, node);
    }
    return node;
  }

  removeChild(node) {
    this.childNodes = this.childNodes.filter((child) => child !== node);
    node.parentNode = null;
    return node;
  }
}

class TestElement extends TestNode {
  constructor(tagName, ownerDocument) {
    super();
    this.attributes = {};
    this.checked = false;
    this.disabled = false;
    this.localName = tagName;
    this.namespaceURI = "http://www.w3.org/1999/xhtml";
    this.nodeName = tagName.toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = ownerDocument;
    this.style = {};
    this.tagName = tagName.toUpperCase();
    this.value = "";
  }

  blur() {
    this.ownerDocument.activeElement = null;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  querySelector() {
    return null;
  }

  hasPointerCapture() {
    return true;
  }

  getBoundingClientRect() {
    return {
      bottom: 640,
      height: 640,
      left: 0,
      right: 960,
      top: 0,
      width: 960,
    };
  }

  releasePointerCapture() {}

  setPointerCapture() {}

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "value") this.value = String(value);
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join("");
  }

  get options() {
    return this.tagName === "SELECT"
      ? allElements(this).filter((node) => node.tagName === "OPTION")
      : undefined;
  }

  set textContent(value) {
    this.childNodes = [new TestText(value, this.ownerDocument)];
  }
}

class TestText extends TestNode {
  constructor(value, ownerDocument) {
    super();
    this.nodeName = "#text";
    this.nodeType = 3;
    this.nodeValue = String(value);
    this.ownerDocument = ownerDocument;
  }

  get textContent() {
    return this.nodeValue;
  }

  set textContent(value) {
    this.nodeValue = String(value);
  }
}

class TestDocument extends TestNode {
  constructor(defaultView) {
    super();
    this.activeElement = null;
    this.defaultView = defaultView;
    this.documentElement = new TestElement("html", this);
    this.body = new TestElement("body", this);
    this.nodeName = "#document";
    this.nodeType = 9;
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
  }

  createComment(value) {
    return new TestText(value, this);
  }

  createElement(tagName) {
    return new TestElement(tagName, this);
  }

  createElementNS(namespaceURI, tagName) {
    const element = new TestElement(tagName, this);
    element.namespaceURI = namespaceURI;
    return element;
  }

  createTextNode(value) {
    return new TestText(value, this);
  }

  getElementById() {
    return null;
  }
}

class TestEvent {}

function allElements(root) {
  const elements = [];
  for (const child of root.childNodes ?? []) {
    if (child.nodeType === 1) {
      elements.push(child);
      elements.push(...allElements(child));
    }
  }
  return elements;
}

function matchingLiveRegions(container, { politeness, role, text }) {
  return allElements(container).filter(
    (element) =>
      element.getAttribute?.("aria-live") === politeness &&
      element.getAttribute?.("role") === role &&
      textOf(element).includes(text),
  );
}

function directText(node) {
  return (node.childNodes ?? [])
    .filter((child) => child.nodeType === 3)
    .map((child) => child.textContent)
    .join("");
}

function textOf(node) {
  return node.textContent ?? "";
}
