import { describe, expect, it } from "vitest";
import { Session } from "../src/session.js";

describe("Session grants", () => {
  it("stores URL.origin and lists the allowlist", () => {
    const s = new Session();
    const r = s.grant("https://github.com/foo");
    expect(r).toEqual({ ok: true, granted: ["https://github.com"] });
    expect(s.isGranted("https://github.com")).toBe(true);
    expect(s.isGranted("http://localhost:3000")).toBe(false);
  });

  it("does not treat different ports as granted", () => {
    const s = new Session();
    s.grant("http://localhost:3000");
    expect(s.requireGrant("http://localhost:5173").ok).toBe(false);
    const denied = s.requireGrant("http://localhost:5173");
    if (!denied.ok) {
      expect(denied.code).toBe("needs_permission");
      expect(denied.origin).toBe("http://localhost:5173");
    }
    expect(s.requireGrant("http://localhost:3000").ok).toBe(true);
  });

  it("returns invalid_origin on garbage grant", () => {
    const s = new Session();
    const r = s.grant("nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_origin");
  });
});

describe("Session snapshot refs", () => {
  it("invalidates old refs after a new snapshot", () => {
    const s = new Session();
    s.rememberSnapshot(1, new Map([["e1", { backendNodeId: 10 }]]));
    expect(s.lookupRef(1, "e1").ok).toBe(true);
    s.rememberSnapshot(1, new Map([["e1", { backendNodeId: 11 }]]));
    const stale = s.lookupRef(1, "e2");
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("stale_ref");
  });
});

describe("Session enqueue", () => {
  it("runs jobs one at a time in order", async () => {
    const s = new Session();
    const order: number[] = [];
    const slow = s.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
      return "a";
    });
    const fast = s.enqueue(async () => {
      order.push(2);
      return "b";
    });
    expect(await Promise.all([slow, fast])).toEqual(["a", "b"]);
    expect(order).toEqual([1, 2]);
  });
});
