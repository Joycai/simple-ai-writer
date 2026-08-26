/**
 * What `runIllustration` actually puts on the wire — specifically the negative
 * prompt, which is the one request field whose whole meaning depends on the
 * route underneath.
 *
 * The proposal already filtered it (see agentImageTools.test.ts), so this is
 * the second gate rather than the first, and it exists because the imagegen
 * binding can change between the card and the approval: the model that draws
 * is resolved here, not there. A negative that survived onto a non-ComfyUI
 * request would at best be ignored and at worst be folded in by a future
 * adapter — and folding it in is the failure mode, not the fallback: a
 * diffusion model draws what it reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IllustrateProposal } from "../agent/registry";

const generateImage = vi.fn(async (..._args: unknown[]) => ({
  images: [{ dataUrl: "data:image/png;base64,aGk=" }],
  usage: undefined,
}));
vi.mock("../ai/image", () => ({
  generateImage: (...a: unknown[]) => generateImage(...a),
  isEditUnsupportedError: () => false,
}));

let storeModels: unknown[] = [];
vi.mock("../../stores/aiStore", () => ({
  useAiStore: {
    getState: () => ({
      models: storeModels,
      providers: [{ id: "p1", name: "ComfyUI", baseUrl: "http://127.0.0.1:8188", apiStandard: "openai_compat" }],
    }),
  },
}));
vi.mock("../keyStore", () => ({ loadApiKey: async () => "" }));
vi.mock("../image/assets", () => ({
  saveDocumentAsset: async () => ({ absPath: "/proj/assets/a/pic.png", relPath: "assets/a/pic.png" }),
  imageMarkdown: () => "![](assets/a/pic.png)",
  saveImageInFolder: async () => "/proj/pic.png",
}));
vi.mock("../image/index", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recordImageUsage: async () => {},
}));
vi.mock("../image/session", () => ({ recordGeneration: async () => {} }));
vi.mock("../lore", () => ({ addLoreImage: async () => "pic.png" }));

const { runIllustration } = await import("../image/illustrate");

const COMFY = {
  id: "m2", providerId: "p1", modelId: "comfyui", name: "SDXL 立绘", type: "image",
  priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true,
  caps: { route: "comfyui", edit: false },
};
const CLOUD = { ...COMFY, id: "m3", name: "Nano", caps: { edit: false } };

function proposal(over: Partial<IllustrateProposal> = {}): IllustrateProposal {
  return {
    kind: "illustrate",
    id: "il-1",
    path: "/proj/a.md",
    prompt: "a knight",
    destination: "a.md",
    dest: { kind: "document", docPath: "/proj/a.md" },
    note: "n",
    modelId: "m2",
    modelName: "SDXL 立绘",
    costUsd: 0,
    ...over,
  } as IllustrateProposal;
}

beforeEach(() => {
  generateImage.mockClear();
  storeModels = [COMFY, CLOUD];
});

describe("runIllustration and the negative prompt", () => {
  it("sends it as its own wire field on the comfyui route", async () => {
    await runIllustration(proposal({ negative: "watermark, blurry" }), "/proj");
    const [, req] = generateImage.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(req.negative).toBe("watermark, blurry");
    // The positive is untouched — the two never merge.
    expect(req.prompt).toBe("a knight");
  });

  it("drops it when the binding moved to a model without negative conditioning", async () => {
    await runIllustration(proposal({ modelId: "m3", negative: "watermark" }), "/proj");
    const [, req] = generateImage.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(req.negative).toBeUndefined();
    expect(req.prompt).toBe("a knight");
  });

  it("omits the field entirely when the proposal carried none", async () => {
    await runIllustration(proposal(), "/proj");
    const [, req] = generateImage.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect("negative" in req).toBe(false);
  });
});
