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
