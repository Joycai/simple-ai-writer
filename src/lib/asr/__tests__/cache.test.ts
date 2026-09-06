import { describe, expect, it } from "vitest";
import {
  ASR_CACHE_TTL_MS,
  ASR_CACHE_VERSION,
  cacheKeyOf,
  optionsTag,
  parseCacheMeta,
  planSweep,
  type AsrCacheMeta,
} from "../cache";

const sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("cacheKeyOf / optionsTag", () => {
  it("同内容不同参数 → 不同键；键只含 [a-z0-9-]", () => {
    const plain = cacheKeyOf(sha, { diarization: false });
    const diar = cacheKeyOf(sha, { diarization: true, speakerCount: 2 });
    const zh = cacheKeyOf(sha, { diarization: false, languageHints: ["zh", "en"] });
    expect(new Set([plain, diar, zh]).size).toBe(3);
    for (const k of [plain, diar, zh]) expect(k).toMatch(/^[0-9a-f]{16}-[a-z0-9-]+$/);
    expect(plain).toBe("0123456789abcdef-p");
    expect(diar).toBe("0123456789abcdef-d2");
    expect(zh).toBe("0123456789abcdef-p-zh-en");
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
