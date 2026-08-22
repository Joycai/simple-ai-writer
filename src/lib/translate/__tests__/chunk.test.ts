import { describe, expect, it } from "vitest";
import {
  applyTranslations,
  chunkSource,
  DEFAULT_LINES_PER_CHUNK,
  halveChunk,
  isTranslatable,
  pairTranslation,
  splitDocument,
} from "../chunk";

const DOC = [
  "# 第一章　オトメのヒミツ",
  "",
  "![挿絵](assets/01.png)",
  "",
  "彼女は扉を開けた。",
  "https://www.pixiv.net/novel/show.php?id=9256002",
  "---",
  "「わたしは魔法愛姫です」",
  "",
].join("\n");

describe("isTranslatable", () => {
  it("认得假名、汉字与半角片假名", () => {
    expect(isTranslatable("彼は扉を開けた。")).toBe(true);
    expect(isTranslatable("# 第一章")).toBe(true);
    expect(isTranslatable("ｱｲｳｴｵ")).toBe(true);
  });

  it("空行、纯 URL、分隔线、纯 ASCII 都不送", () => {
    for (const line of ["", "   ", "https://example.com/a?b=1", "---", "**bold**", "12345"]) {
      expect(isTranslatable(line)).toBe(false);
    }
  });
});

describe("splitDocument", () => {
  it("只把有日文的行送进块，行号保留原文档的位置", () => {
    const { allLines, chunks } = splitDocument(DOC);
    expect(allLines).toHaveLength(9);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].lines.map((l) => l.index)).toEqual([0, 2, 4, 7]);
  });

  it("CRLF 归一为 LF", () => {
    const { allLines } = splitDocument("あ\r\nい\r\n");
    expect(allLines).toEqual(["あ", "い", ""]);
  });

  it("按行数切块，最后一块可以不满", () => {
    const doc = Array.from({ length: 125 }, (_, i) => `第${i}行です。`).join("\n");
    const { chunks } = splitDocument(doc, { linesPerChunk: 50 });
    expect(chunks.map((c) => c.lines.length)).toEqual([50, 50, 25]);
  });

  it("默认块大小落在实测的安全区", () => {
    // 实测 30 / 60 行稳，100 行退化。默认值动了就要重新量。
    expect(DEFAULT_LINES_PER_CHUNK).toBe(50);
  });

  it("一份没有日文的文档切出零块，而不是一个空块", () => {
    expect(splitDocument("\n\nhttps://example.com\n---\n").chunks).toEqual([]);
  });

  it("送出去的文本是逐行拼接，不带空行", () => {
    const { chunks } = splitDocument(DOC);
    expect(chunkSource(chunks[0])).toBe(
      "# 第一章　オトメのヒミツ\n![挿絵](assets/01.png)\n彼女は扉を開けた。\n「わたしは魔法愛姫です」",
    );
  });
});

describe("重组", () => {
  it("按行号写回，没有译文的行原样留下 —— 空行与 URL 的穿透就是这么实现的", () => {
    const { allLines, chunks } = splitDocument(DOC);
    const out = applyTranslations(
      allLines,
      pairTranslation(chunks[0], ["# 第一章　少女的秘密", "![插图](assets/01.png)", "她打开了门。", "「我是魔法爱姬」"]),
    );
    expect(out.split("\n")).toEqual([
      "# 第一章　少女的秘密",
      "",
      "![插图](assets/01.png)",
      "",
      "她打开了门。",
      "https://www.pixiv.net/novel/show.php?id=9256002",
      "---",
      "「我是魔法爱姬」",
      "",
    ]);
  });

  it("一个块不提交，它的原文就留在文档里", () => {
    // 不变量 3（坏译文永不落盘）在这一层的形态：run 只要不交这一块的行即可。
    const { allLines } = splitDocument(DOC);
    expect(applyTranslations(allLines, [])).toBe(DOC);
  });

  it("行数不等时 pairTranslation 返回空，而不是错位配对", () => {
    // 错位的译文比没有译文坏得多：它看起来是对的。
    const { chunks } = splitDocument(DOC);
    expect(pairTranslation(chunks[0], ["一", "二"])).toEqual([]);
  });

  it("越界的行号被忽略而不是写坏文档", () => {
    expect(applyTranslations(["あ"], [{ index: 9, text: "x" }])).toBe("あ");
  });
});

describe("halveChunk", () => {
  it("对半切，奇数行时前一半多一行", () => {
    const { chunks } = splitDocument(
      Array.from({ length: 5 }, (_, i) => `第${i}行です。`).join("\n"),
    );
    expect(halveChunk(chunks[0]).map((c) => c.lines.length)).toEqual([3, 2]);
  });

  it("单行的块切不动 —— 调用方据此停止，而不是无限递归", () => {
    const { chunks } = splitDocument("彼は扉を開けた。");
    expect(halveChunk(chunks[0])).toHaveLength(1);
  });
});
