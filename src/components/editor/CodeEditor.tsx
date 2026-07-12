import { useEffect, useRef } from "react";
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
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { useEditorStore } from "../../stores/editorStore";
import styles from "./CodeEditor.module.css";

interface Props {
  value: string;
  onChange: (value: string) => void;
}

export function CodeEditor({ value, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
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
      view.destroy();
      viewRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value changes (file switch) without re-creating editor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value && externalValueRef.current !== value) {
      externalValueRef.current = value;
      isSyncingRef.current = true;
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
      isSyncingRef.current = false;
    }
  }, [value]);

  return <div ref={containerRef} className={styles.wrap} data-ai-selection />;
}
