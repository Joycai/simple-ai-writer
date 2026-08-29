/**
 * markdown → 一本工作簿的**结构**（还不是字节）。
 *
 * 一条映射，不多不少：**一张表格 = 一个工作表，名字来自它上面最近的那个标题**。
 * 这和导入侧完全对称——`xlsx.rs` 把一份工作簿写成 `## 工作表名` + 表格，这里
 * 把同样的形状读回去。
 *
 * 表格之外的东西（段落、列表、代码块、插图）**不进工作簿**，但会被数出来交给
 * 作者：工作表是格子，没有地方安放一段话；悄悄扔掉才是错的。
 *
 * 解析用的是 `lib/docx/blocks` 的同一条 token 流——markdown 方言在这个 app 里
 * 只有一份（`lib/fs/markdown` 的那个 md 实例），这一层绝不新开第二份。
 */

import { markdownToBlocks, type DocBlock, type DocRun } from "../docx/blocks";
import { cellKind, classifyCell, type Cell } from "./cells";

export interface SheetSpec {
  name: string;
  rows: Cell[][];
  /** 首行是表头：加粗 + 冻结。markdown 表格总有表头，所以实际总是 true。 */
  header: boolean;
}

/** 卡片上给作者看的那一行：这个工作表有多大、里面的格子被判成了什么。 */
export interface SheetSummary {
  name: string;
  rows: number;
  cols: number;
  numbers: number;
  dates: number;
  formulas: number;
  text: number;
}

export interface WorkbookPlan {
  sheets: SheetSpec[];
  summaries: SheetSummary[];
  /** 没有进工作簿的东西，一条一句，直接给作者看。 */
  skipped: string[];
}

/** Excel 不接受的工作表名字符。 */
const FORBIDDEN = /[:\\/?*[\]]/g;
const MAX_NAME = 31;

export function buildWorkbook(markdown: string): WorkbookPlan {
  const { blocks } = markdownToBlocks(markdown);
  const sheets: SheetSpec[] = [];
  const summaries: SheetSummary[] = [];
  const taken = new Set<string>();
  const skipped = new Map<string, number>();

  let heading: string | null = null;
  for (const block of blocks) {
    if (block.kind === "heading") {
      heading = runsToText(block.runs).trim() || null;
      continue;
    }
    if (block.kind !== "table") {
      const label = skippedLabel(block);
      if (label) skipped.set(label, (skipped.get(label) ?? 0) + 1);
      continue;
    }

    const rows = block.rows.map((row) => row.map((cell) => classifyCell(runsToText(cell))));
    // 标题只认一次：同一个标题下的第二张表格拿到的是去重后的名字（「报价 2」），
    // 而不是同一个名字——Excel 里重名的工作表根本存不下来。
    const name = uniqueName(sheetName(heading, sheets.length), taken);
    sheets.push({ name, rows, header: block.headerRows > 0 });
    summaries.push(summarise(name, rows));
  }

  return { sheets, summaries, skipped: [...skipped].map(([what, n]) => `${what}（${n} 处）`) };
}

function runsToText(runs: DocRun[]): string {
  return runs.map((r) => r.text).join("");
}

/** 一个块没进工作簿时，作者该听到的名字。数不清的（分隔线）就不报。 */
function skippedLabel(block: DocBlock): string | null {
  switch (block.kind) {
    case "paragraph": return block.quote ? "引用段落" : "正文段落";
    case "listItem": return "列表项";
    case "code": return "代码块";
    case "image": return "插图";
    default: return null;
  }
}

function sheetName(heading: string | null, index: number): string {
  const cleaned = (heading ?? "").replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim();
  const clipped = [...cleaned].slice(0, MAX_NAME).join("").trim();
  // 「Sheet1」而不是「工作表1」：Excel 自己的默认名，谁的语言环境下都读得通。
  return clipped || `Sheet${index + 1}`;
}

/**
 * 重名的第二个变成「名字 2」，并且仍然守着 31 字的上限——超了就从名字尾部让
 * 位给序号，而不是让 Excel 拒收整本工作簿。
 */
function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  let n = 1;
  while (taken.has(name.toLowerCase())) {
    n += 1;
    const suffix = ` ${n}`;
    name = [...base].slice(0, MAX_NAME - suffix.length).join("").trim() + suffix;
  }
  taken.add(name.toLowerCase());
  return name;
}

function summarise(name: string, rows: Cell[][]): SheetSummary {
  const counts = { numbers: 0, dates: 0, formulas: 0, text: 0 };
  for (const row of rows) {
    for (const cell of row) {
      switch (cellKind(cell)) {
        case "number": counts.numbers++; break;
        case "date": counts.dates++; break;
        case "formula": counts.formulas++; break;
        // 布尔和空格子都归文本那一栏：这张表要回答的是「数字是不是数字」，
        // 多一栏「布尔 0」只会让它更难读。
        default: if (cell.t !== "s" || cell.v !== "") counts.text++; break;
      }
    }
  }
  return {
    name,
    rows: rows.length,
    cols: rows.reduce((max, r) => Math.max(max, r.length), 0),
    ...counts,
  };
}
