/**
 * 排版格式（`DocFormat`）——一份 Word 文稿的全部版面参数，单位全是印刷单位。
 *
 * 为什么不复用 markdown 主题（`lib/theme/markdownThemes.ts`）：那五套是 **CSS**。
 * `--md-para-indent: 2em` 和 `var(--font-serif)` 都无法无损翻译成磅和毫米，而且
 * CSS **根本不表达页面**——纸张、页边距、文档网格在那边不存在。所以这是一个独立
 * 模型，内置预设的名字和主题对齐（作者看到的和导出的对得上），但值是一张手写的
 * 映射表，不是从 CSS 推导的。
 *
 * 这个文件是纯的：模型、内置预设、中文号数表、单位换算、以及作者口语的解析
 * （「三号」「固定值28磅」）。它不认识 `docx` 库，也不碰盘。
 *
 * 一条贯穿全文的纪律：**解析失败返回 null，调用方报错，绝不静默取默认**。
 * 静默回落正是「看起来对、其实不合规」的来源——作者说了仿宋三号，产出却是
 * 默认格式，而没有任何地方会亮红。
 */

// ─── 单位 ─────────────────────────────────────────────────────────────────────
// twip = 1/20 磅 = 1/1440 英寸。Word 的段落和页面尺寸全用它。

/** 磅 → twip。 */
export const ptToTwip = (pt: number): number => Math.round(pt * 20);

/** 毫米 → twip（1 英寸 = 25.4mm = 1440 twip）。 */
export const mmToTwip = (mm: number): number => Math.round((mm * 1440) / 25.4);

/** 磅 → 半磅，`w:sz` 的单位。三号（16 磅）→ 32。 */
export const ptToHalfPt = (pt: number): number => Math.round(pt * 2);

/** 字符数 → `w:ind w:firstLineChars` 的单位（百分之一字符）。2 字符 → 200。 */
export const charsToInd = (chars: number): number => Math.round(chars * 100);

// ─── 中文号数 ─────────────────────────────────────────────────────────────────

/**
 * 号数 → 磅。作者手上的规格用哪种写法都有可能，所以两种都要认、两种都要显示
 * （见 `formatSize`）——只写「三号」核不了甲方的「16磅」，反过来也一样。
 */
export const CN_SIZES: ReadonlyArray<readonly [string, number]> = [
  ["初号", 42], ["小初", 36],
  ["一号", 26], ["小一", 24],
  ["二号", 22], ["小二", 18],
  ["三号", 16], ["小三", 15],
  ["四号", 14], ["小四", 12],
  ["五号", 10.5], ["小五", 9],
  ["六号", 7.5], ["小六", 6.5],
  ["七号", 5.5], ["八号", 5],
];

const CN_BY_NAME = new Map(CN_SIZES);
const CN_BY_PT = new Map(CN_SIZES.map(([name, pt]) => [pt, name] as const));

/** 「三号」/「16」/「16pt」/「16 磅」→ 磅。认不出返回 null。 */
export function parseSize(input: string): number | null {
  const raw = input.trim();
  if (!raw) return null;
  const named = CN_BY_NAME.get(raw);
  if (named !== undefined) return named;
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*(pt|磅|p)?$/i);
  if (!m) return null;
  const pt = Number(m[1]);
  // Word 自己的下限/上限。越界几乎总是把「三号」当成 3 的那类错，报错比画出
  // 一页蚂蚁强。
  return pt >= 1 && pt <= 1638 ? pt : null;
}

/** 磅 → 「三号（16 磅）」；没有对应号数时只写磅。 */
export function formatSize(pt: number): string {
  const name = CN_BY_PT.get(pt);
  return name ? `${name}（${trimNum(pt)} 磅）` : `${trimNum(pt)} 磅`;
}

const trimNum = (n: number): string => (Number.isInteger(n) ? String(n) : String(n));

// ─── 行距 ─────────────────────────────────────────────────────────────────────

/**
 * 三态不能混：`exact` 固定值 / `atLeast` 最小值 / `auto` 倍数。规格写「固定值
 * 28 磅」而实现给了倍数，行距会随字号浮动——那是打印出来才发现的错。
 */
export type LineRule = "exact" | "atLeast" | "auto";

export interface LineSpacing {
  rule: LineRule;
  /** `exact`/`atLeast` 是磅；`auto` 是倍数。 */
  value: number;
}

/** 「固定值28磅」/「最小值20磅」/「1.5倍」/「1.5」→ LineSpacing。认不出返回 null。 */
export function parseLineSpacing(input: string): LineSpacing | null {
  const raw = input.trim().replace(/\s+/g, "");
  if (!raw) return null;
  const fixed = raw.match(/^(?:固定值|固定)(\d+(?:\.\d+)?)(?:磅|pt)?$/i);
  if (fixed) return { rule: "exact", value: Number(fixed[1]) };
  const least = raw.match(/^(?:最小值|至少)(\d+(?:\.\d+)?)(?:磅|pt)?$/i);
  if (least) return { rule: "atLeast", value: Number(least[1]) };
  const multi = raw.match(/^(\d+(?:\.\d+)?)(?:倍|倍行距|x)?$/i);
  if (multi) {
    const v = Number(multi[1]);
    return v > 0 && v <= 132 ? { rule: "auto", value: v } : null;
  }
  return null;
}

export function formatLineSpacing(ls: LineSpacing): string {
  if (ls.rule === "auto") return `${trimNum(ls.value)} 倍行距`;
  return `${ls.rule === "exact" ? "固定值" : "最小值"} ${trimNum(ls.value)} 磅`;
}

/** LineSpacing → docx 的 `{ line, lineRule }`。`auto` 的一倍行距是 240。 */
export function lineSpacingToTwip(ls: LineSpacing): { line: number; lineRule: LineRule } {
  return {
    line: ls.rule === "auto" ? Math.round(ls.value * 240) : ptToTwip(ls.value),
    lineRule: ls.rule,
  };
}

// ─── 模型 ─────────────────────────────────────────────────────────────────────

/**
 * 中西文字体是两个独立字段，不是一个「字体」下拉能表达的：同一段里汉字走
 * eastAsia，英文和数字走 ascii。`hint: "eastAsia"` 不能省——没有它，半角标点
 * 和数字会按西文字体走，屏幕上像回事，但校到「标点也必须是仿宋」那条就挂了。
 */
export interface FontPair {
  eastAsia: string;
  ascii: string;
}

export type Align = "left" | "center" | "right" | "justify";

export interface BlockStyle {
  font: FontPair;
  sizePt: number;
  bold: boolean;
  align: Align;
  /** 省略 = 沿用正文行距。 */
  line?: LineSpacing;
  spaceBeforePt: number;
  spaceAfterPt: number;
  /** 首行缩进，单位是**字符**——按磅写死的话作者一改字号缩进就错位。 */
  firstLineChars: number;
  /** 只对标题有意义：另起一页。 */
  pageBreakBefore?: boolean;
}

export const PAGE_SIZES = {
  A4: { widthMm: 210, heightMm: 297 },
  Letter: { widthMm: 215.9, heightMm: 279.4 },
  B5: { widthMm: 176, heightMm: 250 },
  A5: { widthMm: 148, heightMm: 210 },
} as const;

export type PageSizeName = keyof typeof PAGE_SIZES;

export interface PageSetup {
  size: PageSizeName;
  /** 横向。纸张的长短边对调，版心和网格跟着一起变。 */
  landscape?: boolean;
  /** 毫米。 */
  margins: { top: number; right: number; bottom: number; left: number };
  /**
   * 文档网格（公文的「每页 22 行、每行 28 字」）。省略 = 不设网格。
   * 落成 `w:docGrid` 的 linePitch / charSpace，换算见 `gridToDocx`。
   */
  grid?: { linesPerPage: number; charsPerLine: number };
}

/** 页码的写法。`dashed` 是公文那种「— 1 —」。 */
export type PageNumberStyle = "none" | "plain" | "dashed" | "ofTotal";

export interface HeaderFooter {
  /** 页眉文字。空串＝不写页眉——**留空就什么都不写**，绝不填一个默认值：作者
   *  看到页眉里有字会以为自己设过。 */
  headerText: string;
  headerAlign: Align;
  pageNumber: PageNumberStyle;
  pageNumberAlign: Align;
  /**
   * 奇偶页不同。为真时**偶数页的对齐左右互换**——装订成册时页码落在订口外
   * 侧，这是一条规则而不是两个字段；居中的页码不受影响。
   */
  differentOddEven: boolean;
}

/**
 * 标题自动编号的写法，一级一种。
 * 公文那套是 `一、` / `（一）` / `1.` / `（1）`。
 */
export type HeadingNumberFormat =
  | "none"
  | "chinese"        // 一、二、三、
  | "chineseParen"   // （一）（二）
  | "decimal"        // 1. 2. 3.
  | "decimalParen"   // （1）（2）
  | "decimalDotted"; // 1.1  1.1.1（含上级序号）

export interface HeadingNumbering {
  enabled: boolean;
  levels: [HeadingNumberFormat, HeadingNumberFormat, HeadingNumberFormat, HeadingNumberFormat];
}

export interface DocFormat {
  page: PageSetup;
  body: BlockStyle;
  /** 一到四级标题。第五、六级沿用第四级——再深的层级 Word 里也没人排版。 */
  headings: [BlockStyle, BlockStyle, BlockStyle, BlockStyle];
  quote: {
    indentChars: number;
    italic: boolean;
    /** 省略 = 同正文字号。 */
    sizePt?: number;
  };
  code: { fontAscii: string; sizePt: number; shaded: boolean };
  list: { indentChars: number };
  table: {
    headerBold: boolean;
    borders: boolean;
    /** 表格跨页时在每一页重复表头行。长表格没有它就读不下去。 */
    repeatHeader: boolean;
  };
  headerFooter: HeaderFooter;
  headingNumbering: HeadingNumbering;
}

/** 什么都不写的页眉页脚。默认就该是这个：没设过就不该出现任何东西。 */
export const NO_HEADER_FOOTER: HeaderFooter = {
  headerText: "",
  headerAlign: "center",
  pageNumber: "none",
  pageNumberAlign: "center",
  differentOddEven: false,
};

export const NO_HEADING_NUMBERING: HeadingNumbering = {
  enabled: false,
  levels: ["none", "none", "none", "none"],
};

export interface DocFormatPreset {
  id: string;
  label: string;
  /** 内置的不可删、不可改（改是「另存为」）。 */
  builtin: boolean;
  /**
   * 这套格式是从哪份 Word 文件读来的（「参考模仿」）。存在意味着它是本次会话
   * 的临时预设，作者点「存为预设」才会落盘——审批卡靠它说出「照 X 模仿」。
   */
  imitatedFrom?: string;
  format: DocFormat;
}

/**
 * 网格 → `w:docGrid`。linePitch 是一行占多高，charSpace 是每个字比字号多出来
 * 的那点宽度；两者都从**版心**（页面减去页边距）反算，所以改页边距网格会跟着变。
 */
export function gridToDocx(page: PageSetup, bodySizePt: number):
  | { type: "linesAndChars"; linePitch: number; charSpace: number }
  | undefined {
  if (!page.grid) return undefined;
  const body = bodyRegionMm(page);
  const bodyH = mmToTwip(body.heightMm);
  const bodyW = mmToTwip(body.widthMm);
  const linePitch = Math.round(bodyH / page.grid.linesPerPage);
  const charSpace = Math.round(bodyW / page.grid.charsPerLine - ptToTwip(bodySizePt));
  return { type: "linesAndChars", linePitch, charSpace };
}

// ─── 内置预设 ─────────────────────────────────────────────────────────────────

const SONG = { eastAsia: "宋体", ascii: "Times New Roman" };
const SOURCE_SONG = { eastAsia: "思源宋体", ascii: "Source Serif 4" };
const SOURCE_HEI = { eastAsia: "思源黑体", ascii: "Inter" };
const FANGSONG = { eastAsia: "仿宋_GB2312", ascii: "Times New Roman" };
const FANGSONG_ARIAL = { eastAsia: "仿宋_GB2312", ascii: "Arial" };
const HEI = (ascii = "Times New Roman") => ({ eastAsia: "黑体", ascii });

function heading(over: Partial<BlockStyle>): BlockStyle {
  return {
    font: HEI(),
    sizePt: 16,
    bold: false,
    align: "left",
    spaceBeforePt: 12,
    spaceAfterPt: 6,
    firstLineChars: 0,
    ...over,
  };
}

/** 手稿：小说。宋体正文，标题居中，首行缩进两字。页边距是 Word 的默认版心。 */
const MANUSCRIPT: DocFormat = {
  page: { size: "A4", margins: { top: 25.4, right: 31.8, bottom: 25.4, left: 31.8 } },
  body: {
    font: SOURCE_SONG, sizePt: 12, bold: false, align: "justify",
    line: { rule: "auto", value: 1.75 },
    spaceBeforePt: 0, spaceAfterPt: 0, firstLineChars: 2,
  },
  headings: [
    heading({ font: HEI("Source Serif 4"), sizePt: 22, align: "center", spaceBeforePt: 24, spaceAfterPt: 18, pageBreakBefore: true }),
    heading({ font: HEI("Source Serif 4"), sizePt: 16, align: "center", spaceBeforePt: 18, spaceAfterPt: 12 }),
    heading({ font: SOURCE_SONG, sizePt: 14, bold: true }),
    heading({ font: SOURCE_SONG, sizePt: 12, bold: true }),
  ],
  quote: { indentChars: 2, italic: false },
  code: { fontAscii: "Consolas", sizePt: 10.5, shaded: true },
  list: { indentChars: 2 },
  table: { headerBold: true, borders: true, repeatHeader: true },
  headerFooter: { ...NO_HEADER_FOOTER, pageNumber: "plain" },
  headingNumbering: NO_HEADING_NUMBERING,
};

/** 素雅：报告、周报、文档。无缩进，段间距代替缩进。 */
const CLEAN: DocFormat = {
  page: { size: "A4", margins: { top: 25, right: 25, bottom: 25, left: 25 } },
  body: {
    font: SOURCE_HEI, sizePt: 12, bold: false, align: "left",
    line: { rule: "auto", value: 1.5 },
    spaceBeforePt: 0, spaceAfterPt: 6, firstLineChars: 0,
  },
  headings: [
    heading({ font: SOURCE_HEI, sizePt: 18, bold: true, spaceBeforePt: 18, spaceAfterPt: 10 }),
    heading({ font: SOURCE_HEI, sizePt: 15, bold: true, spaceBeforePt: 14, spaceAfterPt: 8 }),
    heading({ font: SOURCE_HEI, sizePt: 13, bold: true }),
    heading({ font: SOURCE_HEI, sizePt: 12, bold: true }),
  ],
  quote: { indentChars: 2, italic: false },
  code: { fontAscii: "Consolas", sizePt: 10, shaded: true },
  list: { indentChars: 2 },
  table: { headerBold: true, borders: true, repeatHeader: true },
  headerFooter: NO_HEADER_FOOTER,
  headingNumbering: NO_HEADING_NUMBERING,
};

/**
 * 公文：党政机关公文格式常见规格。版心 37/35/28/26mm、正文仿宋_GB2312 三号、
 * 行距固定值 28 磅、每页 22 行。数值来自 00-feasibility §7.1 的实测样张。
 */
const GONGWEN: DocFormat = {
  page: {
    size: "A4",
    margins: { top: 37, right: 26, bottom: 35, left: 28 },
    grid: { linesPerPage: 22, charsPerLine: 28 },
  },
  body: {
    font: FANGSONG, sizePt: 16, bold: false, align: "justify",
    line: { rule: "exact", value: 28 },
    spaceBeforePt: 0, spaceAfterPt: 0, firstLineChars: 2,
  },
  headings: [
    heading({ font: HEI(), sizePt: 22, align: "center", spaceBeforePt: 0, spaceAfterPt: 24, line: { rule: "exact", value: 36 } }),
    heading({ font: { eastAsia: "楷体_GB2312", ascii: "Times New Roman" }, sizePt: 16, firstLineChars: 2, line: { rule: "exact", value: 28 } }),
    heading({ font: FANGSONG, sizePt: 16, bold: true, firstLineChars: 2, line: { rule: "exact", value: 28 } }),
    heading({ font: FANGSONG, sizePt: 16, firstLineChars: 2, line: { rule: "exact", value: 28 } }),
  ],
  quote: { indentChars: 4, italic: false },
  code: { fontAscii: "Consolas", sizePt: 12, shaded: false },
  list: { indentChars: 2 },
  table: { headerBold: true, borders: true, repeatHeader: true },
  // 公文的页码是「— 1 —」，且奇偶页分居订口外侧。
  headerFooter: {
    headerText: "",
    headerAlign: "center",
    pageNumber: "dashed",
    pageNumberAlign: "right",
    differentOddEven: true,
  },
  // 一、（一）1. （1）——党政机关公文的层级写法。
  headingNumbering: { enabled: true, levels: ["chinese", "chineseParen", "decimal", "decimalParen"] },
};

/** 论文：宋体小四，1.5 倍行距，标题黑体分级。 */
const THESIS: DocFormat = {
  page: { size: "A4", margins: { top: 25, right: 20, bottom: 25, left: 30 } },
  body: {
    font: SONG, sizePt: 12, bold: false, align: "justify",
    line: { rule: "auto", value: 1.5 },
    spaceBeforePt: 0, spaceAfterPt: 0, firstLineChars: 2,
  },
  headings: [
    heading({ font: HEI(), sizePt: 18, align: "center", spaceBeforePt: 24, spaceAfterPt: 18, pageBreakBefore: true }),
    heading({ font: HEI(), sizePt: 15, spaceBeforePt: 18, spaceAfterPt: 12 }),
    heading({ font: HEI(), sizePt: 14 }),
    heading({ font: SONG, sizePt: 12, bold: true }),
  ],
  quote: { indentChars: 2, italic: false },
  code: { fontAscii: "Consolas", sizePt: 10.5, shaded: true },
  list: { indentChars: 2 },
  table: { headerBold: true, borders: true, repeatHeader: true },
  headerFooter: { ...NO_HEADER_FOOTER, pageNumber: "ofTotal" },
  headingNumbering: { enabled: true, levels: ["chinese", "decimalDotted", "decimalDotted", "decimalDotted"] },
};

/** 投标：仿宋四号，行距固定 24 磅，标题不分页（评标要连续翻）。 */
const BID: DocFormat = {
  page: { size: "A4", margins: { top: 25, right: 25, bottom: 25, left: 30 } },
  body: {
    font: FANGSONG_ARIAL, sizePt: 14, bold: false, align: "justify",
    line: { rule: "exact", value: 24 },
    spaceBeforePt: 0, spaceAfterPt: 0, firstLineChars: 2,
  },
  headings: [
    heading({ font: HEI("Arial"), sizePt: 22, align: "center", spaceBeforePt: 12, spaceAfterPt: 18 }),
    heading({ font: HEI("Arial"), sizePt: 16, spaceBeforePt: 12, spaceAfterPt: 6 }),
    heading({ font: { eastAsia: "楷体_GB2312", ascii: "Arial" }, sizePt: 14, bold: true }),
    heading({ font: FANGSONG_ARIAL, sizePt: 14, bold: true }),
  ],
  quote: { indentChars: 4, italic: false },
  code: { fontAscii: "Consolas", sizePt: 12, shaded: false },
  list: { indentChars: 2 },
  table: { headerBold: true, borders: true, repeatHeader: true },
  headerFooter: { ...NO_HEADER_FOOTER, pageNumber: "ofTotal" },
  headingNumbering: { enabled: true, levels: ["chinese", "chineseParen", "decimal", "decimalParen"] },
};

export const BUILTIN_FORMATS: DocFormatPreset[] = [
  { id: "manuscript", label: "手稿", builtin: true, format: MANUSCRIPT },
  { id: "clean", label: "素雅", builtin: true, format: CLEAN },
  { id: "gongwen", label: "公文", builtin: true, format: GONGWEN },
  { id: "thesis", label: "论文", builtin: true, format: THESIS },
  { id: "bid", label: "投标", builtin: true, format: BID },
];

export const DEFAULT_FORMAT_ID = "manuscript";

// ─── 摘要 ─────────────────────────────────────────────────────────────────────

/**
 * 人类可读的最终值，一行一条——审批卡和设置页共用的那张规格表。
 *
 * 写的是**最终值**而不是原始输入：号数和磅一起写，行距写全三态的名字。这是
 * 「校对规格表而不是校对产出」（00-feasibility §7.3）唯一的载体。
 */
export function formatSummary(f: DocFormat): string[] {
  const { widthMm, heightMm } = paperMm(f.page);
  const m = f.page.margins;
  const h1 = f.headings[0];
  const lines = [
    `正文 ${f.body.font.eastAsia} / ${f.body.font.ascii} · ${formatSize(f.body.sizePt)}`,
    `行距 ${f.body.line ? formatLineSpacing(f.body.line) : "单倍行距"}` +
      (f.body.firstLineChars > 0 ? ` · 首行缩进 ${trimNum(f.body.firstLineChars)} 字符` : " · 无首行缩进"),
    `${f.page.size}（${trimNum(widthMm)}×${trimNum(heightMm)}mm） · 页边距 上${trimNum(m.top)} 下${trimNum(m.bottom)} 左${trimNum(m.left)} 右${trimNum(m.right)}mm`,
    `标题1 ${h1.font.eastAsia} · ${formatSize(h1.sizePt)}` +
      (h1.align === "center" ? " · 居中" : "") +
      (h1.pageBreakBefore ? " · 另起一页" : ""),
  ];
  if (f.page.grid) {
    lines.push(`文档网格 每页 ${f.page.grid.linesPerPage} 行 · 每行 ${f.page.grid.charsPerLine} 字`);
  }
  return lines;
}

/**
 * 纸张的实际长宽（毫米），横向时长短边对调。**所有**用到纸张尺寸的地方都要走
 * 这里——直接读 `PAGE_SIZES` 会在横向时算错版心，而那是不会报错的那种错。
 */
export function paperMm(page: PageSetup): { widthMm: number; heightMm: number } {
  const { widthMm, heightMm } = PAGE_SIZES[page.size];
  return page.landscape ? { widthMm: heightMm, heightMm: widthMm } : { widthMm, heightMm };
}

/** 版心（页面减去页边距），毫米。纸样预览和网格换算都用它。 */
export function bodyRegionMm(page: PageSetup): { widthMm: number; heightMm: number } {
  const { widthMm, heightMm } = paperMm(page);
  return {
    widthMm: widthMm - page.margins.left - page.margins.right,
    heightMm: heightMm - page.margins.top - page.margins.bottom,
  };
}

/** 预设列表一行里的那句摘要：中西文 · 字号 · 行距 · 缩进。 */
export function formatOneLine(f: DocFormat): string {
  return [
    `${f.body.font.eastAsia} / ${f.body.font.ascii}`,
    formatSize(f.body.sizePt),
    f.body.line ? formatLineSpacing(f.body.line) : "单倍行距",
    f.body.firstLineChars > 0 ? `首行缩进 ${trimNum(f.body.firstLineChars)} 字符` : "无缩进",
  ].join(" · ");
}

/** 规格表的一行。`key` 让调用方能标出「这一行这次被改过」。 */
export interface SpecRow {
  key: "font" | "size" | "line" | "indent" | "page";
  label: string;
  value: string;
}

/**
 * 审批卡和设置页共用的那张规格表——五行，写的全是**最终值**。
 * 号数和磅一起写、行距带三态的名字，是这张表存在的全部理由。
 */
export function formatSpecRows(f: DocFormat): SpecRow[] {
  const m = f.page.margins;
  const { widthMm, heightMm } = paperMm(f.page);
  return [
    { key: "font", label: "中 / 西文", value: `${f.body.font.eastAsia} / ${f.body.font.ascii}` },
    { key: "size", label: "字号", value: formatSize(f.body.sizePt) },
    { key: "line", label: "行距", value: f.body.line ? formatLineSpacing(f.body.line) : "单倍行距" },
    {
      key: "indent",
      label: "首行缩进",
      value: f.body.firstLineChars > 0 ? `${trimNum(f.body.firstLineChars)} 字符` : "无",
    },
    {
      key: "page",
      label: "纸张 / 边距",
      value: `${f.page.size}（${trimNum(widthMm)}×${trimNum(heightMm)}mm）· 上${trimNum(m.top)} 右${trimNum(m.right)} 下${trimNum(m.bottom)} 左${trimNum(m.left)} mm`,
    },
  ];
}

/** 这套格式点名了哪些中文字体——用来提示「本机未装」。 */
export function eastAsiaFontsOf(f: DocFormat): string[] {
  return [...new Set([f.body.font.eastAsia, ...f.headings.map((h) => h.font.eastAsia)])];
}

// ─── 校验 / 归一 ──────────────────────────────────────────────────────────────

/**
 * 把一份来路不明的 JSON 归一成一套 `DocFormat`。
 *
 * 三个入口都要它：从 `config.db` 读回作者的自建预设、从应用配置备份里导入、
 * 以后从任何别的地方。**归一而不是拒绝**——一份预设里有一个字段坏了就整套消失，
 * 对作者来说是「我的格式不见了」，而缺的那一项本来就该落回默认。
 *
 * 也是新增字段的兼容层：三期之前存下来的预设没有 `headerFooter` /
 * `headingNumbering`，读回来时在这里补上，不需要写一次数据迁移。
 */
export function parseDocFormat(raw: unknown, base: DocFormat = BUILTIN_FORMATS[1].format): DocFormat {
  const r = (raw ?? {}) as Record<string, unknown>;
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});
  const num = (v: unknown, fallback: number, min: number, max: number): number =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
  const str = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() ? v : fallback);
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(v as T) ? (v as T) : fallback;

  const align = (v: unknown, fallback: Align) => oneOf(v, ALIGNS, fallback);

  const line = (v: unknown, fallback: LineSpacing | undefined): LineSpacing | undefined => {
    const o = obj(v);
    if (!o.rule && !o.value) return fallback;
    const rule = oneOf(o.rule, LINE_RULES, fallback?.rule ?? "auto");
    return { rule, value: num(o.value, fallback?.value ?? 1, 0.01, 2000) };
  };

  const block = (v: unknown, fb: BlockStyle): BlockStyle => {
    const o = obj(v);
    const font = obj(o.font);
    const l = line(o.line, fb.line);
    return {
      font: { eastAsia: str(font.eastAsia, fb.font.eastAsia), ascii: str(font.ascii, fb.font.ascii) },
      sizePt: num(o.sizePt, fb.sizePt, 1, 1638),
      bold: bool(o.bold, fb.bold),
      align: align(o.align, fb.align),
      ...(l ? { line: l } : {}),
      spaceBeforePt: num(o.spaceBeforePt, fb.spaceBeforePt, 0, 2000),
      spaceAfterPt: num(o.spaceAfterPt, fb.spaceAfterPt, 0, 2000),
      firstLineChars: num(o.firstLineChars, fb.firstLineChars, 0, 20),
      ...(bool(o.pageBreakBefore, !!fb.pageBreakBefore) ? { pageBreakBefore: true } : {}),
    };
  };

  const pageRaw = obj(r.page);
  const marginsRaw = obj(pageRaw.margins);
  const gridRaw = pageRaw.grid === undefined || pageRaw.grid === null ? null : obj(pageRaw.grid);
  const hfRaw = obj(r.headerFooter);
  const numberingRaw = obj(r.headingNumbering);
  const levelsRaw = Array.isArray(numberingRaw.levels) ? numberingRaw.levels : [];

  const headings = [0, 1, 2, 3].map((i) =>
    block(Array.isArray(r.headings) ? r.headings[i] : undefined, base.headings[i]),
  ) as DocFormat["headings"];

  return {
    page: {
      size: oneOf(pageRaw.size, Object.keys(PAGE_SIZES) as PageSizeName[], base.page.size),
      ...(bool(pageRaw.landscape, !!base.page.landscape) ? { landscape: true } : {}),
      margins: {
        top: num(marginsRaw.top, base.page.margins.top, 0, 200),
        right: num(marginsRaw.right, base.page.margins.right, 0, 200),
        bottom: num(marginsRaw.bottom, base.page.margins.bottom, 0, 200),
        left: num(marginsRaw.left, base.page.margins.left, 0, 200),
      },
      ...(gridRaw
        ? {
            grid: {
              linesPerPage: Math.round(num(gridRaw.linesPerPage, 22, 1, 200)),
              charsPerLine: Math.round(num(gridRaw.charsPerLine, 28, 1, 200)),
            },
          }
        : {}),
    },
    body: block(r.body, base.body),
    headings,
    quote: {
      indentChars: num(obj(r.quote).indentChars, base.quote.indentChars, 0, 20),
      italic: bool(obj(r.quote).italic, base.quote.italic),
      ...(typeof obj(r.quote).sizePt === "number"
        ? { sizePt: num(obj(r.quote).sizePt, base.body.sizePt, 1, 1638) }
        : {}),
    },
    code: {
      fontAscii: str(obj(r.code).fontAscii, base.code.fontAscii),
      sizePt: num(obj(r.code).sizePt, base.code.sizePt, 1, 1638),
      shaded: bool(obj(r.code).shaded, base.code.shaded),
    },
    list: { indentChars: num(obj(r.list).indentChars, base.list.indentChars, 0, 20) },
    table: {
      headerBold: bool(obj(r.table).headerBold, base.table.headerBold),
      borders: bool(obj(r.table).borders, base.table.borders),
      repeatHeader: bool(obj(r.table).repeatHeader, base.table.repeatHeader),
    },
    headerFooter: {
      headerText: typeof hfRaw.headerText === "string" ? hfRaw.headerText : base.headerFooter.headerText,
      headerAlign: align(hfRaw.headerAlign, base.headerFooter.headerAlign),
      pageNumber: oneOf(hfRaw.pageNumber, PAGE_NUMBER_STYLES, base.headerFooter.pageNumber),
      pageNumberAlign: align(hfRaw.pageNumberAlign, base.headerFooter.pageNumberAlign),
      differentOddEven: bool(hfRaw.differentOddEven, base.headerFooter.differentOddEven),
    },
    headingNumbering: {
      enabled: bool(numberingRaw.enabled, base.headingNumbering.enabled),
      levels: [0, 1, 2, 3].map((i) =>
        oneOf(levelsRaw[i], HEADING_NUMBER_FORMATS, base.headingNumbering.levels[i]),
      ) as HeadingNumbering["levels"],
    },
  };
}

const ALIGNS: readonly Align[] = ["left", "center", "right", "justify"];
const LINE_RULES: readonly LineRule[] = ["exact", "atLeast", "auto"];
export const PAGE_NUMBER_STYLES: readonly PageNumberStyle[] = ["none", "plain", "dashed", "ofTotal"];
export const HEADING_NUMBER_FORMATS: readonly HeadingNumberFormat[] = [
  "none", "chinese", "chineseParen", "decimal", "decimalParen", "decimalDotted",
];
