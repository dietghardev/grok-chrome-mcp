# Grok Chrome MCP

A local Chrome bridge for Grok Build: an unpacked Manifest V3 extension plus an
MCP server, so Grok can drive **your** Chrome — the one with your cookies and
logins — from the terminal. The TUI is the interface; there is no side-panel
chat.

Same shape as Claude's Chrome extension: open tabs, read the page, click, type,
drag, run JavaScript, watch the console and network, and record what happened
as a GIF. A visible cursor overlay (the *shadow mouse*) shows you where Grok is
clicking as it works.

```
Grok Build TUI
    │  MCP stdio
    ▼
mcp-server (Node)                 in-memory origin allowlist, serial queue
    │  HTTP + WebSocket on 127.0.0.1:17352–17361
    ▼
MV3 extension  ──chrome.debugger (CDP)──▶  a tab Grok opened
```

## Install

```bash
cd mcp-server && npm install && npm run build && npm test && npm run smoke
```

1. Chrome → `chrome://extensions` → **Developer mode** → **Load unpacked** →
   pick this repo's `extension/` directory.
2. Add to `~/.grok/config.toml`, using the absolute path in your clone:

```toml
[mcp_servers.grok-chrome]
command = "node"
args = ["/path/to/grok-extension/mcp-server/dist/index.js"]
```

3. Restart Grok, pin the extension. The popup goes from `waiting for Grok` to
   `connected` and shows the bridge port and how many tabs are attached.

Edge, Brave, Opera, and Vivaldi work too — load the same unpacked extension
there. Every connected browser registers itself; `chrome_browsers` lists them
and `chrome_select_browser` picks which one later tools drive.

## Tools

**Permission model.** Reading is free; acting on a page needs the user's
consent for that origin. A mutating tool called on an ungranted origin returns
`needs_permission` and sends **nothing** to Chrome — Grok is expected to ask
you in chat, then call `chrome_grant_site`. Grants live in the MCP process's
memory only: they never touch disk and die when Grok exits. `localhost:3000`,
`localhost:5173`, and `127.0.0.1:3000` are three separate grants.

| Read-only — no grant | |
|---|---|
| `chrome_tabs` | open tabs and the current target |
| `chrome_page` | target tab's URL and title |
| `chrome_snapshot` | accessibility tree with refs (`e1`, `e2`, …), field values, and disabled/checked/focused state |
| `chrome_find` | elements by text and/or role, sharing snapshot's ref numbering |
| `chrome_text` | visible page text, capped and flagged when truncated |
| `chrome_screenshot` | viewport PNG |
| `chrome_console` | recent console messages, filterable by level |
| `chrome_network` | recent finished requests (no bodies) |
| `chrome_wait_for` | wait for text to appear or disappear |
| `chrome_browsers` | connected browsers |
| `chrome_resize` | resize so the viewport matches a size |
| `chrome_cursor` | show/hide the shadow mouse |
| `chrome_record_start` / `chrome_record_stop` | record the tab to an animated GIF |

| Needs a grant | |
|---|---|
| `chrome_navigate`, `chrome_new_tab` (with a URL) | go somewhere |
| `chrome_back`, `chrome_forward`, `chrome_reload` | history |
| `chrome_click`, `chrome_hover`, `chrome_drag`, `chrome_scroll` | pointer |
| `chrome_type`, `chrome_fill`, `chrome_press` | keyboard, including `Control+a` / `Meta+Shift+p` |
| `chrome_select_option`, `chrome_upload_file` | forms |
| `chrome_evaluate` | run JavaScript in the page |
| `chrome_close_tab` | free for Grok's own tabs; a grant for yours |
| `chrome_batch` | a short sequence in one round-trip; each step is permission-checked as if called alone |

Housekeeping: `chrome_grant_site`, `chrome_revoke_site`, `chrome_use_tab`,
`chrome_select_browser`.

Refs come from `chrome_snapshot` or `chrome_find` and belong to the newest
snapshot of that tab; an older ref returns `stale_ref` rather than clicking
whatever now sits in that position.

## Manual fixture pass

```bash
npx --yes serve mcp-server/fixture -p 4173
```

In Grok: grant `http://localhost:4173`, then open it and work through the
sections — sign in and read `login failed` from the console, wait for
`Welcome back`, choose a colour, hover, drag the chip into the drop zone,
scroll to the bottom, and record a GIF of the run.

Then: quit Chrome mid-session — the next tool call reports
`extension_disconnected` immediately rather than hanging. Reopen Chrome and it
reconnects on its own.

## Errors

Every failure is one of these codes, as JSON the model can act on:
`extension_disconnected`, `bridge_bind_failed`, `no_tab`, `blocked_origin`,
`needs_permission`, `invalid_origin`, `invalid_input`, `stale_ref`, `timeout`,
`debugger_failed`.

## Safety

- The bridge binds `127.0.0.1` only. Any process on this Mac can still reach
  that port — the same class of risk as a token under `~/.grok/`.
- `chrome://`, `chrome-extension://`, `edge://`, and the Web Store are refused
  outright, for reading as well as acting.
- Grok works in tabs it opened (grouped under **Grok**) unless you point it at
  one of yours with `chrome_use_tab` — and even then, acting still needs the
  grant.
- `chrome_evaluate` and `chrome_upload_file` are the sharp ones: the first runs
  arbitrary JavaScript in the page, the second hands local files to it. Both
  need a grant; only pass file paths you chose.
- Page content is untrusted input. Snapshots and screenshots can carry prompt
  injection, so don't grant origins you don't trust — there is no second
  classifier here.

## Development

```bash
cd mcp-server
npm test            # 101 unit tests
npm run smoke       # bridge protocol + MCP stdio surface, no Chrome needed
npm run build
```

The pure logic the extension depends on lives in `extension/lib/` (`keys.js`,
`ax.js`) so it is unit-tested alongside the server rather than only being
exercised by hand in a browser.
