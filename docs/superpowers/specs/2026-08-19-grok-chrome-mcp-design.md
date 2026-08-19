# Grok Chrome MCP (v1)

**Date:** 2026-08-19  
**Status:** Ready for user review  
**Repo:** `/Volumes/SSD/github-backup/grok-extension`

## Goal

Give Grok Build a Claude Code–style Chrome bridge on this Mac: the TUI is the UI; an unpacked Manifest V3 extension lets Grok drive **this** Chrome, including existing cookies and logins.

No side-panel chat. No Mac computer-use (Accessibility / Screen Recording). No Chrome Web Store listing.

Success looks like: load the extension, add one MCP block to `~/.grok/config.toml`, start Grok, grant `http://localhost:3000` once, then Grok can open a tab, fill a form, screenshot, and read `console.error`.

## Non-goals (v1)

- Side-panel or in-browser chat
- Native messaging host
- `--remote-debugging-port` / a second Chrome profile
- File upload, GIF recording, `browser_batch`, workflow recording, scheduled tasks
- Driving the user’s current tab by default
- Computer use of native macOS apps
- Multi-browser (Edge/Brave) until Chrome works
- Team allowlists, 1Password, site-specific “skills”

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Product | Grok TUI → Chrome, not a Claude-in-Chrome clone | Fastest path to the build-test-debug loop |
| Transport | Extension ↔ MCP over localhost WebSocket | No native-host install; Grok already spawns MCP |
| Tab targeting | Grok opens **new** tabs, optionally grouped | Do not hijack Gmail/Docs the user is looking at |
| Site permission | First mutating action per origin prompts; then allowed for the MCP process lifetime | Matches the chosen safety model |
| Read-only | Screenshot, snapshot, console, network, tabs, page metadata: no origin prompt | Observation is cheaper than control |
| Discovery | Fixed localhost port range + `/health`; not a home-dir file | Extensions cannot read `~/.grok/` |
| Trust | Bind `127.0.0.1` only | Personal Mac; localhost is the boundary |
| Stack | TypeScript MCP (`@modelcontextprotocol/sdk`) + MV3 extension | Matches Grok’s MCP config; easy to iterate |

## Architecture

```
Grok Build TUI
    │  MCP stdio
    ▼
mcp-server (Node, spawned by Grok)
    │  HTTP + WebSocket on 127.0.0.1:17352–17361
    │  writes ~/.grok/chrome-bridge.json (debug / CLI smoke only)
    ▼
MV3 extension (unpacked into daily Chrome)
    │  chrome.debugger + tabs + tabGroups
    ▼
A tab Grok opened
```

Two processes besides Grok:

1. **mcp-server** — stdio MCP for Grok; HTTP/WS for the extension; in-memory origin allowlist; serial command queue.
2. **extension** — service worker + tiny status popup (`connected` / `waiting for Grok`). No chat UI.

Grok is not forked. Wiring is a `[mcp_servers.grok-chrome]` entry in user config.

## Repo layout

```
extension/                 # load unpacked; vanilla JS, no bundler
  manifest.json
  background.js
  popup.html
  popup.js
  icons/
mcp-server/
  package.json
  tsconfig.json
  src/
    index.ts               # MCP stdio entry
    bridge-http.ts         # bind port, /health, websocket
    session.ts             # allowlist, target tab, serial queue
    tools.ts               # MCP tool handlers
    protocol.ts            # WS request/response types
    origins.ts             # parse/compare origins, blocked list
  test/
    origins.test.ts
    session.test.ts
  fixture/
    index.html             # button, input, console.error for smoke
README.md
```

Compiled MCP output: `mcp-server/dist/index.js`. Grok config points at that file (or `npx tsx` during dev).

## Connection and discovery

The extension cannot read `~/.grok/`. Discovery is localhost HTTP.

- MCP binds **`127.0.0.1` only**.
- Try ports **17352–17361** in order; use the first free port.
- `GET /health` returns `{"ok":true,"name":"grok-chrome","pid":...}`.
- WebSocket: `ws://127.0.0.1:<port>/ws`.
- One extension connection at a time. A new hello replaces the old one (reloading the extension is expected).
- On start, MCP writes `~/.grok/chrome-bridge.json` (mode `0600`) with `{port, pid}` for humans and the CLI smoke tool. Delete on clean exit. The extension does not use this file.
- If every port in range is taken, MCP tools return `bridge_bind_failed`.

Extension behavior:

- On worker start, probe `/health` on 17352–17361, then open `/ws` on the first grok-chrome health hit.
- Exponential reconnect (cap ~5s) while Grok is not running.
- `chrome.alarms` every 20s so a sleeping worker can reconnect.
- Popup: `connected` if the socket is open, else `waiting for Grok`.

### Wire protocol

Request (MCP → extension):

```json
{ "id": "uuid", "method": "navigate", "params": { "tabId": 123, "url": "http://localhost:3000/" } }
```

Response:

```json
{ "id": "uuid", "ok": true, "result": { "url": "http://localhost:3000/", "title": "…" } }
```

```json
{ "id": "uuid", "ok": false, "error": { "code": "timeout", "message": "…" } }
```

Hello (extension → MCP, first message after WS open):

```json
{ "type": "hello", "extensionVersion": "0.1.0" }
```

Commands are **serial per MCP process**. Do not overlap debugger calls on the same tab. Default command timeout is **30 seconds**.

## Tab model

- Grok’s **target tab** is stored in MCP memory. If unset, mutating navigate/new-tab creates one; snapshot/screenshot/console against no target returns `no_tab`.
- `chrome_new_tab` creates a tab and makes it the target. Put Grok tabs in a tab group titled `Grok` with a distinct color when `tabGroups` succeeds; if grouping fails, continue without a group.
- `chrome_use_tab` sets the target to an existing tab id (Grok-owned or user-owned). It does not grant the origin. Later mutating tools still need a grant for that tab’s origin.
- `chrome_navigate` uses the target tab, or creates a Grok tab if none exists.
- Closing the target tab clears the target (`no_tab` until a new one exists).
- Do not attach debugger to `chrome://`, `chrome-extension://`, `edge://`, `about:` except `about:blank`, or the Chrome Web Store.

## Origins and permission

**Origin** = `URL.origin` (scheme + host + port). Examples that are **different** grants:

- `http://localhost:3000`
- `http://localhost:5173`
- `http://127.0.0.1:3000`
- `https://github.com`

Allowlist is **in-memory** on the MCP process. It dies when Grok exits or the MCP subprocess restarts. It is not written to disk.

### Read-only (no grant)

`chrome_tabs`, `chrome_page`, `chrome_screenshot`, `chrome_snapshot`, `chrome_console`, `chrome_network`.

These may run on the current target tab even if its origin is not granted. They must still refuse blocked origins (`chrome://`, Web Store, other extensions).

### Mutating (grant required)

`chrome_new_tab` **with a URL**, `chrome_navigate`, `chrome_click`, `chrome_type`, `chrome_fill`, `chrome_scroll`.

`chrome_new_tab` with no URL opens `about:blank` and does not need a grant.

`chrome_grant_site` adds one origin. It accepts either an origin (`http://localhost:3000`) or any URL; the server stores `new URL(value).origin`. Invalid input returns `invalid_origin`.

### Prompt flow

1. A mutating tool runs for an origin not on the allowlist.
2. MCP **does not** talk to Chrome. It returns `needs_permission` with the origin and a short message: call `chrome_grant_site` after the user agrees.
3. Grok asks in the TUI. User agrees. Grok calls `chrome_grant_site`.
4. In Grok **Ask** mode, that tool call is the terminal approval. In **Auto** mode, Grok may auto-approve `chrome_grant_site`; the tool description still tells the model to ask in chat first. This Auto-mode gap is accepted for v1 (no Grok-core permission API).

After a navigation, if the **final** URL’s origin differs from the requested origin (redirect), the navigation is allowed only if the **requested** origin was granted. Further mutating actions use the **final** origin and may return `needs_permission` for that new origin.

## Tools

All tools are namespaced as listed (MCP name = table name).

### `chrome_grant_site`

- Input: `{ "origin": string }` (origin or URL)
- Result: `{ "granted": ["http://localhost:3000", …] }` (full allowlist)

### `chrome_tabs`

- Input: none
- Result: `{ "tabs": [{ "id", "title", "url", "active", "grok": boolean }], "targetTabId": number | null }`

### `chrome_new_tab`

- Input: `{ "url"?: string }`
- Grant: required if `url` is present
- Result: `{ "tabId", "url", "title" }`
- Side effect: becomes target

### `chrome_use_tab`

- Input: `{ "tabId": number }`
- Result: `{ "tabId", "url", "title" }`
- Error `no_tab` if id missing

### `chrome_page`

- Result: `{ "tabId", "url", "title" }`

### `chrome_navigate`

- Input: `{ "url": string }`
- Grant: destination origin
- Waits for load or 30s
- Result: `{ "tabId", "url", "title" }` (final URL after redirects)

### `chrome_screenshot`

- Input: none
- Result: viewport PNG as MCP image content, plus `{ "width", "height" }`
- v1 does not support full-page capture

### `chrome_snapshot`

- Builds an accessibility-tree snapshot of the target tab via CDP (`Accessibility.getFullAXTree` and/or DOM).
- Assigns stable refs `e1`, `e2`, … for the **current** snapshot generation on that tab. A new snapshot invalidates previous refs (`stale_ref`).
- Result: indented text the model can read, e.g.

```
[e1] heading "Login"
[e2] textbox "Email"
[e3] textbox "Password"
[e4] button "Sign in"
```

Include role, name/value, and enough structure to click forms. Omit empty generic wrappers when they add noise.

### `chrome_click`

- Input: `{ "ref": string }`
- Grant: current page origin
- Resolves ref → box → CDP `Input.dispatchMouseEvent` (pressed + released at center)
- Result: `{ "ok": true }`

### `chrome_type`

- Input: `{ "ref"?: string, "text": string, "submit"?: boolean }`
- If `ref` given, click it first to focus. Then insert text (CDP `Input.insertText` or equivalent). If `submit`, press Enter.
- Grant: current page origin

### `chrome_fill`

- Input: `{ "ref": string, "value": string }`
- Focus, select-all / clear, insert `value`
- Grant: current page origin

### `chrome_scroll`

- Input: `{ "ref"?: string, "direction": "up"|"down"|"left"|"right", "amount"?: number }`
- Default amount: 3 “ticks” / a viewport-ish delta
- Grant: current page origin

### `chrome_console`

- Input: `{ "level"?: "error"|"warn"|"info"|"debug"|"log", "limit"?: number }`
- Buffer kept on the extension while the debugger is attached (cap last 500 messages).
- Result: `{ "messages": [{ "level", "text", "timestamp", "url"? }] }`

### `chrome_network`

- Input: `{ "urlContains"?: string, "status"?: number, "limit"?: number }`
- Buffer last 200 finished requests while attached.
- Result: `{ "requests": [{ "method", "url", "status", "mimeType"? }] }` — no bodies in v1

## Error codes

Returned as MCP text/JSON the model can see. Never throw an unstructured failure when a code applies.

| Code | When |
|---|---|
| `extension_disconnected` | No WS client; Chrome closed; worker dead after reconnect wait (~2s) |
| `bridge_bind_failed` | Ports 17352–17361 all taken |
| `no_tab` | No target, or tab id gone |
| `blocked_origin` | `chrome://`, Web Store, other extension, etc. |
| `needs_permission` | Mutating tool, origin not granted — **no Chrome action** |
| `invalid_origin` | `chrome_grant_site` / navigate URL unparseable |
| `stale_ref` | Ref not from the latest snapshot on this tab |
| `timeout` | CDP / load exceeded 30s |
| `debugger_failed` | `chrome.debugger.attach` rejected |

## Extension manifest (minimum)

MV3. Permissions: `debugger`, `tabs`, `tabGroups`, `alarms`. Host access as required for debugger on http/https (typically `<all_urls>`). Action popup for status only.

Do not request `sidePanel`, `downloads`, `nativeMessaging`, `desktopCapture`.

## Grok install

`~/.grok/config.toml`:

```toml
[mcp_servers.grok-chrome]
command = "node"
args = ["/Volumes/SSD/github-backup/grok-extension/mcp-server/dist/index.js"]
```

Dev alternative: `args = ["--import", "tsx", "/Volumes/SSD/github-backup/grok-extension/mcp-server/src/index.ts"]` if we document `tsx`; production path is compiled `dist`.

README steps:

1. `cd mcp-server && npm install && npm run build`
2. Load `extension/` unpacked in `chrome://extensions` (Developer mode)
3. Add the MCP block
4. Restart Grok
5. Pin the extension; popup should go from `waiting for Grok` to `connected`

## Testing

### Unit (mcp-server, no Chrome)

- Origin parsing and inequality (`localhost` vs `127.0.0.1`, ports)
- Blocked origins
- Allowlist: grant, mutating deny/allow, process-lifetime (in-memory)
- Serial queue: second command waits
- `needs_permission` does not enqueue a WS command

### Fixture + smoke CLI

`mcp-server/fixture/index.html` served over HTTP on a known port (`npx serve` or the smoke script’s own static server). Not `file://`. Page: labeled email/password fields, submit button that `console.error("login failed")`, and a visible error div.

`npm run smoke` is a **protocol** test: it starts MCP HTTP, connects as a fake extension on `/ws`, and asserts health + serial command echo. It does not require Chrome.

The real extension + fixture page is the **manual** pass below.

### Manual on this Mac

1. Load unpacked, start Grok with MCP.
2. Grant `http://localhost:<fixture-port>`, run the login-fail flow from the TUI.
3. Quit Chrome mid-session → next tool is `extension_disconnected`.
4. Reopen Chrome → reconnect → continue.
5. Confirm Grok did not steal a pre-existing user tab.

v1 is not done until unit tests pass and the manual fixture pass has been run on this Mac.

## Security notes

- Localhost bind only; any process on this Mac can talk to the port. Same class of risk as writing a token under `~/.grok/`.
- Debugger on the user’s daily Chrome is powerful. Mitigations: Grok-owned tabs by default, origin grants, blocked internal URLs, no bodies in network logs.
- Prompt injection from page content is real. Grok will see snapshots and screenshots. Users should not Auto-grant origins they do not trust. v1 does not add a second classifier.

## Implementation order (for the later plan, not extra scope)

1. MCP HTTP `/health` + WS echo + extension hello + popup status
2. Tabs / new tab / navigate / page
3. Origin allowlist + `chrome_grant_site` + mutating gates
4. Debugger: screenshot, snapshot+refs, click/type/fill/scroll
5. Console + network buffers
6. Tests, fixture, README

## Open questions

None. Auto-mode `chrome_grant_site` auto-approval is an accepted limitation, not an open product question.
