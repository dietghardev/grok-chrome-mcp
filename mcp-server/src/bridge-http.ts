import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { ErrorCode } from "./errors.js";
import {
  BRIDGE_HOST,
  COMMAND_TIMEOUT_MS,
  isHello,
  PORT_END,
  PORT_START,
  RECONNECT_WAIT_MS,
  type Bridge,
  type BrowserClient,
  type WsFailure,
  type WsRequest,
  type WsResponse,
} from "./protocol.js";

const DISCONNECTED_MESSAGE =
  "Load the unpacked Grok Chrome extension and keep Chrome open.";

type Client = {
  id: string;
  name: string;
  version: string;
  socket: WebSocket;
  /** Command ids this client owes a response for. */
  inFlight: Set<string>;
};

function failure(id: string, code: ErrorCode, message: string): WsFailure {
  return { id, ok: false, error: { code, message } };
}

function isAddrInUse(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, BRIDGE_HOST);
  });
}

function parseMessage(data: unknown): unknown {
  try {
    return JSON.parse(String(data));
  } catch {
    return undefined;
  }
}

export async function startBridge(): Promise<Bridge> {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", `http://${BRIDGE_HOST}`).pathname;
    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ ok: true, name: "grok-chrome", pid: process.pid }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // Bind first, attach the WebSocket server after. ws forwards the http
  // server's "error" event to itself, and an EADDRINUSE with no listener on
  // the WebSocketServer takes the whole process down instead of letting us
  // try the next port in the range.
  let port: number | undefined;
  for (let candidate = PORT_START; candidate <= PORT_END; candidate++) {
    try {
      await listen(server, candidate);
      port = candidate;
      break;
    } catch (err) {
      if (!isAddrInUse(err)) {
        server.close();
        throw err;
      }
    }
  }
  if (port === undefined) {
    server.close();
    throw new Error("bridge_bind_failed");
  }

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("error", () => {});

  const clients = new Map<string, Client>();
  const bySocket = new Map<WebSocket, Client>();
  const pending = new Map<string, (response: WsResponse) => void>();
  const connectionWaiters = new Set<() => void>();
  let activeId: string | null = null;
  let anonCounter = 0;
  let onDisconnect: ((browserId: string) => void) | undefined;

  const activeClient = (): Client | null => {
    if (activeId) {
      const hit = clients.get(activeId);
      if (hit && hit.socket.readyState === WebSocket.OPEN) return hit;
    }
    for (const client of clients.values()) {
      if (client.socket.readyState === WebSocket.OPEN) {
        activeId = client.id;
        return client;
      }
    }
    activeId = null;
    return null;
  };

  const isConnected = () => activeClient() !== null;

  const releaseWaiters = () => {
    for (const waiter of connectionWaiters) waiter();
    connectionWaiters.clear();
  };

  const settle = (id: string, response: WsResponse) => {
    const resolve = pending.get(id);
    if (!resolve) return;
    pending.delete(id);
    resolve(response);
  };

  /** Only this client's commands die; other browsers keep working. */
  const failClientPending = (client: Client) => {
    for (const id of [...client.inFlight]) {
      client.inFlight.delete(id);
      settle(id, failure(id, "extension_disconnected", DISCONNECTED_MESSAGE));
    }
  };

  const dropClient = (client: Client) => {
    if (clients.get(client.id) === client) clients.delete(client.id);
    bySocket.delete(client.socket);
    failClientPending(client);
    if (activeId === client.id) activeId = null;
    onDisconnect?.(client.id);
  };

  const rekey = (client: Client, nextId: string) => {
    if (client.id === nextId) return;
    const existing = clients.get(nextId);
    if (existing && existing !== client) {
      // Same browser reconnecting (extension reload / worker restart).
      clients.delete(existing.id);
      bySocket.delete(existing.socket);
      failClientPending(existing);
      try {
        existing.socket.close();
      } catch {
        // already closing
      }
    }
    clients.delete(client.id);
    if (activeId === client.id) activeId = nextId;
    client.id = nextId;
    clients.set(nextId, client);
  };

  wss.on("connection", (socket) => {
    const client: Client = {
      id: `anon-${++anonCounter}`,
      name: "Unknown",
      version: "",
      socket,
      inFlight: new Set(),
    };
    clients.set(client.id, client);
    bySocket.set(socket, client);
    if (!activeId) activeId = client.id;
    releaseWaiters();

    socket.on("message", (data) => {
      const msg = parseMessage(data);
      if (isHello(msg)) {
        client.version = msg.extensionVersion;
        if (msg.browserName) client.name = msg.browserName;
        if (msg.browserId) rekey(client, msg.browserId);
        releaseWaiters();
        return;
      }
      if (!msg || typeof msg !== "object") return;
      const id = (msg as { id?: unknown }).id;
      if (typeof id !== "string") return;
      client.inFlight.delete(id);
      settle(id, msg as WsResponse);
    });

    socket.on("close", () => dropClient(client));
    socket.on("error", () => {});
  });

  const waitForConnection = (ms = RECONNECT_WAIT_MS): Promise<boolean> => {
    if (isConnected()) return Promise.resolve(true);
    if (ms <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter = () => {
        cleanup();
        resolve(true);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(isConnected());
      }, ms);
      const cleanup = () => {
        clearTimeout(timer);
        connectionWaiters.delete(waiter);
      };
      connectionWaiters.add(waiter);
    });
  };

  const send = async (
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<WsResponse> => {
    const id = crypto.randomUUID();
    if (!isConnected()) await waitForConnection(RECONNECT_WAIT_MS);
    const client = activeClient();
    if (!client) {
      return failure(id, "extension_disconnected", DISCONNECTED_MESSAGE);
    }
    const request: WsRequest = { id, method, params: params ?? {} };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        client.inFlight.delete(id);
        settle(
          id,
          failure(id, "timeout", `Timed out after ${timeoutMs}ms waiting for ${method}.`),
        );
      }, timeoutMs);
      pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      client.inFlight.add(id);
      try {
        client.socket.send(JSON.stringify(request));
      } catch {
        client.inFlight.delete(id);
        settle(id, failure(id, "extension_disconnected", DISCONNECTED_MESSAGE));
      }
    });
  };

  const close = async (): Promise<void> => {
    for (const client of [...clients.values()]) {
      failClientPending(client);
      try {
        client.socket.close();
      } catch {
        // already closing
      }
    }
    clients.clear();
    bySocket.clear();
    activeId = null;
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };

  const list = (): BrowserClient[] => {
    const active = activeClient();
    return [...clients.values()].map((c) => ({
      id: c.id,
      name: c.name,
      version: c.version,
      active: active !== null && c.id === active.id,
    }));
  };

  const select = (browserId: string): boolean => {
    const hit = clients.get(browserId);
    if (!hit || hit.socket.readyState !== WebSocket.OPEN) return false;
    activeId = browserId;
    return true;
  };

  return {
    port,
    send,
    isConnected,
    waitForConnection,
    close,
    clients: list,
    select,
    activeBrowserId: () => activeClient()?.id ?? null,
    onBrowserGone: (fn) => {
      onDisconnect = fn;
    },
  };
}
