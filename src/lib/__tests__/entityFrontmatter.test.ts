/**
 * Entity frontmatter round-trip — a Phase 4 fix. serializeEntityFrontmatter
 * only escaped literal `"` in the summary/aliases, but summary comes from a
 * multi-line textarea. parseFrontmatter's parser is line-based, so a raw
 * newline inside the quoted scalar used to read back as a truncated summary
 * plus a corrupted, unrelated-looking next line — and the next save would
 * persist that corruption.
 */
import { describe, it, expect } from "vitest";
import { serializeEntityFrontmatter } from "../lore/entity";
import { parseFrontmatter } from "../fs/markdown";
import type { EntityMeta } from "../lore/model";

function roundTrip(meta: EntityMeta) {
  const serialized = serializeEntityFrontmatter(meta);
  // The whole frontmatter block must still be exactly one "---...---" region
  // — if a raw newline had leaked into the summary, this file would parse as
  // having ended its frontmatter early or would corrupt following lines.
  return parseFrontmatter(`${serialized}\n# Body\n`).data;
}

describe("serializeEntityFrontmatter / parseFrontmatter round-trip", () => {
  it("survives a multi-line summary without corrupting the key that follows it", () => {
    // Regression check for the literal failure mode: a raw newline in the
    // quoted scalar would make `category` look like part of the summary
    // value (or vice versa), rather than its own key.
    const meta: EntityMeta = {
      name: "Ava", aliases: ["A"], category: "characters",
      summary: "First line.\nSecond line.",
    };
    const data = roundTrip(meta);
    expect(data.summary).toBe("First line.\nSecond line.");
    expect(data.name).toBe("Ava");
    expect(data.category).toBe("characters");
  });

  it("survives a summary with backslashes, quotes, and a newline together", () => {
    const meta: EntityMeta = {
      name: "X", aliases: [], category: "items",
      summary: 'A "quoted" path C:\\new\nand a second line.',
    };
    const data = roundTrip(meta);
    expect(data.summary).toBe(meta.summary);
  });

  it("survives an alias containing a quote", () => {
    const meta: EntityMeta = {
      name: "X", aliases: ['Bob "The Bear"'], category: "characters", summary: "",
    };
    const data = roundTrip(meta);
    expect(data.aliases).toEqual(['Bob "The Bear"']);
  });

  it("dict: true round-trips; unmarked entities don't carry the line at all", () => {
    const marked: EntityMeta = {
      name: "词典·人名", aliases: [], category: "custom", summary: "", dict: true,
    };
    // The line-based parser yields the string "true" — the same value
    // readEntity accepts (see entity.ts).
    expect(roundTrip(marked).dict).toBe("true");

    const plain: EntityMeta = {
      name: "Ava", aliases: [], category: "characters", summary: "",
    };
    // Absent, not `dict: false`: every pre-existing entity's frontmatter must
    // stay byte-identical to what it was before the field existed.
    expect(serializeEntityFrontmatter(plain)).not.toContain("dict");
  });

  it("cover round-trips; entities without one don't carry the line at all", () => {
    const withCover: EntityMeta = {
      name: "沈知微", aliases: [], category: "characters", summary: "",
      cover: "portrait-sheet.png",
    };
    expect(roundTrip(withCover).cover).toBe("portrait-sheet.png");

    // Same absence rule as dict/collections: no cover, no line — and an
    // explicit null (the "取消档案头图" path) writes nothing either.
    const plain: EntityMeta = { name: "Ava", aliases: [], category: "characters", summary: "" };
    expect(serializeEntityFrontmatter(plain)).not.toContain("cover");
    expect(serializeEntityFrontmatter({ ...plain, cover: null })).not.toContain("cover");
  });
});
