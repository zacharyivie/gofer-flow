const DEFAULT_API_BASE_URL = "/api";

export function installGoferApiFetchAuth() {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  if (window.__goferApiFetchAuthInstalled) return;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    if (shouldBootstrapGoferApiAuth(input, init)) {
      await ensureGoferApiToken(nativeFetch);
    }
    return nativeFetch(...withGoferApiAuth(input, init));
  };
  window.__goferApiFetchAuthInstalled = true;
}

export function apiUrl(path) {
  const baseUrl = normalizeApiBaseUrl(window.goferApiBaseUrl || DEFAULT_API_BASE_URL);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  return `${baseUrl}${normalizedPath}`;
}

export function withGoferApiAuth(input, init = {}) {
  const token = window.goferApiToken;
  if (!token || !isGoferApiRequest(input)) return [input, init];

  const headers = new Headers(init.headers || requestHeaders(input));
  if (!headers.has("Authorization") && !headers.has("X-Gofer-Webhook-Token")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return [input, { ...init, headers }];
}

export async function ensureGoferApiToken(fetchImpl = window.fetch.bind(window)) {
  if (window.goferApiToken || window.__goferApiTokenPromise) {
    return window.__goferApiTokenPromise || window.goferApiToken;
  }
  window.__goferApiTokenPromise = fetchImpl(apiUrl("/session"))
    .then(async (response) => {
      if (!response.ok) return "";
      const payload = await response.json();
      const token = typeof payload.apiToken === "string" ? payload.apiToken : "";
      if (token) {
        window.goferApiToken = token;
      }
      return token;
    })
    .catch(() => "")
    .finally(() => {
      window.__goferApiTokenPromise = undefined;
    });
  return window.__goferApiTokenPromise;
}

function requestHeaders(input) {
  return typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined;
}

function isGoferApiRequest(input) {
  const value = typeof input === "string" ? input : input?.url;
  if (!value) return false;
  const target = new URL(value, window.location?.href || "http://127.0.0.1/");
  const apiBase = new URL(apiUrl("/"), window.location?.href || "http://127.0.0.1/");
  return (
    target.origin === apiBase.origin &&
    target.pathname.startsWith(apiBase.pathname) &&
    !target.pathname.includes("/webhooks/")
  );
}

function shouldBootstrapGoferApiAuth(input, init = {}) {
  if (window.goferApiToken || !isGoferApiRequest(input)) return false;
  const value = typeof input === "string" ? input : input?.url;
  const target = new URL(value, window.location?.href || "http://127.0.0.1/");
  if (target.pathname.endsWith("/session") || target.pathname.includes("/webhooks/")) {
    return false;
  }
  return stateChangingMethod(input, init);
}

function stateChangingMethod(input, init = {}) {
  const method =
    init.method ||
    (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET");
  return !["GET", "HEAD", "OPTIONS"].includes(String(method || "GET").toUpperCase());
}

function normalizeApiBaseUrl(baseUrl) {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

  if (isHttpOrigin(normalizedBaseUrl)) {
    return `${normalizedBaseUrl}/api`;
  }

  return normalizedBaseUrl;
}

function isHttpOrigin(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.pathname === "/";
  } catch {
    return false;
  }
}
