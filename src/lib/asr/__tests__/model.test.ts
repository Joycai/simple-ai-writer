import { describe, expect, it } from "vitest";
import { conversationalModels, isAsrOnly, parseAsrFormat, type Model } from "../../ai/configDb";
import { subAgentModel, SUBAGENT_KINDS, type SubAgentConfig, type SubAgentKind } from "../../agent/subagent";

// 执行方案 §1 不变量 1：转写模型绝不进对话候选，`asr` 档位只收它，别的档位拒收它。

function model(over: Partial<Model>): Model {
  return {
    id: "m", providerId: "p", modelId: "x", name: "x", type: "text",
    priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, ...over,
  };
}

function subs(kind: SubAgentKind, modelId: string): Record<SubAgentKind, SubAgentConfig> {
  const out = {} as Record<SubAgentKind, SubAgentConfig>;
  for (const k of SUBAGENT_KINDS) out[k] = { kind: k, modelId: k === kind ? modelId : null, enabled: k === kind };
  return out;
}

describe("asr model invariants", () => {
  const asr = model({ id: "asr", asrFormat: "dashscope-filetrans", modelId: "qwen-audio-3.0-asr-flash-filetrans" });
  const chat = model({ id: "chat" });

  it("conversationalModels 无条件排除 asrFormat 行", () => {
    expect(isAsrOnly(asr)).toBe(true);
    expect(conversationalModels([asr, chat]).map((m) => m.id)).toEqual(["chat"]);
  });

  it("asr 档位只收转写模型；writer 拒收它", () => {
    expect(subAgentModel("asr", [asr, chat], subs("asr", "asr"))?.id).toBe("asr");
    expect(subAgentModel("asr", [asr, chat], subs("asr", "chat"))).toBeNull();
    expect(subAgentModel("writer", [asr, chat], subs("writer", "asr"))).toBeNull();
    expect(subAgentModel("writer", [asr, chat], subs("writer", "chat"))?.id).toBe("chat");
  });

  it("parseAsrFormat：未知值 → undefined（当普通模型，不藏）", () => {
    expect(parseAsrFormat("dashscope-filetrans")).toBe("dashscope-filetrans");
    expect(parseAsrFormat("whisper")).toBeUndefined();
    expect(parseAsrFormat(null)).toBeUndefined();
  });
});
