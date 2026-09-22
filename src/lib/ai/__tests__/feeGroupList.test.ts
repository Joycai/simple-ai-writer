/**
 * lib/ai/feeGroupList —— 列表怎么分段、怎么过滤。
 *
 * 这里钉的全是**静默错法**：搜不到、分错段、段序在两台机器上不一样。界面
 * 照常渲染，只是少了几行或者多了一段，不会有任何报错。
 */
import { describe, expect, it } from "vitest";

import {
  feeGroupOptions, knownVendors, matchFeeGroups, organizeFeeGroups, vendorKey,
  type BoundModelRef,
} from "../feeGroupList";
import type { FeeGroup } from "../feeGroup";

const group = (id: string, name: string, vendor?: string): FeeGroup => ({
  id, name, vendor,
  billingMode: "token",
  inputPrice: 1, cacheInputPrice: null, outputPrice: 2, requestPrice: 0,
  outputUnit: "image", outputRates: [], inputUnitPrice: 0, inputFreeUnits: 0,
  createdAt: 100,
});

/** 设计稿 2a 的那九个组，顺序就是列表里的顺序。 */
const GROUPS: FeeGroup[] = [
  group("g1", "Claude Sonnet 4.5", "Anthropic"),
  group("g2", "Claude Haiku 4.5", "Anthropic"),
  group("g3", "千问 3.8 · 标准", "阿里云百炼"),
  group("g4", "千问 · 录音转写", "阿里云百炼"),
  group("g5", "qwen-image · 按档", "阿里云百炼"),
  group("g6", "即梦 4.0 · 按张", "字节 · 火山方舟"),
  group("g7", "gpt-image 系列", "OpenAI"),
  group("g8", "某中转 · 按次"),
  group("g9", "本机 Ollama", "   "),
];

const MODELS: BoundModelRef[] = [
  { feeGroupId: "g1", name: "Sonnet", modelId: "claude-sonnet-4.5" },
  { feeGroupId: "g3", name: "通义千问 Flash", modelId: "qwen3.8-flash" },
  { feeGroupId: "g3", name: "通义千问 Plus", modelId: "qwen3.8-plus" },
  { feeGroupId: "g3", name: "视觉理解", modelId: "[API]qwen3-vl-flash" },
  { feeGroupId: "g4", name: "录音文件识别", modelId: "qwen3-asr-flash" },
  { feeGroupId: "g5", name: "qwen-image", modelId: "qwen-image-plus" },
  { feeGroupId: null, name: "没绑组的", modelId: "gemma4:12b" },
];

const names = (sections: ReturnType<typeof organizeFeeGroups>) =>
  sections.map((s) => [s.vendor, s.hits.map((h) => h.group.name)]);

describe("vendorKey / knownVendors", () => {
  it("空、空白、undefined 都是同一个「没填」", () => {
    expect(vendorKey(undefined)).toBe("");
    expect(vendorKey("")).toBe("");
    expect(vendorKey("   ")).toBe("");
  });

  it("候选去重按大小写不敏感，显示第一次出现的写法", () => {
    const gs = [group("a", "A", "OpenAI"), group("b", "B", "openai"), group("c", "C", "  OPENAI ")];
    expect(knownVendors(gs)).toEqual(["OpenAI"]);
  });

  it("候选按出现顺序，没填的不进候选", () => {
    expect(knownVendors(GROUPS)).toEqual(["Anthropic", "阿里云百炼", "字节 · 火山方舟", "OpenAI"]);
  });
});

describe("matchFeeGroups", () => {
  it("空查询不过滤，而不是全部落选", () => {
    expect(matchFeeGroups(GROUPS, MODELS, "").map((h) => h.group.id)).toEqual(GROUPS.map((g) => g.id));
    expect(matchFeeGroups(GROUPS, MODELS, "   ").length).toBe(GROUPS.length);
  });

  it("组名命中，大小写无关", () => {
    expect(matchFeeGroups(GROUPS, MODELS, "OLLAMA").map((h) => h.group.id)).toEqual(["g9"]);
  });

  it("厂商命中", () => {
    expect(matchFeeGroups(GROUPS, MODELS, "anthropic").map((h) => h.group.id)).toEqual(["g1", "g2"]);
  });

  it("绑着的模型的 id 命中——组名里一个字母都没有它", () => {
    const hits = matchFeeGroups(GROUPS, MODELS, "qwen");
    expect(hits.map((h) => h.group.id)).toEqual(["g3", "g4", "g5"]);
  });

  it("命中模型只在组名和厂商都没命中时才写出来", () => {
    const by = new Map(matchFeeGroups(GROUPS, MODELS, "qwen").map((h) => [h.group.id, h.matchedModels]));
    // g3 / g4 的组名是中文，是被模型命中的——要说出是哪几个。
    expect(by.get("g3")).toEqual(["通义千问 Flash", "通义千问 Plus", "视觉理解"]);
    expect(by.get("g4")).toEqual(["录音文件识别"]);
    // g5 的组名里就有 qwen，再挂一串模型名只是噪音。
    expect(by.get("g5")).toEqual([]);
  });

  it("没绑这个组的模型不算它的命中", () => {
    // gemma4 那一行 feeGroupId 是 null，不该把任何组拖进结果。
    expect(matchFeeGroups(GROUPS, MODELS, "gemma")).toEqual([]);
  });

  it("模型没有显示名时退回 modelId", () => {
    const models: BoundModelRef[] = [{ feeGroupId: "g8", modelId: "relay-any" }];
    expect(matchFeeGroups(GROUPS, models, "relay")[0].matchedModels).toEqual(["relay-any"]);
  });
});

describe("organizeFeeGroups", () => {
  it("按厂商分段，段序是这一段第一个组在原列表里的位置", () => {
    expect(names(organizeFeeGroups(GROUPS, MODELS, ""))).toEqual([
      ["Anthropic", ["Claude Sonnet 4.5", "Claude Haiku 4.5"]],
      ["阿里云百炼", ["千问 3.8 · 标准", "千问 · 录音转写", "qwen-image · 按档"]],
      ["字节 · 火山方舟", ["即梦 4.0 · 按张"]],
      ["OpenAI", ["gpt-image 系列"]],
      ["", ["某中转 · 按次", "本机 Ollama"]],
    ]);
  });

  it("未填厂商的一段恒排最后，哪怕它在原列表里排第一", () => {
    const gs = [group("x", "没填的"), group("y", "有厂商的", "Anthropic")];
    expect(names(organizeFeeGroups(gs, [], ""))).toEqual([
      ["Anthropic", ["有厂商的"]],
      ["", ["没填的"]],
    ]);
  });

  it("只有空白的厂商和完全没填归同一段", () => {
    const sections = organizeFeeGroups(GROUPS, MODELS, "");
    const last = sections[sections.length - 1];
    expect(last.vendor).toBe("");
    expect(last.hits.map((h) => h.group.id)).toEqual(["g8", "g9"]);
  });

  it("大小写不同的厂商归一段，显示第一次出现的写法", () => {
    const gs = [group("a", "A", "OpenAI"), group("b", "B", "openai"), group("c", "C", "OPENAI")];
    expect(names(organizeFeeGroups(gs, [], ""))).toEqual([["OpenAI", ["A", "B", "C"]]]);
  });

  it("搜索之后段跟着收缩，空掉的段不留下来", () => {
    expect(names(organizeFeeGroups(GROUPS, MODELS, "qwen"))).toEqual([
      ["阿里云百炼", ["千问 3.8 · 标准", "千问 · 录音转写", "qwen-image · 按档"]],
    ]);
  });

  it("一个都没匹配上时是空数组，不是一堆空段", () => {
    expect(organizeFeeGroups(GROUPS, MODELS, "gemini")).toEqual([]);
  });
});

describe("feeGroupOptions", () => {
  const label = (g: FeeGroup) => g.name;

  it("厂商就是 group，段序和列表一致，未填厂商排最后", () => {
    const opts = feeGroupOptions(GROUPS, label, "未填厂商");
    expect(opts.map((o) => o.group)).toEqual([
      "Anthropic", "Anthropic",
      "阿里云百炼", "阿里云百炼", "阿里云百炼",
      "字节 · 火山方舟", "OpenAI",
      "未填厂商", "未填厂商",
    ]);
    expect(opts.map((o) => o.value)).toEqual(GROUPS.map((g) => g.id));
  });

  it("一个厂商都没填时不产生任何段首——全是「未填厂商」等于没分段", () => {
    const gs = [group("a", "A"), group("b", "B", "  ")];
    expect(feeGroupOptions(gs, label, "未填厂商")).toEqual([
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ]);
  });

  it("空表是空表", () => {
    expect(feeGroupOptions([], label, "未填厂商")).toEqual([]);
  });
});
