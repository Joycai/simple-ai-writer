import { describe, expect, it } from "vitest";
import { inferImageFamily, resolvedImageCaps, withImageFamily } from "../imageFamily";
import { effectiveImageRoute } from "../imageRoute";
import { parseImageCaps } from "../configDb";
import { imageRequestParams } from "../../image";
import { draftRoute, imageCapsToSave, draftFromCaps } from "../../../components/settings/panes/imageCapsDraft";

describe("image model families", () => {
  it.each([
    ["relay/GPT-Image-2.5", "gpt-image-2.5"],
    ["gpt-image-2", "gpt-image-2"],
    ["nanoBanana2", "nanobanana-2"],
    ["gemini-3.1-flash-image-preview", "nanobanana-2"],
    ["doubao-seedream-5.0-pro", "seedream-5-pro"],
    ["qwen-image-3.0", "qwen-image"],
    ["gemini-3.1-flash", undefined],
    ["relay-alias", undefined],
  ])("recognizes %s conservatively", (id, family) => {
    expect(inferImageFamily(id)).toBe(family);
  });
  it("manual family wins over the ID and survives backup parsing", () => {
    const caps = parseImageCaps(JSON.stringify({ dialect: "gpt-image-2.5" }));
    expect(resolvedImageCaps("nanoBanana2", caps)?.dialect).toBe("gpt-image-2.5");
    expect(imageRequestParams(caps, { aspect: "1:1", quality: "max" })).toMatchObject({ size: "1024x1024", quality: "max" });
  });
  it("generic disables inference and ComfyUI stays isolated", () => {
    expect(resolvedImageCaps("nanoBanana2", { dialect: "generic" })?.dialect).toBe("generic");
    expect(resolvedImageCaps("nanoBanana2", { route: "comfyui" })).toEqual({ route: "comfyui" });
  });
  it("does not persist inferred values or overwrite explicit capabilities", () => {
    const model = { modelId: "nanoBanana2", caps: { edit: false } };
    expect(withImageFamily(model).caps).toEqual({ edit: false, dialect: "nanobanana-2", maxRefs: 14 });
    expect(model.caps).toEqual({ edit: false });
    const saved = imageCapsToSave({ ...draftFromCaps(undefined), modelId: "wan2.7-image", asyncTask: true }, "openai_compat");
    expect(saved.dialect).toBeUndefined();
    expect(saved.route).toBeUndefined();
    expect(saved.asyncTask).toBe(true);
  });
  it("keeps endpoint overrides and shares route resolution with the drawer", () => {
    expect(effectiveImageRoute("openai_compat", { dialect: "nanobanana-2" })).toBe("chat");
    expect(effectiveImageRoute("gemini", { dialect: "nanobanana-2" })).toBe("gemini");
    expect(effectiveImageRoute("openai_compat", { dialect: "nanobanana-2", route: "images-api" })).toBe("images-api");
    expect(draftRoute("openai_compat", { route: "", dialect: "", modelId: "wan2.7-image" })).toBe("dashscope");
  });
  it("Nano Banana 2 supports its own resolution menu", () => {
    expect(imageRequestParams({ dialect: "nanobanana-2" }, { resolution: "512", aspect: "1:4" })).toEqual({ imageSize: "512", aspect: "1:4" });
    expect(() => imageRequestParams({ dialect: "nanobanana-2" }, { sizingMode: "exact", size: "1024x1024" })).toThrow();
  });
});
