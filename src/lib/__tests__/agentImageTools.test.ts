/**
 * The agent's image tools, which are the only ones whose approval spends money.
 *
 * Two invariants matter more than the rest and are pinned here:
 *   - nothing is drawn before the author approves, so a rejected proposal
 *     costs exactly nothing;
 *   - an edit never overwrites the picture it came from, because the original
 *     may already be referenced elsewhere.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IllustrateProposal, ToolContext } from "../agent/registry";
import type { LoreIndex } from "../lore";

const generateImage = vi.fn();
vi.mock("../ai/image", () => ({ generateImage: (...a: unknown[]) => generateImage(...a) }));

// The tools reach for their model through the imagegen subagent's binding.
let storeModels: unknown[] = [];
let storeSubAgents: Record<string, unknown> = {};
vi.mock("../../stores/aiStore", () => ({
  useAiStore: {
    getState: () => ({ models: storeModels, providers: [], subAgents: storeSubAgents }),
  },
}));

const { generateImageTool, editImageTool } = await import("../agent/imageTools");

const IMAGE_MODEL = {
  id: "m1", providerId: "p1", modelId: "img-1", name: "Nano", type: "image",
  priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, pricePerImage: 0.04,
};

const ENTITY = {
  id: "elden", category: "characters", dirPath: "/proj/.ai-writer/lore/characters/elden",
  name: "艾尔登", aliases: [], summary: "", avatarPath: null, mdFiles: [],
  images: [{ file: "a.png", desc: "旧立绘", absPath: "/proj/.ai-writer/lore/characters/elden/a.png" }],
  facets: [],
};

const LORE: LoreIndex = { characters: [ENTITY] } as unknown as LoreIndex;

/** A context whose approval channel records what it was asked and says yes. */
function ctxWith(decision: { approved: boolean; reason?: string } = { approved: true }) {
  const seen: IllustrateProposal[] = [];
  const ctx = {
    projectPath: "/proj",
    loreIndex: LORE,
    multimodal: true,
    requestApproval: vi.fn(async (p) => { seen.push(p as IllustrateProposal); return decision; }),
  } as unknown as ToolContext;
  return { ctx, seen };
}

beforeEach(() => {
  generateImage.mockReset();
  storeModels = [IMAGE_MODEL];
  storeSubAgents = { imagegen: { kind: "imagegen", modelId: "m1", enabled: true } };
});

describe("generate_image", () => {
  it("proposes without drawing anything", async () => {
    const { ctx, seen } = ctxWith();
    await generateImageTool("c1", { prompt: "a knight in the rain", entity: "艾尔登" }, ctx);

    // The whole point of proposing first: approval is what spends the money.
    expect(generateImage).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("illustrate");
    expect(seen[0].prompt).toBe("a knight in the rain");
    expect(seen[0].dest).toEqual({ kind: "lore", entityName: "艾尔登", entityDir: ENTITY.dirPath, slot: null });
  });

  it("prices the run so the card can show what is being agreed to", async () => {
    const { ctx, seen } = ctxWith();
    await generateImageTool("c1", { prompt: "x", entity: "艾尔登" }, ctx);
    expect(seen[0].costUsd).toBeCloseTo(0.04, 10);
    expect(seen[0].modelName).toBe("Nano");
  });

  it("carries the framing tiers into the proposal — the agent's only channel to them", async () => {
    const { ctx, seen } = ctxWith();
    await generateImageTool("c1", {
      prompt: "x", entity: "艾尔登", aspect: "16:9", resolution: "2K", quality: "high",
    }, ctx);
    expect(seen[0].aspect).toBe("16:9");
    expect(seen[0].resolution).toBe("2K");
    expect(seen[0].quality).toBe("high");
  });

  it("drops tier values no dialect speaks instead of letting them ride to the wire", async () => {
    const { ctx, seen } = ctxWith();
    await generateImageTool("c1", {
      prompt: "x", entity: "艾尔登", resolution: "2048x2048", quality: "ultra",
    }, ctx);
    expect(seen[0].resolution).toBeUndefined();
    expect(seen[0].quality).toBeUndefined();
  });

  it("hands a rejection back with the author's reason", async () => {
    const { ctx } = ctxWith({ approved: false, reason: "太暗了" });
    const res = await generateImageTool("c1", { prompt: "x", entity: "艾尔登" }, ctx);
    expect(res.content).toMatch(/REJECTED/);
    expect(res.content).toMatch(/太暗了/);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("refuses an unknown entity instead of filing the picture somewhere else", async () => {
    const { ctx, seen } = ctxWith();
    const res = await generateImageTool("c1", { prompt: "x", entity: "无此人" }, ctx);
    expect(res.content).toMatch(/no lore entity/i);
    expect(seen).toHaveLength(0);
  });

  it("keeps document illustrations out of .ai-writer and out of bare directories", async () => {
    const { ctx, seen } = ctxWith();
    const res = await generateImageTool("c1", { prompt: "x", path: "/proj/.ai-writer/secrets.md" }, ctx);
    expect(res.content).toMatch(/\.md document inside the project/);

    // The project root itself is "within" the project but is not a document —
    // saveDocumentAsset would write to <proj>/../assets/ from it.
    const root = await generateImageTool("c1", { prompt: "x", path: "/proj" }, ctx);
    expect(root.content).toMatch(/\.md document inside the project/);
    expect(seen).toHaveLength(0);
  });

  it("needs a destination", async () => {
    const { ctx } = ctxWith();
    const res = await generateImageTool("c1", { prompt: "x" }, ctx);
    expect(res.content).toMatch(/entity.*path|path.*entity/i);
  });

  it("says so when the imagegen subagent is unusable, rather than proposing an unpriced run", async () => {
    storeModels = [];
    const { ctx, seen } = ctxWith();
    const res = await generateImageTool("c1", { prompt: "x", entity: "艾尔登" }, ctx);
    expect(res.content).toMatch(/subagent/i);
    expect(seen).toHaveLength(0);
  });

  it("does not fall back to some other image model when the binding is off", async () => {
    // The pre-subagent behaviour was "whatever image model exists" — routing
    // normally strips the tools before this can run, but the resolver must
    // agree with the routing rather than quietly resurrect the fallback.
    storeSubAgents = { imagegen: { kind: "imagegen", modelId: null, enabled: false } };
    const { ctx, seen } = ctxWith();
    const res = await generateImageTool("c1", { prompt: "x", entity: "艾尔登" }, ctx);
    expect(res.content).toMatch(/subagent/i);
    expect(seen).toHaveLength(0);
  });

  it("refuses on a surface with no approval channel", async () => {
    // Lore modals and batch runs can't render a card; drawing there would
    // spend money with nobody watching.
    const ctx = { projectPath: "/proj", loreIndex: LORE, multimodal: true } as unknown as ToolContext;
    const res = await generateImageTool("c1", { prompt: "x", entity: "艾尔登" }, ctx);
    expect(res.content).toMatch(/cannot review/i);
  });
});

describe("edit_image", () => {
  it("carries the source picture and files the result as a new one", async () => {
    const { ctx, seen } = ctxWith();
    await editImageTool("c1", { entity: "艾尔登", file: "a.png", instruction: "银白色头发" }, ctx);

    expect(seen[0].sourcePath).toBe(ENTITY.images[0].absPath);
    // Destination is the gallery, not the source file: overwriting a picture
    // that may already be referenced is a destructive act nobody approved.
    expect(seen[0].dest).toEqual({ kind: "lore", entityName: "艾尔登", entityDir: ENTITY.dirPath, slot: undefined });
    expect(seen[0].path).not.toBe(ENTITY.images[0].absPath);
  });

  it("inherits the old description when no new one is given", async () => {
    const { ctx, seen } = ctxWith();
    await editImageTool("c1", { entity: "艾尔登", file: "a.png", instruction: "银白色头发" }, ctx);
    expect(seen[0].note).toBe("旧立绘");
  });

  it("refuses a filename that isn't in the gallery", async () => {
    const { ctx, seen } = ctxWith();
    const res = await editImageTool("c1", { entity: "艾尔登", file: "nope.png", instruction: "x" }, ctx);
    expect(res.content).toMatch(/no gallery image/i);
    expect(seen).toHaveLength(0);
  });
});
