import { describe, expect, it } from "vitest";
import { decodePng, encodeGif } from "../src/gif.js";
import { buildPng, solid } from "./pngbuild.js";

const RED: [number, number, number] = [220, 30, 40];
const BLUE: [number, number, number] = [20, 60, 200];

describe("decodePng", () => {
  it("round-trips an RGBA image", () => {
    const png = buildPng(3, 2, solid(3, 2, RED));
    const img = decodePng(png);
    expect(img.width).toBe(3);
    expect(img.height).toBe(2);
    expect([img.rgba[0], img.rgba[1], img.rgba[2], img.rgba[3]]).toEqual([
      ...RED,
      255,
    ]);
  });

  it("reads a truecolour image with no alpha channel", () => {
    const png = buildPng(2, 2, solid(2, 2, BLUE), 2);
    const img = decodePng(png);
    expect(img.width).toBe(2);
    expect([img.rgba[0], img.rgba[1], img.rgba[2], img.rgba[3]]).toEqual([
      ...BLUE,
      255,
    ]);
  });

  it("reconstructs rows written with the Sub and Up filters", () => {
    // A gradient exercises the filter paths that a solid colour cannot.
    const w = 8;
    const h = 4;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = x * 30;
        rgba[i + 1] = y * 60;
        rgba[i + 2] = 128;
        rgba[i + 3] = 255;
      }
    }
    const img = decodePng(buildPng(w, h, rgba));
    expect(Array.from(img.rgba)).toEqual(Array.from(rgba));
  });

  it("rejects a file that is not a PNG", () => {
    expect(() => decodePng(Buffer.from("nope"))).toThrow(/png/i);
  });
});

describe("encodeGif", () => {
  const frameA = buildPng(4, 4, solid(4, 4, RED));
  const frameB = buildPng(4, 4, solid(4, 4, BLUE));

  it("writes a looping GIF89a with one block per frame", () => {
    const gif = encodeGif([frameA, frameB], { delayMs: 500 });
    expect(gif.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    expect(gif.readUInt16LE(6)).toBe(4);
    expect(gif.readUInt16LE(8)).toBe(4);
    expect(gif[gif.length - 1]).toBe(0x3b);
    expect(gif.includes(Buffer.from("NETSCAPE2.0", "ascii"))).toBe(true);
    const separators = gif.filter((b) => b === 0x2c).length;
    expect(separators).toBeGreaterThanOrEqual(2);
  });

  it("keeps both frame colours in the palette", () => {
    const gif = encodeGif([frameA, frameB], { delayMs: 100 });
    const paletteStart = 13;
    const palette = gif.subarray(paletteStart, paletteStart + 256 * 3);
    const has = (rgb: [number, number, number]) => {
      for (let i = 0; i + 2 < palette.length; i += 3) {
        if (
          palette[i] === rgb[0] &&
          palette[i + 1] === rgb[1] &&
          palette[i + 2] === rgb[2]
        ) {
          return true;
        }
      }
      return false;
    };
    expect(has(RED)).toBe(true);
    expect(has(BLUE)).toBe(true);
  });

  it("encodes the delay in hundredths of a second", () => {
    const gif = encodeGif([frameA], { delayMs: 500 });
    const gce = gif.indexOf(Buffer.from([0x21, 0xf9, 0x04]));
    expect(gce).toBeGreaterThan(0);
    expect(gif.readUInt16LE(gce + 4)).toBe(50);
  });

  it("drops frames that do not match the first frame's size", () => {
    const odd = buildPng(2, 2, solid(2, 2, BLUE));
    const gif = encodeGif([frameA, odd, frameB], { delayMs: 100 });
    expect(gif.readUInt16LE(6)).toBe(4);
    expect(gif.frameCount).toBe(2);
    expect(gif.dropped).toBe(1);
  });

  it("refuses to encode nothing", () => {
    expect(() => encodeGif([], { delayMs: 100 })).toThrow(/frame/i);
  });

  it("quantises an image with more than 256 colours", () => {
    const w = 40;
    const h = 40;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = i % 256;
      rgba[i * 4 + 1] = (i * 7) % 256;
      rgba[i * 4 + 2] = (i * 13) % 256;
      rgba[i * 4 + 3] = 255;
    }
    const gif = encodeGif([buildPng(w, h, rgba)], { delayMs: 100 });
    expect(gif.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    expect(gif[gif.length - 1]).toBe(0x3b);
  });
});
