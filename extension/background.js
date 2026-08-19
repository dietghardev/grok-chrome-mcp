const PORTS = [];
for (let p = 17352; p <= 17361; p++) PORTS.push(p);

const HELLO = { type: "hello", extensionVersion: "0.1.0" };
const RECONNECT_START_MS = 300;
const RECONNECT_CAP_MS = 5000;
const HEALTH_TIMEOUT_MS = 200;

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

async function handle(msg) {
  const method = msg.method;
  return { code: "debugger_failed", message: "unknown method " + method };
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
