import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startBridge } from "../src/bridge-http.js";
import { screenshotContent } from "../src/content.js";
import { BRIDGE_HOST } from "../src/protocol.js";
import { Session } from "../src/session.js";
import { createTools } from "../src/tools.js";
import type { Bridge, WsResponse } from "../src/protocol.js";

function bridgeReturning(result: Record<string, unknown>): Bridge {
  return {
    port: 17352,
    isConnected: () => true,
    waitForConnection: async () => true,
    close: async () => undefined,
    clients: () => [],
    select: () => false,
    activeBrowserId: () => null,
    onBrowserGone: () => undefined,
    send: async () => ({ id: "x", ok: true, result }) satisfies WsResponse,
  };
}

describe("screenshot MCP content", () => {
  it("keeps base64 pixels out of the text block", () => {
    const content = screenshotContent({
      ok: true,
      data: "AAAABBBBCCCC",
      width: 800,
      height: 600,
    });
    const text = content.find((c) => c.type === "text");
    expect(text?.type === "text" && text.text).not.toContain("AAAABBBBCCCC");
    expect(text?.type === "text" && text.text).toContain("800");
    const image = content.find((c) => c.type === "image");
    expect(image?.type === "image" && image.data).toBe("AAAABBBBCCCC");
  });

  it("passes an error result through as text only", () => {
    const content = screenshotContent({
      ok: false,
      code: "no_tab",
      message: "No target tab.",
    });
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });
});

describe("bridge port binding", () => {
  it("falls through to the next port when one is already taken", async () => {
    const first = await startBridge();
    const second = await startBridge();
    expect(second.port).toBe(first.port + 1);
    await first.close();
    await second.close();
  });
});

describe("bridge disconnect handling", () => {
  it("fails in-flight commands as soon as the extension socket closes", async () => {
    const bridge = await startBridge();
    const client = new WebSocket(`ws://${BRIDGE_HOST}:${bridge.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });
    expect(await bridge.waitForConnection(1000)).toBe(true);

    const inFlight = bridge.send("navigate", { url: "http://localhost:3000" });
    await new Promise((r) => setTimeout(r, 20));
    client.close();

    const settled = await Promise.race([
      inFlight,
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 2000)),
    ]);
    expect(settled).not.toBe("hung");
    expect(settled !== "hung" && settled.ok).toBe(false);
    if (settled !== "hung" && !settled.ok) {
      expect(settled.error.code).toBe("extension_disconnected");
    }
    await bridge.close();
  });
});

describe("chrome_use_tab safety", () => {
  it("refuses to target a browser-internal tab", async () => {
    const session = new Session();
    const tools = createTools(
      session,
      bridgeReturning({ tabId: 4, url: "chrome://settings", title: "Settings" }),
    );
    const r = await tools.useTab(4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("blocked_origin");
    expect(session.targetTabId).toBe(null);
  });
});
