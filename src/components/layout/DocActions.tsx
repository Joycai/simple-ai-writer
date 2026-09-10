/**
 * 顶栏的**文档段**：跟着当前文档走的那几件（设计稿 01e）。
 *
 * 两条规矩管着这里的一切：
 *
 * 1. **谁在场由扩展名决定，不在场就不渲染**（表 B / `lib/fs/docKind`）。灰掉一件
 *    点不动的东西，等于让作者在每一类文件上都读一遍同样的名单。图片没有视图切换，
 *    `.docx` 没有字数——它们各自的空位换成真有产出的那一件（转换文档 / 用默认应用
 *    打开），而不是留白。
 * 2. **窄了让位，但绝不压变形**（表 A）：这里每一件都是 `nowrap` + `flex-shrink:0`，
 *    整条顶栏里唯一让宽的是面包屑。中文标签被压到字宽以下会逐字折行成「编 辑」，
 *    那是这条 strip 唯一不能出的错。档位切换靠容器查询，两种成色都渲染出来、由
 *    CSS 藏掉一种——查询能换布局，换不了词（`docs/reference/design-system.md`）。
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Printer } from "lucide-react";
import { ContextMenu, type ContextMenuEntry } from "../common/ContextMenu";
import { ExportMenu } from "./ExportMenu";
import { useProjectStore } from "../../stores/projectStore";
import { useEditorStore, type ViewMode } from "../../stores/editorStore";
import { isTextKind, type DocKind } from "../../lib/fs/docKind";
import { openWithDefaultApp } from "../../lib/fs/fileio";
import { printHtmlDocument } from "../../lib/fs/export";
import { convertProjectFile } from "../../lib/import";
import { baseName, dirName } from "../../lib/paths";
import styles from "./TitleBar.module.css";

const VIEW_MODES: ViewMode[] = ["editor", "split", "preview"];

/** How long a failed action's word stays on its own button. */
const FEEDBACK_MS = 2000;

export function DocActions({ kind, path }: { kind: DocKind; path: string }) {
  const { t } = useTranslation();
  const viewMode = useEditorStore((s) => s.viewMode);
  const setViewMode = useEditorStore((s) => s.setViewMode);
  const isDirty = useEditorStore((s) => s.isDirty);
  const wordCount = useProjectStore((s) => s.wordCount);
  const charCount = useProjectStore((s) => s.charCount);
  const imageSize = useProjectStore((s) => s.imageSize);
  const [viewMenuAt, setViewMenuAt] = useState<{ x: number; y: number } | null>(null);

  const editable = kind === "markdown" || kind === "html";
  // The size belongs to this picture only — ImagePreview reports it with the
  // path it decoded, and a mismatch means the new file hasn't decoded yet.
  const dims = imageSize && imageSize.path === path ? imageSize : null;

  const viewItems: ContextMenuEntry[] = VIEW_MODES.map((m) => ({
    kind: "item",
    label: t(`editor.viewMode.${m}`),
    action: () => setViewMode(m),
  }));

  return (
    <>
      {editable && (
        <>
          {/* 宽 / 中：三格连体，当前档实底赭石——作者一眼看见在哪一档。 */}
          <div className={`${styles.viewToggle} ${styles.notNarrow}`}>
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
          {/* 窄：收成一格下拉，留的那一格仍是当前档、仍是实底赭石（表 A ④）。 */}
          <button
            className={`${styles.viewPick} ${styles.narrowOnly}`}
            title={`${t("editor.view")} · ${t(`editor.viewMode.${viewMode}`)}`}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setViewMenuAt({ x: r.left, y: r.bottom + 4 });
            }}
          >
            {t(`editor.viewMode.${viewMode}`)}
            <ChevronDown size={9} strokeWidth={2} />
          </button>
          {viewMenuAt && (
            <ContextMenu
              x={viewMenuAt.x}
              y={viewMenuAt.y}
              items={viewItems}
              onClose={() => setViewMenuAt(null)}
            />
          )}
        </>
      )}

      {kind === "markdown" && <ExportMenu />}
      {kind === "html" && <PrintHtmlButton path={path} />}

      {kind === "image" && dims && (
        <>
          <span className={styles.dims}>{dims.width} × {dims.height}</span>
          <span className={styles.sepThin} />
        </>
      )}
      {kind === "convertible" && <ConvertButton path={path} />}
      {!editable && (
        <button
          className={styles.ctrl}
          onClick={() => {
            openWithDefaultApp(path).catch((e) =>
              console.error("[TitleBar] open with default app failed:", e),
            );
          }}
          title={t("titleBar.openExternal")}
        >
          {/* 窄档也不收成图标（表 A 的「永不动」一行）：这两件只出现在没有视图切换
              的那几类文件上，那一档右侧本来就空着。 */}
          {t("titleBar.openExternal")}
        </button>
      )}

      {isTextKind(kind) && (
        <>
          <span className={styles.sepThin} />
          <span className={styles.wordCount}>
            {/* HTML 报的是源码字符数——它没有「正文」，但这个数说的确实是屏幕上
                那份文件（表 B）。窄档去掉单位只留 mono 数字（表 A ⑦）。 */}
            <strong>{(kind === "html" ? charCount : wordCount).toLocaleString()}</strong>
            {/* 单位词而不是 `statusBar.words`（那是「字数」/「Words」，一个**栏目
                名**）——顶栏这里读的是「3,124 字」。 */}
            <span className={styles.notNarrow}>
              {" "}{kind === "html" ? t("titleBar.chars") : t("titleBar.words")}
            </span>
          </span>
          <span className={styles.saveState} title={isDirty ? t("titleBar.saving") : t("titleBar.saved")}>
            <span className={`${styles.saveDot} ${isDirty ? styles.saveDotDirty : styles.saveDotSaved}`} />
            <span className={styles.wideOnly}>{isDirty ? t("titleBar.saving") : t("titleBar.saved")}</span>
          </span>
        </>
      )}
    </>
  );
}

/**
 * `.html` 的唯一导出：打印这一页（表 B）。
 *
 * 三条导出里只有它对一份 HTML 交付稿成立——另外两条都会把页面源码交给 Markdown
 * 渲染器再渲染一遍。**只剩一项时不做菜单**：按钮直接叫那一项，不带 ▾。
 */
function PrintHtmlButton({ path }: { path: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const run = async () => {
    // 读的是编辑器缓冲区，不是磁盘：作者刚改的那几行也要出现在打印稿上。
    const { content, filePath } = useEditorStore.getState();
    if (filePath !== path) return;
    try {
      await printHtmlDocument(content, (baseName(path) || "document").replace(/\.html?$/i, ""), dirName(path));
    } catch (e) {
      setStatus(t("editor.exportFailed", { message: e instanceof Error ? e.message : String(e) }));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setStatus(null), FEEDBACK_MS);
    }
  };

  return (
    <button className={styles.ctrl} onClick={() => void run()} title={t("editor.printHtml")}>
      {status ?? (
        <>
          <span className={styles.notNarrow}>{t("editor.printHtml")}</span>
          <Printer size={13} className={styles.narrowOnly} />
        </>
      )}
    </button>
  );
}

/**
 * `docx / xlsx / pdf / pptx` 这一类里唯一有产出的动作，所以它是这条上唯一一件
 * 赭石字的文档动作（表 B）。文件树右键里的「转换文档」还在——顶栏是第二个入口，
 * 不是搬家；两边走的是同一个 `convertProjectFile`。
 */
function ConvertButton({ path }: { path: string }) {
  const { t } = useTranslation();
  const refreshFileTree = useProjectStore((s) => s.refreshFileTree);
  const setActiveFilePath = useProjectStore((s) => s.setActiveFilePath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const target = await convertProjectFile(path);
      await refreshFileTree();
      // 成功不留痕迹：转出来的那一篇立刻成为当前文档，面包屑自己就把话说了。
      setActiveFilePath(target);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setError(null), FEEDBACK_MS);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      className={`${styles.ctrl} ${error ? "" : styles.ctrlAccent}`}
      onClick={() => void run()}
      disabled={busy}
      // 失败时短标签在按钮上、整句在 tooltip 里：48px 的一条横杠放不下一句话，
      // 而作者需要知道的是「哪一步失败了」，不是「失败了」。
      title={error ?? t("fileTree.convertDoc")}
    >
      {error
        ? t("titleBar.convertFailed")
        : busy
          ? t("titleBar.converting")
          : t("fileTree.convertDoc")}
    </button>
  );
}
