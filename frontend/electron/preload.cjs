const { contextBridge } = require("electron");

const API_BASE_URL_ARG = "--gofer-api-base-url=";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8765";
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function readApiBaseUrl() {
  const arg = process.argv.find((value) => value.startsWith(API_BASE_URL_ARG));
  const value = arg ? arg.slice(API_BASE_URL_ARG.length) : DEFAULT_API_BASE_URL;

  return isSafeLocalHttpUrl(value) ? value : DEFAULT_API_BASE_URL;
}

function isSafeLocalHttpUrl(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      LOCAL_HOSTNAMES.has(url.hostname)
    );
  } catch {
    return false;
  }
}

contextBridge.exposeInMainWorld("goferApiBaseUrl", readApiBaseUrl());
