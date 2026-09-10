/**
 * 转写结果缓存的纯逻辑层：一条结果住在哪、sidecar 记什么、键怎么算、清扫丢谁。
 * 不碰盘；`run.ts` 是碰盘的那个。目录约定、原子落盘和清扫节奏都照
 * `lib/import/cache.ts`（转换缓存）——两份缓存长得一样，作者只用记一条规矩。
 *
 * 为什么要缓存：一小时的音频 ¥0.8，而平台的结果链接 24 小时就失效。同一份
 * 文件同一组参数第二次转写（助手重问、作者换个输出偏好重写）直接命中，不付
 * 第二次。键是**内容哈希 + 模型 + 参数**：改名 / 搬家不重跑，改了分离开关要重跑
 * （结果真的不一样——多一列说话人），**换了模型也要重跑**。
 *
 * 模型进键而不是「命中时比一下 meta.model 不同就重跑」，是因为两种模型各留一份
 * 缓存：作者拿两个模型对比同一段录音时，来回切不会每切一次付一次钱。而 meta 里
 * 那份 `model` 仍然要在命中时核对（`isUsableMeta`）——目录名是**清洗过**的模型
 * id，理论上两个不同的 id 能洗成同一个字符串，而那一次错的代价是一份张冠李戴的
 * 文字稿：它会被写进项目，抬头还盖着另一个模型的名字。
 */

export const ASR_CACHE_DIR = ".ai-writer/tmp/asr";

/**
 * 结果 JSON 的解析或渲染规则变了就 +1，整批作废。目录名的算法变了也算——旧格式
 * 的条目再也不会被命中，留着只是等 TTL 到期的垃圾。
 *
 * 2：模型 id 进了目录名。
 */
export const ASR_CACHE_VERSION = 2;

/** 没被用过这么久的条目下次清扫丢掉。 */
export const ASR_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const ASR_RESULT_NAME = "result.json";
export const ASR_META_NAME = "meta.json";

/** 影响结果的请求参数——键里要带上的那几个。 */
export interface AsrRequestOptions {
  diarization: boolean;
  /** 多说话人时给平台的参考人数；只在 `diarization` 时有意义。 */
  speakerCount?: number;
  /** 语言提示，`["zh", "en"]` 这种；缺席＝自动检测。 */
  languageHints?: string[];
}

export interface AsrCacheMeta {
  /** 读取时的绝对路径，只作显示——键是内容。 */
  source: string;
  bytes: number;
  model: string;
  options: AsrRequestOptions;
  /** 平台报的计费秒数（`usage.duration` / `usage.seconds`），入账用它。 */
  billedSeconds: number | null;
  transcribedAt: number;
  lastUsedAt: number;
  version: number;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 参数的短标签：`d2` / `p`，后面跟语言提示；进目录名，所以只用 `[a-z0-9-]`。 */
export function optionsTag(o: AsrRequestOptions): string {
  const parts: string[] = [o.diarization ? `d${o.speakerCount ?? ""}` : "p"];
  const hints = (o.languageHints ?? []).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean);
  if (hints.length) parts.push(hints.join("-"));
  return parts.join("-");
}

/**
 * 模型 id 的目录名写法：小写，非 `[a-z0-9]` 一律成 `-`，收尾去掉多余的连字符。
 * 截断到 40 位——`qwen-audio-3.0-asr-flash-filetrans` 这一类名字已经够长，而目录
 * 名不是给人读完的，命中与否由它和哈希一起判定，真正的模型 id 记在 meta 里。
 */
export function modelTag(modelId: string): string {
  const tag = modelId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return tag || "model";
}

/** 目录名：内容哈希前 16 位 + 模型标签 + 参数标签。 */
export function cacheKeyOf(sha256: string, modelId: string, options: AsrRequestOptions): string {
  return `${sha256.slice(0, 16)}-${modelTag(modelId)}-${optionsTag(options)}`;
}

export function cacheRootFor(projectPath: string): string {
  return `${projectPath}/${ASR_CACHE_DIR}`;
}

export function cacheDirFor(projectPath: string, key: string): string {
  return `${cacheRootFor(projectPath)}/${key}`;
}

export function parseCacheMeta(text: string): AsrCacheMeta | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const source = typeof m.source === "string" ? m.source : null;
  const model = typeof m.model === "string" ? m.model : null;
  const bytes = num(m.bytes);
  const transcribedAt = num(m.transcribedAt);
  const lastUsedAt = num(m.lastUsedAt);
  const version = num(m.version);
  const o = m.options && typeof m.options === "object" ? (m.options as Record<string, unknown>) : null;
  if (source === null || model === null || bytes === null || transcribedAt === null || lastUsedAt === null || version === null || !o) {
    return null;
  }
  const options: AsrRequestOptions = {
    diarization: o.diarization === true,
    ...(num(o.speakerCount) !== null ? { speakerCount: num(o.speakerCount) as number } : {}),
    ...(Array.isArray(o.languageHints) ? { languageHints: o.languageHints.filter((h): h is string => typeof h === "string") } : {}),
  };
  return {
    source, bytes, model, options,
    billedSeconds: num(m.billedSeconds),
    transcribedAt, lastUsedAt, version,
  };
}

export function isCurrentMeta(meta: AsrCacheMeta | null): meta is AsrCacheMeta {
  return meta !== null && meta.version === ASR_CACHE_VERSION;
}

/**
 * 这一条缓存能不能给**这次**用——版本对上，而且确实是这个模型转的。
 *
 * 目录名已经带了模型，所以第二个条件平时永远为真；它防的是 `modelTag` 把两个
 * 不同的 id 洗成同一个字符串那一次。清扫（`planSweep`）不看这一条：它只按版本和
 * TTL 丢，别的模型的缓存是别人的资产，不是垃圾。
 */
export function isUsableMeta(meta: AsrCacheMeta | null, modelId: string): meta is AsrCacheMeta {
  return isCurrentMeta(meta) && meta.model === modelId;
}

export interface SweepEntry {
  name: string;
  meta: AsrCacheMeta | null;
}

/** 丢掉：没 sidecar 或读不出（半写的、`.tmp-` 残留）、版本不对、太久没用。`keep` 是本次要读写的那条。 */
export function planSweep(entries: readonly SweepEntry[], now: number, keep?: string): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.name === keep) continue;
    if (!isCurrentMeta(e.meta)) {
      out.push(e.name);
      continue;
    }
    if (now - e.meta.lastUsedAt > ASR_CACHE_TTL_MS) out.push(e.name);
  }
  return out;
}
