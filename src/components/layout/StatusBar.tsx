import { useTranslation } from "react-i18next";
import { useAppStore, type ThemeMode, type Language } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import styles from "./StatusBar.module.css";

const THEMES: { value: ThemeMode; labelKey: string }[] = [
  { value: "dark", labelKey: "settings.dark" },
  { value: "light", labelKey: "settings.light" },
  { value: "system", labelKey: "settings.system" },
];

const LANGUAGES: { value: Language; label: string }[] = [
  { value: "zh-CN", label: "中文" },
  { value: "en", label: "EN" },
];

export function StatusBar() {
  const { t } = useTranslation();
  const { theme, setTheme, language, setLanguage } = useAppStore();
  const { projectPath, wordCount, charCount } = useProjectStore();

  const cycleTheme = () => {
    const idx = THEMES.findIndex((th) => th.value === theme);
    setTheme(THEMES[(idx + 1) % THEMES.length].value);
  };

  const cycleLanguage = () => {
    const idx = LANGUAGES.findIndex((l) => l.value === language);
    setLanguage(LANGUAGES[(idx + 1) % LANGUAGES.length].value);
  };

  return (
    <div className={styles.statusBar}>
      <div className={styles.item}>
        <span className={styles.accentDot} />
        {projectPath
          ? projectPath.split("/").pop()
          : t("statusBar.noProject")}
      </div>

      {projectPath && (
        <>
          <div className={styles.item}>
            {t("statusBar.words")}: <strong>{wordCount}</strong>
          </div>
          <div className={styles.item}>
            {t("statusBar.chars")}: <strong>{charCount}</strong>
          </div>
        </>
      )}

      <div className={styles.spacer} />

      <button className={styles.control} onClick={cycleTheme} title={t("settings.theme")}>
        {theme === "dark" ? "🌙" : theme === "light" ? "☀️" : "💻"}
        {t(`settings.${theme}`)}
      </button>

      <button className={styles.control} onClick={cycleLanguage} title={t("settings.language")}>
        {LANGUAGES.find((l) => l.value === language)?.label}
      </button>
    </div>
  );
}
