import { create } from "zustand";
import type { EditorView } from "@codemirror/view";
import { extractHeadings, countWords, type HeadingNode } from "../lib/fs/markdown";
import { readFile, writeFile } from "../lib/fs/fileio";
import { isImagePath } from "../lib/fs/images";
import type { AiTargetRange } from "../lib/editor/aiTarget";
import { useProjectStore } from "./projectStore";
import { isSamePath } from "../lib/paths";

export type ViewMode = "split" | "editor" | "preview";

interface EditorState {
  content: string;
  filePath: string | null;
  headings: HeadingNode[];
  viewMode: ViewMode;
  isDirty: boolean;
  saveTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Set when `loadFile` couldn't read the path it was given — a non-UTF-8
   * file, a permissions error, a transient I/O failure. `filePath` stays null
   * in that case (see loadFile), specifically so `setContent`'s autosave
   * timer can never schedule a write: without this, the failed read left
   * `content: ""` paired with the real path attached, and the very next
   * keystroke would autosave that near-empty draft over the original file.
   */
  loadError: { path: string; message: string } | null;

  scrollToLine: ((line: number) => void) | null;
  /**
   * 一次还没兑现的跳行。⌘K 可以在知识库墙上按，那时 `scrollToLine` 是 null
   * （CodeEditor 卸载时注销了它）；行号留在这里，`setScrollToLine` 注册的那一刻
   * 冲掉它。1 基行号，和编辑器边栏印的一样。
   */
  pendingJump: number | null;
  /** Live CodeMirror view — used to read precise selection offsets. Null when
   *  no editor is mounted (e.g. preview-only mode). */
  editorView: EditorView | null;
  /**
   * Mirror of the editor's marked AI target range, for UI that must show the
   * half-marked state too (`to: null` — start placed, end not yet). The usable
   * form is committed separately to `aiTaskStore.selection`; a half-marked
   * range is deliberately not a target, and must not look like one.
   * Authoritative copy lives in editor state — see lib/editor/aiTarget.
   */
  aiTarget: AiTargetRange | null;

  loadFile: (path: string) => Promise<void>;
  setContent: (content: string) => void;
  saveNow: () => Promise<void>;
  setViewMode: (mode: ViewMode) => void;
  setScrollToLine: (fn: ((line: number) => void) | null) => void;
  /** 光标跳到第 `line` 行（1 基）并滚进视野；编辑器没挂着就先记下。 */
  jumpToLine: (line: number) => void;
  setEditorView: (view: EditorView | null) => void;
  setAiTarget: (range: AiTargetRange | null) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  content: "",
  filePath: null,
  headings: [],
  viewMode: "split",
  isDirty: false,
  saveTimer: null,
  scrollToLine: null,
  pendingJump: null,
  editorView: null,
  aiTarget: null,
  loadError: null,

  loadFile: async (path) => {
    // Flush any pending autosave for the previously open file before switching.
    // Otherwise edits made within the debounce window are lost: the stale timer
    // would later fire and write the *new* file's content. Mirrors loreStore.selectFile.
    const { saveTimer, isDirty, filePath: prev } = get();
    if (saveTimer) clearTimeout(saveTimer);
    if (isDirty && prev && prev !== path) await get().saveNow();

    try {
      const content = await readFile(path);
      const headings = extractHeadings(content);
      set({ content, filePath: path, headings, isDirty: false, saveTimer: null, loadError: null });
      useProjectStore.getState().setDocCounts(countWords(content), content.length);
    } catch (e) {
      // filePath stays null (not `path`) — see loadError's doc comment above.
      set({
        content: "", filePath: null, headings: [], isDirty: false, saveTimer: null,
        loadError: { path, message: String(e) },
      });
    }
  },

  setContent: (content) => {
    const { saveTimer, filePath } = get();

    if (saveTimer) clearTimeout(saveTimer);
    const headings = extractHeadings(content);
    useProjectStore.getState().setDocCounts(countWords(content), content.length);

    const timer = filePath
      ? setTimeout(() => void get().saveNow().catch(() => {}), 2000) // saveNow logs; retried on next edit/flush
      : null;

    set({ content, headings, isDirty: true, saveTimer: timer });
  },

  saveNow: async () => {
    const { content, filePath, saveTimer } = get();
    // Cancel the real timer here, not just the state field it's mirrored
    // into — a caller that flushes without clearing it first (moveEntry did)
    // leaves it armed in the event loop, and it fires later regardless of
    // what `saveTimer` in state says, writing stale content to wherever
    // `filePath` has drifted to by then (e.g. recreating a just-moved file
    // at its old location).
    if (saveTimer) clearTimeout(saveTimer);
    if (!filePath) { set({ saveTimer: null }); return; }
    try {
      await writeFile(filePath, content);
      set({ isDirty: false, saveTimer: null });
    } catch (e) {
      // Keep isDirty true so the unsaved indicator stays truthful and the next
      // edit/flush retries the write — clearing it would silently drop the draft.
      console.error("[editorStore] save failed:", filePath, e);
      set({ saveTimer: null });
      throw e;
    }
  },

  setViewMode: (mode) => set({ viewMode: mode }),

  setScrollToLine: (fn) => {
    const { pendingJump } = get();
    set({ scrollToLine: fn, pendingJump: fn ? null : pendingJump });
    // `scrollToLine` 收的是 0 基行号（CodeEditor 里 `line + 1`）。
    if (fn && pendingJump != null) fn(pendingJump - 1);
  },

  jumpToLine: (line) => {
    const { scrollToLine } = get();
    if (scrollToLine) scrollToLine(line - 1);
    else set({ pendingJump: line });
  },

  setEditorView: (view) => set({ editorView: view }),

  setAiTarget: (range) => set({ aiTarget: range }),
}));

// ─── Writing focus ────────────────────────────────────────────────────────────

/**
 * The document every AI action targets.
 *
 * `filePath` and `text` are read as a pair from this store on purpose: they are
 * written in a single `set()` inside loadFile, so they can never name two
 * different documents. Composing a focus out of `projectStore.activeFilePath`
 * (set synchronously on click) plus `editorStore.content` (set by an async
 * effect, after flushing the previous file's autosave) *could* — and that window
 * is exactly how a task ends up running the previous chapter's prose against the
 * new chapter's memory and book position.
 */
export interface WritingFocus {
  /** Absolute path of the focused document, or null when none is loaded. */
  filePath: string | null;
  /** That document's current text — always the same document as `filePath`. */
  text: string;
  /**
   * False while the editor has not caught up to the file the author just opened
   * (or is showing something the editor never loads, like an image). AI actions
   * stay disabled until it settles rather than silently using the old document.
   */
  settled: boolean;
  /** The file the author opened, when it differs from the focus. */
  pendingPath: string | null;
}

function deriveFocus(
  filePath: string | null,
  text: string,
  activeFilePath: string | null,
): WritingFocus {
  const settled = isSamePath(activeFilePath, filePath);
  return {
    filePath,
    text,
    settled,
    pendingPath: settled ? null : activeFilePath,
  };
}

/** Non-reactive read, for stores and run-time snapshots. */
export function getWritingFocus(): WritingFocus {
  const { filePath, content } = useEditorStore.getState();
  return deriveFocus(filePath, content, useProjectStore.getState().activeFilePath);
}

/** Reactive read, for components. */
export function useWritingFocus(): WritingFocus {
  const filePath = useEditorStore((s) => s.filePath);
  const text = useEditorStore((s) => s.content);
  const activeFilePath = useProjectStore((s) => s.activeFilePath);
  return deriveFocus(filePath, text, activeFilePath);
}

/** True when the author has opened something the editor will never load as text. */
export function focusBlockedByImage(focus: WritingFocus): boolean {
  return !focus.settled && !!focus.pendingPath && isImagePath(focus.pendingPath);
}
