/**
 * The conversion cache's pure layer (lib/import/cache.ts): keys, sidecars,
 * the scan judgement and the sweep plan. docs/feature/agent/document-read-plan.md
 * D3, D5, D10.
 */
import { describe, expect, it } from "vitest";
import {
  CONVERT_CACHE_TTL_MS,
  CONVERT_CACHE_VERSION,
  cacheDirFor,
  cacheKeyOf,
  isCurrentMeta,
  looksScanned,
  parseCacheMeta,
  planSweep,
  sha256Hex,
  type ConvertCacheMeta,
} from "../import/cache";

const meta = (over: Partial<ConvertCacheMeta> = {}): ConvertCacheMeta => ({
  source: "/p/a.docx",
  ext: "docx",
  bytes: 10,
  convertedAt: 1_000,
  lastUsedAt: 1_000,
  version: CONVERT_CACHE_VERSION,
  pictures: 0,
  ...over,
});

describe("cache key", () => {
  it("is the content, not the path: same bytes → same key, one byte off → another", async () => {
    const a = await sha256Hex(new Uint8Array([1, 2, 3]));
    const b = await sha256Hex(new Uint8Array([1, 2, 3]));
    const c = await sha256Hex(new Uint8Array([1, 2, 4]));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(cacheKeyOf(a)).toHaveLength(16);
    expect(cacheKeyOf(a)).toBe(a.slice(0, 16));
  });

  it("lives under .ai-writer/tmp — outside list_files and read_file, inside read_image", () => {
    expect(cacheDirFor("/proj", "abcd")).toBe("/proj/.ai-writer/tmp/convert/abcd");
  });
});

describe("sidecar", () => {
  it("round-trips a complete record", () => {
    const m = meta({ pictures: 3 });
    expect(parseCacheMeta(JSON.stringify(m))).toEqual(m);
  });

  it("treats garbage, a non-object and a record missing a field as no sidecar", () => {
    expect(parseCacheMeta("{")).toBeNull();
    expect(parseCacheMeta("42")).toBeNull();
    const { lastUsedAt: _drop, ...partial } = meta();
    void _drop;
    expect(parseCacheMeta(JSON.stringify(partial))).toBeNull();
  });

  it("only a current-version sidecar counts as a hit", () => {
    expect(isCurrentMeta(meta())).toBe(true);
    expect(isCurrentMeta(meta({ version: CONVERT_CACHE_VERSION + 1 }))).toBe(false);
    expect(isCurrentMeta(null)).toBe(false);
  });
});

describe("looksScanned", () => {
  it("is true for page markers and page pictures alone", () => {
    const scan = ["<!-- page 1 -->", "", "![](assets/p1-1.jpg)", "", "<!-- page 2 -->", "", "![](assets/p2-1.jpg)"].join("\n");
    expect(looksScanned(scan)).toBe(true);
  });

  it("is true for an empty conversion", () => {
    expect(looksScanned("")).toBe(true);
  });

  it("is false once a line of prose is present", () => {
    const text = "<!-- page 1 -->\n\n第一章 投标须知前附表——本项目为某某工程施工总承包招标。\n";
    expect(looksScanned(text)).toBe(false);
  });

  it("does not count a stray short caption as a text layer", () => {
    expect(looksScanned("<!-- page 1 -->\n\n图 1\n\n![](assets/p1-1.jpg)")).toBe(true);
  });
});

describe("planSweep", () => {
  const now = 10 * CONVERT_CACHE_TTL_MS;

  it("drops the unreadable, the stale-version and the unused; keeps the recent", () => {
    const plan = planSweep(
      [
        { name: "fresh", meta: meta({ lastUsedAt: now - 1000 }) },
        { name: "old", meta: meta({ lastUsedAt: now - CONVERT_CACHE_TTL_MS - 1 }) },
        { name: "edge", meta: meta({ lastUsedAt: now - CONVERT_CACHE_TTL_MS }) },
        { name: "stale", meta: meta({ lastUsedAt: now, version: CONVERT_CACHE_VERSION - 1 }) },
        { name: "abcd.tmp-x1y2", meta: null },
      ],
      now,
    );
    expect(plan).toEqual(["old", "stale", "abcd.tmp-x1y2"]);
  });

  it("spares the entry the current call is about to touch, whatever its state", () => {
    expect(planSweep([{ name: "k", meta: null }], now, "k")).toEqual([]);
  });
});
