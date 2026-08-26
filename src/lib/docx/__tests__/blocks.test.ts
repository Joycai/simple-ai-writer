import { describe, expect, it } from "vitest";
import { markdownToBlocks, splitChapters } from "../blocks";

describe("结构", () => {
  it("标题带级别，正文成段", () => {
    const { blocks } = markdownToBlocks("# 第一章\n\n正文一段。\n\n## 小节\n");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, runs: [{ text: "第一章" }] },
      { kind: "paragraph", runs: [{ text: "正文一段。" }], quote: false },
      { kind: "heading", level: 2, runs: [{ text: "小节" }] },
    ]);
  });

  it("行内标记落到 run 上", () => {
    const { blocks } = markdownToBlocks("这是**粗**和*斜*和`码`。");
    expect(blocks[0]).toMatchObject({ kind: "paragraph" });
    const runs = blocks[0].kind === "paragraph" ? blocks[0].runs : [];
    expect(runs).toContainEqual({ text: "粗", bold: true });
    expect(runs).toContainEqual({ text: "斜", italic: true });
    expect(runs).toContainEqual({ text: "码", mono: true });
  });

  it("列表展平成带层级的项", () => {
    const { blocks } = markdownToBlocks("- 一\n- 二\n  - 二之一\n\n1. 甲\n2. 乙\n");
    const items = blocks.filter((b) => b.kind === "listItem");
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({ ordered: false, level: 0 });
    expect(items[2]).toMatchObject({ ordered: false, level: 1 });
    expect(items[3]).toMatchObject({ ordered: true, level: 0 });
  });

  it("引用段落带 quote 标记", () => {
    const { blocks } = markdownToBlocks("> 引一句\n\n不引。\n");
    expect(blocks[0]).toMatchObject({ kind: "paragraph", quote: true });
    expect(blocks[1]).toMatchObject({ kind: "paragraph", quote: false });
  });

  it("表格记住有几行是表头", () => {
    const { blocks } = markdownToBlocks("| 姓名 | 年龄 |\n|---|---|\n| 甲 | 1 |\n");
    const table = blocks.find((b) => b.kind === "table");
    expect(table).toMatchObject({ kind: "table", headerRows: 1 });
    if (table?.kind === "table") {
      expect(table.rows).toHaveLength(2);
      expect(table.rows[0][0]).toEqual([{ text: "姓名" }]);
    }
  });

  it("代码块和分隔线各成一块", () => {
    const { blocks } = markdownToBlocks("```js\nconst a = 1;\n```\n\n---\n");
    expect(blocks[0]).toEqual({ kind: "code", text: "const a = 1;" });
    expect(blocks[1]).toEqual({ kind: "rule" });
  });

  it("frontmatter 之外的 --- 仍是分隔线", () => {
    const { blocks } = markdownToBlocks("正文\n\n---\n\n更多");
    expect(blocks.some((b) => b.kind === "rule")).toBe(true);
  });
});

describe("插图", () => {
  it("独占一行的图是一个块", () => {
    const { blocks } = markdownToBlocks("![说明](assets/a.png)\n");
    expect(blocks[0]).toEqual({ kind: "image", src: "assets/a.png", alt: "说明" });
  });

  it("行内图退回替代文字，并且说出来", () => {
    const { blocks, degraded } = markdownToBlocks("看这里 ![说明](assets/a.png) 就是它。");
    expect(blocks[0].kind).toBe("paragraph");
    expect(degraded.join()).toContain("行内插图");
  });
});

describe("降级", () => {
  it("mermaid 退回代码块并计数", () => {
    const { degraded } = markdownToBlocks("```mermaid\ngraph TD;A-->B;\n```\n");
    expect(degraded.join()).toContain("mermaid");
    expect(degraded.join()).toContain("1 处");
  });

  it("同一类降级合并计数", () => {
    const { degraded } = markdownToBlocks(
      "```mermaid\na\n```\n\n```mermaid\nb\n```\n",
    );
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toContain("2 处");
  });

  it("知识库引用落成纯文字", () => {
    const { blocks, degraded } = markdownToBlocks("见 [[lore:林渊|他]] 那一节。");
    const runs = blocks[0].kind === "paragraph" ? blocks[0].runs : [];
    expect(runs.map((r) => r.text).join("")).toContain("他");
    expect(degraded.join()).toContain("知识库引用");
  });

  it("干净的文档没有降级", () => {
    const { degraded } = markdownToBlocks("# 标题\n\n正文。\n");
    expect(degraded).toEqual([]);
  });
});

describe("按章分节（每章页码从 1 开始）", () => {
  it("每个一级标题起一节", () => {
    const { blocks } = markdownToBlocks("# 一章\n\n正文\n\n# 二章\n\n正文\n\n## 小节\n");
    const chapters = splitChapters(blocks);
    expect(chapters).toHaveLength(2);
    expect(chapters[0][0]).toMatchObject({ kind: "heading", level: 1 });
    expect(chapters[1]).toHaveLength(3);
  });

  it("第一个一级标题之前的内容自成一节", () => {
    // 并进第一章的话，页码就从封面开始数——第一章的第 1 页会是第 3 页。
    const { blocks } = markdownToBlocks("封面一段\n\n# 一章\n\n正文\n");
    const chapters = splitChapters(blocks);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toHaveLength(1);
    expect(chapters[0][0]).toMatchObject({ kind: "paragraph" });
  });

  it("没有一级标题时是一整节，不是零节", () => {
    // 返回空数组的话整份文稿会消失，而且是安静地消失。
    const { blocks } = markdownToBlocks("## 只有二级\n\n正文\n");
    expect(splitChapters(blocks)).toEqual([blocks]);
  });

  it("空文档也给一节", () => {
    expect(splitChapters([])).toEqual([[]]);
  });

  it("二级三级标题不切", () => {
    const { blocks } = markdownToBlocks("# 一章\n\n## 甲\n\n### 乙\n\n## 丙\n");
    expect(splitChapters(blocks)).toHaveLength(1);
  });
});
