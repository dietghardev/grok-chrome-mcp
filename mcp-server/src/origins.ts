import { fail, type ToolResult } from "./errors.js";

const BLOCKED_SCHEMES = new Set([
  "chrome:",
  "chrome-extension:",
  "chrome-search:",
  "chrome-untrusted:",
  "chrome-native:",
  "edge:",
  "brave:",
  "opera:",
  "vivaldi:",
  "devtools:",
  "view-source:",
  "file:",
  "data:",
  "javascript:",
  "filesystem:",
]);
const WEBSTORE_HOSTS = new Set([
  "chrome.google.com",
  "chromewebstore.google.com",
  "microsoftedge.microsoft.com",
]);

export function parseOrigin(input: string): ToolResult<{ origin: string }> {
  try {
    const url = new URL(input);
    if (!url.hostname) {
      return fail("invalid_origin", `Cannot parse origin: ${input}`);
    }
    return { ok: true, origin: url.origin };
  } catch {
    return fail("invalid_origin", `Cannot parse origin: ${input}`);
  }
}

export function isBlockedUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol === "about:") return u.pathname !== "blank";
    if (BLOCKED_SCHEMES.has(u.protocol)) return true;
    if (WEBSTORE_HOSTS.has(u.hostname)) return true;
    return false;
  } catch {
    return true;
  }
}
