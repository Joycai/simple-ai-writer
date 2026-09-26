/**
 * The transcript's reading of `@[名称]` references. What is pinned: the split
 * reproduces the sent text exactly (a bubble is a record), and only tokens the
 * picker could have spliced count as mentions.
 */
import { describe, expect, it } from "vitest";
import { mentionToken, splitMentions, stripMentions } from "../mentionText";

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

  it("reads a name whose brackets pair up as one mention", () => {
    const text = `对照${mentionToken("潮汐[旧]")}，再看${mentionToken("夜航[上][下]")}`;
    expect(splitMentions(text).filter((s) => s.kind === "mention").map((s) => s.text)).toEqual([
      "@[潮汐[旧]]",
      "@[夜航[上][下]]",
    ]);
    expect(joined(text)).toBe(text);
  });

  it("reads every token mentionToken writes back as exactly that token", () => {
    for (const name of ["沈砚", "潮汐[旧]", "夜航]", "[夜航", "a]b[c", "[[潮汐]", "封面@2x.png", "][", "封面@[2x]", "手稿[旧]@2x.png"]) {
      const token = mentionToken(name);
      expect(splitMentions(`看看${token}的`)).toEqual([
        { kind: "text", text: "看看" },
        { kind: "mention", text: token },
        { kind: "text", text: "的" },
      ]);
    }
  });

  it("does not close a nested bracket at the first ]", () => {
    // Unbalanced to the end of the line: not a token, and the `]` inside is
    // not taken as the end of a shorter one.
    for (const text of ["看看 @[潮汐[旧] 的", "看看 @[潮汐[旧]\n]"]) {
      expect(splitMentions(text).every((s) => s.kind === "text")).toBe(true);
    }
  });
});

describe("a typed `@[` before a real reference", () => {
  it("does not swallow the reference: a nested `@[` starts a new token", () => {
    const text = "按@[旧稿，参考@[潮汐.md]里的写法]重写";
    expect(splitMentions(text).filter((s) => s.kind === "mention").map((s) => s.text)).toEqual(["@[潮汐.md]"]);
    expect(stripMentions(text)).toBe("按@[旧稿，参考里的写法]重写");
  });
});

describe("mentionToken", () => {
  it("keeps a name without brackets as it is", () => {
    expect(mentionToken("潮汐.png")).toBe("@[潮汐.png]");
  });

  it("keeps paired brackets and turns lone ones full-width", () => {
    expect(mentionToken("潮汐[旧]")).toBe("@[潮汐[旧]]");
    expect(mentionToken("夜航]")).toBe("@[夜航］]");
    expect(mentionToken("[夜航")).toBe("@[［夜航]");
    expect(mentionToken("a]b[c")).toBe("@[a］b［c]");
    expect(mentionToken("[[潮汐]")).toBe("@[［[潮汐]]");
    // `@[` never appears inside a name: readers would take it as a new token.
    expect(mentionToken("封面@[2x]")).toBe("@[封面@［2x］]");
  });
});

describe("stripMentions", () => {
  it("drops whole tokens, bracketed names included, and nothing else", () => {
    const text = `照${mentionToken("潮汐[旧]")}和${mentionToken("夜航]")}写一个门，@[没闭合`;
    expect(stripMentions(text)).toBe("照和写一个门，@[没闭合");
  });
});
