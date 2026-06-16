import { useTranslation } from "react-i18next";
import { Moon, Sun, Monitor, Settings } from "lucide-react";
import { useAppStore, type ThemeMode, type Language } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import styles from "./StatusBar.module.css";

const THEMES: { value: ThemeMode; labelKey: string }[] = [
  { value: "dark", labelKey: "settings.dark" },
  { value: "light", labelKey: "settings.light" },
  { value: "system", labelKey: "settings.system" },
];

const LANGUAGES: { value: Language; labelKey: string }[] = [
  { value: "zh-CN", labelKey: "language.chinese" },
  { value: "en", labelKey: "language.english" },
];

interface Props {
  onOpenSettings: () => void;
}

export function StatusBar({ onOpenSettings }: Props) {
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
        {theme === "dark" ? <Moon size={13} /> : theme === "light" ? <Sun size={13} /> : <Monitor size={13} />}
        {t(`settings.${theme}`)}
      </button>

      <button className={styles.control} onClick={cycleLanguage} title={t("settings.language")}>
        {t(LANGUAGES.find((l) => l.value === language)?.labelKey || "language.english")}
      </button>

      <button className={styles.control} onClick={onOpenSettings} title={t("settings.aiConfig")}>
        <Settings size={13} />
        {t("settings.aiConfig")}
      </button>
    </div>
  );
}
