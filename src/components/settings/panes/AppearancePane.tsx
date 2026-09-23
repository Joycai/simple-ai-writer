/**
 * 设置 → 外观 (设计稿 05m)：应用外壳的颜色、正文字体、文档排版。
 *
 * These used to be one section of 通用 and had grown to most of that page —
 * mode, one or two bands of appearance cards, four font cards, seven
 * typography cards and a row of file actions — pushing language, notices,
 * debugging, maintenance and reset below the fold. Here each axis is its own
 * section (外观主题 · 字体方案 · Markdown 排版主题 · 主题文件), with the
 * 「此刻」 window on top: the only place the three are seen stacked, which
 * is how they meet while writing. Cards, bands and the three broken-theme
 * states are 05i's and live in `AppearanceThemes.tsx`.
 */
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FONT_PACK_FALLBACK, useAppStore, type ThemeMode, type FontScheme } from "../../../stores/appStore";
import { FONT_PACK_LICENSE, isFontPackId, type FontPackId } from "../../../lib/theme/fontPacks";
import { FontPackCard } from "./FontPackCard";
import { Pane, PaneHeader, Section, Row } from "./bits";
import {
  AppearanceThemeGrid, MarkdownThemeGrid, MdThemeCount, NowSpecimen, ThemeFiles, UiThemeCount,
  type AppearanceAxis,
} from "./AppearanceThemes";
import ui from "../settingsUi.module.css";
import a from "./Appearance.module.css";
import bands from "./ThemeCards.module.css";

const MODES: { value: ThemeMode; labelKey: string }[] = [
  { value: "light", labelKey: "settings.light" },
  { value: "dark", labelKey: "settings.dark" },
  { value: "system", labelKey: "settings.system" },
];

// Preview stack per scheme mirrors the --font-serif override in tokens.css,
// so each option renders in the body font it selects.
const SYSTEM_FONTS: { value: FontScheme; labelKey: string; previewFont: string }[] = [
  { value: "manuscript", labelKey: "systemSettings.appearance.fontManuscript", previewFont: '"Spectral", Georgia, "Songti SC", "Noto Serif CJK SC", serif' },
  { value: "song", labelKey: "systemSettings.appearance.fontSong", previewFont: 'Georgia, Cambria, "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", STSong, SimSun, serif' },
  { value: "hei", labelKey: "systemSettings.appearance.fontHei", previewFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif' },
  { value: "kai", labelKey: "systemSettings.appearance.fontKai", previewFont: '"Iowan Old Style", Georgia, "Kaiti SC", STKaiti, KaiTi, "Noto Serif CJK SC", serif' },
];

// Downloaded on first pick (设计稿 05n). The family leads, then 黑's stack — the
// same stack tokens.css gives the scheme, so an absent pack's card draws the
// fallback it will really fall to.
const HEI_STACK = SYSTEM_FONTS[2].previewFont;
const PACK_FONTS: { value: FontPackId; labelKey: string; previewFont: string }[] = [
  { value: "harmonyos", labelKey: "systemSettings.appearance.fontHarmonyos", previewFont: `"HarmonyOS Sans SC", ${HEI_STACK}` },
  { value: "misans", labelKey: "systemSettings.appearance.fontMisans", previewFont: `"MiSans", ${HEI_STACK}` },
];
const ALL_FONTS = [...SYSTEM_FONTS, ...PACK_FONTS];
const labelKeyOf = (scheme: FontScheme) => (ALL_FONTS.find((f) => f.value === scheme) ?? SYSTEM_FONTS[0]).labelKey;

export function AppearancePane() {
  const { t } = useTranslation();
  const { theme, setTheme, fontScheme, setFontScheme } = useAppStore();
  const chosenPack = useAppStore((st) => (isFontPackId(st.fontScheme) ? st.fontPacks[st.fontScheme].status : null));
  const refs = {
    ui: useRef<HTMLDivElement>(null),
    font: useRef<HTMLDivElement>(null),
    md: useRef<HTMLDivElement>(null),
  };

  const jump = (axis: AppearanceAxis) => {
    // 显式 behavior 会压过 global.css 的 `scroll-behavior: auto !important`（方案 051）。
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    refs[axis].current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  };

  // 「此刻」 draws the glyphs actually in use — while a pack isn't here that is
  // the fallback, and the caption says so rather than naming a font not shown.
  const chosenName = t(labelKeyOf(fontScheme));
  const fontName =
    chosenPack === "downloading" ? t("systemSettings.appearance.nowFontPending", { name: chosenName })
    : chosenPack === "absent" || chosenPack === "error" ? t("systemSettings.appearance.nowFontMissing", { name: chosenName })
    : chosenName;

  return (
    <Pane>
      <PaneHeader title={t("systemSettings.tabs.appearance")} sub={t("systemSettings.appearance.paneSub")} />

      <NowSpecimen fontName={fontName} onJump={jump} />

      <div ref={refs.ui} className={a.anchor}>
        <Section label={t("systemSettings.appearance.uiThemeLabel")} action={<UiThemeCount />}>
          {/* 明暗 decides whether one band grows below or two (05i A1), so it
              is this section's first row rather than a section of its own.
              Three mutually exclusive options: a segmented control, not a
              chip row, which reads as tags one could pick several of. */}
          <Row title={t("systemSettings.appearance.modeLabel")} desc={t("systemSettings.appearance.modeHint")}>
            <div className={a.seg} role="radiogroup" aria-label={t("systemSettings.appearance.modeLabel")}>
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={theme === m.value}
                  className={`${a.segBtn} ${theme === m.value ? a.segOn : ""}`}
                  onClick={() => setTheme(m.value)}
                >
                  {t(m.labelKey)}
                </button>
              ))}
            </div>
          </Row>
          <AppearanceThemeGrid />
        </Section>
      </div>

      <div ref={refs.font} className={a.anchor}>
        <Section
          label={t("systemSettings.appearance.fontLabel")}
          action={<span className={bands.tag}>{t("systemSettings.appearance.fontCount", { count: ALL_FONTS.length })}</span>}
        >
          <div className={`${ui.rowStacked} ${ui.rowLast}`}>
            <div className={ui.rowDesc}>{t("systemSettings.appearance.fontHint")}</div>
            {/* Two bands (05n): the system faces pick instantly; the packs
                download the first time — different behaviour, said by the band head. */}
            <div className={a.fontBands}>
              <div className={bands.bandHead}>
                <span>{t("systemSettings.appearance.fontBandSystem")}</span>
                <span className={bands.bandRule} />
                <span className={bands.bandCurrent}>{t("systemSettings.appearance.fontBandSystemNote")}</span>
              </div>
              <div className={`${ui.cardGrid} ${ui.cardGridFont}`}>
                {SYSTEM_FONTS.map((f) => (
                  <button
                    key={f.value}
                    className={`${ui.card} ${ui.fontCard} ${fontScheme === f.value ? ui.cardActive : ""}`}
                    onClick={() => setFontScheme(f.value)}
                  >
                    <span className={ui.fontSample} style={{ fontFamily: f.previewFont }}>文字 Aa</span>
                    {/* A line at body size: 「文字 Aa」 shows the glyphs, not the grey a paragraph makes. */}
                    <span className={a.fontLine} style={{ fontFamily: f.previewFont }}>
                      {t("systemSettings.appearance.fontSampleLine")}
                    </span>
                    <span className={ui.cardName}>{t(f.labelKey)}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className={a.fontBands}>
              <div className={bands.bandHead}>
                <span>{t("systemSettings.appearance.fontBandPack")}</span>
                <span className={bands.bandRule} />
                <span className={bands.bandCurrent}>{t("systemSettings.appearance.fontBandPackNote")}</span>
              </div>
              <div className={`${ui.cardGrid} ${ui.cardGridFont} ${a.packGrid}`}>
                {PACK_FONTS.map((f) => (
                  <FontPackCard
                    key={f.value}
                    id={f.value}
                    labelKey={f.labelKey}
                    previewFont={f.previewFont}
                    fallbackLabelKey={labelKeyOf(FONT_PACK_FALLBACK)}
                  />
                ))}
                <div className={a.packLicense}>
                  {t("systemSettings.appearance.fontPackLicense")}
                  <div className={a.packCredit}>{t("systemSettings.appearance.fontPackCredit")}</div>
                  <div className={a.packLinks}>
                    {PACK_FONTS.map((f) => (
                      <button
                        key={f.value}
                        type="button"
                        className={a.packLink}
                        onClick={() => { openUrl(FONT_PACK_LICENSE[f.value]).catch(() => { /* best-effort */ }); }}
                      >
                        {t("systemSettings.appearance.fontPackLicenseLink", { name: t(f.labelKey) })}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Section>
      </div>

      <div ref={refs.md} className={a.anchor}>
        <Section label={t("systemSettings.appearance.mdThemeLabel")} action={<MdThemeCount />}>
          <MarkdownThemeGrid />
        </Section>
      </div>

      <Section label={t("systemSettings.appearance.filesSection")}>
        <ThemeFiles />
      </Section>
    </Pane>
  );
}
