import { fail, type ErrorCode, type ToolError, type ToolResult } from "./errors.js";
import { isBlockedUrl, parseOrigin } from "./origins.js";
import type { Bridge, WsFailure } from "./protocol.js";
import type { Session, SnapshotRef } from "./session.js";

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "extension_disconnected",
  "bridge_bind_failed",
  "no_tab",
  "blocked_origin",
  "needs_permission",
  "invalid_origin",
  "stale_ref",
  "timeout",
  "debugger_failed",
]);

type TabInfo = { tabId: number; url: string; title: string };
type TabListItem = {
  id: number;
  title: string;
  url: string;
  active: boolean;
  grok: boolean;
};
type ScrollDirection = "up" | "down" | "left" | "right";

function isErrorCode(code: string): code is ErrorCode {
  return ERROR_CODES.has(code);
}

function mapWsError(resp: WsFailure): ToolError {
  const code = isErrorCode(resp.error.code) ? resp.error.code : "debugger_failed";
  return fail(code, resp.error.message);
}

function noTab(): ToolError {
  return fail("no_tab", "No target tab. Use chrome_new_tab or chrome_use_tab.");
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function tabPayload(
  result: Record<string, unknown>,
  fallback?: { tabId?: number | null; url?: string },
): TabInfo {
  const tabId = asNumber(result.tabId) ?? fallback?.tabId ?? 0;
  return {
    tabId,
    url: asString(result.url, fallback?.url ?? ""),
    title: asString(result.title),
  };
}

function snapshotRefs(
  value: unknown,
): Map<string, SnapshotRef> {
  const map = new Map<string, SnapshotRef>();
  if (!value || typeof value !== "object") return map;
  for (const [ref, node] of Object.entries(value as Record<string, unknown>)) {
    if (!node || typeof node !== "object") continue;
    const backendNodeId = (node as { backendNodeId?: unknown }).backendNodeId;
    if (typeof backendNodeId === "number") {
      map.set(ref, { backendNodeId });
    }
  }
  return map;
}

export function createTools(session: Session, bridge: Bridge) {
  const run = <T>(fn: () => Promise<T>): Promise<T> => session.enqueue(fn);

  function checkDestination(url: string): ToolResult<{ origin: string }> {
    const parsed = parseOrigin(url);
    if (!parsed.ok) return parsed;
    if (isBlockedUrl(url)) {
      return fail("blocked_origin", `Blocked origin: ${parsed.origin}`, {
        origin: parsed.origin,
      });
    }
    const grant = session.requireGrant(parsed.origin);
    if (!grant.ok) return grant;
    return parsed;
  }

  async function requirePageGrant(
    tabId: number,
  ): Promise<ToolResult<{ url: string; title: string }>> {
    const resp = await bridge.send("page", { tabId });
    if (!resp.ok) return mapWsError(resp);
    const url = asString(resp.result.url);
    const title = asString(resp.result.title);
    if (isBlockedUrl(url)) {
      const parsed = parseOrigin(url);
      return fail(
        "blocked_origin",
        `Blocked origin: ${url}`,
        parsed.ok ? { origin: parsed.origin } : undefined,
      );
    }
    const parsed = parseOrigin(url);
    if (!parsed.ok) return parsed;
    const grant = session.requireGrant(parsed.origin);
    if (!grant.ok) return grant;
    return { ok: true, url, title };
  }

  function adoptGrokTab(result: Record<string, unknown>): void {
    const tabId = asNumber(result.tabId);
    if (tabId === undefined) return;
    session.targetTabId = tabId;
    session.markGrokTab(tabId);
  }

  async function grantSite(origin: string) {
    return session.grant(origin);
  }

  async function tabs() {
    return run(async () => {
      const resp = await bridge.send("tabs", {});
      if (!resp.ok) return mapWsError(resp);
      const raw = Array.isArray(resp.result.tabs) ? resp.result.tabs : [];
      const list: TabListItem[] = raw.map((item) => {
        const tab = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        const id = asNumber(tab.id) ?? 0;
        return {
          id,
          title: asString(tab.title),
          url: asString(tab.url),
          active: Boolean(tab.active),
          grok: session.isGrokTab(id),
        };
      });
      return { ok: true as const, tabs: list, targetTabId: session.targetTabId };
    });
  }

  async function newTab(url?: string) {
    if (url !== undefined) {
      const dest = checkDestination(url);
      if (!dest.ok) return dest;
    }
    return run(async () => {
      const params: Record<string, unknown> = url !== undefined ? { url } : {};
      const resp = await bridge.send("newTab", params);
      if (!resp.ok) return mapWsError(resp);
      adoptGrokTab(resp.result);
      return { ok: true as const, ...tabPayload(resp.result, { url: url ?? "about:blank" }) };
    });
  }

  async function useTab(tabId: number) {
    return run(async () => {
      const resp = await bridge.send("page", { tabId });
      if (!resp.ok) {
        return fail("no_tab", resp.error.message || `Tab ${tabId} not found`);
      }
      session.targetTabId = tabId;
      return { ok: true as const, ...tabPayload(resp.result, { tabId }) };
    });
  }

  async function page() {
    const tabId = session.targetTabId;
    if (tabId == null) return noTab();
    return run(async () => {
      const resp = await bridge.send("page", { tabId });
      if (!resp.ok) return mapWsError(resp);
      const info = tabPayload(resp.result, { tabId });
      if (isBlockedUrl(info.url)) {
        const parsed = parseOrigin(info.url);
        return fail(
          "blocked_origin",
          `Blocked origin: ${info.url}`,
          parsed.ok ? { origin: parsed.origin } : undefined,
        );
      }
      return { ok: true as const, ...info };
    });
  }

  async function navigate(url: string) {
    const dest = checkDestination(url);
    if (!dest.ok) return dest;
    return run(async () => {
      const resp = await bridge.send("navigate", {
        tabId: session.targetTabId,
        url,
      });
      if (!resp.ok) return mapWsError(resp);
      adoptGrokTab(resp.result);
      return { ok: true as const, ...tabPayload(resp.result, { tabId: session.targetTabId, url }) };
    });
  }

  async function screenshot() {
    const tabId = session.targetTabId;
    if (tabId == null) return noTab();
    return run(async () => {
      const resp = await bridge.send("screenshot", { tabId });
      if (!resp.ok) return mapWsError(resp);
      return {
        ok: true as const,
        data: asString(resp.result.data),
        width: asNumber(resp.result.width) ?? 0,
        height: asNumber(resp.result.height) ?? 0,
      };
    });
  }

  async function snapshot() {
    const tabId = session.targetTabId;
    if (tabId == null) return noTab();
    return run(async () => {
      const resp = await bridge.send("snapshot", { tabId });
      if (!resp.ok) return mapWsError(resp);
      session.rememberSnapshot(tabId, snapshotRefs(resp.result.refs));
      return { ok: true as const, text: asString(resp.result.text) };
    });
  }

  async function click(ref: string) {
    return run(async () => {
      const tabId = session.targetTabId;
      if (tabId == null) return noTab();
      const node = session.lookupRef(tabId, ref);
      if (!node.ok) return node;
      const granted = await requirePageGrant(tabId);
      if (!granted.ok) return granted;
      const resp = await bridge.send("click", {
        tabId,
        backendNodeId: node.backendNodeId,
      });
      if (!resp.ok) return mapWsError(resp);
      return { ok: true as const };
    });
  }

  async function type(text: string, ref?: string, submit?: boolean) {
    return run(async () => {
      const tabId = session.targetTabId;
      if (tabId == null) return noTab();
      let backendNodeId: number | undefined;
      if (ref !== undefined) {
        const node = session.lookupRef(tabId, ref);
        if (!node.ok) return node;
        backendNodeId = node.backendNodeId;
      }
      const granted = await requirePageGrant(tabId);
      if (!granted.ok) return granted;
      const params: Record<string, unknown> = {
        tabId,
        text,
        submit: submit === true,
      };
      if (backendNodeId !== undefined) params.backendNodeId = backendNodeId;
      const resp = await bridge.send("type", params);
      if (!resp.ok) return mapWsError(resp);
      return { ok: true as const };
    });
  }

  async function fill(ref: string, value: string) {
    return run(async () => {
      const tabId = session.targetTabId;
      if (tabId == null) return noTab();
      const node = session.lookupRef(tabId, ref);
      if (!node.ok) return node;
      const granted = await requirePageGrant(tabId);
      if (!granted.ok) return granted;
      const resp = await bridge.send("fill", {
        tabId,
        backendNodeId: node.backendNodeId,
        value,
      });
      if (!resp.ok) return mapWsError(resp);
      return { ok: true as const };
    });
  }

  async function scroll(
    direction: ScrollDirection,
    ref?: string,
    amount?: number,
  ) {
    return run(async () => {
      const tabId = session.targetTabId;
      if (tabId == null) return noTab();
      let backendNodeId: number | undefined;
      if (ref !== undefined) {
        const node = session.lookupRef(tabId, ref);
        if (!node.ok) return node;
        backendNodeId = node.backendNodeId;
      }
      const granted = await requirePageGrant(tabId);
      if (!granted.ok) return granted;
      const params: Record<string, unknown> = {
        tabId,
        direction,
        amount: amount ?? 3,
      };
      if (backendNodeId !== undefined) params.backendNodeId = backendNodeId;
      const resp = await bridge.send("scroll", params);
      if (!resp.ok) return mapWsError(resp);
      return { ok: true as const };
    });
  }

  async function consoleMessages(level?: string, limit?: number) {
    const tabId = session.targetTabId;
    if (tabId == null) return noTab();
    return run(async () => {
      const params: Record<string, unknown> = { tabId };
      if (level !== undefined) params.level = level;
      if (limit !== undefined) params.limit = limit;
      const resp = await bridge.send("console", params);
      if (!resp.ok) return mapWsError(resp);
      const messages = Array.isArray(resp.result.messages) ? resp.result.messages : [];
      return { ok: true as const, messages };
    });
  }

  async function network(urlContains?: string, status?: number, limit?: number) {
    const tabId = session.targetTabId;
    if (tabId == null) return noTab();
    return run(async () => {
      const params: Record<string, unknown> = { tabId };
      if (urlContains !== undefined) params.urlContains = urlContains;
      if (status !== undefined) params.status = status;
      if (limit !== undefined) params.limit = limit;
      const resp = await bridge.send("network", params);
      if (!resp.ok) return mapWsError(resp);
      const requests = Array.isArray(resp.result.requests) ? resp.result.requests : [];
      return { ok: true as const, requests };
    });
  }

  return {
    grantSite,
    tabs,
    newTab,
    useTab,
    page,
    navigate,
    screenshot,
    snapshot,
    click,
    type,
    fill,
    scroll,
    consoleMessages,
    network,
  };
}
