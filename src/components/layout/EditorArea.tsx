import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useProjectStore, useTerms } from "../../stores/projectStore";
import { useEditorStore } from "../../stores/editorStore";
import { CodeEditor } from "../editor/CodeEditor";
import { EditorScrollNav } from "../editor/EditorScrollNav";
import { Preview } from "../editor/Preview";
import { ImagePreview } from "../editor/ImagePreview";
import { HtmlPreview } from "../editor/HtmlPreview";
import { EditorBottomStrip } from "./EditorBottomStrip";
import { MOD_KEY } from "../../lib/platform";
import { isHtmlPath, isImagePath } from "../../lib/fs/images";
import { linkScrollers } from "../../lib/editor/scrollSync";
import styles from "./EditorArea.module.css";

export function EditorArea() {
  const { t } = useTranslation();
  const { projectPath, activeFilePath } = useProjectStore();
  const { content, filePath, loadError, viewMode, editorView, loadFile, setContent } = useEditorStore();
  const setShowCommandPalette = useAppStore((s) => s.setShowCommandPalette);
  const terms = useTerms();

  const isImage = !!activeFilePath && isImagePath(activeFilePath);
  // Third file kind: edited as text like markdown, but previewed in a
  // sandboxed iframe (HtmlPreview) instead of the markdown renderer.
  const isHtml = !!activeFilePath && isHtmlPath(activeFilePath);

  const previewPaneRef = useRef<HTMLDivElement>(null);

  // Split view: keep editor and preview scrolled to the same relative position.
  // Neither pane is the scrolling element — CodeMirror scrolls on .cm-scroller
  // inside it, and the preview scrolls on its own root — so the link binds to
  // those two.
  //
  // The editor's scroller comes from `editorView.scrollDOM` rather than a
  // querySelector, and editorView is a dependency, because CodeEditor builds
  // the view in its own effect. Reaching into the DOM at one instant meant that
  // if the scroller wasn't there yet (or was later replaced) the effect hit its
  // early return, gave up silently, and never retried — nothing in the old
  // dependency list changes when a view appears. Keying on the view instead
  // makes the link rebuild exactly when its target does.
  useEffect(() => {
    // isHtml excluded: the preview there is an iframe whose inner scroll
    // position is out of the parent's reach — there is nothing to link.
    if (viewMode !== "split" || !activeFilePath || isImage || isHtml) return;
    const editor = editorView?.scrollDOM;
    const preview = previewPaneRef.current?.querySelector<HTMLElement>("[data-preview-scroller]");
    if (!editor || !preview) return;
    return linkScrollers(editor, preview);
  }, [viewMode, activeFilePath, isImage, isHtml, editorView]);

  // Load file when active path changes. Images are rendered directly (see below),
  // so we must NOT read them as text — that would fill the editor with binary
  // garbage and risk overwriting the image on autosave.
  useEffect(() => {
    if (activeFilePath && !isImage && activeFilePath !== filePath) {
      loadFile(activeFilePath);
    }
  }, [activeFilePath, isImage, filePath, loadFile]);

  if (!projectPath || !activeFilePath) {
    return (
      <div className={styles.area}>
        <div className={styles.empty}>
          <div className={styles.emptyInner}>
            <div className={styles.emptyEyebrow}>{terms.emptyEyebrow}</div>
            <h1 className={styles.emptyTitle}>{t("empty.firstLine")}</h1>
            <div className={styles.emptyOrnament}>{t("empty.ornament")}</div>
            <p className={styles.emptyHint}>{t("empty.hint1")}</p>
            <p className={styles.emptyHint}>{t("empty.hint2")}</p>

            <div className={styles.emptyCta}>
              <span className={styles.emptyCtaText}>{t("empty.dontKnow")}</span>
              <button
                className={styles.emptyCtaBtn}
                onClick={() => setShowCommandPalette(true)}
              >
                <Sparkles size={11} />
                {t("empty.letAi", { mod: MOD_KEY })}
              </button>
            </div>

            <div className={styles.tipGrid}>
              <div className={styles.tipCard}>
                <div className={styles.tipLabel}>{t("empty.tipCmdkLabel", { mod: MOD_KEY })}</div>
                <div className={styles.tipText}>{t("empty.tipCmdk")}</div>
              </div>
              <div className={styles.tipCard}>
                <div className={styles.tipLabel}>[[ 名 ]]</div>
                <div className={styles.tipText}>
                  {t("empty.tipBrackets", { entry: terms.entry, entries: terms.entries, kb: terms.kb })}
                </div>
              </div>
              <div className={styles.tipCard}>
                <div className={styles.tipLabel}>{t("empty.tipSaveLabel", { mod: MOD_KEY })}</div>
                <div className={styles.tipText}>{t("empty.tipSave")}</div>
              </div>
            </div>
          </div>
        </div>
        <EditorBottomStrip />
      </div>
    );
  }

  if (isImage) {
    return (
      <div className={styles.area}>
        <div className={styles.panes}>
          <ImagePreview path={activeFilePath} />
        </div>
        <EditorBottomStrip />
      </div>
    );
  }

  // The file couldn't be read (non-UTF-8, permissions, a transient I/O
  // fault). Render a non-editable notice instead of the CodeEditor — showing
  // it with empty content would let the very next keystroke autosave over
  // whatever is actually on disk.
  if (loadError && loadError.path === activeFilePath) {
    return (
      <div className={styles.area}>
        <div className={styles.empty}>
          <div className={styles.emptyInner}>
            <div className={styles.emptyEyebrow}>{t("editor.loadErrorEyebrow")}</div>
            <h1 className={styles.emptyTitle}>{t("editor.loadErrorTitle")}</h1>
            <p className={styles.emptyHint}>{t("editor.loadErrorHint", { message: loadError.message })}</p>
            <div className={styles.emptyCta}>
              <button className={styles.emptyCtaBtn} onClick={() => loadFile(activeFilePath)}>
                {t("editor.loadErrorRetry")}
              </button>
            </div>
          </div>
        </div>
        <EditorBottomStrip />
      </div>
    );
  }

  const showEditor = viewMode === "editor" || viewMode === "split";
  const showPreview = viewMode === "preview" || viewMode === "split";

  return (
    <div className={styles.area}>
      <div className={styles.panes}>
        {showEditor && (
          <div className={styles.editorPane}>
            <CodeEditor value={content} onChange={setContent} />
            <EditorScrollNav />
          </div>
        )}
        {showPreview && (
          <div className={styles.previewPane} ref={previewPaneRef}>
            {isHtml
              ? <HtmlPreview source={content} filePath={filePath} />
              : <Preview source={content} basePath={filePath ? filePath.replace(/[/\\][^/\\]*$/, "") : null} />}
          </div>
        )}
      </div>
      <EditorBottomStrip />
    </div>
  );
}
