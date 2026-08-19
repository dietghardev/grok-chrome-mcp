import { describe, expect, it } from "vitest";
import { Session } from "../src/session.js";
import { createTools } from "../src/tools.js";
import type { Bridge, WsResponse } from "../src/protocol.js";

function fakeBridge(
  record: string[],
  pageUrl = "http://localhost:3000/login",
): Bridge {
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
          result: { tabId: 7, url: pageUrl, title: "Login" },
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
    expect(calls).toEqual(["newTab", "navigate"]);
  });

  it("chrome_navigate uses the existing target tab", async () => {
    const calls: string[] = [];
    const session = new Session();
    session.grant("http://localhost:3000");
    session.targetTabId = 7;
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

describe("blocked origins and about:blank", () => {
  it("screenshot does not send when the page origin is blocked", async () => {
    const calls: string[] = [];
    const session = new Session();
    session.targetTabId = 7;
    const tools = createTools(session, fakeBridge(calls, "chrome://extensions"));
    const r = await tools.screenshot();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("blocked_origin");
    expect(calls).toEqual(["page"]);
  });

  it("navigate to about:blank does not need a grant", async () => {
    const calls: string[] = [];
    const tools = createTools(new Session(), fakeBridge(calls));
    const r = await tools.navigate("about:blank");
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["newTab", "navigate"]);
  });

  it("new tab at about:blank does not need a grant", async () => {
    const calls: string[] = [];
    const tools = createTools(new Session(), fakeBridge(calls));
    const r = await tools.newTab("about:blank");
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["newTab"]);
  });

  it("click on about:blank does not need a grant", async () => {
    const calls: string[] = [];
    const session = new Session();
    session.targetTabId = 7;
    session.rememberSnapshot(7, new Map([["e1", { backendNodeId: 99 }]]));
    const tools = createTools(session, fakeBridge(calls, "about:blank"));
    const r = await tools.click("e1");
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["page", "click"]);
  });
});

describe("closed target tab", () => {
  it("page no_tab clears the target so navigate opens a new tab", async () => {
    const calls: string[] = [];
    const session = new Session();
    session.grant("http://localhost:3000");
    session.targetTabId = 7;
    session.markGrokTab(7);
    const bridge: Bridge = {
      port: 17352,
      isConnected: () => true,
      waitForConnection: async () => true,
      close: async () => undefined,
      send: async (method, params) => {
        calls.push(method);
        if (method === "page") {
          return {
            id: "x",
            ok: false,
            error: { code: "no_tab", message: "Tab 7 not found" },
          } satisfies WsResponse;
        }
        if (method === "newTab") {
          return {
            id: "x",
            ok: true,
            result: { tabId: 8, url: params?.url ?? "about:blank", title: "" },
          };
        }
        return {
          id: "x",
          ok: true,
          result: { tabId: 8, url: "http://localhost:3000/", title: "" },
        };
      },
    };
    const tools = createTools(session, bridge);

    const missing = await tools.page();
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("no_tab");
    expect(session.targetTabId).toBeNull();
    expect(session.isGrokTab(7)).toBe(false);

    const r = await tools.navigate("http://localhost:3000/");
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["page", "newTab", "navigate"]);
    expect(session.targetTabId).toBe(8);
  });
});
