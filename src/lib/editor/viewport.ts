import type { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export interface ViewportDocument {
  filePath: string | null;
  content: string;
  viewportRevision: number;
}

interface EditorViewport {
  selection: EditorSelection;
  scroll: ReturnType<EditorView["scrollSnapshot"]>;
}

/** One open-buffer snapshot; no live view, DOM, history, or per-file cache. */
export function createViewportCache() {
  let current: ViewportDocument | null = null;
  let editor: EditorViewport | undefined;
  let preview: { top: number; left: number } | undefined;
  const matches = (doc: ViewportDocument) => !!doc.filePath &&
    current?.filePath === doc.filePath && current.content === doc.content &&
    current.viewportRevision === doc.viewportRevision;
  const clear = () => { editor = undefined; preview = undefined; };
  return {
    sync(doc: ViewportDocument) {
      if (!matches(doc)) clear();
      current = { filePath: doc.filePath, content: doc.content, viewportRevision: doc.viewportRevision };
    },
    clear,
    clearPreview() { preview = undefined; },
    saveEditor(doc: ViewportDocument, value: EditorViewport) {
      if (matches(doc)) editor = value;
    },
    savePreview(doc: ViewportDocument, value: { top: number; left: number }) {
      if (matches(doc)) preview = value;
    },
    editor(doc: ViewportDocument, pendingJump: number | null) {
      return pendingJump === null && matches(doc) ? editor : undefined;
    },
    preview(doc: ViewportDocument, pendingJump: number | null) {
      return pendingJump === null && matches(doc) ? preview : undefined;
    },
  };
}
