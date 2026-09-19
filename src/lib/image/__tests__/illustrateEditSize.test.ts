/**
 * The size an agent-approved image-conditioned call sends when the proposal
 * named no aspect. On qwen-image an omitted `size` bills the 2K tier — twice
 * the 1K price — so the framing comes from the first input, whether that is
 * the picture being edited or only a reference.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IllustrateProposal } from "../../agent/registry";

function png(w: number, h: number): string {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  b[24] = 8; b[25] = 6;
  return `data:image/png;base64,${btoa(String.fromCharCode(...b))}`;
}

const generateImage = vi.fn(async (..._args: unknown[]) => ({
  images: [{ dataUrl: "data:image/png;base64,aGk=" }],
  usage: undefined,
}));
vi.mock("../../ai/image", () => ({
  generateImage: (...a: unknown[]) => generateImage(...a),
  isEditUnsupportedError: () => false,
}));
vi.mock("../normalize", () => ({ imageForModel: async () => ({ dataUrl: png(768, 1376) }) }));
// aiStore's rows, handed in the way agentStore's approval path does.
const settings = () => ({
  models: [{
    id: "m1", providerId: "p1", modelId: "qwen-image-2.0", name: "Qwen", type: "image",
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true,
    caps: { dialect: "qwen-image", route: "dashscope", edit: true },
  }],
  providers: [{ id: "p1", name: "百炼", baseUrl: "https://dashscope.aliyuncs.com", apiStandard: "openai_compat" }],
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
  kind: "illustrate", id: "il-1", path: "/proj/a.md", prompt: "a knight", destination: "a.md",
  dest: { kind: "document", docPath: "/proj/a.md" }, note: "n", modelId: "m1", modelName: "Qwen", costUsd: 0,
  ...over,
} as IllustrateProposal);

beforeEach(() => generateImage.mockClear());

describe("runIllustration — size on an image-conditioned call with no aspect", () => {
  it("follows a reference image's framing at 1K when there is no source picture", async () => {
    await runIllustration(proposal({ refPaths: ["/proj/ref.png"] }), "/proj", settings());
    const [, req] = generateImage.mock.calls[0] as unknown as [unknown, { size?: string; images?: string[] }];
    expect(req.images).toHaveLength(1);
    const [w, h] = req.size!.split("*").map(Number);
    expect(h).toBeGreaterThan(w);
    expect(w * h).toBeLessThanOrEqual(1024 * 1024);
  });
});
