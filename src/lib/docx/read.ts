/**
 * 「参考模仿」：把一份 .docx 里写死的排版参数读成一套 `DocFormat`。
 *
 * 分成两层，理由和这个子系统别处一样——纯的那半是全部逻辑所在，也是唯一能测的
 * 一半：`layoutToFormat` 是纯函数，`readDocFormat` 只负责过一趟 IPC。
 *
 * 三条判断写在这里而不是 Rust 侧（那边只报「XML 里写着什么」）：
 *
 * 1. **缺席 ≠ 零。** 文件没写死的字段落回底座预设的值，而不是 0——一个没声明
 *    字号的文件不是「字号 0 磅」。
 * 2. **纸张按尺寸认，不按名字。** OOXML 里根本没有「A4」这个词，只有 twip。
 *    认不出来就落回 A4 并说出来，而不是编一个尺寸。
 * 3. **报出「哪些是它写死的」。** 全用 Word 默认值的文件不是错误，但作者必须
 *    知道他照着模仿的其实是一份没写死任何东西的文件（设计稿 1i）。
 */

import { invoke } from "@tauri-apps/api/core";
import { toBase64 } from "../fs/fileio";
import {
  BUILTIN_FORMATS,
  bodyRegionMm,
  formatLineSpacing,
  formatSize,
  PAGE_SIZES,
  type Align,
  type BlockStyle,
  type DocFormat,
  type LineRule,
  type LineSpacing,
  type PageSizeName,
} from "./format";

const TWIP_PER_MM = 1440 / 25.4;

/** Rust 侧原样报回来的属性。单位全是 OOXML 的。 */
export interface DocxBlockInfo {
  fontEastAsia?: string | null;
  fontAscii?: string | null;
  sizeHalfPt?: number | null;
  bold?: boolean | null;
  align?: string | null;
  line?: number | null;
  lineRule?: string | null;
  spaceBefore?: number | null;
  spaceAfter?: number | null;
  firstLineChars?: number | null;
  firstLine?: number | null;
  pageBreakBefore?: boolean | null;
}

export interface DocxPageInfo {
  width?: number | null;
  height?: number | null;
  landscape: boolean;
  marginTop?: number | null;
  marginRight?: number | null;
  marginBottom?: number | null;
  marginLeft?: number | null;
  gridType?: string | null;
  gridLinePitch?: number | null;
  gridCharSpace?: number | null;
}

export interface DocxLayout {
  page: DocxPageInfo;
  body: DocxBlockInfo;
  headings: (DocxBlockInfo | null)[];
}

/**
 * 一行读到的规格。`source` 是这张表的重点，不是附注：
 * - `declared` 这份文件自己写死了它——只有这些才是「格式要求」；
 * - `default` 它没写，值是 Word 的出厂设置补上的；
 * - `absent` 这一项在文件里根本没出现（比如没用过的标题级别）。
 *
 * 一份**全是 `default`** 的文件不是读取失败，但它也不能当格式要求用——作者
 * 必须在存成预设之前知道这件事（设计稿 1i）。
 */
export interface ReadRow {
  label: string;
  value: string;
  source: "declared" | "default" | "absent";
}

export interface ReadResult {
  format: DocFormat;
  /** 逐项：读到了什么、它是不是这份文件自己写死的。 */
  rows: ReadRow[];
  /** 这份文件真正写死了几项。0 = 它什么都没写死。 */
  declaredCount: number;
  /** 认不出纸张这类要说给作者听的事。 */
  notes: string[];
}

const mm = (twip: number): number => Math.round((twip / TWIP_PER_MM) * 10) / 10;

/** OOXML 的 `w:jc` → 我们的对齐。`both` 是两端对齐，名字对不上但意思一样。 */
function alignOf(val: string | null | undefined): Align | undefined {
  switch (val) {
    case "center": return "center";
    case "right": case "end": return "right";
    case "both": case "distribute": return "justify";
    case "left": case "start": return "left";
    default: return undefined;
  }
}

function lineOf(info: DocxBlockInfo): LineSpacing | undefined {
  if (!info.line) return undefined;
  const rule = (info.lineRule ?? "auto") as LineRule;
  if (rule === "exact" || rule === "atLeast") {
    return { rule, value: Math.round((info.line / 20) * 10) / 10 };
  }
  return { rule: "auto", value: Math.round((info.line / 240) * 100) / 100 };
}

/** 一个块：文件写死的盖在底座上，没写死的原样留着。 */
function blockOf(info: DocxBlockInfo | null | undefined, base: BlockStyle): BlockStyle {
  if (!info) return base;
  const line = lineOf(info);
  return {
    font: {
      eastAsia: info.fontEastAsia || base.font.eastAsia,
      ascii: info.fontAscii || base.font.ascii,
    },
    sizePt: info.sizeHalfPt ? info.sizeHalfPt / 2 : base.sizePt,
    bold: info.bold ?? base.bold,
    align: alignOf(info.align) ?? base.align,
    ...(line ? { line } : base.line ? { line: base.line } : {}),
    spaceBeforePt: info.spaceBefore !== null && info.spaceBefore !== undefined
      ? info.spaceBefore / 20 : base.spaceBeforePt,
    spaceAfterPt: info.spaceAfter !== null && info.spaceAfter !== undefined
      ? info.spaceAfter / 20 : base.spaceAfterPt,
    firstLineChars: firstLineCharsOf(info, info.sizeHalfPt ? info.sizeHalfPt / 2 : base.sizePt)
      ?? base.firstLineChars,
    ...(info.pageBreakBefore ? { pageBreakBefore: true } : base.pageBreakBefore ? { pageBreakBefore: true } : {}),
  };
}

/**
 * 首行缩进。`firstLineChars` 直接除 100；只有 `firstLine`（磅）时按字号折回
 * 字符数——作者的规格说的是「两个字」，把磅数原样搬过来会在改字号时错位。
 */
function firstLineCharsOf(info: DocxBlockInfo, sizePt: number): number | undefined {
  if (info.firstLineChars !== null && info.firstLineChars !== undefined) {
    return Math.round((info.firstLineChars / 100) * 10) / 10;
  }
  if (info.firstLine && sizePt > 0) {
    return Math.round((info.firstLine / 20 / sizePt) * 10) / 10;
  }
  return undefined;
}

/** 按实际尺寸认纸张（±3mm）。OOXML 里没有「A4」这个词，只有 twip。 */
function paperOf(page: DocxPageInfo): { size: PageSizeName; landscape: boolean } | null {
  if (!page.width || !page.height) return null;
  const w = page.width / TWIP_PER_MM;
  const h = page.height / TWIP_PER_MM;
  const landscape = page.landscape || w > h;
  const [longEdge, shortEdge] = w > h ? [w, h] : [h, w];
  for (const [name, dims] of Object.entries(PAGE_SIZES) as [PageSizeName, { widthMm: number; heightMm: number }][]) {
    if (Math.abs(dims.heightMm - longEdge) < 3 && Math.abs(dims.widthMm - shortEdge) < 3) {
      return { size: name, landscape };
    }
  }
  return null;
}

export function layoutToFormat(layout: DocxLayout, base: DocFormat = BUILTIN_FORMATS[1].format): ReadResult {
  const rows: ReadRow[] = [];
  const notes: string[] = [];
  const page = { ...base.page, margins: { ...base.page.margins } };
  const row = (label: string, value: string, source: ReadRow["source"]) => rows.push({ label, value, source });

  const paper = paperOf(layout.page);
  if (paper) {
    page.size = paper.size;
    page.landscape = paper.landscape;
  } else if (layout.page.width && layout.page.height) {
    // 自定义纸张：认不出就说出来，别编一个尺寸——作者要知道这一条没模仿到。
    notes.push(`这份文件用的是自定义纸张 ${mm(layout.page.width)} × ${mm(layout.page.height)} mm，已按 ${page.size} 近似`);
  }
  row("纸张", `${page.size}${page.landscape ? " · 横向" : " · 纵向"}`, paper ? "declared" : "default");

  const sides = [
    ["top", layout.page.marginTop],
    ["right", layout.page.marginRight],
    ["bottom", layout.page.marginBottom],
    ["left", layout.page.marginLeft],
  ] as const;
  const hasMargins = sides.every(([, v]) => v !== null && v !== undefined);
  if (hasMargins) {
    for (const [side, v] of sides) page.margins[side] = mm(v!);
  }
  const m = page.margins;
  row("页边距", `上 ${m.top} · 右 ${m.right} · 下 ${m.bottom} · 左 ${m.left} mm`, hasMargins ? "declared" : "default");

  const body = blockOf(layout.body, base.body);

  // 网格要靠版心反算，所以放在页边距定下来之后。
  const gridded = layout.page.gridType === "linesAndChars" || layout.page.gridType === "lines";
  if (gridded && layout.page.gridLinePitch) {
    const region = bodyRegionMm({ ...page, grid: undefined });
    const linesPerPage = Math.round((region.heightMm * TWIP_PER_MM) / layout.page.gridLinePitch);
    const charPitch = body.sizePt * 20 + (layout.page.gridCharSpace ?? 0);
    const charsPerLine = charPitch > 0
      ? Math.round((region.widthMm * TWIP_PER_MM) / charPitch)
      : 0;
    if (linesPerPage > 0 && charsPerLine > 0) page.grid = { linesPerPage, charsPerLine };
  } else {
    page.grid = undefined;
  }
  row(
    "文档网格",
    page.grid ? `${page.grid.linesPerPage} 行 × ${page.grid.charsPerLine} 字` : "关",
    page.grid ? "declared" : "default",
  );

  row("正文中文", body.font.eastAsia, layout.body.fontEastAsia ? "declared" : "default");
  row("正文西文", body.font.ascii, layout.body.fontAscii ? "declared" : "default");
  row("正文字号", formatSize(body.sizePt), layout.body.sizeHalfPt ? "declared" : "default");
  row("行距", body.line ? formatLineSpacing(body.line) : "单倍", layout.body.line ? "declared" : "default");
  row(
    "首行缩进",
    body.firstLineChars > 0 ? `${body.firstLineChars} 字符` : "无",
    layout.body.firstLineChars || layout.body.firstLine ? "declared" : "default",
  );
  row(
    "段前 / 段后",
    `${body.spaceBeforePt} 磅 / ${body.spaceAfterPt} 磅`,
    layout.body.spaceBefore !== null && layout.body.spaceBefore !== undefined ? "declared" : "default",
  );

  const headings = base.headings.map((h, i) => blockOf(layout.headings[i], h)) as DocFormat["headings"];
  headings.forEach((h, i) => {
    const declaredHere = !!layout.headings[i];
    row(
      `标题 ${i + 1}`,
      declaredHere
        ? `${h.font.eastAsia} ${formatSize(h.sizePt)} · ${ALIGN_WORD[h.align]} · ${h.spaceBeforePt}/${h.spaceAfterPt} 磅`
        : `文件里没用到 · 沿用${i > 0 ? `标题 ${i}` : "默认"}的值`,
      declaredHere ? "declared" : "absent",
    );
  });

  return {
    format: { ...base, page, body, headings },
    rows,
    declaredCount: rows.filter((r) => r.source === "declared").length,
    notes,
  };
}

const ALIGN_WORD: Record<Align, string> = {
  left: "左", center: "居中", right: "右", justify: "两端",
};

/** 读项目里一份 .docx 的排版参数（agent 工具走这条：路径受 FsScope 约束）。 */
export async function readDocFormat(path: string, base?: DocFormat): Promise<ReadResult> {
  const layout = await invoke<DocxLayout>("docx_read_layout", { path });
  return layoutToFormat(layout, base);
}

/**
 * 同上，但读的是作者刚从系统对话框里挑的文件——那个文件**在工作区外面**，
 * `FsScope` 不会为它背书，授权来自对话框本身。同 `pptxToMarkdown` 的分工。
 */
export async function readPickedDocFormat(path: string, base?: DocFormat): Promise<ReadResult> {
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const bytes = await readFile(path);
  const layout = await invoke<DocxLayout>("docx_layout_from_bytes", { data: toBase64(bytes) });
  return layoutToFormat(layout, base);
}
