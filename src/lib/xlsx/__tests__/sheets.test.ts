/**
 * markdown → 工作簿结构：一张表格一个工作表，名字来自它上面的标题。
 */

import { describe, expect, it } from "vitest";
import { buildWorkbook } from "../sheets";

const QUOTE = `# 2026 报价

## 报价表

| 项目 | 单价 | 数量 | 金额 |
| --- | --- | --- | --- |
| 服务器 | 12,000 | 2 | =B3*C3 |
| 交付日期 | 2026-08-06 |  |  |

正文说明一段。

## 折扣

| 档位 | 比例 |
| --- | --- |
| 老客户 | 12% |
`;

describe("buildWorkbook", () => {
  it("makes one sheet per table, named by the heading above it", () => {
    const plan = buildWorkbook(QUOTE);
    expect(plan.sheets.map((s) => s.name)).toEqual(["报价表", "折扣"]);
    expect(plan.summaries[0].rows).toBe(3);
    expect(plan.summaries[0].cols).toBe(4);
  });

  it("counts what each sheet's cells were read as", () => {
    const [quote, discount] = buildWorkbook(QUOTE).summaries;
    // 12,000 和 2；表头行是文字，`=B3*C3` 是公式，日期单独一栏。
    expect(quote.numbers).toBe(2);
    expect(quote.formulas).toBe(1);
    expect(quote.dates).toBe(1);
    expect(discount.numbers).toBe(1);
  });

  it("says what it left behind instead of dropping it quietly", () => {
    const plan = buildWorkbook(QUOTE);
    expect(plan.skipped).toEqual(["正文段落（1 处）"]);
  });

  it("falls back to Excel's own default name when no heading precedes a table", () => {
    const plan = buildWorkbook("| a |\n| --- |\n| 1 |\n");
    expect(plan.sheets[0].name).toBe("Sheet1");
  });

  it("makes duplicate names unique, because Excel cannot store two of them", () => {
    const plan = buildWorkbook(
      "## 明细\n\n| a |\n| --- |\n| 1 |\n\n| b |\n| --- |\n| 2 |\n",
    );
    expect(plan.sheets.map((s) => s.name)).toEqual(["明细", "明细 2"]);
  });

  it("strips the characters Excel forbids in a sheet name and clips to 31", () => {
    const plan = buildWorkbook(`## 一/二:三[四]\n\n| a |\n| --- |\n| 1 |\n`);
    expect(plan.sheets[0].name).toBe("一 二 三 四");

    const long = "长".repeat(40);
    const clipped = buildWorkbook(`## ${long}\n\n| a |\n| --- |\n| 1 |\n`);
    expect([...clipped.sheets[0].name].length).toBe(31);
  });

  it("is empty rather than throwing when the document has no tables", () => {
    const plan = buildWorkbook("# 标题\n\n就是一段话。\n");
    expect(plan.sheets).toEqual([]);
    expect(plan.skipped).toEqual(["正文段落（1 处）"]);
  });

  it("marks the header row so the writer can bold and freeze it", () => {
    expect(buildWorkbook("| a |\n| --- |\n| 1 |\n").sheets[0].header).toBe(true);
  });
});
