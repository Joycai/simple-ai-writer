/**
 * When an approved edit asks the endpoint to keep a transparent source's
 * background transparent. The mode promises a see-through background
 * (measured on Seedream 5.0 pro, 2026-09-23: "add a sky behind it" painted
 * the sky inside the subject instead), so it needs every condition at once —
 * and the agent's word that the result wants no filled background.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IllustrateProposal } from "../../agent/registry";

/** A PNG header whose IHDR declares the given colour type (6 = RGBA, 2 = RGB). */
function png(colorType: number): string {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, 1024);
  new DataView(b.buffer).setUint32(20, 1024);
  b[24] = 8; b[25] = colorType;
  return `data:image/png;base64,${btoa(String.fromCharCode(...b))}`;
}
const JPEG = `data:image/jpeg;base64,${btoa("\xff\xd8\xff\xe0" + "0".repeat(60))}`;

const generateImage = vi.fn(async (..._args: unknown[]) => ({
  images: [{ dataUrl: "data:image/png;base64,aGk=" }],
  usage: undefined,
}));
vi.mock("../../ai/image", () => ({
  generateImage: (...a: unknown[]) => generateImage(...a),
  isEditUnsupportedError: () => false,
}));
let onDisk: Record<string, string> = {};
vi.mock("../normalize", () => ({ imageForModel: async (p: string) => ({ dataUrl: onDisk[p] }) }));

let caps: Record<string, unknown> = {};
const settings = () => ({
  models: [{
    id: "m1", providerId: "p1", modelId: "doubao-seedream-5.0-pro", name: "Seedream", type: "image",
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, caps,
  }],
  providers: [{ id: "p1", name: "火山方舟", baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3", apiStandard: "openai_compat" }],
}) as never;
vi.mock("../../keyStore", () => ({ loadApiKey: async () => "k" }));
vi.mock("../assets", () => ({
  saveDocumentAsset: async () => ({ absPath: "/proj/assets/a/pic.png", relPath: "assets/a/pic.png" }),
  imageMarkdown: () => "![](assets/a/pic.png)",
  saveImageInFolder: async () => "/proj/pic.png",
}));
vi.mock("../index", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recordImageUsage: async () => {},
}));
vi.mock("../session", () => ({ recordGeneration: async () => {} }));
vi.mock("../../lore", () => ({ addLoreImage: async () => "pic.png" }));

const { runIllustration } = await import("../illustrate");

const proposal = (over: Partial<IllustrateProposal>): IllustrateProposal => ({
  kind: "illustrate", id: "il-1", path: "/proj", prompt: "make the circle blue", destination: "proj",
  dest: { kind: "file", dir: "/proj" }, note: "n", modelId: "m1", modelName: "Seedream", costUsd: 0,
  sourcePath: "/proj/sprite.png",
  ...over,
} as IllustrateProposal);

/** What the edit request carried for transparency. */
async function sent(p: IllustrateProposal): Promise<unknown> {
  await runIllustration(p, "/proj", settings());
  const [, req] = generateImage.mock.calls[0] as unknown as [unknown, { transparentBackground?: boolean }];
  return req.transparentBackground;
}

beforeEach(() => {
  generateImage.mockClear();
  caps = { route: "ark", dialect: "seedream-5-pro", edit: true, maxRefs: 10 };
  onDisk = { "/proj/sprite.png": png(6), "/proj/ref.png": png(6), "/proj/photo.png": png(2), "/proj/photo.jpg": JPEG };
});

describe("runIllustration — keeping a transparent source transparent", () => {
  it("asks for it on a lone RGBA PNG source when the dialect is 5.0 pro / flash", async () => {
    expect(await sent(proposal({}))).toBe(true);
  });

  it("does not when the agent said the result needs a filled background", async () => {
    expect(await sent(proposal({ keepTransparency: false }))).toBeUndefined();
  });

  it("does not on a model whose dialect cannot — 5.0 lite, or pro's table off the ark route", async () => {
    caps = { route: "ark", dialect: "seedream-5-lite", edit: true, maxRefs: 14 };
    expect(await sent(proposal({}))).toBeUndefined();
    generateImage.mockClear();
    caps = { route: "images-api", dialect: "seedream-5-pro", edit: true };
    expect(await sent(proposal({}))).toBeUndefined();
  });

  it("does not on a fresh drawing that only leans on a transparent reference", async () => {
    // generate_image has no keep_transparency to say no with, and a reference
    // is a look to follow — its see-through background is not the result's.
    expect(await sent(proposal({ sourcePath: undefined, refPaths: ["/proj/ref.png"] }))).toBeUndefined();
  });

  it("does not with references alongside — the endpoint takes exactly one input", async () => {
    expect(await sent(proposal({ refPaths: ["/proj/ref.png"] }))).toBeUndefined();
  });

  it("does not on a source that cannot be transparent", async () => {
    expect(await sent(proposal({ sourcePath: "/proj/photo.png" }))).toBeUndefined();
    generateImage.mockClear();
    expect(await sent(proposal({ sourcePath: "/proj/photo.jpg" }))).toBeUndefined();
  });
});
