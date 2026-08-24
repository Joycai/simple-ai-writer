/**
 * ComfyUI 工作流的解析 / 占位识别 / 注入。
 *
 * 锁住的行为里最重要的两条：UI 保存格式必须被**单独**识别（那是作者最容易
 * 拿错的文件，报错必须指向「导出 (API)」），以及标题判定**负面先于正面**
 * （「负面提示词」含「提示词」，顺序反了词会填错节点）。
 */
import { describe, it, expect } from "vitest";
import {
  analyzeComfyWorkflow, injectComfyInputs, parseComfySize, parseComfyWorkflow,
  type ComfyGraph,
} from "../workflow";

/** 一张最小但形状真实的 txt2img 工作流（API 格式）。 */
const WF: ComfyGraph = {
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 5, steps: 20, cfg: 7,
      positive: ["6", 0], negative: ["7", 0],
      latent_image: ["5", 0], model: ["4", 0],
    },
  },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl.safetensors" } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "old positive", clip: ["4", 1] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "old negative", clip: ["4", 1] } },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "ComfyUI" } },
};

const clone = (): ComfyGraph => structuredClone(WF);

describe("parseComfyWorkflow", () => {
  it("accepts an API-format graph", () => {
    const res = parseComfyWorkflow(JSON.stringify(WF));
    expect("graph" in res && Object.keys(res.graph)).toHaveLength(6);
  });

  it("names the UI save format specifically — the file authors grab by mistake", () => {
    const ui = JSON.stringify({ nodes: [{ id: 1 }], links: [], groups: [], version: 0.4 });
    expect(parseComfyWorkflow(ui)).toEqual({ error: "ui-format" });
  });

  it("rejects non-JSON, empty graphs and shapeless objects with distinct errors", () => {
    expect(parseComfyWorkflow("not json")).toEqual({ error: "not-json" });
    expect(parseComfyWorkflow("{}")).toEqual({ error: "empty" });
    expect(parseComfyWorkflow(JSON.stringify({ "3": { foo: 1 } }))).toEqual({ error: "not-api-format" });
    expect(parseComfyWorkflow(JSON.stringify([1, 2]))).toEqual({ error: "not-api-format" });
  });
});

describe("analyzeComfyWorkflow", () => {
  it("traces positive/negative through the sampler's links", () => {
    const a = analyzeComfyWorkflow(WF);
    expect(a.positive).toEqual({ nodeId: "6", via: "sampler" });
    expect(a.negative).toEqual({ nodeId: "7" });
    expect(a.seedNodes).toEqual(["3"]);
    expect(a.latent).toEqual({ nodeId: "5" });
  });

  it("lets a node title override the trace", () => {
    const g = clone();
    g["6"]._meta = { title: "正面提示词" };
    const a = analyzeComfyWorkflow(g);
    expect(a.positive).toEqual({ nodeId: "6", via: "title" });
  });

  it("checks the negative rule before the positive one — 「负面提示词」 contains 「提示词」", () => {
    const g = clone();
    delete g["3"].inputs.positive;
    delete g["3"].inputs.negative;
    g["6"]._meta = { title: "提示词" };
    g["7"]._meta = { title: "负面提示词" };
    const a = analyzeComfyWorkflow(g);
    expect(a.positive?.nodeId).toBe("6");
    expect(a.negative?.nodeId).toBe("7");
  });

  it("reports LoadImage nodes and counts noise_seed as a seed input", () => {
    const g = clone();
    g["10"] = { class_type: "LoadImage", inputs: { image: "ref.png" } };
    g["11"] = { class_type: "KSamplerAdvanced", inputs: { noise_seed: 1, positive: ["6", 0], negative: ["7", 0] } };
    const a = analyzeComfyWorkflow(g);
    expect(a.loadImageNodes).toEqual(["10"]);
    expect(a.seedNodes).toEqual(["3", "11"]);
  });
});

describe("injectComfyInputs", () => {
  it("fills prompt, seed, size and batch without touching the input graph", () => {
    const g = clone();
    const out = injectComfyInputs(g, { prompt: "a cat", seed: 42, width: 832, height: 1216, batch: 3 });
    expect(out).not.toBeNull();
    expect(out!["6"].inputs.text).toBe("a cat");
    expect(out!["7"].inputs.text).toBe("old negative"); // 模板里烤好的负面原样生效
    expect(out!["3"].inputs.seed).toBe(42);
    expect(out!["5"].inputs).toMatchObject({ width: 832, height: 1216, batch_size: 3 });
    // 入参没被改——注入返回的是新图。
    expect(g["6"].inputs.text).toBe("old positive");
    expect(g["3"].inputs.seed).toBe(5);
  });

  it("returns null when no positive-prompt node can be located", () => {
    const g = clone();
    delete g["3"].inputs.positive;
    delete g["3"].inputs.negative;
    expect(injectComfyInputs(g, { prompt: "x" })).toBeNull();
  });

  it("drops size/batch quietly when the graph has no latent node", () => {
    const g = clone();
    delete g["5"];
    const out = injectComfyInputs(g, { prompt: "x", width: 512, height: 512, batch: 2 });
    expect(out).not.toBeNull();
    expect(out!["6"].inputs.text).toBe("x");
  });
});

describe("parseComfySize", () => {
  it("reads the three separator spellings and rejects the rest", () => {
    expect(parseComfySize("832x1216")).toEqual({ width: 832, height: 1216 });
    expect(parseComfySize("1024*1024")).toEqual({ width: 1024, height: 1024 });
    expect(parseComfySize("1024 × 768")).toEqual({ width: 1024, height: 768 });
    expect(parseComfySize("2K")).toBeNull();
    expect(parseComfySize(undefined)).toBeNull();
  });
});
