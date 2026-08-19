const PORTS = [];
for (let p = 17352; p <= 17361; p++) PORTS.push(p);

const HELLO = { type: "hello", extensionVersion: "0.1.0" };
const RECONNECT_START_MS = 300;
const RECONNECT_CAP_MS = 5000;
const HEALTH_TIMEOUT_MS = 200;
const NAVIGATE_TIMEOUT_MS = 30000;
const SCROLL_TICK_PX = 360;
const CONSOLE_MAX = 500;
const NETWORK_MAX = 200;
const BUFFER_LIMIT_DEFAULT = 100;
const BLOCKED_SCHEMES = new Set(["chrome:", "chrome-extension:", "edge:"]);
const WEBSTORE_HOSTS = new Set([
  "chrome.google.com",
  "chromewebstore.google.com",
]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "tab",
  "heading",
  "searchbox",
]);
const attached = new Map();

let connected = false;
let ws = null;
let connecting = false;
let reconnectDelay = RECONNECT_START_MS;
let reconnectTimer = null;

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
    url: tab.url || "",
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
  return tabResult(tab);
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
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (e) {
    if (!String(e).includes("already attached")) {
      throw Object.assign(new Error(String(e)), { code: "debugger_failed" });
    }
  }
  if (!attached.has(tabId)) {
    attached.set(tabId, {
      consoleBuf: [],
      networkBuf: [],
      requests: new Map(),
    });
  }
  await chrome.debugger.sendCommand(target, "Page.enable", {});
  await chrome.debugger.sendCommand(target, "DOM.enable", {});
  await chrome.debugger.sendCommand(target, "Runtime.enable", {});
  await chrome.debugger.sendCommand(target, "Console.enable", {});
  await chrome.debugger.sendCommand(target, "Network.enable", {});
  await chrome.debugger.sendCommand(target, "Accessibility.enable", {});
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
      level: p.type,
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

function axString(ax) {
  if (!ax || ax.value == null) return "";
  return String(ax.value);
}

function flattenAx(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map();
  for (const node of list) {
    if (node && node.nodeId != null) byId.set(node.nodeId, node);
  }
  const out = [];
  const seen = new Set();

  function consider(node) {
    if (!node || node.ignored) return;
    if (node.backendDOMNodeId == null) return;
    const roleRaw = axString(node.role);
    const role = roleRaw.toLowerCase();
    const name = axString(node.name).trim();
    if (!name && !INTERACTIVE_ROLES.has(role)) return;
    if (!name && role === "generic") return;
    out.push({
      role: roleRaw || "generic",
      name,
      backendNodeId: node.backendDOMNodeId,
    });
  }

  function walk(node) {
    if (!node || seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    consider(node);
    for (const childId of node.childIds || []) {
      walk(byId.get(childId));
    }
  }

  const roots = list.filter((n) => n && (n.parentId == null || !byId.has(n.parentId)));
  for (const root of roots.length ? roots : list) walk(root);
  for (const node of list) {
    if (node && !seen.has(node.nodeId)) walk(node);
  }
  return out;
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

async function snapshot(tabId) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  const target = { tabId };
  const tree = await chrome.debugger.sendCommand(target, "Accessibility.getFullAXTree", {});
  const nodes = flattenAx(tree && tree.nodes);
  const refs = {};
  const lines = [];
  for (let i = 0; i < nodes.length; i++) {
    const ref = "e" + (i + 1);
    const node = nodes[i];
    refs[ref] = { backendNodeId: node.backendNodeId };
    lines.push(
      node.name ? `[${ref}] ${node.role} "${node.name}"` : `[${ref}] ${node.role}`,
    );
  }
  return { text: lines.join("\n"), refs };
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

async function readConsole(tabId, level, limit) {
  const ready = await ensureAttached(tabId);
  if (isHandleError(ready)) return ready;
  const state = attached.get(tabId);
  let messages = state ? state.consoleBuf.slice() : [];
  if (level != null && level !== "") {
    messages = messages.filter((m) => m.level === level);
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
    reconnectDelay = RECONNECT_START_MS;
    socket.send(JSON.stringify(HELLO));
  });

  socket.addEventListener("message", (event) => {
    if (ws !== socket) return;
    onSocketMessage(socket, event);
  });

  socket.addEventListener("close", () => {
    if (ws !== socket) return;
    connected = false;
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

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  chrome.debugger.detach({ tabId }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "getStatus") {
    sendResponse({ connected });
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
