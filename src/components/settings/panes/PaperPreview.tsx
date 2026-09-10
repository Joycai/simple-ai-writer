/**
 * 纸样示意图 —— 让一屏数字变得可读的那张图。
 *
 * 三条它必须一直是的东西（设计稿 1c）：
 *
 * 1. **它是示意图，不是所见即所得。** 正文一律画成灰条，不画真的字——本机大
 *    概率没装仿宋_GB2312，真渲染出来的是替换字体，看着不对而文件是对的，那
 *    比什么都不画更糟。右上角那枚「示意图 · 不是所见即所得」的标签不是谦辞，
 *    是这张图的使用说明。
 * 2. **每一根线都是算出来的。** 版心是页面减页边距，行位是行距，缩进那一格
 *    是「字符数 × 字号」。没有一处是为了好看摆上去的——改一个数字，图上对应
 *    的那一处就动，这才让它能当核对工具用。
 * 3. **条子的语义固定**：粗深条＝标题（高度＝字号），细浅条＝正文行（间距＝
 *    行距）。所以「改成 1.5 倍」时条子不动、间距变，一眼看得出改的是哪一条。
 */

import { useTranslation } from "react-i18next";
import {
  bodyRegionMm,
  pageNumberSample,
  paperMm,
  type BlockStyle,
  type DocFormat,
} from "../../../lib/docx/format";
import styles from "./DocFormat.module.css";

/**
 * 纸样宽度（px）。高度按纸张比例来，所以只需要一个基准。
 * 抽屉里那张是同一张图缩了尺——不是另画一张，否则两处会各自漂。
 */
const PAGE_PX = 300;
const PAGE_PX_COMPACT = 188;
const MM_PER_PT = 25.4 / 72;

/** 画出来的一根条子。 */
interface Bar {
  /** 版心内坐标，毫米。 */
  x: number;
  y: number;
  w: number;
  h: number;
  heading: boolean;
}

/**
 * 一行占多高（毫米）。网格开着时行位由网格定义（公文就是这么规定的）；否则
 * 由行距定义——固定值/最小值直接是磅，倍数按字号的 1.2 倍折算，那是 Word 对
 * 「单倍」的实际取值。
 */
function linePitchMm(f: DocFormat): number {
  if (f.page.grid) return bodyRegionMm(f.page).heightMm / f.page.grid.linesPerPage;
  const line = f.body.line;
  if (!line || line.rule === "auto") return f.body.sizePt * (line?.value ?? 1) * 1.2 * MM_PER_PT;
  return line.value * MM_PER_PT;
}

/**
 * 版面脚本：一个标题、一段正文、一个二级标题……画的是**节奏**，不是某一份
 * 具体文稿。每一段的行数固定，所以两套格式并排看时差别全部来自格式本身。
 */
function layout(f: DocFormat): { bars: Bar[]; indentCell: Bar | null; marks: Mark[] } {
  const region = bodyRegionMm(f.page);
  const pitch = linePitchMm(f);
  const bodyH = f.body.sizePt * MM_PER_PT;
  const indentMm = f.body.firstLineChars * f.body.sizePt * MM_PER_PT;

  const bars: Bar[] = [];
  const marks: Mark[] = [];
  /** 缩进那一格：由第一段首行**推出来**，不在循环里边写边攒——那样 TS 只能
      看见闭包里的赋值，narrowing 会把它读成 never。 */
  let indentAt: { y: number } | undefined;
  let y = 0;

  // 自动编号开着且这一级有写法时，标题条前多一小截同色同高的条、隔一个字位——它只说
  // 「这里会多占一段宽度」，不写字：写了就等于承诺我们知道 Word 会排出几个字符宽（05h 屏 1c）。
  const heading = (s: BlockStyle, widthRatio: number, label: string, levelIdx: number) => {
    y += s.spaceBeforePt * MM_PER_PT;
    const h = s.sizePt * MM_PER_PT;
    const w = region.widthMm * widthRatio;
    const numbered = f.headingNumbering.enabled && f.headingNumbering.levels[levelIdx] !== "none";
    const stub = numbered ? h * 1.6 : 0;
    const gap = numbered ? h * 0.8 : 0;
    const x0 = s.align === "center" ? (region.widthMm - (stub + gap + w)) / 2 : 0;
    if (numbered) bars.push({ x: x0, y, w: stub, h, heading: true });
    bars.push({ x: x0 + stub + gap, y, w, h, heading: true });
    marks.push({ y: y + h / 2, label });
    y += h + s.spaceAfterPt * MM_PER_PT;
  };

  const paragraph = (lines: number, lastRatio: number, first: boolean) => {
    for (let i = 0; i < lines; i++) {
      const indented = i === 0 && indentMm > 0;
      const x = indented ? indentMm : 0;
      const w = (i === lines - 1 ? region.widthMm * lastRatio : region.widthMm) - x;
      bars.push({ x, y, w, h: bodyH * 0.42, heading: false });
      if (indented && !indentAt) {
        indentAt = { y };
        if (first) marks.push({ y: y + bodyH * 0.45, label: "indent" });
      }
      if (i === 0 && first) marks.push({ y: y + pitch, label: "body" });
      y += pitch;
    }
    y += f.body.spaceAfterPt * MM_PER_PT;
  };

  heading(f.headings[0], 0.45, "h1", 0);
  paragraph(6, 0.62, true);
  heading(f.headings[1], 0.3, "h2", 1);
  paragraph(5, 0.8, false);
  heading(f.headings[2], 0.22, "h3", 2);
  paragraph(3, 0.53, false);

  const cell: Bar | null =
    indentAt && indentAt.y + bodyH * 0.9 <= region.heightMm
      ? { x: 0, y: indentAt.y, w: indentMm, h: bodyH * 0.9, heading: false }
      : null;

  // 超出版心的部分不画：一页装不下就是装不下，硬缩比例会让「行距」失真。
  return {
    bars: bars.filter((b) => b.y + b.h <= region.heightMm),
    indentCell: cell,
    marks: marks.filter((m) => m.y <= region.heightMm),
  };
}

interface Mark {
  y: number;
  label: string;
}

export function PaperPreview({ format, compact = false }: { format: DocFormat; compact?: boolean }) {
  const { t } = useTranslation();
  const page = paperMm(format.page);
  const pagePx = compact ? PAGE_PX_COMPACT : PAGE_PX;
  const scale = pagePx / page.widthMm;
  const region = bodyRegionMm(format.page);
  const m = format.page.margins;
  const { bars, indentCell, marks } = layout(format);
  const pitch = linePitchMm(format);

  const px = (mm: number) => `${mm * scale}px`;
  const markText: Record<string, string> = {
    h1: t("docxFormat.preview.markH1", { font: format.headings[0].font.eastAsia, size: format.headings[0].sizePt }),
    indent: t("docxFormat.preview.markIndent", {
      chars: format.body.firstLineChars,
      mm: (format.body.firstLineChars * format.body.sizePt * MM_PER_PT).toFixed(1),
    }),
    body: t("docxFormat.preview.markBody", { font: format.body.font.eastAsia, size: format.body.sizePt }),
    h2: t("docxFormat.preview.markH2", { font: format.headings[1].font.eastAsia, size: format.headings[1].sizePt }),
    h3: t("docxFormat.preview.markH3", { font: format.headings[2].font.eastAsia, size: format.headings[2].sizePt }),
  };

  return (
    <div className={styles.previewFrame}>
      <div
        className={styles.previewStage}
        style={{
          width: `${pagePx + (compact ? 34 : 158)}px`,
          height: `${page.heightMm * scale + 28}px`,
        }}
      >
        {/* 顶边尺：左右页边距各一段，中间是版心宽 */}
        <div className={styles.rulerTop} style={{ left: "26px", width: px(page.widthMm) }}>
          <div className={styles.rulerSeg} style={{ width: px(m.left) }}>
            <span className={styles.rulerNum}>{m.left}</span>
          </div>
          <div className={styles.rulerSeg} style={{ flex: 1 }}>
            <span className={styles.rulerTick} />
            <span className={styles.rulerLine} />
            <span className={styles.rulerNum}>{fmt(region.widthMm)} mm</span>
            <span className={styles.rulerLine} />
            <span className={styles.rulerTick} />
          </div>
          <div className={styles.rulerSeg} style={{ width: px(m.right) }}>
            <span className={styles.rulerNum}>{m.right}</span>
          </div>
        </div>

        {/* 左边尺 */}
        <div className={styles.rulerLeft} style={{ top: "28px", height: px(page.heightMm) }}>
          <div className={styles.rulerSegV} style={{ height: px(m.top) }}>
            <span className={styles.rulerNum}>{m.top}</span>
          </div>
          <div className={styles.rulerSegV} style={{ flex: 1 }}>
            <span className={styles.rulerTickV} />
            <span className={styles.rulerLineV} />
            <span className={styles.rulerNumV}>{fmt(region.heightMm)} mm</span>
            <span className={styles.rulerLineV} />
            <span className={styles.rulerTickV} />
          </div>
          <div className={styles.rulerSegV} style={{ height: px(m.bottom) }}>
            <span className={styles.rulerNum}>{m.bottom}</span>
          </div>
        </div>

        {/* 纸 */}
        <div
          className={styles.paper}
          style={{ left: "26px", top: "28px", width: px(page.widthMm), height: px(page.heightMm) }}
        >
          <div className={styles.paperHatch} />

          {/* 版心：唯一的虚线框——虚线＝「这条边是算出来的，不是画上去的」 */}
          <div
            className={styles.region}
            style={{
              left: px(m.left),
              top: px(m.top),
              width: px(region.widthMm),
              height: px(region.heightMm),
              // 行位淡线：网格开着时是网格行，否则是行距
              backgroundImage: `repeating-linear-gradient(var(--stg-bg-input) 0 ${pitch * scale - 1}px, var(--doc-grid-line) ${pitch * scale - 1}px ${pitch * scale}px)`,
            }}
          >
            {format.page.grid && (
              <div
                className={styles.charRuler}
                style={{
                  backgroundImage: `repeating-linear-gradient(90deg, var(--doc-tick) 0 1px, transparent 1px ${(region.widthMm * scale) / format.page.grid.charsPerLine}px)`,
                }}
              />
            )}
            {indentCell && (
              <div
                className={styles.indentCell}
                style={{
                  left: px(indentCell.x),
                  top: px(indentCell.y),
                  width: px(indentCell.w),
                  height: px(indentCell.h),
                }}
              />
            )}
            {bars.map((b, i) => (
              <div
                key={i}
                className={b.heading ? styles.barHeading : styles.barBody}
                style={{ left: px(b.x), top: px(b.y), width: px(b.w), height: px(b.h) }}
              />
            ))}
          </div>
          {/* 行号刻度 1 / 5 / 10 / … / 末行，与顶边的「N 字位」（设计稿 05e 屏 1c）：网格
              开着时才有——它们标的是格子，不是尺寸。紧凑模式不画。 */}
          {format.page.grid && !compact && (
            <>
              <div className={styles.rowNums} style={{ left: `calc(${px(m.left)} - 16px)`, top: px(m.top) }} aria-hidden>
                {gridRowMarks(format.page.grid.linesPerPage).map((n) => (
                  <span key={n} className={styles.rowNum} style={{ top: px((n - 0.5) * pitch) }}>{n}</span>
                ))}
              </div>
              <span
                className={styles.charColsTag}
                style={{ right: px(m.right), top: px(m.top) }}
                aria-hidden
              >
                {t("docxFormat.preview.charCols", { n: format.page.grid.charsPerLine })}
              </span>
            </>
          )}
          {/* 页眉横线：版心上边线之上一个行位处、长度＝版心宽的 1px 实线。它在文件里也确实是一根线，
              不是一行字，所以不用灰条；虚线仍然只表示「算出来的边」（05h 屏 1c）。 */}
          {format.headerFooter.headerRule && (
            <div
              className={styles.headerRule}
              style={{ left: px(m.left), top: px(Math.max(m.top - pitch, m.top / 2)), width: px(region.widthMm) }}
            />
          )}
          {/* 页码是斜纹里唯一的住户：等宽小字、按对齐落在版心的左 / 中 / 右。它是全图唯一真的写出字符
              的地方——它写的就是那个字符串，不是一段会被替换字体的正文。奇偶 / 首页 / 每章重来不画：
              纸样只有「默认那一页」，不翻页、不画第二张纸。 */}
          {format.headerFooter.pageNumber !== "none" && (
            <div
              className={`${styles.pageNum} ${compact ? styles.pageNumCompact : ""}`}
              style={{
                left: px(m.left),
                width: px(region.widthMm),
                top: px(m.top + region.heightMm + m.bottom / 2),
                textAlign: format.headerFooter.pageNumberAlign === "justify" ? "center" : format.headerFooter.pageNumberAlign,
              }}
            >
              {pageNumberSample(format.headerFooter.pageNumber)}
            </div>
          )}
          <span className={styles.schematic}>SCHEMATIC</span>
        </div>

        {/* 右侧引线标注。紧凑模式不画：188px 的图旁边挂五行小字只是噪音，
            抽屉里那几个值本来就在左边的表单里。 */}
        {!compact && (
        <div className={styles.marks} style={{ left: `${26 + page.widthMm * scale}px`, top: "28px" }}>
          {marks.map((mk, i) => (
            <div key={i} className={styles.mark} style={{ top: px(m.top + mk.y) }}>
              <span className={styles.markLeader} />
              <span className={styles.markText}>{markText[mk.label]}</span>
            </div>
          ))}
        </div>
        )}
      </div>

      {!compact && (
      <div className={styles.legend}>
        <span className={styles.legendItem}><span className={styles.legendHeading} />{t("docxFormat.preview.legendHeading")}</span>
        <span className={styles.legendItem}><span className={styles.legendBody} />{t("docxFormat.preview.legendBody")}</span>
        <span className={styles.legendItem}><span className={styles.legendMargin} />{t("docxFormat.preview.legendMargin")}</span>
        <span className={styles.legendItem}><span className={styles.legendRegion} />{t("docxFormat.preview.legendRegion")}</span>
      </div>
      )}
    </div>
  );
}

/** 1 / 5 / 10 / 15 / … 加末行——点出第几行，不是每行都标。 */
function gridRowMarks(lines: number): number[] {
  const marks = [1];
  for (let n = 5; n < lines; n += 5) marks.push(n);
  if (lines > 1) marks.push(lines);
  return marks;
}

/** 25.4 → "25.4"，26 → "26"。尺上的数字不该带无意义的小数点。 */
function fmt(mm: number): string {
  return Number.isInteger(mm) ? String(mm) : mm.toFixed(1);
}
