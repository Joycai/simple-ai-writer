/**
 * Guards the byte handling in `imageToDataUrl`.
 *
 * TS 6 rejected the old `new Uint8Array(bytes as ArrayBuffer)` line, because
 * plugin-fs `readFile` returns a Uint8Array and that cast claimed it was an
 * ArrayBuffer. The cast was load-bearing only for the type-checker: at runtime
 * the constructor saw an array-like and copied the whole image. Removing it
 * means the base64 loop — including its 8192-byte chunking — now runs over the
 * view `readFile` handed us, so the encoding is worth pinning down.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let fileBytes = new Uint8Array();

vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn(async () => fileBytes),
}));

vi.mock("../fs/fileio", () => ({
  readDir: vi.fn(async () => []),
  readFile: vi.fn(async () => ""),
}));

const { imageToDataUrl } = await import("../fs/images");

/** Decode a data URL's base64 payload back to bytes, for round-trip checks. */
function decode(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

describe("imageToDataUrl", () => {
  beforeEach(() => {
    fileBytes = new Uint8Array();
  });

  it("round-trips bytes through base64", async () => {
    fileBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { dataUrl, bytes } = await imageToDataUrl("/p/a.png");
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect([...decode(dataUrl)]).toEqual([...fileBytes]);
    expect([...bytes]).toEqual([...fileBytes]);
  });

  it("handles the full byte range, including 0x00 and 0xff", async () => {
    fileBytes = new Uint8Array(256).map((_, i) => i);
    const { dataUrl } = await imageToDataUrl("/p/a.png");
    expect([...decode(dataUrl)]).toEqual([...fileBytes]);
  });

  // The chunked loop is the part that could silently truncate or mis-slice.
  it.each([8191, 8192, 8193, 20_000])(
    "encodes %i bytes across the 8192-byte chunk boundary",
    async (size) => {
      fileBytes = new Uint8Array(size).map((_, i) => i % 256);
      const { dataUrl, bytes } = await imageToDataUrl("/p/big.png");
      const decoded = decode(dataUrl);
      expect(decoded.length).toBe(size);
      expect([...decoded]).toEqual([...fileBytes]);
      expect(bytes.length).toBe(size);
    },
  );

  it("derives the mime type from the extension, case-insensitively", async () => {
    fileBytes = new Uint8Array([1, 2, 3]);
    for (const [path, mime, ext] of [
      ["/p/a.jpg", "image/jpeg", "jpg"],
      ["/p/a.JPEG", "image/jpeg", "jpeg"],
      ["/p/a.webp", "image/webp", "webp"],
      ["/p/a.gif", "image/gif", "gif"],
    ] as const) {
      const result = await imageToDataUrl(path);
      expect(result.dataUrl.startsWith(`data:${mime};base64,`)).toBe(true);
      expect(result.ext).toBe(ext);
    }
  });

  it("falls back to png for an unknown or missing extension", async () => {
    fileBytes = new Uint8Array([1]);
    for (const path of ["/p/a.bmp", "/p/noext"]) {
      const { dataUrl } = await imageToDataUrl(path);
      expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    }
  });

  it("produces an empty payload for an empty file rather than throwing", async () => {
    const { dataUrl, bytes } = await imageToDataUrl("/p/empty.png");
    expect(dataUrl).toBe("data:image/png;base64,");
    expect(bytes.length).toBe(0);
  });
});
