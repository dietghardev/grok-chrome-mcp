# Grok Chrome MCP

Local Chrome bridge for Grok Build: an unpacked Manifest V3 extension plus an MCP server so Grok can open tabs, fill forms, screenshot, and read console/network events in **this** Chrome (with your existing cookies).

## Install

```bash
cd mcp-server && npm install && npm run build && npm test && npm run smoke
```

1. Open Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this repo’s `extension/` directory.
2. Add to `~/.grok/config.toml` (use the absolute path to `mcp-server/dist/index.js` in your clone):

```toml
[mcp_servers.grok-chrome]
command = "node"
args = ["/Volumes/SSD/github-backup/grok-extension/mcp-server/dist/index.js"]
```

On this feature worktree the path is:

`/Volumes/SSD/github-backup/grok-extension/.worktrees/feat-grok-chrome-mcp/mcp-server/dist/index.js`

After merge (or on a normal clone of the repo root), point `args` at `<clone-root>/mcp-server/dist/index.js`.

3. Restart Grok. Pin the extension. The popup should go from `waiting for Grok` → `connected`.

## Manual fixture pass

```bash
npx --yes serve mcp-server/fixture -p 4173
```

Then in Grok: grant `http://localhost:4173`, open it, fill email/password, click **Sign in**, read console for `login failed`, and take a screenshot.

## Disconnect / reconnect

Quit Chrome → the next tool call should report `extension_disconnected`. Reopen Chrome → the extension reconnects.

## Safety

The MCP HTTP/WebSocket bridge binds **localhost only**. Grok can see and act on pages for origins you grant. Do **not** Auto-grant untrusted origins.
