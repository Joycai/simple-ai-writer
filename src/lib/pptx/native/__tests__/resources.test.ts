import { describe, expect, it } from "vitest";
import { validateImageResources, type ImageResourceInfo } from "../resources";
import { DECK_LIMITS as L, type DeckSpec } from "../model";
const spec: DeckSpec = { version: 1, language: "en-US", theme: "paper", assets: [{ id: "photo", path: "a.png" }], slides: [{ id: "s", layout: "title", title: "Test" }] };
const image: ImageResourceInfo = { assetId: "photo", byteLength: 1024, width: 1280, height: 720, mime: "image/png" };
describe("image resource observations", () => {
  it("accepts decoded PNG/JPEG metadata at the limits", () => {
    expect(validateImageResources(spec, [{ ...image, byteLength: L.imageBytes, width: 8000, height: 5000 }])).toEqual([]);
    expect(validateImageResources(spec, [{ ...image, mime: "image/jpeg" }])).toEqual([]);
  });
  it("rejects missing, duplicate and unexpected resources", () => {
    expect(validateImageResources(spec, [])[0].code).toBe("missing_asset");
    expect(validateImageResources(spec, [image, image])[0].code).toBe("duplicate_id");
    expect(validateImageResources(spec, [image, { ...image, assetId: "other" }])[0].code).toBe("invalid_image");
  });
  it.each([0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid metadata %s", value => {
    for (const key of ["byteLength", "width", "height"]) {
      expect(validateImageResources(spec, [{ ...image, [key]: value }])[0].code).toBe("invalid_image");
    }
  });
  it("rejects excessive bytes, decoded pixels and total assets", () => {
    expect(validateImageResources(spec, [{ ...image, byteLength: L.imageBytes + 1 }])[0].code).toBe("image_limit");
    expect(validateImageResources(spec, [{ ...image, width: 8001, height: 5000 }])[0].code).toBe("image_limit");
    const assets = Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, path: `${i}.png` }));
    const images = assets.map(a => ({ ...image, assetId: a.id, byteLength: L.imageBytes }));
    expect(validateImageResources({ ...spec, assets }, images)).toEqual([{ code: "image_limit", path: "/assets" }]);
  });
});
