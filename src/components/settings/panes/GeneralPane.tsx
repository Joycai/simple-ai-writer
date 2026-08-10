import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Moon, Sun, Monitor, FolderOpen, FileDown, FileUp } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAiStore } from "../../../stores/aiStore";
import { useAppStore, type ThemeMode, type Language, type FontScheme } from "../../../stores/appStore";
import { MARKDOWN_THEMES } from "../../../lib/theme/markdownThemes";
import { isApiLogEnabled, setApiLogEnabled, getApiLogRevealTarget } from "../../../lib/ai/apiLog";
import { applyConfigImport, exportAiConfig, stageConfigImport } from "../../../lib/ai/configTransfer";
import styles from "../settingsCommon.module.css";

const THEMES: { value: ThemeMode; icon: React.ReactNode; labelKey: string }[] = [
  { value: "dark", icon: <Moon size={14} />, labelKey: "settings.dark" },
  { value: "light", icon: <Sun size={14} />, labelKey: "settings.light" },
  { value: "system", icon: <Monitor size={14} />, labelKey: "settings.system" },
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
    <div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t("systemSettings.general.appearance")}</div>
        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("systemSettings.general.themeLabel")}</label>
          <div className={styles.optionGroup}>
            {THEMES.map((th) => (
              <button
                key={th.value}
                className={`${styles.optionBtn} ${theme === th.value ? styles.optionBtnActive : ""}`}
                onClick={() => setTheme(th.value)}
              >
                {th.icon}
                {t(th.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("systemSettings.general.fontLabel")}</label>
          <div className={styles.safetyHint}>{t("systemSettings.general.fontHint")}</div>
          <div className={styles.fontGrid}>
            {FONT_SCHEMES.map((f) => (
              <button
                key={f.value}
                className={`${styles.fontCard} ${fontScheme === f.value ? styles.fontCardActive : ""}`}
                onClick={() => setFontScheme(f.value)}
              >
                <span className={styles.fontSample} style={{ fontFamily: f.previewFont }}>{f.sample}</span>
                <span className={styles.fontName}>{t(f.labelKey)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("systemSettings.general.mdThemeLabel")}</label>
          <div className={styles.safetyHint}>{t("systemSettings.general.mdThemeHint")}</div>
          <div className={styles.mdThemeGrid}>
            {MARKDOWN_THEMES.map((mt) => (
              <button
                key={mt.id}
                className={`${styles.mdThemeCard} ${markdownTheme === mt.id ? styles.mdThemeCardActive : ""}`}
                onClick={() => setMarkdownTheme(mt.id)}
              >
                {/* data-md-theme pins the sample to this card's theme, whatever
                    the app-wide setting currently is. */}
                <div className={`${styles.mdThemeSample} md-body`} data-md-theme={mt.id} aria-hidden>
                  <h2>{isZh ? "标题" : "Heading"}</h2>
                  <p>{isZh ? "正文示例，字体与间距如此。" : "Body text, set in this theme."}</p>
                </div>
                <div className={styles.mdThemeName}>{isZh ? mt.label.zh : mt.label.en}</div>
                <div className={styles.mdThemeDesc}>{isZh ? mt.desc.zh : mt.desc.en}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t("systemSettings.general.languageSection")}</div>
        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("systemSettings.general.languageLabel")}</label>
          <div className={styles.optionGroup}>
            {LANGUAGES.map((lang) => (
              <button
                key={lang.value}
                className={`${styles.optionBtn} ${language === lang.value ? styles.optionBtnActive : ""}`}
                onClick={() => setLanguage(lang.value)}
              >
                {lang.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t("systemSettings.general.debugSection")}</div>
        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("systemSettings.general.apiLogLabel")}</label>
          <div className={styles.safetyHint}>{t("systemSettings.general.apiLogHint")}</div>
          <div className={styles.debugControls}>
            <div className={styles.optionGroup}>
              <button
                className={`${styles.optionBtn} ${apiLogOn ? styles.optionBtnActive : ""}`}
                onClick={() => toggleApiLog(true)}
              >
                {t("systemSettings.general.apiLogOn")}
              </button>
              <button
                className={`${styles.optionBtn} ${!apiLogOn ? styles.optionBtnActive : ""}`}
                onClick={() => toggleApiLog(false)}
              >
                {t("systemSettings.general.apiLogOff")}
              </button>
            </div>
            <button className={`${styles.btnSecondary} ${styles.btnWithIcon}`} onClick={openApiLogs}>
              <FolderOpen size={14} /> {t("systemSettings.general.openApiLogs")}
            </button>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>{t("systemSettings.backup.section")}</div>
        <div className={styles.fieldGroup}>
          <div className={styles.safetyHint}>{t("systemSettings.backup.hint")}</div>
          <div className={styles.debugControls}>
            <button
              className={`${styles.btnSecondary} ${styles.btnWithIcon}`}
              onClick={handleExportConfig}
              disabled={backupBusy}
            >
              <FileDown size={14} /> {t("systemSettings.backup.export")}
            </button>
            <button
              className={`${styles.btnSecondary} ${styles.btnWithIcon}`}
              onClick={handleImportConfig}
              disabled={backupBusy}
            >
              <FileUp size={14} /> {t("systemSettings.backup.import")}
            </button>
          </div>
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.label}>{t("systemSettings.backup.keysLabel")}</label>
          <div className={styles.safetyHint}>{t("systemSettings.backup.keysHint")}</div>
          <div className={styles.optionGroup}>
            <button
              className={`${styles.optionBtn} ${!includeKeys ? styles.optionBtnActive : ""}`}
              onClick={() => setIncludeKeys(false)}
            >
              {t("systemSettings.backup.keysOff")}
            </button>
            <button
              className={`${styles.optionBtn} ${includeKeys ? styles.optionBtnActive : ""}`}
              onClick={() => setIncludeKeys(true)}
            >
              {t("systemSettings.backup.keysOn")}
            </button>
          </div>
        </div>
        {backupStatus && (
          <div className={backupStatus.ok ? styles.safetyHint : styles.errorNote}>
            {backupStatus.text}
          </div>
        )}
      </div>
    </div>
  );
}
