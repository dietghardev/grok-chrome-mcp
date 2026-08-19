import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startBridge } from "../src/bridge-http.js";
import { BRIDGE_HOST, type Bridge } from "../src/protocol.js";
import { Session } from "../src/session.js";
import { createTools } from "../src/tools.js";

let bridge: Bridge | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  if (bridge) await bridge.close();
  bridge = null;
});

async function connectBrowser(
  port: number,
  browserId: string,
  browserName: string,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://${BRIDGE_HOST}:${port}/ws`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(
    JSON.stringify({
      type: "hello",
      extensionVersion: "0.2.0",
      browserId,
      browserName,
    }),
  );
  await new Promise((r) => setTimeout(r, 30));
  return ws;
}

describe("multiple connected browsers", () => {
  it("lists every connected browser by name", async () => {
    bridge = await startBridge();
    await connectBrowser(bridge.port, "b-chrome", "Chrome");
    await connectBrowser(bridge.port, "b-edge", "Edge");

    const list = bridge.clients();
    expect(list.map((c) => c.name).sort()).toEqual(["Chrome", "Edge"]);
    expect(list.filter((c) => c.active)).toHaveLength(1);
  });

  it("routes commands only to the selected browser", async () => {
    bridge = await startBridge();
    const chrome = await connectBrowser(bridge.port, "b-chrome", "Chrome");
    const edge = await connectBrowser(bridge.port, "b-edge", "Edge");

    const seenByChrome: string[] = [];
    const seenByEdge: string[] = [];
    chrome.on("message", (d) => {
      const m = JSON.parse(String(d));
      seenByChrome.push(m.method);
      chrome.send(JSON.stringify({ id: m.id, ok: true, result: { who: "chrome" } }));
    });
    edge.on("message", (d) => {
      const m = JSON.parse(String(d));
      seenByEdge.push(m.method);
      edge.send(JSON.stringify({ id: m.id, ok: true, result: { who: "edge" } }));
    });

    expect(bridge.select("b-chrome")).toBe(true);
    const r = await bridge.send("page", {});
    expect(r.ok && r.result.who).toBe("chrome");
    expect(seenByChrome).toEqual(["page"]);
    expect(seenByEdge).toEqual([]);
  });

  it("reports an unknown browser id as unselectable", async () => {
    bridge = await startBridge();
    await connectBrowser(bridge.port, "b-chrome", "Chrome");
    expect(bridge.select("b-firefox")).toBe(false);
  });

  it("keeps one browser's in-flight command alive when another disconnects", async () => {
    bridge = await startBridge();
    const chrome = await connectBrowser(bridge.port, "b-chrome", "Chrome");
    const edge = await connectBrowser(bridge.port, "b-edge", "Edge");
    chrome.on("message", (d) => {
      const m = JSON.parse(String(d));
      setTimeout(
        () => chrome.send(JSON.stringify({ id: m.id, ok: true, result: { done: true } })),
        200,
      );
    });

    bridge.select("b-chrome");
    const inFlight = bridge.send("snapshot", {});
    await new Promise((r) => setTimeout(r, 30));
    edge.close();

    const result = await inFlight;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.done).toBe(true);
  });
});

describe("per-browser tab state", () => {
  it("keeps a separate target tab for each browser", () => {
    const s = new Session();
    s.activeBrowserId = "b-chrome";
    s.targetTabId = 11;
    s.activeBrowserId = "b-edge";
    expect(s.targetTabId).toBe(null);
    s.targetTabId = 22;
    s.activeBrowserId = "b-chrome";
    expect(s.targetTabId).toBe(11);
  });

  it("shares granted origins across browsers", () => {
    const s = new Session();
    s.activeBrowserId = "b-chrome";
    s.grant("http://localhost:3000");
    s.activeBrowserId = "b-edge";
    expect(s.isGranted("http://localhost:3000")).toBe(true);
  });

  it("does not leak snapshot refs between browsers", () => {
    const s = new Session();
    s.activeBrowserId = "b-chrome";
    s.rememberSnapshot(5, new Map([["e1", { backendNodeId: 99 }]]));
    s.activeBrowserId = "b-edge";
    expect(s.lookupRef(5, "e1").ok).toBe(false);
  });
});

describe("browser tools", () => {
  it("lists connected browsers and switches the active one", async () => {
    bridge = await startBridge();
    await connectBrowser(bridge.port, "b-chrome", "Chrome");
    await connectBrowser(bridge.port, "b-brave", "Brave");
    const session = new Session();
    const tools = createTools(session, bridge);

    const listed = await tools.browsers();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.browsers.map((b) => b.name).sort()).toEqual([
        "Brave",
        "Chrome",
      ]);
    }

    const picked = await tools.selectBrowser("b-brave");
    expect(picked.ok).toBe(true);
    expect(session.activeBrowserId).toBe("b-brave");
  });

  it("fails to select a browser that is not connected", async () => {
    bridge = await startBridge();
    await connectBrowser(bridge.port, "b-chrome", "Chrome");
    const tools = createTools(new Session(), bridge);
    const r = await tools.selectBrowser("b-safari");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("extension_disconnected");
  });

  it("follows the connected browser without an explicit select", async () => {
    bridge = await startBridge();
    await connectBrowser(bridge.port, "b-chrome", "Chrome");
    const session = new Session();
    const tools = createTools(session, bridge);
    await tools.browsers();
    expect(session.activeBrowserId).toBe("b-chrome");
  });
});
