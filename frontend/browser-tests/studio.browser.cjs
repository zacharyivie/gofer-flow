/* global __dirname, Buffer, clearTimeout, console, CSS, document, Event, MouseEvent, process, setTimeout, window */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { app, BrowserWindow } = require("electron");

const frontendRoot = path.resolve(__dirname, "..");
const distRoot = path.join(frontendRoot, "dist");
const TEST_TIMEOUT_MS = 45000;

let server;
let baseUrl;
let windowRef;
const rendererMessages = [];

const state = {
  approvals: [
    {
      approvers: ["ops"],
      message: "Approve deploy to production?",
      nodeId: "approval",
      requestedAt: "2026-06-27T10:00:00Z",
      runId: "run-1",
      status: "pending",
      timeoutSeconds: 300,
    },
  ],
  calls: [],
  retention: {
    keepDays: 30,
    keepFailedDays: 90,
    keepLast: 20,
  },
  workflow: workflowFixture(),
};

const timeout = setTimeout(() => {
  fail(new Error("Browser studio regression test timed out."));
}, TEST_TIMEOUT_MS);

process.on("unhandledRejection", fail);
process.on("uncaughtException", fail);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-setuid-sandbox");

app.whenReady().then(run).catch(fail);

async function run() {
  server = await startServer();

  windowRef = new BrowserWindow({
    width: 1440,
    height: 950,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      preload: path.join(__dirname, "studio-preload-mock.cjs"),
      sandbox: false,
    },
  });
  windowRef.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    rendererMessages.push({ level, line, message, sourceId });
    if (level >= 2) {
      console.error(`Renderer console: ${message} (${sourceId}:${line})`);
    }
  });
  windowRef.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      rendererMessages.push({
        level: 3,
        line: 0,
        message: `did-fail-load ${errorCode}: ${errorDescription}`,
        sourceId: validatedURL,
      });
    },
  );

  await loadApp();
  await runDesktopGraphRegression();
  await runMobileLayoutRegression();

  clearTimeout(timeout);
  console.log("Browser studio regression tests passed.");
  await cleanup(0);
}

async function loadApp() {
  await windowRef.loadURL(baseUrl);
  await waitFor(() => textIncludes("Demo workflow"), "workflow list loaded");
  await waitFor(
    () => count("[data-testid='workflow-node']") >= 3,
    "workflow nodes rendered",
    7000,
    browserDiagnosticSnapshot,
  );
}

async function runDesktopGraphRegression() {
  assert.equal(await textIncludes("Missing provider CLI: codex"), true);
  assert.equal(await textIncludes("Approval Required"), true);
  assert.equal(await textIncludes("Approve deploy to production?"), true);

  await clickByTitle("Run workflow now");
  await waitFor(() => textIncludes("Run preview: Demo workflow"), "run preview dialog");
  assert.equal(await textIncludes("Deletes /tmp/output.txt"), true);
  assert.equal(await textIncludes("codex binary=codex"), true);
  await clickByTitle("Close");
  await waitFor(() => !textIncludes("Run preview: Demo workflow"), "run preview closes");

  await clickByText("All runs");
  await waitFor(() => textIncludes("Previous runs"), "run history opens");
  assert.equal(await textIncludes("run-1"), true);
  assert.equal(await textIncludes("Run timeline"), true);

  await clickByTitle("Run retention settings");
  await waitFor(() => textIncludes("Retention"), "retention controls open");
  await fillLabeledNumber("Keep latest runs", "7");
  await waitFor(() => lastCall("PUT", "/api/workflows/demo/retention"), "retention settings saved");
  await clickByText("Preview");
  await waitFor(() => lastCall("POST", "/api/workflows/demo/logs/prune"), "retention preview sent");

  await clickByText("Add trusted directory");
  await clickByTitle("Choose trusted directory");
  await waitFor(() => bridgeCall("workspace.selectPath"), "desktop bridge path picker called");
  await clickByText("Add");
  await waitForSavedPayload(
    (payload) =>
      (payload.filesystemAccess ?? []).some(
        (entry) => entry.path === "/workspace/inputs",
      ),
    "selected path serialized",
  );
  await clickByTitle("Open trusted directory in file browser");
  await waitFor(
    () =>
      bridgeCall("workspace.revealPath") ||
      bridgeCall("workspace.openPath"),
    "selected path opened through bridge",
  );

  const firstNodeBefore = await nodePosition("fetch");
  await dragSelector("[data-node-id='fetch']", 90, 45);
  const firstNodeAfter = await nodePosition("fetch");
  assert.ok(firstNodeAfter.left > firstNodeBefore.left + 40);
  assert.ok(firstNodeAfter.top > firstNodeBefore.top + 20);

  await clickByTitle("Add node");
  await waitFor(() => count("[data-testid='workflow-node']") >= 4, "new node added");
  const newNodeId = await newestNodeId();

  await contextMenu("[data-node-id='fetch']");
  await waitFor(() => exists("[data-testid='node-context-menu']"), "node menu opens");
  await clickByText("Duplicate node");
  await waitFor(() => textIncludes("Fetch data copy"), "node duplicated");
  await key("Delete");
  await waitFor(() => !textIncludes("Fetch data copy"), "duplicated node deleted");

  await clickSelector("[data-node-id='fetch']");
  await clickByText("Add edge");
  await setLastSelects(["output_matches", newNodeId]);
  await fillByPlaceholder("regex pattern", "READY=.*");
  await waitForSavedPayload(
    (payload) =>
      payload.edges.some(
        (edge) =>
          edge.from === "fetch" &&
          edge.to === newNodeId &&
          edge.condition === "output_matches" &&
          edge.outputPattern === "READY=.*",
      ),
    "conditional edge serialized",
  );

  await clickLastByTitle("Delete edge");
  await waitForSavedPayload(
    (payload) => !payload.edges.some((edge) => edge.from === "fetch" && edge.to === newNodeId),
    "edge deletion serialized",
  );

  await clickByTitle("Zoom in");
  await clickByTitle("Zoom out");
  await clickByTitle("Fit graph");
  await clickByTitle("Auto-layout graph");
  await fillByLabel("Search nodes", "Summarize");
  await key("Enter");
  await waitFor(() => selectedNodeId() === "summarize", "graph search selected summarize");
  await dragSelector("[data-testid='graph-minimap'] > div", 30, 18);

  await waitForSavedPayload(
    (payload) => payload.nodes.some((node) => node.id === "fetch" && node.x !== 0),
    "dragged position serialized",
  );
}

async function runMobileLayoutRegression() {
  await windowRef.setSize(390, 820);
  await wait(250);
  const layout = await evaluate(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const selectors = [
      ["addNode", "[title='Add node']"],
      ["fitGraph", "[title='Fit graph']"],
      ["zoomIn", "[title='Zoom in']"],
      ["runNow", "[title='Run workflow now']"],
      ["minimap", "[data-testid='graph-minimap']"],
      ["search", "[aria-label='Search nodes']"],
    ];
    const controls = selectors.map(([name, selector]) => {
      const element = document.querySelector(selector);
      if (!element) return { name, missing: true };
      const rect = element.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        name,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      };
    });
    return { controls, viewport };
  });

  assert.ok(layout.controls.length >= 6);
  for (const rect of layout.controls) {
    assert.equal(rect.missing, undefined, `${rect.name} should render on mobile`);
    assert.ok(rect.width > 0 && rect.height > 0);
    assert.ok(rect.left >= 0, `${rect.name} left edge is clipped`);
    assert.ok(rect.top >= 0, `${rect.name} top edge is clipped`);
    assert.ok(rect.right <= layout.viewport.width, `${rect.name} right edge is clipped`);
    assert.ok(rect.bottom <= layout.viewport.height, `${rect.name} bottom edge is clipped`);
  }

  const minimap = layout.controls.find((rect) => rect.name === "minimap");
  for (const rect of layout.controls.filter((candidate) => candidate.name !== "minimap")) {
    assert.equal(rectsOverlap(minimap, rect), false, `minimap overlaps ${rect.name}`);
  }

  await clickByTitle("Fit graph");
  await fillByLabel("Search nodes", "Approve");
  await key("Enter");
  await waitFor(() => selectedNodeId() === "approval", "mobile search remains usable");
}

function workflowFixture() {
  return {
    agents: {},
    description: "Demo workflow",
    edges: [
      {
        id: "edge_fetch_summarize",
        from: "fetch",
        to: "summarize",
        condition: "on_success",
        label: "on success",
      },
      {
        id: "edge_summarize_approval",
        from: "summarize",
        to: "approval",
        condition: "always",
        label: "always",
      },
    ],
    healthWarnings: ["Missing provider CLI: codex"],
    id: "demo",
    name: "Demo workflow",
    nodes: [
      {
        id: "fetch",
        label: "Fetch data",
        operation: { command: "echo READY=1", type: "bash_command", working_dir: "" },
        type: "bash_command",
        x: 0,
        y: 0,
      },
      {
        id: "summarize",
        label: "Summarize",
        operation: { command: "cat summary.txt", type: "bash_command", working_dir: "" },
        type: "bash_command",
        x: 320,
        y: 120,
      },
      {
        id: "approval",
        label: "Approve release",
        operation: {
          approvers: ["ops"],
          message: "Approve deploy to production?",
          notify: false,
          timeout_decision: "reject",
          timeout_seconds: 300,
          type: "approval_gate",
        },
        type: "approval_gate",
        x: 650,
        y: 220,
      },
    ],
    parameters: {},
    sourcePath: "/workspace/demo.toml",
    status: "Ready",
    tags: ["ready"],
  };
}

async function startServer() {
  const staticTypes = {
    ".css": "text/css",
    ".html": "text/html",
    ".js": "text/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
  };

  const nextServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const method = request.method || "GET";
    const body = await readBody(request);
    state.calls.push({ body, method, path: url.pathname });

    if (url.pathname.startsWith("/api/")) {
      return routeApi(method, url.pathname, body, response);
    }

    const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.normalize(path.join(distRoot, requestedPath));
    if (!filePath.startsWith(distRoot)) {
      response.writeHead(404).end();
      return;
    }
    fs.readFile(filePath, (error, data) => {
      if (error) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": staticTypes[path.extname(filePath)] || "application/octet-stream",
      });
      response.end(data);
    });
  });

  await new Promise((resolve) => nextServer.listen(0, "127.0.0.1", resolve));
  const address = nextServer.address();
  baseUrl = `http://127.0.0.1:${address.port}/`;
  return nextServer;
}

function routeApi(method, pathname, body, response) {
  const decodedPath = decodeURIComponent(pathname);
  if (method === "GET" && pathname === "/api/workflows") {
    return json(response, { dataDir: "/workspace", promptAgentIds: [], workflows: [state.workflow] });
  }
  if (method === "GET" && pathname === "/api/dashboards") return json(response, { dashboards: [] });
  if (method === "GET" && pathname === "/api/workflow-templates") return json(response, { templates: [] });
  if (method === "GET" && pathname === "/api/doctor") {
    return json(response, { errors: [], warnings: ["Missing provider CLI: codex"] });
  }
  if (method === "GET" && pathname === "/api/queue") return json(response, { runners: [] });
  if (method === "GET" && pathname === "/api/provider/profiles") return json(response, { profiles: [] });
  if (method === "GET" && pathname === "/api/chat/providers") return json(response, { providers: [] });
  if (method === "GET" && pathname === "/api/workflows/demo/logs/latest") {
    return json(response, {
      log: {
        logPath: "/workspace/.gofer/runs/run-1.log",
        logText: "2026-06-27T10:00:00Z fetch success\n2026-06-27T10:00:02Z summarize success",
        nodeOutputs: { fetch: { output: "READY=1" } },
        runEvents: [
          {
            attempt: 1,
            message: "fetch completed",
            nodeId: "fetch",
            status: "success",
            timestamp: "2026-06-27T10:00:00Z",
          },
          {
            attempt: 1,
            message: "approval waiting",
            nodeId: "approval",
            status: "waiting",
            timestamp: "2026-06-27T10:00:03Z",
          },
        ],
      },
    });
  }
  if (method === "GET" && pathname === "/api/workflows/demo/logs") {
    return json(response, { runs: runHistory() });
  }
  if (method === "GET" && pathname === "/api/workflows/demo/approvals") {
    return json(response, { approvals: state.approvals });
  }
  if (method === "GET" && pathname === "/api/workflows/demo/retention") {
    return json(response, { settings: state.retention });
  }
  if (method === "PUT" && decodedPath === "/api/workflows/demo") {
    state.workflow = { ...state.workflow, ...body };
    return json(response, { workflow: state.workflow });
  }
  if (method === "PUT" && decodedPath === "/api/workflows/demo/retention") {
    state.retention = { ...state.retention, ...body };
    return json(response, { settings: state.retention });
  }
  if (method === "POST" && decodedPath === "/api/workflows/demo/logs/prune") {
    return json(response, { runs: [{ id: "old-run" }], dryRun: Boolean(body?.dryRun) });
  }
  if (method === "POST" && decodedPath === "/api/workflows/demo/plan") {
    return json(response, {
      plan: {
        destructiveActions: ["Deletes /tmp/output.txt"],
        generations: [["fetch"], ["summarize"], ["approval"]],
        providerRequirements: [
          {
            agentId: "analyst",
            available: true,
            binary: "codex",
            subscription: "codex",
            workingDir: "/workspace",
          },
        ],
        requiredSecrets: ["OPENAI_API_KEY"],
        triggerContext: body?.triggerContext ?? {},
        unresolvedDynamicValues: [],
        warnings: ["Dry run before release."],
      },
    });
  }
  if (method === "POST" && decodedPath === "/api/workflows/demo/run") {
    return json(response, {
      run: {
        logPath: "/workspace/.gofer/runs/run-2.log",
        logText: "run complete",
        runEvents: [],
        success: true,
      },
    });
  }

  return json(response, {}, 200);
}

function runHistory() {
  return [
    {
      durationSeconds: 3,
      hasTriggerReplay: true,
      id: "run-1",
      startedAt: "2026-06-27T10:00:00Z",
      status: "waiting",
      triggerId: "deploy-webhook",
    },
    {
      durationSeconds: 4,
      id: "run-0",
      startedAt: "2026-06-26T10:00:00Z",
      status: "success",
    },
  ];
}

function json(response, payload, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(text);
      }
    });
  });
}

async function clickByTitle(title) {
  await clickSelector(`[title="${cssEscape(title)}"]`);
}

async function clickLastByTitle(title) {
  const selector = await evaluate((targetTitle) => {
    const matches = [...document.querySelectorAll(`[title="${CSS.escape(targetTitle)}"]`)];
    const match = matches.at(-1);
    if (!match) return null;
    const token = `browser-test-${Math.random().toString(36).slice(2)}`;
    match.setAttribute("data-browser-test-click", token);
    return `[data-browser-test-click="${token}"]`;
  }, title);
  assert.ok(selector, `Unable to find title: ${title}`);
  await clickSelector(selector);
}

async function clickByText(text) {
  const selector = await evaluate((targetText) => {
    const candidates = [...document.querySelectorAll("button, [role='button']")];
    const match = candidates.find((element) => element.textContent.trim() === targetText);
    if (!match) return null;
    const token = `browser-test-${Math.random().toString(36).slice(2)}`;
    match.setAttribute("data-browser-test-click", token);
    return `[data-browser-test-click="${token}"]`;
  }, text);
  assert.ok(selector, `Unable to find button text: ${text}`);
  await clickSelector(selector);
}

async function clickSelector(selector) {
  const rect = await elementRect(selector);
  await mouse(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

async function contextMenu(selector) {
  await elementRect(selector);
  await evaluate((targetSelector) => {
    const element = document.querySelector(targetSelector);
    const box = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        button: 2,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      }),
    );
  }, selector);
}

async function dragSelector(selector, dx, dy) {
  const rect = await elementRect(selector);
  const startX = rect.left + rect.width / 2;
  const startY = rect.top + rect.height / 2;
  windowRef.webContents.sendInputEvent({ type: "mouseMove", x: startX, y: startY });
  windowRef.webContents.sendInputEvent({ button: "left", clickCount: 1, type: "mouseDown", x: startX, y: startY });
  await wait(50);
  windowRef.webContents.sendInputEvent({ type: "mouseMove", x: startX + dx, y: startY + dy });
  await wait(50);
  windowRef.webContents.sendInputEvent({ button: "left", clickCount: 1, type: "mouseUp", x: startX + dx, y: startY + dy });
  await wait(100);
}

async function mouse(x, y) {
  windowRef.webContents.sendInputEvent({ type: "mouseMove", x, y });
  windowRef.webContents.sendInputEvent({ button: "left", clickCount: 1, type: "mouseDown", x, y });
  windowRef.webContents.sendInputEvent({ button: "left", clickCount: 1, type: "mouseUp", x, y });
  await wait(50);
}

async function key(keyCode) {
  windowRef.webContents.sendInputEvent({ keyCode, type: "keyDown" });
  windowRef.webContents.sendInputEvent({ keyCode, type: "keyUp" });
  await wait(50);
}

async function fillByLabel(label, value) {
  await evaluate(
    ({ labelText, nextValue }) => {
      const input =
        [...document.querySelectorAll("input, textarea, select")].find(
          (candidate) => candidate.getAttribute("aria-label") === labelText,
        ) ||
        [...document.querySelectorAll("label")].find((candidate) =>
          candidate.textContent.includes(labelText),
        )?.querySelector("input, textarea, select");
      if (!input) throw new Error(`Unable to find labeled control: ${labelText}`);
      input.focus();
      input.value = nextValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { labelText: label, nextValue: value },
  );
  await wait(50);
}

async function fillLabeledNumber(label, value) {
  await fillByLabel(label, value);
}

async function fillByPlaceholder(placeholder, value) {
  await evaluate(
    ({ nextValue, targetPlaceholder }) => {
      const input = [...document.querySelectorAll("input, textarea")].find(
        (candidate) => candidate.placeholder === targetPlaceholder,
      );
      if (!input) throw new Error(`Unable to find placeholder: ${targetPlaceholder}`);
      input.focus();
      input.value = nextValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { nextValue: value, targetPlaceholder: placeholder },
  );
  await wait(50);
}

async function setLastSelects(values) {
  await evaluate((nextValues) => {
    const selects = [...document.querySelectorAll("select")].slice(-3);
    nextValues.forEach((value, index) => {
      const select = selects[index];
      if (!select) throw new Error(`Missing select ${index}`);
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }, values);
  await wait(100);
}

async function nodePosition(id) {
  return elementRect(`[data-node-id='${cssEscape(id)}']`);
}

async function newestNodeId() {
  return evaluate(() => document.querySelectorAll("[data-testid='workflow-node']")[3]?.dataset.nodeId);
}

async function selectedNodeId() {
  return evaluate(() => {
    const selected = [...document.querySelectorAll("[data-testid='workflow-node']")].find((node) =>
      node.className.includes("border-teal-500"),
    );
    return selected?.dataset.nodeId ?? null;
  });
}

async function waitForSavedPayload(predicate, label) {
  await waitFor(() => {
    const payload = [...state.calls].reverse().find(
      (call) => call.method === "PUT" && call.path === "/api/workflows/demo" && call.body,
    )?.body;
    return payload ? predicate(payload) : false;
  }, label, 5000);
}

function lastCall(method, pathName) {
  return state.calls.some((call) => call.method === method && call.path === pathName);
}

async function bridgeCall(method, payload) {
  return evaluate(
    ({ expectedMethod, expectedPayload }) =>
      (window.__goferBridgeCalls ?? []).some(
        (call) =>
          call.method === expectedMethod &&
          (expectedPayload === undefined || call.payload === expectedPayload),
      ),
    { expectedMethod: method, expectedPayload: payload },
  );
}

function rectsOverlap(a, b) {
  const gap = 1;
  return !(
    a.right <= b.left + gap ||
    b.right <= a.left + gap ||
    a.bottom <= b.top + gap ||
    b.bottom <= a.top + gap
  );
}

async function exists(selector) {
  return evaluate((targetSelector) => Boolean(document.querySelector(targetSelector)), selector);
}

async function count(selector) {
  return evaluate((targetSelector) => document.querySelectorAll(targetSelector).length, selector);
}

async function textIncludes(text) {
  return evaluate((targetText) => document.body.textContent.includes(targetText), text);
}

async function elementRect(selector) {
  const rect = await evaluate((targetSelector) => {
    const element = document.querySelector(targetSelector);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { height: box.height, left: box.left, top: box.top, width: box.width };
  }, selector);
  assert.ok(rect, `Element not found: ${selector}`);
  return rect;
}

async function waitFor(check, label, timeoutMs = 7000, diagnostics) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  const details = diagnostics ? await diagnostics() : "";
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}${details ? `\n${details}` : ""}`,
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluate(fn, arg) {
  const source = `(${fn.toString()})(${JSON.stringify(arg)})`;
  return windowRef.webContents.executeJavaScript(source, true);
}

async function browserDiagnosticSnapshot() {
  const snapshot = await evaluate(() => {
    const nodes = document.querySelectorAll("[data-testid='workflow-node']").length;
    const canvas = Boolean(document.querySelector("[data-testid='dag-canvas']"));
    const body = document.body.textContent.replace(/\s+/g, " ").trim().slice(0, 1200);
    return { body, canvas, nodes, title: document.title, url: window.location.href };
  });
  const recentMessages = rendererMessages
    .slice(-10)
    .map((item) => `${item.message} (${item.sourceId}:${item.line})`)
    .join("\n");
  return [
    `Browser snapshot: ${JSON.stringify(snapshot)}`,
    recentMessages ? `Recent renderer messages:\n${recentMessages}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function cssEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/'/g, "\\'");
}

async function cleanup(exitCode) {
  try {
    windowRef?.close();
    await new Promise((resolve) => server?.close(resolve));
  } finally {
    app.exit(exitCode);
  }
}

function fail(error) {
  clearTimeout(timeout);
  console.error(error);
  cleanup(1);
}
