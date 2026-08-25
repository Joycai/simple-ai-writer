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
import { X } from "lucide-react";
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
            <GroupHead label={t("docxFormat.drawer.groupHeadings")} summary={t("docxFormat.drawer.headingsHint")} />
            <div className={styles.headTable} role="table">
              <div className={styles.headRowHead} role="row">
                <span>{t("docxFormat.drawer.colLevel")}</span>
                <span>{t("docxFormat.drawer.colFont")}</span>
                <span>{t("docxFormat.drawer.colBold")}</span>
                <span>{t("docxFormat.drawer.colAlign")}</span>
                <span>{t("docxFormat.drawer.colSpacing")}</span>
                <span>{t("docxFormat.drawer.colBreak")}</span>
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
                  <span>{h.pageBreakBefore ? t("common.yes", { defaultValue: "是" }) : t("common.no", { defaultValue: "否" })}</span>
                </button>
              ))}
            </div>

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
                <span className={styles.echo}>{t("docxFormat.drawer.pageBreakHint")}</span>
              </Field>
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

            {/* ── 页眉页脚（三期） ───────────────────────────────────── */}
            <GroupHead label={t("docxFormat.drawer.groupHeader")} summary={t("docxFormat.drawer.phaseThree")} />
            <div className={styles.laterNote}>{t("docxFormat.drawer.headerLater")}</div>
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
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

/** 号数下拉 + 磅数回显。作者手上的规格用哪种写法都有可能，所以两种都要在。 */
function SizePicker({ value, onChange }: { value: number; onChange: (pt: number) => void }) {
  const { t } = useTranslation();
  const named = CN_SIZES.find(([, pt]) => pt === value);
  return (
    <>
      <select
        className={styles.select}
        value={named ? named[0] : "__custom"}
        onChange={(e) => {
          const pt = parseSize(e.target.value);
          if (pt !== null) onChange(pt);
        }}
      >
        {!named && <option value="__custom">{t("docxFormat.drawer.customSize")}</option>}
        {CN_SIZES.map(([name, pt]) => (
          <option key={name} value={name}>{`${name}（${pt} 磅）`}</option>
        ))}
      </select>
      <Num value={value} unit={t("docxFormat.drawer.pt")} min={1} max={200} step={0.5} onChange={onChange} />
    </>
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

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`${styles.switch} ${on ? styles.switchOn : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      <span className={styles.switchKnob} />
    </button>
  );
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
