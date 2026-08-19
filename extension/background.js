const PORTS = [];
for (let p = 17352; p <= 17361; p++) PORTS.push(p);

const HELLO = { type: "hello", extensionVersion: "0.1.0" };
const RECONNECT_START_MS = 300;
const RECONNECT_CAP_MS = 5000;
const HEALTH_TIMEOUT_MS = 200;
const NAVIGATE_TIMEOUT_MS = 30000;
const BLOCKED_SCHEMES = new Set(["chrome:", "chrome-extension:", "edge:"]);
const WEBSTORE_HOSTS = new Set([
  "chrome.google.com",
  "chromewebstore.google.com",
]);

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
