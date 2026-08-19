import fsp from "node:fs/promises";
import path from "node:path";
import { fail, type ErrorCode, type ToolError, type ToolResult } from "./errors.js";
import { encodeGif } from "./gif.js";
import { isBlockedUrl, parseOrigin } from "./origins.js";
import { DEFAULT_MAX_FRAMES, MAX_FPS, Recorder } from "./record.js";
import type { Bridge, WsFailure } from "./protocol.js";
import type { Session, SnapshotRef } from "./session.js";

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "extension_disconnected",
  "bridge_bind_failed",
  "no_tab",
  "blocked_origin",
  "needs_permission",
  "invalid_origin",
  "invalid_input",
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
    url:
      asString(result.url) ||
      asString(result.pendingUrl) ||
      fallback?.url ||
      "",
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

function isAboutBlank(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "about:" && parsed.pathname === "blank";
  } catch {
    return false;
  }
}

function blockedOrigin(url: string): ToolError {
  const parsed = parseOrigin(url);
  return fail(
    "blocked_origin",
    `Blocked origin: ${url}`,
    parsed.ok ? { origin: parsed.origin } : undefined,
  );
}

export function createTools(session: Session, bridge: Bridge) {
  bridge.onBrowserGone((browserId) => session.forgetBrowser(browserId));

  /**
   * Tab ids and refs are scoped per browser, so every command re-syncs the
   * session to whichever browser the bridge is currently talking to.
   */
  const syncActiveBrowser = (): void => {
    const active = bridge.activeBrowserId();
    if (active) session.activeBrowserId = active;
  };

  const run = <T>(fn: () => Promise<T>): Promise<T> =>
    session.enqueue(async () => {
      syncActiveBrowser();
      return fn();
    });

  function checkDestination(url: string): ToolResult<{ origin: string }> {
    if (isAboutBlank(url)) return { ok: true, origin: "about:blank" };
    if (isBlockedUrl(url)) return blockedOrigin(url);
    const parsed = parseOrigin(url);
    if (!parsed.ok) return parsed;
    const grant = session.requireGrant(parsed.origin);
    if (!grant.ok) return grant;
    return parsed;
  }

  function forgetIfTargetGone(tabId: number): void {
    if (session.targetTabId === tabId) session.unmarkGrokTab(tabId);
  }

  async function loadPage(tabId: number): Promise<ToolResult<TabInfo>> {
    const resp = await bridge.send("page", { tabId });
    if (!resp.ok) {
      if (resp.error.code === "no_tab") forgetIfTargetGone(tabId);
      return mapWsError(resp);
    }
    const info = tabPayload(resp.result, { tabId });
    if (isBlockedUrl(info.url)) return blockedOrigin(info.url);
    return { ok: true, ...info };
  }

  async function requirePageGrant(
    tabId: number,
    opts: { allowBlank?: boolean } = {},
  ): Promise<ToolResult<TabInfo>> {
    const info = await loadPage(tabId);
    if (!info.ok) return info;
    if (opts.allowBlank !== false && isAboutBlank(info.url)) return info;
    if (isAboutBlank(info.url)) {
      return fail(
        "invalid_input",
        "Cannot run this tool on about:blank. Navigate to a granted origin first.",
      );
    }
    const parsed = parseOrigin(info.url);
    if (!parsed.ok) return parsed;
    const grant = session.requireGrant(parsed.origin);
    if (!grant.ok) return grant;
    return info;
  }

  async function sendNewTab(url?: string): Promise<ToolResult<TabInfo>> {
    const params: Record<string, unknown> = url !== undefined ? { url } : {};
    const resp = await bridge.send("newTab", params);
    if (!resp.ok) return mapWsError(resp);
    adoptGrokTab(resp.result);
    return {
      ok: true,
      ...tabPayload(resp.result, { url: url ?? "about:blank" }),
    };
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

  async function revokeSite(origin: string) {
    return session.revoke(origin);
  }

  async function browsers() {
    syncActiveBrowser();
    return { ok: true as const, browsers: bridge.clients() };
  }

  async function selectBrowser(browserId: string) {
    if (!bridge.select(browserId)) {
      return fail(
        "extension_disconnected",
        `Browser ${browserId} is not connected. Call chrome_browsers to see what is.`,
      );
    }
    session.activeBrowserId = browserId;
    return { ok: true as const, browsers: bridge.clients() };
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
    return run(async () => sendNewTab(url));
  }

  async function useTab(tabId: number) {
    return run(async () => {
      const resp = await bridge.send("page", { tabId });
      if (!resp.ok) {
        if (resp.error.code === "no_tab") forgetIfTargetGone(tabId);
        return fail("no_tab", resp.error.message || `Tab ${tabId} not found`);
      }
      const info = tabPayload(resp.result, { tabId });
      if (isBlockedUrl(info.url)) return blockedOrigin(info.url);
      session.targetTabId = tabId;
      return { ok: true as const, ...info };
    });
  }

  async function page() {
    return run(async () => {
      const tabId = session.targetTabId;
      if (tabId == null) return noTab();
      return loadPage(tabId);
    });
  }

  async function navigate(url: string) {
    const dest = checkDestination(url);
    if (!dest.ok) return dest;
    return run(async () => {
      let tabId = session.targetTabId;
      if (tabId == null) {
        const opened = await sendNewTab();
        if (!opened.ok) return opened;
        tabId = opened.tabId;
      }
      const resp = await bridge.send("navigate", { tabId, url });
      if (!resp.ok) {
        if (resp.error.code === "no_tab") forgetIfTargetGone(tabId);
        return mapWsError(resp);
      }
      // Keep whatever ownership this tab already had. Navigating a tab the
      // user pointed us at must not turn it into a Grok tab that closeTab
      // can then destroy without a grant.
      session.targetTabId = asNumber(resp.result.tabId) ?? tabId;
      return { ok: true as const, ...tabPayload(resp.result, { tabId, url }) };
    });
  }

  async function screenshot() {
    return run(async () => {
      const tabId = session.targetTabId;
      if (tabId == null) return noTab();
      const readable = await loadPage(tabId);
      if (!readable.ok) return readable;
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
    return run(async () => {
      const tabId = session.targetTabId;
      if (tabId == null) return noTab();
      const readable = await loadPage(tabId);
      if (!readable.ok) return readable;
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
    return run(async () => {
      const tabId = session.targetTabId;
      if (tabId == null) return noTab();
      const readable = await loadPage(tabId);
      if (!readable.ok) return readable;
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
    return run(async () => {
      const tabId = session.targetTabId;
      if (tabId == null) return noTab();
      const readable = await loadPage(tabId);
      if (!readable.ok) return readable;
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


  /** Resolves a snapshot ref on the target tab, gated on the page's origin. */
  async function actOnRef(
    ref: string | undefined,
    method: string,
    extra: Record<string, unknown> = {},
    opts: { allowBlank?: boolean } = {},
  ): Promise<ToolResult<Record<string, unknown>>> {
    const tabId = session.targetTabId;
    if (tabId == null) return noTab();
    const params: Record<string, unknown> = { tabId, ...extra };
    if (ref !== undefined) {
      const node = session.lookupRef(tabId, ref);
      if (!node.ok) return node;
      params.backendNodeId = node.backendNodeId;
    }
    const granted = await requirePageGrant(tabId, opts);
    if (!granted.ok) return granted;
    const resp = await bridge.send(method, params);
    if (!resp.ok) return mapWsError(resp);
    return { ok: true, ...resp.result };
  }

  /** Sends a read-only command that only needs the tab to be readable. */
  async function readOnly(
    method: string,
    extra: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<ToolResult<Record<string, unknown>>> {
    const tabId = session.targetTabId;
    if (tabId == null) return noTab();
    const readable = await loadPage(tabId);
    if (!readable.ok) return readable;
    const resp = await bridge.send(method, { tabId, ...extra }, timeoutMs);
    if (!resp.ok) return mapWsError(resp);
    return { ok: true, ...resp.result };
  }

  async function hover(ref: string) {
    return run(async () => actOnRef(ref, "hover"));
  }

  async function drag(fromRef: string, toRef: string) {
    return run(async () => {
      const tabId = session.targetTabId;
      if (tabId == null) return noTab();
      const to = session.lookupRef(tabId, toRef);
      if (!to.ok) return to;
      return actOnRef(fromRef, "drag", { toBackendNodeId: to.backendNodeId });
    });
  }

  async function press(key: string, ref?: string) {
    return run(async () => actOnRef(ref, "press", { key }));
  }

  async function selectOption(ref: string, values: string[]) {
    return run(async () => actOnRef(ref, "selectOption", { values }));
  }

  async function uploadFile(ref: string, paths: string[]) {
    return run(async () =>
      actOnRef(ref, "uploadFile", { paths }, { allowBlank: false }),
    );
  }

  async function back() {
    return run(async () => actOnRef(undefined, "back"));
  }

  async function forward() {
    return run(async () => actOnRef(undefined, "forward"));
  }

  async function reload() {
    return run(async () => actOnRef(undefined, "reload"));
  }

  async function evaluate(expression: string) {
    return run(async () =>
      actOnRef(undefined, "evaluate", { expression }, { allowBlank: false }),
    );
  }

  async function resize(width: number, height: number) {
    return run(async () => {
      const tabId = session.targetTabId;
      if (tabId == null) return noTab();
      const resp = await bridge.send("resize", { tabId, width, height });
      if (!resp.ok) return mapWsError(resp);
      return { ok: true as const, ...resp.result };
    });
  }

  async function closeTab(tabId?: number) {
    return run(async () => {
      const target = tabId ?? session.targetTabId;
      if (target == null) return noTab();
      // Closing a tab Grok opened is its own business; closing one of the
      // user's tabs destroys their state, so that needs the origin grant.
      if (!session.isGrokTab(target)) {
        const granted = await requirePageGrant(target);
        if (!granted.ok) return granted;
      }
      const resp = await bridge.send("closeTab", { tabId: target });
      if (!resp.ok) return mapWsError(resp);
      session.unmarkGrokTab(target);
      return { ok: true as const, closedTabId: target };
    });
  }

  /** The overlay is aria-hidden and pointer-events:none, so it is not an
   * interaction with the page and needs no origin grant. */
  async function cursor(show: boolean) {
    return run(async () => {
      const tabId = session.targetTabId;
      if (tabId == null) return noTab();
      const resp = await bridge.send("cursor", { tabId, show });
      if (!resp.ok) return mapWsError(resp);
      return { ok: true as const, ...resp.result };
    });
  }

  const recorder = new Recorder();
  let recordTimer: ReturnType<typeof setInterval> | null = null;

  const stopTimer = (): void => {
    if (recordTimer) clearInterval(recordTimer);
    recordTimer = null;
  };

  async function recordStart(fps?: number, maxFrames?: number) {
    const tabId = session.targetTabId;
    if (tabId == null) return noTab();
    if (recorder.isRecording()) {
      return fail(
        "invalid_input",
        "Already recording. Call chrome_record_stop first.",
      );
    }
    const rate = Math.min(Math.max(fps ?? 2, 1), MAX_FPS);
    recorder.start(rate, maxFrames ?? DEFAULT_MAX_FRAMES);

    // Frames go through the same serial queue as actions, so a frame is only
    // ever captured between steps, never halfway through a click.
    recordTimer = setInterval(() => {
      void run(async () => {
        if (!recorder.isRecording()) return;
        const current = session.targetTabId;
        if (current == null) return;
        const resp = await bridge.send("screenshot", { tabId: current });
        if (!resp.ok) return;
        const data = asString(resp.result.data);
        if (data) recorder.addFrame(Buffer.from(data, "base64"));
      }).catch(() => undefined);
    }, recorder.intervalMs());
    if (typeof recordTimer.unref === "function") recordTimer.unref();

    return { ok: true as const, fps: rate, intervalMs: recorder.intervalMs() };
  }

  async function recordStop(outPath: string, delayMs?: number) {
    if (!recorder.isRecording()) {
      return fail("invalid_input", "Not recording. Call chrome_record_start first.");
    }
    if (!path.isAbsolute(outPath)) {
      return fail("invalid_input", `Output path must be absolute: ${outPath}`);
    }
    stopTimer();
    const interval = recorder.intervalMs();
    const cappedOut = recorder.hitCap();
    const frames = recorder.stop();
    if (!frames.length) {
      return fail(
        "timeout",
        "No frames captured. Was the tab still open while recording?",
      );
    }
    let gif;
    try {
      gif = encodeGif(frames, { delayMs: delayMs ?? interval });
    } catch (err) {
      return fail(
        "invalid_input",
        `Could not encode the recording: ${(err as Error).message}`,
      );
    }
    try {
      await fsp.mkdir(path.dirname(outPath), { recursive: true });
      await fsp.writeFile(outPath, gif);
    } catch (err) {
      return fail("invalid_input", `Could not write ${outPath}: ${(err as Error).message}`);
    }
    return {
      ok: true as const,
      path: outPath,
      frames: gif.frameCount,
      dropped: gif.dropped,
      bytes: gif.length,
      truncated: cappedOut,
    };
  }

  async function pageText(maxChars?: number) {
    return run(async () => {
      const extra: Record<string, unknown> = {};
      if (maxChars !== undefined) extra.maxChars = maxChars;
      const r = await readOnly("text", extra);
      if (!r.ok) return r;
      return {
        ok: true as const,
        text: asString(r.text),
        truncated: r.truncated === true,
      };
    });
  }

  async function find(text?: string, role?: string) {
    return run(async () => {
      const tabId = session.targetTabId;
      if (tabId == null) return noTab();
      const extra: Record<string, unknown> = {};
      if (text !== undefined) extra.text = text;
      if (role !== undefined) extra.role = role;
      const r = await readOnly("find", extra);
      if (!r.ok) return r;
      // find shares chrome_snapshot's numbering, so its refs stay clickable.
      session.rememberSnapshot(tabId, snapshotRefs(r.refs));
      return {
        ok: true as const,
        text: asString(r.text),
        matches: asNumber(r.matches) ?? 0,
      };
    });
  }

  async function waitFor(opts: {
    text?: string;
    textGone?: string;
    timeoutMs?: number;
  }) {
    return run(async () => {
      const extra: Record<string, unknown> = {};
      if (opts.text !== undefined) extra.text = opts.text;
      if (opts.textGone !== undefined) extra.textGone = opts.textGone;
      const timeoutMs = opts.timeoutMs ?? 10_000;
      extra.timeoutMs = timeoutMs;
      return readOnly("waitFor", extra, timeoutMs + 5_000);
    });
  }

  type BatchAction = Record<string, unknown> & { tool?: unknown };

  /** One round-trip for a short fixed sequence, stopping at the first error. */
  async function batch(actions: BatchAction[]) {
    const results: unknown[] = [];
    for (const action of actions) {
      const name = typeof action.tool === "string" ? action.tool : "";
      const str = (key: string): string =>
        typeof action[key] === "string" ? (action[key] as string) : "";
      const optStr = (key: string): string | undefined =>
        typeof action[key] === "string" ? (action[key] as string) : undefined;
      const optNum = (key: string): number | undefined =>
        typeof action[key] === "number" ? (action[key] as number) : undefined;

      let result: unknown;
      switch (name) {
        case "click":
          result = await click(str("ref"));
          break;
        case "type":
          result = await type(str("text"), optStr("ref"), action.submit === true);
          break;
        case "fill":
          result = await fill(str("ref"), str("value"));
          break;
        case "press":
          result = await press(str("key"), optStr("ref"));
          break;
        case "hover":
          result = await hover(str("ref"));
          break;
        case "drag":
          result = await drag(str("ref"), str("toRef"));
          break;
        case "selectOption":
          result = await selectOption(
            str("ref"),
            Array.isArray(action.values) ? (action.values as string[]) : [],
          );
          break;
        case "scroll":
          result = await scroll(
            (optStr("direction") ?? "down") as ScrollDirection,
            optStr("ref"),
            optNum("amount"),
          );
          break;
        case "navigate":
          result = await navigate(str("url"));
          break;
        case "waitFor":
          result = await waitFor({
            text: optStr("text"),
            textGone: optStr("textGone"),
            timeoutMs: optNum("timeoutMs"),
          });
          break;
        case "snapshot":
          result = await snapshot();
          break;
        default:
          return fail(
            "invalid_input",
            `Unknown batch action "${name}". Use click, type, fill, press, hover, drag, selectOption, scroll, navigate, waitFor, or snapshot.`,
          );
      }
      const step = result as { ok?: boolean };
      if (!step?.ok) return result as ToolError;
      results.push(result);
    }
    return { ok: true as const, results };
  }

  return {
    grantSite,
    revokeSite,
    browsers,
    selectBrowser,
    tabs,
    newTab,
    closeTab,
    hover,
    drag,
    press,
    selectOption,
    uploadFile,
    back,
    forward,
    reload,
    evaluate,
    resize,
    pageText,
    find,
    waitFor,
    cursor,
    recordStart,
    recordStop,
    batch,
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
