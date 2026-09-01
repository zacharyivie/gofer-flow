function normalizeBrowserUrl(value) {
  const input = String(value ?? "").trim();
  if (!input || input === "about:blank") return "about:blank";
  if (/^https?:\/\//i.test(input)) return new URL(input).toString();
  if (/^(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?(?:[/?#]|$)/i.test(input)) {
    return new URL(`http://${input}`).toString();
  }
  if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(input)) {
    return new URL(`https://${input}`).toString();
  }
  if (/\s/.test(input)) return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
  throw new Error("Enter an http:// or https:// address.");
}

function browserShortcutAction(input = {}, platform = process.platform, openBrowserBinding = "Mod+Alt+Slash") {
  if (input.type !== "keyDown" || input.isAutoRepeat) return "";
  const key = String(input.key ?? "").toLowerCase();
  const primary = platform === "darwin" ? input.meta : input.control;
  if (matchesBrowserBinding(input, openBrowserBinding, platform)) return "open-browser";
  if (primary && key === "l") return "focus-location";
  if (primary && key === "r") return "reload";
  if (primary && key === "w") return "close";
  if (input.alt && key === "left") return "back";
  if (input.alt && key === "right") return "forward";
  if (primary && (key === "+" || key === "=")) return "zoom-in";
  if (primary && key === "-") return "zoom-out";
  if (primary && key === "0") return "zoom-reset";
  return "";
}

function matchesBrowserBinding(input, binding, platform = process.platform) {
  if (!binding) return false;
  const parts = String(binding).split("+").filter(Boolean);
  const expectedCode = parts.at(-1);
  const modifiers = new Set(parts.slice(0, -1));
  const mac = platform === "darwin";
  const primary = mac ? Boolean(input.meta) : Boolean(input.control);
  if (modifiers.has("Mod") && !primary) return false;
  const explicitControl = Boolean(input.control && !(!mac && modifiers.has("Mod")));
  const explicitMeta = Boolean(input.meta && !(mac && modifiers.has("Mod")));
  if (modifiers.has("Ctrl") !== explicitControl) return false;
  if (modifiers.has("Meta") !== explicitMeta) return false;
  if (modifiers.has("Alt") !== Boolean(input.alt)) return false;
  if (modifiers.has("Shift") !== Boolean(input.shift)) return false;
  return browserInputCode(input) === expectedCode;
}

function browserInputCode(input) {
  if (input.code) return input.code;
  const key = String(input.key ?? "");
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^\d$/.test(key)) return `Digit${key}`;
  return { ",": "Comma", "/": "Slash", "`": "Backquote", "=": "Equal", "-": "Minus" }[key] ?? key;
}

module.exports = {
  browserShortcutAction,
  matchesBrowserBinding,
  normalizeBrowserUrl,
};
