/**
 * 一致性检查的范围（lib/consistency/scope）：序列化往返、失效剔除、三档各自交给
 * 检索层的东西。
 */
import { describe, expect, it } from "vitest";
import type { LoreEntity, LoreIndex } from "../lore";
import {
  ALL_SCOPE, parseReviewScope, pinKey, resolveReviewScope, scopeForRun, serializeReviewScope,
  type ReviewScope,
} from "../consistency/scope";

const entity = (over: Partial<LoreEntity> & Pick<LoreEntity, "dirPath" | "name">): LoreEntity => ({
  id: over.name,
  category: "characters",
  aliases: [],
  summary: "",
  avatarPath: null,
  collections: [],
  mdFiles: [],
  images: [],
  facets: [],
  ...over,
});

const index: LoreIndex = {
  characters: [
    entity({ dirPath: "/p/lore/characters/lin", name: "林辰", collections: ["小说A"], facets: [{ file: "looks.md", title: "外貌", slot: null, keys: [], group: null, priority: 0 } as never] }),
    entity({ dirPath: "/p/lore/characters/su", name: "苏婉", collections: ["小说B"] }),
  ],
};

describe("serialize / parse", () => {
  it("round-trips every kind and folds empties to all", () => {
    expect(serializeReviewScope(ALL_SCOPE)).toBeNull();
    expect(parseReviewScope(null)).toEqual(ALL_SCOPE);
    expect(parseReviewScope("garbage")).toEqual(ALL_SCOPE);

    const cols: ReviewScope = { kind: "collections", names: ["小说A"] };
    expect(parseReviewScope(serializeReviewScope(cols))).toEqual(cols);
    expect(serializeReviewScope({ kind: "collections", names: [] })).toBeNull();

    const pins: ReviewScope = { kind: "entries", pins: [{ dirPath: "/p/lore/characters/lin", facetFile: "looks.md" }] };
    expect(parseReviewScope(serializeReviewScope(pins))).toEqual(pins);
    expect(serializeReviewScope({ kind: "entries", pins: [] })).toBeNull();
  });

  it("dedupes pins on parse", () => {
    const raw = JSON.stringify({
      kind: "entries",
      pins: [{ dirPath: "/a", facetFile: null }, { dirPath: "/a" }, { dirPath: "/a", facetFile: "f.md" }],
    });
    const scope = parseReviewScope(raw);
    expect(scope.kind).toBe("entries");
    if (scope.kind === "entries") expect(scope.pins.map(pinKey)).toEqual(["/a", "/a#f.md"]);
  });
});

describe("resolveReviewScope", () => {
  it("keeps collections that exist (declared or carried) and reports the rest", () => {
    const r = resolveReviewScope({ kind: "collections", names: ["小说A", "已删", "小说B"] }, index, ["小说A"]);
    expect(r.effective).toEqual({ kind: "collections", names: ["小说A", "小说B"] });
    expect(r.staleCollections).toEqual(["已删"]);
  });

  it("drops a pin whose entry or facet is gone, and never widens a facet pin", () => {
    const r = resolveReviewScope(
      {
        kind: "entries",
        pins: [
          { dirPath: "/p/lore/characters/lin", facetFile: "looks.md" },
          { dirPath: "/p/lore/characters/lin", facetFile: "gone.md" },
          { dirPath: "/p/lore/characters/nobody", facetFile: null },
        ],
      },
      index,
      [],
    );
    expect(r.effective).toEqual({
      kind: "entries",
      pins: [{ dirPath: "/p/lore/characters/lin", facetFile: "looks.md" }],
    });
    expect(r.stalePins.map((s) => s.label)).toEqual(["林辰 · gone", "nobody"]);
  });

  it("falls back to all when everything is stale", () => {
    const r = resolveReviewScope({ kind: "collections", names: ["x"] }, index, []);
    expect(r.effective).toEqual(ALL_SCOPE);
  });
});

describe("scopeForRun", () => {
  it("all follows the fence, collections override it, entries pin and refuse", () => {
    expect(scopeForRun(ALL_SCOPE, ["小说A"])).toMatchObject({ loreScope: ["小说A"], pinPaths: [], autoDiscovery: true, allowedDirs: null });
    expect(scopeForRun({ kind: "collections", names: ["小说B"] }, ["小说A"])).toMatchObject({ loreScope: ["小说B"], autoDiscovery: true });
    const e = scopeForRun({ kind: "entries", pins: [{ dirPath: "/p/lore/characters/lin", facetFile: "looks.md" }] }, ["小说A"]);
    expect(e.loreScope).toBeNull();
    expect(e.pinPaths).toEqual(["/p/lore/characters/lin#looks.md"]);
    expect(e.autoDiscovery).toBe(false);
    expect(e.allowedDirs?.has("/p/lore/characters/lin")).toBe(true);
  });
});
