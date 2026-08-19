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
  type WsFailure,
  type WsRequest,
  type WsResponse,
} from "./protocol.js";

const DISCONNECTED_MESSAGE =
  "Load the unpacked Grok Chrome extension and keep Chrome open.";

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

  const wss = new WebSocketServer({ server, path: "/ws" });

  let port: number | undefined;
  for (let candidate = PORT_START; candidate <= PORT_END; candidate++) {
    try {
      await listen(server, candidate);
      port = candidate;
      break;
    } catch (err) {
      if (!isAddrInUse(err)) {
        wss.close();
        server.close();
        throw err;
      }
    }
  }
  if (port === undefined) {
    wss.close();
    server.close();
    throw new Error("bridge_bind_failed");
  }

  let socket: WebSocket | null = null;
  const connectionWaiters = new Set<() => void>();
  const pending = new Map<string, (response: WsResponse) => void>();

  const isConnected = () => socket?.readyState === WebSocket.OPEN;

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

  const settle = (id: string, response: WsResponse) => {
    const resolve = pending.get(id);
    if (!resolve) return;
    pending.delete(id);
    resolve(response);
  };

  wss.on("connection", (next) => {
    if (socket && socket !== next) socket.close();
    socket = next;
    for (const waiter of connectionWaiters) waiter();
    connectionWaiters.clear();

    next.on("message", (data) => {
      const msg = parseMessage(data);
      if (isHello(msg)) return;
      if (!msg || typeof msg !== "object") return;
      const id = (msg as { id?: unknown }).id;
      if (typeof id !== "string") return;
      settle(id, msg as WsResponse);
    });

    next.on("close", () => {
      if (socket === next) socket = null;
    });

    next.on("error", () => {});
  });

  const send = async (
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<WsResponse> => {
    const id = crypto.randomUUID();
    if (!isConnected()) {
      await waitForConnection(RECONNECT_WAIT_MS);
    }
    const current = socket;
    if (!current || current.readyState !== WebSocket.OPEN) {
      return failure(id, "extension_disconnected", DISCONNECTED_MESSAGE);
    }
    const request: WsRequest = { id, method, params: params ?? {} };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        settle(id, failure(id, "timeout", "Timed out waiting for extension response."));
      }, timeoutMs);
      pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      current.send(JSON.stringify(request));
    });
  };

  const close = async (): Promise<void> => {
    for (const [id] of pending) {
      settle(id, failure(id, "extension_disconnected", DISCONNECTED_MESSAGE));
    }
    if (socket) {
      socket.close();
      socket = null;
    }
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return { port, send, isConnected, waitForConnection, close };
}
