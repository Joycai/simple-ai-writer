import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { useAppStore, type ThemeMode, type Language } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import { useEditorStore, type ViewMode } from "../../stores/editorStore";
import { MOD_K } from "../../lib/platform";
import { ExportMenu } from "./ExportMenu";
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

/**
 * The 卷 level of the breadcrumb: the document's parent folder inside
 * `writing/`, when there is one. Purely presentational — derived from the
 * path, so grouping documents differently needs no store change here.
 */
function volumeOf(p: string | null): string | null {
  if (!p) return null;
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  const w = parts.lastIndexOf("writing");
  // parts between writing/ and the file itself; only show the innermost.
  if (w === -1 || parts.length - w <= 2) return null;
  return parts[parts.length - 2];
}

export function TitleBar() {
  const { t } = useTranslation();
  const {
    theme, setTheme, language, setLanguage,
    setShowAiDrawer,
  } = useAppStore();
  const { projectPath, activeFilePath, wordCount } = useProjectStore();
  const { isDirty, viewMode, setViewMode } = useEditorStore();

  const projectName = basename(projectPath) ?? t("titleBar.noProject");
  const fileName = basename(activeFilePath)?.replace(/\.md$/i, "") ?? null;
  const volumeName = volumeOf(activeFilePath);

  const cycleTheme = () => {
    const idx = THEME_ORDER.indexOf(theme);
    setTheme(THEME_ORDER[(idx + 1) % THEME_ORDER.length]);
  };
  const cycleLang = () => {
    const idx = LANG_ORDER.indexOf(language);
    setLanguage(LANG_ORDER[(idx + 1) % LANG_ORDER.length]);
  };

  return (
    <div className={styles.bar}>
      <div className={styles.traffic}>
        <span className={styles.trafficDot} />
        <span className={styles.trafficDot} />
        <span className={styles.trafficDot} />
      </div>
      <span className={styles.sep} />
      <span className={styles.brandIcon}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M12 2 L22 8 L12 14 L2 8 Z M2 16 L12 22 L22 16" />
        </svg>
      </span>
      <div className={styles.crumb}>
        <span className={fileName ? styles.crumbMid : styles.crumbCurrent}>{projectName}</span>
        {volumeName && (
          <>
            <span className={styles.crumbSlash}>/</span>
            <span className={styles.crumbMid}>{volumeName}</span>
          </>
        )}
        {fileName && (
          <>
            <span className={styles.crumbSlash}>/</span>
            <span className={styles.crumbCurrent}>{fileName}</span>
            {isDirty && <span className={styles.crumbState}>{t("titleBar.modified")}</span>}
          </>
        )}
      </div>

      <div className={styles.spacer} />

      <div className={styles.right}>
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

        {/* Document-scoped, so it sits with the view toggle's audience rather
            than the app-wide controls — and hides itself when nothing is open. */}
        <ExportMenu />

        <span className={styles.sepThin} />

        <button className={styles.ctrl} onClick={cycleTheme} title={t("titleBar.themeCycle")}>
          {t(`settings.${theme}`)}
        </button>
        <button className={styles.ctrl} onClick={cycleLang} title={t("settings.language")}>
          {language === "zh-CN" ? t("language.chinese") : t("language.english")}
        </button>

        {projectPath && (
          <>
            <span className={styles.sepThin} />
            <span className={styles.wordCount}>
              <strong>{wordCount.toLocaleString()}</strong> {t("statusBar.words")}
            </span>
            <span className={styles.sepThin} />
            <span className={styles.saveState}>
              <span className={`${styles.saveDot} ${isDirty ? styles.saveDotDirty : styles.saveDotSaved}`} />
              {isDirty ? t("titleBar.modified") : t("titleBar.saved")}
            </span>
          </>
        )}

        <span className={styles.sepThin} />

        {/* No mode passed: the generic summon button reopens the drawer on
            whatever tab was last used. */}
        <button
          className={styles.aiBtn}
          onClick={() => setShowAiDrawer(true)}
          title={t("titleBar.summonAi")}
        >
          <Sparkles size={11} />
          AI · {MOD_K}
        </button>
      </div>
    </div>
  );
}
