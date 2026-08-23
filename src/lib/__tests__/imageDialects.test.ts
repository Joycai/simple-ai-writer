/**
 * The image parameter dialects — the layer that turns an author's framing
 * choices into the exact fields each model family's endpoint accepts.
 *
 * The gpt-image-2 size math is the part worth pinning hard: the endpoint's own
 * rules (both sides divisible by 16, ratio within 1:3..3:1, at most 3840x2160)
 * are enforced by the vendor with a 400, so a drifting computation here turns
 * into paid-for failures.
 */
import { describe, it, expect } from "vitest";
import { gptImageSize, imageDialect, wanImageSize, IMAGE_DIALECTS } from "../ai/imageDialects";
import { imageRequestParams } from "../image";

describe("gptImageSize", () => {
  it("reproduces the documented presets exactly at 1K", () => {
    expect(gptImageSize("1:1", "1K")).toBe("1024x1024");
    expect(gptImageSize("3:2", "1K")).toBe("1536x1024");
    expect(gptImageSize("2:3", "1K")).toBe("1024x1536");
  });

  it("hits the documented ceilings at 2K and 4K for 16:9", () => {
    // 2560x1440 is the documented non-experimental maximum, 3840x2160 the hard one.
    expect(gptImageSize("16:9", "2K")).toBe("2560x1440");
    expect(gptImageSize("16:9", "4K")).toBe("3840x2160");
    expect(gptImageSize("9:16", "4K")).toBe("2160x3840");
  });

  it("keeps both sides divisible by 16 across every aspect and tier", () => {
    const spec = imageDialect("gpt-image-2")!;
    for (const aspect of spec.aspects) {
      for (const tier of spec.resolutions) {
        const [w, h] = gptImageSize(aspect, tier).split("x").map(Number);
        expect(w % 16, `${aspect}@${tier} width`).toBe(0);
        expect(h % 16, `${aspect}@${tier} height`).toBe(0);
        expect(Math.max(w, h)).toBeLessThanOrEqual(3840);
        expect(Math.max(w, h) / Math.min(w, h)).toBeLessThanOrEqual(3);
      }
    }
  });

  it("shrinks the short side rather than the ratio when the long-side cap bites", () => {
    // 21:9 at 4K would want 5040 wide; the cap keeps the requested framing.
    const [w, h] = gptImageSize("21:9", "4K").split("x").map(Number);
    expect(w).toBe(3840);
    expect(Math.abs(w / h - 21 / 9)).toBeLessThan(0.05);
  });

  it("falls back to the square preset on an unparseable aspect", () => {
    expect(gptImageSize("banana", "1K")).toBe("1024x1024");
  });
});

describe("dialect params", () => {
  it("nanobanana speaks aspectRatio + imageSize and never a pixel size", () => {
    const spec = imageDialect("nanobanana")!;
    expect(spec.params({ aspect: "21:9", resolution: "2K" })).toEqual({
      aspect: "21:9",
      imageSize: "2K",
    });
    // The default tier sends nothing — the one request every revision accepts.
    expect(spec.params({ aspect: "3:4" })).toEqual({ aspect: "3:4" });
  });

  it("gpt-image-2 speaks size + quality and defaults to the 1K tier", () => {
    const spec = imageDialect("gpt-image-2")!;
    expect(spec.params({ aspect: "3:2", quality: "high" })).toEqual({
      aspect: "3:2",
      size: "1536x1024",
      quality: "high",
    });
    expect(spec.params({ aspect: "1:1" }).quality).toBeUndefined();
  });

  it("gpt-image-2 edits: computed size when a framing is asked for, none otherwise", () => {
    const spec = imageDialect("gpt-image-2")!;
    // An explicit aspect means "recompose" — same computed size as a
    // generation, tier included (the adapter falls back to a preset if the
    // endpoint enforces the documented edit sizes).
    expect(spec.params({ aspect: "2:3" }, { edit: true }).size).toBe("1024x1536");
    expect(spec.params({ aspect: "16:9", resolution: "2K" }, { edit: true }).size).toBe("2560x1440");
    // No aspect means "follow the input image" — no size at all.
    expect(spec.params({}, { edit: true }).size).toBeUndefined();
    // nanobanana resolves identically either way — Gemini edits take the
    // same imageConfig as generations.
    const nb = imageDialect("nanobanana")!;
    expect(nb.params({ aspect: "3:2", resolution: "2K" }, { edit: true }))
      .toEqual(nb.params({ aspect: "3:2", resolution: "2K" }));
  });

  it("an absent aspect stays absent — an edit must be able to follow its input", () => {
    expect(imageDialect("nanobanana")!.params({ resolution: "2K" })).toEqual({ imageSize: "2K" });
    expect(imageDialect("wan2.7")!.params({}, { edit: true })).toEqual({ size: "1K" });
  });

  it("wan2.7 speaks 宽*高 on generation and the tier shorthand on edits", () => {
    const spec = imageDialect("wan2.7")!;
    // Square tiers reproduce the documented shorthand meanings exactly.
    expect(spec.params({ aspect: "1:1", resolution: "1K" }).size).toBe("1024*1024");
    expect(spec.params({ aspect: "1:1", resolution: "2K" }).size).toBe("2048*2048");
    expect(spec.params({ aspect: "1:1", resolution: "4K" }).size).toBe("4096*4096");
    // Edits: only the 1K/2K tier goes out — the output's framing follows the
    // input image, and the edit range caps at 2048*2048 (4K clamps down).
    expect(spec.params({ aspect: "16:9", resolution: "2K" }, { edit: true }).size).toBe("2K");
    expect(spec.params({ aspect: "16:9", resolution: "4K" }, { edit: true }).size).toBe("2K");
    expect(spec.params({ aspect: "3:4" }, { edit: true }).size).toBe("1K");
  });

  it("wanImageSize keeps every side inside the documented 768..4096 range", () => {
    const spec = imageDialect("wan2.7")!;
    for (const aspect of spec.aspects) {
      for (const tier of spec.resolutions) {
        const [w, h] = wanImageSize(aspect, tier).split("*").map(Number);
        expect(w, `${aspect}@${tier} width`).toBeGreaterThanOrEqual(768);
        expect(h, `${aspect}@${tier} height`).toBeGreaterThanOrEqual(768);
        expect(Math.max(w, h)).toBeLessThanOrEqual(4096);
      }
    }
    // The clamp keeps the framing: 21:9 at 1K would put the short side at
    // ~670 — it rises to the 768 floor and the long side follows the ratio.
    expect(wanImageSize("21:9", "1K")).toBe("1792*768");
  });

  it("every dialect's aspect list stays within the shared vocabulary", () => {
    for (const spec of IMAGE_DIALECTS) {
      for (const a of spec.aspects) expect(a).toMatch(/^\d+:\d+$/);
      // The prompt-drafting step only ever proposes these five; every dialect
      // must accept them or a drafted aspect would be unselectable.
      for (const a of ["1:1", "3:4", "4:3", "16:9", "9:16"]) {
        expect(spec.aspects, `${spec.id} accepts ${a}`).toContain(a);
      }
    }
  });
});

describe("imageRequestParams", () => {
  it("routes through the declared dialect when there is one", () => {
    expect(imageRequestParams({ dialect: "nanobanana" }, { aspect: "4:5", resolution: "4K" })).toEqual({
      aspect: "4:5",
      imageSize: "4K",
    });
  });

  it("keeps the pre-dialect behaviour for generic models", () => {
    // An explicit size wins over the declared list…
    expect(imageRequestParams({ sizes: ["1024x1024"] }, { aspect: "1:1", size: "512x512" }))
      .toEqual({ aspect: "1:1", size: "512x512" });
    // …the closest declared size fills in otherwise…
    expect(imageRequestParams({ sizes: ["1024x1024", "1536x1024"] }, { aspect: "3:2" }))
      .toEqual({ aspect: "3:2", size: "1536x1024" });
    // …and no declaration means no size at all (xAI rejects the field).
    expect(imageRequestParams(undefined, { aspect: "1:1" })).toEqual({ aspect: "1:1", size: undefined });
  });

  it("ignores the free-form size box when a dialect is declared", () => {
    const params = imageRequestParams({ dialect: "gpt-image-2" }, { aspect: "1:1", size: "999x999" });
    expect(params.size).toBe("1024x1024");
  });

  it("passes the edit flag through to the dialect", () => {
    expect(imageRequestParams({ dialect: "wan2.7" }, { aspect: "16:9", resolution: "2K" }, { edit: true }).size)
      .toBe("2K");
    // Generic models resolve identically for edits — the pre-dialect behaviour.
    expect(imageRequestParams({ sizes: ["1024x1024"] }, { aspect: "1:1" }, { edit: true }))
      .toEqual({ aspect: "1:1", size: "1024x1024" });
  });
});
