/**
 * 视觉理解 / 音频 ASR 两个模型类型的不变量（configDb 的 canSeeImages /
 * isAsrOnly / normalizeAsrIdentity，以及读它们的候选与线格式）。
 */
import { describe, expect, it } from "vitest";
import {
  canAutoSelectAsChat, canSeeImages, chatModels, conversationalModels, isAsrOnly, MODEL_TYPES, normalizeAsrIdentity, parseModelType,
  type Model,
} from "../configDb";
import { chainCanSeeImages, subAgentModel, SUBAGENT_KINDS, type SubAgentConfig, type SubAgentKind } from "../../agent/subagentModel";
import { declarationMarks, wireSummary } from "../modelSummary";

function model(over: Partial<Model>): Model {
  return {
    id: "m", providerId: "p", modelId: "x", name: "x", type: "text",
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, ...over,
  };
}

function subs(kind: SubAgentKind, modelId: string | null): Record<SubAgentKind, SubAgentConfig> {
  const out = {} as Record<SubAgentKind, SubAgentConfig>;
  for (const k of SUBAGENT_KINDS) out[k] = { kind: k, modelId: k === kind ? modelId : null, enabled: k === kind };
  return out;
}

describe("model types", () => {
  it("parseModelType reads every declared type and degrades the unknown to text", () => {
    for (const t of MODEL_TYPES) expect(parseModelType(t)).toBe(t);
    expect(parseModelType("hologram")).toBe("text");
    expect(MODEL_TYPES).toEqual(expect.arrayContaining(["vision", "asr"]));
  });

  it("canSeeImages: multimodal and vision, nothing else", () => {
    const seeing = MODEL_TYPES.filter((type) => canSeeImages({ type }));
    expect(seeing).toEqual(["multimodal", "vision"]);
  });
});

describe("vision", () => {
  const vl = model({ id: "vl", type: "vision", modelId: "qwen3-vl-plus" });
  const text = model({ id: "text" });

  it("stays conversational — it can be the main model", () => {
    expect(conversationalModels([vl, text]).map((m) => m.id)).toEqual(["vl", "text"]);
  });

  it("binds to the vision subagent and lights the image path as a main model", () => {
    expect(subAgentModel("vision", [vl, text], subs("vision", "vl"))?.id).toBe("vl");
    expect(chainCanSeeImages(vl, subs("vision", null), [vl, text])).toBe(true);
    expect(chainCanSeeImages(text, subs("vision", null), [vl, text])).toBe(false);
  });

  it("is never the writer", () => {
    expect(subAgentModel("writer", [vl, text], subs("writer", "vl"))).toBeNull();
    expect(subAgentModel("writer", [vl, text], subs("writer", "text"))?.id).toBe("text");
  });

  it("vl_high_resolution_images reaches the wire summary on the openai family only", () => {
    const m = { ...vl, vlHighResolution: true };
    expect(wireSummary(m, "openai_compat")).toContainEqual({ key: "vl_high_resolution_images", value: "true" });
    expect(wireSummary(m, "anthropic_compat").map((i) => i.key)).not.toContain("vl_high_resolution_images");
    // …and on a platform whose ① wire reads it — 智谱 ignores it.
    expect(wireSummary(m, "openai_compat", "https://open.bigmodel.cn/api/paas/v4").map((i) => i.key))
      .not.toContain("vl_high_resolution_images");
  });
});

describe("image and video rows are not chat models", () => {
  const text = model({ id: "text" });
  const image = model({ id: "image", type: "image" });
  const video = model({ id: "video", type: "video" });
  const translate = model({ id: "sakura", translateFormat: "sakura" });

  it("chatModels drops them, conversationalModels keeps them for the 出图 picker", () => {
    expect(chatModels([text, image, video, translate]).map((m) => m.id)).toEqual(["text"]);
    expect(conversationalModels([text, image, video, translate]).map((m) => m.id)).toEqual(["text", "image", "video"]);
  });

  it("no conversational subagent kind runs on one", () => {
    for (const kind of ["search", "vision", "longread", "pdf", "retrieval", "writer"] as const) {
      expect(subAgentModel(kind, [image, video], subs(kind, "image"))).toBeNull();
      expect(subAgentModel(kind, [image, video], subs(kind, "video"))).toBeNull();
    }
    expect(subAgentModel("imagegen", [image], subs("imagegen", "image"))?.id).toBe("image");
  });

  it("auto-selection agrees with the picker", () => {
    for (const m of [text, image, video, translate]) {
      expect(canAutoSelectAsChat(m)).toBe(chatModels([m]).length > 0);
    }
  });
});

describe("asr is the type, asrFormat the endpoint", () => {
  it("isAsrOnly keys on the type", () => {
    expect(isAsrOnly({ type: "asr" })).toBe(true);
    expect(isAsrOnly({ type: "text" })).toBe(false);
  });

  it("a row saved before the type existed (format only) is upgraded to asr", () => {
    const legacy = model({ type: "text", asrFormat: "dashscope-filetrans" });
    const upgraded = normalizeAsrIdentity(legacy);
    expect(upgraded.type).toBe("asr");
    expect(conversationalModels([upgraded])).toEqual([]);
  });

  it("an asr row missing its format gets the only one", () => {
    expect(normalizeAsrIdentity(model({ type: "asr" })).asrFormat).toBe("dashscope-filetrans");
  });

  it("leaves every other row untouched (same object)", () => {
    const plain = model({ type: "vision" });
    expect(normalizeAsrIdentity(plain)).toBe(plain);
  });

  it("carries no declaration marks on the list row", () => {
    expect(declarationMarks({ type: "asr", thinkingCategory: "qwen-budget" })).toEqual([]);
  });
});
