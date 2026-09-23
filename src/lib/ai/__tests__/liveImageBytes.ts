/**
 * Width × height read off a generated picture's bytes — shared by the live
 * image probes, because the one thing a framing request can be checked against
 * is the bytes, never the endpoint's own claim about them.
 */
import { deflateSync, inflateSync } from "node:zlib";
import type { GeneratedImage } from "../image";

export function dimensions(img: GeneratedImage): { w: number; h: number; mime: string } {
  const b = Uint8Array.from(atob(img.dataUrl.slice(img.dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  if (b[0] === 0x89 && b[1] === 0x50) return { w: u32(16), h: u32(20), mime: "image/png" };
  if (b[0] === 0xff && b[1] === 0xd8) {
    // Walk the segments to the first SOF marker.
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: u16(i + 7), h: u16(i + 5), mime: "image/jpeg" };
      }
      i += 2 + u16(i + 2);
    }
  }
  throw new Error(`unrecognised image bytes: ${Array.from(b.slice(0, 4)).map((x) => x.toString(16)).join(" ")}`);
}

// ─── Transparency (the Seedream `background: "transparent"` probes) ──────────


function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * A `size`×`size` 8-bit PNG as a data URL: a red disc on a fully transparent
 * field (RGBA), or the same disc on white with no alpha channel at all (RGB).
 */
export function discPng(size: number, alpha: boolean): string {
  const bpp = alpha ? 4 : 3;
  const raw = new Uint8Array(size * (1 + size * bpp));
  const r = size * 0.3;
  for (let y = 0, p = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const inside = (x - size / 2) ** 2 + (y - size / 2) ** 2 < r * r;
      const px = inside ? [0xe0, 0x20, 0x20, 0xff] : alpha ? [0, 0, 0, 0] : [0xff, 0xff, 0xff];
      raw.set(px.slice(0, bpp), p);
      p += bpp;
    }
  }
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, size);
  new DataView(ihdr.buffer).setUint32(4, size);
  ihdr.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  return `data:image/png;base64,${Buffer.concat(parts).toString("base64")}`;
}

/** How many pixels of an 8-bit RGBA PNG are fully transparent; 0 for anything else. */
export function fullyTransparentPixels(img: GeneratedImage): number {
  const b = Buffer.from(img.dataUrl.slice(img.dataUrl.indexOf(",") + 1), "base64");
  if (b[0] !== 0x89 || b[25] !== 6 || b[24] !== 8) return 0;
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  const idat: Buffer[] = [];
  for (let i = 8; i < b.length; ) {
    const len = b.readUInt32BE(i);
    if (b.toString("latin1", i + 4, i + 8) === "IDAT") idat.push(b.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  let prev = new Uint8Array(stride);
  let count = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? line[i - 4] : 0;
      const up = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      const pred = filter === 1 ? a
        : filter === 2 ? up
        : filter === 3 ? (a + up) >> 1
        : filter === 4 ? (() => {
          const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c);
          return pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
        })()
        : 0;
      line[i] = (line[i] + pred) & 0xff;
    }
    for (let i = 3; i < stride; i += 4) if (line[i] === 0) count++;
    prev = line;
  }
  return count;
}
