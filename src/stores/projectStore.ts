import { create } from "zustand";

interface ProjectState {
  projectPath: string | null;
  activeFilePath: string | null;
  wordCount: number;
  charCount: number;

  setProjectPath: (path: string | null) => void;
  setActiveFilePath: (path: string | null) => void;
  setWordCount: (n: number) => void;
  setCharCount: (n: number) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  projectPath: null,
  activeFilePath: null,
  wordCount: 0,
  charCount: 0,

  setProjectPath: (path) => set({ projectPath: path }),
  setActiveFilePath: (path) => set({ activeFilePath: path }),
  setWordCount: (n) => set({ wordCount: n }),
  setCharCount: (n) => set({ charCount: n }),
}));
