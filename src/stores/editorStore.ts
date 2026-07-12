import { create } from "zustand";
import type { EditorView } from "@codemirror/view";
import { extractHeadings, countWords, type HeadingNode } from "../lib/fs/markdown";
import { readFile, writeFile } from "../lib/fs/fileio";
import { useProjectStore } from "./projectStore";

export type ViewMode = "split" | "editor" | "preview";

interface EditorState {
  content: string;
  filePath: string | null;
  headings: HeadingNode[];
  viewMode: ViewMode;
  isDirty: boolean;
  saveTimer: ReturnType<typeof setTimeout> | null;

  scrollToLine: ((line: number) => void) | null;
  /** Live CodeMirror view — used to read precise selection offsets. Null when
   *  no editor is mounted (e.g. preview-only mode). */
  editorView: EditorView | null;

  loadFile: (path: string) => Promise<void>;
  setContent: (content: string) => void;
  saveNow: () => Promise<void>;
  setViewMode: (mode: ViewMode) => void;
  setScrollToLine: (fn: ((line: number) => void) | null) => void;
  setEditorView: (view: EditorView | null) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  content: "",
  filePath: null,
  headings: [],
  viewMode: "split",
  isDirty: false,
  saveTimer: null,
  scrollToLine: null,
  editorView: null,

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
      set({ content, filePath: path, headings, isDirty: false, saveTimer: null });
      const words = countWords(content);
      useProjectStore.getState().setWordCount(words);
      useProjectStore.getState().setCharCount(content.length);
    } catch {
      set({ content: "", filePath: path, headings: [], isDirty: false, saveTimer: null });
    }
  },

  setContent: (content) => {
    const { saveTimer, filePath } = get();

    if (saveTimer) clearTimeout(saveTimer);
    const headings = extractHeadings(content);
    const words = countWords(content);
    useProjectStore.getState().setWordCount(words);
    useProjectStore.getState().setCharCount(content.length);

    const timer = filePath
      ? setTimeout(() => get().saveNow(), 2000)
      : null;

    set({ content, headings, isDirty: true, saveTimer: timer });
  },

  saveNow: async () => {
    const { content, filePath } = get();
    if (!filePath) return;
    await writeFile(filePath, content);
    set({ isDirty: false, saveTimer: null });
  },

  setViewMode: (mode) => set({ viewMode: mode }),

  setScrollToLine: (fn) => set({ scrollToLine: fn }),

  setEditorView: (view) => set({ editorView: view }),
}));
