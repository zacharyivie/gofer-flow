/* global window */

const { ipcRenderer } = require("electron");

const LINK_CHANNEL = "gofer:browser-link-clicked";
const NAVIGATION_CHANNEL = "gofer:browser-navigation";

window.addEventListener("click", (event) => {
  if (
    event.defaultPrevented
    || event.button !== 0
    || (!event.ctrlKey && !event.metaKey)
  ) return;
  const anchor = event.composedPath().find((node) => node?.tagName === "A");
  if (!anchor || anchor.hasAttribute("download")) return;
  const url = String(anchor.href || "").trim();
  if (!/^(?:https?|file):/i.test(url)) return;
  event.preventDefault();
  event.stopPropagation();
  ipcRenderer.send(LINK_CHANNEL, { url });
}, true);

window.addEventListener("keydown", (event) => {
  if (
    event.defaultPrevented
    || event.repeat
    || event.key !== "Backspace"
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
    || event.composedPath().some(isEditableNode)
  ) return;
  event.preventDefault();
  ipcRenderer.send(NAVIGATION_CHANNEL, { action: "back" });
}, true);

function isEditableNode(node) {
  return Boolean(
    node?.isContentEditable
    || ["INPUT", "SELECT", "TEXTAREA"].includes(node?.tagName),
  );
}
