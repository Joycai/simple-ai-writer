import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightActiveLine,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { themedSearch } from "./searchPanel";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { useEditorStore } from "../../stores/editorStore";
import { useAiTaskStore } from "../../stores/aiTaskStore";
import { EditorContextMenu } from "./EditorContextMenu";
import { DocImageGenModal } from "./DocImageGenModal";
import { useAiStore } from "../../stores/aiStore";
import {
  aiTargetExtension,
  aiTargetField,
  clearAiTarget,
  clearTarget,
  markTargetEnd,
  markTargetStart,
} from "../../lib/editor/aiTarget";
import {
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleInlineCode,
  toggleHeading,
  toggleQuote,
  toggleBulletList,
  insertLink,
  insertAtCursor,
} from "../../lib/editor/format";
import { imageMarkdown, importDocumentAsset } from "../../lib/image/assets";
import styles from "./CodeEditor.module.css";

/** Markdown formatting shortcuts. Kept clear of app globals: Mod-S (save),
 *  Mod-K (command palette) and Mod-Shift-E/L/M (AI actions). */
const formatKeymap = [
  { key: "Mod-b", run: toggleBold },
  { key: "Mod-i", run: toggleItalic },
  { key: "Mod-Shift-x", run: toggleStrikethrough },
  { key: "Mod-e", run: toggleInlineCode },
  { key: "Mod-Shift-k", run: insertLink },
  { key: "Mod-Alt-1", run: (v: EditorView) => toggleHeading(v, 1) },
  { key: "Mod-Alt-2", run: (v: EditorView) => toggleHeading(v, 2) },
  { key: "Mod-Alt-3", run: (v: EditorView) => toggleHeading(v, 3) },
  { key: "Mod-Shift-.", run: toggleQuote },
  { key: "Mod-Shift-8", run: toggleBulletList },
];

/** Marking the AI target range. Bracket keys sit next to CodeMirror's own
 *  Mod-[ / Mod-] indent pair, and the shifted forms are otherwise unbound. */
const aiTargetKeymap = [
  { key: "Mod-Shift-[", run: markTargetStart },
  { key: "Mod-Shift-]", run: markTargetEnd },
  { key: "Mod-Shift-\\", run: clearTarget },
];

interface Props {
  value: string;
  onChange: (value: string) => void;
}

export function CodeEditor({ value, onChange }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [illustrating, setIllustrating] = useState(false);
  const hasImageModel = useAiStore((s) => s.models.some((m) => m.type === "image"));
  const filePath = useEditorStore((s) => s.filePath);
  /** A failed 插入图片, shown until the next attempt. */
  const [insertError, setInsertError] = useState<string | null>(null);

  /**
   * Copy a picture off disk into the document's own `assets/` folder and link
   * it at the cursor.
   *
   * Copied rather than linked in place: the link is relative, so pointing at
   * wherever the file happened to sit would break the moment the project moves
   * to another machine — and the picture would be missing from every export
   * and backup, which only carry the project folder.
   */
  const handleInsertImage = async () => {
    const view = viewRef.current;
    if (!view || !filePath) return;
    setInsertError(null);
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const { relPath } = await importDocumentAsset(filePath, picked);
      // Alt text is what a text-only model — and a reader of the exported
      // HTML — sees in place of the picture, so an empty one makes it
      // invisible. The filename is the only description available here.
      const alt = (picked.split(/[/\\]/).pop() ?? "").replace(/\.[^.]+$/, "");
      insertAtCursor(view, imageMarkdown(relPath, alt));
    } catch (e) {
      setInsertError(t("editor.insertImageFailed", { message: String(e) }));
    }
  };

  // Update content when external value changes (e.g. file switch)
  const externalValueRef = useRef(value);
  // True while we push an external value into the doc; prevents the resulting
  // docChanged event from being reported back as a user edit (which would flip
  // the file to "dirty" and schedule a redundant save on every file open).
  const isSyncingRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && !isSyncingRef.current) {
        const newValue = update.state.doc.toString();
        onChangeRef.current(newValue);
      }
      // Mirror the marked range into the AI store. Driven by the field rather
      // than by the mark commands so that edits which *move* the range keep the
      // store in step — that mapping is the whole reason the range lives in
      // editor state, and a stale mirror would throw it away.
      const before = update.startState.field(aiTargetField, false) ?? null;
      const after = update.state.field(aiTargetField, false) ?? null;
      if (before === after) return;
      useEditorStore.getState().setAiTarget(after);
      const { setSelection, clearSelectionFrom } = useAiTaskStore.getState();
      if (after && after.to !== null && after.to > after.from) {
        const range = { from: after.from, to: after.to };
        setSelection(update.state.sliceDoc(range.from, range.to), range, "marker");
      } else {
        // Dropped, or only half-marked — either way there is no usable target.
        clearSelectionFrom("marker");
      }
    });

    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        // Must be configured here (not left to openSearchPanel's lazy default)
        // or Mod-F builds CodeMirror's own unstyled panel instead of ours.
        themedSearch(),
        keymap.of([...aiTargetKeymap, ...formatKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        aiTargetExtension(styles.aiTarget),
        markdown({
          base: markdownLanguage,
          codeLanguages: languages,
        }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        EditorView.theme({
          "&": { background: "transparent" },
          ".cm-gutters": { display: "none" },
        }),
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    externalValueRef.current = value;
    useEditorStore.getState().setEditorView(view);

    useEditorStore.getState().setScrollToLine((line) => {
      const doc = view.state.doc;
      const lineNo = Math.min(Math.max(line + 1, 1), doc.lines);
      const pos = doc.line(lineNo).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 80 }),
      });
      view.focus();
    });

    return () => {
      useEditorStore.getState().setScrollToLine(null);
      useEditorStore.getState().setEditorView(null);
      useEditorStore.getState().setAiTarget(null);
      useAiTaskStore.getState().clearSelectionFrom("marker");
      view.destroy();
      viewRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value changes (file switch) without re-creating editor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // Cheap ref check first: the common case is the editor's own edit arriving
    // back through the store, and the old order serialized the whole document
    // (`doc.toString()`) on every keystroke just to conclude nothing external
    // changed — a full-doc string allocation per character at novel sizes.
    if (externalValueRef.current === value) return;
    const current = view.state.doc.toString();
    if (current === value) {
      // The store caught up with what the editor already shows (a user edit
      // round-tripping). Remember it so the next run stops at the ref check.
      externalValueRef.current = value;
      return;
    }
    externalValueRef.current = value;
    isSyncingRef.current = true;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      // This replaces the whole document (a file switch, or an AI insert), so
      // there is nothing meaningful to map the marked range onto — offsets
      // would survive as numbers pointing at unrelated prose. Drop it.
      effects: clearAiTarget.of(null),
    });
    isSyncingRef.current = false;
  }, [value]);

  return (
    <div
      ref={containerRef}
      className={styles.wrap}
      data-ai-selection
      onContextMenu={(e) => {
        // Replace the webview's native menu with our own markdown/edit menu.
        e.preventDefault();
        viewRef.current?.focus();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {menu && viewRef.current && (
        <EditorContextMenu
          x={menu.x}
          y={menu.y}
          view={viewRef.current}
          onClose={() => setMenu(null)}
          // Both are offered only when they can actually work: an entry that
          // can only ever open an empty modal — or file a picture beside a
          // document that has no path — is worse than no entry.
          onIllustrate={hasImageModel ? () => { setMenu(null); setIllustrating(true); } : undefined}
          onInsertImage={filePath ? () => { setMenu(null); void handleInsertImage(); } : undefined}
        />
      )}
      {insertError && (
        <div className={styles.notice} onClick={() => setInsertError(null)} role="status">
          {insertError}
        </div>
      )}
      {illustrating && <DocImageGenModal onClose={() => setIllustrating(false)} />}
    </div>
  );
}
