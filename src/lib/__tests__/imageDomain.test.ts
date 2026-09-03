/**
 * The pure decisions around image generation: which declared size fits a
 * requested aspect, what a run costs under either billing shape, and decoding
 * a generated data URL back into the bytes that go to disk.
 */
import { describe, it, expect, vi } from "vitest";
import { defaultImageCaps, imageCostFor, type Model } from "../ai/configDb";
import type { ApiStandard } from "../ai/types";

// index.ts reaches for the project DB to record usage; the pure helpers under
// test never touch it.
vi.mock("../project", () => ({ getDb: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));
vi.mock("../fs/fileio", () => ({ readDir: vi.fn(), readFile: vi.fn() }));

const { sizeForAspect } = await import("../image");
const { dataUrlToBytes } = await import("../fs/images");

function model(over: Partial<Model> = {}): Model {
  return {
    id: "m1", providerId: "p1", modelId: "img-1", name: "Img", type: "image",
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, ...over,
  };
}

describe("sizeForAspect", () => {
  it("returns undefined when the model declares no sizes", () => {
    // The signal to omit `size` entirely — endpoints like xAI reject the field.
    expect(sizeForAspect("1:1", undefined)).toBeUndefined();
    expect(sizeForAspect("1:1", [])).toBeUndefined();
  });

  it("picks the declared size closest to the requested ratio", () => {
    const sizes = ["1024x1024", "1024x1536", "1536x1024"];
    expect(sizeForAspect("1:1", sizes)).toBe("1024x1024");
    expect(sizeForAspect("3:4", sizes)).toBe("1024x1536");
    expect(sizeForAspect("16:9", sizes)).toBe("1536x1024");
  });

  it("falls back to the first declared size when none parse", () => {
    expect(sizeForAspect("1:1", ["auto", "large"])).toBe("auto");
  });

  it("parses DashScope's 宽*高 spelling alongside WxH", () => {
    const sizes = ["1024*1024", "1024*1536", "1536*1024"];
    expect(sizeForAspect("1:1", sizes)).toBe("1024*1024");
    expect(sizeForAspect("3:4", sizes)).toBe("1024*1536");
    // Wan's "2K" presets carry no aspect — they only ever win as the fallback.
    expect(sizeForAspect("1:1", ["2K", "1024*1536"])).toBe("1024*1536");
    expect(sizeForAspect("1:1", ["2K"])).toBe("2K");
  });
});

describe("defaultImageCaps", () => {
  it("assumes editing works on the two first-party protocols, not on relays", () => {
    expect(defaultImageCaps("openai").edit).toBe(true);
    expect(defaultImageCaps("gemini").edit).toBe(true);
    expect(defaultImageCaps("openai_compat").edit).toBe(false);
    // Claude generates no images at all.
    expect(defaultImageCaps("anthropic").edit).toBe(false);
    expect(defaultImageCaps("anthropic_compat").edit).toBe(false);
    // The Responses standard is the same host below the same base: the image
    // endpoints don't care which chat protocol the provider was filed under.
    expect(defaultImageCaps("openai_responses")).toEqual(defaultImageCaps("openai"));
    expect(defaultImageCaps("openai_responses_compat").edit).toBe(false);
  });

  it("keeps the optimistic default for a Gemini relay, unlike an OpenAI one", () => {
    // Not an inconsistency: OpenAI hides editing behind a second endpoint
    // (`/images/edits`) that relays often skip, while Gemini expresses an edit
    // as extra parts on the generation call itself. Nothing separate exists for
    // a Gemini relay to be missing.
    expect(defaultImageCaps("gemini_compat")).toEqual(defaultImageCaps("gemini"));
    expect(defaultImageCaps("openai_compat").edit).toBe(false);
  });

  it("still returns caps for a standard outside the union", () => {
    // `apiStandard` arrives from a free-text DB column, so an unrecognised
    // value is reachable at runtime. Falling out of the switch as undefined
    // used to crash the settings form the moment a model was set to "image".
    // Deliberately a protocol this app has never supported — using a name that
    // later joins the union would quietly stop testing the default branch.
    expect(defaultImageCaps("cohere" as ApiStandard)).toEqual({ edit: false });
  });
});

describe("imageCostFor", () => {
  it("bills per image when the model has a per-image price", () => {
    expect(imageCostFor(model({ pricePerImage: 0.07 }), 3)).toBeCloseTo(0.21, 10);
  });

  it("bills tokens when the provider reported usage instead", () => {
    const m = model({ priceIn: 5, priceOut: 40 });
    expect(imageCostFor(m, 1, { inputTokens: 1000, outputTokens: 1290 }))
      .toBeCloseTo((1000 * 5 + 1290 * 40) / 1_000_000, 10);
  });

  it("sums both shapes rather than choosing one", () => {
    const m = model({ pricePerImage: 0.01, priceIn: 1000000, priceOut: 0 });
    expect(imageCostFor(m, 2, { inputTokens: 1, outputTokens: 0 })).toBeCloseTo(1.02, 10);
  });

  it("costs nothing when neither price is configured", () => {
    expect(imageCostFor(model(), 4)).toBe(0);
  });
});

describe("dataUrlToBytes", () => {
  it("round-trips bytes and derives the extension from the mime type", () => {
    const { bytes, ext } = dataUrlToBytes("data:image/png;base64,iVBO");
    expect(ext).toBe("png");
    expect(Array.from(bytes)).toEqual(Array.from(atob("iVBO"), (c) => c.charCodeAt(0)));
  });

  it("maps image/jpeg to a jpg extension", () => {
    expect(dataUrlToBytes("data:image/jpeg;base64,aGk=").ext).toBe("jpg");
  });

  it("falls back to png for an unknown mime type", () => {
    expect(dataUrlToBytes("data:image/avif;base64,aGk=").ext).toBe("png");
  });

  it("rejects anything that is not a data URL", () => {
    expect(() => dataUrlToBytes("https://example.com/x.png")).toThrow(/data URL/);
  });
});
