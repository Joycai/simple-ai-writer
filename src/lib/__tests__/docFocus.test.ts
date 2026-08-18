/**
 * The chat's document policy: describe by default, inject when asked.
 *
 * The regressions this guards are asymmetric. A cue that stops matching costs
 * one read_file round — annoying. A brief that stops saying the text was
 * withheld costs correctness: the model answers about a document it was told
 * exists and never read, and the answer looks exactly like a real one.
 */
import { describe, expect, it } from "vitest";

import { documentBrief, queryWantsDocument, wantsDocumentBody } from "../context/docFocus";

const DOC = `# 第三章 雨夜

雨下了一整夜。

## 一

他推开门。

## 二

灯还亮着。
`;

describe("queryWantsDocument", () => {
  it("matches the words that only mean the open file", () => {
    for (const q of [
      "把这一段改得紧凑些",
      "这段话读起来很别扭",
      "本章的节奏怎么样？",
      "帮我通读全文，看看有没有前后矛盾",
      "继续写下去",
      "接着往下写一段",
      "当前文档还缺什么？",
      "polish this paragraph",
      "summarize the current document",
      "continue writing from here",
      "does the whole chapter hold together?",
    ]) {
      expect(queryWantsDocument(q), q).toBe(true);
    }
  });

  it("leaves everything else to the assistant's own judgement", () => {
    for (const q of [
      "艾尔登的剑叫什么名字？",
      "帮我把设定里重复的条目合并一下",
      "第七章在哪个文件夹",
      "what models do you support?",
      "给这本书起个书名",
      "",
    ]) {
      expect(queryWantsDocument(q), q).toBe(false);
    }
  });
});

describe("wantsDocumentBody", () => {
  it("treats a pinned passage as pointing at the document", () => {
    expect(wantsDocumentBody({ query: "改一下", hasQuote: true, alreadyAttached: false }))
      .toBe(true);
  });

  it("does not send the window when the author already @-ed the file", () => {
    // chatRefs inlined the whole file; the window would repeat it.
    expect(wantsDocumentBody({ query: "把这一段改短", hasQuote: true, alreadyAttached: true }))
      .toBe(false);
  });

  it("stays out of the way for an unrelated question", () => {
    expect(wantsDocumentBody({
      query: "艾尔登多大年纪了", hasQuote: false, alreadyAttached: false,
    })).toBe(false);
  });
});

describe("documentBrief", () => {
  it("carries the title and outline — and never the body", () => {
    const brief = documentBrief(DOC);
    expect(brief).toContain("第三章 雨夜");
    expect(brief).toContain("- 一");
    expect(brief).toContain("- 二");
    expect(brief).not.toContain("他推开门");
    // The one line whose absence turns a brief into a hallucination.
    expect(brief).toContain("read_file");
  });

  it("drops the withheld notice when the window is coming along", () => {
    const brief = documentBrief(DOC, { withheld: false });
    expect(brief).toContain("第三章 雨夜");
    expect(brief).not.toContain("read_file");
  });

  it("says a file is empty rather than reporting a length", () => {
    const brief = documentBrief("   \n");
    expect(brief).toMatch(/空文件|empty file/);
  });
});
