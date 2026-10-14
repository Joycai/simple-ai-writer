import { describe, expect, it } from "vitest";
import { imageOutputSpec, imageSelection, parseImageOutputCaps, validateImageOutputConfig, validateImageSelection } from "../imageDialects";

describe("per-model image output capabilities", () => {
  it("inherits omitted fields and preserves explicitly empty menus", () => {
    const spec = imageOutputSpec({ dialect: "gpt-image-2", overrides: { aspects: ["3:2"], qualities: [] } });
    expect(spec.modes).toEqual(["ratio", "exact"]);
    expect(spec.aspects).toEqual(["3:2"]);
    expect(spec.qualities).toEqual([]);
    expect(spec.resolutions).toContain("1.5K");
    expect(spec.pixels.step).toBe(16);
  });

  it("inherits defaults only for undefined values", () => {
    const caps = { defaults: { aspect: "3:2", resolution: "2K", quality: "high" } };
    expect(imageSelection(caps, { aspect: "", quality: "" })).toEqual({ sizingMode: "ratio", aspect: "", resolution: "2K", quality: "" });
  });

  it("explicit ratio choices supersede an exact default", () => {
    expect(imageSelection({ defaults: { sizingMode: "exact", size: "1536x1024" } }, { aspect: "2:3" }))
      .toEqual({ sizingMode: "ratio", aspect: "2:3" });
  });

  it("removes inactive fields in both modes", () => {
    const sel = { aspect: "3:2", resolution: "2K", size: "1536x1024", quality: "high" };
    expect(imageSelection(undefined, { ...sel, sizingMode: "exact" }))
      .toEqual({ sizingMode: "exact", size: "1536x1024", quality: "high" });
    expect(imageSelection(undefined, { ...sel, sizingMode: "ratio" }))
      .toEqual({ sizingMode: "ratio", aspect: "3:2", resolution: "2K", quality: "high" });
  });

  it("rejects unsupported defaults and conflicting limits", () => {
    expect(validateImageOutputConfig({ dialect: "gpt-image-2", defaults: { quality: "max" } })).toBe("quality");
    expect(validateImageOutputConfig({ dialect: "gpt-image-2.5", defaults: { quality: "max" } })).toBeUndefined();
    expect(validateImageOutputConfig({ overrides: { pixels: { minEdge: 2048, maxEdge: 1024 } } })).toBe("edge");
    expect(validateImageOutputConfig({ defaults: { sizingMode: "exact" } })).toBe("dimensions");
    expect(validateImageOutputConfig({ dialect: "nanobanana", overrides: { modes: ["exact"] } })).toBe("mode");
  });

  it("cannot extend a lookup table with an unknown tier", () => {
    expect(validateImageOutputConfig({ dialect: "seedream-5-pro", overrides: { resolutions: ["8K"] } })).toBe("resolution");
    expect(validateImageOutputConfig({ dialect: "nanobanana", overrides: { resolutions: ["1.5K"] } })).toBeUndefined();
  });

  it("narrows malformed backup fields independently", () => {
    expect(parseImageOutputCaps({
      overrides: { modes: ["bad", "exact", "exact"], aspects: ["3:2", 42], qualities: [], pixels: { step: 64, maxEdge: -1, maxPixels: Infinity, maxRatio: 2.5 } },
      defaults: { sizingMode: "exact", size: "1536x1024", quality: false },
    })).toEqual({
      overrides: { aspects: ["3:2"], qualities: [], modes: ["exact"], pixels: { step: 64, maxRatio: 2.5 } },
      defaults: { size: "1536x1024", sizingMode: "exact" },
    });
    expect(parseImageOutputCaps({ overrides: "bad", defaults: [] })).toEqual({});
  });
});

describe("exact dimension validation", () => {
  const caps = { dialect: "gpt-image-2" as const, overrides: { pixels: { step: 64, minEdge: 512, minPixels: 655360 } } };
  it.each([
    ["1536x1024", undefined], ["1025x1024", "step"], ["3841x1024", "step"],
    ["3904x1024", "edge"], ["3840x3840", "pixels"], ["3072x512", "ratio"],
    ["512x512", "pixels"], ["256x4096", "edge"], ["0x1024", "dimensions"],
    ["1024.5x1024", "dimensions"], ["1024", "dimensions"], ["", "dimensions"],
  ])("validates %s before submission", (size, expected) => {
    expect(validateImageSelection(caps, { sizingMode: "exact", size })).toBe(expected);
  });
});
