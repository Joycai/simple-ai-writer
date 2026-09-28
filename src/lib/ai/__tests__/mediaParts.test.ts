import { describe, expect, it } from "vitest";
import { MEDIA_KINDS, partKind, unsendablePart, withoutParts, type MediaKind } from "../mediaParts";
import type { ContentPart } from "../types";

const IMG: ContentPart = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
const CLIP: ContentPart = { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" }, fps: 2 };
const PDF: ContentPart = { type: "file", file: { file_data: "data:application/pdf;base64,AAAA", filename: "a.pdf" } };
const text = (t: string): ContentPart => ({ type: "text", text: t });

describe("partKind", () => {
  it("names the three media kinds and nothing else", () => {
    expect(partKind(IMG)).toBe("image");
    expect(partKind(CLIP)).toBe("video");
    expect(partKind(PDF)).toBe("pdf");
    expect(partKind(text("x"))).toBeUndefined();
    expect(partKind({ type: "audio_url" } as unknown as ContentPart)).toBeUndefined();
  });
});

describe("withoutParts", () => {
  it("keeps the words and collapses to a string once only text is left", () => {
    expect(withoutParts([text("这段视频讲了什么？"), CLIP], new Set(["video"]), "[clip removed]"))
      .toBe("这段视频讲了什么？\n\n[clip removed]");
  });

  it("keeps the array, and adds the note as a part, when other media survive", () => {
    expect(withoutParts([text("对比"), IMG, CLIP], new Set(["video"]), "[clip removed]"))
      .toEqual([text("对比"), IMG, text("[clip removed]")]);
  });

  it("leaves string content alone", () => {
    expect(withoutParts("只有字", new Set(["image"]), "[note]")).toBe("只有字");
  });

  it("never removes a part of a type it does not know", () => {
    const odd = { type: "audio_url", audio_url: { url: "x" } } as unknown as ContentPart;
    expect(withoutParts([text("a"), odd, IMG], new Set<MediaKind>(MEDIA_KINDS), "[n]"))
      .toEqual([text("a"), odd, text("[n]")]);
  });

  it("over random contents: no removed kind survives, every word and every kept part stays in order", () => {
    const pool = [IMG, CLIP, PDF];
    for (let seed = 1; seed < 400; seed++) {
      const r = rng(seed);
      const content: ContentPart[] = [];
      const n = 1 + Math.floor(r() * 6);
      for (let i = 0; i < n; i++) {
        content.push(r() < 0.4 ? text(`t${seed}-${i}`) : pool[Math.floor(r() * pool.length)]);
      }
      const kinds = new Set(MEDIA_KINDS.filter(() => r() < 0.5));
      const out = withoutParts(content, kinds, "[note]");

      const parts = typeof out === "string" ? [text(out)] : out;
      for (const p of parts) expect(kinds.has(partKind(p) as MediaKind)).toBe(false);

      const words = content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text);
      const flat = parts.map((p) => (p.type === "text" ? p.text : `<${p.type}>`)).join("\n\n");
      let at = 0;
      for (const w of words) {
        const i = flat.indexOf(w, at);
        expect(i, `seed ${seed}`).toBeGreaterThanOrEqual(0);
        at = i + w.length;
      }
      expect(flat.endsWith("[note]")).toBe(true);

      const keptMedia = content.filter((p) => {
        const k = partKind(p);
        return k !== undefined && !kinds.has(k);
      });
      expect(parts.filter((p) => partKind(p) !== undefined)).toEqual(keptMedia);
    }
  });
});

describe("unsendablePart", () => {
  it("names the adapter and the part type", () => {
    expect(unsendablePart("Gemini", CLIP).message)
      .toMatch(/^Gemini adapter: no spelling for a "video_url" content part/);
    expect(unsendablePart("DashScope", null).message).toMatch(/"undefined" content part/);
  });
});

/** A small deterministic PRNG, so a failing seed can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
