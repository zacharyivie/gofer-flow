const DEFAULT_API_BASE_URL = "/api";

export function apiUrl(path) {
  const baseUrl = normalizeApiBaseUrl(window.goferApiBaseUrl || DEFAULT_API_BASE_URL);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  return `${baseUrl}${normalizedPath}`;
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
