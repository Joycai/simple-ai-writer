/**
 * A video clip in the chat composer: sent as one `video_url` part to a model
 * that can take it, a plain recording pointer to one that cannot, and never
 * more than one per message.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async () => "text body"),
  fileExists: vi.fn(async () => true),
}));

import { buildChatMessage } from "../chatRefs";
import { estimateMessagesTokens, VIDEO_TOKENS_UNKNOWN } from "../../ai/tokenEstimate";
import type { ContentPart, StreamMessage } from "../../ai/types";
import type { AttachedItem } from "../../lore/aiTask";

const clip = (name: string, extra: Record<string, unknown> = {}) => ({
  kind: "video",
  file: { name, path: `/proj/media/${name}`, kind: "media" },
  dataUrl: "data:video/mp4;base64,AAAA",
  sizeBytes: 3,
  durationSec: 3,
  width: 640,
  height: 480,
  ...extra,
}) as unknown as AttachedItem;

const partsOf = (content: unknown) => (Array.isArray(content) ? (content as ContentPart[]) : []);

describe("buildChatMessage with a video clip", () => {
  it("sends it as a video_url part after the text, with the model's fps beside it", async () => {
    const res = await buildChatMessage("这段视频里发生了什么？", undefined, [clip("a.mp4")], {
      allowVideo: true, videoFps: 0.5,
    });
    const parts = partsOf(res.content);
    expect(parts[0].type).toBe("text");
    expect(parts[1]).toEqual({ type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" }, fps: 0.5 });
    expect(res.text).toContain("a.mp4");
  });

  it("sends no fps when the model declares none", async () => {
    const res = await buildChatMessage("看看", undefined, [clip("a.mp4")], { allowVideo: true });
    expect(partsOf(res.content)[1]).toEqual({ type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } });
  });

  it("carries at most one clip, and names the rest with their paths", async () => {
    const res = await buildChatMessage("比较", undefined, [clip("a.mp4"), clip("b.mp4")], { allowVideo: true });
    expect(partsOf(res.content).filter((p) => p.type === "video_url")).toHaveLength(1);
    expect(res.text).toContain("/proj/media/b.mp4");
  });

  it("to a model that cannot take video it is a recording pointer — no payload, no tool it lacks", async () => {
    const res = await buildChatMessage("看看", undefined, [clip("a.mp4")], { allowVideo: false, transcribe: false });
    expect(typeof res.content).toBe("string");
    expect(res.text).toContain("/proj/media/a.mp4");
    expect(res.text).not.toContain("transcribe_audio");
  });

  it("prices the part with the composer's estimate, not a flat picture rate", async () => {
    const known = await buildChatMessage("看看", undefined, [clip("a.mp4")], { allowVideo: true });
    const unknown = await buildChatMessage("看看", undefined, [clip("a.webm", { durationSec: undefined })], { allowVideo: true });
    const tokens = (content: unknown) => estimateMessagesTokens([{ role: "user", content } as StreamMessage]);
    // 640×480 3 s → 902 measured; the text half adds a few dozen.
    expect(tokens(known.content)).toBeGreaterThan(900);
    expect(tokens(known.content)).toBeLessThan(1100);
    expect(tokens(unknown.content)).toBeGreaterThanOrEqual(VIDEO_TOKENS_UNKNOWN);
    // Nothing of the estimate reaches the wire part.
    expect(Object.keys(partsOf(known.content)[1]).sort()).toEqual(["type", "video_url"]);
  });
});
