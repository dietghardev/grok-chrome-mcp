import { describe, expect, it } from "vitest";
import type { Bridge, WsResponse } from "../src/protocol.js";
import { Session } from "../src/session.js";
import { createTools } from "../src/tools.js";

type Call = { method: string; params: Record<string, unknown> };

function bridgeSpy(
  calls: Call[],
  results: Record<string, Record<string, unknown>> = {},
  pageUrl = "http://localhost:3000/app",
): Bridge {
  return {
    port: 17352,
    isConnected: () => true,
    waitForConnection: async () => true,
    close: async () => undefined,
    clients: () => [],
    select: () => false,
    activeBrowserId: () => null,
    onBrowserGone: () => undefined,
    send: async (method, params) => {
      calls.push({ method, params: params ?? {} });
      if (method === "page") {
        return {
          id: "x",
          ok: true,
          result: { tabId: 7, url: pageUrl, title: "App" },
        } satisfies WsResponse;
      }
      return { id: "x", ok: true, result: results[method] ?? {} };
    },
  };
}

function grantedSession(): Session {
  const s = new Session();
  s.grant("http://localhost:3000");
  s.targetTabId = 7;
  s.rememberSnapshot(7, new Map([["e1", { backendNodeId: 42 }]]));
  return s;
}

describe("pointer tools", () => {
  it("hover needs a grant before touching the page", async () => {
    const calls: Call[] = [];
    const s = new Session();
    s.targetTabId = 7;
    s.rememberSnapshot(7, new Map([["e1", { backendNodeId: 42 }]]));
    const r = await createTools(s, bridgeSpy(calls)).hover("e1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("needs_permission");
    expect(calls.map((c) => c.method)).toEqual(["page"]);
  });

  it("hover sends the resolved node once granted", async () => {
    const calls: Call[] = [];
    const r = await createTools(grantedSession(), bridgeSpy(calls)).hover("e1");
    expect(r.ok).toBe(true);
    const hover = calls.find((c) => c.method === "hover");
    expect(hover?.params.backendNodeId).toBe(42);
  });

  it("drag resolves both ends to node ids", async () => {
    const calls: Call[] = [];
    const s = grantedSession();
    s.rememberSnapshot(
      7,
      new Map([
        ["e1", { backendNodeId: 42 }],
        ["e2", { backendNodeId: 43 }],
      ]),
    );
    const r = await createTools(s, bridgeSpy(calls)).drag("e1", "e2");
    expect(r.ok).toBe(true);
    const drag = calls.find((c) => c.method === "drag");
    expect(drag?.params).toMatchObject({ backendNodeId: 42, toBackendNodeId: 43 });
  });

  it("drag reports a stale target ref without sending", async () => {
    const calls: Call[] = [];
    const r = await createTools(grantedSession(), bridgeSpy(calls)).drag("e1", "e9");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("stale_ref");
    expect(calls.some((c) => c.method === "drag")).toBe(false);
  });
});

describe("keyboard tool", () => {
  it("press needs a grant", async () => {
    const calls: Call[] = [];
    const s = new Session();
    s.targetTabId = 7;
    const r = await createTools(s, bridgeSpy(calls)).press("Enter");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("needs_permission");
  });

  it("press forwards the key combination", async () => {
    const calls: Call[] = [];
    const r = await createTools(grantedSession(), bridgeSpy(calls)).press(
      "Control+Shift+K",
    );
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c.method === "press")?.params.key).toBe(
      "Control+Shift+K",
    );
  });
});

describe("form tools", () => {
  it("selectOption forwards the requested values", async () => {
    const calls: Call[] = [];
    const r = await createTools(grantedSession(), bridgeSpy(calls)).selectOption(
      "e1",
      ["blue"],
    );
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c.method === "selectOption")?.params.values).toEqual([
      "blue",
    ]);
  });

  it("uploadFile needs a grant and forwards absolute paths", async () => {
    const calls: Call[] = [];
    const denied = new Session();
    denied.targetTabId = 7;
    denied.rememberSnapshot(7, new Map([["e1", { backendNodeId: 42 }]]));
    const blocked = await createTools(denied, bridgeSpy(calls)).uploadFile("e1", [
      "/tmp/a.png",
    ]);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("needs_permission");

    const r = await createTools(grantedSession(), bridgeSpy(calls)).uploadFile(
      "e1",
      ["/tmp/a.png"],
    );
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c.method === "uploadFile")?.params.paths).toEqual([
      "/tmp/a.png",
    ]);
  });
});

describe("history and window tools", () => {
  it("back needs a grant for the current origin", async () => {
    const calls: Call[] = [];
    const s = new Session();
    s.targetTabId = 7;
    const r = await createTools(s, bridgeSpy(calls)).back();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("needs_permission");
  });

  it("reload sends once granted", async () => {
    const calls: Call[] = [];
    const r = await createTools(grantedSession(), bridgeSpy(calls)).reload();
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.method === "reload")).toBe(true);
  });

  it("resize is a window action and needs no grant", async () => {
    const calls: Call[] = [];
    const s = new Session();
    s.targetTabId = 7;
    const r = await createTools(s, bridgeSpy(calls)).resize(1280, 800);
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c.method === "resize")?.params).toMatchObject({
      width: 1280,
      height: 800,
    });
  });
});

describe("tab closing", () => {
  it("closes the target tab and forgets it", async () => {
    const calls: Call[] = [];
    const s = grantedSession();
    s.markGrokTab(7);
    const r = await createTools(s, bridgeSpy(calls)).closeTab();
    expect(r.ok).toBe(true);
    expect(s.targetTabId).toBe(null);
    expect(calls.find((c) => c.method === "closeTab")?.params.tabId).toBe(7);
  });

  it("needs a grant to close a tab Grok did not open", async () => {
    const calls: Call[] = [];
    const s = new Session();
    s.targetTabId = 7;
    const r = await createTools(s, bridgeSpy(calls)).closeTab(7);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("needs_permission");
  });
});

describe("read-only page tools", () => {
  it("get page text needs no grant", async () => {
    const calls: Call[] = [];
    const s = new Session();
    s.targetTabId = 7;
    const tools = createTools(s, bridgeSpy(calls, { text: { text: "Hello" } }));
    const r = await tools.pageText();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("Hello");
  });

  it("find needs no grant and leaves its refs clickable", async () => {
    const calls: Call[] = [];
    const s = new Session();
    s.grant("http://localhost:3000");
    s.targetTabId = 7;
    const tools = createTools(
      s,
      bridgeSpy(calls, {
        find: {
          text: '[e3] button "Sign in"',
          matches: 1,
          refs: { e3: { backendNodeId: 77 } },
        },
      }),
    );
    const found = await tools.find("sign");
    expect(found.ok).toBe(true);

    const clicked = await tools.click("e3");
    expect(clicked.ok).toBe(true);
    expect(calls.find((c) => c.method === "click")?.params.backendNodeId).toBe(77);
  });

  it("waitFor needs no grant and forwards the condition", async () => {
    const calls: Call[] = [];
    const s = new Session();
    s.targetTabId = 7;
    const r = await createTools(s, bridgeSpy(calls)).waitFor({
      text: "Welcome",
      timeoutMs: 5000,
    });
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c.method === "waitFor")?.params).toMatchObject({
      text: "Welcome",
      timeoutMs: 5000,
    });
  });
});

describe("javascript tool", () => {
  it("refuses to evaluate without a grant", async () => {
    const calls: Call[] = [];
    const s = new Session();
    s.targetTabId = 7;
    const r = await createTools(s, bridgeSpy(calls)).evaluate("1 + 1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("needs_permission");
    expect(calls.some((c) => c.method === "evaluate")).toBe(false);
  });

  it("returns the evaluated value once granted", async () => {
    const calls: Call[] = [];
    const tools = createTools(
      grantedSession(),
      bridgeSpy(calls, { evaluate: { value: 2 } }),
    );
    const r = await tools.evaluate("1 + 1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(2);
  });

  it("does not evaluate on about:blank even without needing a grant for clicks", async () => {
    const calls: Call[] = [];
    const s = new Session();
    s.targetTabId = 7;
    const r = await createTools(s, bridgeSpy(calls, {}, "about:blank")).evaluate(
      "1 + 1",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_input");
    expect(calls.some((c) => c.method === "evaluate")).toBe(false);
  });
});

describe("batch", () => {
  it("runs actions in order and reports each result", async () => {
    const calls: Call[] = [];
    const tools = createTools(grantedSession(), bridgeSpy(calls));
    const r = await tools.batch([
      { tool: "click", ref: "e1" },
      { tool: "press", key: "Enter" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results).toHaveLength(2);
    expect(calls.map((c) => c.method).filter((m) => m !== "page")).toEqual([
      "click",
      "press",
    ]);
  });

  it("stops at the first failing action", async () => {
    const calls: Call[] = [];
    const s = new Session();
    s.targetTabId = 7;
    s.rememberSnapshot(7, new Map([["e1", { backendNodeId: 42 }]]));
    const tools = createTools(s, bridgeSpy(calls));
    const r = await tools.batch([
      { tool: "click", ref: "e1" },
      { tool: "press", key: "Enter" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("needs_permission");
    expect(calls.some((c) => c.method === "press")).toBe(false);
  });

  it("rejects an unknown action name", async () => {
    const calls: Call[] = [];
    const tools = createTools(grantedSession(), bridgeSpy(calls));
    const r = await tools.batch([{ tool: "teleport" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_input");
  });
});

describe("shadow mouse", () => {
  it("toggles the cursor overlay without needing a grant", async () => {
    const calls: Call[] = [];
    const s = new Session();
    s.targetTabId = 7;
    const r = await createTools(s, bridgeSpy(calls)).cursor(false);
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c.method === "cursor")?.params).toMatchObject({
      show: false,
      tabId: 7,
    });
  });
});
