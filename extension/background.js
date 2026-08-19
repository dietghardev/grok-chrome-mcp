const PORTS = [];
for (let p = 17352; p <= 17361; p++) PORTS.push(p);

import { findMatches, renderSnapshot } from "./lib/ax.js";
import { detectBrowserName, stableBrowserId } from "./lib/identity.js";
import { parseKey } from "./lib/keys.js";

const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const RECONNECT_START_MS = 300;
const RECONNECT_CAP_MS = 5000;
const HEALTH_TIMEOUT_MS = 200;
const NAVIGATE_TIMEOUT_MS = 30000;
const HISTORY_IDLE_MS = 400;
const SCROLL_TICK_PX = 360;
const CONSOLE_MAX = 500;
const NETWORK_MAX = 200;
const BUFFER_LIMIT_DEFAULT = 100;
const TEXT_DEFAULT_CAP = 20000;
const TEXT_HARD_CAP = 200000;
const WAIT_POLL_MS = 250;
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
const attached = new Map();

let connected = false;
let bridgePort = null;
let browserName = "Chrome";
let ws = null;
let connecting = false;
let reconnectDelay = RECONNECT_START_MS;
let reconnectTimer = null;

async function buildHello() {
  // Identity must never block the handshake: if detection fails we still say
  // hello, just with defaults.
  try {
    browserName = await detectBrowserName(navigator);
  } catch {
    browserName = "Chrome";
  }
  let id;
  try {
    id = await stableBrowserId(chrome.storage.local);
  } catch {
    id = "ephemeral-" + Math.floor(Math.random() * 1e9);
  }
  return {
    type: "hello",
    extensionVersion: EXTENSION_VERSION,
    browserId: id,
    browserName,
  };
}

async function findBridge() {
  for (const p of PORTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(`http://127.0.0.1:${p}/health`, {
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.name === "grok-chrome") return p;
    } catch {
      // try the next port
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function isBlockedUrl(url) {
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

function fail(code, message) {
  return { code, message };
}

function tabResult(tab) {
  return {
    tabId: tab.id,
    url: tab.url || tab.pendingUrl || "",
    title: tab.title || "",
  };
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

function waitComplete(tabId, timeoutMs) {
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    let seenNewLoad = false;

    function finish(tab, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error);
      else resolve(tab);
    }

    cancel = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };

    const timer = setTimeout(() => {
      finish(
        null,
        Object.assign(new Error("Navigation timed out"), { code: "timeout" }),
      );
    }, timeoutMs);

    function onUpdated(id, info, tab) {
      if (id !== tabId) return;
      if (info.status === "loading" || info.url) seenNewLoad = true;
      if (info.status === "complete" && seenNewLoad) finish(tab);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
  promise.cancel = cancel;
  return promise;
}

async function listTabs() {
  const list = await chrome.tabs.query({});
  return {
    tabs: list.map((tab) => ({
      id: tab.id,
      title: tab.title || "",
      url: tab.url || "",
      active: Boolean(tab.active),
    })),
  };
}

async function groupGrokTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const groups = await chrome.tabGroups.query({
      title: "Grok",
      windowId: tab.windowId,
    });
    const options = { tabIds: [tabId] };
    if (groups.length) options.groupId = groups[0].id;
    const groupId = await chrome.tabs.group(options);
    await chrome.tabGroups.update(groupId, { title: "Grok", color: "blue" });
  } catch {
    // grouping is best-effort
  }
}

async function newTab(url) {
  const target = url || "about:blank";
  if (isBlockedUrl(target)) {
    return fail("blocked_origin", `Blocked origin: ${target}`);
  }
  const tab = await chrome.tabs.create({ url: target });
  await groupGrokTab(tab.id);
  if (target === "about:blank") return tabResult(tab);

  // Wait for the load, so the first snapshot after opening a tab describes the
  // page rather than the blank document it started as.
  const pending = waitComplete(tab.id, NAVIGATE_TIMEOUT_MS);
  const settled = await getTab(tab.id);
  if (settled && settled.status === "complete" && settled.url === target) {
    pending.cancel();
    return tabResult(settled);
  }
  try {
    return tabResult(await pending);
  } catch (e) {
    if (e && e.code === "timeout") return fail("timeout", e.message);
    return tabResult(settled || tab);
  }
}

async function page(tabId) {
  const tab = await getTab(tabId);
  if (!tab) return fail("no_tab", `Tab ${tabId} not found`);
  return tabResult(tab);
}

async function navigate(tabId, url) {
  if (typeof url !== "string" || isBlockedUrl(url)) {
    return fail("blocked_origin", `Blocked origin: ${url}`);
  }
  const existing = await getTab(tabId);
  if (!existing) return fail("no_tab", `Tab ${tabId} not found`);
  const pending = waitComplete(tabId, NAVIGATE_TIMEOUT_MS);
  let updated;
  try {
    updated = await chrome.tabs.update(tabId, { url });
  } catch (e) {
    pending.cancel();
    return fail("no_tab", (e && e.message) || `Tab ${tabId} not found`);
  }
  if (updated && updated.status === "complete") {
    pending.cancel();
    return tabResult(updated);
  }
  try {
    const loaded = await pending;
    return tabResult(loaded);
  } catch (e) {
    if (e && e.code === "timeout") {
      return fail("timeout", e.message || "Navigation timed out");
    }
    return fail("no_tab", (e && e.message) || `Tab ${tabId} not found`);
  }
}

async function attach(tabId) {
  // Already set up: the domains stay enabled across navigations, so redoing
  // six CDP round-trips before every click is pure latency.
  if (attached.has(tabId)) return;

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (e) {
    if (!String(e).includes("already attached")) {
      throw Object.assign(new Error(String(e)), { code: "debugger_failed" });
    }
  }
  attached.set(tabId, {
    consoleBuf: [],
    networkBuf: [],
    requests: new Map(),
  });
  try {
    await chrome.debugger.sendCommand(target, "Page.enable", {});
    await chrome.debugger.sendCommand(target, "DOM.enable", {});
    await chrome.debugger.sendCommand(target, "Runtime.enable", {});
    await chrome.debugger.sendCommand(target, "Console.enable", {});
    await chrome.debugger.sendCommand(target, "Network.enable", {});
    await chrome.debugger.sendCommand(target, "Accessibility.enable", {});
  } catch (e) {
    // Half-enabled is worse than not attached: forget it so the next command
    // starts clean instead of sending into a dead session.
    attached.delete(tabId);
    throw Object.assign(new Error(String(e)), { code: "debugger_failed" });
  }
}

async function ensureAttached(tabId) {
  const tab = await getTab(tabId);
  if (!tab) return fail("no_tab", `Tab ${tabId} not found`);
  const url = tab.url || tab.pendingUrl || "";
  if (isBlockedUrl(url)) {
    return fail("blocked_origin", `Blocked origin: ${url}`);
  }
  await attach(tabId);
  return { tabId };
}

function pushCapped(buf, item, max) {
  buf.push(item);
  if (buf.length > max) buf.splice(0, buf.length - max);
}

function remoteText(arg) {
  if (arg == null || typeof arg !== "object") {
    return arg == null ? "" : String(arg);
  }
  if (arg.value !== undefined) {
    const v = arg.value;
    if (typeof v === "string") return v;
    if (v !== null && typeof v === "object") {
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    }
    return String(v);
  }
  if (arg.description != null) return String(arg.description);
  if (arg.unserializableValue != null) return String(arg.unserializableValue);
  return "";
}

function consoleArgsText(args) {
  return (Array.isArray(args) ? args : []).map(remoteText).join(" ");
}

function firstFrameUrl(stackTrace) {
  const frames = stackTrace && stackTrace.callFrames;
  const url = frames && frames[0] && frames[0].url;
  return url || undefined;
}

function consoleLevel(level) {
  return level === "warning" ? "warn" : level;
}

function bufferLimit(limit) {
  if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) {
    return limit;
  }
  return BUFFER_LIMIT_DEFAULT;
}

function tail(items, limit) {
  const n = bufferLimit(limit);
  if (n === 0) return [];
  return items.slice(-n);
}

function onDebuggerEvent(source, method, params) {
  const tabId = source && source.tabId;
  if (tabId == null) return;
  const state = attached.get(tabId);
  if (!state) return;
  const p = params && typeof params === "object" ? params : {};

  if (method === "Runtime.consoleAPICalled") {
    const url = firstFrameUrl(p.stackTrace);
    const entry = {
      level: consoleLevel(p.type),
      text: consoleArgsText(p.args),
      timestamp: p.timestamp,
    };
    if (url) entry.url = url;
    pushCapped(state.consoleBuf, entry, CONSOLE_MAX);
    return;
  }

  if (method === "Runtime.exceptionThrown") {
    const details = p.exceptionDetails || {};
    const url = details.url || firstFrameUrl(details.stackTrace);
    let text = "";
    if (details.exception) text = remoteText(details.exception);
    if (!text && details.text) text = String(details.text);
    const entry = {
      level: "error",
      text,
      timestamp: p.timestamp,
    };
    if (url) entry.url = url;
    pushCapped(state.consoleBuf, entry, CONSOLE_MAX);
    return;
  }

  if (method === "Network.requestWillBeSent") {
    const req = p.request || {};
    if (p.requestId != null) {
      state.requests.set(p.requestId, {
        method: req.method || "",
        url: req.url || "",
      });
    }
    return;
  }

  if (method === "Network.responseReceived") {
    const response = p.response || {};
    const pending = p.requestId != null ? state.requests.get(p.requestId) : undefined;
    const headers = response.requestHeaders;
    let httpMethod = pending && pending.method;
    if (!httpMethod && headers && typeof headers === "object") {
      httpMethod = headers[":method"] || headers.method;
    }
    const entry = {
      method: httpMethod || "",
      url: (pending && pending.url) || response.url || "",
      status: response.status,
    };
    if (response.mimeType) entry.mimeType = response.mimeType;
    pushCapped(state.networkBuf, entry, NETWORK_MAX);
    if (p.requestId != null) state.requests.delete(p.requestId);
  }
}

function quadCenter(points) {
  if (!points || points.length < 8) return null;
  return {
    x: (points[0] + points[2] + points[4] + points[6]) / 4,
    y: (points[1] + points[3] + points[5] + points[7]) / 4,
  };
}

function viewportFromMetrics(metrics) {
  const vp =
    (metrics && metrics.cssVisualViewport) ||
    (metrics && metrics.visualViewport) ||
    (metrics && metrics.cssLayoutViewport) ||
    (metrics && metrics.layoutViewport) ||
    {};
  return {
    width: Math.round(vp.clientWidth || 0),
    height: Math.round(vp.clientHeight || 0),
  };
}

async function nodeCenter(target, backendNodeId) {
  try {
    await chrome.debugger.sendCommand(target, "DOM.getDocument", { depth: 0 });
  } catch {
    // document may already be available
  }
  try {
    await chrome.debugger.sendCommand(target, "DOM.pushNodesByBackendIdsToFrontend", {
      backendNodeIds: [backendNodeId],
    });
  } catch {
    // node may already be in the frontend document
  }

  let center = null;
  try {
    const { quads } = await chrome.debugger.sendCommand(target, "DOM.getContentQuads", {
      backendNodeId,
    });
    if (quads && quads.length) center = quadCenter(quads[0]);
  } catch {
    // fall through to box model
  }
  if (!center) {
    const { model } = await chrome.debugger.sendCommand(target, "DOM.getBoxModel", {
      backendNodeId,
    });
    center = quadCenter(model && model.content);
  }
  if (!center) {
    throw Object.assign(new Error("Could not resolve node box"), {
      code: "debugger_failed",
    });
  }
  return { x: center.x, y: center.y };
}

async function clickAt(target, x, y) {
  const event = {
    x,
    y,
    button: "left",
    clickCount: 1,
  };
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    ...event,
    type: "mousePressed",
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    ...event,
    type: "mouseReleased",
  });
}

async function clickNode(target, backendNodeId) {
  const point = await nodeCenter(target, backendNodeId);
  await moveCursor(target, point.x, point.y, true);
  await clickAt(target, point.x, point.y);
  return point;
}

async function pressEnter(target) {
  const event = {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  };
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    ...event,
    type: "keyDown",
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    ...event,
    type: "keyUp",
  });
}

async function selectAll(target) {
  let mac = false;
  try {
    const info = await chrome.runtime.getPlatformInfo();
    mac = info && info.os === "mac";
  } catch {
    mac =
      typeof navigator !== "undefined" &&
      /Mac/i.test(navigator.platform || navigator.userAgent || "");
  }
  const modifiers = mac ? 4 : 2;
  const event = {
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers,
  };
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    ...event,
    type: "keyDown",
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    ...event,
    type: "keyUp",
  });
}

async function insertText(target, text) {
  await chrome.debugger.sendCommand(target, "Input.insertText", {
    text: text == null ? "" : String(text),
  });
}

async function screenshot(tabId) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  const target = { tabId };
  const metrics = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics", {});
  const size = viewportFromMetrics(metrics);
  const shot = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
    format: "png",
  });
  let data = (shot && shot.data) || "";
  if (data.startsWith("data:")) {
    const comma = data.indexOf(",");
    if (comma !== -1) data = data.slice(comma + 1);
  }
  return { data, width: size.width, height: size.height };
}

async function axEntries(tabId) {
  const target = { tabId };
  const tree = await chrome.debugger.sendCommand(
    target,
    "Accessibility.getFullAXTree",
    {},
  );
  return renderSnapshot(tree && tree.nodes);
}

async function snapshot(tabId) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  const { text, refs } = await axEntries(tabId);
  return { text, refs };
}

async function find(tabId, text, role) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  const snap = await axEntries(tabId);
  const hits = findMatches(snap.entries, { text, role });
  return {
    text: hits.map((h) => h.line).join("\n"),
    matches: hits.length,
    // Full map: a find result must stay clickable, and so must earlier refs.
    refs: snap.refs,
  };
}

async function click(tabId, backendNodeId) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  if (typeof backendNodeId !== "number") {
    throw Object.assign(new Error("backendNodeId is required"), {
      code: "debugger_failed",
    });
  }
  await clickNode({ tabId }, backendNodeId);
  return {};
}

async function typeIn(tabId, backendNodeId, text, submit) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  const target = { tabId };
  if (typeof backendNodeId === "number") {
    await clickNode(target, backendNodeId);
  }
  await insertText(target, text);
  if (submit) await pressEnter(target);
  return {};
}

async function fill(tabId, backendNodeId, value) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  if (typeof backendNodeId !== "number") {
    throw Object.assign(new Error("backendNodeId is required"), {
      code: "debugger_failed",
    });
  }
  const target = { tabId };
  await clickNode(target, backendNodeId);
  await selectAll(target);
  try {
    await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: "document.execCommand('selectAll'); document.execCommand('delete');",
      userGesture: true,
    });
  } catch {
    // key select-all still applied
  }
  await insertText(target, value);
  return {};
}

async function scroll(tabId, backendNodeId, direction, amount) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  const target = { tabId };
  const ticks = amount == null ? 1 : Number(amount);
  const mag = Number.isFinite(ticks) ? ticks : 1;
  const delta = SCROLL_TICK_PX * mag;
  let deltaX = 0;
  let deltaY = 0;
  if (direction === "down") deltaY = delta;
  else if (direction === "up") deltaY = -delta;
  else if (direction === "right") deltaX = delta;
  else if (direction === "left") deltaX = -delta;
  let x;
  let y;
  if (typeof backendNodeId === "number") {
    const point = await clickNode(target, backendNodeId);
    x = point.x;
    y = point.y;
  } else {
    const metrics = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics", {});
    const size = viewportFromMetrics(metrics);
    x = size.width / 2;
    y = size.height / 2;
  }
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX,
    deltaY,
  });
  return {};
}


async function evalInPage(target, expression, opts) {
  const res = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
    ...(opts || {}),
  });
  if (res && res.exceptionDetails) {
    const ex = res.exceptionDetails.exception;
    const message =
      (ex && (ex.description || ex.value)) || res.exceptionDetails.text;
    throw Object.assign(new Error(String(message)), { code: "debugger_failed" });
  }
  return res && res.result ? res.result.value : undefined;
}

async function callOnNode(target, backendNodeId, functionDeclaration, args) {
  const resolved = await chrome.debugger.sendCommand(target, "DOM.resolveNode", {
    backendNodeId,
  });
  const objectId = resolved && resolved.object && resolved.object.objectId;
  if (!objectId) {
    throw Object.assign(new Error("Could not resolve node"), {
      code: "debugger_failed",
    });
  }
  const res = await chrome.debugger.sendCommand(target, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    arguments: (args || []).map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res && res.exceptionDetails) {
    const ex = res.exceptionDetails.exception;
    const message =
      (ex && (ex.description || ex.value)) || res.exceptionDetails.text;
    throw Object.assign(new Error(String(message)), { code: "debugger_failed" });
  }
  return res && res.result ? res.result.value : undefined;
}


/**
 * Shadow mouse: a visible cursor so the user can watch what Grok is doing.
 * It lives in a shadow root with aria-hidden so it never shows up in the
 * accessibility snapshot or in chrome_text, and pointer-events:none keeps it
 * from ever swallowing a click. Every cursor call is best-effort — a page
 * with a strict CSP may refuse it, and that must not fail the real action.
 */
let cursorEnabled = true;

const CURSOR_SETUP = `
  const ID = "__grok_shadow_mouse__";
  let host = document.getElementById(ID);
  if (!host) {
    host = document.createElement("div");
    host.id = ID;
    host.setAttribute("aria-hidden", "true");
    const s = host.style;
    s.position = "fixed";
    s.left = "0px";
    s.top = "0px";
    s.width = "0px";
    s.height = "0px";
    s.zIndex = "2147483647";
    s.pointerEvents = "none";
    const root = host.attachShadow({ mode: "open" });

    const wrap = document.createElement("div");
    const w = wrap.style;
    w.position = "fixed";
    w.left = "0px";
    w.top = "0px";
    w.willChange = "transform";
    w.transition = "transform 120ms cubic-bezier(.22,.61,.36,1)";
    w.pointerEvents = "none";

    const arrow = document.createElement("div");
    arrow.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 20 20">' +
      '<path d="M4 2 L4 18 L8 14 L10.5 19 L13.2 17.8 L10.7 13 L15 12.6 Z" ' +
      'fill="#7C5CFF" stroke="#ffffff" stroke-width="1.2" stroke-linejoin="round"/></svg>';
    const a = arrow.style;
    a.position = "absolute";
    a.left = "0px";
    a.top = "0px";
    a.filter = "drop-shadow(0 1px 3px rgba(0,0,0,.45))";

    const ring = document.createElement("div");
    const r = ring.style;
    r.position = "absolute";
    r.left = "0px";
    r.top = "0px";
    r.width = "34px";
    r.height = "34px";
    r.marginLeft = "-17px";
    r.marginTop = "-17px";
    r.borderRadius = "50%";
    r.border = "2px solid #7C5CFF";
    r.opacity = "0";
    r.transform = "scale(.3)";

    wrap.appendChild(ring);
    wrap.appendChild(arrow);
    root.appendChild(wrap);
    (document.body || document.documentElement).appendChild(host);
    host.__grok = { wrap, ring };
  }
`;

function cursorMoveJs(x, y, click) {
  return `(() => {
${CURSOR_SETUP}
  if (!host || !host.__grok) return false;
  const { wrap, ring } = host.__grok;
  wrap.style.transform = "translate(${Number(x)}px, ${Number(y)}px)";
  if (${click ? "true" : "false"}) {
    ring.style.transition = "none";
    ring.style.opacity = "0.9";
    ring.style.transform = "scale(.3)";
    requestAnimationFrame(() => {
      ring.style.transition = "transform 320ms ease-out, opacity 320ms ease-out";
      ring.style.opacity = "0";
      ring.style.transform = "scale(1.15)";
    });
  }
  return true;
})()`;
}

async function moveCursor(target, x, y, click) {
  if (!cursorEnabled) return;
  try {
    await evalInPage(target, cursorMoveJs(x, y, Boolean(click)));
  } catch {
    // never let the overlay break the action it is illustrating
  }
}

async function removeCursor(target) {
  try {
    await evalInPage(
      target,
      `(() => { const n = document.getElementById("__grok_shadow_mouse__"); if (n) n.remove(); return true; })()`,
    );
  } catch {
    // nothing to clean up
  }
}

async function setCursor(tabId, show) {
  cursorEnabled = show !== false;
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  if (cursorEnabled) await moveCursor({ tabId }, 0, 0, false);
  else await removeCursor({ tabId });
  return { cursor: cursorEnabled };
}

async function closeTab(tabId) {
  const tab = await getTab(tabId);
  if (!tab) return fail("no_tab", `Tab ${tabId} not found`);
  if (attached.has(tabId)) {
    attached.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // the tab is going away anyway
    }
  }
  await chrome.tabs.remove(tabId);
  return { closedTabId: tabId };
}

async function hover(tabId, backendNodeId) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  const target = { tabId };
  const point = await nodeCenter(target, backendNodeId);
  await moveCursor(target, point.x, point.y);
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  return {};
}

async function drag(tabId, backendNodeId, toBackendNodeId) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  const target = { tabId };
  const from = await nodeCenter(target, backendNodeId);
  const to = await nodeCenter(target, toBackendNodeId);

  await moveCursor(target, from.x, from.y);
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: from.x,
    y: from.y,
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.x,
    y: from.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  // Intermediate moves: drag handlers that watch pointermove ignore a jump.
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "left",
      buttons: 1,
    });
    await moveCursor(target, x, y);
  }
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: to.x,
    y: to.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  return {};
}

async function press(tabId, backendNodeId, key) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  const combo = parseKey(key);
  if (!combo) {
    return fail(
      "invalid_input",
      `Unknown key "${key}". Try Enter, Tab, Escape, ArrowDown, or Control+a.`,
    );
  }
  const target = { tabId };
  if (typeof backendNodeId === "number") await clickNode(target, backendNodeId);
  const base = {
    key: combo.key,
    code: combo.code,
    windowsVirtualKeyCode: combo.windowsVirtualKeyCode,
    nativeVirtualKeyCode: combo.windowsVirtualKeyCode,
    modifiers: combo.modifiers,
  };
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    ...base,
    type: combo.text ? "keyDown" : "rawKeyDown",
    ...(combo.text ? { text: combo.text } : {}),
  });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    ...base,
    type: "keyUp",
  });
  return {};
}

const SELECT_OPTION_FN = `function (values) {
  if (this.tagName !== "SELECT") throw new Error("Not a <select> element");
  const wanted = new Set(values);
  let matched = 0;
  for (const option of this.options) {
    const hit =
      wanted.has(option.value) ||
      wanted.has(option.label) ||
      wanted.has(option.text);
    option.selected = hit;
    if (hit) matched++;
  }
  if (!matched) throw new Error("No option matched " + JSON.stringify(values));
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return matched;
}`;

async function selectOption(tabId, backendNodeId, values) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  const list = Array.isArray(values) ? values.map(String) : [];
  if (!list.length) return fail("invalid_input", "values must not be empty");
  const selected = await callOnNode({ tabId }, backendNodeId, SELECT_OPTION_FN, [
    list,
  ]);
  return { selected };
}

async function uploadFile(tabId, backendNodeId, paths) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  const files = Array.isArray(paths) ? paths.map(String) : [];
  if (!files.length) return fail("invalid_input", "paths must not be empty");
  if (files.some((f) => !f.startsWith("/"))) {
    return fail("invalid_input", "file paths must be absolute");
  }
  await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", {
    backendNodeId,
    files,
  });
  return { files };
}

async function historyGo(tabId, direction) {
  const tab = await getTab(tabId);
  if (!tab) return fail("no_tab", `Tab ${tabId} not found`);
  const pending = waitComplete(tabId, NAVIGATE_TIMEOUT_MS);
  try {
    if (direction === "back") await chrome.tabs.goBack(tabId);
    else await chrome.tabs.goForward(tabId);
  } catch (e) {
    pending.cancel();
    return fail("invalid_input", (e && e.message) || `Cannot go ${direction}`);
  }

  // goBack/goForward is a no-op when there is nowhere to go, and SPAs often
  // change history without a load. Waiting the full navigation timeout made
  // those cases look hung for 30s.
  const idle = new Promise((resolve) => setTimeout(resolve, HISTORY_IDLE_MS));
  const raced = await Promise.race([
    pending.then((loaded) => ({ kind: "loaded", loaded })).catch((e) => ({ kind: "error", e })),
    idle.then(() => ({ kind: "idle" })),
  ]);
  if (raced.kind === "loaded") return tabResult(raced.loaded);
  if (raced.kind === "error") {
    if (raced.e && raced.e.code === "timeout") return fail("timeout", raced.e.message);
    return fail("no_tab", (raced.e && raced.e.message) || `Tab ${tabId} not found`);
  }

  const now = await getTab(tabId);
  if (now && now.status !== "loading") {
    pending.cancel();
    return tabResult(now);
  }
  try {
    return tabResult(await pending);
  } catch (e) {
    if (e && e.code === "timeout") return fail("timeout", e.message);
    return fail("no_tab", (e && e.message) || `Tab ${tabId} not found`);
  }
}

async function reload(tabId) {
  const tab = await getTab(tabId);
  if (!tab) return fail("no_tab", `Tab ${tabId} not found`);
  const pending = waitComplete(tabId, NAVIGATE_TIMEOUT_MS);
  try {
    await chrome.tabs.reload(tabId);
  } catch (e) {
    pending.cancel();
    return fail("no_tab", (e && e.message) || `Tab ${tabId} not found`);
  }
  try {
    return tabResult(await pending);
  } catch (e) {
    if (e && e.code === "timeout") return fail("timeout", e.message);
    return fail("no_tab", (e && e.message) || `Tab ${tabId} not found`);
  }
}

async function evaluate(tabId, expression) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  if (typeof expression !== "string" || !expression.trim()) {
    return fail("invalid_input", "expression must be a non-empty string");
  }
  // Wrapped so the caller can write either an expression or a statement body.
  const value = await evalInPage(
    { tabId },
    `(async () => { return (${expression}); })()`,
  );
  return { value: value === undefined ? null : value };
}

async function resizeWindow(tabId, width, height) {
  const tab = await getTab(tabId);
  if (!tab) return fail("no_tab", `Tab ${tabId} not found`);
  const want = { width: Math.round(width), height: Math.round(height) };
  if (!(want.width > 0 && want.height > 0)) {
    return fail("invalid_input", "width and height must be positive");
  }
  await chrome.windows.update(tab.windowId, {
    state: "normal",
    width: want.width,
    height: want.height,
  });

  // Window bounds include the browser chrome, so correct once against the
  // viewport the page actually sees.
  const measure = async () => {
    const ready = await ensureAttached(tabId);
    if (isHandleError(ready)) return null;
    const metrics = await chrome.debugger.sendCommand(
      { tabId },
      "Page.getLayoutMetrics",
      {},
    );
    return viewportFromMetrics(metrics);
  };

  let viewport = await measure();
  if (viewport && (viewport.width !== want.width || viewport.height !== want.height)) {
    const win = await chrome.windows.get(tab.windowId);
    await chrome.windows.update(tab.windowId, {
      width: win.width + (want.width - viewport.width),
      height: win.height + (want.height - viewport.height),
    });
    viewport = (await measure()) || viewport;
  }
  return {
    width: viewport ? viewport.width : want.width,
    height: viewport ? viewport.height : want.height,
  };
}

async function pageText(tabId, maxChars) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  const cap =
    typeof maxChars === "number" && maxChars > 0
      ? Math.min(maxChars, TEXT_HARD_CAP)
      : TEXT_DEFAULT_CAP;
  const text = await evalInPage(
    { tabId },
    "(document.body && document.body.innerText) || document.documentElement.innerText || ''",
  );
  const full = typeof text === "string" ? text : "";
  return { text: full.slice(0, cap), truncated: full.length > cap };
}

async function waitFor(tabId, text, textGone, timeoutMs) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  if (!text && !textGone) {
    return fail("invalid_input", "waitFor needs text or textGone");
  }
  const budget =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? Math.min(timeoutMs, NAVIGATE_TIMEOUT_MS)
      : 10000;
  const started = Date.now();
  const needle = JSON.stringify(String(text || textGone));
  const expression = `((document.body && document.body.innerText) || "").includes(${needle})`;

  while (Date.now() - started < budget) {
    let present = false;
    try {
      present = Boolean(await evalInPage({ tabId }, expression));
    } catch {
      // page mid-navigation: try again on the next tick
    }
    if (text ? present : !present) {
      return { waitedMs: Date.now() - started, matched: true };
    }
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
  return fail(
    "timeout",
    text
      ? `Timed out waiting for "${text}" after ${budget}ms`
      : `Timed out waiting for "${textGone}" to disappear after ${budget}ms`,
  );
}

async function readConsole(tabId, level, limit) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  const state = attached.get(tabId);
  let messages = state ? state.consoleBuf.slice() : [];
  if (level != null && level !== "") {
    const want = consoleLevel(level);
    messages = messages.filter((m) => m.level === want);
  }
  return { messages: tail(messages, limit) };
}

async function readNetwork(tabId, urlContains, status, limit) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  const state = attached.get(tabId);
  let requests = state ? state.networkBuf.slice() : [];
  if (typeof urlContains === "string" && urlContains !== "") {
    requests = requests.filter((r) => String(r.url).includes(urlContains));
  }
  if (typeof status === "number") {
    requests = requests.filter((r) => r.status === status);
  }
  return { requests: tail(requests, limit) };
}

async function handle(msg) {
  const method = msg.method;
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  switch (method) {
    case "tabs":
      return listTabs();
    case "newTab":
      return newTab(params.url);
    case "page":
      return page(params.tabId);
    case "navigate":
      return navigate(params.tabId, params.url);
    case "screenshot":
      return screenshot(params.tabId);
    case "snapshot":
      return snapshot(params.tabId);
    case "click":
      return click(params.tabId, params.backendNodeId);
    case "type":
      return typeIn(params.tabId, params.backendNodeId, params.text, params.submit);
    case "fill":
      return fill(params.tabId, params.backendNodeId, params.value);
    case "scroll":
      return scroll(
        params.tabId,
        params.backendNodeId,
        params.direction,
        params.amount,
      );
    case "cursor":
      return setCursor(params.tabId, params.show);
    case "closeTab":
      return closeTab(params.tabId);
    case "hover":
      return hover(params.tabId, params.backendNodeId);
    case "drag":
      return drag(params.tabId, params.backendNodeId, params.toBackendNodeId);
    case "press":
      return press(params.tabId, params.backendNodeId, params.key);
    case "selectOption":
      return selectOption(params.tabId, params.backendNodeId, params.values);
    case "uploadFile":
      return uploadFile(params.tabId, params.backendNodeId, params.paths);
    case "back":
      return historyGo(params.tabId, "back");
    case "forward":
      return historyGo(params.tabId, "forward");
    case "reload":
      return reload(params.tabId);
    case "evaluate":
      return evaluate(params.tabId, params.expression);
    case "resize":
      return resizeWindow(params.tabId, params.width, params.height);
    case "text":
      return pageText(params.tabId, params.maxChars);
    case "find":
      return find(params.tabId, params.text, params.role);
    case "waitFor":
      return waitFor(
        params.tabId,
        params.text,
        params.textGone,
        params.timeoutMs,
      );
    case "console":
      return readConsole(params.tabId, params.level, params.limit);
    case "network":
      return readNetwork(
        params.tabId,
        params.urlContains,
        params.status,
        params.limit,
      );
    default:
      return fail("debugger_failed", "unknown method " + method);
  }
}

function isHandleError(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    value.result === undefined
  );
}

function sendResponse(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function onSocketMessage(socket, event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object" || !msg.method) return;

  Promise.resolve(handle(msg))
    .then((result) => {
      if (isHandleError(result)) {
        sendResponse(socket, { id: msg.id, ok: false, error: result });
        return;
      }
      sendResponse(socket, { id: msg.id, ok: true, result: result ?? {} });
    })
    .catch((err) => {
      sendResponse(socket, {
        id: msg.id,
        ok: false,
        error: {
          code: (err && err.code) || "debugger_failed",
          message: (err && err.message) || String(err),
        },
      });
    });
}

function openSocket(port) {
  if (ws) {
    const prev = ws;
    ws = null;
    try {
      prev.close();
    } catch {
      // ignore
    }
  }

  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws = socket;

  socket.addEventListener("open", () => {
    if (ws !== socket) return;
    connected = true;
    bridgePort = port;
    reconnectDelay = RECONNECT_START_MS;
    buildHello()
      .catch(() => ({
        type: "hello",
        extensionVersion: EXTENSION_VERSION,
        browserName: "Chrome",
      }))
      .then((hello) => {
        if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify(hello));
      });
  });

  socket.addEventListener("message", (event) => {
    if (ws !== socket) return;
    onSocketMessage(socket, event);
  });

  socket.addEventListener("close", () => {
    if (ws !== socket) return;
    connected = false;
    bridgePort = null;
    ws = null;
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    if (ws !== socket) return;
    try {
      socket.close();
    } catch {
      // close handler schedules reconnect
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer != null) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_CAP_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

async function connect() {
  if (connected || connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  connecting = true;
  try {
    const port = await findBridge();
    if (port == null) {
      scheduleReconnect();
      return;
    }
    openSocket(port);
  } catch {
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

chrome.debugger.onEvent.addListener(onDebuggerEvent);

// The user can end a debugging session from Chrome's banner. Forget the tab so
// the next command re-attaches instead of talking to a session that is gone.
chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId != null) attached.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  chrome.debugger.detach({ tabId }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "getStatus") {
    sendResponse({
      connected,
      port: bridgePort,
      attachedTabs: attached.size,
      version: EXTENSION_VERSION,
      browserName,
    });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "grok-reconnect" && !connected) {
    connect();
  }
});

function start() {
  chrome.alarms.create("grok-reconnect", { periodInMinutes: 0.5 });
  connect();
}

chrome.runtime.onInstalled.addListener(start);
start();
