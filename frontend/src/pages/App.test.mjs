/* global document, TextEncoder */
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
let ensureGoferApiToken;
let installGoferApiFetchAuth;
let withGoferApiAuth;
let appModule;
let canvasModule;
let patchModule;

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
  ({ apiUrl, ensureGoferApiToken, installGoferApiFetchAuth, withGoferApiAuth } =
    await viteServer.ssrLoadModule("/src/lib/api.js"));
  appModule = await viteServer.ssrLoadModule("/src/pages/App.jsx");
  canvasModule = await viteServer.ssrLoadModule("/src/components/DagCanvas.jsx");
  patchModule = await viteServer.ssrLoadModule("/src/lib/workflowPatch.js");
});

after(async () => {
  await viteServer?.close();
});

beforeEach(() => {
  globalThis.window = {
    goferApiBaseUrl: undefined,
    goferApiToken: undefined,
    __goferApiFetchAuthInstalled: undefined,
    __goferApiTokenPromise: undefined,
    location: { href: "http://127.0.0.1:5173/" },
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

test("withGoferApiAuth attaches bearer tokens only to Gofer API requests", () => {
  globalThis.window.goferApiBaseUrl = "http://127.0.0.1:8765";
  globalThis.window.goferApiToken = "ui-token";

  const [, init] = withGoferApiAuth("http://127.0.0.1:8765/api/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(init.headers.get("Authorization"), "Bearer ui-token");
  assert.equal(init.headers.get("Content-Type"), "application/json");

  const [, externalInit] = withGoferApiAuth("https://example.com/api/workflows", {
    method: "POST",
  });
  assert.equal(externalInit.headers, undefined);
});

test("ensureGoferApiToken loads the UI session token without changing API base URL", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return {
      ok: true,
      json: async () => ({
        apiBaseUrl: "http://127.0.0.1:8765/api",
        apiToken: "boot-token",
      }),
    };
  };

  const token = await ensureGoferApiToken(fetchImpl);

  assert.equal(token, "boot-token");
  assert.equal(globalThis.window.goferApiToken, "boot-token");
  assert.equal(globalThis.window.goferApiBaseUrl, undefined);
  assert.deepEqual(requests, ["/api/session"]);
});

test("installGoferApiFetchAuth bootstraps token before mutating Gofer API requests", async () => {
  const calls = [];
  globalThis.window.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === "/api/session") {
      return {
        ok: true,
        json: async () => ({ apiToken: "boot-token" }),
      };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };

  installGoferApiFetchAuth();
  await globalThis.window.fetch("/api/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "/api/session");
  assert.equal(calls[1].url, "/api/workflows");
  assert.equal(calls[1].init.headers.get("Authorization"), "Bearer boot-token");
  assert.equal(calls[1].init.headers.get("Content-Type"), "application/json");
});

test("installGoferApiFetchAuth does not bootstrap for webhook requests", async () => {
  const calls = [];
  globalThis.window.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ ok: true }) };
  };

  installGoferApiFetchAuth();
  await globalThis.window.fetch("/api/workflows/demo/webhooks/main/trigger", {
    method: "POST",
  });

  assert.deepEqual(
    calls.map((call) => call.url),
    ["/api/workflows/demo/webhooks/main/trigger"],
  );
  assert.equal(calls[0].init.headers, undefined);
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

test("workflow refresh helpers preserve pending dashboard item loop sources", () => {
  const remote = [
    {
      id: "demo",
      name: "Remote",
      nodes: [
        {
          id: "loop",
          type: "loop",
          label: "Loop",
          operation: {
            type: "loop",
            source: { type: "count", count: 1, max_concurrency: 1, fail_fast: false },
          },
        },
      ],
      edges: [],
      agents: {},
      sourcePath: "/tmp/demo.toml",
      status: "Ready",
    },
  ];
  const local = {
    ...remote[0],
    nodes: [
      {
        ...remote[0].nodes[0],
        operation: {
          type: "loop",
          source: {
            type: "dashboard_items",
            dashboard: "development-dashboard",
            component: "tickets",
            filter: "status=todo",
            max_concurrency: 1,
            fail_fast: false,
          },
        },
      },
    ],
  };

  const preserved = appModule.preserveLocalWorkflows(remote, [local], "/data")[0];

  assert.equal(preserved.nodes[0].operation.source.type, "dashboard_items");
  assert.equal(preserved.nodes[0].operation.source.dashboard, "development-dashboard");
  assert.equal(preserved.sourcePath, "/tmp/demo.toml");
});

test("workflow save payload keeps graph positions and serializes defaults", () => {
  const payload = appModule.workflowPayloadForSave(
    {
      id: "demo",
      name: "Demo",
      filesystemAccess: [
        { path: "/project", read: false, write: false, execute: true },
        { path: "/outside/shared", read: false, write: false, execute: true },
        { path: "/outside/shared/", read: true, write: true, execute: true },
        { path: "" },
      ],
      metadata: {
        canvas: {
          groups: [{ id: "group-1", label: "Phase", nodeIds: ["step"] }],
        },
      },
      nodes: [
        {
          id: "step",
          type: "bash_command",
          label: "Run",
          operation: { type: "bash_command", command: "echo hi" },
        },
      ],
    },
    "/project",
  );

  assert.deepEqual(payload.edges, []);
  assert.deepEqual(payload.agents, {});
  assert.deepEqual(payload.filesystemAccess, [
    { path: "/project", read: true, write: true, execute: false },
    { path: "/outside/shared", read: true, write: true, execute: false },
  ]);
  assert.equal(payload.nodes[0].x, 0);
  assert.equal(payload.nodes[0].y, 0);
  assert.equal(payload.nodes[0].operation.command, "echo hi");
  assert.deepEqual(payload.metadata.canvas.groups[0].nodeIds, ["step"]);
});

test("workflow deletion helpers remove the selected workflow and choose the next active ID", () => {
  const workflows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  assert.deepEqual(appModule.workflowIdsAfterDelete(workflows, "b"), ["a", "c"]);
  assert.equal(appModule.nextActiveWorkflowIdAfterDelete(workflows, "b", "b"), "a");
  assert.equal(appModule.nextActiveWorkflowIdAfterDelete(workflows, "c", "b"), "c");
});

test("App keeps the new workflow name field enabled after deleting a workflow", async () => {
  const dom = await mountReact(
    React.createElement(appModule.default),
    createFetchMock([
      jsonResponse("/api/workflows", workflowsPayload([
        workflowFixture({ id: "demo", name: "Demo" }),
        workflowFixture({ id: "other", name: "Other" }),
      ])),
      jsonResponse("/api/chat/providers", {
        providers: [{ id: "codex", name: "Codex", available: true, models: ["cli-default"] }],
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
    messages: [{ role: "user", body: "hi" }],
    workflow: { id: "workflow-assistant:thread-1", chatThreadId: "thread-1" },
  }), {
    provider: "codex",
    model: "cli-default",
    messages: [{ role: "user", body: "hi" }],
    workflow: { id: "workflow-assistant:thread-1", chatThreadId: "thread-1" },
  });
});

test("workflow patch helpers parse, validate, apply selected hunks, and reject unsafe actions", () => {
  const workflow = workflowFixture({ id: "demo", name: "Demo" });
  const body = [
    "Proposed patch:",
    "```gofer-workflow-patch",
    JSON.stringify({
      type: "gofer.workflow.patch",
      version: 1,
      title: "Add review step",
      operations: [
        {
          id: "add-review",
          op: "add_node",
          node: {
            id: "review",
            type: "agent",
            label: "Review output",
            operation: { type: "agent", agent_id: "reviewer", prompt: "Review {{step.output}}" },
          },
        },
        {
          id: "connect-review",
          op: "add_edge",
          edge: {
            from: "step",
            to: "review",
            condition: "output_matches",
            outputPattern: "ok",
          },
        },
      ],
    }),
    "```",
  ].join("\n");

  const parsed = patchModule.extractWorkflowPatch(body);
  assert.equal(parsed.ok, true);
  const review = patchModule.buildPatchReview(parsed.patch, workflow);
  assert.equal(review.ok, true);
  assert.deepEqual(review.hunks.map((hunk) => hunk.risk), ["graph", "graph"]);

  const selected = patchModule.selectedPatchOperations(parsed.patch, ["add-review"]);
  const nextWorkflow = patchModule.applyWorkflowPatch(workflow, selected);
  assert.equal(nextWorkflow.nodes.some((node) => node.id === "review"), true);
  assert.equal(nextWorkflow.edges.length, 0);
  assert.equal(nextWorkflow.agents.reviewer.subscription, "codex");

  const unsafe = patchModule.buildPatchReview(
    { type: "gofer.workflow.patch", version: 1, operations: [{ op: "run_workflow" }] },
    workflow,
  );
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.errors.join("\n"), /Unsupported patch operation/);
});

test("App reviews and applies selected chat workflow patch hunks with validation and audit metadata", async () => {
  const patch = {
    type: "gofer.workflow.patch",
    version: 1,
    title: "Add notify step",
    summary: "Add a notification node and connect it conditionally.",
    operations: [
      {
        id: "add-notify",
        op: "add_node",
        node: {
          id: "notify",
          type: "notification",
          label: "Notify owner",
          x: 240,
          y: 80,
          operation: { type: "notification", title: "Done", body: "Workflow finished" },
        },
      },
      {
        id: "connect-notify",
        op: "add_edge",
        edge: {
          from: "step",
          to: "notify",
          condition: "output_matches",
          outputPattern: "done",
        },
      },
    ],
  };
  const chatStream = streamResponse([
    `{"type":"final","message":{"body":${JSON.stringify(`Here is the patch:\n\`\`\`gofer-workflow-patch\n${JSON.stringify(patch)}\n\`\`\``)}}}\n`,
  ]);
  const fetchMock = createFetchMock([
    jsonResponse("/api/workflows", workflowsPayload([workflowFixture({ id: "demo", name: "Demo" })])),
    jsonResponse("/api/chat/providers", {
      providers: [{ id: "codex", name: "Codex", available: true, models: ["cli-default"] }],
    }),
    jsonResponse("/api/workflows/demo/logs/latest", { log: null }),
    jsonResponse("/api/workflows/demo/logs?limit=100", { runs: [] }),
    (url) => (url === "/api/chat/stream" ? chatStream(url) : null),
    jsonResponse("/api/workflows/demo/validate", { ok: true, diagnostics: [] }, { method: "POST" }),
    (url, options = {}) => {
      if (url !== "/api/workflows/demo" || options.method !== "PUT") return null;
      const saved = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ workflow: { ...saved, status: "Ready", tags: ["ready"] } }),
      };
    },
  ]);
  const dom = await mountReact(React.createElement(appModule.default), fetchMock);

  await dom.flush();
  await dom.click(dom.byText("New thread"));
  await dom.change(dom.first("textarea"), "Add a notification");
  await dom.click(dom.byTitle("Send message"));
  await dom.flush();
  await dom.click(dom.byText("Review patch"));
  await dom.flush();

  assert.match(dom.text(), /Review workflow patch/);
  assert.match(dom.text(), /Add a notification node and connect it conditionally/);
  assert.match(dom.text(), /Connect nodes/);

  const connectCheckbox = dom.controlAfterLabel("Connect nodes");
  await dom.change(connectCheckbox, false);
  await dom.click(dom.byText("Apply selected"));
  await dom.flush();

  const saveCall = fetchMock.calls.find((call) => call.url === "/api/workflows/demo" && call.options.method === "PUT");
  const saved = JSON.parse(saveCall.options.body);
  assert.equal(saved.nodes.some((node) => node.id === "notify"), true);
  assert.equal(saved.edges.length, 0);
  assert.deepEqual(saved.auditMetadata.appliedHunkIds, ["add-notify"]);
  assert.equal(saved.auditMetadata.prompt, "Add a notification");
  assert.match(saved.auditMetadata.response, /gofer-workflow-patch/);

  await dom.unmount();
});

test("App rejects invalid chat workflow patches before changing the workflow", async () => {
  const patch = {
    type: "gofer.workflow.patch",
    version: 1,
    title: "Broken edge",
    operations: [
      {
        id: "bad-edge",
        op: "add_edge",
        edge: { from: "missing", to: "step" },
      },
    ],
  };
  const chatStream = streamResponse([
    `{"type":"final","message":{"body":${JSON.stringify(`\`\`\`json\n${JSON.stringify(patch)}\n\`\`\``)}}}\n`,
  ]);
  const fetchMock = createFetchMock([
    jsonResponse("/api/workflows", workflowsPayload([workflowFixture({ id: "demo", name: "Demo" })])),
    jsonResponse("/api/chat/providers", {
      providers: [{ id: "codex", name: "Codex", available: true, models: ["cli-default"] }],
    }),
    jsonResponse("/api/workflows/demo/logs/latest", { log: null }),
    jsonResponse("/api/workflows/demo/logs?limit=100", { runs: [] }),
    (url) => (url === "/api/chat/stream" ? chatStream(url) : null),
  ]);
  const dom = await mountReact(React.createElement(appModule.default), fetchMock);

  await dom.flush();
  await dom.click(dom.byText("New thread"));
  await dom.change(dom.first("textarea"), "Connect missing node");
  await dom.click(dom.byTitle("Send message"));
  await dom.flush();
  await dom.click(dom.byText("Review patch"));
  await dom.flush();

  assert.match(dom.text(), /Patch rejected/);
  assert.match(dom.text(), /Edge source 'missing' does not exist/);
  assert.equal(
    fetchMock.calls.some((call) => call.url === "/api/workflows/demo" && call.options.method === "PUT"),
    false,
  );

  await dom.unmount();
});

test("RunPreviewDialog renders grouped warnings, destructive actions, providers, fan-out samples, and node details", () => {
  const plan = {
    workflowId: "preview-demo",
    workflowName: "Preview Demo",
    startNodes: ["scan"],
    validation: {
      ok: true,
      diagnostics: [
        { severity: "warning", message: "Provider CLI missing", subject: "agent:reviewer" },
      ],
    },
    warnings: ["Missing read target: /workspace/missing.txt"],
    destructiveActions: ["overwrite file: /workspace/out.txt"],
    requiredSecrets: ["OPENAI_API_KEY"],
    secretReadiness: [
      {
        name: "OPENAI_API_KEY",
        status: "missing",
        present: false,
        sources: ["node:review.provider.api_key"],
      },
    ],
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
    unresolvedDynamicValues: ["agent.prompt={{previous.output}}"],
    triggerContext: {
      watch: { path: "/workspace/inbox", glob: "*.md", mode: "fanout" },
    },
    conditionalBranches: [{ from: "scan", to: "review", label: "output_matches:ready" }],
    resourceLimits: {
      max_fanout_items: 10,
      max_fanout_concurrency: 2,
      max_files_scanned: 100,
      max_file_read_bytes: 1024,
    },
    executionLimits: { maxTotalNodeRuns: 25 },
    usageBudget: { enabled: true, max_agent_calls: 3 },
    projectedLlmUsage: {
      agent_calls: 2,
      total_tokens: 1200,
      estimated_cost: 0.03,
      agent_time_seconds: 4.5,
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
            sideEffectDetails: [
              {
                kind: "network",
                action: "http_request",
                method: "GET",
                host: "internal.service",
                networkAllowlist: ["10.0.0.0/8", "internal.service"],
              },
            ],
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
            unresolvedDynamicValues: ["scan.inputs={{trigger.file}}"],
            retryCount: 1,
            retryDelaySeconds: 2,
            timeoutSeconds: 30,
            allowFailure: true,
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
  assert.match(html, /Start nodes/);
  assert.match(html, /scan/);
  assert.match(html, /Validation diagnostics/);
  assert.match(html, /warning: Provider CLI missing \(agent:reviewer\)/);
  assert.match(html, /overwrite file: \/workspace\/out\.txt/);
  assert.match(html, /Warnings/);
  assert.match(html, /Required secrets/);
  assert.match(html, /OPENAI_API_KEY/);
  assert.match(html, /Secret readiness/);
  assert.match(html, /OPENAI_API_KEY: missing/);
  assert.match(html, /Provider CLI requirements/);
  assert.match(
    html,
    /reviewer: codex binary=codex \(missing\) cwd=\/workspace\/agents profile=quality model=gpt-5 timeout=45s/,
  );
  assert.match(html, /Trigger context/);
  assert.match(html, /Watch: \/workspace\/inbox glob=\*\.md mode=fanout/);
  assert.match(html, /Conditional branches/);
  assert.match(html, /scan -&gt; review when output_matches:ready/);
  assert.match(html, /Projected LLM usage/);
  assert.match(html, /Agent calls: 2/);
  assert.match(html, /Usage budget/);
  assert.match(html, /max_agent_calls: 3/);
  assert.match(html, /Resource limits/);
  assert.match(html, /Fan-out concurrency: 2/);
  assert.match(html, /<details/);
  assert.match(html, /Generation 0/);
  assert.match(html, /Working directory: \/workspace\/jobs/);
  assert.match(html, /Network allowlist internal\.service: 10\.0\.0\.0\/8, internal\.service/);
  assert.match(html, /Fan-out directory:/);
  assert.match(html, /at least 2 items/);
  assert.match(html, /Sample: \/workspace\/inbox\/a\.md/);
  assert.match(html, /Unresolved values/);
  assert.match(html, /Timeout: 30s/);
  assert.match(html, /Retries: 1 delay=2s/);
  assert.match(html, /Allow failure/);
});

test("RunPreviewDialog blocks execution while validation has errors", () => {
  const html = renderToStaticMarkup(
    React.createElement(appModule.RunPreviewDialog, {
      plan: {
        workflowId: "broken",
        workflowName: "Broken",
        validation: {
          ok: false,
          diagnostics: [
            {
              severity: "error",
              message: "Edge target 'missing' does not exist",
              subject: "edge:start->missing",
            },
          ],
        },
        generations: [],
      },
      workflow: { id: "broken", name: "Broken" },
      onCancel: () => {},
      onRun: () => {},
    }),
  );

  assert.match(html, /error: Edge target &#x27;missing&#x27; does not exist/);
  assert.match(html, /Resolve validation errors before running\./);
  assert.match(html, /disabled=""/);
});

test("UsageSummaryStrip renders run cost, expensive nodes, slow nodes, and budget failures", () => {
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
        budget_failures: [{ node_id: "review" }],
      },
    }),
  );

  assert.match(html, /LLM usage/);
  assert.match(html, /3 calls/);
  assert.match(html, /1,234 tokens/);
  assert.match(html, /cost~\$0\.045000/);
  assert.match(html, /Most expensive: review/);
  assert.match(html, /Slowest: draft/);
  assert.match(html, /Budget failures: review/);
});

test("bundle import preview surfaces high-risk webhook trigger warnings", () => {
  const preview = appModule.formatBundleImportPreview({
    workflowId: "local-hook",
    workflowName: "Local Hook",
    filesToCreate: [],
    filesToOverwrite: [],
    manifest: {
      includedPaths: [],
      providerAssumptions: [],
      triggers: [
        {
          type: "webhook",
          id: "github",
          source: "github",
          enabled: "true",
          tokenConfigured: "false",
          allowUnauthenticated: "true",
          risk: "high",
          riskReasons: "unauthenticated_allowed",
        },
      ],
    },
    riskWarnings: [
      "Webhook trigger 'github' explicitly allows unauthenticated requests; only use this for local testing.",
    ],
  });

  assert.match(preview, /webhook github: github, enabled, allows unauthenticated requests, high risk/);
  assert.match(preview, /High-risk configuration:/);
  assert.match(preview, /explicitly allows unauthenticated requests/);
});

test("App loads workflows, preserves local edits on silent refreshes, saves errors, deletes workflows, and loads logs", async () => {
  const dom = await mountReact(
    React.createElement(appModule.default),
    createFetchMock([
      jsonResponse("/api/workflows", workflowsPayload([
        workflowFixture({ id: "demo", name: "Demo", label: "Original label" }),
        workflowFixture({ id: "other", name: "Other", label: "Other label" }),
      ])),
      jsonResponse("/api/chat/providers", {
        providers: [{ id: "codex", name: "Codex", available: true, models: ["cli-default"] }],
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

  const labelInput = dom.controlAfterLabel("Label");
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
    '{"type":"thought","text":"Inspecting graph"}\n',
    '{"type":"final","message":{"body":"Looks ready"}}\n',
  ]);
  const fetchMock = createFetchMock([
    jsonResponse("/api/workflows", workflowsPayload([
      {
        ...workflowFixture({ id: "demo", name: "Demo", status: "Running" }),
        runs: [{ id: "run-1", status: "running", startedAt: "2026-01-02T03:04:05Z" }],
      },
    ])),
    jsonResponse("/api/chat/providers", {
      providers: [{ id: "codex", name: "Codex", available: true, models: ["cli-default"] }],
    }),
    jsonResponse("/api/workflows/demo/logs/latest", {
      log: { logText: "running log", logPath: "/tmp/demo.log" },
    }),
    jsonResponse("/api/workflows/demo/logs?limit=100", {
      runs: [{ id: "run-1", status: "running", startedAt: "2026-01-02T03:04:05Z" }],
    }),
    jsonResponse("/api/workflows/demo", {
      workflow: workflowFixture({ id: "demo", name: "Demo", status: "Ready" }),
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
  const stopButton = dom.byTitle("Stop all runs");
  assert.equal(stopButton.disabled, false);
  await dom.click(stopButton);
  await dom.flush();
  assert.equal(fetchMock.calls.some((call) => call.url === "/api/workflows/demo/stop"), true);

  await dom.click(dom.byTitle("Start another workflow run"));
  await dom.flush();
  assert.match(dom.text(), /Run preview: Demo/);
  assert.match(dom.text(), /delete file: \/tmp\/out\.txt/);
  const previewRunButton = dom.ancestor(dom.byText("Run workflow"), "BUTTON");
  assert.match(previewRunButton.getAttribute("class"), /inline-flex/);
  assert.match(previewRunButton.getAttribute("class"), /items-center/);
  assert.match(previewRunButton.getAttribute("class"), /gap-2/);

  await dom.click(previewRunButton);
  await dom.flush();
  assert.match(dom.text(), /run stopped/);
  assert.match(dom.text(), /Stopped/);
  const runRequest = fetchMock.calls.find((call) => call.url === "/api/workflows/demo/run");
  assert.deepEqual(JSON.parse(runRequest.options.body), { dryRun: false, triggerContext: {} });

  await dom.click(dom.byText("New thread"));
  await dom.change(dom.first("textarea"), "Explain this workflow");
  await dom.click(dom.byTitle("Send message"));
  await dom.flush();
  assert.match(dom.text(), /Explain this workflow/);
  assert.match(dom.text(), /Looks ready/);
  const chatRequest = fetchMock.calls.find((call) => call.url === "/api/chat/stream");
  assert.equal(JSON.parse(chatRequest.options.body).workflow.selectedWorkflowId, "demo");

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
  let workflow = workflowFixture({ id: "canvas", name: "Canvas", label: "Initial command" });
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
  await dom.click(dom.byText("Cancel"));
  assert(!dom.text().includes("Node label"));

  await dom.pointer(
    dom.ancestor(dom.byText("Initial command copy"), "ARTICLE"),
    "onContextMenu",
    { button: 2, clientX: 90, clientY: 100 },
  );
  await dom.click(dom.byText("Rename node"));
  await dom.change(dom.controlAfterLabel("Node label"), "Renamed command");
  await dom.click(dom.byTitle("Confirm node rename"));
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
  assert.ok(dom.byText("Approval Required"));
  assert.ok(dom.byText("Review deployment"));
  assert.ok(dom.byText("Approve deployment?"));

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
          budget_failures: [
            { node_id: "step", budget_violations: ["node max_estimated_cost exceeded"] },
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
  assert.match(dom.text(), /Budget failures: step/);
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

test("DagCanvas notification inspector exposes retry controls for network channels", async () => {
  const workflow = workflowFixture({ id: "notify-canvas", name: "Notify Canvas" });
  workflow.nodes = [
    {
      id: "notify",
      type: "notification",
      label: "Notify ops",
      x: 0,
      y: 0,
      operation: {
        type: "notification",
        channel: "email",
        title: "Deploy",
        body: "Done",
        email_from: "gofer@example.test",
        email_to: ["ops@example.test"],
        smtp_host: "smtp.example.test",
        smtp_username: "***",
        smtp_password: "***",
        retry: { attempts: 2, backoff_seconds: 0.5, retry_on_statuses: [429, 503] },
      },
    },
  ];
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      dataDir: "/workspace",
      workflow,
      onWorkflowChange() {},
    }),
    createFetchMock([]),
  );

  await dom.flush();
  await dom.pointer(dom.ancestor(dom.byText("Notify ops"), "ARTICLE"), "onPointerDown");
  await dom.flush();
  assert.ok(dom.controlAfterLabel("Retry attempts"));
  assert.ok(dom.controlAfterLabel("Retry backoff seconds"));
  assert.ok(dom.controlAfterLabel("Retry statuses"));

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

  await dom.flush();
  assert.match(dom.text(), /API trigger: github \(github\)/);
  assert.match(dom.text(), /Webhook\/API triggers/);
  assert.match(dom.text(), /Token required/);

  await dom.click(dom.byTitle("Select workflow run"));
  await dom.click(dom.ancestor(dom.byText("Replay webhook payload"), "BUTTON"));
  assert.deepEqual(replayCalls, [{ runId: "run-1.log", triggerId: "github" }]);

  await dom.unmount();
});

test("DagCanvas marks enabled unauthenticated webhook triggers as high risk", async () => {
  const workflowChanges = [];
  const workflow = {
    ...workflowFixture({ id: "hook-risk", name: "Hook Risk" }),
    webhooks: {
      github: {
        id: "github",
        enabled: true,
        source: "github",
        concurrency_policy: "allow",
      },
    },
  };
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      dataDir: "/workspace",
      workflow,
      onWorkflowChange(patch) {
        workflowChanges.push(patch);
      },
    }),
    createFetchMock([]),
  );

  await dom.flush();
  assert.match(dom.text(), /API trigger: github \(github\) - high risk/);
  assert.match(dom.text(), /High risk/);
  assert.match(dom.text(), /No token configured/);
  assert.match(dom.text(), /Missing authentication/);

  await dom.change(dom.controlAfterLabel("Allow unauthenticated local testing"), true);
  assert.equal(
    workflowChanges.at(-1).webhooks.github.allow_unauthenticated,
    true,
  );

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

test("DagCanvas exposes dashboard item fields as selectable outputs", () => {
  const fields = canvasModule.nodeOutputFields({
    id: "tickets",
    type: "dashboard_item",
    operation: { type: "dashboard_item" },
  });
  const paths = new Set(fields.map(([pathValue]) => pathValue));

  assert(paths.has("items"));
  assert(paths.has("data.message"));
  assert(paths.has("data.items"));
  assert(paths.has("data.item"));
  assert(paths.has("data.selected"));
});

test("DagCanvas creates dashboard item loop sources and exposes dashboard loop fields", () => {
  assert.deepEqual(canvasModule.defaultFanSource("dashboard_items"), {
    type: "dashboard_items",
    dashboard: "",
    component: "",
    filter: "",
    max_concurrency: 1,
    fail_fast: false,
  });

  const sourceOptions = canvasModule.buildInputSourceOptions(
    { id: "agent", type: "agent" },
    [
      {
        id: "loop",
        label: "Loop tickets",
        type: "loop",
        operation: {
          type: "loop",
          source: {
            type: "dashboard_items",
            dashboard: "development-dashboard",
            component: "tickets",
          },
        },
      },
      { id: "agent", type: "agent" },
    ],
    [{ from: "loop", to: "agent" }],
    [
      {
        id: "development-dashboard",
        name: "Development Dashboard",
        sections: [
          {
            id: "kanban",
            title: "Kanban",
            components: [
              {
                id: "tickets",
                title: "Tickets",
                schema: {
                  title: { type: "string" },
                  status: { type: "enum", values: ["backlog", "todo"] },
                },
                items: [
                  {
                    id: "ticket-1",
                    title: "Write docs",
                    owner: "Dana",
                    status: "todo",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  );
  const paths = new Set(sourceOptions.map(([pathValue]) => pathValue));

  assert(paths.has("loop.current.item_id"));
  assert(paths.has("loop.current.item_json"));
  assert(paths.has("loop.current.item.title"));
  assert(paths.has("loop.current.item.status"));
  assert(paths.has("loop.current.item.owner"));
  assert(!paths.has("loop.current.file_path"));
});

test("DagCanvas only exposes loop inputs that match the parent loop source", () => {
  const countOptions = canvasModule.buildInputSourceOptions(
    { id: "child", type: "bash_command" },
    [
      {
        id: "loop",
        label: "Repeat",
        type: "loop",
        operation: {
          type: "loop",
          source: { type: "count", count: 3 },
        },
      },
      { id: "child", type: "bash_command" },
    ],
    [{ from: "loop", to: "child" }],
  );
  const countPaths = new Set(countOptions.map(([pathValue]) => pathValue));
  assert(countPaths.has("loop.current.index"));
  assert(!countPaths.has("loop.current.file_path"));
  assert(!countPaths.has("loop.current.item_id"));

  const directoryOptions = canvasModule.buildInputSourceOptions(
    { id: "child", type: "bash_command" },
    [
      {
        id: "loop",
        label: "Files",
        type: "loop",
        operation: {
          type: "loop",
          source: { type: "directory", path: "docs", include_content: false },
        },
      },
      { id: "child", type: "bash_command" },
    ],
    [{ from: "loop", to: "child" }],
  );
  const directoryPaths = new Set(directoryOptions.map(([pathValue]) => pathValue));
  assert(directoryPaths.has("loop.current.file_path"));
  assert(!directoryPaths.has("loop.current.file_content"));
});

test("DagCanvas exposes loop inputs to downstream iteration nodes", () => {
  const nodes = [
    {
      id: "loop",
      label: "Files",
      type: "loop",
      operation: {
        type: "loop",
        source: { type: "directory", path: "docs", include_content: true },
      },
    },
    { id: "first", type: "bash_command" },
    { id: "second", type: "bash_command" },
    { id: "after", type: "bash_command" },
  ];
  const edges = [
    { from: "loop", to: "first", condition: "always" },
    { from: "first", to: "second", condition: "always" },
    { from: "loop", to: "after", condition: "after_loop" },
  ];

  const downstreamOptions = canvasModule.buildInputSourceOptions(
    { id: "second", type: "bash_command" },
    nodes,
    edges,
  );
  const downstreamPaths = new Set(downstreamOptions.map(([pathValue]) => pathValue));
  assert(downstreamPaths.has("loop.current.file_path"));
  assert(downstreamPaths.has("loop.current.file_content"));

  const afterLoopOptions = canvasModule.buildInputSourceOptions(
    { id: "after", type: "bash_command" },
    nodes,
    edges,
  );
  const afterLoopPaths = new Set(afterLoopOptions.map(([pathValue]) => pathValue));
  assert(!afterLoopPaths.has("loop.current.file_path"));
  assert(!afterLoopPaths.has("loop.current.file_content"));
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

  workflow = canvasModule.removeWorkflowNode(workflow, "a");
  assert.deepEqual(workflow.nodes.map((node) => node.id), ["b"]);
  assert.deepEqual(workflow.edges, []);
});

test("DagCanvas canvas group helpers preserve metadata without changing graph semantics", () => {
  let workflow = {
    id: "wf",
    agents: {},
    nodes: [
      { id: "scan", type: "bash_command", label: "Scan", operation: { type: "bash_command" }, x: 10, y: 20 },
      { id: "review", type: "agent", label: "Review", operation: { type: "agent" }, x: 330, y: 20 },
      { id: "ship", type: "pass", label: "Ship", operation: { type: "pass" }, x: 660, y: 20 },
    ],
    edges: [{ id: "scan-review", from: "scan", to: "review" }],
  };

  workflow = canvasModule.createCanvasGroup(workflow, ["scan", "review"]);
  let group = canvasModule.normalizeCanvasGroups(workflow)[0];
  assert.equal(group.label, "Group 1");
  assert.deepEqual(group.nodeIds, ["scan", "review"]);
  assert.deepEqual(workflow.edges, [{ id: "scan-review", from: "scan", to: "review" }]);

  workflow = canvasModule.updateCanvasGroup(workflow, group.id, {
    label: "Research",
    color: "#9333ea",
    collapsed: true,
  });
  group = canvasModule.normalizeCanvasGroups(workflow)[0];
  assert.equal(group.label, "Research");
  assert.equal(group.color, "#9333ea");
  assert.deepEqual(
    canvasModule.visibleNodesForGroups(workflow.nodes, [group]).map((node) => node.id),
    ["ship"],
  );
  assert.deepEqual(canvasModule.visibleEdgesForGroups(workflow.edges, [workflow.nodes[2]]), []);

  workflow = canvasModule.moveCanvasGroup(workflow, group.id, { x: 40, y: 10 });
  assert.equal(workflow.nodes[0].x, 50);
  assert.equal(workflow.nodes[1].x, 370);
  assert.equal(canvasModule.normalizeCanvasGroups(workflow)[0].x, group.x + 40);

  workflow = canvasModule.duplicateCanvasGroup(workflow, group.id);
  assert.equal(canvasModule.normalizeCanvasGroups(workflow).length, 2);

  workflow = canvasModule.deleteCanvasGroup(workflow, group.id);
  assert.equal(canvasModule.normalizeCanvasGroups(workflow).length, 1);
  assert.equal(workflow.nodes.length, 3);
  assert.equal(workflow.edges.length, 1);
});

test("DagCanvas auto-layout, search visibility, and run overlays understand groups", () => {
  const workflow = {
    id: "wf",
    agents: {},
    metadata: {
      canvas: {
        groups: [
          {
            id: "group-1",
            label: "Phase",
            color: "#0f766e",
            nodeIds: ["scan", "review"],
            x: 0,
            y: 0,
            width: 260,
            height: 160,
            collapsed: false,
          },
        ],
      },
    },
    nodes: [
      { id: "review", type: "agent", label: "Review", operation: { type: "agent" }, x: 400, y: 300 },
      { id: "scan", type: "bash_command", label: "Scan", operation: { type: "bash_command" }, x: 20, y: 20 },
      { id: "publish", type: "pass", label: "Publish", operation: { type: "pass" }, x: 760, y: 20 },
    ],
    edges: [
      { id: "scan-review", from: "scan", to: "review" },
      { id: "review-publish", from: "review", to: "publish" },
    ],
  };

  const laidOut = canvasModule.autoLayoutWorkflow(workflow, {
    columnGap: 280,
    rowGap: 120,
    startX: 40,
    startY: 60,
  });
  const group = canvasModule.normalizeCanvasGroups(laidOut)[0];
  const byId = Object.fromEntries(laidOut.nodes.map((node) => [node.id, node]));
  assert.equal(byId.scan.x, 40);
  assert.equal(byId.review.x, 320);
  assert.ok(group.width >= 500);
  assert.ok(group.height >= 160);
  assert.deepEqual(canvasModule.matchingNodeIds(laidOut.nodes, "review"), ["review"]);
  assert.equal(
    canvasModule.canvasGroupStatus(group, { scan: "success", review: "started" }, []),
    "running",
  );
  assert.equal(
    canvasModule.canvasGroupStatus(group, { scan: "success", review: "success" }, []),
    "success",
  );
  assert.equal(
    canvasModule.canvasGroupStatus(group, {}, [{ nodeId: "review", status: "pending" }]),
    "approval",
  );
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

test("DagCanvas rendered navigation controls auto-layout, fit, zoom, and search to focus nodes", async () => {
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
  assert.equal(
    dom.ancestor(dom.byLabel("Search nodes"), (node) => node.getAttribute?.("data-toolbar-row") === "secondary"),
    secondaryToolbarRow,
  );
  assert.equal(primaryToolbarRow.contains(secondaryToolbarRow), false);
  assert.match(secondaryToolbarRow.getAttribute("class"), /flex-wrap/);
  assert.doesNotMatch(toolbar.getAttribute("class"), /overflow-x-auto|workflow-scrollbar/);
  assert.match(dom.ancestor(dom.byLabel("Search nodes"), "FORM").getAttribute("class"), /flex-1/);
  assert.match(dom.byText("Workflow is valid").getAttribute("class"), /right-0/);

  await dom.flush();
  await dom.click(dom.byTitle("Auto-layout graph"));
  assert.deepEqual(changes.at(-1).nodes.map((node) => node.id), ["scan", "review", "archive"]);
  assert.ok(changes.at(-1).nodes[0].x < changes.at(-1).nodes[1].x);
  assert.ok(changes.at(-1).nodes[1].x < changes.at(-1).nodes[2].x);

  await dom.click(dom.byTitle("Fit graph"));
  await dom.click(dom.byTitle("Zoom in"));
  await dom.click(dom.byTitle("Zoom out"));

  await dom.change(dom.byLabel("Search nodes"), "reviewer");
  await dom.click(dom.byTitle("Next search match"));
  assert.match(dom.text(), /Agent ID/);
  assert.match(dom.text(), /reviewer/);

  await dom.click(dom.byTitle("Fit selection"));
  await dom.unmount();
});

test("DagCanvas rendered canvas groups can be edited, collapsed, duplicated, and deleted", async () => {
  let workflow = {
    ...workflowFixture({ id: "groups", name: "Groups", label: "Scan" }),
    nodes: [
      {
        id: "scan",
        type: "bash_command",
        label: "Scan",
        x: 40,
        y: 80,
        operation: { type: "bash_command", command: "find docs", working_dir: "" },
      },
      {
        id: "review",
        type: "agent",
        label: "Review",
        x: 340,
        y: 80,
        operation: { type: "agent", agent_id: "reviewer", prompt: "Review" },
      },
    ],
  };
  const dom = await mountReact(
    React.createElement(DagCanvasHarness, {
      workflow,
      onWorkflowChange(nextWorkflow) {
        workflow = nextWorkflow;
      },
    }),
    createFetchMock([]),
  );

  await dom.click(dom.byTitle("Create canvas group"));
  let group = canvasModule.normalizeCanvasGroups(workflow)[0];
  assert.deepEqual(group.nodeIds, ["scan", "review"]);

  await dom.change(dom.byLabel("Rename Group 1"), "Research phase");
  group = canvasModule.normalizeCanvasGroups(workflow)[0];
  assert.equal(group.label, "Research phase");

  await dom.change(dom.byLabel("Color Research phase"), "#dc2626");
  group = canvasModule.normalizeCanvasGroups(workflow)[0];
  assert.equal(group.color, "#dc2626");

  await dom.click(dom.byTitle("Collapse group"));
  group = canvasModule.normalizeCanvasGroups(workflow)[0];
  assert.equal(group.collapsed, true);
  assert.doesNotMatch(dom.text(), /Review/);

  await dom.click(dom.byTitle("Duplicate group"));
  assert.equal(canvasModule.normalizeCanvasGroups(workflow).length, 2);

  await dom.click(dom.byTitle("Delete group"));
  assert.equal(canvasModule.normalizeCanvasGroups(workflow).length, 1);
  assert.equal(workflow.nodes.length, 2);

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

  const minimap = dom.byTitle("Minimap");
  assert.match(minimap.getAttribute("class"), /left-4/);
  assert.match(minimap.getAttribute("class"), /top-4/);
  assert.match(minimap.getAttribute("class"), /bg-white\/70/);
  assert.match(minimap.getAttribute("class"), /opacity-80/);
  assert.match(minimap.getAttribute("class"), /dark:bg-\[#252526\]\/70/);

  const minimapSurface = minimap.childNodes[0];
  assert.match(minimapSurface.getAttribute("class"), /dark:bg-\[#1b1f22\]\/80/);
  assert.equal(minimapSurface.style.width, "124px");
  assert.equal(minimapSurface.style.height, "86px");
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
  await dom.pointer(minimapSurface, "onPointerDown", {
    clientX: 80,
    clientY: 50,
    pointerId: 9,
  });
  await dom.pointer(minimapSurface, "onPointerMove", {
    clientX: 240,
    clientY: 50,
    pointerId: 9,
  });

  await dom.unmount();
});

test("Electron preload exposes stable desktop and update bridge contracts", async () => {
  const exposed = runPreload({
    argv: [
      "electron",
      "preload",
      "--gofer-api-base-url=http://localhost:9000",
      "--gofer-api-token=ui-token",
    ],
  });

  assert.equal(exposed.goferApiBaseUrl, "http://localhost:9000");
  assert.equal(exposed.goferApiToken, "ui-token");
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
        return { grantId: "grant-1", path: "/outside/workflow.toml" };
      }
      if (channel === "gofer:path-info") {
        return { basename: "workflow.toml", grantId: "grant-1", isFile: true, path: payload.targetPath };
      }
      if (channel === "gofer:grant-path") {
        return { grantId: "grant-drop", path: payload.targetPath };
      }
      return { channel, payload };
    },
  });

  assert.equal(await exposed.goferDesktop.workspace.selectPath({}), "/outside/workflow.toml");
  assert.deepEqual(toPlainObject(await exposed.goferDesktop.workspace.getPathInfo("/outside/workflow.toml")), {
    basename: "workflow.toml",
    isFile: true,
    path: "/outside/workflow.toml",
  });
  assert.deepEqual(toPlainObject(calls.at(-1)), {
    channel: "gofer:path-info",
    payload: {
      grantId: "grant-1",
      targetPath: "/outside/workflow.toml",
    },
  });
  assert.equal(await exposed.goferDesktop.workspace.selectPath({ currentPath: "/outside" }), "/outside/workflow.toml");
  assert.equal(exposed.goferDesktop.workspace.pathGrantForApi("/outside/workflow.toml"), "grant-1");
  assert.equal(await exposed.goferDesktop.grantDroppedPath({ path: "/outside/dropped.gof.zip" }), "/outside/dropped.gof.zip");
  assert.equal(exposed.goferDesktop.workspace.pathGrantForApi("/outside/dropped.gof.zip"), "grant-drop");
  assert.deepEqual(toPlainObject(await exposed.goferDesktop.workspace.listDirectory({ currentPath: "/outside/workflow.toml" })), {
    channel: "gofer:list-directory",
    payload: {
      create: true,
      currentPath: "/outside/workflow.toml",
      grantId: "grant-1",
    },
  });
  assert.deepEqual(toPlainObject(await exposed.goferDesktop.textFiles.read("/outside/workflow.toml")), {
    channel: "gofer:read-text-file",
    payload: {
      grantId: "grant-1",
      targetPath: "/outside/workflow.toml",
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
  onReplayRunLog,
  onRetentionSettingsChange,
  onResumeRunLog,
  onWorkflowChange,
  retentionSettings,
  workflow,
}) {
  const [currentWorkflow, setCurrentWorkflow] = React.useState(workflow);
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

  return React.createElement(canvasModule.default, {
    dataDir,
    logState: logState ?? { loading: false, error: "", text: "", path: null, runs: [] },
    notice,
    retentionSettings: currentRetentionSettings,
    approvalState: approvalState ?? { approvals: [], error: "", loading: false },
    runResult: null,
    runState: { running: false },
    usedAgentIds: [],
    workflow: currentWorkflow,
    onImportWorkflow: () => {},
    onLoadLatestLog: () => {},
    onPruneRunLogs: onPruneRunLogs ?? (() => {}),
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
    async flush(ms = 0) {
      if (ms > 0) {
        dom.runTimers(ms);
      }
      await React.act(async () => {
        await Promise.resolve();
        await Promise.resolve();
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
  const previous = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    HTMLElement: globalThis.HTMLElement,
    HTMLIFrameElement: globalThis.HTMLIFrameElement,
    navigator: globalThis.navigator,
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
  globalThis.navigator = windowObject.navigator;

  return {
    restore() {
      Object.assign(globalThis, previous);
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

function directText(node) {
  return (node.childNodes ?? [])
    .filter((child) => child.nodeType === 3)
    .map((child) => child.textContent)
    .join("");
}

function textOf(node) {
  return node.textContent ?? "";
}
