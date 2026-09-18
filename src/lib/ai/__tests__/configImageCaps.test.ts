/**
 * An image model's `caps`, validated field by field wherever it is read — the
 * config database and a restored backup alike.
 *
 * Both used to take the object on trust (`as ImageCaps`), and every consumer
 * reads its fields without a second check: the model drawer calls
 * `caps.sizes.join`, the image modal `caps.sizes.map`, the ComfyUI route parses
 * `caps.comfy.workflow` as text. A hand-edited backup with `"sizes": "1024x1024"`
 * therefore did not fail at restore — it crashed the settings page later, on a
 * machine that had never seen the file. Same rule as every other declaration
 * here: a value this build cannot read degrades to absent, one field at a time,
 * and never takes the rest of the model with it.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0-test" }));
vi.mock("../../project", () => ({
  getGlobalDb: async () => ({ execute: async () => {}, select: async () => [] }),
  getGlobalDbPath: async () => "/app-data/config.db",
}));
vi.mock("../../keyStore", () => ({ saveApiKey: async () => {}, loadApiKey: async () => null }));
vi.mock("../../fs/transfer", () => ({
  openTextFileDialog: async () => null,
  saveTextFileDialog: async () => null,
}));

const { parseImageCaps } = await import("../configDb");
const { parseConfigBundle, CONFIG_BACKUP_KIND } = await import("../configTransfer");
type ImageCaps = import("../configDb").ImageCaps;

const full: Required<ImageCaps> = {
  edit: false,
  dialect: "gpt-image-2",
  sizes: ["1024x1024", "1536x1024"],
  maxRefs: 16,
  route: "images-api",
  asyncTask: false,
  comfy: { workflow: '{"3":{"class_type":"KSampler","inputs":{}}}' },
};

describe("parseImageCaps", () => {
  it("keeps every valid field, from an object or from the stored JSON text", () => {
    expect(parseImageCaps(full)).toEqual(full);
    expect(parseImageCaps(JSON.stringify(full))).toEqual(full);
  });

  it("drops each malformed field on its own and keeps the rest", () => {
    const out = parseImageCaps({
      ...full,
      sizes: "1024x1024",   // not a list — `.join` / `.map` would throw
      maxRefs: "3",
      route: "ftp",
      dialect: "dall-e-9",
    });
    expect(out).toEqual({ edit: false, asyncTask: false, comfy: full.comfy });
  });

  it("keeps only the text entries of a mixed size list", () => {
    expect(parseImageCaps({ sizes: ["1024x1024", 5, null, ""] })).toEqual({ sizes: ["1024x1024"] });
  });

  it("wants a positive whole number of reference images", () => {
    for (const maxRefs of [0, -1, 2.5, Number.NaN, Infinity]) {
      expect(parseImageCaps({ edit: true, maxRefs })).toEqual({ edit: true });
    }
  });

  it("wants booleans to be booleans", () => {
    expect(parseImageCaps({ edit: "yes", asyncTask: 1, route: "dashscope" })).toEqual({ route: "dashscope" });
  });

  it("keeps the ark route and the Seedream dialects (火山方舟 starter rows declare them)", () => {
    for (const dialect of ["seedream-5-pro", "seedream-5-lite", "seedream-4"]) {
      const caps = { route: "ark", dialect, edit: true, maxRefs: 14 };
      expect(parseImageCaps(JSON.stringify(caps))).toEqual(caps);
    }
  });

  it("wants the ComfyUI workflow as text", () => {
    for (const comfy of [{ workflow: 5 }, { workflow: { "3": {} } }, "graph", null]) {
      expect(parseImageCaps({ route: "comfyui", comfy })).toEqual({ route: "comfyui" });
    }
  });

  it("is absent when nothing readable is left", () => {
    for (const raw of [undefined, null, "", "not json", 42, [], ["1024x1024"], {}, { sizes: 5 }]) {
      expect(parseImageCaps(raw)).toBeUndefined();
    }
  });
});

describe("restoring a backup with malformed caps", () => {
  it("keeps the model and drops only what cannot be read", () => {
    const parsed = parseConfigBundle({
      kind: CONFIG_BACKUP_KIND,
      version: 1,
      providers: [{ id: "p1", name: "Relay", baseUrl: "https://relay.example/v1", apiStandard: "openai_compat", createdAt: 0 }],
      models: [{
        id: "m1", providerId: "p1", modelId: "gpt-image-2", name: "Image", type: "image",
        caps: { edit: true, sizes: "1024x1024", maxRefs: 4 },
      }],
    }, []);
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0].caps).toEqual({ edit: true, maxRefs: 4 });
  });
});
