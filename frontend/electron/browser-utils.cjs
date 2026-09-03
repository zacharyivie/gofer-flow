const TASKUROTTA_HOME_URL = "taskurotta://home";

function normalizeBrowserUrl(value) {
  const input = String(value ?? "").trim();
  if (!input || input === "about:blank") return "about:blank";
  if (input === TASKUROTTA_HOME_URL) return TASKUROTTA_HOME_URL;
  if (/^https?:\/\//i.test(input)) return new URL(input).toString();
  if (/^(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?(?:[/?#]|$)/i.test(input)) {
    return new URL(`http://${input}`).toString();
  }
  if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(input)) {
    return new URL(`https://${input}`).toString();
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(input)) {
    throw new Error("Enter an http:// or https:// address.");
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

function browserShortcutAction(input = {}, platform = process.platform, openBrowserBinding = "Mod+Alt+Slash") {
  if (input.type !== "keyDown" || input.isAutoRepeat) return "";
  const key = String(input.key ?? "").toLowerCase();
  const primary = platform === "darwin" ? input.meta : input.control;
  if (matchesBrowserBinding(input, openBrowserBinding, platform)) return "open-browser";
  if (input.alt && !input.control && !input.meta && key === "d") return "focus-location";
  if (primary && key === "r") return "reload";
  if (primary && key === "w") return "close";
  if (input.control && !input.alt && !input.meta && key === "tab") {
    return input.shift ? "previous-tab" : "next-tab";
  }
  if (primary && !input.alt && !input.shift && key === "t") return "new-tab";
  if (input.alt && key === "left") return "back";
  if (input.alt && key === "right") return "forward";
  if (primary && (key === "+" || key === "=")) return "zoom-in";
  if (primary && key === "-") return "zoom-out";
  if (primary && key === "0") return "zoom-reset";
  return "";
}

function browserLoadUrl(value) {
  return value === TASKUROTTA_HOME_URL ? taskurottaHomeDataUrl() : value;
}

function taskurottaHomeDataUrl() {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
  <title>Taskurotta</title>
  <style>
    :root { color-scheme: light dark; --bg:#fafafa; --surface:#fff; --ink:#1c1c1f; --muted:#71717a; --line:#e4e4e7; --accent:#4f46e5; --accent-soft:#eef2ff; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:var(--bg); color:var(--ink); font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
    main { width:min(880px,calc(100% - 48px)); margin:0 auto; padding:clamp(72px,12vh,132px) 0 64px; }
    .mark { display:grid; width:42px; height:42px; place-items:center; border-radius:10px; background:var(--accent); color:#fff; font-size:21px; font-weight:750; letter-spacing:-.04em; box-shadow:0 8px 24px rgba(79,70,229,.2); }
    h1 { max-width:720px; margin:24px 0 12px; font-size:clamp(36px,6vw,64px); line-height:1.02; letter-spacing:-.035em; }
    .lede { max-width:650px; margin:0; color:var(--muted); font-size:clamp(16px,2vw,19px); line-height:1.6; }
    .rule { margin:48px 0 26px; border:0; border-top:1px solid var(--line); }
    .features { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:28px; }
    h2 { margin:0 0 7px; font-size:14px; }
    .features p { margin:0; color:var(--muted); font-size:13px; }
    .command { display:flex; align-items:center; justify-content:space-between; gap:24px; margin-top:44px; padding:16px 18px; border:1px solid var(--line); border-radius:10px; background:var(--surface); }
    .command p { margin:0; color:var(--muted); font-size:12px; }
    kbd { flex:none; border:1px solid var(--line); border-radius:6px; background:var(--accent-soft); color:var(--accent); padding:5px 8px; font:600 12px/1 ui-monospace,SFMono-Regular,Consolas,monospace; }
    @media (max-width:680px) { main { width:min(100% - 32px,880px); padding-top:56px; } .features { grid-template-columns:1fr; gap:22px; } .command { align-items:flex-start; flex-direction:column; gap:12px; } }
    @media (prefers-color-scheme:dark) { :root { --bg:#18181a; --surface:#202023; --ink:#f4f4f5; --muted:#a1a1aa; --line:#323238; --accent:#818cf8; --accent-soft:#27263b; } .mark { color:#fff; background:#6366f1; } }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">T</div>
    <h1>Workflows that stay on your machine.</h1>
    <p class="lede">Taskurotta is a local workflow studio and CLI for building graph-based automation with shell commands, scripts, HTTP requests, and AI agents.</p>
    <hr class="rule">
    <section class="features" aria-label="Taskurotta capabilities">
      <div><h2>Build visually</h2><p>Shape routes, branches, loops, and joins in the graph editor or write the same workflow in Radish.</p></div>
      <div><h2>Run locally</h2><p>Keep projects and execution on your computer. No account or hosted backend is required.</p></div>
      <div><h2>Use agents deliberately</h2><p>Mix deterministic steps with Codex, Claude, or API-backed agents where they earn their place.</p></div>
    </section>
    <div class="command">
      <p>Type a URL or search in the address bar. Your home page is configurable in Browser settings.</p>
      <kbd>Alt + D</kbd>
    </div>
  </main>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
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
  TASKUROTTA_HOME_URL,
  browserLoadUrl,
  browserShortcutAction,
  matchesBrowserBinding,
  normalizeBrowserUrl,
  taskurottaHomeDataUrl,
};
