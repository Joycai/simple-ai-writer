import { create } from "zustand";
import { extractHeadings, countWords, type HeadingNode } from "../lib/markdown";
import { readFile, writeFile } from "../lib/fileio";
import { useProjectStore } from "./projectStore";

export type ViewMode = "split" | "editor" | "preview";

interface EditorState {
  content: string;
  filePath: string | null;
  headings: HeadingNode[];
  viewMode: ViewMode;
  isDirty: boolean;
  saveTimer: ReturnType<typeof setTimeout> | null;

  loadFile: (path: string) => Promise<void>;
  setContent: (content: string) => void;
  saveNow: () => Promise<void>;
  setViewMode: (mode: ViewMode) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  content: "",
  filePath: null,
  headings: [],
  viewMode: "split",
  isDirty: false,
  saveTimer: null,

  loadFile: async (path) => {
    try {
      const content = await readFile(path);
      const headings = extractHeadings(content);
      set({ content, filePath: path, headings, isDirty: false });
      const words = countWords(content);
      useProjectStore.getState().setWordCount(words);
      useProjectStore.getState().setCharCount(content.length);
    } catch {
      set({ content: "", filePath: path, headings: [], isDirty: false });
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
    set({ isDirty: false });
  },

  setViewMode: (mode) => set({ viewMode: mode }),
}));
