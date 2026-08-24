/**
 * ComfyUI 工作流（API 格式）的解析、占位识别与注入 —— 全部纯函数。
 *
 * 应用绝不自己构造节点图：作者在 ComfyUI 里搭好并跑通工作流后用「导出 (API)」
 * 存成 JSON 导入进来，这里只回答三个问题——这份 JSON 是不是能提交的格式、
 * 图里哪些节点是应用要填的占位（正面提示词 / seed / 尺寸 / 张数）、以及把
 * 一次请求的值填进去。识别是**读取时**做的而不是导入时固化 node id：存的
 * 永远只有原始 JSON，识别逻辑升级后老配置自动受益。
 *
 * 设计与取舍：docs/feature/comfyui-plan.md §1。
 */

/** 存进 `ImageCaps.comfy` 的配置——目前只有工作流原文一件事。 */
export interface ComfyWorkflowConfig {
  /** API 格式工作流 JSON 原文，与作者导出的文件逐字相同。 */
  workflow: string;
}

/** API 格式里的一个节点。`inputs` 的值是常量或 `[nodeId, slot]` 连线。 */
export interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

/** API 格式整体：node id → 节点。 */
export type ComfyGraph = Record<string, ComfyNode>;

export type ComfyParseError = "not-json" | "ui-format" | "empty" | "not-api-format";

/**
 * 解析一份导入的工作流文本。
 *
 * UI 保存格式（`nodes[]` + `links[]`——ComfyUI 里点「保存」得到的那个）被
 * 单独识别：它是作者最容易拿错的文件，报「格式不对」而不指明是哪种不对，
 * 作者只会以为功能坏了。见 comfyui-plan.md §1.1。
 */
export function parseComfyWorkflow(raw: string): { graph: ComfyGraph } | { error: ComfyParseError } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: "not-json" };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { error: "not-api-format" };
  }
  const obj = json as Record<string, unknown>;
  if (Array.isArray(obj.nodes) && "links" in obj) {
    return { error: "ui-format" };
  }
  const entries = Object.entries(obj).filter(([, v]) => typeof v === "object" && v !== null);
  if (entries.length === 0) return { error: "empty" };
  const graph: ComfyGraph = {};
  for (const [id, v] of entries) {
    const node = v as Partial<ComfyNode>;
    if (typeof node.class_type !== "string" || typeof node.inputs !== "object" || node.inputs === null) {
      return { error: "not-api-format" };
    }
    graph[id] = node as ComfyNode;
  }
  return { graph };
}

/** `[nodeId, slot]` 连线值的判定。 */
function isLink(v: unknown): v is [string, number] {
  return Array.isArray(v) && v.length === 2 && (typeof v[0] === "string" || typeof v[0] === "number");
}

const NEGATIVE_TITLE = /negative|负面|反向/i;
const POSITIVE_TITLE = /positive|正面/i;
/** 只有在不命中负面规则时才作数——「负面提示词」含「提示词」。 */
const PROMPT_TITLE = /prompt|提示词/i;

/** 带字符串 `text` 输入的节点（CLIPTextEncode 及同形的自定义节点）。 */
function hasTextInput(node: ComfyNode): boolean {
  return typeof node.inputs.text === "string";
}

export interface ComfyAnalysis {
  nodeCount: number;
  /** 正面提示词落点，找不到则 null——这张工作流当模型没法用。 */
  positive: { nodeId: string; via: "title" | "sampler" } | null;
  /** 负面提示词落点（PR1 只展示，不注入——模板里烤好的负面原样生效）。 */
  negative: { nodeId: string } | null;
  /** 带 seed / noise_seed 数值输入的节点，全部注入。 */
  seedNodes: string[];
  /** 带数值 width/height 的 latent 类节点（尺寸与 batch_size 的落点）。 */
  latent: { nodeId: string } | null;
  /** LoadImage 节点——PR2 参考图的入口，PR1 仅报告。 */
  loadImageNodes: string[];
}

/**
 * 识别占位节点。两层：标题约定（作者显式指定，最高优先）→ 采样器回溯
 * （找同时有 positive/negative 连线的节点，沿连线找到带 text 输入的目标）。
 * 判定顺序负面先于正面，测试锁着这一条。
 */
export function analyzeComfyWorkflow(graph: ComfyGraph): ComfyAnalysis {
  const ids = Object.keys(graph);
  let positive: ComfyAnalysis["positive"] = null;
  let negative: ComfyAnalysis["negative"] = null;

  // 第一层：标题约定。
  for (const id of ids) {
    const node = graph[id];
    if (!hasTextInput(node)) continue;
    const title = node._meta?.title ?? "";
    if (!title) continue;
    if (NEGATIVE_TITLE.test(title)) {
      negative ??= { nodeId: id };
    } else if (POSITIVE_TITLE.test(title) || PROMPT_TITLE.test(title)) {
      positive ??= { nodeId: id, via: "title" };
    }
  }

  // 第二层：采样器回溯，只补标题没答上的那半。
  if (!positive || !negative) {
    for (const id of ids) {
      const node = graph[id];
      const pos = node.inputs.positive;
      const neg = node.inputs.negative;
      if (!isLink(pos) || !isLink(neg)) continue;
      if (!positive) {
        const target = graph[String(pos[0])];
        if (target && hasTextInput(target)) positive = { nodeId: String(pos[0]), via: "sampler" };
      }
      if (!negative) {
        const target = graph[String(neg[0])];
        if (target && hasTextInput(target)) negative = { nodeId: String(neg[0]) };
      }
      if (positive && negative) break;
    }
  }

  const seedNodes = ids.filter((id) => {
    const inputs = graph[id].inputs;
    return typeof inputs.seed === "number" || typeof inputs.noise_seed === "number";
  });

  // 数值 width+height 的节点即 latent 类（EmptyLatentImage、EmptySD3LatentImage…）。
  // LoadImage 没有这两个输入，Resize 类节点有——多个命中时取带 batch_size 的
  // 那个优先，仍多个就取第一个：这正是标题约定之外「够用而不完备」的边界。
  const sized = ids.filter(
    (id) => typeof graph[id].inputs.width === "number" && typeof graph[id].inputs.height === "number",
  );
  const latentId = sized.find((id) => typeof graph[id].inputs.batch_size === "number") ?? sized[0];

  return {
    nodeCount: ids.length,
    positive,
    negative,
    seedNodes,
    latent: latentId ? { nodeId: latentId } : null,
    loadImageNodes: ids.filter((id) => graph[id].class_type === "LoadImage"),
  };
}

export interface ComfyInjection {
  prompt: string;
  /** 注入所有 seed 节点。不给则调用方应自己随机化（缓存问题见 plan §2）。 */
  seed?: number;
  width?: number;
  height?: number;
  /** 出图张数，落到 latent 节点的 batch_size 上；没有 latent 节点则忽略。 */
  batch?: number;
}

/**
 * 把一次请求的值填进图里，返回新图（入参不动）。
 *
 * 正面提示词是唯一的硬前提——填不进词的提交毫无意义，返回 null 让调用方
 * 报「无法定位正面提示词节点」。其余占位缺席都是软的：seed 没有就不注入
 * （缓存后果由调用方的随机化兜），尺寸/张数没有 latent 节点就丢弃。
 */
export function injectComfyInputs(graph: ComfyGraph, inj: ComfyInjection): ComfyGraph | null {
  const analysis = analyzeComfyWorkflow(graph);
  if (!analysis.positive) return null;

  const next: ComfyGraph = structuredClone(graph);
  next[analysis.positive.nodeId].inputs.text = inj.prompt;

  if (inj.seed !== undefined) {
    for (const id of analysis.seedNodes) {
      const inputs = next[id].inputs;
      if (typeof inputs.seed === "number") inputs.seed = inj.seed;
      if (typeof inputs.noise_seed === "number") inputs.noise_seed = inj.seed;
    }
  }

  if (analysis.latent) {
    const inputs = next[analysis.latent.nodeId].inputs;
    if (inj.width && inj.height) {
      inputs.width = inj.width;
      inputs.height = inj.height;
    }
    if (inj.batch && inj.batch > 1 && typeof inputs.batch_size === "number") {
      inputs.batch_size = inj.batch;
    }
  }

  return next;
}

/** `"832x1216"` / `"832*1216"` / `"832×1216"` → 数对；认不出返回 null。 */
export function parseComfySize(size: string | undefined): { width: number; height: number } | null {
  if (!size) return null;
  const m = size.toLowerCase().match(/^\s*(\d+)\s*[x*×]\s*(\d+)\s*$/);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}
