/**
 * The header reader is a fast path with an authority it must not claim: every
 * picture on its way to a model asks it "do you already fit?", and a wrong
 * answer either wastes a decode or sends something oversized. The formats are
 * fixed-layout, so the fixtures here are hand-built headers rather than real
 * files — what is being pinned is the offset arithmetic.
 */
import { describe, expect, it } from "vitest";
import { readImageHeader } from "../image/imageSize";

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];

function png(w: number, h: number, colorType: number): Uint8Array {
  return new Uint8Array([
    0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), ...ascii("IHDR"),
    ...be32(w), ...be32(h),
    8, colorType, 0, 0, 0,
  ]);
}

function jpeg(w: number, h: number, opts: { withApp0?: boolean } = {}): Uint8Array {
  const app0 = opts.withApp0
    ? [0xff, 0xe0, ...be16(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]
    : [];
  return new Uint8Array([
    0xff, 0xd8,
    ...app0,
    0xff, 0xc0, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1,
  ]);
}

function gif(w: number, h: number): Uint8Array {
  return new Uint8Array([...ascii("GIF89a"), ...le16(w), ...le16(h), 0, 0, 0]);
}

function webpVp8x(w: number, h: number, flags: number): Uint8Array {
  return new Uint8Array([
    ...ascii("RIFF"), ...be32(0), ...ascii("WEBP"),
    ...ascii("VP8X"), ...be32(10),
    flags, 0, 0, 0,
    ...le24(w - 1), ...le24(h - 1),
  ]);
}

describe("readImageHeader", () => {
  it("reads PNG dimensions and reports alpha from the colour type", () => {
    expect(readImageHeader(png(4032, 3024, 2))).toEqual({
      width: 4032, height: 3024, animated: false, alpha: false,
    });
    // 6 = RGBA, 4 = grey+alpha, 3 = palette (which may carry tRNS)
    for (const ct of [6, 4, 3]) expect(readImageHeader(png(10, 10, ct))?.alpha).toBe(true);
    for (const ct of [0, 2]) expect(readImageHeader(png(10, 10, ct))?.alpha).toBe(false);
  });

  it("reads JPEG dimensions from the frame header, past other segments", () => {
    expect(readImageHeader(jpeg(4032, 3024))).toEqual({
      width: 4032, height: 3024, animated: false, alpha: false,
    });
    // The APP0 that every camera writes must be skipped by its length, not
    // scanned through — a byte pair inside it can look like any marker.
    expect(readImageHeader(jpeg(1920, 1080, { withApp0: true }))).toMatchObject({
      width: 1920, height: 1080,
    });
  });

  it("treats every GIF as animated", () => {
    // Flattening one to a single frame is the failure this prevents, and
    // proving a GIF is still costs a walk of the block chain.
    expect(readImageHeader(gif(500, 400))).toEqual({
      width: 500, height: 400, animated: true, alpha: true,
    });
  });

  it("reads WebP's extended header, including its animation and alpha flags", () => {
    expect(readImageHeader(webpVp8x(2000, 1000, 0))).toMatchObject({
      width: 2000, height: 1000, animated: false, alpha: false,
    });
    expect(readImageHeader(webpVp8x(64, 64, 0x02))?.animated).toBe(true);
    expect(readImageHeader(webpVp8x(64, 64, 0x10))?.alpha).toBe(true);
  });

  it("reads lossy and lossless WebP", () => {
    const vp8 = new Uint8Array([
      ...ascii("RIFF"), ...be32(0), ...ascii("WEBP"), ...ascii("VP8 "), ...be32(0),
      0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(800), ...le16(600),
    ]);
    expect(readImageHeader(vp8)).toMatchObject({ width: 800, height: 600, alpha: false });

    // 14 bits of width-1, then 14 of height-1, then the alpha-used bit at 28.
    const bits = (300 - 1) | ((200 - 1) << 14) | (1 << 28);
    const vp8l = new Uint8Array([
      ...ascii("RIFF"), ...be32(0), ...ascii("WEBP"), ...ascii("VP8L"), ...be32(0),
      0x2f,
      bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(readImageHeader(vp8l)).toMatchObject({ width: 300, height: 200, alpha: true });
  });

  it("returns null rather than guessing at anything else", () => {
    expect(readImageHeader(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(readImageHeader(new Uint8Array())).toBeNull();
    // Truncated headers must not read past the buffer and invent a size.
    expect(readImageHeader(png(10, 10, 2).slice(0, 20))).toBeNull();
    // A JPEG whose scan starts before any frame header — nothing to find.
    expect(readImageHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 12]))).toBeNull();
  });
});
