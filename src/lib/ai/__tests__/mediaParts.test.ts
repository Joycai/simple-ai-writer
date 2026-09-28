import { describe, expect, it } from "vitest";
import { MEDIA_KINDS, admitMedia, partKind, unsendablePart, withoutParts, type MediaKind } from "../mediaParts";
import type { ContentPart, StreamMessage } from "../types";
import { estimateMessagesTokens, noteVideoCost, VIDEO_TOKENS_UNKNOWN } from "../tokenEstimate";

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
    expect(partKind({ type: "constructor" } as unknown as ContentPart)).toBeUndefined();
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

describe("admitMedia", () => {
  const ALL = { image: true, video: true, pdf: true };
  const history = (): StreamMessage[] => [
    { role: "user", content: [text("看这两样"), IMG, CLIP] },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    { role: "user", content: [text("还有这份"), PDF] },
    { role: "user", content: "只有字" },
  ];

  it("admitting everything changes nothing, but still hands back a new array", () => {
    const h = history();
    const out = admitMedia(h, ALL, "as-built");
    expect(out).not.toBe(h);
    out.forEach((m, i) => expect(m).toBe(h[i]));
  });

  it("replaces only the refused kinds, copies only the messages it changes, and never writes into the history", () => {
    const h = history();
    const out = admitMedia(h, { image: true, video: false, pdf: false }, "none");
    expect(h).toEqual(history());
    expect(out[0]).toEqual({ role: "user", content: [text("看这两样"), IMG, text(expect.stringMatching(/^\[video clip not sent/) as unknown as string)] });
    expect(out[3]).toEqual({ role: "user", content: expect.stringMatching(/^还有这份\n\n\[PDF not sent/) });
    for (const i of [1, 2, 4]) expect(out[i]).toBe(h[i]);
  });

  it("one message refusing two kinds gets one note per kind", () => {
    const [m] = admitMedia([{ role: "user", content: [text("q"), IMG, CLIP] }], { image: false, video: false, pdf: true }, 0.5);
    expect(typeof m.content).toBe("string");
    expect(m.content).toMatch(/^q\n\n\[picture not sent[^\n]*\]\n\[video clip not sent/);
  });
});

describe("admitMedia: the clip's fps", () => {
  const ALL = { image: true, video: true, pdf: true };
  const turn = (clip: ContentPart): StreamMessage[] => [
    { role: "user", content: [text("这段呢"), IMG, clip] },
    { role: "user", content: "只有字" },
  ];
  const clipOf = (m: StreamMessage) => (m.content as ContentPart[]).find((p) => p.type === "video_url");

  it("writes the plan's fps onto a clip attached without one, and the history keeps none", () => {
    const bare: ContentPart = { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } };
    const h = turn(bare);
    const out = admitMedia(h, ALL, 0.5);
    expect(clipOf(out[0])).toEqual({ ...bare, fps: 0.5 });
    expect(h).toEqual(turn(bare));
    expect(out[1]).toBe(h[1]);
    // The rest of the message is the same parts: only the clip is a copy.
    expect((out[0].content as ContentPart[])[1]).toBe(IMG);
  });

  it("replaces a different fps, and strips it where the request sends none", () => {
    expect(clipOf(admitMedia(turn(CLIP), ALL, 0.5)[0])).toEqual({ ...CLIP, fps: 0.5 });
    const stripped = clipOf(admitMedia(turn(CLIP), ALL, "none")[0])!;
    expect(stripped).toEqual({ type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } });
    expect("fps" in stripped).toBe(false);
  });

  it("leaves the message the same object when the clip already says it, or the request is as built", () => {
    const h = turn(CLIP);
    expect(admitMedia(h, ALL, 2)[0]).toBe(h[0]);
    expect(admitMedia(h, ALL, "as-built")[0]).toBe(h[0]);
  });

  it("in one message, a refused picture becomes a note and the clip beside it still gets this request's fps", () => {
    const h = turn(CLIP);
    const [m] = admitMedia(h, { image: false, video: true, pdf: true }, 0.5);
    const parts = m.content as ContentPart[];
    expect(parts.some((p) => p.type === "image_url")).toBe(false);
    expect(clipOf(m)).toEqual({ ...CLIP, fps: 0.5 });
    expect(parts[parts.length - 1]).toEqual(text(expect.stringMatching(/^\[picture not sent/) as unknown as string));
    expect(h).toEqual(turn(CLIP));
  });

  it("a copied clip keeps its estimated cost, now at the fps it goes out with", () => {
    const clip: ContentPart = { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } };
    noteVideoCost(clip, (fps) => (fps === 0.5 ? 1_000 : 4_000));
    const h = turn(clip);
    const at = (fps: 0.5 | "none") => estimateMessagesTokens(admitMedia(h, ALL, fps)) - estimateMessagesTokens([{ role: "user", content: [text("这段呢"), IMG] }, h[1]]);
    expect(at("none")).toBe(4_000);
    expect(at(0.5)).toBe(1_000);
    expect(at(0.5)).not.toBe(VIDEO_TOKENS_UNKNOWN);
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
