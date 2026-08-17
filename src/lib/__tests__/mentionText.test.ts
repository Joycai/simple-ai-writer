/**
 * The transcript's reading of `@[名称]` references. What is pinned: the split
 * reproduces the sent text exactly (a bubble is a record), and only tokens the
 * picker could have spliced count as mentions.
 */
import { describe, expect, it } from "vitest";
import { splitMentions } from "../agent/mentionText";

/** The segments must reassemble into the original — a renderer drops nothing. */
function joined(text: string): string {
  return splitMentions(text).map((s) => s.text).join("");
}

describe("splitMentions", () => {
  it("passes plain text through as one segment", () => {
    expect(splitMentions("把这一段重写得更克制一些。")).toEqual([
      { kind: "text", text: "把这一段重写得更克制一些。" },
    ]);
  });

  it("keeps the literal @[名称] token in a mention segment", () => {
    const text = "对照 @[青鸾剑] 的出场设定，检查 @[第三章 · 雨夜行军] 里的形制描写。";
    const segs = splitMentions(text);
    expect(segs.filter((s) => s.kind === "mention").map((s) => s.text)).toEqual([
      "@[青鸾剑]",
      "@[第三章 · 雨夜行军]",
    ]);
    expect(joined(text)).toBe(text);
  });

  it("handles a message that is nothing but adjacent mentions", () => {
    const text = "@[甲]@[乙]";
    expect(splitMentions(text)).toEqual([
      { kind: "mention", text: "@[甲]" },
      { kind: "mention", text: "@[乙]" },
    ]);
  });

  it("leaves what the picker could not have produced as plain text", () => {
    // Unclosed, empty, and newline-crossing brackets are typed text, not refs.
    for (const text of ["还没选好 @[青鸾", "空的 @[] 引用", "跨行 @[青\n鸾]"]) {
      expect(splitMentions(text).every((s) => s.kind === "text")).toBe(true);
      expect(joined(text)).toBe(text);
    }
  });

  it("returns one empty text segment for an empty message", () => {
    expect(splitMentions("")).toEqual([{ kind: "text", text: "" }]);
  });
});
