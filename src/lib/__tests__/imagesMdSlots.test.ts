/**
 * `images.md` and its **slot** line — the one storage format the type system had
 * to extend (docs/feature/lore/lore-entry-type-plan.md §7 坑 5).
 *
 * The format is `## <file>` plus a description block. A picture's image slot
 * rides as a `slot: <id>` line at the very top of that block, which is the least
 * destructive place it could go: a build that knows nothing about slots reads it
 * as the first line of the description — cosmetic, nothing lost — whereas a
 * grouping heading would be swallowed into the previous image's description and
 * a decorated `## file [slot]` heading would corrupt the filename itself.
 */
import { describe, expect, it } from "vitest";
import { parseImagesMd, serializeImagesMd } from "../lore/gallery";

describe("parseImagesMd", () => {
  it("reads a slot line and keeps it out of the description", () => {
    const raw = "## portrait.png\nslot: portrait\n三视图人设。\n\n## abacus.png\n随身算盘。";
    expect(parseImagesMd(raw)).toEqual([
      { file: "portrait.png", desc: "三视图人设。", slot: "portrait" },
      { file: "abacus.png", desc: "随身算盘。", slot: null },
    ]);
  });

  it("only reads the FIRST line as a slot", () => {
    // A description that happens to talk about slots stays a description.
    const raw = "## a.png\n这张图的 slot: 还没定。";
    expect(parseImagesMd(raw)[0]).toEqual({
      file: "a.png",
      desc: "这张图的 slot: 还没定。",
      slot: null,
    });
  });

  it("tolerates a slot line with no description, and blank lines before it", () => {
    expect(parseImagesMd("## a.png\nslot: map")[0]).toEqual({ file: "a.png", desc: "", slot: "map" });
    expect(parseImagesMd("## a.png\n\nslot: map\n地图。")[0]).toEqual({
      file: "a.png", desc: "地图。", slot: "map",
    });
  });

  it("reads a file written by a build that never heard of slots", () => {
    // The backwards half of the compatibility promise: no slot line, no slot.
    expect(parseImagesMd("## a.png\n描述。")).toEqual([
      { file: "a.png", desc: "描述。", slot: null },
    ]);
  });
});

describe("serializeImagesMd", () => {
  it("round-trips slot + description", () => {
    const entries = [
      { file: "a.png", desc: "第一张。", slot: "portrait" },
      { file: "b.png", desc: "", slot: "expression" },
      { file: "c.png", desc: "没有归类。", slot: null },
    ];
    expect(parseImagesMd(serializeImagesMd(entries))).toEqual(entries);
  });

  it("writes no slot line when there is no slot", () => {
    // An unclassified image must produce byte-identical output to what this file
    // looked like before slots existed — old projects keep clean diffs.
    expect(serializeImagesMd([{ file: "a.png", desc: "描述。", slot: null }]))
      .toBe("## a.png\n描述。\n");
    expect(serializeImagesMd([{ file: "a.png", desc: "描述。" }]))
      .toBe("## a.png\n描述。\n");
  });
});
