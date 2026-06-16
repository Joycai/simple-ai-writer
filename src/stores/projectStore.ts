import { create } from "zustand";
import {
  openProjectFolder,
  scaffoldProject,
  readDirRecursive,
  getDb,
  resetDb,
  type FileNode,
} from "../lib/project";
import { useLoreStore } from "./loreStore";

interface ProjectState {
  projectPath: string | null;
  activeFilePath: string | null;
  fileTree: FileNode[];
  wordCount: number;
  charCount: number;
  isLoading: boolean;

  openProject: () => Promise<void>;
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

  openProject: async () => {
    const path = await openProjectFolder();
    if (!path) return;

    set({ isLoading: true });
    try {
      await scaffoldProject(path);
      resetDb();
      await getDb(path);
      set({ projectPath: path, activeFilePath: null, fileTree: [] });
      await get().refreshFileTree();
      await useLoreStore.getState().scanProject(path);
    } finally {
      set({ isLoading: false });
    }
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
