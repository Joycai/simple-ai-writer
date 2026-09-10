import { describe, expect, it } from "vitest";
import {
  ASR_CACHE_TTL_MS,
  ASR_CACHE_VERSION,
  cacheKeyOf,
  isUsableMeta,
  modelTag,
  optionsTag,
  parseCacheMeta,
  planSweep,
  type AsrCacheMeta,
} from "../cache";

const sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const MODEL = "qwen-audio-3.0-asr-flash-filetrans";

describe("cacheKeyOf / optionsTag / modelTag", () => {
  it("同内容不同参数 → 不同键；键只含 [a-z0-9-]", () => {
    const plain = cacheKeyOf(sha, MODEL, { diarization: false });
    const diar = cacheKeyOf(sha, MODEL, { diarization: true, speakerCount: 2 });
    const zh = cacheKeyOf(sha, MODEL, { diarization: false, languageHints: ["zh", "en"] });
    expect(new Set([plain, diar, zh]).size).toBe(3);
    for (const k of [plain, diar, zh]) expect(k).toMatch(/^[0-9a-f]{16}-[a-z0-9-]+$/);
    expect(plain).toBe("0123456789abcdef-qwen-audio-3-0-asr-flash-filetrans-p");
    expect(diar).toBe("0123456789abcdef-qwen-audio-3-0-asr-flash-filetrans-d2");
    expect(zh).toBe("0123456789abcdef-qwen-audio-3-0-asr-flash-filetrans-p-zh-en");
  });
  it("换模型 → 换键：同内容同参数的两个模型各留一份缓存，来回切不重复付费", () => {
    const a = cacheKeyOf(sha, "qwen3-asr-flash-filetrans", { diarization: false });
    const b = cacheKeyOf(sha, MODEL, { diarization: false });
    expect(a).not.toBe(b);
  });
  it("模型标签只留 [a-z0-9-]，截断到 40 位，空的退回 model", () => {
    expect(modelTag("Qwen3/ASR_Flash.Filetrans")).toBe("qwen3-asr-flash-filetrans");
    expect(modelTag("...")).toBe("model");
    expect(modelTag("x".repeat(60))).toHaveLength(40);
  });
  it("语言提示里的奇怪字符去掉；分离没给人数是裸 d", () => {
    expect(optionsTag({ diarization: true, languageHints: ["zh-CN", "../x"] })).toBe("d-zhcn-x");
  });
});

describe("parseCacheMeta", () => {
  const meta: AsrCacheMeta = {
    source: "D:/p/a.wav", bytes: 10, model: "m", options: { diarization: true, speakerCount: 2, languageHints: ["zh"] },
    billedSeconds: 48, transcribedAt: 1, lastUsedAt: 2, version: ASR_CACHE_VERSION,
  };
  it("往返", () => {
    expect(parseCacheMeta(JSON.stringify(meta))).toEqual(meta);
  });
  // 目录名已经带了模型，所以这条平时永远为真；它防的是两个 id 洗成同一个标签
  // 那一次——那一次错的代价是一份张冠李戴、抬头还盖着另一个模型名字的文字稿。
  it("isUsableMeta：版本对上还不够，模型也要是这一个", () => {
    expect(isUsableMeta(meta, "m")).toBe(true);
    expect(isUsableMeta(meta, "other")).toBe(false);
    expect(isUsableMeta({ ...meta, version: ASR_CACHE_VERSION + 1 }, "m")).toBe(false);
    expect(isUsableMeta(null, "m")).toBe(false);
  });
  it("billedSeconds 缺席 → null；缺必填字段 / 非 JSON → null", () => {
    const { billedSeconds: _b, ...rest } = meta;
    expect(parseCacheMeta(JSON.stringify(rest))?.billedSeconds).toBeNull();
    expect(parseCacheMeta(JSON.stringify({ ...meta, options: undefined }))).toBeNull();
    expect(parseCacheMeta("{")).toBeNull();
  });
});

describe("planSweep", () => {
  const now = 10_000_000_000;
  const fresh = (name: string, over: Partial<AsrCacheMeta> = {}) => ({
    name,
    meta: { source: "s", bytes: 1, model: "m", options: { diarization: false }, billedSeconds: null, transcribedAt: now, lastUsedAt: now, version: ASR_CACHE_VERSION, ...over },
  });
  it("丢：没 sidecar、版本不对、过期；留：新鲜的和 keep", () => {
    const gone = planSweep([
      fresh("keep-me", { lastUsedAt: 0 }),
      fresh("fresh"),
      { name: "half", meta: null },
      fresh("old", { version: ASR_CACHE_VERSION + 1 }),
      fresh("stale", { lastUsedAt: now - ASR_CACHE_TTL_MS - 1 }),
    ], now, "keep-me");
    expect(gone.sort()).toEqual(["half", "old", "stale"]);
  });
});
