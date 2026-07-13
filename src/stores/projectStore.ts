import { create } from "zustand";
import {
  openProjectFolder,
  registerProjectRoot,
  scaffoldProject,
  readDirRecursive,
  getDb,
  resetDb,
  type FileNode,
} from "../lib/project";
import { useLoreStore } from "./loreStore";
import { useEditorStore } from "./editorStore";
import { useAppStore } from "./appStore";

/** Persist any unsaved editor/lore edits and cancel their pending autosave timers. */
async function flushDirtyDocuments(): Promise<void> {
  const editor = useEditorStore.getState();
  if (editor.saveTimer) clearTimeout(editor.saveTimer);
  if (editor.isDirty && editor.filePath) await editor.saveNow();

  const lore = useLoreStore.getState();
  if (lore.saveTimer) clearTimeout(lore.saveTimer);
  if (lore.isDirty && lore.selectedEntity && lore.selectedFile) await lore.saveNow();
}

/** Reset the in-memory editor + lore state so stale content can't leak across projects. */
function resetDocuments(): void {
  useEditorStore.setState({ content: "", filePath: null, headings: [], isDirty: false, saveTimer: null });
  useLoreStore.setState({ index: {}, selectedEntity: null, selectedFile: null, fileContent: "", isDirty: false, saveTimer: null });
}

interface ProjectState {
  projectPath: string | null;
  activeFilePath: string | null;
  fileTree: FileNode[];
  wordCount: number;
  charCount: number;
  isLoading: boolean;

  openProject: (path?: string) => Promise<void>;
  closeProject: () => Promise<void>;
  refreshFileTree: () => Promise<void>;
  setActiveFilePath: (path: string | null) => void;
  setWordCount: (n: number) => void;
  setCharCount: (n: number) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projectPath: null,
  activeFilePath: null,
  fileTree: [],
  wordCount: 0,
  charCount: 0,
  isLoading: false,

  openProject: async (path) => {
    // `path` is passed when reopening from the recent-projects list; otherwise prompt.
    const target = typeof path === "string" ? path : await openProjectFolder();
    if (!target) return;

    // Persist unsaved edits from the currently open project before switching away.
    await flushDirtyDocuments();

    set({ isLoading: true });
    try {
      // Paths from the recents list weren't registered by the dialog — the
      // scoped fs commands reject them until the Rust side verifies the
      // on-disk .ai-writer marker and allows the root.
      if (typeof path === "string") await registerProjectRoot(target);
      await scaffoldProject(target);
      resetDb();
      resetDocuments();
      await getDb(target);
      set({ projectPath: target, activeFilePath: null, fileTree: [], wordCount: 0, charCount: 0 });
      await get().refreshFileTree();
      await useLoreStore.getState().scanProject(target);
      useAppStore.getState().addRecentProject(target);
    } catch (err) {
      // A recent path that no longer opens (moved/deleted) should drop out of the list.
      if (typeof path === "string") useAppStore.getState().removeRecentProject(path);
      throw err;
    } finally {
      set({ isLoading: false });
    }
  },

  closeProject: async () => {
    await flushDirtyDocuments();
    resetDocuments();
    resetDb();
    set({ projectPath: null, activeFilePath: null, fileTree: [], wordCount: 0, charCount: 0 });
  },

  refreshFileTree: async () => {
    const { projectPath } = get();
    if (!projectPath) return;
    try {
      const tree = await readDirRecursive(projectPath);
      set({ fileTree: tree });
    } catch {
      set({ fileTree: [] });
    }
  },

  setActiveFilePath: (path) => set({ activeFilePath: path }),
  setWordCount: (n) => set({ wordCount: n }),
  setCharCount: (n) => set({ charCount: n }),
}));
