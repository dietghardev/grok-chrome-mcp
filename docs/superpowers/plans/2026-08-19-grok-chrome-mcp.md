# Grok Chrome MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grok Build drives the user's existing Chrome via an unpacked MV3 extension and a localhost MCP WebSocket bridge.

**Architecture:** Grok spawns `mcp-server` over stdio. The server binds `127.0.0.1:17352–17361`, serves `GET /health` and `WS /ws`, and keeps an in-memory origin allowlist. The extension probes that port range, connects, and runs CDP through `chrome.debugger` on tabs Grok opened.

**Tech Stack:** Node 20+, TypeScript, `@modelcontextprotocol/sdk`, `ws`, `zod`, `vitest`, `tsx`. Extension is vanilla MV3 JS (no bundler).

**Spec:** `docs/superpowers/specs/2026-08-19-grok-chrome-mcp-design.md`

## Global Constraints

- Bind host is exactly `127.0.0.1`. Ports tried in order: `17352` through `17361`.
- Health JSON: `{"ok":true,"name":"grok-chrome","pid":<number>}`. WebSocket path: `/ws`.
- Origin = `new URL(value).origin`. `localhost` ≠ `127.0.0.1`; ports are distinct grants.
- Mutating tools (`chrome_new_tab` with URL, `chrome_navigate`, `chrome_click`, `chrome_type`, `chrome_fill`, `chrome_scroll`) require a grant; on miss return `needs_permission` and **do not** send a WS command.
- Read-only tools never require a grant; they still refuse blocked origins.
- Error codes (only these): `extension_disconnected`, `bridge_bind_failed`, `no_tab`, `blocked_origin`, `needs_permission`, `invalid_origin`, `stale_ref`, `timeout`, `debugger_failed`.
- Default command timeout: 30000 ms. Reconnect wait before `extension_disconnected`: 2000 ms.
- Grok opens new tabs (group title `Grok`, color `blue` if grouping works). Do not steal the user's current tab.
- Block debugger/navigate on `chrome:`, `chrome-extension:`, `edge:`, Chrome Web Store, and `about:` except `about:blank`.
- Extension permissions only: `debugger`, `tabs`, `tabGroups`, `alarms`, plus `<all_urls>` host access. No `sidePanel`, `downloads`, `nativeMessaging`, `desktopCapture`.
- No side-panel chat. Popup copy is exactly `connected` or `waiting for Grok`.
- Tests: `cd mcp-server && npm test`. Protocol smoke: `cd mcp-server && npm run smoke`. No Chrome required for those.
- Do not edit `~/.grok/config.toml` unless a later task says to; README documents the block.
- Commit after each task. Do not implement later tasks early.

## File map

| File | Responsibility |
|---|---|
| `mcp-server/package.json` | Scripts: `build`, `test`, `smoke`. Deps listed in Task 1. |
| `mcp-server/tsconfig.json` | ESM, Node 20, `rootDir` `src`, `outDir` `dist`. Tests are not compiled to dist. |
| `mcp-server/src/origins.ts` | `parseOrigin`, `isBlockedUrl` |
| `mcp-server/src/session.ts` | Allowlist, target tab, grok tab ids, snapshot refs, serial `enqueue` |
| `mcp-server/src/protocol.ts` | WS request/response/hello types + helpers |
| `mcp-server/src/bridge-http.ts` | Bind port range, `/health`, `/ws`, `send()`, connection state |
| `mcp-server/src/tools.ts` | Tool handlers used by MCP (pure functions over Session + Bridge) |
| `mcp-server/src/index.ts` | Start bridge, write/delete bridge file, register MCP tools, stdio |
| `mcp-server/src/errors.ts` | Shared `ToolResult` / error helpers |
| `mcp-server/test/origins.test.ts` | Origin + blocked tests |
| `mcp-server/test/session.test.ts` | Allowlist + queue tests |
| `mcp-server/test/tools.test.ts` | Grant gates; `needs_permission` must not call bridge |
| `mcp-server/test/smoke.ts` | Fake-extension WS client |
| `mcp-server/fixture/index.html` | Login-fail page for the manual pass |
| `extension/manifest.json` | MV3 |
| `extension/background.js` | Probe, WS, CDP methods, buffers |
| `extension/popup.html` / `popup.js` | Status only |
| `extension/icons/icon16.png` (etc.) | Minimal solid icons |
| `README.md` | Install steps |
| `.gitignore` | `node_modules`, `dist`, OS junk |

---

### Task 1: Origins + repo scaffold

**Files:**
- Create: `mcp-server/package.json`
- Create: `mcp-server/tsconfig.json`
- Create: `mcp-server/src/origins.ts`
- Create: `mcp-server/src/errors.ts`
- Create: `mcp-server/test/origins.test.ts`
- Create: `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `export type ErrorCode = "extension_disconnected" | "bridge_bind_failed" | "no_tab" | "blocked_origin" | "needs_permission" | "invalid_origin" | "stale_ref" | "timeout" | "debugger_failed"`
  - `export type ToolError = { ok: false; code: ErrorCode; message: string; origin?: string }`
  - `export type ToolOk<T extends object> = { ok: true } & T`
  - `export type ToolResult<T extends object> = ToolOk<T> | ToolError`
  - `export function fail(code: ErrorCode, message: string, extra?: { origin?: string }): ToolError`
  - `export function parseOrigin(input: string): ToolResult<{ origin: string }>`
  - `export function isBlockedUrl(url: string): boolean`

- [ ] **Step 1: Write `mcp-server/package.json` and `tsconfig.json`**

`package.json`:

```json
{
  "name": "grok-chrome-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "smoke": "tsx test/smoke.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.17.0",
    "ws": "^8.18.3",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/node": "^22.13.10",
    "@types/ws": "^8.18.0",
    "tsx": "^4.19.3",
    "typescript": "^5.8.2",
    "vitest": "^3.0.9"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*.ts"]
}
```

`.gitignore` at repo root:

```
node_modules/
dist/
.DS_Store
*.log
.superpowers/
```

- [ ] **Step 2: Write the failing tests**

`mcp-server/test/origins.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isBlockedUrl, parseOrigin } from "../src/origins.js";

describe("parseOrigin", () => {
  it("parses a URL into origin", () => {
    const r = parseOrigin("https://github.com/xai-org/grok-build");
    expect(r).toEqual({ ok: true, origin: "https://github.com" });
  });

  it("accepts an origin string", () => {
    const r = parseOrigin("http://localhost:3000");
    expect(r).toEqual({ ok: true, origin: "http://localhost:3000" });
  });

  it("treats localhost and 127.0.0.1 as different", () => {
    const a = parseOrigin("http://localhost:3000");
    const b = parseOrigin("http://127.0.0.1:3000");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.origin).not.toBe(b.origin);
  });

  it("treats different ports as different", () => {
    const a = parseOrigin("http://localhost:3000");
    const b = parseOrigin("http://localhost:5173");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.origin).not.toBe(b.origin);
  });

  it("returns invalid_origin for garbage", () => {
    const r = parseOrigin("not a url");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_origin");
  });
});

describe("isBlockedUrl", () => {
  it("blocks chrome, extension, edge, and web store", () => {
    expect(isBlockedUrl("chrome://extensions")).toBe(true);
    expect(isBlockedUrl("chrome-extension://abcdef/popup.html")).toBe(true);
    expect(isBlockedUrl("edge://settings")).toBe(true);
    expect(isBlockedUrl("https://chrome.google.com/webstore/detail/x")).toBe(true);
    expect(isBlockedUrl("https://chromewebstore.google.com/detail/x")).toBe(true);
  });

  it("blocks about: except about:blank", () => {
    expect(isBlockedUrl("about:blank")).toBe(false);
    expect(isBlockedUrl("about:config")).toBe(true);
  });

  it("allows http(s)", () => {
    expect(isBlockedUrl("http://localhost:3000/login")).toBe(false);
    expect(isBlockedUrl("https://github.com")).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd mcp-server && npm install && npx vitest run test/origins.test.ts
```

Expected: FAIL — cannot find `../src/origins.js`.

- [ ] **Step 4: Implement `errors.ts` and `origins.ts`**

`mcp-server/src/errors.ts`:

```ts
export type ErrorCode =
  | "extension_disconnected"
  | "bridge_bind_failed"
  | "no_tab"
  | "blocked_origin"
  | "needs_permission"
  | "invalid_origin"
  | "stale_ref"
  | "timeout"
  | "debugger_failed";

export type ToolError = {
  ok: false;
  code: ErrorCode;
  message: string;
  origin?: string;
};

export type ToolOk<T extends object> = { ok: true } & T;
export type ToolResult<T extends object> = ToolOk<T> | ToolError;

export function fail(
  code: ErrorCode,
  message: string,
  extra?: { origin?: string },
): ToolError {
  return { ok: false, code, message, ...extra };
}
```

`mcp-server/src/origins.ts`:

```ts
import { fail, type ToolResult } from "./errors.js";

const BLOCKED_SCHEMES = new Set(["chrome:", "chrome-extension:", "edge:"]);
const WEBSTORE_HOSTS = new Set([
  "chrome.google.com",
  "chromewebstore.google.com",
]);

export function parseOrigin(input: string): ToolResult<{ origin: string }> {
  try {
    const url = input.includes("://") ? new URL(input) : new URL(`http://${input}`);
    if (!url.hostname) return fail("invalid_origin", `Cannot parse origin: ${input}`);
    if (!input.includes("://") && !input.startsWith("http")) {
      return fail("invalid_origin", `Cannot parse origin: ${input}`);
    }
    return { ok: true, origin: new URL(input).origin };
  } catch {
    return fail("invalid_origin", `Cannot parse origin: ${input}`);
  }
}

export function isBlockedUrl(url: string): boolean {
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
```

Keep `parseOrigin` strict: only `new URL(input)` — do **not** prepend `http://` for garbage. `"not a url"` must fail. `"http://localhost:3000"` and `"https://github.com/xai-org/grok-build"` succeed.

- [ ] **Step 5: Run tests**

```bash
cd mcp-server && npx vitest run test/origins.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .gitignore mcp-server/package.json mcp-server/package-lock.json mcp-server/tsconfig.json mcp-server/src/errors.ts mcp-server/src/origins.ts mcp-server/test/origins.test.ts
git commit -m "feat: add origin parsing and blocked-URL checks"
```

---

### Task 2: Session allowlist, target tab, serial queue

**Files:**
- Create: `mcp-server/src/session.ts`
- Create: `mcp-server/test/session.test.ts`

**Interfaces:**
- Consumes: `parseOrigin`, `ToolResult`, `fail` from Task 1
- Produces:
  - `export type SnapshotRef = { backendNodeId: number }`
  - `export class Session` with:
    - `grant(input: string): ToolResult<{ granted: string[] }>`
    - `isGranted(origin: string): boolean`
    - `get granted(): string[]`
    - `requireGrant(origin: string): ToolResult<Record<string, never>>`
    - `targetTabId: number | null`
    - `markGrokTab(tabId: number): void`
    - `isGrokTab(tabId: number): boolean`
    - `unmarkGrokTab(tabId: number): void`
    - `clearTargetIf(tabId: number): void`
    - `rememberSnapshot(tabId: number, refs: Map<string, SnapshotRef>): void`
    - `lookupRef(tabId: number, ref: string): ToolResult<SnapshotRef>`
    - `enqueue<T>(fn: () => Promise<T>): Promise<T>`

- [ ] **Step 1: Write the failing tests**

`mcp-server/test/session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Session } from "../src/session.js";

describe("Session grants", () => {
  it("stores URL.origin and lists the allowlist", () => {
    const s = new Session();
    const r = s.grant("https://github.com/foo");
    expect(r).toEqual({ ok: true, granted: ["https://github.com"] });
    expect(s.isGranted("https://github.com")).toBe(true);
    expect(s.isGranted("http://localhost:3000")).toBe(false);
  });

  it("does not treat different ports as granted", () => {
    const s = new Session();
    s.grant("http://localhost:3000");
    expect(s.requireGrant("http://localhost:5173").ok).toBe(false);
    const denied = s.requireGrant("http://localhost:5173");
    if (!denied.ok) {
      expect(denied.code).toBe("needs_permission");
      expect(denied.origin).toBe("http://localhost:5173");
    }
    expect(s.requireGrant("http://localhost:3000").ok).toBe(true);
  });

  it("returns invalid_origin on garbage grant", () => {
    const s = new Session();
    const r = s.grant("nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_origin");
  });
});

describe("Session snapshot refs", () => {
  it("invalidates old refs after a new snapshot", () => {
    const s = new Session();
    s.rememberSnapshot(1, new Map([["e1", { backendNodeId: 10 }]]));
    expect(s.lookupRef(1, "e1").ok).toBe(true);
    s.rememberSnapshot(1, new Map([["e1", { backendNodeId: 11 }]]));
    const stale = s.lookupRef(1, "e2");
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("stale_ref");
  });
});

describe("Session enqueue", () => {
  it("runs jobs one at a time in order", async () => {
    const s = new Session();
    const order: number[] = [];
    const slow = s.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
      return "a";
    });
    const fast = s.enqueue(async () => {
      order.push(2);
      return "b";
    });
    expect(await Promise.all([slow, fast])).toEqual(["a", "b"]);
    expect(order).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd mcp-server && npx vitest run test/session.test.ts
```

Expected: FAIL — `Session` not found.

- [ ] **Step 3: Implement `session.ts`**

```ts
import { fail, type ToolResult } from "./errors.js";
import { parseOrigin } from "./origins.js";

export type SnapshotRef = { backendNodeId: number };

export class Session {
  private allow = new Set<string>();
  private grokTabs = new Set<number>();
  private snapshots = new Map<number, Map<string, SnapshotRef>>();
  private tail: Promise<unknown> = Promise.resolve();
  targetTabId: number | null = null;

  grant(input: string): ToolResult<{ granted: string[] }> {
    const parsed = parseOrigin(input);
    if (!parsed.ok) return parsed;
    this.allow.add(parsed.origin);
    return { ok: true, granted: this.granted };
  }

  get granted(): string[] {
    return [...this.allow];
  }

  isGranted(origin: string): boolean {
    return this.allow.has(origin);
  }

  requireGrant(origin: string): ToolResult<Record<string, never>> {
    if (this.allow.has(origin)) return { ok: true };
    return fail(
      "needs_permission",
      `Origin ${origin} is not granted. Call chrome_grant_site after the user agrees.`,
      { origin },
    );
  }

  markGrokTab(tabId: number): void {
    this.grokTabs.add(tabId);
  }

  isGrokTab(tabId: number): boolean {
    return this.grokTabs.has(tabId);
  }

  unmarkGrokTab(tabId: number): void {
    this.grokTabs.delete(tabId);
    this.snapshots.delete(tabId);
    this.clearTargetIf(tabId);
  }

  clearTargetIf(tabId: number): void {
    if (this.targetTabId === tabId) this.targetTabId = null;
  }

  rememberSnapshot(tabId: number, refs: Map<string, SnapshotRef>): void {
    this.snapshots.set(tabId, refs);
  }

  lookupRef(tabId: number, ref: string): ToolResult<SnapshotRef> {
    const map = this.snapshots.get(tabId);
    const hit = map?.get(ref);
    if (!hit) return fail("stale_ref", `Ref ${ref} is not from the latest snapshot`);
    return { ok: true, ...hit };
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd mcp-server && npx vitest run test/session.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/session.ts mcp-server/test/session.test.ts
git commit -m "feat: add session allowlist, refs, and serial queue"
```

---

### Task 3: Bridge HTTP + WebSocket + protocol smoke

**Files:**
- Create: `mcp-server/src/protocol.ts`
- Create: `mcp-server/src/bridge-http.ts`
- Create: `mcp-server/test/smoke.ts`

**Interfaces:**
- Consumes: `fail`, `ErrorCode` from Task 1
- Produces:
  - `export const PORT_START = 17352`
  - `export const PORT_END = 17361`
  - `export const BRIDGE_HOST = "127.0.0.1"`
  - `export const COMMAND_TIMEOUT_MS = 30_000`
  - `export const RECONNECT_WAIT_MS = 2_000`
  - `export type WsRequest = { id: string; method: string; params: Record<string, unknown> }`
  - `export type WsSuccess = { id: string; ok: true; result: Record<string, unknown> }`
  - `export type WsFailure = { id: string; ok: false; error: { code: string; message: string } }`
  - `export type WsResponse = WsSuccess | WsFailure`
  - `export type HelloMessage = { type: "hello"; extensionVersion: string }`
  - `export function isHello(value: unknown): value is HelloMessage`
  - `export type Bridge = { port: number; send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<WsResponse>; isConnected(): boolean; waitForConnection(ms?: number): Promise<boolean>; close(): Promise<void> }`
  - `export async function startBridge(): Promise<Bridge>` — throws if all ports taken (caller maps to `bridge_bind_failed`)

For smoke, `send("echo", { n: 1 })` must work. Implement an **echo** method on the server side when the WS client is a test double that replies, not on Chrome. The bridge itself only forwards: it sends the JSON request and waits for a matching `id`. The smoke client answers `echo`.

- [ ] **Step 1: Write `protocol.ts` and `bridge-http.ts`**

`protocol.ts`:

```ts
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
export type HelloMessage = { type: "hello"; extensionVersion: string };

export function isHello(value: unknown): value is HelloMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.type === "hello" && typeof v.extensionVersion === "string";
}
```

`bridge-http.ts` — requirements the implementer must satisfy (write the full file):

- `http.createServer` + `WebSocketServer({ server, path: "/ws" })`.
- Bind `127.0.0.1` only. Loop ports `PORT_START`…`PORT_END`. If `EADDRINUSE`, try next. If none bind, throw `Error("bridge_bind_failed")`.
- `GET /health` → `Content-Type: application/json` body `{"ok":true,"name":"grok-chrome","pid":process.pid}`. Other HTTP paths → 404.
- Track one `WebSocket`. On a new connection, close the previous socket (reload).
- First non-hello message from the extension is ignored unless it is a response to a pending `id`.
- `send(method, params, timeoutMs = COMMAND_TIMEOUT_MS)`:
  - If not connected, `await waitForConnection(RECONNECT_WAIT_MS)`.
  - If still not connected, resolve `{ id, ok: false, error: { code: "extension_disconnected", message: "Load the unpacked Grok Chrome extension and keep Chrome open." } }`.
  - Else send `{ id: crypto.randomUUID(), method, params: params ?? {} }` and wait for a JSON message with that `id`, or timeout `{ ok: false, error: { code: "timeout", message: "..." } }`.
- `waitForConnection(ms)` resolves true if a socket is open, or becomes open within `ms`.
- `close()` closes the WS server and HTTP server.

- [ ] **Step 2: Write `test/smoke.ts`**

```ts
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startBridge } from "../src/bridge-http.js";
import { BRIDGE_HOST, PORT_START } from "../src/protocol.js";

const bridge = await startBridge();
assert.ok(bridge.port >= PORT_START);

const health = await fetch(`http://${BRIDGE_HOST}:${bridge.port}/health`);
const body = await health.json();
assert.equal(body.ok, true);
assert.equal(body.name, "grok-chrome");
assert.equal(typeof body.pid, "number");

const ws = new WebSocket(`ws://${BRIDGE_HOST}:${bridge.port}/ws`);
await new Promise<void>((resolve, reject) => {
  ws.once("open", () => resolve());
  ws.once("error", reject);
});
ws.send(JSON.stringify({ type: "hello", extensionVersion: "0.1.0" }));

ws.on("message", (data) => {
  const msg = JSON.parse(String(data));
  if (msg.method === "echo") {
    ws.send(JSON.stringify({ id: msg.id, ok: true, result: msg.params }));
  }
});

assert.equal(await bridge.waitForConnection(1000), true);

const first = bridge.send("echo", { n: 1 });
const second = bridge.send("echo", { n: 2 });
const [a, b] = await Promise.all([first, second]);
assert.equal(a.ok, true);
assert.equal(b.ok, true);
if (a.ok && b.ok) {
  assert.equal(a.result.n, 1);
  assert.equal(b.result.n, 2);
}

await bridge.close();
ws.close();
console.log("smoke ok");
```

Note: `Promise.all` of two `send`s is allowed at the bridge layer (two in-flight WS ids). Session-level `enqueue` (Task 2) is what serializes tool commands. Do not serialize inside `send`.

- [ ] **Step 3: Run smoke**

```bash
cd mcp-server && npm run smoke
```

Expected: prints `smoke ok` and exits 0.

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/protocol.ts mcp-server/src/bridge-http.ts mcp-server/test/smoke.ts
git commit -m "feat: add localhost health endpoint and websocket bridge"
```

---

### Task 4: Tool handlers + MCP stdio entry

**Files:**
- Create: `mcp-server/src/tools.ts`
- Create: `mcp-server/src/index.ts`
- Create: `mcp-server/test/tools.test.ts`

**Interfaces:**
- Consumes: `Session`, `Bridge`, `parseOrigin`, `isBlockedUrl`, `fail`, `ToolResult`
- Produces: `export function createTools(session: Session, bridge: Bridge)` returning an object of async functions, one per MCP tool. Each returns `ToolResult<...>`.
  - `grantSite(origin: string)`
  - `tabs()`
  - `newTab(url?: string)`
  - `useTab(tabId: number)`
  - `page()`
  - `navigate(url: string)`
  - `screenshot()`
  - `snapshot()`
  - `click(ref: string)`
  - `type(text: string, ref?: string, submit?: boolean)`
  - `fill(ref: string, value: string)`
  - `scroll(direction: "up"|"down"|"left"|"right", ref?: string, amount?: number)`
  - `consoleMessages(level?: string, limit?: number)`
  - `network(urlContains?: string, status?: number, limit?: number)`

**Grant rules (must be in `tools.ts`, before any `bridge.send`):**

- `newTab(url)` if `url` is set: `parseOrigin` → `isBlockedUrl` → `requireGrant`. Fail codes `invalid_origin` / `blocked_origin` / `needs_permission`.
- `navigate(url)`: same.
- `click` / `type` / `fill` / `scroll`: if no `session.targetTabId` → `no_tab`. Else ask the extension for current URL via `bridge.send("page", { tabId })` **only after** we have a target; then `isBlockedUrl` / `requireGrant` on that page origin. Wait: read-only `page` does not need grant. Mutating tools need the **current page origin**. To know the origin they may `send("page")` (read-only). Then `requireGrant`. Then `send("click"|...)`.
- `needs_permission` must happen **before** the mutating `send`. Tests use a fake bridge that records calls.

`createTools` wraps every mutating Chrome call in `session.enqueue`.

For Task 4, implement **all handler logic** including screenshot/snapshot/etc. calling `bridge.send` with these method names (extension implements them in later tasks):

| handler | WS method | params |
|---|---|---|
| tabs | `tabs` | `{}` |
| newTab | `newTab` | `{ url?: string }` |
| useTab | `page` | `{ tabId }` (to read url/title; then set `session.targetTabId`) |
| page | `page` | `{ tabId }` |
| navigate | `navigate` | `{ tabId, url }` |
| screenshot | `screenshot` | `{ tabId }` |
| snapshot | `snapshot` | `{ tabId }` |
| click | `click` | `{ tabId, backendNodeId }` |
| type | `type` | `{ tabId, backendNodeId?: number, text, submit }` |
| fill | `fill` | `{ tabId, backendNodeId, value }` |
| scroll | `scroll` | `{ tabId, backendNodeId?: number, direction, amount }` |
| consoleMessages | `console` | `{ tabId, level?, limit? }` |
| network | `network` | `{ tabId, urlContains?, status?, limit? }` |

After `newTab` / `navigate` success: set `session.targetTabId` from result `tabId`, `session.markGrokTab(tabId)`.
After `snapshot` success: `session.rememberSnapshot(tabId, map)` from result `refs: Record<string, { backendNodeId: number }>` and return `text` from result.
`screenshot` result includes `data` (base64 png), `width`, `height`.
`useTab`: `send("page")`; if fail/`no_tab`, return `no_tab`; else set target (do **not** mark as grok tab unless it already is).

`index.ts`:

- Call `startBridge()`. On throw, keep `bridge` as a stub whose `isConnected()` is false, `send` always returns `bridge_bind_failed`, `port` is `0`.
- On successful start, write `~/.grok/chrome-bridge.json` with `{ port, pid: process.pid }` and `mode 0o600`. `mkdir` `~/.grok` if needed. On `SIGINT`/`SIGTERM`/`beforeExit`, unlink the file and `bridge.close()`.
- Register MCP tools with `@modelcontextprotocol/sdk` `McpServer` + `StdioServerTransport`.
- Each tool: call the handler, return `content: [{ type: "text", text: JSON.stringify(result) }]`. For screenshot success, also include `{ type: "image", data: result.data, mimeType: "image/png" }`.
- Tool descriptions must tell the model: mutating tools may return `needs_permission`; ask the user; then call `chrome_grant_site`. `chrome_grant_site` description: "Grants this origin for the rest of the session. Ask the user before calling."

MCP names must match the spec exactly: `chrome_grant_site`, `chrome_tabs`, `chrome_new_tab`, `chrome_use_tab`, `chrome_page`, `chrome_navigate`, `chrome_screenshot`, `chrome_snapshot`, `chrome_click`, `chrome_type`, `chrome_fill`, `chrome_scroll`, `chrome_console`, `chrome_network`.

Use `zod` schemas matching the spec inputs.

- [ ] **Step 1: Write `test/tools.test.ts` (failing)**

```ts
import { describe, expect, it } from "vitest";
import { Session } from "../src/session.js";
import { createTools } from "../src/tools.js";
import type { Bridge, WsResponse } from "../src/protocol.js";

function fakeBridge(record: string[]): Bridge {
  return {
    port: 17352,
    isConnected: () => true,
    waitForConnection: async () => true,
    close: async () => undefined,
    send: async (method, params) => {
      record.push(method);
      if (method === "page") {
        return {
          id: "x",
          ok: true,
          result: { tabId: 7, url: "http://localhost:3000/login", title: "Login" },
        } satisfies WsResponse;
      }
      if (method === "newTab") {
        return {
          id: "x",
          ok: true,
          result: { tabId: 7, url: params?.url ?? "about:blank", title: "" },
        };
      }
      return { id: "x", ok: true, result: { ok: true } };
    },
  };
}

describe("mutating tools require a grant before send", () => {
  it("chrome_navigate does not send when origin is not granted", async () => {
    const calls: string[] = [];
    const tools = createTools(new Session(), fakeBridge(calls));
    const r = await tools.navigate("http://localhost:3000/");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("needs_permission");
      expect(r.origin).toBe("http://localhost:3000");
    }
    expect(calls).toEqual([]);
  });

  it("chrome_navigate sends after grant", async () => {
    const calls: string[] = [];
    const session = new Session();
    session.grant("http://localhost:3000");
    const tools = createTools(session, fakeBridge(calls));
    const r = await tools.navigate("http://localhost:3000/");
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["navigate"]);
  });

  it("new tab without url does not need a grant", async () => {
    const calls: string[] = [];
    const tools = createTools(new Session(), fakeBridge(calls));
    const r = await tools.newTab();
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["newTab"]);
  });

  it("click does not send click when origin is not granted", async () => {
    const calls: string[] = [];
    const session = new Session();
    session.targetTabId = 7;
    session.rememberSnapshot(7, new Map([["e1", { backendNodeId: 99 }]]));
    const tools = createTools(session, fakeBridge(calls));
    const r = await tools.click("e1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("needs_permission");
    expect(calls).toEqual(["page"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd mcp-server && npx vitest run test/tools.test.ts
```

Expected: FAIL — `createTools` not found.

- [ ] **Step 3: Implement `tools.ts` and `index.ts` as specified above**

For `click` without grant: `send("page")` then `requireGrant` then do **not** `send("click")`.

Blocked URL on navigate: `isBlockedUrl` → `fail("blocked_origin", ...)` with no send.

If `bridge.send` returns `ok: false`, map `error.code` onto `ToolError` when it is a known `ErrorCode`, else `debugger_failed`.

- [ ] **Step 4: Run unit tests**

```bash
cd mcp-server && npm test
```

Expected: all existing tests PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools.ts mcp-server/src/index.ts mcp-server/test/tools.test.ts
git commit -m "feat: register Chrome MCP tools with origin grants"
```

---

### Task 5: Unpacked extension — connect and status popup

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/background.js`
- Create: `extension/popup.html`
- Create: `extension/popup.js`
- Create: `extension/icons/icon16.png`, `icon48.png`, `icon128.png`

**Interfaces:**
- Consumes: port range, `/health` name `grok-chrome`, `/ws`, hello `{ type:"hello", extensionVersion:"0.1.0" }`
- Produces: worker that stays connected; popup strings exactly `connected` / `waiting for Grok`

- [ ] **Step 1: Write `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Grok Chrome",
  "version": "0.1.0",
  "description": "Lets Grok Build drive this Chrome from the terminal.",
  "action": {
    "default_popup": "popup.html",
    "default_title": "Grok Chrome"
  },
  "background": { "service_worker": "background.js" },
  "permissions": ["debugger", "tabs", "tabGroups", "alarms"],
  "host_permissions": ["<all_urls>"],
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

- [ ] **Step 2: Write `popup.html` and `popup.js`**

Popup is ~200px wide, one status node. `popup.js` sends `{ type: "getStatus" }` via `chrome.runtime.sendMessage` and sets `textContent` to `connected` or `waiting for Grok`.

- [ ] **Step 3: Write `background.js` (connection only + command router stub)**

Must:

- `PORTS = []; for (let p = 17352; p <= 17361; p++) PORTS.push(p);`
- `async function findBridge()` fetch `http://127.0.0.1:${p}/health` with 200ms abort; return port if `data.name === "grok-chrome"`.
- Connect `new WebSocket(\`ws://127.0.0.1:${port}/ws\`)`, on open send hello.
- On message, `JSON.parse`, if `method` exists, `handle(msg)` and `ws.send` the response `{ id, ok, result }` or `{ id, ok:false, error }`.
- `handle` for unknown method: `{ code: "debugger_failed", message: "unknown method "+method }`.
- Keep `let connected = false`. `onMessage` for `getStatus` returns `{ connected }`.
- Reconnect: delay starts 300ms, doubles, cap 5000ms. Reset delay on successful open.
- `chrome.alarms.create("grok-reconnect", { periodInMinutes: 0.5 })` and on alarm, if `!connected`, `findBridge` + connect.
- `chrome.runtime.onInstalled` / worker start: connect immediately.

Icons: write tiny valid PNGs (solid 16/48/128). A 1×1 PNG scaled is fine if Chrome accepts it; prefer generate via a short Node script using no extra deps (raw PNG bytes) or copy a generated file. Do not commit huge binaries.

- [ ] **Step 4: Manual check (this Mac)**

```bash
cd mcp-server && npm run build && node dist/index.js
```

This will sit on stdio. In another terminal: `curl -s http://127.0.0.1:17352/health`. Load `extension/` unpacked. Open the popup: it should read `connected` while the node process is running, `waiting for Grok` after you kill it (within ~5s).

If you cannot click the popup in this environment, still write the files; do not skip them.

- [ ] **Step 5: Commit**

```bash
git add extension/
git commit -m "feat: add unpacked extension that connects to the MCP bridge"
```

---

### Task 6: Tab methods in the extension

**Files:**
- Modify: `extension/background.js` — implement `tabs`, `newTab`, `page`, `navigate`
- Modify: `mcp-server/src/tools.ts` only if WS result shapes don't match (prefer keep Task 4 shapes)

**Interfaces:**
- Consumes: `handle(method)` router from Task 5
- Produces WS results:
  - `tabs` → `{ tabs: [{ id, title, url, active, grok }], targetTabId }` — **`grok` is not known in the extension.** Return `grok: false` always from the extension; `tools.tabs` overwrites `grok` using `session.isGrokTab`. `targetTabId` is filled by `tools.tabs` from `session.targetTabId`, not the extension. Extension result: `{ tabs: [{ id, title, url, active }] }`.
  - `newTab` → `{ tabId, url, title }`. Create with `chrome.tabs.create({ url: url || "about:blank" })`. Then try `chrome.tabs.group` + `chrome.tabGroups.update` title `Grok`, color `blue`. On group failure, still return success.
  - `page` → `{ tabId, url, title }` from `chrome.tabs.get`. Missing tab → `{ ok:false, error:{ code:"no_tab", message } }`.
  - `navigate` → `chrome.tabs.update(tabId, { url })`, wait for `chrome.tabs.onUpdated` status `complete` for that tab or 30s → timeout. Return final `{ tabId, url, title }`.

Blocked URLs: extension must refuse `navigate` / debugger attach using the same rules (chrome:, chrome-extension:, edge:, web store, about: except blank). Return `blocked_origin`.

- [ ] **Step 1: Implement the four methods in `background.js`**

Keep helpers `getTab(tabId)`, `waitComplete(tabId, timeoutMs)`.

- [ ] **Step 2: Adjust `tools.tabs` to merge session grok flags and `targetTabId`**

If already done in Task 4, skip.

- [ ] **Step 3: Commit**

```bash
git add extension/background.js mcp-server/src/tools.ts
git commit -m "feat: implement tab list, create, and navigate in the extension"
```

---

### Task 7: Debugger — screenshot, snapshot, click, type, fill, scroll

**Files:**
- Modify: `extension/background.js`

**Interfaces:**
- Consumes: `chrome.debugger` attach `"1.3"` per tab; detach when tab closes
- Produces:
  - `screenshot` → `{ data: base64PngWithoutPrefix, width, height }` via `Page.captureScreenshot` `{ format: "png" }` plus `Page.getLayoutMetrics` (or `cssVisualViewport`) for size. Viewport only.
  - `snapshot` → enable Accessibility, `Accessibility.getFullAXTree`, flatten nodes that have a name or an interactive role (`button`, `link`, `textbox`, `checkbox`, `radio`, `combobox`, `menuitem`, `tab`, `heading`, `searchbox`). Assign `e1`, `e2`, … in tree order. Skip nodes with no name and generic role. Result: `{ text: string, refs: { [ref]: { backendNodeId: number } } }` where `text` is lines `[e1] heading "Login"`.
  - `click` → `DOM.getContentQuads` / `DOM.getBoxModel` for `backendNodeId`, click center with `Input.dispatchMouseEvent` mousePressed + mouseReleased, button left, clickCount 1.
  - `type` → if `backendNodeId`, click first; `Input.insertText` `{ text }`; if `submit`, `Input.dispatchKeyEvent` keyDown/keyUp `Enter`.
  - `fill` → click node; `Input.dispatchKeyEvent` with modifiers select-all (Meta+A on Mac) or `document.execCommand` via `Runtime.evaluate` to select and clear; then `Input.insertText`.
  - `scroll` → `Input.dispatchMouseEvent` type `mouseWheel` with `deltaY` 360 * sign (down + / up −), `deltaX` for left/right. Default `amount` 1 means one 360px tick; `amount` N multiplies. If `backendNodeId` present, click it first so the wheel targets that node.

Attach helper:

```js
async function attach(tabId) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (e) {
    if (!String(e).includes("already attached")) {
      throw Object.assign(new Error(String(e)), { code: "debugger_failed" });
    }
  }
  await chrome.debugger.sendCommand(target, "Page.enable", {});
  await chrome.debugger.sendCommand(target, "DOM.enable", {});
  await chrome.debugger.sendCommand(target, "Runtime.enable", {});
  await chrome.debugger.sendCommand(target, "Console.enable", {});
  await chrome.debugger.sendCommand(target, "Network.enable", {});
  await chrome.debugger.sendCommand(target, "Accessibility.enable", {});
}
```

Never attach to a blocked URL. On `chrome.tabs.onRemoved`, `debugger.detach` if attached.

- [ ] **Step 1: Implement attach + the six methods**

- [ ] **Step 2: Commit**

```bash
git add extension/background.js
git commit -m "feat: drive the page with debugger screenshot, snapshot, and input"
```

---

### Task 8: Console and network buffers

**Files:**
- Modify: `extension/background.js`

**Interfaces:**
- Per attached `tabId`:
  - `consoleBuf`: array max 500 of `{ level, text, timestamp, url? }`
  - `networkBuf`: array max 200 of `{ method, url, status, mimeType? }`
- Listen `chrome.debugger.onEvent`:
  - `Runtime.consoleAPICalled` → push `{ level: params.type, text: params.args mapped via value/description, timestamp: params.timestamp, url: params.stackTrace?.callFrames?.[0]?.url }`
  - `Runtime.exceptionThrown` → level `error`
  - `Network.responseReceived` → `{ method: response.requestHeaders? or from requestWillBeSent map, url, status, mimeType }`
- Keep a `requestId → { method, url }` map from `Network.requestWillBeSent` to fill method/url on response.
- `console` method: filter `level` if provided; `slice(-limit)` default limit 100.
- `network` method: filter `urlContains` substring and `status` equality; default limit 100; no bodies.

- [ ] **Step 1: Implement buffers and the two methods**

- [ ] **Step 2: Commit**

```bash
git add extension/background.js
git commit -m "feat: buffer console and network events from the debugger"
```

---

### Task 9: Fixture page + README

**Files:**
- Create: `mcp-server/fixture/index.html`
- Create: `README.md`

**Interfaces:**
- Consumes: install paths from spec
- Produces: documented manual pass

- [ ] **Step 1: Write `fixture/index.html`**

A single page, no build:

- `<h1>Login</h1>`
- `<label>Email <input id="email" name="email" /></label>`
- `<label>Password <input id="password" name="password" type="password" /></label>`
- `<button id="submit" type="button">Sign in</button>`
- `<div id="error" hidden>Invalid credentials</div>`
- Script: on submit, `console.error("login failed")` and unhide `#error`.

- [ ] **Step 2: Write `README.md`**

Include:

1. `cd mcp-server && npm install && npm run build && npm test && npm run smoke`
2. Chrome → `chrome://extensions` → Developer mode → Load unpacked → this repo's `extension/`
3. Add to `~/.grok/config.toml`:

```toml
[mcp_servers.grok-chrome]
command = "node"
args = ["/Volumes/SSD/github-backup/grok-extension/mcp-server/dist/index.js"]
```

(Use the real absolute path of this repo if it differs.)

4. Restart Grok. Pin the extension. Popup goes `waiting for Grok` → `connected`.
5. Manual fixture: `npx --yes serve mcp-server/fixture -p 4173`, then in Grok: grant `http://localhost:4173`, open it, fill email/password, click Sign in, read console for `login failed`, screenshot.
6. Disconnect: quit Chrome → next tool `extension_disconnected`; reopen Chrome → reconnect.

Safety paragraph: localhost-only; Grok will see pages it is granted; do not Auto-grant untrusted origins.

- [ ] **Step 3: Run unit + smoke once more**

```bash
cd mcp-server && npm test && npm run smoke && npm run build
```

Expected: PASS, `dist/index.js` exists.

- [ ] **Step 4: Commit**

```bash
git add mcp-server/fixture/index.html README.md
git commit -m "docs: add install steps and login-fail fixture page"
```

---

## Self-review (spec coverage)

| Spec requirement | Task |
|---|---|
| Localhost bind, ports 17352–17361, `/health`, `/ws` | 3 |
| Bridge file `~/.grok/chrome-bridge.json` mode 0600 | 4 |
| Origin parsing, blocked URLs | 1 |
| In-memory allowlist, per-port grants | 2 |
| `needs_permission` without Chrome action | 4 |
| All 14 tools | 4 (handlers) + 6–8 (extension) |
| Grok new tabs + group | 6 |
| Viewport screenshot, snapshot refs, input | 7 |
| Console 500 / network 200, no bodies | 8 |
| Extension popup, alarms, reconnect | 5 |
| Unit tests + protocol smoke + fixture + README | 1–4, 3, 9 |
| No side panel / computer use / native messaging | 5 manifest |

No placeholders left. Type names (`Session`, `Bridge`, `createTools`, WS methods) are consistent across tasks.
