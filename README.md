<h1 align="center">grok-chrome-mcp</h1>

<p align="center">
  <b>Let Grok Build click through the app you are writing.</b><br>
  Grok opens tabs in the Chrome you already use, fills forms, reads the
  console and network, takes screenshots, and records a GIF of the run.
  Your cookies stay put. No second browser profile. No Playwright.
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://github.com/dietghardev/grok-chrome-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/dietghardev/grok-chrome-mcp/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg">
  <img alt="tests" src="https://img.shields.io/badge/tests-125%20passing-brightgreen.svg">
</p>

<p align="center">
  <img src="docs/demo.gif" alt="Grok filling a login form in Chrome, with the shadow mouse cursor visible on the button it clicks" width="820">
</p>

You stay in the Grok Build TUI. Grok works in tabs it opens, grouped under
**Grok**. It does not steal the tab you are looking at. The first time it
needs to act on a site, it asks; a refused action never reaches Chrome.

Works in Chrome, Edge, Brave, Opera, and Vivaldi. Connect more than one and
pick with `chrome_select_browser`.

Claude has an official Chrome extension. This is that, for Grok Build: 35
tools over MCP, no forked client, no `--remote-debugging-port`, no native
messaging host.

## What you can ask

Paste these into Grok after you are connected:

> open http://localhost:3000, sign in as test@example.com / password123,
> and tell me what the console says

> the submit button does nothing. screenshot the form, click it, and show me
> the network calls that fire

> fill the signup form, wait until you see Welcome back, and save a GIF of
> the run to /tmp/signup.gif

You do not call the 35 tools yourself. Ask in chat. Grok snapshots the page,
clicks refs, and grants an origin only after you agree.

## Install

The package is not on the npm registry yet. Run it from a clone (Node 20+).

```bash
git clone https://github.com/dietghardev/grok-chrome-mcp.git
cd grok-chrome-mcp/mcp-server
npm install && npm run build
node dist/index.js setup
```

`setup` copies the extension to `~/.grok/grok-chrome-extension` and prints
the Grok config for this tree.

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the folder `setup` printed.
2. Paste the printed block into `~/.grok/config.toml`. It should look like:

   ```toml
   [mcp_servers.grok-chrome]
   command = "node"
   args = ["/absolute/path/to/grok-chrome-mcp/mcp-server/dist/index.js"]
   enabled = true
   ```

3. Restart Grok and pin the extension. The popup goes from `waiting for Grok` to `connected`.

After you pull and rebuild, hit reload (↻) on the card at `chrome://extensions`
so Chrome picks up the new version.

Edge, Brave, Opera, and Vivaldi load the same folder. Every connected browser
registers itself; `chrome_browsers` lists them.

## How it works

```
Grok Build TUI
    │  MCP stdio
    ▼
mcp-server (Node)                 in-memory origin allowlist, serial queue
    │  HTTP + WebSocket on 127.0.0.1:17352–17361
    ▼
MV3 extension  ──chrome.debugger (CDP)──▶  a tab Grok opened
```

- **Your real browser.** Tabs Grok opens share the cookies and logins you already have.
- **You can watch it.** A shadow mouse, a cursor overlay on the page, moves to whatever Grok is about to click and ripples when it does.
- **Permission per origin.** Reading is free. Acting on a site needs your consent for that origin.
- **Debugging, not only clicking.** Console, network, accessibility snapshots, page text, screenshots, GIFs.

## Permission model

A mutating tool on an ungranted origin returns `needs_permission` and sends
**nothing** to Chrome. Grok should ask you, then call `chrome_grant_site`.
Grants live in the MCP process memory only: they never touch disk and die
when Grok exits. `localhost:3000`, `localhost:5173`, and `127.0.0.1:3000`
are three separate grants.

## Tools

| Read-only, no grant | |
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
snapshot of that tab. An older ref returns `stale_ref` rather than clicking
whatever now sits in that position.

## Try it against the fixture

```bash
npx --yes serve mcp-server/fixture -p 4173
```

In Grok: grant `http://localhost:4173`, then open it and work through the
sections. Sign in and read `login failed` from the console, wait for
`Welcome back`, choose a colour, hover, drag the chip into the drop zone,
scroll to the bottom, and record a GIF of the run.

Then quit Chrome mid-session. The next tool call reports
`extension_disconnected` immediately rather than hanging. Reopen Chrome and it
reconnects on its own.

## If something goes wrong

**Popup stays `waiting for Grok`.** Grok is not running this server, or the
extension cannot reach `127.0.0.1:17352`–`17361`. Restart Grok. Confirm
`config.toml` points at this clone's `mcp-server/dist/index.js`.

**Chrome shows a debugger banner.** Expected. The extension uses
`chrome.debugger` on tabs Grok opened. Cancel the session from that banner
and the next command re-attaches.

**Tool returns `extension_disconnected`.** Chrome is closed or the extension
was reloaded. Reopen Chrome; it reconnects on its own.

**Tool returns `needs_permission`.** Agree in chat so Grok can call
`chrome_grant_site`. Grants die when Grok exits.

**`npx grok-chrome-mcp` is not found.** The package is not published. Use the
clone steps under [Install](#install).

Every failure is one of these codes, as JSON the model can act on:
`extension_disconnected`, `bridge_bind_failed`, `no_tab`, `blocked_origin`,
`needs_permission`, `invalid_origin`, `invalid_input`, `stale_ref`, `timeout`,
`debugger_failed`.

## Safety

- The bridge binds `127.0.0.1` only. Any process on this machine can still reach that port. Same class of risk as a token under `~/.grok/`.
- `chrome://`, `chrome-extension://`, `edge://`, `brave://`, `opera://`, `vivaldi://`, `devtools://`, `view-source:`, `file://`, `data:`, and the Chrome / Edge Web Stores are refused outright, for reading as well as acting.
- Grok works in tabs it opened unless you point it at one of yours with `chrome_use_tab`. Acting still needs the grant.
- `chrome_evaluate` and `chrome_upload_file` are the sharp ones: the first runs arbitrary JavaScript in the page, the second hands local files to it. Both need a grant. Only pass file paths you chose. Neither runs on `about:blank`.
- Page content is untrusted input. Snapshots and screenshots can carry prompt injection. Do not grant origins you do not trust. There is no second classifier here.

## Contributing

Issues and pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
Security reports go through [private advisories](SECURITY.md), not public
issues.

## Development

```bash
cd mcp-server
npm test            # unit tests (see badge)
npm run smoke       # bridge protocol + MCP stdio surface, no Chrome needed
npm run build
```

`npm run e2e` drives a real browser through the whole tool surface against the
fixture: permission gating, snapshot, fill, click, wait, console, network,
select, evaluate, keyboard, screenshot, GIF, blocked origins, tab close.

Google Chrome stable refuses `--load-extension`, so pick a mode:

```bash
# Drive a browser that already has the extension loaded. Opens one localhost
# tab and closes it; a browser it did not launch is otherwise never commanded.
E2E_USE_CONNECTED=1 npm run e2e

# Or launch an isolated browser, given a binary that still allows it.
CHROME_PATH=/path/to/chromium npm run e2e
```

The connected mode requires the loaded extension to match this tree's version.
After editing `extension/`, hit reload (↻) on the card at `chrome://extensions`
or the run will tell you to.

The pure logic the extension depends on lives in `extension/lib/` (`keys.js`,
`ax.js`) so it is unit-tested alongside the server rather than only being
exercised by hand in a browser.

## License

MIT. See [LICENSE](LICENSE).
