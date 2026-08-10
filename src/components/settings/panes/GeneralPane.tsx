import { useState } from "react";
import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAiStore } from "../../../stores/aiStore";
import { useAppStore, type ThemeMode, type Language, type FontScheme } from "../../../stores/appStore";
import { MARKDOWN_THEMES } from "../../../lib/theme/markdownThemes";
import { isApiLogEnabled, setApiLogEnabled, getApiLogRevealTarget } from "../../../lib/ai/apiLog";
import { applyConfigImport, exportAiConfig, stageConfigImport } from "../../../lib/ai/configTransfer";
import { Pane, PaneHeader, Section, Row, Chip, ChipRow, Toggle } from "./bits";
import ui from "../settingsUi.module.css";

const THEMES: { value: ThemeMode; labelKey: string }[] = [
  { value: "dark", labelKey: "settings.dark" },
  { value: "light", labelKey: "settings.light" },
  { value: "system", labelKey: "settings.system" },
];

const LANGUAGES: { value: Language; label: string }[] = [
  { value: "zh-CN", label: "中文" },
  { value: "en", label: "English" },
];

// Preview stack per scheme mirrors the --font-serif override in tokens.css,
// so each option renders in the body font it selects.
const FONT_SCHEMES: { value: FontScheme; labelKey: string; sample: string; previewFont: string }[] = [
  { value: "manuscript", labelKey: "systemSettings.general.fontManuscript", sample: "文字 Aa", previewFont: '"Spectral", Georgia, "Songti SC", "Noto Serif CJK SC", serif' },
  { value: "song", labelKey: "systemSettings.general.fontSong", sample: "文字 Aa", previewFont: 'Georgia, Cambria, "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", STSong, SimSun, serif' },
  { value: "hei", labelKey: "systemSettings.general.fontHei", sample: "文字 Aa", previewFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif' },
  { value: "kai", labelKey: "systemSettings.general.fontKai", sample: "文字 Aa", previewFont: '"Iowan Old Style", Georgia, "Kaiti SC", STKaiti, KaiTi, "Noto Serif CJK SC", serif' },
];

export function GeneralPane() {
  const { t, i18n: i18nInst } = useTranslation();
  const isZh = i18nInst.language.startsWith("zh");
  const { theme, setTheme, language, setLanguage, fontScheme, setFontScheme } = useAppStore();
  const markdownTheme = useAppStore((s) => s.markdownTheme);
  const setMarkdownTheme = useAppStore((s) => s.setMarkdownTheme);
  const [apiLogOn, setApiLogOn] = useState(isApiLogEnabled());
  const providers = useAiStore((s) => s.providers);
  const loadConfig = useAiStore((s) => s.loadConfig);
  const [includeKeys, setIncludeKeys] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupStatus, setBackupStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const toggleApiLog = (enabled: boolean) => {
    setApiLogEnabled(enabled);
    setApiLogOn(enabled);
  };

  const openApiLogs = async () => {
    try {
      await revealItemInDir(await getApiLogRevealTarget());
    } catch { /* best-effort */ }
  };

  const handleExportConfig = async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupStatus(null);
    try {
      const saved = await exportAiConfig(includeKeys);
      if (saved) setBackupStatus({ ok: true, text: t("systemSettings.backup.exported", { path: saved }) });
    } catch (e) {
      setBackupStatus({ ok: false, text: `${t("systemSettings.backup.exportFailed")} ${e}` });
    } finally {
      setBackupBusy(false);
    }
  };

  const handleImportConfig = async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupStatus(null);
    try {
      const staged = await stageConfigImport(providers.map((p) => p.id));
      if (!staged) return;
      let confirmMsg = t("systemSettings.backup.importConfirm", {
        providers: staged.providers.length,
        models: staged.models.length,
        prompts: staged.prompts.length,
      });
      if (staged.keyCount > 0) {
        confirmMsg += `\n${t("systemSettings.backup.importKeysNote", { count: staged.keyCount })}`;
      }
      if (staged.prefs.length > 0) {
        confirmMsg += `\n${t("systemSettings.backup.importPrefsNote", { count: staged.prefs.length })}`;
      }
      if (!window.confirm(confirmMsg)) return;
      await applyConfigImport(staged);
      await loadConfig();
      // Imported preferences are in the store but not yet on screen.
      useAppStore.getState().reloadFromPrefs();
      setBackupStatus({ ok: true, text: t("systemSettings.backup.imported") });
    } catch (e) {
      const invalid = e instanceof Error && e.message === "invalid-backup";
      setBackupStatus({
        ok: false,
        text: invalid ? t("systemSettings.backup.invalidFile") : `${t("systemSettings.backup.importFailed")} ${e}`,
      });
    } finally {
      setBackupBusy(false);
    }
  };

  return (
    <Pane>
      <PaneHeader title={t("systemSettings.tabs.general")} sub={t("systemSettings.general.paneSub")} />

      <Section label={t("systemSettings.general.appearance")}>
        <Row title={t("systemSettings.general.themeLabel")}>
          <ChipRow>
            {THEMES.map((th) => (
              <Chip key={th.value} label={t(th.labelKey)} active={theme === th.value} onClick={() => setTheme(th.value)} />
            ))}
          </ChipRow>
        </Row>

        <div className={ui.rowStacked}>
          <div className={ui.rowTitle}>{t("systemSettings.general.fontLabel")}</div>
          <div className={ui.rowDesc}>{t("systemSettings.general.fontHint")}</div>
          <div className={`${ui.cardGrid} ${ui.cardGridFont}`}>
            {FONT_SCHEMES.map((f) => (
              <button
                key={f.value}
                className={`${ui.card} ${ui.fontCard} ${fontScheme === f.value ? ui.cardActive : ""}`}
                onClick={() => setFontScheme(f.value)}
              >
                <span className={ui.fontSample} style={{ fontFamily: f.previewFont }}>{f.sample}</span>
                <span className={ui.cardName}>{t(f.labelKey)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={`${ui.rowStacked} ${ui.rowLast}`}>
          <div className={ui.rowTitle}>{t("systemSettings.general.mdThemeLabel")}</div>
          <div className={ui.rowDesc}>{t("systemSettings.general.mdThemeHint")}</div>
          <div className={`${ui.cardGrid} ${ui.cardGridWide}`}>
            {MARKDOWN_THEMES.map((mt) => (
              <button
                key={mt.id}
                className={`${ui.card} ${markdownTheme === mt.id ? ui.cardActive : ""}`}
                onClick={() => setMarkdownTheme(mt.id)}
              >
                {/* A real md-body sample, pinned by data-md-theme to this card's
                    theme whatever the app-wide setting currently is. */}
                <div className={`${ui.mdSample} md-body`} data-md-theme={mt.id} aria-hidden>
                  <h2>{isZh ? "标题" : "Heading"}</h2>
                  <p>{isZh ? "正文示例，字体与间距如此。" : "Body text, set in this theme."}</p>
                </div>
                <div className={ui.cardName}>{isZh ? mt.label.zh : mt.label.en}</div>
                <div className={ui.cardDesc}>{isZh ? mt.desc.zh : mt.desc.en}</div>
              </button>
            ))}
          </div>
        </div>
      </Section>

      <Section label={t("systemSettings.general.languageSection")}>
        <Row title={t("systemSettings.general.languageLabel")} last>
          <ChipRow>
            {LANGUAGES.map((lang) => (
              <Chip key={lang.value} label={lang.label} active={language === lang.value} onClick={() => setLanguage(lang.value)} />
            ))}
          </ChipRow>
        </Row>
      </Section>

      <Section label={t("systemSettings.general.debugSection")}>
        <Row
          title={t("systemSettings.general.apiLogLabel")}
          desc={t("systemSettings.general.apiLogHint")}
          last={!apiLogOn}
        >
          <Toggle on={apiLogOn} onChange={toggleApiLog} label={t("systemSettings.general.apiLogLabel")} />
        </Row>
        {/* Only worth offering once there is something in that folder. */}
        {apiLogOn && (
          <Row desc={t("systemSettings.general.apiLogLocation")} last>
            <button className={ui.rowBtn} onClick={openApiLogs}>
              {t("systemSettings.general.openApiLogs")}
            </button>
          </Row>
        )}
      </Section>

      <Section label={t("systemSettings.backup.section")}>
        <Row title={t("systemSettings.backup.transferLabel")} desc={t("systemSettings.backup.hint")}>
          <button className={ui.rowBtn} onClick={handleExportConfig} disabled={backupBusy}>
            {t("systemSettings.backup.export")}
          </button>
          <button className={ui.rowBtn} onClick={handleImportConfig} disabled={backupBusy}>
            {t("systemSettings.backup.import")}
          </button>
        </Row>
        <Row
          title={t("systemSettings.backup.keysLabel")}
          desc={t("systemSettings.backup.keysHint")}
          warn={includeKeys ? t("systemSettings.backup.keysWarn") : undefined}
          last
        >
          <ChipRow>
            <Chip label={t("systemSettings.backup.keysOff")} active={!includeKeys} onClick={() => setIncludeKeys(false)} />
            <Chip label={t("systemSettings.backup.keysOn")} active={includeKeys} onClick={() => setIncludeKeys(true)} />
          </ChipRow>
        </Row>
        {backupStatus && (
          <div className={backupStatus.ok ? ui.statusOk : ui.statusError}>{backupStatus.text}</div>
        )}
      </Section>
    </Pane>
  );
}
