/**
 * The pure decisions around image generation: which declared size fits a
 * requested aspect, what a run costs under either billing shape, and decoding
 * a generated data URL back into the bytes that go to disk.
 */
import { describe, it, expect, vi } from "vitest";
import { defaultImageCaps, imageCostFor, type Model } from "../../ai/configDb";
import { ZERO_FEE, type FeeConfig } from "../../ai/feeGroup";
import type { ApiStandard } from "../../ai/types";

// index.ts reaches for the project DB to record usage; the pure helpers under
// test never touch it.
vi.mock("../../project", () => ({ getDb: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));
vi.mock("../../fs/fileio", () => ({ readDir: vi.fn(), readFile: vi.fn() }));

const { sizeForAspect } = await import("../index");
const { dataUrlToBytes } = await import("../../fs/images");

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

/**
 * 计价方式在**组**上，不在调用点上：同一个 `imageCostFor` 按组的模式走
 * 哪一条算式。旧版把 `pricePerImage` 与 token 价**相加**，于是一个两边都
 * 填了的模型会被收两次——那笔糊涂账是这一轮要改掉的东西之一。
 */
function fee(over: Partial<FeeConfig> = {}): FeeConfig {
  return { ...ZERO_FEE, ...over };
}

describe("imageCostFor", () => {
  it("按张的组：张数 × 命中档位的单价", () => {
    const m = model({ fee: fee({ billingMode: "spec", outputUnit: "image", outputRates: [{ price: 0.07 }] }) });
    expect(imageCostFor(m, 3)).toBeCloseTo(0.21, 10);
  });

  it("按张的组：档位随尺寸变，请求的尺寸决定单价", () => {
    const m = model({ fee: fee({
      billingMode: "spec", outputUnit: "image",
      outputRates: [{ size: "1K", price: 0.04 }, { size: "2K", price: 0.06 }],
    }) });
    expect(imageCostFor(m, 1, undefined, { size: "2k" })).toBeCloseTo(0.06, 10);
    expect(imageCostFor(m, 1, undefined, { size: "1K" })).toBeCloseTo(0.04, 10);
  });

  it("按 token 的组：把出图计进 token 的端点按回包的 usage 算", () => {
    const m = model({ fee: fee({ inputPrice: 5, outputPrice: 40 }) });
    expect(imageCostFor(m, 1, { inputTokens: 1000, outputTokens: 1290 }))
      .toBeCloseTo((1000 * 5 + 1290 * 40) / 1_000_000, 10);
  });

  it("两种价不再相加：按张的组不看 token 价", () => {
    const m = model({ fee: fee({
      billingMode: "spec", outputUnit: "image", outputRates: [{ price: 0.01 }],
      inputPrice: 1_000_000,
    }) });
    expect(imageCostFor(m, 2, { inputTokens: 1, outputTokens: 0 })).toBeCloseTo(0.02, 10);
  });

  it("没命中任何档位就按 0 计，而不是悄悄挑一行凑数", () => {
    const m = model({ fee: fee({
      billingMode: "spec", outputUnit: "image", outputRates: [{ quality: "high", price: 0.04 }],
    }) });
    expect(imageCostFor(m, 1, undefined, { quality: "low" })).toBe(0);
  });

  it("像素尺寸落进表里真有的那个档——只在表里有的档之间比", () => {
    // 表只写了 1K，自由尺寸端点回显 512x512（0.26MP）：它落 1K，而不是
    // 因为「不等于字符串 1K」就变成未覆盖。
    const one = model({ fee: fee({
      billingMode: "spec", outputUnit: "image", outputRates: [{ size: "1K", price: 0.04 }],
    }) });
    expect(imageCostFor(one, 1, undefined, { size: "512x512" })).toBeCloseTo(0.04, 10);
    // 表里同时有 1K 与 2K 时，1696x960（1.63MP）在对数尺度上离 1K 更近。
    const two = model({ fee: fee({
      billingMode: "spec", outputUnit: "image",
      outputRates: [{ size: "1K", price: 0.04 }, { size: "2K", price: 0.06 }],
    }) });
    expect(imageCostFor(two, 1, undefined, { size: "1696x960" })).toBeCloseTo(0.04, 10);
  });

  it("没绑组 ＝ 一分不收", () => {
    expect(imageCostFor(model(), 4)).toBe(0);
  });

  it("输入图单独收：免费额度按每次请求扣", () => {
    const m = model({ fee: fee({
      billingMode: "spec", outputUnit: "image", outputRates: [{ price: 0.04 }],
      inputUnitPrice: 0.01, inputFreeUnits: 1,
    }) });
    // 出 1 张 + 交 3 张参考图，首张免费 ⇒ 0.04 + 2 × 0.01
    expect(imageCostFor(m, 1, undefined, {}, 3)).toBeCloseTo(0.06, 10);
  });

  it("一张都没交付：输出 0，输入图也不收", () => {
    const m = model({ fee: fee({
      billingMode: "spec", outputUnit: "image", outputRates: [{ price: 0.04 }],
      inputUnitPrice: 0.01,
    }) });
    expect(imageCostFor(m, 0, undefined, {}, 2)).toBe(0);
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
