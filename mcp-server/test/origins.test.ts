import { describe, expect, it } from "vitest";
import { isBlockedUrl, parseOrigin } from "../src/origins.js";

describe("parseOrigin", () => {
  it("parses a URL into origin", () => {
    const r = parseOrigin("https://github.com/xai-org/grok-build");
    expect(r).toEqual({ ok: true, origin: "https://github.com" });
  });

  it("accepts an origin string", () => {
    const r = parseOrigin("http://localhost:3000");
    expect(r).toEqual({ ok: true, origin: "http://localhost:3000" });
  });

  it("treats localhost and 127.0.0.1 as different", () => {
    const a = parseOrigin("http://localhost:3000");
    const b = parseOrigin("http://127.0.0.1:3000");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.origin).not.toBe(b.origin);
  });

  it("treats different ports as different", () => {
    const a = parseOrigin("http://localhost:3000");
    const b = parseOrigin("http://localhost:5173");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.origin).not.toBe(b.origin);
  });

  it("returns invalid_origin for garbage", () => {
    const r = parseOrigin("not a url");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_origin");
  });
});

describe("isBlockedUrl", () => {
  it("blocks chrome, extension, edge, and web store", () => {
    expect(isBlockedUrl("chrome://extensions")).toBe(true);
    expect(isBlockedUrl("chrome-extension://abcdef/popup.html")).toBe(true);
    expect(isBlockedUrl("edge://settings")).toBe(true);
    expect(isBlockedUrl("https://chrome.google.com/webstore/detail/x")).toBe(true);
    expect(isBlockedUrl("https://chromewebstore.google.com/detail/x")).toBe(true);
  });

  it("blocks about: except about:blank", () => {
    expect(isBlockedUrl("about:blank")).toBe(false);
    expect(isBlockedUrl("about:config")).toBe(true);
  });

  it("allows http(s)", () => {
    expect(isBlockedUrl("http://localhost:3000/login")).toBe(false);
    expect(isBlockedUrl("https://github.com")).toBe(false);
  });
});
