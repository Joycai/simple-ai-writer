/**
 * 计费组：一组价格，被任意多个模型引用。
 *
 * 在这之前价格是模型行上的五个列（`price_in` / `price_cached_in` /
 * `price_out` / `price_per_image` / `price_per_second`），于是同一家的十几个
 * 模型要把同一份价抄十几遍，改价要改十几处，而且「按张」「按秒」两种计价
 * 方式只能各占一列、谁也说不清一次请求到底该读哪一列。计费组把「这类模型
 * 按什么算钱」单独立成一个实体，模型只持有一个引用。
 *
 * 这个模块是**纯的**：不碰数据库、不碰 store。它定义组的形状、三种计价
 * 模式的算式、规格档位的归一化与匹配，以及唯一的一份 `costOf()`。库那一侧
 * 在 `feeGroupDb.ts`，记账在 `usageRow.ts`。
 *
 * 三条不变量：
 * 1. **三种模式共用一行、字段全保留。** 切模式只换界面读哪几个字段，不清空
 *    别的模式的值——切回来价还在。
 * 2. **「没有」与「零」分得开。** `cacheInputPrice` 为 null 是「跟输入价一样」，
 *    为 0 是「缓存真免费」；上游报价为 null 是「没报」，为 0 是「上游说免费」。
 * 3. **算钱只有一份代码。** 汇总、分组、明细、估算都调 `costOf()`；用量行把
 *    当时的单价抄在自己身上，所以改组、删组、换组都动不了历史（见 usageRow.ts）。
 *
 * 设计依据与被推翻的做法记在 docs/feature/billing/01-fee-groups.md。
 */

/** 一个组按什么算钱。未知值按 `token` 读——那是这个应用历史上唯一的解释。 */
export type BillingMode = "token" | "request" | "spec";

export const BILLING_MODES: BillingMode[] = ["token", "request", "spec"];

export function parseBillingMode(v: unknown): BillingMode {
  return v === "request" || v === "spec" ? v : "token";
}

/**
 * 按规格计费时，一次请求数什么。
 *
 * `image` 数响应里真的带回来的图片张数，`second` 数请求的音视频秒数，
 * `clip` 是每次一条。这个应用今天用到前两个：出图走 `image`，转写走 `second`。
 */
export type OutputUnit = "image" | "second" | "clip";

export const OUTPUT_UNITS: OutputUnit[] = ["image", "second", "clip"];

export function parseOutputUnit(v: unknown): OutputUnit {
  return v === "second" || v === "clip" ? v : "image";
}

/**
 * 档位表的一行：三个条件都可选，空条件匹配一切。
 *
 * 三个都空 = 兜底行（「其他规格」）。用户不需要排序也不需要写兜底行，
 * `matchRate` 让填得最多的行赢。
 */
export interface SpecRate {
  size?: string;
  quality?: string;
  seconds?: number;
  price: number;
}

export interface FeeGroup {
  id: string;
  name: string;
  billingMode: BillingMode;
  /** token 模式：每百万输入 token。 */
  inputPrice: number;
  /** token 模式：每百万缓存命中 token。**null = 同输入价**，0 = 真免费。 */
  cacheInputPrice: number | null;
  /** token 模式：每百万输出 token。 */
  outputPrice: number;
  /** request 模式：每次请求。 */
  requestPrice: number;
  /** spec 模式：一次请求数什么。 */
  outputUnit: OutputUnit;
  /** spec 模式：档位表。空表 = 一律按 0 计，用量页标「未覆盖」。 */
  outputRates: SpecRate[];
  /** spec / request 模式：每张输入（参考）图的单价。0 = 不收。 */
  inputUnitPrice: number;
  /** spec 模式：每次请求免费的输入图张数。 */
  inputFreeUnits: number;
  /** 用户拖拽出来的顺序；有自己的写入口，整行更新不碰它。 */
  sortOrder?: number;
  createdAt: number;
}

/**
 * 解析后的价格，记账只读这个——不再回头查库。
 *
 * 与 `FeeGroup` 的差别只有两处：没有身份字段（名字、排序、创建时间不参与
 * 算钱），以及缓存价已经落成一个确定的数（`cacheInputPrice ?? inputPrice`）。
 */
export interface FeeConfig {
  billingMode: BillingMode;
  inputPrice: number;
  /** 已落地：组没填时这里是输入价。行上快照的就是这个数。 */
  cachePrice: number;
  outputPrice: number;
  requestPrice: number;
  outputUnit: OutputUnit;
  outputRates: SpecRate[];
  inputUnitPrice: number;
  inputFreeUnits: number;
}

/** 没有绑组的模型按这个算：一分不收，用量页照样记下数量。 */
export const ZERO_FEE: FeeConfig = {
  billingMode: "token",
  inputPrice: 0,
  cachePrice: 0,
  outputPrice: 0,
  requestPrice: 0,
  outputUnit: "image",
  outputRates: [],
  inputUnitPrice: 0,
  inputFreeUnits: 0,
};

export function feeConfigOf(g: FeeGroup): FeeConfig {
  return {
    billingMode: g.billingMode,
    inputPrice: g.inputPrice,
    cachePrice: g.cacheInputPrice ?? g.inputPrice,
    outputPrice: g.outputPrice,
    requestPrice: g.requestPrice,
    outputUnit: g.outputUnit,
    outputRates: g.outputRates,
    inputUnitPrice: g.inputUnitPrice,
    inputFreeUnits: g.inputFreeUnits,
  };
}

/**
 * 收不收输入图的钱。
 *
 * **单位不参与**：按张、按秒、按条都收。视频端点的首帧 / 参考图是在按秒
 * 标价之外另收的，只让单位为「张」的组收会让那一类一分记不到。按 token 的
 * 组不收——它的图已经算进 token 里了。
 */
export function chargesInputImages(f: FeeConfig): boolean {
  return (f.billingMode === "spec" || f.billingMode === "request") && f.inputUnitPrice > 0;
}

/** 档位表里没有全空条件的行 ⇒ 没命中的规格按 0 计，界面要说出来。 */
export function otherSpecsAtZero(f: FeeConfig): boolean {
  return f.billingMode === "spec" && !f.outputRates.some((r) => specificity(r) === 0);
}

// ── 规格 ─────────────────────────────────────────────────────────────────────

/** 一次请求的输出规格。全空 = 这次请求没有规格，只有空条件的行能匹配它。 */
export interface OutputSpec {
  size?: string;
  quality?: string;
  seconds?: number;
}

/**
 * 「让上游决定」的取值读成**空**。
 *
 * 它们不带规格：`auto` 是把档位的选择权交给模型，请求本身没说要哪一档。
 * 按字面存进去会让它永远匹配不上任何一行，于是整类请求静默记 0。
 */
const UNSPECIFIED = new Set(["", "auto", "not_set", "adaptive", "default", "none"]);

/**
 * 尺寸归一化。请求值、上游回显值、表里手填的条件**三方都过这一个函数**，
 * 匹配时就是纯相等——否则 `1k` 与 `1K`、`1024*1024` 与 `1024x1024` 是两个
 * 不同的档，而写表的人看不出区别。
 */
export function normalizeSize(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (UNSPECIFIED.has(s.toLowerCase())) return undefined;
  // 1024*1024 / 1024×1024 / 1024 X 1024 → 1024x1024
  const px = /^(\d+)\s*[xX*×]\s*(\d+)$/.exec(s);
  if (px) return `${px[1]}x${px[2]}`;
  // 1k / 1.5K → 1K / 1.5K（K 大写，小数保留）
  const k = /^(\d+(?:\.\d+)?)\s*[kK]$/.exec(s);
  if (k) return `${k[1]}K`;
  // 768P → 768p
  const p = /^(\d+)\s*[pP]$/.exec(s);
  if (p) return `${p[1]}p`;
  return s;
}

export function normalizeQuality(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  return s && !UNSPECIFIED.has(s) ? s : undefined;
}

/** 数字、数字字符串、`8s` 都认；≤ 0 或读不出来 → 空。 */
export function normalizeSeconds(v: unknown): number | undefined {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (!s || UNSPECIFIED.has(s)) return undefined;
    n = parseFloat(s.endsWith("s") ? s.slice(0, -1) : s);
  } else return undefined;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

export function normalizeSpec(raw: {
  size?: unknown;
  quality?: unknown;
  seconds?: unknown;
}): OutputSpec {
  const spec: OutputSpec = {};
  const size = normalizeSize(raw.size);
  const quality = normalizeQuality(raw.quality);
  const seconds = normalizeSeconds(raw.seconds);
  if (size) spec.size = size;
  if (quality) spec.quality = quality;
  if (seconds !== undefined) spec.seconds = seconds;
  return spec;
}

/** `1K · low · 8s`，缺的维度不写。 */
export function specLabel(s: OutputSpec): string {
  return [s.size, s.quality, s.seconds !== undefined ? `${s.seconds}s` : undefined]
    .filter(Boolean)
    .join(" · ");
}

/** 填了几个条件（0–3）。匹配的平局裁决。 */
export function specificity(r: SpecRate): number {
  return (r.size ? 1 : 0) + (r.quality ? 1 : 0) + (r.seconds !== undefined ? 1 : 0);
}

const K_TIER = /^(\d+(?:\.\d+)?)K$/;
const PIXELS = /^(\d+)x(\d+)$/;

/**
 * 像素尺寸落在表里的哪个 `NK` 档。
 *
 * 自由尺寸端点（qwen-image、wan、Seedream）**回显像素**（`1696x960`）却
 * **按档计价**（1K / 2K）。`NK` 档代表边长 `N·1024` 的正方形面积；像素尺寸
 * 取对数尺度上面积最近的档，**只在表里真有的档之间比**——所以不需要为每家
 * 写一张边界表，有 `1.5K` 行的表就按那家的分法切。
 *
 * 对数尺度而不是线性：档位是等比排布的（1K / 2K / 4K 面积成四倍），线性
 * 距离会让每一个中间尺寸都靠向更大的那档。
 */
export function tierOf(size: string | undefined, rates: SpecRate[]): string | undefined {
  if (!size) return undefined;
  const px = PIXELS.exec(size);
  if (!px) return undefined;
  const area = Number(px[1]) * Number(px[2]);
  if (!Number.isFinite(area) || area <= 0) return undefined;
  let best: string | undefined;
  let bestDist = Infinity;
  for (const r of rates) {
    const k = r.size ? K_TIER.exec(r.size) : null;
    if (!k) continue;
    const side = Number(k[1]) * 1024;
    const dist = Math.abs(Math.log(area) - Math.log(side * side));
    if (dist < bestDist) {
      bestDist = dist;
      best = r.size;
    }
  }
  return best;
}

/**
 * 档位匹配：**空条件匹配一切，填得最多的行赢，同样多先写的赢，同样多时
 * 精确尺寸压过靠面积落进来的档位。**
 *
 * 返回 null = 未覆盖：单价按 0 计，行上记 `matched: false`，用量页据此提示
 * 用户去补表。不静默挑一行凑数——挑错了只会记错钱而不报错。
 */
export function matchRate(rates: SpecRate[], spec: OutputSpec): SpecRate | null {
  const tier = tierOf(spec.size, rates);
  let best: SpecRate | null = null;
  let bestExact = false;
  for (const r of rates) {
    let exact = true;
    if (r.size !== undefined && r.size !== spec.size) {
      if (tier === undefined || r.size !== tier) continue;
      exact = false;
    }
    if (r.quality !== undefined && r.quality !== spec.quality) continue;
    if (r.seconds !== undefined && r.seconds !== spec.seconds) continue;
    const better =
      best === null ||
      specificity(r) > specificity(best) ||
      (specificity(r) === specificity(best) && exact && !bestExact);
    if (better) {
      best = r;
      bestExact = exact;
    }
  }
  return best;
}

// ── 算钱 ─────────────────────────────────────────────────────────────────────

/**
 * 一次计费请求的**全部计费依据**：数出来的量 + 当时的单价 + 上游报价。
 *
 * 这正是用量行快照下来的那几列（`usageRow.ts`），所以 `costOf()` 读一行历史
 * 与读一次刚发生的请求是同一件事——改组、删组、换组都动不了已记下的钱。
 * 单价跟着量一起传，而不是在这里回头查组：回头查当前价，改一次价历史全变。
 */
export interface Billed {
  billingMode: BillingMode;
  /** 与 `cacheTokens` **不重叠**：二者之和才是全部 prompt token。 */
  inputTokens: number;
  cacheTokens: number;
  outputTokens: number;
  /** 每百万。`cachePrice` 是**解析后**的价：组没填缓存价时这里是输入价。 */
  inputPrice: number;
  cachePrice: number;
  outputPrice: number;
  requests: number;
  requestPrice: number;
  /** spec 模式数出来的量（张 / 秒 / 1）。 */
  outputUnits: number;
  /** 命中档位的单价；未覆盖时为 0。 */
  outputUnitPrice: number;
  /** **计费**张数（免费的已扣）。与「发出去几张」是两个数。 */
  inputUnits: number;
  inputUnitPrice: number;
  /** 上游自己报的这次金额。null = 没报；0 = 上游说免费。 */
  reportedCost: number | null;
}

export const ZERO_BILLED: Billed = {
  billingMode: "token",
  inputTokens: 0, cacheTokens: 0, outputTokens: 0,
  inputPrice: 0, cachePrice: 0, outputPrice: 0,
  requests: 0, requestPrice: 0,
  outputUnits: 0, outputUnitPrice: 0,
  inputUnits: 0, inputUnitPrice: 0,
  reportedCost: null,
};

/**
 * 成本拆成七个部分。界面按部分上色、汇总按部分加；每种模式只有自己的
 * 那几项非零。
 */
export interface CostParts {
  input: number;
  cache: number;
  output: number;
  request: number;
  spec: number;
  specInput: number;
  reported: number;
}

const ZERO_PARTS: CostParts = {
  input: 0, cache: 0, output: 0, request: 0, spec: 0, specInput: 0, reported: 0,
};

/** SQLite 的 REAL 列里塞得进文本，读出来的坏格当缺失，不让一行毁掉整页。 */
function fin(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > -Infinity ? n : 0;
}

/** 上游报价可信吗。空 ≠ 0：没报是 null，上游说 0 就是 0；负数 / 非有限当没报。 */
export function hasReportedCost(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * 这一次到底花了多少——**全应用唯一的一份算式**。
 *
 * 上游报价压过一切：它含输入侧，所以不是叠加而是替换。按 token 的默认组
 * （$0）挂着一个出图模型时，也正是靠它把账记对。
 */
export function costOf(b: Billed): CostParts {
  if (hasReportedCost(b.reportedCost)) return { ...ZERO_PARTS, reported: b.reportedCost };
  switch (b.billingMode) {
    case "token":
      return {
        ...ZERO_PARTS,
        input: (fin(b.inputTokens) * fin(b.inputPrice)) / 1_000_000,
        cache: (fin(b.cacheTokens) * fin(b.cachePrice)) / 1_000_000,
        output: (fin(b.outputTokens) * fin(b.outputPrice)) / 1_000_000,
      };
    case "request":
      return {
        ...ZERO_PARTS,
        request: fin(b.requests) * fin(b.requestPrice),
        specInput: fin(b.inputUnits) * fin(b.inputUnitPrice),
      };
    case "spec":
      return {
        ...ZERO_PARTS,
        spec: fin(b.outputUnits) * fin(b.outputUnitPrice),
        specInput: fin(b.inputUnits) * fin(b.inputUnitPrice),
      };
  }
}

export function totalOf(p: CostParts): number {
  return p.input + p.cache + p.output + p.request + p.spec + p.specInput + p.reported;
}

// ── 数量：从一次请求数出计费用的量 ──────────────────────────────────────────

/** `priceSpec()` 数出来的东西——用量行输出 / 输入两侧的快照。 */
export interface PricedSpec {
  spec: OutputSpec;
  /** 有没有命中档位。false = 未覆盖，单价 0，用量页提示补表。 */
  matched: boolean;
  outputUnits: number;
  outputUnitPrice: number;
  outputUnit: OutputUnit;
  /** **实际发出**的参考图张数（给界面看）。 */
  inputImages: number;
  /** **计费**张数（免费的已扣）。 */
  inputUnits: number;
  inputUnitPrice: number;
}

/**
 * 纯函数：给定组的价格、这次请求的规格与交付量，数出该记哪些量。
 *
 * 三条到达路径（同步、流式、长任务提交）都走它，所以每条路径一条测试就
 * 钉得住。它不碰库、不碰时间、不碰随机数。
 *
 * `delivered` 的意思是「上游真的交付了东西」：一张图都没出来的请求输出
 * 记 0，**输入图也不收**——没出图不是一次事件，而不是「出了 0 张」。
 */
export function priceSpec(
  f: FeeConfig,
  raw: { size?: unknown; quality?: unknown; seconds?: unknown },
  counted: { outputUnits: number; inputImages: number },
): PricedSpec {
  const spec = normalizeSpec(raw);
  const sent = Math.max(0, Math.floor(fin(counted.inputImages)));
  const outputUnits = f.billingMode === "spec" ? Math.max(0, fin(counted.outputUnits)) : 0;
  // 按次 = 按成功请求，没有「交付了几个单位」的概念；按规格看有没有出东西。
  const delivered = f.billingMode === "request" ? true : outputUnits > 0;
  const charges = chargesInputImages(f) && delivered;
  const hit = f.billingMode === "spec" ? matchRate(f.outputRates, spec) : null;
  return {
    spec,
    matched: f.billingMode !== "spec" || hit !== null,
    outputUnits,
    outputUnitPrice: hit ? fin(hit.price) : 0,
    outputUnit: f.outputUnit,
    inputImages: sent,
    inputUnits: charges ? Math.max(0, sent - Math.max(0, Math.floor(f.inputFreeUnits))) : 0,
    inputUnitPrice: charges ? f.inputUnitPrice : 0,
  };
}
