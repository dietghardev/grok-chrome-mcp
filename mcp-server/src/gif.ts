import zlib from "node:zlib";

export type DecodedImage = {
  width: number;
  height: number;
  /** Straight RGBA, 8 bits per channel. */
  rgba: Uint8Array;
};

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Enough of a PNG reader for what Page.captureScreenshot emits: 8-bit,
 * non-interlaced, greyscale / truecolour / palette, with or without alpha.
 */
export function decodePng(buffer: Buffer): DecodedImage {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buffer[i] !== PNG_SIGNATURE[i]) throw new Error("Not a PNG file");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === "PLTE") {
      palette = Buffer.from(body);
    } else if (type === "tRNS") {
      transparency = Buffer.from(body);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8) {
    throw new Error(`Unsupported PNG bit depth ${bitDepth}`);
  }
  if (interlace !== 0) throw new Error("Interlaced PNG is not supported");

  const channelsFor: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsFor[colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (PNG spec §9).
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = y * stride;
    const prior = row - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src++];
      const a = x >= channels ? pixels[row + x - channels] : 0;
      const b = y > 0 ? pixels[prior + x] : 0;
      const c = x >= channels && y > 0 ? pixels[prior + x - channels] : 0;
      let out: number;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + a;
          break;
        case 2:
          out = value + b;
          break;
        case 3:
          out = value + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          out = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`Unknown PNG filter ${filter}`);
      }
      pixels[row + x] = out & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (colorType === 0 || colorType === 4) {
      rgba[d] = pixels[s];
      rgba[d + 1] = pixels[s];
      rgba[d + 2] = pixels[s];
      rgba[d + 3] = colorType === 4 ? pixels[s + 1] : 255;
    } else if (colorType === 3) {
      const index = pixels[s];
      const p = palette ? index * 3 : 0;
      rgba[d] = palette ? palette[p] : 0;
      rgba[d + 1] = palette ? palette[p + 1] : 0;
      rgba[d + 2] = palette ? palette[p + 2] : 0;
      rgba[d + 3] = transparency && index < transparency.length
        ? transparency[index]
        : 255;
    } else {
      rgba[d] = pixels[s];
      rgba[d + 1] = pixels[s + 1];
      rgba[d + 2] = pixels[s + 2];
      rgba[d + 3] = colorType === 6 ? pixels[s + 3] : 255;
    }
  }

  return { width, height, rgba };
}

type Box = { colors: number[]; counts: number[] };

function boxBounds(box: Box): { channel: number; range: number } {
  let best = { channel: 0, range: -1 };
  for (let channel = 0; channel < 3; channel++) {
    let min = 255;
    let max = 0;
    for (const color of box.colors) {
      const v = (color >> (8 * (2 - channel))) & 0xff;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = max - min;
    if (range > best.range) best = { channel, range };
  }
  return best;
}

function averageColor(box: Box): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let total = 0;
  for (let i = 0; i < box.colors.length; i++) {
    const count = box.counts[i];
    const color = box.colors[i];
    r += ((color >> 16) & 0xff) * count;
    g += ((color >> 8) & 0xff) * count;
    b += (color & 0xff) * count;
    total += count;
  }
  if (!total) return [0, 0, 0];
  return [Math.round(r / total), Math.round(g / total), Math.round(b / total)];
}

/** Median-cut quantiser: exact colours when an image has 256 or fewer. */
function buildPalette(
  histogram: Map<number, number>,
  max: number,
): [number, number, number][] {
  const colors = [...histogram.keys()];
  if (colors.length <= max) {
    return colors.map((c) => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff]);
  }

  let boxes: Box[] = [
    { colors, counts: colors.map((c) => histogram.get(c) ?? 1) },
  ];
  while (boxes.length < max) {
    let target = -1;
    let widest = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].colors.length < 2) continue;
      const { range } = boxBounds(boxes[i]);
      if (range > widest) {
        widest = range;
        target = i;
      }
    }
    if (target < 0) break;

    const box = boxes[target];
    const { channel } = boxBounds(box);
    const shift = 8 * (2 - channel);
    const order = box.colors
      .map((color, i) => ({ color, count: box.counts[i] }))
      .sort(
        (a, b) => ((a.color >> shift) & 0xff) - ((b.color >> shift) & 0xff),
      );
    const half = Math.floor(order.length / 2) || 1;
    const left = order.slice(0, half);
    const right = order.slice(half);
    boxes.splice(
      target,
      1,
      { colors: left.map((e) => e.color), counts: left.map((e) => e.count) },
      { colors: right.map((e) => e.color), counts: right.map((e) => e.count) },
    );
  }
  return boxes.filter((b) => b.colors.length).map(averageColor);
}

function lzwEncode(indices: Uint8Array, minCodeSize: number): Buffer {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let dictionary = new Map<string, number>();

  const out: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  const emit = (code: number) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  emit(clearCode);
  let prefix = indices.length ? String(indices[0]) : "";
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const combined = prefix + "," + k;
    if (dictionary.has(combined)) {
      prefix = combined;
      continue;
    }
    emit(
      prefix.includes(",")
        ? (dictionary.get(prefix) as number)
        : Number(prefix),
    );
    dictionary.set(combined, nextCode++);
    if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
    if (nextCode === 4096) {
      emit(clearCode);
      dictionary = new Map();
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = String(k);
  }
  if (prefix !== "") {
    emit(
      prefix.includes(",")
        ? (dictionary.get(prefix) as number)
        : Number(prefix),
    );
  }
  emit(endCode);
  if (bitCount > 0) out.push(bitBuffer & 0xff);

  // Payload goes out in sub-blocks of at most 255 bytes.
  const blocks: number[] = [minCodeSize];
  for (let i = 0; i < out.length; i += 255) {
    const slice = out.slice(i, i + 255);
    blocks.push(slice.length, ...slice);
  }
  blocks.push(0);
  return Buffer.from(blocks);
}

export type GifBuffer = Buffer & { frameCount: number; dropped: number };

export type GifOptions = {
  delayMs: number;
  /** Palette ceiling; GIF allows 256. */
  maxColors?: number;
};

/** Encodes PNG frames into one looping animated GIF. */
export function encodeGif(pngFrames: Buffer[], options: GifOptions): GifBuffer {
  if (!pngFrames.length) throw new Error("No frames to encode");

  const decoded: DecodedImage[] = [];
  let dropped = 0;
  let width = 0;
  let height = 0;
  for (const png of pngFrames) {
    const img = decodePng(png);
    if (!decoded.length) {
      width = img.width;
      height = img.height;
    } else if (img.width !== width || img.height !== height) {
      // The window was resized mid-recording; a GIF has one canvas size.
      dropped++;
      continue;
    }
    decoded.push(img);
  }
  if (!decoded.length) throw new Error("No frames to encode");

  const maxColors = Math.min(options.maxColors ?? 256, 256);
  const histogram = new Map<number, number>();
  for (const img of decoded) {
    for (let i = 0; i < img.rgba.length; i += 4) {
      const key = (img.rgba[i] << 16) | (img.rgba[i + 1] << 8) | img.rgba[i + 2];
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
    }
  }
  const palette = buildPalette(histogram, maxColors);

  const cache = new Map<number, number>();
  const indexOf = (r: number, g: number, b: number): number => {
    const key = (r << 16) | (g << 8) | b;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const dr = palette[i][0] - r;
      const dg = palette[i][1] - g;
      const db = palette[i][2] - b;
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
        if (distance === 0) break;
      }
    }
    cache.set(key, best);
    return best;
  };

  let bits = 1;
  while (1 << bits < palette.length) bits++;
  const tableSize = 1 << bits;

  const parts: Buffer[] = [];
  parts.push(Buffer.from("GIF89a", "ascii"));

  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x80 | (bits - 1); // global colour table, its size
  lsd[5] = 0;
  lsd[6] = 0;
  parts.push(lsd);

  const table = Buffer.alloc(tableSize * 3);
  palette.forEach((rgb, i) => {
    table[i * 3] = rgb[0];
    table[i * 3 + 1] = rgb[1];
    table[i * 3 + 2] = rgb[2];
  });
  parts.push(table);

  // Loop forever.
  parts.push(
    Buffer.concat([
      Buffer.from([0x21, 0xff, 0x0b]),
      Buffer.from("NETSCAPE2.0", "ascii"),
      Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
    ]),
  );

  const delay = Math.max(2, Math.round(options.delayMs / 10));
  const minCodeSize = Math.max(2, bits);
  for (const img of decoded) {
    const gce = Buffer.alloc(8);
    gce[0] = 0x21;
    gce[1] = 0xf9;
    gce[2] = 0x04;
    gce[3] = 0x00;
    gce.writeUInt16LE(delay, 4);
    gce[6] = 0;
    gce[7] = 0;
    parts.push(gce);

    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(0, 1);
    descriptor.writeUInt16LE(0, 3);
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    descriptor[9] = 0;
    parts.push(descriptor);

    const indices = new Uint8Array(width * height);
    for (let i = 0; i < indices.length; i++) {
      const s = i * 4;
      indices[i] = indexOf(img.rgba[s], img.rgba[s + 1], img.rgba[s + 2]);
    }
    parts.push(lzwEncode(indices, minCodeSize));
  }

  parts.push(Buffer.from([0x3b]));
  const gif = Buffer.concat(parts) as GifBuffer;
  gif.frameCount = decoded.length;
  gif.dropped = dropped;
  return gif;
}
