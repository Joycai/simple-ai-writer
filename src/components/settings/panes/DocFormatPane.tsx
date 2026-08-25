/**
 * 设置 → 排版格式（Beta）。
 *
 * 这一页的性质是**规格核对表，不是主题选择器**（设计稿 1a 的第一句话）。作者
 * 手上有一份甲方给的格式要求，他要做的是逐条核对，所以数字排第一：每一处字号
 * 同时写号数与磅、行距同时写模式与数值、中西文字体是两个字段、数字列一律等宽。
 *
 * 两个**正交**的状态，都要能同时成立（设计稿 1d）：
 * - 「以后自动用哪一个」＝ 默认，一枚全列唯一的实心圆点 + 一枚「默认」标签；
 * - 「我现在在看哪一个」＝ 选中，一片淡染 + 左侧一条竖线。
 * 把选中也画成强调色实心，作者就会以为自己刚刚改了默认。
 *
 * 一期只有内置预设和「设为默认」。新建 / 编辑 / 从 Word 文件读取格式在二期，
 * 所以这一页现在**不摆那两个按钮**——一个点了没反应的按钮比没有更糟。
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pane, PaneHeader } from "./bits";
import { PaperPreview } from "./PaperPreview";
import { useDocFormatStore } from "../../../stores/docFormatStore";
import {
  bodyRegionMm,
  eastAsiaFontsOf,
  formatLineSpacing,
  formatOneLine,
  formatSize,
  PAGE_SIZES,
  type DocFormatPreset,
} from "../../../lib/docx/format";
import { missingFonts } from "../../../lib/docx/fontCheck";
import ui from "../settingsUi.module.css";
import styles from "./DocFormat.module.css";

const MM_PER_PT = 25.4 / 72;

export function DocFormatPane() {
  const { t } = useTranslation();
  const presets = useDocFormatStore((s) => s.presets);
  const defaultId = useDocFormatStore((s) => s.defaultId);
  const selectedId = useDocFormatStore((s) => s.selectedId);
  const setDefault = useDocFormatStore((s) => s.setDefault);
  const select = useDocFormatStore((s) => s.select);

  const selected = presets.find((p) => p.id === selectedId) ?? presets[0];
  const builtin = presets.filter((p) => p.builtin);
  const custom = presets.filter((p) => !p.builtin);

  return (
    <Pane width="wide">
      <PaneHeader
        title={t("docxFormat.title")}
        sub={t("docxFormat.sub")}
        action={<span className={styles.betaTag}>BETA</span>}
      />

      <div className={styles.split}>
        <div className={styles.listCol}>
          <div className={styles.listHead}>
            <span className={styles.radioCol}>{t("docxFormat.defaultCol")}</span>
            <span className={styles.listHint}>{t("docxFormat.listHint", { count: presets.length })}</span>
          </div>

          <div className={styles.list}>
            <div className={styles.groupLabel}>{t("docxFormat.groupBuiltin")}</div>
            {builtin.map((p) => (
              <PresetRow
                key={p.id}
                preset={p}
                isDefault={p.id === defaultId}
                isSelected={p.id === selected?.id}
                onSelect={() => select(p.id)}
                onMakeDefault={() => setDefault(p.id)}
              />
            ))}

            <div className={styles.groupLabel}>{t("docxFormat.groupCustom")}</div>
            {custom.length === 0 ? (
              <div className={styles.emptyCustom}>{t("docxFormat.customEmpty")}</div>
            ) : (
              custom.map((p) => (
                <PresetRow
                  key={p.id}
                  preset={p}
                  isDefault={p.id === defaultId}
                  isSelected={p.id === selected?.id}
                  onSelect={() => select(p.id)}
                  onMakeDefault={() => setDefault(p.id)}
                />
              ))
            )}
          </div>
        </div>

        {selected && (
          <div className={styles.previewCol}>
            <div className={styles.previewHead}>
              <span className={styles.previewTitle}>{t("docxFormat.previewTitle", { name: selected.label })}</span>
              <span className={ui.spacer} />
              <span className={styles.schematicTag}>{t("docxFormat.schematicTag")}</span>
            </div>
            <PaperPreview format={selected.format} />
            <PageSpec preset={selected} />
          </div>
        )}
      </div>
    </Pane>
  );
}

function PresetRow({
  preset,
  isDefault,
  isSelected,
  onSelect,
  onMakeDefault,
}: {
  preset: DocFormatPreset;
  isDefault: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onMakeDefault: () => void;
}) {
  const { t } = useTranslation();
  // 每次渲染都问一遍不值当，但预设列表短、字体探测是同步的一次 check——放
  // memo 里是为了别在滚动时重复问，不是为了性能悬崖。
  const missing = useMemo(() => missingFonts(eastAsiaFontsOf(preset.format)), [preset]);

  return (
    <div
      className={`${styles.row} ${isSelected ? styles.rowSelected : ""}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); }
      }}
    >
      <div className={styles.radioCol}>
        <button
          className={`${styles.radio} ${isDefault ? styles.radioOn : ""}`}
          role="radio"
          aria-checked={isDefault}
          aria-label={t("docxFormat.makeDefault", { name: preset.label })}
          title={t("docxFormat.makeDefault", { name: preset.label })}
          onClick={(e) => { e.stopPropagation(); onMakeDefault(); }}
        />
      </div>
      <div className={styles.rowMain}>
        <div className={styles.rowTop}>
          <span className={styles.rowName}>{preset.label}</span>
          {isDefault && <span className={styles.defaultChip}>{t("docxFormat.defaultChip")}</span>}
          {preset.imitatedFrom && (
            <span className={styles.fromChip}>{t("docxFormat.readFrom", { file: preset.imitatedFrom })}</span>
          )}
          {/* 字体没装不是错误：文件仍然是对的，只是本机预览会替换。所以是一枚
              中性描边标签，绝不用红色。 */}
          {missing.length > 0 && (
            <span className={styles.missingChip}>{t("docxFormat.fontMissing", { font: missing[0] })}</span>
          )}
        </div>
        <div className={styles.rowSummary}>{formatOneLine(preset.format)}</div>
      </div>
    </div>
  );
}

/** 预览下面那张四行小表：纸张 / 页边距 / 版心 / 网格。 */
function PageSpec({ preset }: { preset: DocFormatPreset }) {
  const { t } = useTranslation();
  const f = preset.format;
  const size = PAGE_SIZES[f.page.size];
  const region = bodyRegionMm(f.page);
  const m = f.page.margins;

  // 网格和行距是两处独立声明的同一件事，对不上就是一个真问题——所以这里核一次。
  let gridNote: { ok: boolean; text: string } | null = null;
  if (f.page.grid) {
    const pitchPt = region.heightMm / f.page.grid.linesPerPage / MM_PER_PT;
    const declared = f.body.line;
    if (declared && declared.rule !== "auto") {
      const ok = Math.abs(pitchPt - declared.value) < 0.75;
      gridNote = {
        ok,
        text: ok
          ? t("docxFormat.gridAgrees", { size: formatSize(f.body.sizePt), line: formatLineSpacing(declared) })
          : t("docxFormat.gridDiffers", { pitch: pitchPt.toFixed(1), line: formatLineSpacing(declared) }),
      };
    }
  }

  return (
    <div className={styles.spec}>
      <span className={styles.specLabel}>{t("docxFormat.specPaper")}</span>
      <span className={styles.specValue}>{`${f.page.size} · ${size.widthMm} × ${size.heightMm} mm`}</span>
      <span className={styles.specLabel}>{t("docxFormat.specMargins")}</span>
      <span className={styles.specValue}>{`上 ${m.top} · 右 ${m.right} · 下 ${m.bottom} · 左 ${m.left} mm`}</span>
      <span className={styles.specLabel}>{t("docxFormat.specRegion")}</span>
      <span className={styles.specValue}>{`${round1(region.widthMm)} × ${round1(region.heightMm)} mm`}</span>
      <span className={styles.specLabel}>{t("docxFormat.specGrid")}</span>
      <span className={styles.specValue}>
        {f.page.grid
          ? t("docxFormat.gridValue", { lines: f.page.grid.linesPerPage, chars: f.page.grid.charsPerLine })
          : t("docxFormat.gridOff")}
        {gridNote && (
          <span className={gridNote.ok ? styles.gridOk : styles.gridWarn}> {gridNote.ok ? "✓" : "·"} {gridNote.text}</span>
        )}
      </span>
    </div>
  );
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
