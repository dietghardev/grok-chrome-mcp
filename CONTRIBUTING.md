# Contributing

Thanks for looking. Issues and pull requests are welcome.

## Layout

```
extension/          unpacked MV3 extension (vanilla JS, no bundler)
  background.js     service worker: bridge connection + CDP command handlers
  lib/              pure logic, unit-tested from mcp-server/test
mcp-server/         the MCP server Grok spawns
  src/tools.ts      tool handlers, permission gates
  src/bridge-http.ts  localhost HTTP + WebSocket bridge
  test/             vitest suites, smoke, and the end-to-end pass
  fixture/          the page the manual and e2e passes drive
```

## Running things

```bash
cd mcp-server
npm install
npm test        # unit tests
npm run smoke   # bridge protocol + MCP stdio surface, no browser needed
npm run build
```

Pull requests run that same trio on GitHub Actions.

End-to-end against a real browser, with the extension loaded:

```bash
E2E_USE_CONNECTED=1 npm run e2e
```

**After editing anything in `extension/`, hit reload (↻) on the card at
`chrome://extensions`.** The e2e refuses to run against a stale copy and will
tell you so, but a manual session will silently keep using the old code.

## Tests come first

This project is test-driven. Write the failing test, watch it fail for the
right reason, then make it pass. The bugs worth catching here — a bridge that
crashed instead of trying the next port, a handshake swallowed by a failed
browser check — were all found by tests or by the end-to-end pass, not by
reading the code.

Logic that can be tested without a browser belongs in `extension/lib/` or
`mcp-server/src/`, not inline in the service worker.

## Adding a tool

1. A test in `mcp-server/test/` for the permission gate and the wire call.
2. The handler in `src/tools.ts`.
3. The `case` in `background.js`.
4. `server.registerTool` in `src/index.ts`, with a description that says
   whether it needs a grant.
5. The tool name in `test/smoke.ts`'s expected list — it fails if you forget.
6. A row in the README table.

## Style

Match what is already there: no bundler in the extension, no dependencies added
without a reason, comments that explain why rather than what.
