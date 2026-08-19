import { describe, expect, it } from "vitest";
import { detectBrowserName, stableBrowserId } from "../../extension/lib/identity.js";

describe("detectBrowserName", () => {
  it("reads Chrome from the brand list", async () => {
    const nav = { userAgentData: { brands: [{ brand: "Google Chrome" }] } };
    expect(await detectBrowserName(nav)).toBe("Chrome");
  });

  it("recognises Edge, Opera, and Vivaldi", async () => {
    const of = (brand: string) => ({ userAgentData: { brands: [{ brand }] } });
    expect(await detectBrowserName(of("Microsoft Edge"))).toBe("Edge");
    expect(await detectBrowserName(of("Opera"))).toBe("Opera");
    expect(await detectBrowserName(of("Vivaldi"))).toBe("Vivaldi");
  });

  it("asks Brave directly, since it brands itself as Chrome", async () => {
    const nav = {
      brave: { isBrave: async () => true },
      userAgentData: { brands: [{ brand: "Google Chrome" }] },
    };
    expect(await detectBrowserName(nav)).toBe("Brave");
  });

  it("falls back to Chrome when nothing identifies the browser", async () => {
    expect(await detectBrowserName({})).toBe("Chrome");
    expect(await detectBrowserName(undefined)).toBe("Chrome");
  });

  it("survives a browser check that throws", async () => {
    const nav = {
      brave: {
        isBrave: async () => {
          throw new Error("nope");
        },
      },
    };
    expect(await detectBrowserName(nav)).toBe("Chrome");
  });
});

describe("stableBrowserId", () => {
  it("reuses the id already in storage", async () => {
    const storage = {
      get: async () => ({ grokBrowserId: "kept" }),
      set: async () => {
        throw new Error("should not write");
      },
    };
    expect(await stableBrowserId(storage)).toBe("kept");
  });

  it("generates and stores an id the first time", async () => {
    const saved: Record<string, unknown>[] = [];
    const storage = {
      get: async () => ({}),
      set: async (v: Record<string, unknown>) => {
        saved.push(v);
      },
    };
    const id = await stableBrowserId(storage);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved[0].grokBrowserId).toBe(id);
  });

  it("still returns an id when storage is unavailable", async () => {
    const storage = {
      get: async () => {
        throw new Error("no storage permission");
      },
      set: async () => undefined,
    };
    const id = await stableBrowserId(storage);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
})
