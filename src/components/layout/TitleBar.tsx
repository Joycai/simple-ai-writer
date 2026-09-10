import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, MoreHorizontal, Sparkles } from "lucide-react";
import { useAppStore, type ThemeMode, type Language } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import { closeDocument, useEditorStore } from "../../stores/editorStore";
import { IS_TAURI, MOD_K } from "../../lib/platform";
import { CLOSE_DOC_COMBOS, combosLabel } from "../../lib/shortcuts";
import { docKindOf, isTextKind } from "../../lib/fs/docKind";
import { ContextMenu } from "../common/ContextMenu";
import { DocActions } from "./DocActions";
import { useWindowControls } from "./useWindowControls";
import styles from "./TitleBar.module.css";
import { baseName, toPosixPath } from "../../lib/paths";

const THEME_ORDER: ThemeMode[] = ["dark", "light", "system"];
const LANG_ORDER: Language[] = ["zh-CN", "en"];
/** 与 useGlobalShortcuts 派发的是同一份绑定；mac 上是两条（见 CLOSE_DOC_COMBOS）。 */
const CLOSE_KEY = combosLabel(CLOSE_DOC_COMBOS);

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
  const isDirty = useEditorStore((s) => s.isDirty);
  const closeNotice = useEditorStore((s) => s.closeNotice);
  const chrome = useWindowControls();
  const [moreAt, setMoreAt] = useState<{ x: number; y: number } | null>(null);

  const projectName = basename(projectPath) ?? t("titleBar.noProject");
  const fileName = basename(activeFilePath)?.replace(/\.md$/i, "") ?? null;
  const volumeName = volumeOf(activeFilePath, projectPath);
  /**
   * 打开的这个文件属于哪一类——文档段的整张名单都从它长出来（设计稿 01e 表 B）。
   *
   * 「已修改」跟着 `isTextKind`：它说的是**编辑器缓冲区**，而作者打开一张图片
   * （或任何编辑器读不出来的文件）时缓冲区有意停在上一篇文档上（AI 那一侧靠
   * `WritingFocus` 判断「还没就绪」）。不跟着分类走，这四个字就会挂在另一个文件
   * 的名字旁边。
   */
  const kind = activeFilePath ? docKindOf(activeFilePath) : null;
  const hasTextDoc = isTextKind(kind);

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
          browser (dev) — the decorative dots of 设计稿 01a;
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
      {/* 让位的量程就是这一格（设计稿 01e 表 A）：三档量的是顶栏**可用内容宽**，
          所以平台让位（mac 的 56px 红绿灯位、无边框 Windows 右端的 138px 三键）
          留在容器外面。按窗口宽判会让同一台机器上的两种边框形态在不同的窗口宽度
          上跳档。 */}
      <div className={styles.flow} data-tauri-drag-region>
        <div className={styles.crumb} data-tauri-drag-region>
          <span className={styles.brandIcon}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M12 2 L22 8 L12 14 L2 8 Z M2 16 L12 22 L22 16" />
            </svg>
          </span>
          <span className={fileName ? styles.crumbProject : styles.crumbCurrent}>{projectName}</span>
          {volumeName && (
            <span className={styles.wideOnly}>
              <span className={styles.crumbSlash}>/</span>
              <span className={styles.crumbMid}>{volumeName}</span>
            </span>
          )}
          {fileName && (
            <>
              <span className={styles.crumbSlash}>/</span>
              <span className={styles.crumbCurrent}>{fileName}</span>
              {isDirty && hasTextDoc && (
                <span className={`${styles.crumbState} ${styles.wideOnly}`}>{t("titleBar.modified")}</span>
              )}
              {/* 常驻，不是悬停才现身（屏 1e-1）：作者的问题是「没有地方关闭」，
                  藏起来等于没解决。⌘W 与文件树右键的「关闭」是同一个动作。 */}
              <button
                className={styles.closeBtn}
                onClick={() => void closeDocument()}
                title={`${t("titleBar.closeDoc")} · ${CLOSE_KEY}`}
                aria-label={t("titleBar.closeDoc")}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <path d="M1 1 L9 9 M9 1 L1 9" />
                </svg>
              </button>
            </>
          )}
          {/* 关掉一篇脏文档后原地留两秒（屏 1e-3）——和导出按钮变成「✓ 已复制」
              是同一种回执、同一个时长。干净文档关掉不留痕迹。 */}
          {closeNotice && (
            <span className={`${styles.crumbTrace} ${closeNotice.failed ? styles.crumbTraceFail : ""}`}>
              {closeNotice.failed ? <AlertTriangle size={11} /> : <Check size={11} />}
              {t(closeNotice.failed ? "titleBar.closeFailed" : "titleBar.closedTrace", {
                name: closeNotice.name,
              })}
            </span>
          )}
        </div>

        <div className={styles.right}>
          {/* 文档段：跟着当前文档走，按扩展名决定谁在场；关掉后整段消失。 */}
          {kind && activeFilePath && (
            <>
              <DocActions kind={kind} path={activeFilePath} />
              <span className={styles.sepThin} />
            </>
          )}

          {/* 全局段：右锚，永不动（除了窄档里前两件并进 ⋯）。 */}
          <button
            className={`${styles.ctrl} ${styles.notNarrow}`}
            onClick={cycleTheme}
            title={t("titleBar.themeCycle")}
          >
            {t(`settings.${theme}`)}
          </button>
          <button
            className={`${styles.ctrl} ${styles.notNarrow}`}
            onClick={cycleLang}
            title={t("settings.language")}
          >
            {language === "zh-CN" ? t("language.chinese") : t("language.english")}
          </button>

          <span className={`${styles.sepThin} ${styles.notNarrow}`} />

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

          <button
            className={`${styles.ctrl} ${styles.narrowOnly}`}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMoreAt({ x: r.left, y: r.bottom + 4 });
            }}
            title={`${t("settings.theme")} · ${t("settings.language")}`}
          >
            <MoreHorizontal size={14} />
          </button>
          {moreAt && (
            <ContextMenu
              x={moreAt.x}
              y={moreAt.y}
              items={[
                { kind: "item", label: `${t("settings.theme")} · ${t(`settings.${theme}`)}`, action: cycleTheme },
                {
                  kind: "item",
                  label: `${t("settings.language")} · ${language === "zh-CN" ? t("language.chinese") : t("language.english")}`,
                  action: cycleLang,
                },
              ]}
              onClose={() => setMoreAt(null)}
            />
          )}
        </div>
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
