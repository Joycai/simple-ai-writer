/**
 * Width × height read off a generated picture's bytes — shared by the live
 * image probes, because the one thing a framing request can be checked against
 * is the bytes, never the endpoint's own claim about them.
 */
import type { GeneratedImage } from "../ai/image";

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
