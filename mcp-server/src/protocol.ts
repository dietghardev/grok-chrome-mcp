export const PORT_START = 17352;
export const PORT_END = 17361;
export const BRIDGE_HOST = "127.0.0.1";
export const COMMAND_TIMEOUT_MS = 30_000;
export const RECONNECT_WAIT_MS = 2_000;

export type WsRequest = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

export type WsSuccess = { id: string; ok: true; result: Record<string, unknown> };
export type WsFailure = {
  id: string;
  ok: false;
  error: { code: string; message: string };
};
export type WsResponse = WsSuccess | WsFailure;
export type HelloMessage = {
  type: "hello";
  extensionVersion: string;
  browserId?: string;
  browserName?: string;
};

export type BrowserClient = {
  id: string;
  name: string;
  version: string;
  active: boolean;
};

export function isHello(value: unknown): value is HelloMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "hello" && typeof v.extensionVersion === "string";
}

export type Bridge = {
  port: number;
  clients(): BrowserClient[];
  select(browserId: string): boolean;
  activeBrowserId(): string | null;
  onBrowserGone(fn: (browserId: string) => void): void;
  send(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<WsResponse>;
  isConnected(): boolean;
  waitForConnection(ms?: number): Promise<boolean>;
  close(): Promise<void>;
};
