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

// --- MCP stdio surface -------------------------------------------------------
// Registration errors (duplicate names, bad schemas) only show up when a real
// client connects, so drive dist/index.js the way Grok does.
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import(
  "@modelcontextprotocol/sdk/client/stdio.js"
);

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../dist/index.js", import.meta.url).pathname],
  }),
);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const expected = [
  "chrome_back",
  "chrome_batch",
  "chrome_browsers",
  "chrome_click",
  "chrome_close_tab",
  "chrome_console",
  "chrome_cursor",
  "chrome_drag",
  "chrome_evaluate",
  "chrome_fill",
  "chrome_find",
  "chrome_forward",
  "chrome_grant_site",
  "chrome_hover",
  "chrome_navigate",
  "chrome_network",
  "chrome_new_tab",
  "chrome_page",
  "chrome_press",
  "chrome_reload",
  "chrome_resize",
  "chrome_revoke_site",
  "chrome_screenshot",
  "chrome_scroll",
  "chrome_select_browser",
  "chrome_select_option",
  "chrome_snapshot",
  "chrome_tabs",
  "chrome_text",
  "chrome_type",
  "chrome_upload_file",
  "chrome_use_tab",
  "chrome_wait_for",
];
assert.deepEqual(names, expected, `tool list drifted:\n${names.join("\n")}`);

// With no extension attached, a read-only tool must report the disconnect
// rather than hanging or throwing.
const disconnected = await client.callTool({ name: "chrome_tabs", arguments: {} });
const block = (disconnected.content as Array<{ type: string; text: string }>)[0];
assert.equal(block.type, "text");
assert.equal(JSON.parse(block.text).code, "extension_disconnected");

await client.close();
console.log(`mcp ok (${names.length} tools)`);
