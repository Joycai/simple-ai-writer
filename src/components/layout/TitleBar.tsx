import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { useAppStore, type ThemeMode, type Language } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import { useEditorStore, type ViewMode } from "../../stores/editorStore";
import { IS_TAURI, MOD_K } from "../../lib/platform";
import { ExportMenu } from "./ExportMenu";
import { useWindowControls } from "./useWindowControls";
import styles from "./TitleBar.module.css";
import { baseName, toPosixPath } from "../../lib/paths";

const THEME_ORDER: ThemeMode[] = ["dark", "light", "system"];
const LANG_ORDER: Language[] = ["zh-CN", "en"];
const VIEW_MODES: ViewMode[] = ["editor", "split", "preview"];

function basename(p: string | null): string | null {
  return p ? baseName(p) || null : null;
}

/**
 * The 卷 level of the breadcrumb: the document's parent folder inside the
 * workspace, when there is one (a file at the workspace root has none). Purely
 * presentational — derived from the path, so grouping documents differently
 * needs no store change here.
 */
function volumeOf(p: string | null, projectPath: string | null): string | null {
  if (!p || !projectPath) return null;
  const parts = toPosixPath(p).split("/").filter(Boolean);
  const rootDepth = toPosixPath(projectPath).split("/").filter(Boolean).length;
  // parts between the workspace root and the file itself; only the innermost.
  if (parts.length - rootDepth <= 1) return null;
  return parts[parts.length - 2];
}

export function TitleBar() {
  const { t } = useTranslation();
  // Field selectors: this bar shows the live word count, so it re-renders per
  // keystroke by design — but it must not also re-render on every unrelated
  // appStore / editorStore / projectStore write (panel widths, editor content).
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const setShowAiDrawer = useAppStore((s) => s.setShowAiDrawer);
  const projectPath = useProjectStore((s) => s.projectPath);
  const activeFilePath = useProjectStore((s) => s.activeFilePath);
  const wordCount = useProjectStore((s) => s.wordCount);
  const isDirty = useEditorStore((s) => s.isDirty);
  const viewMode = useEditorStore((s) => s.viewMode);
  const setViewMode = useEditorStore((s) => s.setViewMode);
  const chrome = useWindowControls();

  const projectName = basename(projectPath) ?? t("titleBar.noProject");
  const fileName = basename(activeFilePath)?.replace(/\.md$/i, "") ?? null;
  const volumeName = volumeOf(activeFilePath, projectPath);

  const cycleTheme = () => {
    const idx = THEME_ORDER.indexOf(theme);
    setTheme(THEME_ORDER[(idx + 1) % THEME_ORDER.length]);
  };
  const cycleLang = () => {
    const idx = LANG_ORDER.indexOf(language);
    setLanguage(LANG_ORDER[(idx + 1) % LANG_ORDER.length]);
  };

  return (
    <div
      className={`${styles.bar} ${chrome.showCaptionButtons ? styles.barCaptions : ""}`}
      data-tauri-drag-region
    >
      {/* Left edge, one of three chromes:
          mac in Tauri  — blank inset under the native traffic lights (Overlay);
          browser (dev) — the decorative dots of 设计稿 01;
          undecorated   — nothing, caption buttons live on the right instead. */}
      {chrome.macInset ? (
        <div className={styles.macInset} data-tauri-drag-region />
      ) : !IS_TAURI ? (
        <>
          <div className={styles.traffic}>
            <span className={styles.trafficDot} />
            <span className={styles.trafficDot} />
            <span className={styles.trafficDot} />
          </div>
          <span className={styles.sep} />
        </>
      ) : null}
      <span className={styles.brandIcon}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M12 2 L22 8 L12 14 L2 8 Z M2 16 L12 22 L22 16" />
        </svg>
      </span>
      <div className={styles.crumb} data-tauri-drag-region>
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

      <div className={styles.spacer} data-tauri-drag-region />

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

      {/* Undecorated Windows: our own caption buttons, Segoe-style strokes.
          Order and semantics follow the OS: minimize / maximize-restore / close. */}
      {chrome.showCaptionButtons && (
        <div className={styles.captions}>
          <button
            className={styles.captionBtn}
            onClick={chrome.minimize}
            aria-label={t("titleBar.minimize")}
            title={t("titleBar.minimize")}
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M0 5 H10" stroke="currentColor" strokeWidth="1" fill="none" />
            </svg>
          </button>
          <button
            className={styles.captionBtn}
            onClick={chrome.toggleMaximize}
            aria-label={t(chrome.isMaximized ? "titleBar.restore" : "titleBar.maximize")}
            title={t(chrome.isMaximized ? "titleBar.restore" : "titleBar.maximize")}
          >
            {chrome.isMaximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="none" />
                <path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5" stroke="currentColor" strokeWidth="1" fill="none" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" />
              </svg>
            )}
          </button>
          <button
            className={`${styles.captionBtn} ${styles.captionClose}`}
            onClick={chrome.close}
            aria-label={t("titleBar.close")}
            title={t("titleBar.close")}
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" strokeWidth="1" fill="none" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
