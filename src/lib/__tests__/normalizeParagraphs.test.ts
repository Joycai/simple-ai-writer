/**
 * Paragraph tidying.
 *
 * What these tests are really guarding is the refusals. Getting the easy half
 * right (collapse blank runs, strip trailing spaces) is not where a formatter
 * hurts anyone; shredding a hard-wrapped paragraph into one paragraph per line,
 * or spacing out a tight list so it renders differently, is — and both are
 * silent, in a document the author asked to tidy precisely because they were not
 * reading it closely.
 */
import { describe, expect, it } from "vitest";

import { normalizeParagraphs } from "../format/paragraphs";

const run = (s: string) => normalizeParagraphs(s).text;

describe("normalizeParagraphs", () => {
  it("separates paragraphs that ran together", () => {
    // Rendered as one paragraph with a soft break until this blank line exists,
    // which is exactly what the author sees as "my paragraphs are stuck".
    expect(run("第一段。\n第二段。\n")).toBe("第一段。\n\n第二段。\n");
  });

  it("accepts the sentence-final punctuation of both languages", () => {
    expect(run("One sentence.\nAnother one.")).toBe("One sentence.\n\nAnother one.");
    expect(run("问题？\n回答！")).toBe("问题？\n\n回答！");
    expect(run("他说「走吧。」\n她没答话。")).toBe("他说「走吧。」\n\n她没答话。");
  });

  it("leaves hard-wrapped prose alone", () => {
    // The line breaks mid-sentence, so it is one paragraph the author wrapped
    // by hand — splitting it would be unrecoverable by anything but an undo.
    const wrapped = "This is a single paragraph that the author\nwrapped by hand across three\nsource lines.";
    expect(run(wrapped)).toBe(wrapped);
  });

  it("collapses runs of blank lines to one", () => {
    expect(run("一。\n\n\n\n二。")).toBe("一。\n\n二。");
  });

  it("strips trailing whitespace", () => {
    expect(run("一。   \n二。\t")).toBe("一。\n\n二。");
  });

  it("reports what it did, so the author can judge a whole-document change", () => {
    const r = normalizeParagraphs("一。\n二。 \n\n\n三。");
    expect(r).toMatchObject({ separated: 1, collapsed: 1, trimmed: 1 });
  });

  it("reports zero on a file that is already tidy", () => {
    const r = normalizeParagraphs("一。\n\n二。\n");
    expect(r).toMatchObject({ separated: 0, collapsed: 0, trimmed: 0 });
    expect(r.text).toBe("一。\n\n二。\n");
  });
});

describe("normalizeParagraphs — what it refuses to touch", () => {
  it("never spaces out a tight list", () => {
    // A tight list renders differently from a loose one, so inserting blanks
    // here would change the output the author never asked about.
    const list = "- 第一项。\n- 第二项。\n- 第三项。";
    expect(run(list)).toBe(list);
    expect(run("1. 一。\n2. 二。")).toBe("1. 一。\n2. 二。");
  });

  it("never splits a multi-line quote or table", () => {
    expect(run("> 引用一。\n> 引用二。")).toBe("> 引用一。\n> 引用二。");
    expect(run("| a. | b. |\n| -- | -- |")).toBe("| a. | b. |\n| -- | -- |");
  });

  it("does not insert between a paragraph and a following structural line", () => {
    // Doing nothing is the safe direction: the author can add the blank line,
    // and a list that quietly became loose is not something they would notice.
    expect(run("引子。\n- 第一项")).toBe("引子。\n- 第一项");
    expect(run("引子。\n## 小节")).toBe("引子。\n## 小节");
  });

  it("leaves fenced code exactly as it was, trailing spaces included", () => {
    // Whitespace can be significant in the language being quoted, and a blank
    // line inside a fence is part of the program.
    const fenced = "说明。\n\n```py\ndef f():   \n\n\n    return 1\n```\n";
    expect(run(fenced)).toBe(fenced);
  });

  it("does not report a fence's untouched trailing spaces as trimmed", () => {
    expect(normalizeParagraphs("```\na.   \n```").trimmed).toBe(0);
  });

  it("leaves frontmatter untouched", () => {
    const doc = "---\nname: 张三\nsummary: 一句话。\n---\n正文一。\n正文二。";
    expect(run(doc)).toBe("---\nname: 张三\nsummary: 一句话。\n---\n正文一。\n\n正文二。");
  });

  it("treats an unterminated frontmatter delimiter as ordinary text", () => {
    // Swallowing the rest of the file as "frontmatter" would silently disable
    // the whole command on a document that merely opens with a rule.
    expect(run("---\n一。\n二。")).toBe("---\n一。\n\n二。");
  });

  it("leaves an indented block alone", () => {
    expect(run("    code.\n    more.")).toBe("    code.\n    more.");
  });
});
