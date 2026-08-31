/**
 * The multi-instance half of the picker's memory.
 *
 * Two windows share one `config.db`, and both of these rows are lists each
 * window appends to from its own snapshot — so a plain write loses whichever
 * addition saved first. These are the merges `writePrefMerged` runs at persist
 * time; the rest of the module is thin enough to read.
 */
import { describe, expect, it } from "vitest";
import { mergeBlockedModels, mergeRecentModels } from "../ai/modelHealth";

const parse = (raw: string): string[] => JSON.parse(raw);

describe("mergeRecentModels", () => {
  it("keeps the other window's picks behind our own", () => {
    // We just picked `c`; the row already carried the other window's `b`, `a`.
    expect(parse(mergeRecentModels('["b","a"]', '["c"]'))).toEqual(["c", "b", "a"]);
  });

  it("does not duplicate a model both windows have picked", () => {
    expect(parse(mergeRecentModels('["b","a"]', '["a","c"]'))).toEqual(["a", "c", "b"]);
  });

  it("caps the merged row at the picker's row length", () => {
    const ours = JSON.stringify(["o1", "o2", "o3", "o4", "o5"]);
    const theirs = JSON.stringify(["t1", "t2", "t3", "t4", "t5"]);
    const merged = parse(mergeRecentModels(theirs, ours));
    expect(merged).toHaveLength(8);
    // Ours survive whole — they are the newer events — and theirs fill the rest.
    expect(merged.slice(0, 5)).toEqual(["o1", "o2", "o3", "o4", "o5"]);
    expect(merged.slice(5)).toEqual(["t1", "t2", "t3"]);
  });

  it("treats a missing row as empty", () => {
    expect(parse(mergeRecentModels(null, '["a"]'))).toEqual(["a"]);
  });

  it("survives a row it cannot read", () => {
    // An unreadable row must cost the other window's picks, not this write.
    expect(parse(mergeRecentModels("not json", '["a"]'))).toEqual(["a"]);
    expect(parse(mergeRecentModels('{"a":1}', '["a"]'))).toEqual(["a"]);
    expect(parse(mergeRecentModels('["b",7,null]', '["a"]'))).toEqual(["a", "b"]);
  });
});

describe("mergeBlockedModels", () => {
  it("keeps a block the other window recorded", () => {
    expect(parse(mergeBlockedModels('["theirs"]', '["ours"]')).sort()).toEqual(["ours", "theirs"]);
  });

  it("does not duplicate a block both windows recorded", () => {
    expect(parse(mergeBlockedModels('["a"]', '["a"]'))).toEqual(["a"]);
  });

  it("does not cap — a blocked list is a set, not a recency row", () => {
    const many = Array.from({ length: 12 }, (_, i) => `m${i}`);
    expect(parse(mergeBlockedModels(JSON.stringify(many), "[]"))).toHaveLength(12);
  });
});
