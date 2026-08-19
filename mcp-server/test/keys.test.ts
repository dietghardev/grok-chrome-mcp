import { describe, expect, it } from "vitest";
import { parseKey } from "../../extension/lib/keys.js";

describe("parseKey", () => {
  it("maps Enter to its virtual key code and carriage return text", () => {
    expect(parseKey("Enter")).toEqual({
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      modifiers: 0,
      text: "\r",
    });
  });

  it("maps a printable letter to its KeyA-style code", () => {
    expect(parseKey("a")).toEqual({
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: 0,
      text: "a",
    });
  });

  it("treats an uppercase letter as shifted", () => {
    const k = parseKey("A");
    expect(k?.text).toBe("A");
    expect(k?.code).toBe("KeyA");
    expect(k?.modifiers).toBe(8);
  });

  it("maps digits to Digit codes", () => {
    expect(parseKey("1")?.code).toBe("Digit1");
    expect(parseKey("1")?.windowsVirtualKeyCode).toBe(49);
  });

  it("combines modifiers into the CDP bitmask", () => {
    // Alt 1, Control 2, Meta 4, Shift 8
    expect(parseKey("Control+a")?.modifiers).toBe(2);
    expect(parseKey("Meta+Shift+p")?.modifiers).toBe(12);
    expect(parseKey("Alt+Control+Delete")?.modifiers).toBe(3);
  });

  it("drops the text payload when a non-shift modifier is held", () => {
    expect(parseKey("Control+a")?.text).toBeUndefined();
    expect(parseKey("Shift+a")?.text).toBe("a");
  });

  it("accepts navigation and editing keys", () => {
    expect(parseKey("ArrowDown")?.windowsVirtualKeyCode).toBe(40);
    expect(parseKey("Backspace")?.windowsVirtualKeyCode).toBe(8);
    expect(parseKey("Escape")?.windowsVirtualKeyCode).toBe(27);
    expect(parseKey("PageUp")?.windowsVirtualKeyCode).toBe(33);
    expect(parseKey("Tab")?.text).toBe("\t");
  });

  it("is case-insensitive for named keys and modifiers", () => {
    expect(parseKey("enter")?.key).toBe("Enter");
    expect(parseKey("CTRL+a")?.modifiers).toBe(2);
    expect(parseKey("cmd+c")?.modifiers).toBe(4);
  });

  it("rejects an unknown key name", () => {
    expect(parseKey("Frobnicate")).toBe(null);
    expect(parseKey("")).toBe(null);
  });
});
