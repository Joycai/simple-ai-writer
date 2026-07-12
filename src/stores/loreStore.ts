import { create } from "zustand";
import {
  scanLore,
  createEntity,
  readEntityFile,
  writeEntityFile,
  type LoreIndex,
  type LoreEntity,
  type CategoryId,
} from "../lib/lore";
import { removeDir } from "../lib/fs/fileio";

interface LoreState {
  index: LoreIndex;
  selectedEntity: LoreEntity | null;
  selectedFile: string | null;   // filename within entity dir
  fileContent: string;
  isDirty: boolean;
  isLoading: boolean;
  saveTimer: ReturnType<typeof setTimeout> | null;

  scanProject: (projectPath: string) => Promise<void>;
  selectEntity: (entity: LoreEntity) => void;
  selectFile: (filename: string) => Promise<void>;
  setFileContent: (content: string) => void;
  saveNow: () => Promise<void>;
  createNewEntity: (projectPath: string, category: CategoryId, id: string, name: string) => Promise<void>;
  deleteEntity: (projectPath: string, entity: LoreEntity) => Promise<void>;
}

export const useLoreStore = create<LoreState>((set, get) => ({
  index: {},
  selectedEntity: null,
  selectedFile: null,
  fileContent: "",
  isDirty: false,
  isLoading: false,
  saveTimer: null,

  scanProject: async (projectPath) => {
    set({ isLoading: true });
    try {
      const index = await scanLore(projectPath);
      set({ index });
    } finally {
      set({ isLoading: false });
    }
  },

  selectEntity: (entity) => {
    set({ selectedEntity: entity, selectedFile: null, fileContent: "", isDirty: false });
    // Auto-open index.md if it exists
    if (entity.mdFiles.includes("index.md")) {
      get().selectFile("index.md");
    }
  },

  selectFile: async (filename) => {
    const { selectedEntity, saveTimer } = get();
    if (!selectedEntity) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      await get().saveNow();
    }
    try {
      const content = await readEntityFile(selectedEntity.dirPath, filename);
      set({ selectedFile: filename, fileContent: content, isDirty: false });
    } catch {
      set({ selectedFile: filename, fileContent: "", isDirty: false });
    }
  },

  setFileContent: (content) => {
    const { saveTimer, selectedEntity, selectedFile } = get();
    if (saveTimer) clearTimeout(saveTimer);

    const timer = selectedEntity && selectedFile
      ? setTimeout(() => get().saveNow(), 2000)
      : null;

    set({ fileContent: content, isDirty: true, saveTimer: timer });
  },

  saveNow: async () => {
    const { selectedEntity, selectedFile, fileContent } = get();
    if (!selectedEntity || !selectedFile) return;
    await writeEntityFile(selectedEntity.dirPath, selectedFile, fileContent);
    set({ isDirty: false, saveTimer: null });
  },

  createNewEntity: async (projectPath, category, id, name) => {
    await createEntity(projectPath, category, id, name);
    await get().scanProject(projectPath);
    const entity = get().index[category]?.find((e) => e.id === id);
    if (entity) get().selectEntity(entity);
  },

  deleteEntity: async (projectPath, entity) => {
    await removeDir(entity.dirPath);
    await get().scanProject(projectPath);
    if (get().selectedEntity?.id === entity.id) {
      set({ selectedEntity: null, selectedFile: null, fileContent: "" });
    }
  },
}));
