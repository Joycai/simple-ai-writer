/**
 * `DocBlock[]` + `DocFormat` → .docx 字节。
 *
 * 刻意薄：能不碰库就决定的全部住在 `format.ts` / `blocks.ts` / `resolve.ts`，
 * 所以这里是**唯一**知道 `docx` 存在的文件，哪天换库或改走 Rust，重写的只有它
 * （同 `lib/pptx/write.ts` 的分法）。
 *
 * 库是懒加载的：1.1MB，只有开了 Beta 又真的导出的作者才需要它，不能进启动包。
 */

import {
  charsToInd,
  gridToDocx,
  lineSpacingToTwip,
  mmToTwip,
  paperMm,
  ptToHalfPt,
  ptToTwip,
  type BlockStyle,
  type DocFormat,
  type HeadingNumberFormat,
} from "./format";
import { splitChapters, type DocBlock, type DocRun } from "./blocks";

/** 一张已经读进内存、量过尺寸的插图。 */
export interface ResolvedImage {
  data: Uint8Array;
  type: "png" | "jpg" | "gif" | "bmp";
  widthPx: number;
  heightPx: number;
}

const BULLET = "saw-bullet";
const ORDERED = "saw-ordered";
const HEADING_NUM = "saw-heading";
const QUOTE_STYLE = "SawQuote";
const CODE_STYLE = "SawCode";
/** numbering / 引用缩进的层数上限。再深 Word 里也没人排版。 */
const MAX_LEVELS = 4;

export async function blocksToDocx(
  blocks: DocBlock[],
  format: DocFormat,
  images: Map<string, ResolvedImage>,
): Promise<Uint8Array> {
  const d = await import("docx");
  // 横向时长短边已经在 paperMm 里对调过——这里再读一次 PAGE_SIZES 就会把版心
  // 算错，而那是不会报错的那种错。
  const { widthMm, heightMm } = paperMm(format.page);
  const m = format.page.margins;
  // 版心宽度，插图按它等比缩放：一张比版心宽的图 Word 会撑破页面。
  const bodyWidthPx = Math.round(((widthMm - m.left - m.right) / 25.4) * 96);

  const doc = new d.Document({
    styles: {
      default: {
        document: {
          run: runProps(d, format.body),
          paragraph: paraProps(d, format.body, format.body),
        },
        // 覆盖内置标题走 `default.heading*` 而**不是** `paragraphStyles`：后者会
        // 产出两个同名 w:styleId（00-feasibility §2.1 实测），Word 大概率认后
        // 一个，但那是运气不是保证。
        heading1: headingStyle(d, format, 0),
        heading2: headingStyle(d, format, 1),
        heading3: headingStyle(d, format, 2),
        heading4: headingStyle(d, format, 3),
      },
      paragraphStyles: [
        {
          id: QUOTE_STYLE,
          name: "SAW Quote",
          basedOn: "Normal",
          quickFormat: false,
          run: {
            italics: format.quote.italic,
            ...(format.quote.sizePt ? { size: ptToHalfPt(format.quote.sizePt) } : {}),
          },
          paragraph: {
            indent: {
              start: ptToTwip(format.body.sizePt * format.quote.indentChars),
              firstLine: 0,
            },
          },
        },
        {
          id: CODE_STYLE,
          name: "SAW Code",
          basedOn: "Normal",
          run: {
            font: { ascii: format.code.fontAscii, hAnsi: format.code.fontAscii },
            size: ptToHalfPt(format.code.sizePt),
          },
          paragraph: {
            spacing: { line: 240, lineRule: "auto", before: 0, after: 0 },
            indent: { firstLine: 0 },
            // 底纹画在**段落**上而不是 run 上：run 级的只染到字后面，一行代码
            // 的行尾会缺一块，长短不一的代码块看起来像被咬过。
            ...(format.code.shaded
              ? { shading: { type: d.ShadingType.CLEAR, fill: "F2F0EC" } }
              : {}),
          },
        },
      ],
    },
    // 奇偶页不同要在**文档**层开，不是在节里——只设节属性的话 Word 会照单页
    // 的页脚排满全篇，偶数页那半安静地不出现。
    ...(format.headerFooter.differentOddEven ? { evenAndOddHeaderAndFooters: true } : {}),
    numbering: {
      config: [
        bulletConfig(d, format),
        orderedConfig(d, format),
        ...(format.headingNumbering.enabled ? [headingNumberConfig(d, format)] : []),
      ],
    },
    // 一节，除非「每章页码从 1 开始」——那时每个一级标题起一节。
    sections: (format.headerFooter.restartEachChapter ? splitChapters(blocks) : [blocks]).map(
      (chapter, index) => ({
        ...headersAndFooters(d, format),
        properties: {
          page: {
            size: {
              width: mmToTwip(widthMm),
              height: mmToTwip(heightMm),
              orientation: format.page.landscape
                ? d.PageOrientation.LANDSCAPE
                : d.PageOrientation.PORTRAIT,
            },
            margin: {
              top: mmToTwip(m.top),
              right: mmToTwip(m.right),
              bottom: mmToTwip(m.bottom),
              left: mmToTwip(m.left),
            },
            ...(format.headerFooter.restartEachChapter ? { pageNumbers: { start: 1 } } : {}),
          },
          grid: gridToDocx(format.page, format.body.sizePt),
          // 第一节不发 type：那会在文稿最前面多插一个分节符。
          ...(index > 0 ? { type: d.SectionType.NEXT_PAGE } : {}),
          ...(format.headerFooter.differentFirstPage ? { titlePage: true } : {}),
        },
        children: chapter.flatMap((b) => renderBlock(d, b, format, images, bodyWidthPx)),
      }),
    ),
  });

  // `toBuffer` 在浏览器里没有 Buffer，`toBlob` 要 DOM——base64 是两边都有的那条
  // 路，而且正好接上这个 app 已有的 base64 二进制写盘通道。
  const b64 = await d.Packer.toBase64String(doc);
  return base64ToBytes(b64);
}

type Docx = typeof import("docx");

function runProps(d: Docx, s: BlockStyle) {
  void d;
  return {
    font: {
      ascii: s.font.ascii,
      hAnsi: s.font.ascii,
      eastAsia: s.font.eastAsia,
      // 省掉它，半角标点和数字会按西文字体走——屏幕上像回事，但校到「标点也
      // 必须是仿宋」那一条就挂了。
      hint: "eastAsia",
    },
    size: ptToHalfPt(s.sizePt),
    bold: s.bold,
  };
}

function paraProps(d: Docx, s: BlockStyle, body: BlockStyle) {
  const line = s.line ?? body.line;
  return {
    alignment: alignOf(d, s.align),
    spacing: {
      before: ptToTwip(s.spaceBeforePt),
      after: ptToTwip(s.spaceAfterPt),
      ...(line ? lineSpacingToTwip(line) : {}),
    },
    // 中文规格说的是「缩进 2 字符」，所以走 firstLineChars 而不是按磅写死的
    // firstLine——后者在作者改字号时会错位。
    indent: { firstLineChars: charsToInd(s.firstLineChars) },
  };
}

function headingStyle(d: Docx, format: DocFormat, index: number) {
  const s = format.headings[index];
  // 每章一节时，分节符本身就分页——再叠一个 pageBreakBefore，每章前面会多出
  // 一张白纸。让开的是一级标题，因为节正是按它切的。
  const sectionBreaks = index === 0 && format.headerFooter.restartEachChapter;
  return {
    run: runProps(d, s),
    paragraph: {
      ...paraProps(d, s, format.body),
      ...(s.pageBreakBefore && !sectionBreaks ? { pageBreakBefore: true } : {}),
    },
  };
}

function alignOf(d: Docx, a: BlockStyle["align"]) {
  switch (a) {
    case "center": return d.AlignmentType.CENTER;
    case "right": return d.AlignmentType.RIGHT;
    case "justify": return d.AlignmentType.BOTH;
    default: return d.AlignmentType.LEFT;
  }
}

function levels(d: Docx, format: DocFormat, ordered: boolean) {
  const step = ptToTwip(format.body.sizePt * format.list.indentChars);
  const marks = ordered
    ? ["%1.", "%2)", "%3.", "%4)"]
    : ["•", "○", "▪", "·"];
  return Array.from({ length: MAX_LEVELS }, (_, level) => ({
    level,
    format: ordered ? d.LevelFormat.DECIMAL : d.LevelFormat.BULLET,
    text: marks[level],
    alignment: d.AlignmentType.LEFT,
    style: {
      paragraph: {
        indent: { left: step * (level + 1), hanging: step },
        // 项目符号自己就是缩进，再叠一次首行缩进会把符号推到字里去。
        ...(level === 0 ? {} : {}),
      },
    },
  }));
}

const bulletConfig = (d: Docx, f: DocFormat) => ({ reference: BULLET, levels: levels(d, f, false) });
const orderedConfig = (d: Docx, f: DocFormat) => ({ reference: ORDERED, levels: levels(d, f, true) });

function renderBlock(
  d: Docx,
  block: DocBlock,
  format: DocFormat,
  images: Map<string, ResolvedImage>,
  bodyWidthPx: number,
) {
  switch (block.kind) {
    case "heading": {
      // 五、六级沿用四级：Word 的内置样式再往下也不再有排版意义。
      const level = Math.min(block.level, MAX_LEVELS);
      const headings = [
        d.HeadingLevel.HEADING_1,
        d.HeadingLevel.HEADING_2,
        d.HeadingLevel.HEADING_3,
        d.HeadingLevel.HEADING_4,
      ];
      // 自动编号只挂在写法不是 none 的那几级上：给一级挂一个空编号，Word 仍会
      // 为它留出一个制表位，标题就莫名其妙地缩进了。
      const numbered =
        format.headingNumbering.enabled &&
        format.headingNumbering.levels[level - 1] !== "none";
      return [
        new d.Paragraph({
          heading: headings[level - 1],
          ...(numbered ? { numbering: { reference: HEADING_NUM, level: level - 1 } } : {}),
          children: textRuns(d, block.runs),
        }),
      ];
    }
    case "paragraph":
      return [
        new d.Paragraph({
          ...(block.quote ? { style: QUOTE_STYLE } : {}),
          children: textRuns(d, block.runs),
        }),
      ];
    case "listItem":
      return [
        new d.Paragraph({
          numbering: {
            reference: block.ordered ? ORDERED : BULLET,
            level: Math.min(block.level, MAX_LEVELS - 1),
          },
          // 项目符号的缩进来自 numbering；正文的首行缩进要在这里清掉，否则第一
          // 个字会被推到符号右边两格。
          indent: { firstLine: 0 },
          children: textRuns(d, block.runs),
        }),
      ];
    case "code":
      // 一行一段而不是一段里塞换行：Word 的分页在段落边界上做，长代码块才不会
      // 整块被推到下一页。
      return block.text.split("\n").map(
        (line) => new d.Paragraph({ style: CODE_STYLE, children: [new d.TextRun({ text: line })] }),
      );
    case "rule":
      return [
        new d.Paragraph({
          indent: { firstLine: 0 },
          border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: "auto", space: 1 } },
          children: [],
        }),
      ];
    case "image": {
      const img = images.get(block.src);
      // 读不到的图落成替代文字，而不是让整份导出失败——同 `lib/fs/export` 的
      // inlineImages：文件里留一个看得见的洞，比什么都没有强。
      if (!img) {
        return [new d.Paragraph({ children: [new d.TextRun({ text: block.alt || block.src, italics: true })] })];
      }
      const scale = img.widthPx > bodyWidthPx ? bodyWidthPx / img.widthPx : 1;
      return [
        new d.Paragraph({
          alignment: d.AlignmentType.CENTER,
          indent: { firstLine: 0 },
          children: [
            new d.ImageRun({
              type: img.type,
              data: img.data,
              transformation: {
                width: Math.round(img.widthPx * scale),
                height: Math.round(img.heightPx * scale),
              },
            }),
          ],
        }),
      ];
    }
    case "table":
      return [
        new d.Table({
          width: { size: 100, type: d.WidthType.PERCENTAGE },
          ...(format.table.borders ? {} : { borders: d.TableBorders.NONE }),
          rows: block.rows.map((row, rowIndex) =>
            new d.TableRow({
              // 跨页时在每一页重复这一行——长表格没有它就读不下去。
              tableHeader: format.table.repeatHeader && rowIndex < block.headerRows,
              children: row.map(
                (cell) =>
                  new d.TableCell({
                    children: [
                      new d.Paragraph({
                        indent: { firstLine: 0 },
                        children: textRuns(
                          d,
                          rowIndex < block.headerRows && format.table.headerBold
                            ? cell.map((r) => ({ ...r, bold: true }))
                            : cell,
                        ),
                      }),
                    ],
                  }),
              ),
            }),
          ),
        }),
      ];
  }
}

function textRuns(d: Docx, runs: DocRun[]) {
  return runs.map(
    (r) =>
      new d.TextRun({
        text: r.text,
        bold: r.bold,
        italics: r.italic,
        strike: r.strike,
        ...(r.mono ? { font: { ascii: "Consolas", hAnsi: "Consolas" } } : {}),
      }),
  );
}

/** base64 → 字节。`atob` 在 webview 和 vitest 的 node 环境里都有。 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}


// ─── 页眉页脚 ─────────────────────────────────────────────────────────────────

/**
 * 一节的页眉页脚。**什么都没设就一个都不发**——发一个空页眉，Word 里那一行
 * 就占着位置，作者会以为自己设过。
 *
 * `differentOddEven` 为真时偶数页的对齐左右互换：装订成册后页码落在订口外侧。
 * 居中的页码不受影响，所以这是一条规则而不是两套字段。
 */
function headersAndFooters(d: Docx, format: DocFormat) {
  const hf = format.headerFooter;
  type H = InstanceType<Docx["Header"]>;
  type F = InstanceType<Docx["Footer"]>;
  const out: {
    headers?: { default: H; even?: H; first?: H };
    footers?: { default: F; even?: F; first?: F };
  } = {};

  // 横线可以单独存在：有些模板就只要一条线，不要字。
  if (hf.headerText.trim() || hf.headerRule) {
    const header = () =>
      new d.Header({
        children: [
          new d.Paragraph({
            alignment: alignOf(d, hf.headerAlign),
            indent: { firstLine: 0 },
            ...(hf.headerRule
              ? { border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: "auto", space: 1 } } }
              : {}),
            children: hf.headerText.trim() ? [new d.TextRun({ text: hf.headerText })] : [],
          }),
        ],
      });
    out.headers = {
      default: header(),
      ...(hf.differentOddEven ? { even: header() } : {}),
      // 首页不同＝首页**什么都不写**。不是「首页写别的」：那是两套内容，而作者
      // 要的从来是「封面这一页空着」。空的 Header 是必须发的——不发的话 Word
      // 会拿 default 顶上，titlePage 就等于没设。
      ...(hf.differentFirstPage ? { first: new d.Header({ children: [] }) } : {}),
    };
  }

  if (hf.pageNumber !== "none") {
    const footer = (align: BlockStyle["align"]) =>
      new d.Footer({
        children: [
          new d.Paragraph({
            alignment: alignOf(d, align),
            indent: { firstLine: 0 },
            children: [new d.TextRun({ children: pageNumberRun(d, format) })],
          }),
        ],
      });
    out.footers = {
      default: footer(hf.pageNumberAlign),
      ...(hf.differentOddEven ? { even: footer(mirror(hf.pageNumberAlign)) } : {}),
      ...(hf.differentFirstPage ? { first: new d.Footer({ children: [] }) } : {}),
    };
  }

  return out;
}

/** 左右互换，居中和两端不动。 */
function mirror(align: BlockStyle["align"]): BlockStyle["align"] {
  if (align === "left") return "right";
  if (align === "right") return "left";
  return align;
}

function pageNumberRun(d: Docx, format: DocFormat) {
  switch (format.headerFooter.pageNumber) {
    case "dashed":
      // 公文的一字线页码。用 U+2014 而不是连字符——规范里那是一字线。
      return ["— ", d.PageNumber.CURRENT, " —"];
    case "ofTotal":
      return [d.PageNumber.CURRENT, " / ", d.PageNumber.TOTAL_PAGES];
    default:
      return [d.PageNumber.CURRENT];
  }
}

// ─── 标题自动编号 ─────────────────────────────────────────────────────────────

/**
 * 一、（一）1. （1）——把每一级的写法翻成 OOXML 的编号定义。
 *
 * `decimalDotted` 含上级序号（1.1.1），所以它的 text 要把前面每一级的占位符都
 * 串上；其余写法只用本级的。
 */
function headingLevelText(format: HeadingNumberFormat, level: number): string {
  const self = `%${level + 1}`;
  switch (format) {
    case "chinese": return `${self}、`;
    case "chineseParen": return `（${self}）`;
    case "decimal": return `${self}.`;
    case "decimalParen": return `（${self}）`;
    case "decimalDotted":
      return Array.from({ length: level + 1 }, (_, i) => `%${i + 1}`).join(".");
    default: return "";
  }
}

function headingNumberConfig(d: Docx, format: DocFormat) {
  return {
    reference: HEADING_NUM,
    levels: format.headingNumbering.levels.map((kind, level) => ({
      level,
      format: kind === "chinese" || kind === "chineseParen"
        ? d.LevelFormat.CHINESE_COUNTING
        : d.LevelFormat.DECIMAL,
      text: headingLevelText(kind, level),
      alignment: d.AlignmentType.LEFT,
      // 序号和标题之间不插制表位：公文的「一、总体要求」是连着的，而 Word 的
      // 默认 tab 会把标题推到一个和正文对不齐的位置上。
      suffix: d.LevelSuffix.NOTHING,
      style: {
        // 缩进交给标题样式的 firstLineChars —— 编号自己再加一层就会双重缩进。
        paragraph: { indent: { left: 0, hanging: 0 } },
      },
    })),
  };
}
