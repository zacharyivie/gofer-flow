/* global __dirname, clearTimeout, console, document, getComputedStyle, localStorage, MouseEvent, process, self, setTimeout */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { app, BrowserWindow } = require("electron");

const frontendRoot = path.resolve(__dirname, "..");
const distRoot = path.join(frontendRoot, "dist");
const timeout = setTimeout(() => fail(new Error("Browser studio smoke test timed out.")), 30000);

let server;
let windowRef;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-dev-shm-usage");
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-setuid-sandbox");

process.on("unhandledRejection", fail);
process.on("uncaughtException", fail);
app.whenReady().then(run).catch(fail);

async function run() {
  const baseUrl = await startServer();
  windowRef = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      preload: path.join(__dirname, "studio-preload-mock.cjs"),
      sandbox: false,
    },
  });

  await windowRef.loadURL(baseUrl);
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[aria-label='Search workflows']"))));
  if (process.env.GOFER_MONACO_ONLY === "1") {
    await exerciseMonacoEditor();
    await exercisePackagedMonacoWorker(baseUrl);
    clearTimeout(timeout);
    console.log("Browser Monaco regression test passed.");
    await cleanup(0);
    return;
  }
  await exerciseCreateDialog();
  await exerciseDesignRegressions();
  await exerciseKeyboardGraphAndResizers();
  await exerciseMonacoEditor();
  await exercisePackagedMonacoWorker(baseUrl);

  clearTimeout(timeout);
  console.log("Browser studio accessibility smoke test passed.");
  await cleanup(0);
}

async function exerciseMonacoEditor() {
  await waitFor(() => evaluate(() => [...document.querySelectorAll("[role='button']")]
    .some((button) => button.textContent.includes("Radish editor"))));
  await evaluate(() => [...document.querySelectorAll("[role='button']")]
    .find((button) => button.textContent.includes("Radish editor")).click());
  await waitFor(() => evaluate(() => [...document.querySelectorAll("article")]
    .some((node) => node.textContent.includes("Prepare"))));
  await evaluate(() => document.querySelector("button[title='Run workflow now']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[role='dialog']"))));
  assert.equal(await evaluate(() => document.querySelector("[role='dialog']").textContent.includes("prepare")), true);
  await evaluate(() => [...document.querySelectorAll("[role='dialog'] button")]
    .find((button) => button.textContent.trim() === "Run workflow").click());
  await waitFor(() => evaluate(() => !document.querySelector("[role='dialog']")));
  await waitFor(() => evaluate(() => [...document.querySelectorAll("[role='button']")]
    .some((button) => button.textContent.includes("Radish editor") && button.textContent.includes("Success"))));
  await waitFor(() => evaluate(() => !document.querySelector("button[role='tab'][title*='Code view']")?.disabled));
  await evaluate(() => [...document.querySelectorAll("button[role='tab']")]
    .find((button) => button.textContent.trim() === "Code").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector(".monaco-editor"))));
  assert.equal(await evaluate(() => document.querySelector("[aria-label='Search files']")?.placeholder), "Search files");
  await waitFor(() => evaluate(() => [...document.querySelectorAll(".view-line")]
    .some((line) => line.textContent.includes("Radish"))));
  await evaluate(() => [...document.querySelectorAll("button[role='tab']")]
    .find((button) => button.textContent.trim() === "Graph").click());
  assert.equal(await evaluate(() => Boolean(document.querySelector(".monaco-editor"))), true);
  await waitFor(() => evaluate(() => [...document.querySelectorAll("article")]
    .some((node) => node.textContent.includes("Prepare"))));
  assert.equal(await evaluate(() => document.body.textContent.includes("Radish graph preview")), true);
}

async function exercisePackagedMonacoWorker(baseUrl) {
  const httpWindow = windowRef;
  const packagedWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      additionalArguments: [`--gofer-api-base-url=${baseUrl}`],
      contextIsolation: false,
      nodeIntegration: false,
      preload: path.join(__dirname, "studio-preload-mock.cjs"),
      sandbox: false,
    },
  });
  await packagedWindow.loadFile(path.join(distRoot, "index.html"));
  windowRef = packagedWindow;
  if (httpWindow && !httpWindow.isDestroyed()) httpWindow.destroy();
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[aria-label='Search workflows']"))));
  await waitFor(() => evaluate(() => [...document.querySelectorAll("[role='button']")]
    .some((button) => button.textContent.includes("Radish editor"))));
  await evaluate(() => [...document.querySelectorAll("[role='button']")]
    .find((button) => button.textContent.includes("Radish editor")).click());
  await evaluate(() => [...document.querySelectorAll("button[role='tab']")]
    .find((button) => button.textContent.trim() === "Code").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector(".monaco-editor"))));
  const workerResult = await evaluate(() => {
    try {
      const worker = self.MonacoEnvironment.getWorker();
      worker.terminate();
      return { ok: true };
    } catch (error) {
      return { error: String(error), ok: false };
    }
  });
  assert.equal(workerResult.ok, true, workerResult.error);
}

async function exerciseDesignRegressions() {
  await evaluate(() => {
    const workflowScroll = document.querySelector("[aria-label='Search workflows']")
      .closest("aside")
      .querySelector(".workflow-scrollbar");
    workflowScroll.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 180,
    }));
  });
  await waitFor(() => evaluate(() => Boolean([...document.querySelectorAll("button")]
    .find((button) => button.textContent.includes("Create group")))));
  await evaluate(() => [...document.querySelectorAll("button")]
    .find((button) => button.textContent.includes("Create group")).click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("input[value='New group']"))));
  await evaluate(() => {
    const input = document.querySelector("input[value='New group']");
    input.blur();
  });
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[aria-label='New group workflows']"))));

  await evaluate(() => {
    const workflow = [...document.querySelectorAll("[draggable='true']")]
      .find((item) => item.textContent.includes("Demo workflow"));
    const target = document.querySelector("[aria-label='New group workflows']");
    const values = new Map();
    const transfer = {
      effectAllowed: "all",
      getData(type) { return values.get(type) ?? ""; },
      setData(type, value) { values.set(type, value); },
    };
    const event = (type) => {
      const nextEvent = new target.ownerDocument.defaultView.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(nextEvent, "dataTransfer", { value: transfer });
      return nextEvent;
    };
    workflow.dispatchEvent(event("dragstart"));
    target.dispatchEvent(event("dragover"));
    target.dispatchEvent(event("drop"));
  });
  await waitFor(() => evaluate(() => {
    const group = document.querySelector("[aria-label='New group workflows']");
    const stored = JSON.parse(localStorage.getItem("gofer.workflowGroups"));
    return group?.textContent.includes("Demo workflow") && stored?.assignments?.demo;
  }));

  await evaluate(() => {
    const group = document.querySelector("[aria-label='New group workflows']");
    group.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 140,
      clientY: 150,
    }));
  });
  await waitFor(() => evaluate(() => Boolean([...document.querySelectorAll("button")]
    .find((button) => button.textContent.includes("Ungroup workflows")))));
  assert.equal(
    await evaluate(() => Boolean([...document.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Delete group")))),
    false,
  );
  assert.equal(
    await evaluate(() => Boolean([...document.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Ungroup workflows"))
      ?.querySelector(".lucide-ungroup"))),
    true,
  );
  await evaluate(() => [...document.querySelectorAll("button")]
    .find((button) => button.textContent.includes("Ungroup workflows")).click());
  await waitFor(() => evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("gofer.workflowGroups"));
    return !document.querySelector("[aria-label='New group workflows']")
      && document.querySelector("[aria-label='Unfiled workflows']")?.textContent.includes("Demo workflow")
      && !stored?.groups?.some((group) => group.name === "New group")
      && !stored?.assignments?.demo;
  }));

  const pickerWidths = await evaluate(() => {
    const textarea = document.querySelector("textarea[placeholder='Message this workflow']");
    const chat = textarea.closest("aside");
    const trigger = chat.querySelector(".model-picker-trigger");
    const provider = trigger.querySelector("[data-model-picker-part='provider']");
    const model = trigger.querySelector("[data-model-picker-part='model']");
    const effort = trigger.querySelector("[data-model-picker-part='effort']");
    const metrics = (segment) => {
      const label = segment.querySelector("[data-picker-label]");
      const segmentRect = segment.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      const style = getComputedStyle(segment);
      return {
        centerDelta: Math.abs(
          (labelRect.left + labelRect.width / 2) - (segmentRect.left + segmentRect.width / 2),
        ),
        color: style.color,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fullyVisible: label.scrollWidth <= label.clientWidth,
        width: segmentRect.width,
      };
    };
    return {
      composer: textarea.parentElement.getBoundingClientRect().width,
      effortLeft: effort.getBoundingClientRect().left,
      effortMetrics: metrics(effort),
      effortText: effort.textContent.trim(),
      modelLeft: model.getBoundingClientRect().left,
      modelMetrics: metrics(model),
      modelText: model.textContent.trim(),
      providerLeft: provider.getBoundingClientRect().left,
      providerMetrics: metrics(provider),
      providerText: provider.textContent.trim(),
      trigger: trigger.getBoundingClientRect().width,
    };
  });
  assert.ok(Math.abs(pickerWidths.trigger - pickerWidths.composer) < 1);
  assert.equal(pickerWidths.providerText, "Codex");
  assert.equal(pickerWidths.modelText, "GPT-5.6-Sol");
  assert.equal(pickerWidths.effortText, "Medium");
  assert.ok(pickerWidths.providerLeft < pickerWidths.modelLeft);
  assert.ok(pickerWidths.modelLeft < pickerWidths.effortLeft);
  const typography = ({ color, fontFamily, fontSize, fontWeight }) => ({
    color,
    fontFamily,
    fontSize,
    fontWeight,
  });
  assert.deepEqual(typography(pickerWidths.providerMetrics), typography(pickerWidths.modelMetrics));
  assert.deepEqual(typography(pickerWidths.modelMetrics), typography(pickerWidths.effortMetrics));
  assert.ok(pickerWidths.providerMetrics.centerDelta < 1);
  assert.ok(pickerWidths.modelMetrics.centerDelta < 1);
  assert.ok(pickerWidths.effortMetrics.centerDelta < 1);
  assert.ok(pickerWidths.modelMetrics.width > pickerWidths.providerMetrics.width);
  assert.ok(pickerWidths.providerMetrics.width > pickerWidths.effortMetrics.width);
  assert.equal(pickerWidths.providerMetrics.fullyVisible, true);
  assert.equal(pickerWidths.modelMetrics.fullyVisible, true);
  assert.equal(pickerWidths.effortMetrics.fullyVisible, true);

  await evaluate(() => document.querySelector("[data-picker-trigger='provider']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[data-picker-menu='provider']"))));
  const providerMenuWidth = await evaluate(() =>
    document.querySelector("[data-picker-menu='provider']").getBoundingClientRect().width,
  );
  assert.ok(
    Math.abs(providerMenuWidth - pickerWidths.composer) <= 20,
    `Provider menu width ${providerMenuWidth} did not match composer width ${pickerWidths.composer}`,
  );
  await evaluate(() => document.querySelector("[data-picker-trigger='provider']").click());

  await evaluate(() => document.querySelector("[data-picker-trigger='model']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[data-picker-menu='model']"))));
  assert.equal(await evaluate(() => Boolean(document.querySelector("input[placeholder='Search models']"))), false);
  await evaluate(() => document.querySelector("[data-picker-trigger='model']").parentElement.classList.add("dark"));
  await wait(200);
  const darkModelState = await evaluate(() => {
    const trigger = document.querySelector("[data-picker-trigger='model']");
    return {
      background: getComputedStyle(trigger).backgroundColor,
      className: trigger.className,
      expanded: trigger.getAttribute("aria-expanded"),
      parentClassName: trigger.parentElement.className,
    };
  });
  assert.equal(darkModelState.background, "rgb(42, 42, 42)", JSON.stringify(darkModelState));
  await evaluate(() => document.querySelector("[data-picker-trigger='model']").parentElement.classList.remove("dark"));
  await evaluate(() => [...document.querySelectorAll("[data-picker-menu='model'] [role='option']")]
    .find((option) => option.textContent.trim() === "GPT-5.6-Luna").click());
  await waitFor(() => evaluate(() =>
    document.querySelector("[data-picker-trigger='model'] [data-picker-label]").textContent.trim() === "GPT-5.6-Luna"));
  assert.equal(
    await evaluate(() => document.querySelector("[data-picker-trigger='effort'] [data-picker-label]").textContent.trim()),
    "Medium",
  );

  await evaluate(() => document.querySelector("[data-picker-trigger='effort']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[data-picker-menu='effort']"))));
  const effortMenu = await evaluate(() => {
    const menu = document.querySelector("[data-picker-menu='effort']");
    const options = [...menu.querySelectorAll("[role='option']")];
    return {
      activeLabel: menu.querySelector("[role='option'][aria-selected='true']")?.textContent.trim(),
      fitsWidth: menu.scrollWidth <= menu.clientWidth,
      labels: options.map((option) => option.textContent.trim()),
      optionCount: options.length,
      optionTops: options.map((option) => Math.round(option.getBoundingClientRect().top)),
    };
  });
  assert.equal(effortMenu.optionCount, 5);
  assert.equal(new Set(effortMenu.optionTops).size, 5);
  assert.equal(effortMenu.fitsWidth, true);
  assert.deepEqual(effortMenu.labels, ["Low", "Medium (default)", "High", "X-high", "Max"]);
  assert.equal(effortMenu.activeLabel, "Medium (default)");
  await evaluate(() => document.querySelector("[data-picker-trigger='effort']").click());

  await evaluate(() => document.querySelector("[data-picker-trigger='provider']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[data-picker-menu='provider']"))));
  await evaluate(() => [...document.querySelectorAll("[data-picker-menu='provider'] [role='option']")]
    .find((option) => option.textContent.includes("Claude Code")).click());
  await waitFor(() => evaluate(() =>
    document.querySelector("[data-picker-trigger='model'] [data-picker-label]").textContent.trim() === "Claude Sonnet 5"));
  assert.equal(
    await evaluate(() => document.querySelector("[data-picker-trigger='effort'] [data-picker-label]").textContent.trim()),
    "High",
  );
  await evaluate(() => document.querySelector("[data-picker-trigger='model']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[data-picker-menu='model']"))));
  const claudeModels = await evaluate(() =>
    [...document.querySelectorAll("[data-picker-menu='model'] [role='option']")]
      .map((option) => option.textContent.trim()));
  assert.equal(claudeModels.includes("Default"), false);
  assert.equal(claudeModels.includes("Claude Sonnet 5 (default)"), true);
  await evaluate(() => document.querySelector("[data-picker-trigger='model']").click());
  await evaluate(() => document.querySelector("[data-picker-trigger='effort']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[data-picker-menu='effort']"))));
  assert.equal(
    await evaluate(() => document.querySelector("[data-picker-menu='effort'] [aria-selected='true']").textContent.trim()),
    "High (default)",
  );
  assert.equal(
    await evaluate(() => [...document.querySelectorAll("[data-picker-menu='effort'] [role='option']")]
      .some((option) => option.textContent.trim() === "Default")),
    false,
  );
  await evaluate(() => document.querySelector("[data-picker-trigger='effort']").click());

  assert.equal(await evaluate(() => Boolean(document.querySelector("button[title='New thread']"))), true);
  assert.equal(await evaluate(() => Boolean(document.querySelector("button[title='Recent threads']"))), true);
  await evaluate(() => document.querySelector("button[title='New thread']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("button[title='Back to recent threads']"))));
  await evaluate(() => document.querySelector("button[title='Back to recent threads']").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[data-assistant-home]"))));
  assert.equal(await evaluate(() => document.querySelector("[data-assistant-home]").textContent.includes("Workflow assistant")), true);
  assert.equal(await evaluate(() => document.querySelector("[data-assistant-home]").textContent.includes("Ask about the selected workflow")), true);
  assert.equal(await evaluate(() => document.querySelector("[data-assistant-home]").textContent.includes("Recent threads")), true);
  assert.equal(await evaluate(() => document.querySelector("[data-assistant-home]").textContent.includes("New thread")), true);
  assert.equal(await evaluate(() => Boolean(document.querySelector("button[title='Back to recent threads']"))), false);
  await evaluate(() => document.querySelector("button[title='Recent threads']").click());
  await waitFor(() => evaluate(() => Boolean([...document.querySelectorAll("p")]
    .find((item) => item.textContent.trim() === "Recent threads"))));
  await evaluate(() => document.querySelector("button[title='Recent threads']").click());

  const composerLayout = await evaluate(() => {
    const composer = document.querySelector("[data-chat-composer]");
    const textarea = composer.querySelector("textarea");
    const send = composer.querySelector("button[title='Send message']");
    const composerRect = composer.getBoundingClientRect();
    const textareaRect = textarea.getBoundingClientRect();
    const sendRect = send.getBoundingClientRect();
    return {
      composer: { height: composerRect.height, width: composerRect.width },
      sendInsideTextarea:
        sendRect.left >= textareaRect.left &&
        sendRect.right <= textareaRect.right &&
        sendRect.top >= textareaRect.top &&
        sendRect.bottom <= textareaRect.bottom,
      textarea: { height: textareaRect.height, width: textareaRect.width },
    };
  });
  assert.ok(Math.abs(composerLayout.textarea.width - composerLayout.composer.width) <= 2);
  assert.ok(Math.abs(composerLayout.textarea.height - composerLayout.composer.height) <= 2);
  assert.equal(composerLayout.sendInsideTextarea, true);

  await evaluate(() => document.querySelector("button[title='Map']").click());
  await evaluate(() => [...document.querySelectorAll("button")]
    .find((button) => button.textContent.trim() === "Minimap").click());
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[title='Minimap'] > div"))));
  const minimapFill = await evaluate(() => {
    const surface = document.querySelector("[title='Minimap'] > div");
    const container = surface.parentElement;
    return {
      containerHeight: container.clientHeight,
      containerWidth: container.clientWidth,
      surfaceHeight: surface.clientHeight,
      surfaceWidth: surface.clientWidth,
    };
  });
  assert.equal(minimapFill.surfaceWidth, minimapFill.containerWidth);
  assert.equal(minimapFill.surfaceHeight, minimapFill.containerHeight);
  await evaluate(() => [...document.querySelectorAll("button")]
    .find((button) => button.textContent.trim() === "Outline").click());
  await evaluate(() => document.querySelector("button[title='Map']").click());

  await evaluate(() => document.querySelector("button[title='Show workflow settings and node inspector']").click());
  await waitFor(() => evaluate(() => document.querySelectorAll("[role='tab']").length === 4));
  assert.deepEqual(
    await evaluate(() => [...document.querySelectorAll("[role='tab']")].map((tab) => tab.textContent.trim())),
    ["General", "Triggers", "Variables", "Access"],
  );
  await evaluate(() => document.querySelector("button[title='Hide workflow settings and node inspector']").click());
}

async function exerciseKeyboardGraphAndResizers() {
  await evaluate(() => document.querySelector("button[title='Map']").click());
  const initialOutline = await evaluate(() => {
    const outline = document.querySelector("[aria-label='Graph outline']");
    const nodeButtons = [...outline.querySelectorAll("button[aria-label*=', status '")];
    return {
      nodeCount: nodeButtons.length,
      firstDescription: nodeButtons[0]?.getAttribute("aria-label") || "",
    };
  });
  assert.equal(initialOutline.nodeCount, 2);
  assert.match(initialOutline.firstDescription, /incoming.*outgoing.*valid/);

  await evaluate(() => {
    const addNode = document.querySelector("[title='Add node']");
    addNode.focus();
  });
  await pressFocusedKey("Enter");
  await waitFor(() => evaluate(() => Boolean(
    document.querySelector("[aria-label^='New Step 1,']"),
  )));
  assert.equal(
    await evaluate(() => document.activeElement.matches("[aria-label^='New Step 1,']")),
    true,
  );
  await pressFocusedKey("Enter");
  await waitFor(() => evaluate(() => document.activeElement.id === "workflow-inspector"));
  assert.equal(
    await evaluate(() => document.activeElement.id),
    "workflow-inspector",
  );
  assert.deepEqual(
    await evaluate(() => {
      const tablist = document.querySelector("[aria-label='Node inspector sections']");
      return [...tablist.querySelectorAll("[role='tab']")].map((tab) => ({
        label: tab.textContent.trim(),
        selected: tab.getAttribute("aria-selected"),
        tabIndex: tab.getAttribute("tabindex"),
      }));
    }),
    [
      { label: "General", selected: "true", tabIndex: "0" },
      { label: "Action", selected: "false", tabIndex: "-1" },
      { label: "Inputs", selected: "false", tabIndex: "-1" },
      { label: "Run", selected: "false", tabIndex: "-1" },
      { label: "Edges", selected: "false", tabIndex: "-1" },
    ],
  );
  await evaluate(() => {
    document.querySelector("#node-tab-general").focus();
  });
  await pressFocusedKey("ArrowRight");
  await waitFor(() => evaluate(() =>
    document.querySelector("#node-tab-action").getAttribute("aria-selected") === "true",
  ));
  assert.equal(
    await evaluate(() => document.querySelector("#node-tabpanel-general").hidden),
    true,
  );
  await evaluate(() => document.querySelector("#node-tab-general").click());
  await evaluate(() => {
    const labelControl = [...document.querySelectorAll("#workflow-inspector label")]
      .find((label) => label.querySelector("span")?.textContent === "Label")
      ?.querySelector("input");
    labelControl.focus();
    labelControl.select();
  });
  await windowRef.webContents.insertText("Keyboard step");
  await waitFor(() => evaluate(() => Boolean(
    document.querySelector("[aria-label^='Keyboard step,']"),
  )));

  await evaluate(() => {
    document.querySelector("[aria-label^='Run command,']").focus();
  });
  await pressFocusedKey("C");
  assert.match(
    await evaluate(() => document.querySelector("[aria-label='Graph outline']").textContent),
    /Connecting from Run command/,
  );
  await evaluate(() => {
    document.querySelector("[aria-label^='Review output,']").focus();
  });
  await pressFocusedKey("Enter");
  await waitFor(() => evaluate(() => Boolean(
    document.querySelector("[aria-label^='Run command to Review output, condition always']"),
  )));
  assert.equal(
    await evaluate(() => document.activeElement.matches(
      "[aria-label^='Run command to Review output, condition always']",
    )),
    true,
  );
  await pressFocusedKey("Enter");
  await waitFor(() => evaluate(() => document.activeElement.id === "workflow-inspector"));
  assert.equal(await evaluate(() => document.activeElement.id), "workflow-inspector");
  await evaluate(() => {
    const typeControl = [...document.querySelectorAll("#workflow-inspector label")]
      .find((label) => label.querySelector("span")?.textContent === "Type")
      ?.querySelector("select");
    typeControl.focus();
  });
  await pressNativeKey("DOWN");
  await pressNativeKey("DOWN");
  await waitFor(() => evaluate(() => Boolean(
    document.querySelector("[aria-label^='Run command to Review output, condition on failure']"),
  )));
  await evaluate(() => {
    document.querySelector("[aria-label^='Run command to Review output, condition on failure']").focus();
  });
  await pressFocusedKey("Delete");
  await waitFor(() => evaluate(() => !document.querySelector(
    "[aria-label^='Run command to Review output, condition on failure']",
  )));
  assert.equal(
    await evaluate(() => document.activeElement.matches("[aria-label^='Run command,']")),
    true,
  );
  await pressFocusedKey("D", ["control"]);
  await waitFor(() => evaluate(() => Boolean(
    document.querySelector("[aria-label^='Run command copy,']"),
  )));
  assert.equal(
    await evaluate(() => document.activeElement.matches("[aria-label^='Run command copy,']")),
    true,
  );
  await pressFocusedKey("Delete");
  await waitFor(() => evaluate(() => !document.querySelector("[aria-label^='Run command copy,']")));
  assert.equal(
    await evaluate(() => document.activeElement.matches("[aria-label^='Keyboard step,']")),
    true,
  );

  assert.deepEqual(
    await evaluate(() => {
      const separator = document.querySelector("[aria-label='Resize workflow settings and node inspector']");
      return {
        max: separator.getAttribute("aria-valuemax"),
        min: separator.getAttribute("aria-valuemin"),
        now: separator.getAttribute("aria-valuenow"),
        orientation: separator.getAttribute("aria-orientation"),
        role: separator.getAttribute("role"),
      };
    }),
    { max: "520", min: "280", now: "340", orientation: "vertical", role: "separator" },
  );
  await evaluate(() => {
    document.querySelector("[aria-label='Resize workflow settings and node inspector']").focus();
  });
  await pressFocusedKey("ArrowRight");
  await waitFor(() => evaluate(() =>
    document.querySelector("[aria-label='Resize workflow settings and node inspector']")
      .getAttribute("aria-valuenow") === "350",
  ));
  await pressFocusedKey("Enter");
  await waitFor(() => evaluate(() =>
    document.querySelector("[aria-label='Resize workflow settings and node inspector']")
      .getAttribute("aria-valuenow") === "340",
  ));
}

async function exerciseCreateDialog() {
  await evaluate(() => {
    const opener = document.querySelector("[title='Create workflow']");
    opener.focus();
    opener.click();
  });
  await waitFor(() => evaluate(() => Boolean(document.querySelector("[role='dialog']"))));

  const initialState = await evaluate(() => {
    const dialog = document.querySelector("[role='dialog']");
    return {
      activeInside: dialog.contains(document.activeElement),
      describedBy: dialog.getAttribute("aria-describedby"),
      labelledBy: dialog.getAttribute("aria-labelledby"),
      modal: dialog.getAttribute("aria-modal"),
      name: dialog.getAttribute("aria-labelledby")
        ? document.getElementById(dialog.getAttribute("aria-labelledby"))?.textContent
        : "",
    };
  });
  assert.equal(initialState.activeInside, true);
  assert.equal(initialState.modal, "true");
  assert.equal(initialState.name, "New workflow");
  assert.ok(initialState.labelledBy);
  assert.ok(initialState.describedBy);

  const lastControlLabel = await evaluate(() => {
    const dialog = document.querySelector("[role='dialog']");
    const controls = [...dialog.querySelectorAll(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    )];
    const last = controls.at(-1);
    last.dataset.browserSmokeLast = "true";
    last.focus();
    return last.textContent || last.getAttribute("aria-label") || last.tagName;
  });
  assert.ok(lastControlLabel);
  await sendKey("Tab");
  assert.equal(
    await evaluate(() => {
      const dialog = document.querySelector("[role='dialog']");
      const first = dialog.querySelector(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      );
      return document.activeElement === first;
    }),
    true,
  );

  await sendKey("Escape");
  await waitFor(() => evaluate(() => !document.querySelector("[role='dialog']")));
  assert.equal(
    await evaluate(() => document.activeElement?.getAttribute("title")),
    "Create workflow",
  );
}

async function sendKey(keyCode) {
  await windowRef.webContents.executeJavaScript(
    `document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: ${JSON.stringify(keyCode)} }))`,
  );
  await wait(40);
}

async function pressFocusedKey(keyCode, modifiers = []) {
  await windowRef.webContents.executeJavaScript(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ctrlKey: ${modifiers.includes("control")},
    key: ${JSON.stringify(keyCode)},
    metaKey: ${modifiers.includes("meta")},
    shiftKey: ${modifiers.includes("shift")}
  }))`);
  await wait(60);
}

async function pressNativeKey(keyCode, modifiers = []) {
  windowRef.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  windowRef.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await wait(60);
}

async function startServer() {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      response.setHeader("Access-Control-Allow-Origin", "*");
      routeApi(url.pathname, response);
      return;
    }

    const requestedPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filePath = path.resolve(distRoot, requestedPath);
    if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${path.sep}`)) {
      response.writeHead(404).end();
      return;
    }
    fs.readFile(filePath, (error, data) => {
      if (error) {
        response.writeHead(404).end();
        return;
      }
      const contentTypes = {
        ".css": "text/css",
        ".html": "text/html",
        ".js": "text/javascript",
        ".svg": "image/svg+xml",
      };
      response.writeHead(200, {
        "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      });
      response.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}/`;
}

function routeApi(pathname, response) {
  if (pathname === "/api/workflows") {
    json(response, {
      dataDir: "/workspace",
      promptAgentIds: [],
      workflows: [workflowFixture(), radishWorkflowFixture()],
    });
    return;
  }
  if (pathname === "/api/provider/capabilities") {
    json(response, {
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
          efforts: [
            { id: "low", displayName: "Low" },
            { id: "medium", displayName: "Medium" },
            { id: "high", displayName: "High" },
            { id: "xhigh", displayName: "X-high" },
          ],
        }, {
          id: "gpt-5.6-luna",
          displayName: "GPT-5.6-Luna",
          defaultEffort: "medium",
          efforts: [
            { id: "low", displayName: "Low" },
            { id: "medium", displayName: "Medium" },
            { id: "high", displayName: "High" },
            { id: "xhigh", displayName: "X-high" },
            { id: "max", displayName: "Max" },
          ],
        }],
      }, {
        id: "claude_code",
        displayName: "Claude Code",
        available: true,
        discoveryStatus: "ready",
        defaultModel: "claude-sonnet-5",
        models: [{
          id: "claude-sonnet-5",
          displayName: "Claude Sonnet 5",
          defaultEffort: "high",
          efforts: [
            { id: "low", displayName: "Low" },
            { id: "medium", displayName: "Medium" },
            { id: "high", displayName: "High" },
            { id: "xhigh", displayName: "X-high" },
            { id: "max", displayName: "Max" },
          ],
        }, {
          id: "default",
          displayName: "Default",
          defaultEffort: null,
          efforts: [
            { id: "low", displayName: "Low" },
            { id: "medium", displayName: "Medium" },
            { id: "high", displayName: "High" },
            { id: "xhigh", displayName: "X-high" },
            { id: "max", displayName: "Max" },
          ],
        }],
      }],
    });
    return;
  }
  if (pathname === "/api/workflow-templates") {
    json(response, { templates: [] });
    return;
  }
  if (pathname === "/api/workflows/radish-editor/document") {
    json(response, { document: radishDocumentFixture() });
    return;
  }
  if (pathname === "/api/workflows/radish-editor/document/analyze") {
    json(response, { document: radishDocumentFixture() });
    return;
  }
  if (pathname === "/api/workflows/radish-editor/document/save") {
    json(response, { document: radishDocumentFixture() });
    return;
  }
  if (pathname === "/api/workflows/radish-editor/plan") {
    json(response, {
      plan: {
        blockingDiagnostics: [],
        destructiveActions: ["prepare: command"],
        generations: [{
          index: 0,
          nodes: [{ id: "prepare", detail: "echo ready", sideEffects: ["command"], type: "bash-command" }],
        }],
        kind: "radish",
        providerRequirements: [],
        requiredSecrets: [],
        runnable: true,
        warnings: [],
      },
    });
    return;
  }
  if (pathname === "/api/workflows/radish-editor/run") {
    json(response, {
      run: {
        logPath: "/workspace/radish/run.json",
        logText: "prepare: ready",
        nodeOutputs: { prepare: { data: { stdout: "ready" }, output: "ready", success: true } },
        runEvents: [],
        runNodes: { prepare: { status: "success" } },
        status: "success",
        success: true,
        workflowId: "radish-editor",
      },
    });
    return;
  }
  if (pathname.endsWith("/logs")) {
    json(response, { runs: [] });
    return;
  }
  if (pathname.endsWith("/approvals")) {
    json(response, { approvals: [] });
    return;
  }
  if (pathname === "/api/doctor") {
    json(response, { errors: [], warnings: [] });
    return;
  }
  json(response, {});
}

function workflowFixture() {
  return {
    agents: {},
    edges: [],
    id: "demo",
    name: "Demo workflow",
    nodes: [
      {
        id: "step",
        label: "Run command",
        operation: { command: "echo hello", type: "bash_command", working_dir: "" },
        type: "bash_command",
        x: 80,
        y: 80,
      },
      {
        id: "review",
        label: "Review output",
        operation: { agent_id: "reviewer", prompt: "Review", type: "agent" },
        type: "agent",
        x: 400,
        y: 80,
      },
    ],
    parameters: {},
    sourcePath: "/workspace/demo.toml",
    status: "Ready",
    tags: ["ready"],
  };
}

function radishWorkflowFixture() {
  return {
    agents: {},
    edges: [],
    id: "radish-editor",
    name: "Radish editor",
    nodes: [],
    parameters: {},
    projectName: "gofer-flow",
    projectRoot: "/workspace/gofer-flow",
    readOnly: true,
    sourceFormat: "radish",
    sourcePath: "/workspace/gofer-flow/.taskurotta/radish-editor/workflow.rad",
    status: "Ready",
    tags: ["ready"],
    workflowRoot: "/workspace/gofer-flow/.taskurotta/radish-editor",
  };
}

function radishDocumentFixture() {
  const source = "Radish: 1\n\nWorkflow:\n  name: Radish editor\n\nNode prepare:\n  type: bash-command\n  command: echo ready\n";
  return {
    compilation: { fingerprint: "sha256:test", irVersion: 1, lastValidFingerprint: "sha256:test", state: "valid" },
    diagnostics: [],
    dirty: false,
    graph: {
      edges: [],
      nodes: [{
        configuration: { command: "echo ready" },
        diagnostics: [],
        execution: { allow_fail: false, max_concurrency: 1, retry_count: 0, retry_delay_ms: 0, timeout_ms: null },
        id: "prepare",
        label: "Prepare",
        status: "valid",
        type: "bash-command",
      }],
    },
    invalidRegions: [],
    metadata: { metadataVersion: 1, canvas: { nodes: {}, pan: { x: 0, y: 0 }, zoom: 1 }, editor: { foldedDeclarations: [] } },
    metadataRevision: "sha256:metadata",
    preflight: { diagnostics: [], ready: true },
    projectRoot: "/workspace/gofer-flow",
    runnable: true,
    savedRevision: "sha256:source",
    source,
    sourcePath: "/workspace/gofer-flow/.taskurotta/radish-editor/workflow.rad",
    sourceRevision: "sha256:source",
    workflow: { name: "Radish editor" },
    workflowId: "radish-editor",
  };
}

function json(response, payload) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function evaluate(callback) {
  const result = await windowRef.webContents.executeJavaScript(`(() => {
    try {
      return { value: (${callback.toString()})() };
    } catch (error) {
      return { error: String(error?.stack || error) };
    }
  })()`);
  if (result?.error) throw new Error(result.error);
  return result?.value;
}

async function waitFor(predicate, delay = 25) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(delay);
  }
  throw new Error("Timed out waiting for browser condition.");
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cleanup(exitCode) {
  if (windowRef && !windowRef.isDestroyed()) windowRef.destroy();
  if (server) await new Promise((resolve) => server.close(resolve));
  app.exit(exitCode);
}

async function fail(error) {
  clearTimeout(timeout);
  console.error(error);
  await cleanup(1);
}
