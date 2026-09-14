/**
 * Video as model input: the gate, the part shape, the fps clamp, and the token
 * estimate against every point measured on qwen3-vl-plus, 2026-09-14
 * (docs/feature/video-input.md).
 */
import { describe, expect, it } from "vitest";
import {
  canReadVideo, clampVideoFps, DEFAULT_VIDEO_FPS, estimateVideoTokens, videoPart,
} from "../ai/videoInput";

describe("estimateVideoTokens", () => {
  // [width, height, seconds, fps | undefined, measured video_tokens]
  const MEASURED: [number, number, number, number | undefined, number][] = [
    [640, 480, 2, undefined, 602],
    [640, 480, 3, undefined, 902],
    [320, 240, 3, undefined, 242],
    [320, 240, 6, undefined, 482],
    [320, 240, 6, 1, 242],
    [320, 240, 6, 0.5, 162],
    [1280, 720, 60, undefined, 35_642],
    [1280, 720, 60, 4, 71_282],
    [1280, 720, 60, 0.5, 8_912],
  ];

  it.each(MEASURED)("%ix%i %is fps=%s ≈ %i measured", (width, height, durationSec, fps, measured) => {
    const est = estimateVideoTokens({ width, height, durationSec, fps })!;
    // Labelled ≈ in the UI; the pattern happens to reproduce every point, but
    // the guard is a tolerance, not equality, so a vendor change reads as drift.
    expect(Math.abs(est - measured) / measured).toBeLessThan(0.05);
  });

  it("is null when duration or frame size is unknown (WebM), rather than guessing", () => {
    expect(estimateVideoTokens({ width: 640, height: 480 })).toBeNull();
    expect(estimateVideoTokens({ durationSec: 3 })).toBeNull();
    expect(estimateVideoTokens({})).toBeNull();
  });

  it("scales with fps, but short clips hit the 4-frame floor", () => {
    const at = (fps?: number) => estimateVideoTokens({ width: 640, height: 480, durationSec: 30, fps })!;
    expect(at(0.5)).toBeLessThan(at());
    expect(at(4)).toBeGreaterThan(at());
    const short = (fps?: number) => estimateVideoTokens({ width: 640, height: 480, durationSec: 2, fps })!;
    expect(short(0.5)).toBe(short());
  });
});

describe("clampVideoFps", () => {
  it("keeps a sane value, clamps the rest, and treats blank / junk as send-nothing", () => {
    expect(clampVideoFps(0.5)).toBe(0.5);
    expect(clampVideoFps("4")).toBe(4);
    expect(clampVideoFps(50)).toBe(10);
    expect(clampVideoFps(0.01)).toBe(0.1);
    expect(clampVideoFps(0)).toBeUndefined();
    expect(clampVideoFps(-1)).toBeUndefined();
    expect(clampVideoFps("")).toBeUndefined();
    expect(clampVideoFps("abc")).toBeUndefined();
    expect(clampVideoFps(null)).toBeUndefined();
    expect(DEFAULT_VIDEO_FPS).toBe(2);
  });
});

describe("videoPart", () => {
  it("puts fps beside video_url, and sends none when unset", () => {
    expect(videoPart("data:video/mp4;base64,AA")).toEqual({ type: "video_url", video_url: { url: "data:video/mp4;base64,AA" } });
    expect(videoPart("data:video/mp4;base64,AA", 0.5)).toEqual({
      type: "video_url", video_url: { url: "data:video/mp4;base64,AA" }, fps: 0.5,
    });
  });
});

describe("canReadVideo", () => {
  const vl = { type: "vision" as const, videoInput: true };
  it("needs the declaration, a model that sees, and the Chat Completions family", () => {
    expect(canReadVideo(vl, "openai_compat")).toBe(true);
    expect(canReadVideo({ ...vl, type: "multimodal" }, "openai")).toBe(true);
    expect(canReadVideo({ ...vl, videoInput: undefined }, "openai_compat")).toBe(false);
    expect(canReadVideo({ ...vl, type: "text" }, "openai_compat")).toBe(false);
    // Responses: qwen3-vl-plus is Unsupported model there, and a clip once
    // came back as an empty answer. Gemini / Anthropic have no spelling.
    for (const s of ["openai_responses_compat", "gemini_compat", "anthropic_compat"] as const) {
      expect(canReadVideo(vl, s)).toBe(false);
    }
    expect(canReadVideo(undefined, "openai")).toBe(false);
    expect(canReadVideo(vl, undefined)).toBe(false);
  });
});
