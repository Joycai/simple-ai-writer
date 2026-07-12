import { useTranslation } from "react-i18next";
import { Moon, Sun, Monitor, Sparkles, Languages } from "lucide-react";
import { useAppStore, type ThemeMode, type Language } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import { useEditorStore, type ViewMode } from "../../stores/editorStore";
import { MOD_K } from "../../lib/platform";
import styles from "./TitleBar.module.css";

const THEME_ORDER: ThemeMode[] = ["dark", "light", "system"];
const LANG_ORDER: Language[] = ["zh-CN", "en"];
const VIEW_MODES: ViewMode[] = ["editor", "split", "preview"];

function basename(p: string | null): string | null {
  if (!p) return null;
  const norm = p.replace(/\\/g, "/");
  const tail = norm.split("/").filter(Boolean).pop();
  return tail ?? null;
}

export function TitleBar() {
  const { t } = useTranslation();
  const {
    theme, setTheme, language, setLanguage,
    setShowAiDrawer, setShowCommandPalette,
  } = useAppStore();
  const { projectPath, activeFilePath, wordCount } = useProjectStore();
  const { isDirty, viewMode, setViewMode } = useEditorStore();

  const projectName = basename(projectPath) ?? t("titleBar.noProject");
  const fileName = basename(activeFilePath)?.replace(/\.md$/i, "") ?? null;

  const cycleTheme = () => {
    const idx = THEME_ORDER.indexOf(theme);
    setTheme(THEME_ORDER[(idx + 1) % THEME_ORDER.length]);
  };
  const cycleLang = () => {
    const idx = LANG_ORDER.indexOf(language);
    setLanguage(LANG_ORDER[(idx + 1) % LANG_ORDER.length]);
  };

  const themeIcon =
    theme === "dark" ? <Moon size={12} /> :
    theme === "light" ? <Sun size={12} /> : <Monitor size={12} />;

  return (
    <div className={styles.bar}>
      <span className={styles.brandIcon}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M12 2 L22 8 L12 14 L2 8 Z M2 16 L12 22 L22 16" />
        </svg>
      </span>
      <div className={styles.crumb}>
        <span className={styles.crumbProject}>{projectName}</span>
        {fileName && (
          <>
            <span className={styles.crumbSlash}>/</span>
            <span className={styles.crumbChapter}>{fileName}</span>
            {isDirty && <span className={styles.crumbState}>{t("titleBar.modified")}</span>}
          </>
        )}
      </div>

      <div className={styles.spacer} />

      {activeFilePath && (
        <div className={styles.viewToggle}>
          {VIEW_MODES.map((m) => (
            <button
              key={m}
              className={`${styles.viewBtn} ${viewMode === m ? styles.viewBtnActive : ""}`}
              onClick={() => setViewMode(m)}
            >
              {t(`editor.viewMode.${m}`)}
            </button>
          ))}
        </div>
      )}

      <div className={styles.right}>
        {projectPath && (
          <>
            <span className={styles.wordCount}>
              <strong>{wordCount.toLocaleString()}</strong>{t("statusBar.words")}
            </span>
            <span className={styles.sep} />
            <span className={styles.saveState}>
              <span className={`${styles.saveDot} ${isDirty ? styles.saveDotDirty : styles.saveDotSaved}`} />
              {isDirty ? t("titleBar.modified") : t("titleBar.saved")}
            </span>
            <span className={styles.sep} />
          </>
        )}

        <button
          className={styles.aiBtn}
          onClick={() => setShowAiDrawer(true, "generate")}
          title={t("titleBar.summonAi")}
        >
          <Sparkles size={11} />
          {t("titleBar.summonAi")}
        </button>

        <button className={styles.ctrl} onClick={cycleTheme} title={t("settings.theme")}>
          {themeIcon}
          {t(`settings.${theme}`)}
        </button>
        <button className={styles.ctrl} onClick={cycleLang} title={t("settings.language")}>
          <Languages size={12} />
          {language === "zh-CN" ? t("language.chinese") : t("language.english")}
        </button>

        <button
          className={styles.ctrl}
          onClick={() => setShowCommandPalette(true)}
          title={MOD_K}
        >
          {MOD_K}
        </button>
      </div>
    </div>
  );
}
