import { describe, expect, it } from "vitest";
import { draftFromCaps, imageCapsToSave } from "../imageCapsDraft";
import { parseImageCaps, type ImageCaps } from "../../../../lib/ai/configDb";

describe("model drawer image output persistence", () => {
  it("round-trips model-specific capabilities and defaults through edit, save and import", () => {
    const caps: ImageCaps = {
      dialect: "gpt-image-2.5", route: "images-api", edit: true,
      overrides: { modes: ["ratio", "exact"], aspects: ["3:2", "2:3"], resolutions: ["1K", "2K"], qualities: ["high", "max"], pixels: { step: 64, maxEdge: 3840 } },
      defaults: { sizingMode: "exact", size: "1536x1024", quality: "max" },
    };
    const saved = imageCapsToSave(draftFromCaps(caps), "openai_compat");
    expect(saved).toEqual(caps);
    expect(parseImageCaps(JSON.stringify(saved))).toEqual(caps);
  });

  it("removing overrides restores preset inheritance without losing defaults", () => {
    const draft = draftFromCaps({ dialect: "gpt-image-2", overrides: { qualities: ["high"] }, defaults: { quality: "high" } });
    draft.overrides = undefined;
    const saved = imageCapsToSave(draft, "openai_compat");
    expect(saved.overrides).toBeUndefined();
    expect(saved.defaults).toEqual({ quality: "high" });
  });
});
