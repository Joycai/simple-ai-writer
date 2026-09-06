/**
 * 预设编辑抽屉（设计稿 1f/1g）。
 *
 * 四级标题为什么是**一张紧凑表 + 单级展开**，而不是四张卡 / 四个折叠组 / 一排
 * tab：四级的字段集完全一样、只有值不同，所以真正的问题不是「怎么塞下四份
 * 表单」，而是**「怎么让四级的值能横向比」**——甲方要求里最常见的错就是 H3
 * 抄了 H2 的段前值。一张四行六列、全等宽的表把要核对的值摆在一屏里对齐；点
 * 任意一行就地展开成完整字段，表本身既是核对表也是级别选择器。
 *
 * 底栏常驻、不做即时保存：这是会长期生效的配置，不是即时预览。点抽屉外的空白
 * 不关闭（有未保存的改动），Esc 会先问一句。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, X } from "lucide-react";
import { PaperPreview } from "./PaperPreview";
import { isFontInstalled } from "../../../lib/docx/fontCheck";
import {
  bodyRegionMm,
  CN_SIZES,
  formatLineSpacing,
  formatOneLine,
  formatSize,
  PAGE_SIZES,
  paperMm,
  parseSize,
  type Align,
  type BlockStyle,
  type DocFormat,
  type DocFormatPreset,
  type LineRule,
  type LineSpacing,
  type PageSizeName,
  HEADING_NUMBER_FORMATS,
  PAGE_NUMBER_STYLES,
  headingNumberSample,
  headingNumberingLine,
  isChineseNumbering,
  numberingConflicts,
  numberingPickBlocked,
  type HeadingNumberFormat,
  type PageNumberStyle,
} from "../../../lib/docx/format";
import styles from "./DocFormat.module.css";

const MM_PER_PT = 25.4 / 72;

export function DocFormatDrawer({
  preset,
  onSave,
  onClose,
}: {
  preset: DocFormatPreset;
  onSave: (next: DocFormatPreset) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(preset.label);
  const [format, setFormat] = useState<DocFormat>(() => structuredClone(preset.format));
  const [level, setLevel] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = label !== preset.label || JSON.stringify(format) !== JSON.stringify(preset.format);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Esc：干净就直接关，脏了先问一句。抽屉自己吃掉这次按键，所以设置页不会跟着
  // 一起关（SettingsPage 的 escIntercept 是同一条约定）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (dirtyRef.current) setConfirmDiscard(true);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const patch = (part: Partial<DocFormat>) => setFormat((f) => ({ ...f, ...part }));
  const patchBody = (part: Partial<BlockStyle>) =>
    setFormat((f) => ({ ...f, body: { ...f.body, ...part } }));
  const patchHeading = (index: number, part: Partial<BlockStyle>) =>
    setFormat((f) => ({
      ...f,
      headings: f.headings.map((h, i) => (i === index ? { ...h, ...part } : h)) as DocFormat["headings"],
    }));

  const region = bodyRegionMm(format.page);
  const paper = paperMm(format.page);
  const indentMm = format.body.firstLineChars * format.body.sizePt * MM_PER_PT;
  const numberingOn = format.headingNumbering.enabled;
  const numLevels = format.headingNumbering.levels;
  // 已存下的坏组合（#505 之前复制出去的论文预设）：下拉拦得住选、拦不住存过的值，只能指出来。
  const numConflicts = numberingOn ? numberingConflicts(numLevels) : [];
  // 编号下拉旁那行 mono：这一级此刻要么已经坏了（warm），要么有项被拦要说一声为什么，要么就是「样例即选项」。
  const numEcho = (lv: number): { text: string; warm: boolean } => {
    const here = numberingPickBlocked(numLevels, lv, numLevels[lv]);
    if (here === "upperChinese") return { text: t("docxFormat.drawer.numberingConflictDotted"), warm: true };
    if (here === "lowerDotted") return { text: t("docxFormat.drawer.numberingConflictChinese"), warm: true };
    if (numLevels.slice(lv + 1).includes("decimalDotted")) return { text: t("docxFormat.drawer.numberingNoChinese"), warm: false };
    if (numLevels.slice(0, lv).some(isChineseNumbering)) return { text: t("docxFormat.drawer.numberingNoDotted"), warm: false };
    return { text: t("docxFormat.drawer.numberingPick"), warm: false };
  };
  const hasPn = format.headerFooter.pageNumber !== "none";
  const hasAny = hasPn || !!format.headerFooter.headerText.trim() || format.headerFooter.headerRule;
  const hfEmpty = !hasAny;
  // 「一、总体要求」那个反例——前缀取 H1 当前的写法，关掉或不编号时不会渲染到这里。
  const exPrefix = numberingOn && format.headingNumbering.levels[0] !== "none"
    ? headingNumberSample(format.headingNumbering.levels[0], 0)
    : t("docxFormat.drawer.numberingExPrefix");
  const exRest = t("docxFormat.drawer.numberingExRest");

  return (
    <>
      {/* 点空白处不关闭——有未保存的改动。所以这层只是变暗，不接 onClick。 */}
      <div className={styles.scrim} />
      <div className={styles.drawer} role="dialog" aria-label={t("docxFormat.drawer.title")}>
        <div className={styles.drawerHead}>
          <div className={styles.drawerHeadMain}>
            <div className={styles.drawerEyebrow}>{t("docxFormat.drawer.title")}</div>
            <input
              className={styles.nameInput}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("docxFormat.drawer.namePlaceholder")}
              aria-label={t("docxFormat.drawer.namePlaceholder")}
            />
            {preset.imitatedFrom && (
              <div className={styles.drawerFrom}>{t("docxFormat.readFrom", { file: preset.imitatedFrom })}</div>
            )}
          </div>
          <button className={styles.iconBtn} onClick={() => (dirty ? setConfirmDiscard(true) : onClose())} aria-label={t("common.close", { defaultValue: "关闭" })}>
            <X size={15} />
          </button>
        </div>

        <div className={styles.drawerBody}>
          <div className={styles.fields}>
            {/* ── 页面 ───────────────────────────────────────────────── */}
            <GroupHead
              label={t("docxFormat.drawer.groupPage")}
              summary={`${format.page.size}${format.page.landscape ? " · " + t("docxFormat.drawer.landscape") : ""}${
                format.page.grid ? ` · ${format.page.grid.linesPerPage} × ${format.page.grid.charsPerLine}` : ""
              }`}
            />
            <Field label={t("docxFormat.drawer.paper")}>
              <select
                className={styles.select}
                value={format.page.size}
                onChange={(e) => patch({ page: { ...format.page, size: e.target.value as PageSizeName } })}
              >
                {(Object.keys(PAGE_SIZES) as PageSizeName[]).map((k) => (
                  <option key={k} value={k}>
                    {`${k} · ${PAGE_SIZES[k].widthMm} × ${PAGE_SIZES[k].heightMm} mm`}
                  </option>
                ))}
              </select>
              <Seg
                value={format.page.landscape ? "landscape" : "portrait"}
                options={[
                  { value: "portrait", label: t("docxFormat.drawer.portrait") },
                  { value: "landscape", label: t("docxFormat.drawer.landscape") },
                ]}
                onChange={(v) => patch({ page: { ...format.page, landscape: v === "landscape" } })}
              />
            </Field>
            <Field label={t("docxFormat.drawer.margins")}>
              <div className={styles.marginGrid}>
                {(["top", "right", "bottom", "left"] as const).map((side) => (
                  <label key={side} className={styles.marginCell}>
                    <span className={styles.marginLabel}>{t(`docxFormat.drawer.margin_${side}`)}</span>
                    <Num
                      value={format.page.margins[side]}
                      unit="mm"
                      min={0}
                      max={100}
                      step={0.5}
                      onChange={(v) => patch({ page: { ...format.page, margins: { ...format.page.margins, [side]: v } } })}
                    />
                  </label>
                ))}
              </div>
            </Field>
            <Field label={t("docxFormat.drawer.grid")}>
              <Switch
                on={!!format.page.grid}
                label={t("docxFormat.drawer.grid")}
                onChange={(on) =>
                  patch({ page: { ...format.page, grid: on ? { linesPerPage: 22, charsPerLine: 28 } : undefined } })
                }
              />
              {format.page.grid && (
                <div className={styles.inlinePair}>
                  <Num
                    value={format.page.grid.linesPerPage}
                    unit={t("docxFormat.drawer.linesPerPage")}
                    min={1}
                    max={80}
                    onChange={(v) => patch({ page: { ...format.page, grid: { ...format.page.grid!, linesPerPage: v } } })}
                  />
                  <span className={styles.times}>×</span>
                  <Num
                    value={format.page.grid.charsPerLine}
                    unit={t("docxFormat.drawer.charsPerLine")}
                    min={1}
                    max={80}
                    onChange={(v) => patch({ page: { ...format.page, grid: { ...format.page.grid!, charsPerLine: v } } })}
                  />
                </div>
              )}
            </Field>

            {/* ── 正文 ───────────────────────────────────────────────── */}
            <GroupHead label={t("docxFormat.drawer.groupBody")} summary={formatOneLine(format)} />
            <FontField
              label={t("docxFormat.drawer.fontEastAsia")}
              value={format.body.font.eastAsia}
              onChange={(v) => patchBody({ font: { ...format.body.font, eastAsia: v } })}
            />
            <FontField
              label={t("docxFormat.drawer.fontAscii")}
              value={format.body.font.ascii}
              onChange={(v) => patchBody({ font: { ...format.body.font, ascii: v } })}
            />
            <Field label={t("docxFormat.drawer.size")}>
              <SizePicker value={format.body.sizePt} onChange={(pt) => patchBody({ sizePt: pt })} />
            </Field>
            <Field label={t("docxFormat.drawer.line")}>
              <LinePicker value={format.body.line} onChange={(line) => patchBody({ line })} />
            </Field>
            <Field label={t("docxFormat.drawer.indent")}>
              <Num
                value={format.body.firstLineChars}
                unit={t("docxFormat.drawer.chars")}
                min={0}
                max={10}
                step={0.5}
                onChange={(v) => patchBody({ firstLineChars: v })}
              />
              <span className={styles.echo}>= {indentMm.toFixed(1)} mm</span>
            </Field>
            <Field label={t("docxFormat.drawer.spacing")}>
              <Num value={format.body.spaceBeforePt} unit={t("docxFormat.drawer.pt")} min={0} max={200}
                   onChange={(v) => patchBody({ spaceBeforePt: v })} />
              <span className={styles.times}>/</span>
              <Num value={format.body.spaceAfterPt} unit={t("docxFormat.drawer.pt")} min={0} max={200}
                   onChange={(v) => patchBody({ spaceAfterPt: v })} />
            </Field>
            <Field label={t("docxFormat.drawer.align")}>
              <AlignSeg value={format.body.align} onChange={(align) => patchBody({ align })} />
            </Field>

            {/* ── 标题 1–4 ───────────────────────────────────────────── */}
            <GroupHead
              label={t("docxFormat.drawer.groupHeadings")}
              summary={numberingOn
                ? t("docxFormat.drawer.numberingSummary", { s: headingNumberingLine(format.headingNumbering) })
                : t("docxFormat.drawer.numberingSummaryOff")}
            />
            {/* 总开关单独一行、留在表外：它管四级，不属于任何一级（05h 1z · A1）。 */}
            <Field label={t("docxFormat.drawer.numbering")}>
              <Switch
                on={format.headingNumbering.enabled}
                label={t("docxFormat.drawer.numbering")}
                onChange={(enabled) => patch({ headingNumbering: { ...format.headingNumbering, enabled } })}
              />
              <span className={styles.echo}>
                {format.headingNumbering.enabled ? t("docxFormat.drawer.numberingOn") : t("docxFormat.drawer.numberingOffHint")}
              </span>
            </Field>
            <div className={styles.headTable} role="table">
              <div className={styles.headRowHead} role="row">
                <span>{t("docxFormat.drawer.colLevel")}</span>
                <span>{t("docxFormat.drawer.colFont")}</span>
                <span>{t("docxFormat.drawer.colBold")}</span>
                <span>{t("docxFormat.drawer.colAlign")}</span>
                <span>{t("docxFormat.drawer.colSpacing")}</span>
                <span>{t("docxFormat.drawer.colBreak")}</span>
                {/* 第七列。— 是「作者选了不编号」，关闭时整列同一种灰的 —；虚线是「未设」，
                    这里一格都不用——关不是未设（05h 1z · A2）。 */}
                <span className={numberingOn ? styles.colOn : undefined}>
                  {numberingOn ? t("docxFormat.drawer.colNumbering") : t("docxFormat.drawer.colNumberingOff")}
                </span>
              </div>
              {format.headings.map((h, i) => (
                <button
                  key={i}
                  role="row"
                  className={`${styles.headRow} ${i === level ? styles.headRowActive : ""}`}
                  onClick={() => setLevel(i)}
                >
                  <span>H{i + 1}</span>
                  <span>{`${h.font.eastAsia} ${formatSize(h.sizePt)}`}</span>
                  <span>{h.bold ? t("common.yes", { defaultValue: "是" }) : t("common.no", { defaultValue: "否" })}</span>
                  <span>{t(`docxFormat.drawer.align_${h.align}`)}</span>
                  <span>{`${h.spaceBeforePt} / ${h.spaceAfterPt}`}</span>
                  {/* 「每章页码重来」开着时 H1 那一格写「分节」：核对表不能写「是」而文件里是另一回事
                      ——分节符自己分页，效果在、但走的不是这个字段（05h 1z · B5）。 */}
                  {i === 0 && format.headerFooter.restartEachChapter && format.headerFooter.pageNumber !== "none"
                    ? <span className={styles.cellDim}>{t("docxFormat.drawer.sectioned")}</span>
                    : <span>{h.pageBreakBefore ? t("common.yes", { defaultValue: "是" }) : t("common.no", { defaultValue: "否" })}</span>}
                  <span className={!numberingOn || numLevels[i] === "none" ? styles.cellDim : numConflicts.includes(i) ? styles.cellConflict : undefined}>
                    {numberingOn ? headingNumberSample(numLevels[i], i) : "—"}
                  </span>
                </button>
              ))}
            </div>
            <div className={styles.tableFoot}>{t("docxFormat.drawer.numberingFoot")}</div>
            {numConflicts.length > 0 && (
              <div className={`${styles.tableFoot} ${styles.tableFootNote}`}>
                {t("docxFormat.drawer.numberingConflictFoot", { levels: numConflicts.map((i) => `H${i + 1}`).join(" / ") })}
              </div>
            )}
            {/* 「不要手写序号」给一个反例：比回显重（一块常驻说明 + 一行真实后果），比警告轻（中性灰、
                无红、无 ⚠）。这里不做检测，也不替作者删——码里确实没有，稿子不许暗示有（05h 1z · A3）。 */}
            {numberingOn && (
              <div className={styles.onBlock}>
                <div className={styles.onBlockHead}>
                  <span className={styles.onBlockMark} />
                  <span className={styles.onBlockTitle}>{t("docxFormat.drawer.numberingOnTitle")}</span>
                </div>
                <div className={styles.onBlockText}>
                  {t("docxFormat.drawer.numberingOnText")}
                  <strong>{t("docxFormat.drawer.numberingOnStrong")}</strong>
                  {t("docxFormat.drawer.numberingOnText2")}
                </div>
                <div className={styles.onBlockExample}>
                  <span className={styles.onBlockExLabel}>{t("docxFormat.drawer.numberingExLabel")}</span>
                  <span className={styles.onBlockExText}>{exPrefix}{exRest}</span>
                  <span className={styles.onBlockArrow}>→</span>
                  <span className={styles.onBlockExText}>{exPrefix}<mark className={styles.onBlockDup}>{exPrefix}</mark>{exRest}</span>
                </div>
                <div className={styles.onBlockFoot}>{t("docxFormat.drawer.numberingOnFoot")}</div>
              </div>
            )}

            <div className={styles.levelPanel}>
              <div className={styles.levelPanelHead}>
                <span className={styles.levelBadge}>H{level + 1}</span>
                <span className={styles.levelHint}>{t("docxFormat.drawer.levelHint")}</span>
              </div>
              <FontField
                label={t("docxFormat.drawer.fontEastAsia")}
                value={format.headings[level].font.eastAsia}
                onChange={(v) => patchHeading(level, { font: { ...format.headings[level].font, eastAsia: v } })}
              />
              <Field label={t("docxFormat.drawer.size")}>
                <SizePicker value={format.headings[level].sizePt} onChange={(pt) => patchHeading(level, { sizePt: pt })} />
              </Field>
              <Field label={t("docxFormat.drawer.boldAlign")}>
                <Switch on={format.headings[level].bold} label={t("docxFormat.drawer.bold")}
                        onChange={(bold) => patchHeading(level, { bold })} />
                <AlignSeg value={format.headings[level].align} onChange={(align) => patchHeading(level, { align })} />
              </Field>
              <Field label={t("docxFormat.drawer.spacing")}>
                <Num value={format.headings[level].spaceBeforePt} unit={t("docxFormat.drawer.pt")} min={0} max={200}
                     onChange={(v) => patchHeading(level, { spaceBeforePt: v })} />
                <span className={styles.times}>/</span>
                <Num value={format.headings[level].spaceAfterPt} unit={t("docxFormat.drawer.pt")} min={0} max={200}
                     onChange={(v) => patchHeading(level, { spaceAfterPt: v })} />
              </Field>
              <Field label={t("docxFormat.drawer.pageBreak")}>
                <Switch on={!!format.headings[level].pageBreakBefore} label={t("docxFormat.drawer.pageBreak")}
                        onChange={(v) => patchHeading(level, { pageBreakBefore: v })} />
                <span className={styles.echo}>
                  {level === 0 && format.headerFooter.restartEachChapter && format.headerFooter.pageNumber !== "none"
                    ? t("docxFormat.drawer.pageBreakSectioned")
                    : t("docxFormat.drawer.pageBreakHint")}
                </span>
              </Field>
              {/* 下拉项就是样例本身：写法名认不出来，样子一眼就认得；回显那一列＝表里的那一格。 */}
              {numberingOn && (
                <Field label={t("docxFormat.drawer.colNumbering")}>
                  <select
                    className={styles.select}
                    value={format.headingNumbering.levels[level]}
                    onChange={(e) => {
                      const levels = [...format.headingNumbering.levels] as DocFormat["headingNumbering"]["levels"];
                      levels[level] = e.target.value as HeadingNumberFormat;
                      patch({ headingNumbering: { ...format.headingNumbering, levels } });
                    }}
                  >
                    {/* 含上级的写法和它之上的中文计数互斥：选不了的项灰掉，旁边的 mono 说为什么。 */}
                    {HEADING_NUMBER_FORMATS.map((k) => (
                      <option key={k} value={k} disabled={numberingPickBlocked(numLevels, level, k) !== null}>
                        {headingNumberSample(k, level)}
                      </option>
                    ))}
                  </select>
                  <span className={`${styles.echo} ${numEcho(level).warm ? styles.echoWarm : ""}`}>{numEcho(level).text}</span>
                </Field>
              )}
            </div>

            {/* ── 其他块 ─────────────────────────────────────────────── */}
            <GroupHead label={t("docxFormat.drawer.groupBlocks")} summary={t("docxFormat.drawer.blocksHint")} />
            <Field label={t("docxFormat.drawer.quote")}>
              <Num value={format.quote.indentChars} unit={t("docxFormat.drawer.chars")} min={0} max={10} step={0.5}
                   onChange={(v) => patch({ quote: { ...format.quote, indentChars: v } })} />
              <Switch on={format.quote.italic} label={t("docxFormat.drawer.italic")}
                      onChange={(italic) => patch({ quote: { ...format.quote, italic } })} />
              <span className={styles.echo}>{t("docxFormat.drawer.italic")}</span>
            </Field>
            <Field label={t("docxFormat.drawer.code")}>
              <input
                className={styles.textInput}
                value={format.code.fontAscii}
                onChange={(e) => patch({ code: { ...format.code, fontAscii: e.target.value } })}
                aria-label={t("docxFormat.drawer.code")}
              />
              <Num value={format.code.sizePt} unit={t("docxFormat.drawer.pt")} min={5} max={72} step={0.5}
                   onChange={(v) => patch({ code: { ...format.code, sizePt: v } })} />
              <Switch on={format.code.shaded} label={t("docxFormat.drawer.shaded")}
                      onChange={(shaded) => patch({ code: { ...format.code, shaded } })} />
              <span className={styles.echo}>{t("docxFormat.drawer.shaded")}</span>
            </Field>
            <Field label={t("docxFormat.drawer.listIndent")}>
              <Num value={format.list.indentChars} unit={t("docxFormat.drawer.chars")} min={0} max={10} step={0.5}
                   onChange={(v) => patch({ list: { indentChars: v } })} />
              <span className={styles.echo}>{t("docxFormat.drawer.listIndentHint")}</span>
            </Field>
            <Field label={t("docxFormat.drawer.table")}>
              <Switch on={format.table.borders} label={t("docxFormat.drawer.borders")}
                      onChange={(borders) => patch({ table: { ...format.table, borders } })} />
              <span className={styles.echo}>{t("docxFormat.drawer.borders")}</span>
              <Switch on={format.table.headerBold} label={t("docxFormat.drawer.headerBold")}
                      onChange={(headerBold) => patch({ table: { ...format.table, headerBold } })} />
              <span className={styles.echo}>{t("docxFormat.drawer.headerBold")}</span>
              <Switch on={format.table.repeatHeader} label={t("docxFormat.drawer.repeatHeader")}
                      onChange={(repeatHeader) => patch({ table: { ...format.table, repeatHeader } })} />
              <span className={styles.echo}>{t("docxFormat.drawer.repeatHeader")}</span>
            </Field>

            {/* ── 页眉页脚 ───────────────────────────────────────────── */}
            {/* 空态摘要就是「留空就一行都不写进文件」那句话——它只在空态成立，就只在空态出现；
                字段级的两处（占位「留空＝不写页眉」、下拉第一项「不写页码」）是值本身，留着（05h 1z · B2）。 */}
            <GroupHead
              label={t("docxFormat.drawer.groupHeader")}
              summary={hfEmpty ? t("docxFormat.drawer.headerEmptySummary") : headerFooterSummary(format, t)}
            />
            <Field label={t("docxFormat.drawer.headerText")}>
              <input
                className={styles.textInput}
                value={format.headerFooter.headerText}
                placeholder={t("docxFormat.drawer.headerTextPlaceholder")}
                onChange={(e) => patch({ headerFooter: { ...format.headerFooter, headerText: e.target.value } })}
                aria-label={t("docxFormat.drawer.headerText")}
              />
              {format.headerFooter.headerText.trim() && (
                <Seg
                  value={format.headerFooter.headerAlign}
                  options={HF_ALIGNS.map((a) => ({ value: a, label: t(`docxFormat.drawer.align_${a}`) }))}
                  onChange={(v) => patch({ headerFooter: { ...format.headerFooter, headerAlign: v as Align } })}
                />
              )}
            </Field>
            <Field label={t("docxFormat.drawer.pageNumber")}>
              <div className={styles.stack}>
                <div className={styles.stackRow}>
                  <select
                    className={styles.select}
                    value={format.headerFooter.pageNumber}
                    onChange={(e) => patch({ headerFooter: { ...format.headerFooter, pageNumber: e.target.value as PageNumberStyle } })}
                  >
                    {PAGE_NUMBER_STYLES.map((k) => (
                      <option key={k} value={k}>{t(`docxFormat.drawer.pn_${k}`)}</option>
                    ))}
                  </select>
                  {hasPn && (
                    <Seg
                      value={format.headerFooter.pageNumberAlign}
                      options={HF_ALIGNS.map((a) => ({ value: a, label: t(`docxFormat.drawer.align_${a}`) }))}
                      onChange={(v) => patch({ headerFooter: { ...format.headerFooter, pageNumberAlign: v as Align } })}
                    />
                  )}
                </div>
                {/* 一个字段一个值：左 / 中 / 右仍只有一个选中态；互换那条规则写在段下，只在「奇偶页不同」
                    开着时出现——它是那个开关的结果，不是对齐的第二套值（05h 1z · B4）。 */}
                {hasPn && format.headerFooter.differentOddEven && (
                  <div className={styles.oddEvenEcho}>
                    {t("docxFormat.drawer.oddEvenEcho", {
                      odd: t(`docxFormat.drawer.align_${format.headerFooter.pageNumberAlign}`),
                      even: t(`docxFormat.drawer.align_${mirrorAlign(format.headerFooter.pageNumberAlign)}`),
                    })}
                    <span className={styles.oddEvenCenter}>{t("docxFormat.drawer.oddEvenCenter")}</span>
                  </div>
                )}
              </div>
            </Field>
            <Field label={t("docxFormat.drawer.headerRule")}>
              <Switch
                on={format.headerFooter.headerRule}
                label={t("docxFormat.drawer.headerRule")}
                onChange={(headerRule) => patch({ headerFooter: { ...format.headerFooter, headerRule } })}
              />
              <span className={styles.echo}>{t("docxFormat.drawer.headerRuleHint")}</span>
            </Field>
            {/* 三行依赖字段不消失：虚线开关 + 次级标签 + 一句「先设页码」。作者会在没设页码时找「首页不同」
                ——公文的甲方就是这么说的；三行都不见，他无从知道这一组能做这三件事（05h 1z · B1）。 */}
            <Field label={t("docxFormat.drawer.oddEven")} dim={!hasPn}>
              <Switch
                on={format.headerFooter.differentOddEven}
                label={t("docxFormat.drawer.oddEven")}
                disabled={!hasPn}
                onChange={(differentOddEven) => patch({ headerFooter: { ...format.headerFooter, differentOddEven } })}
              />
              <span className={styles.echo}>{hasPn ? t("docxFormat.drawer.oddEvenHint") : t("docxFormat.drawer.needPageNumber")}</span>
            </Field>
            <Field label={t("docxFormat.drawer.firstPage")} dim={!hasAny}>
              <Switch
                on={format.headerFooter.differentFirstPage}
                label={t("docxFormat.drawer.firstPage")}
                disabled={!hasAny}
                onChange={(differentFirstPage) => patch({ headerFooter: { ...format.headerFooter, differentFirstPage } })}
              />
              <span className={styles.echo}>{hasAny ? t("docxFormat.drawer.firstPageHint") : t("docxFormat.drawer.needAny")}</span>
            </Field>
            <Field label={t("docxFormat.drawer.restartChapter")} dim={!hasPn}>
              <Switch
                on={format.headerFooter.restartEachChapter}
                label={t("docxFormat.drawer.restartChapter")}
                disabled={!hasPn}
                onChange={(restartEachChapter) => patch({ headerFooter: { ...format.headerFooter, restartEachChapter } })}
              />
              <span className={styles.echo}>{hasPn ? t("docxFormat.drawer.restartChapterHint") : t("docxFormat.drawer.needPageNumber")}</span>
            </Field>
          </div>

          <div className={styles.drawerPreview}>
            <div className={styles.previewHead}>
              <span className={styles.previewTitle}>{t("docxFormat.drawer.previewTitle")}</span>
              <span className={styles.echo}>{t("docxFormat.drawer.previewLive")}</span>
            </div>
            <PaperPreview format={format} compact />
            <div className={styles.drawerSummary}>
              <div>{`${format.page.size} · 上${format.page.margins.top} 右${format.page.margins.right} 下${format.page.margins.bottom} 左${format.page.margins.left}`}</div>
              <div>{t("docxFormat.drawer.regionLine", {
                w: round1(region.widthMm), h: round1(region.heightMm),
                grid: format.page.grid ? ` · ${format.page.grid.linesPerPage} × ${format.page.grid.charsPerLine}` : "",
              })}</div>
              <div>{`${formatSize(format.body.sizePt)} · ${format.body.line ? formatLineSpacing(format.body.line) : "—"}`}</div>
              <div>{`${round1(paper.widthMm)} × ${round1(paper.heightMm)} mm`}</div>
            </div>
          </div>
        </div>

        <div className={styles.drawerFoot}>
          <span className={styles.footHint}>{t("docxFormat.drawer.saveHint")}</span>
          <span className={styles.grow} />
          <button className={styles.ghostBtn} onClick={() => (dirty ? setConfirmDiscard(true) : onClose())}>
            {t("common.cancel", { defaultValue: "取消" })}
          </button>
          <button
            className={styles.primaryBtn}
            disabled={!label.trim()}
            onClick={() => onSave({ ...preset, label: label.trim(), builtin: false, format })}
          >
            {t("common.save", { defaultValue: "保存" })}
          </button>
        </div>

        {confirmDiscard && (
          <div className={styles.discard}>
            <div className={styles.discardText}>{t("docxFormat.drawer.discardAsk")}</div>
            <button className={styles.ghostBtn} onClick={() => setConfirmDiscard(false)}>
              {t("docxFormat.drawer.keepEditing")}
            </button>
            <button className={styles.dangerBtn} onClick={onClose}>{t("docxFormat.drawer.discard")}</button>
          </div>
        )}
      </div>
    </>
  );
}

// ─── 小控件 ───────────────────────────────────────────────────────────────────

function GroupHead({ label, summary }: { label: string; summary: string }) {
  return (
    <div className={styles.groupHead}>
      <span className={styles.groupHeadLabel}>{label}</span>
      {/* 分组标题旁挂一行等宽摘要，写法和列表里的完全一致——同一串数字在三个
          地方长得一样，作者才不用重新认一遍。 */}
      <span className={styles.groupHeadSummary}>{summary}</span>
    </div>
  );
}

function Field({ label, dim = false, children }: { label: string; dim?: boolean; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <span className={`${styles.fieldLabel} ${dim ? styles.fieldLabelDim : ""}`}>{label}</span>
      <div className={styles.fieldBody}>{children}</div>
    </div>
  );
}

/** 字体名输入 + 「本机未装」的中性提示。红色是留给错误的，这不是错误。 */
function FontField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const installed = useMemo(() => isFontInstalled(value), [value]);
  return (
    <>
      <Field label={label}>
        <input
          className={styles.textInput}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
        />
      </Field>
      {!installed && value.trim() && (
        <div className={styles.fontNote}>{t("docxFormat.drawer.fontMissingNote", { font: value })}</div>
      )}
    </>
  );
}

/** 一个数值用哪种写法显示：有号数就显示号数，没有就显示磅。 */
function sizeDisplay(pt: number): string {
  const named = CN_SIZES.find(([, p]) => p === pt);
  return named ? named[0] : String(pt);
}

/**
 * 字号：一个框，两种写法（设计稿 05e 屏 1e）。输入框接受号数也接受磅值——甲方要求写
 * 「三号」还是写「16」都能直接照抄；另一种写法永远在框内右侧回显（灰色、不可编辑）。
 * 没有对应号数的磅值是允许的，不是错（回显「磅 · 无对应号数」）。号数表折在框尾的
 * 小箭头后面，两种写法并列、等宽对齐。
 */
function SizePicker({ value, onChange }: { value: number; onChange: (pt: number) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(sizeDisplay(value));
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!editing) setDraft(sizeDisplay(value)); }, [value, editing]);

  const parsed = parseSize(draft);
  const typedName = CN_SIZES.some(([name]) => name === draft.trim());
  const named = parsed !== null ? CN_SIZES.find(([, pt]) => pt === parsed) : undefined;
  const echo = parsed === null
    ? ""
    : typedName
      ? t("docxFormat.drawer.echoPt", { pt: parsed })
      : named
        ? t("docxFormat.drawer.echoName", { name: named[0] })
        : t("docxFormat.drawer.echoNoName");

  const commit = () => {
    setEditing(false);
    // 解析失败退回原值，不静默取默认——同 format.ts 那条纪律。
    if (parsed === null) { setDraft(sizeDisplay(value)); return; }
    if (parsed !== value) onChange(parsed);
  };

  return (
    <span className={styles.sizeWrap}>
      <input
        className={styles.sizeInput}
        value={draft}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setOpen(false); }}
        aria-label={t("docxFormat.drawer.size")}
      />
      <span className={styles.sizeEcho}>{echo}</span>
      <button
        type="button"
        className={styles.sizeToggle}
        onClick={() => setOpen((v) => !v)}
        aria-label={t("docxFormat.drawer.sizeTable")}
        aria-expanded={open}
      >
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className={styles.sizeTable} role="listbox">
          {CN_SIZES.map(([name, pt]) => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={pt === value}
              className={`${styles.sizeRow} ${pt === value ? styles.sizeRowOn : ""}`}
              onClick={() => { onChange(pt); setOpen(false); }}
            >
              <span>{name}</span>
              <span className={styles.sizeRowPt}>{`${pt} ${t("docxFormat.drawer.pt")}`}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** 行距：三态永远同时可见——固定值 / 最小值 / 倍数混了是打印出来才发现的错。 */
function LinePicker({ value, onChange }: { value?: LineSpacing; onChange: (v: LineSpacing) => void }) {
  const { t } = useTranslation();
  const current: LineSpacing = value ?? { rule: "auto", value: 1 };
  return (
    <>
      <Seg
        value={current.rule}
        options={(["exact", "atLeast", "auto"] as LineRule[]).map((rule) => ({
          value: rule,
          label: t(`docxFormat.drawer.line_${rule}`),
        }))}
        onChange={(rule) =>
          onChange({
            rule: rule as LineRule,
            // 换模式时数值也要换个量纲：28 磅变成 28 倍会画出一页空白。
            value: rule === "auto" ? 1.5 : Math.max(1, Math.round(current.value * (current.rule === "auto" ? 12 : 1))),
          })
        }
      />
      <Num
        value={current.value}
        unit={current.rule === "auto" ? t("docxFormat.drawer.times") : t("docxFormat.drawer.pt")}
        min={current.rule === "auto" ? 0.5 : 1}
        max={current.rule === "auto" ? 10 : 400}
        step={current.rule === "auto" ? 0.05 : 0.5}
        onChange={(v) => onChange({ ...current, value: v })}
      />
      <span className={styles.echo}>＝ {formatLineSpacing(current)}</span>
    </>
  );
}

function AlignSeg({ value, onChange }: { value: Align; onChange: (v: Align) => void }) {
  const { t } = useTranslation();
  return (
    <Seg
      value={value}
      options={(["left", "center", "right", "justify"] as Align[]).map((a) => ({
        value: a,
        label: t(`docxFormat.drawer.align_${a}`),
      }))}
      onChange={(v) => onChange(v as Align)}
    />
  );
}

function Seg({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className={styles.seg} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          className={`${styles.segBtn} ${o.value === value ? styles.segBtnOn : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 数字 + 单位。空串不当 0 处理——中途清空输入框不该把值打到 0。 */
function Num({
  value,
  unit,
  min,
  max,
  step = 1,
  onChange,
}: {
  value: number;
  unit: string;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(String(value)); }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const n = Number(draft);
    if (!Number.isFinite(n)) { setDraft(String(value)); return; }
    const clamped = Math.min(max, Math.max(min, n));
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <span className={styles.numWrap}>
      <input
        className={styles.numInput}
        inputMode="decimal"
        value={draft}
        step={step}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        // 边打边夹会把 "4096" 的第一个数字变成 min，剩下的没地方去——所以
        // 在 blur 时才夹（同 GeneralPane 的长边输入框）。
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      />
      <span className={styles.numUnit}>{unit}</span>
    </span>
  );
}

/** 禁用＝虚线边、透明底：05c 的方言，未设是虚线，不是不见。 */
function Switch({ on, label, disabled = false, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`${styles.switch} ${on && !disabled ? styles.switchOn : ""} ${disabled ? styles.switchDashed : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className={styles.switchKnob} />
    </button>
  );
}

/** 页眉与页码只有左 / 中 / 右——两端对齐对一行页码没有意义。 */
const HF_ALIGNS: Align[] = ["left", "center", "right"];

/** 奇偶页互换：左右对调、居中不动——和 write.ts 里的 mirror 是同一条规则。 */
function mirrorAlign(a: Align): Align {
  return a === "left" ? "right" : a === "right" ? "left" : a;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

function headerFooterSummary(format: DocFormat, t: (k: string) => string): string {
  const hf = format.headerFooter;
  const parts: string[] = [];
  if (hf.headerText.trim()) parts.push(`${t("docxFormat.drawer.headerText")} ${hf.headerText}`);
  parts.push(hf.pageNumber === "none" ? t("docxFormat.drawer.pn_none") : t(`docxFormat.drawer.pn_${hf.pageNumber}`));
  if (hf.pageNumber !== "none" && hf.differentOddEven) parts.push(t("docxFormat.drawer.oddEven"));
  if (hf.headerRule) parts.push(t("docxFormat.drawer.headerRule"));
  if (hf.differentFirstPage) parts.push(t("docxFormat.drawer.firstPage"));
  if (hf.restartEachChapter) parts.push(t("docxFormat.drawer.restartChapter"));
  return parts.join(" · ");
}
