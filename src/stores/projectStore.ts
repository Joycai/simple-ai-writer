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
import { backupFile } from "../lib/agent/backup";
import { normalizeChapterFileName } from "../lib/context/outline";
import { fileExists, makeDir, removeDir, removeFile, renamePath, writeFile } from "../lib/fs/fileio";
import { isStrictDescendant } from "../lib/paths";
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
  /**
   * Which sidebar folders the author has explicitly opened or closed, keyed by
   * path. Lives here rather than in FileTree's nodes because the sidebar's tab
   * transition remounts the tree — local state would collapse every folder on
   * each visit to another tab. Absent key = the node's default (see FileTree).
   */
  expandedDirs: Record<string, boolean>;
  wordCount: number;
  charCount: number;
  isLoading: boolean;

  openProject: (path?: string) => Promise<void>;
  closeProject: () => Promise<void>;
  refreshFileTree: () => Promise<void>;

  /**
   * Create a file (or folder) under `parentDir` and return its absolute path.
   * Bare filenames get `.md`. Refuses to overwrite an existing entry.
   */
  createEntry: (
    parentDir: string,
    name: string,
    type: "file" | "folder",
    content?: string,
  ) => Promise<string>;
  /** Move or rename a file/folder, keeping the open document pointed at it. */
  moveEntry: (from: string, to: string) => Promise<void>;
  /**
   * Delete a file or folder. With `backup`, the entry is snapshotted into
   * `.ai-writer/backups/` first; returns the backup path, or null when none
   * was taken. Callers that offer no undo of their own should pass it.
   */
  deleteEntry: (
    path: string,
    isDir: boolean,
    opts?: { backup?: boolean },
  ) => Promise<string | null>;

  setActiveFilePath: (path: string | null) => void;
  setDirExpanded: (path: string, open: boolean) => void;
  setWordCount: (n: number) => void;
  setCharCount: (n: number) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projectPath: null,
  activeFilePath: null,
  fileTree: [],
  expandedDirs: {},
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
      set({ projectPath: target, activeFilePath: null, fileTree: [], expandedDirs: {}, wordCount: 0, charCount: 0 });
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
    set({ projectPath: null, activeFilePath: null, fileTree: [], expandedDirs: {}, wordCount: 0, charCount: 0 });
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

  // ── File mutations ────────────────────────────────────────────────────────
  // Shared by the sidebar's context menu and the agent's approved proposals.
  // The filesystem call is the easy half; the editor bookkeeping around it is
  // what must not be reimplemented per call site (see each action).

  createEntry: async (parentDir, name, type, content = "") => {
    const finalName = type === "folder" ? name.trim() : normalizeChapterFileName(name);
    if (!finalName) throw new Error("A name is required.");
    const path = `${parentDir}/${finalName}`;

    // writeFile truncates, so an unchecked "new chapter" with an existing name
    // silently empties that chapter — unrecoverable, and the reason this guard
    // lives here rather than in either caller.
    if (await fileExists(path)) throw new Error(`"${finalName}" already exists here.`);

    if (type === "folder") await makeDir(path);
    else await writeFile(path, content); // creates parent dirs on the Rust side

    await get().refreshFileTree();
    return path;
  },

  moveEntry: async (from, to) => {
    if (from === to) return;
    // fs::rename silently replaces an existing destination file on Windows.
    if (await fileExists(to)) throw new Error("Something already exists at the destination.");
    // Moving a folder into its own subtree would strand it.
    if (isStrictDescendant(from, to)) throw new Error("Cannot move a folder into itself.");

    const editor = useEditorStore.getState();
    const editorAffected =
      editor.filePath === from || (!!editor.filePath && isStrictDescendant(from, editor.filePath));
    // Flush first: after the rename the editor still points at the old path,
    // and a pending autosave would recreate the file where it used to be.
    if (editorAffected && editor.isDirty) await editor.saveNow();

    await renamePath(from, to);

    const { activeFilePath } = get();
    if (activeFilePath === from) {
      set({ activeFilePath: to });
    } else if (activeFilePath && isStrictDescendant(from, activeFilePath)) {
      set({ activeFilePath: to + activeFilePath.slice(from.length) });
    }
    await get().refreshFileTree();
  },

  deleteEntry: async (path, isDir, opts) => {
    const { projectPath, activeFilePath } = get();
    const affected =
      activeFilePath === path || (!!activeFilePath && isStrictDescendant(path, activeFilePath));
    if (affected) {
      // Drop editor state *before* removing, or a pending autosave resurrects
      // the file moments after it is deleted.
      const editor = useEditorStore.getState();
      if (editor.saveTimer) clearTimeout(editor.saveTimer);
      useEditorStore.setState({ content: "", filePath: null, headings: [], isDirty: false, saveTimer: null });
      set({ activeFilePath: null });
    }

    let backupPath: string | null = null;
    try {
      if (opts?.backup && projectPath) {
        if (isDir) {
          // Move rather than copy: one rename both backs the folder up and
          // removes it, so there is no half-deleted state, and binary assets
          // travel too (backupFile is text-only).
          const backupRoot = `${projectPath}/.ai-writer/backups`;
          await makeDir(backupRoot);
          const flat = path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "folder";
          backupPath = `${backupRoot}/deleted-${Date.now()}-${flat}`;
          await renamePath(path, backupPath);
          return backupPath;
        }
        // A failed backup must abort the delete, never delete anyway.
        backupPath = await backupFile(projectPath, path);
      }
      if (isDir) await removeDir(path);
      else await removeFile(path);
    } finally {
      await get().refreshFileTree();
    }
    return backupPath;
  },

  setActiveFilePath: (path) => set({ activeFilePath: path }),
  setDirExpanded: (path, open) =>
    set((s) => ({ expandedDirs: { ...s.expandedDirs, [path]: open } })),
  setWordCount: (n) => set({ wordCount: n }),
  setCharCount: (n) => set({ charCount: n }),
}));
