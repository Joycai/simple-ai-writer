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
import { gptImageSize, imageDialect, IMAGE_DIALECTS } from "../ai/imageDialects";
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

  it("gpt-image-2 drops size on edits (the edits endpoint documents presets only)", () => {
    expect(imageDialect("gpt-image-2")!.omitSizeOnEdit).toBe(true);
    expect(imageDialect("nanobanana")!.omitSizeOnEdit).toBeUndefined();
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
});
