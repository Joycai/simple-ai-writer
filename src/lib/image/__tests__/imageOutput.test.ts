import { describe, expect, it } from "vitest";
import { imageRequestParams, imageSelectedSpec } from "../index";
import { ImageOutputValidationError } from "../../ai/imageDialects";

describe("shared image request resolution", () => {
  it("applies per-model defaults to every caller", () => {
    expect(imageRequestParams({ dialect: "nanobanana", defaults: { aspect: "3:2", resolution: "2K" } }, {}))
      .toEqual({ aspect: "3:2", imageSize: "2K" });
    expect(imageRequestParams({ dialect: "nanobanana", defaults: { aspect: "3:2", resolution: "2K" } }, { aspect: "", resolution: "" }))
      .toEqual({});
  });

  it("exact mode overrides ratio and tier with a quality independent of sizing", () => {
    expect(imageRequestParams({ dialect: "gpt-image-2.5" }, {
      sizingMode: "exact", size: "1536x1024", aspect: "2:3", resolution: "4K", quality: "max",
    })).toEqual({ size: "1536x1024", quality: "max" });
  });

  it("rejects invalid pixels rather than rounding the author's exact request", () => {
    expect(() => imageRequestParams({ dialect: "gpt-image-2", overrides: { pixels: { step: 64 } } }, { sizingMode: "exact", size: "1552x1024" }))
      .toThrow(ImageOutputValidationError);
  });

  it("applies custom pixel limits to computed ratio output too", () => {
    expect(() => imageRequestParams({ dialect: "gpt-image-2", overrides: { modes: ["ratio"], pixels: { step: 64 } } }, { aspect: "21:9", resolution: "1K" }))
      .toThrow("step");
  });

  it("encodes Grok native fields separately from Gemini imageSize", () => {
    expect(imageRequestParams({ dialect: "grok-imagine" }, { aspect: "3:2", resolution: "2K", quality: "medium" }))
      .toEqual({ aspect: "3:2", extraBody: { aspect_ratio: "3:2", resolution: "2k" }, quality: "medium" });
  });

  it("keeps legacy dialect sizing and generic endpoint values compatible", () => {
    expect(imageRequestParams({ dialect: "gpt-image-2" }, { aspect: "3:2", size: "999x999" }).size).toBe("1536x1024");
    expect(imageRequestParams(undefined, { size: "auto" })).toEqual({ aspect: undefined, size: "auto" });
  });

  it("estimates and records the same active sizing spec and model defaults", () => {
    expect(imageSelectedSpec({ dialect: "gpt-image-2", defaults: { resolution: "2K", quality: "high" } }, { sizingMode: "ratio", size: "1024x1024" }))
      .toEqual({ size: "2K", quality: "high" });
    expect(imageSelectedSpec({ dialect: "gpt-image-2" }, { sizingMode: "exact", size: "1536x1024", resolution: "4K", quality: "high" }))
      .toEqual({ size: "1536x1024", quality: "high" });
    expect(imageSelectedSpec({ dialect: "gpt-image-2" }, {})).toEqual({ size: "1024x1024", quality: undefined });
  });
});
