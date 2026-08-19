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
