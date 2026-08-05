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
import { useMemo } from "react";
import {
  loadProfile,
  profileTerms,
  resetActiveProfile,
  saveProfile,
  setActiveProfile,
  DEFAULT_SECTION_LABELS,
  NOVEL_PROFILE,
  type DocModel,
  type ResolvedTerms,
  type SectionId,
  type WorkspaceProfile,
} from "../lib/profile";
import { backupFile } from "../lib/agent/backup";
import { normalizeChapterFileName } from "../lib/context/outline";
import { copyPath, fileExists, makeDir, removeDir, removeFile, renamePath, writeFile } from "../lib/fs/fileio";
import { baseNameOf, resolveCopyTarget, type TransferMode } from "../lib/fs/moveCopy";
import { isStrictDescendant } from "../lib/paths";
import { useLoreStore } from "./loreStore";
import { useEditorStore } from "./editorStore";
import { useAppStore, type MainView } from "./appStore";

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
  /**
   * The open project's workspace profile — what kind of writing this is (see
   * lib/profile). Mirrors the `lib/profile/active` singleton, which is what
   * non-React code reads; this copy exists so components re-render when the
   * profile changes. **This store is the only writer of both**: keeping them in
   * sync anywhere else would let the UI and the prompt disagree about which
   * profile is in force.
   */
  profile: WorkspaceProfile;
  activeFilePath: string | null;
  fileTree: FileNode[];
  /**
   * Which sidebar folders the author has explicitly opened or closed, keyed by
   * path. Lives here rather than in FileTree's nodes because the sidebar's tab
   * transition remounts the tree — local state would collapse every folder on
   * each visit to another tab. Absent key = the node's default (see FileTree).
   */
  expandedDirs: Record<string, boolean>;
  /**
   * The entry the author cut or copied from the sidebar, waiting for a paste.
   * Lives here for the same reason `expandedDirs` does — the sidebar's tab
   * transition remounts the tree, and a clipboard that emptied itself whenever
   * the author looked at the lore tab would be worse than not having one.
   */
  clipboard: { path: string; isDir: boolean; mode: TransferMode } | null;
  wordCount: number;
  charCount: number;
  isLoading: boolean;

  openProject: (path?: string) => Promise<void>;
  closeProject: () => Promise<void>;
  refreshFileTree: () => Promise<void>;
  /**
   * Switch the open project to another profile: persist it, scaffold the new
   * category folders, and rescan. Non-destructive — the previous profile's
   * folders and the entities in them stay on disk, so switching back restores
   * them (they are simply not scanned while another profile is active).
   */
  setProfile: (profile: WorkspaceProfile) => Promise<void>;

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
   * Copy a file/folder into `destDir` and return the new path. Unlike a move,
   * a name collision is not an error — the copy is numbered (`稿 (1).md`), so
   * duplicating an entry into its own folder works.
   */
  copyEntry: (from: string, destDir: string, isDir: boolean) => Promise<string>;
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
  setClipboard: (entry: { path: string; isDir: boolean; mode: TransferMode } | null) => void;
  setDirExpanded: (path: string, open: boolean) => void;
  setWordCount: (n: number) => void;
  setCharCount: (n: number) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projectPath: null,
  profile: NOVEL_PROFILE,
  activeFilePath: null,
  fileTree: [],
  expandedDirs: {},
  clipboard: null,
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
      // Resolve the profile before the scaffold, which creates the folders it
      // names — but don't *activate* it until the open can no longer fail.
      // Activating early would leave the still-open previous project reading
      // the failed project's categories.
      const profile = (await loadProfile(target)) ?? NOVEL_PROFILE;
      await scaffoldProject(target, profile.categories.map((c) => c.id));
      resetDb();
      resetDocuments();
      await getDb(target);
      setActiveProfile(profile);
      set({ projectPath: target, profile, activeFilePath: null, fileTree: [], expandedDirs: {}, clipboard: null, wordCount: 0, charCount: 0 });
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
    // Back to the default profile: with no project open, anything that reads
    // the active profile must not still see the closed project's categories.
    resetActiveProfile();
    set({ projectPath: null, profile: NOVEL_PROFILE, activeFilePath: null, fileTree: [], expandedDirs: {}, clipboard: null, wordCount: 0, charCount: 0 });
  },

  setProfile: async (profile) => {
    const { projectPath } = get();
    if (!projectPath) throw new Error("Open a project before changing its profile.");
    if (profile.id === get().profile.id) return;

    // Persist first: if writing profile.json fails, nothing else has moved and
    // the next open still resolves the previous profile.
    await saveProfile(projectPath, profile);
    setActiveProfile(profile);
    set({ profile });
    await scaffoldProject(projectPath, profile.categories.map((c) => c.id));
    await get().refreshFileTree();
    // The lore index is keyed by category, so it is entirely stale now.
    await useLoreStore.getState().scanProject(projectPath);
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

  copyEntry: async (from, destDir, isDir) => {
    if (isStrictDescendant(from, destDir) || from === destDir) {
      throw new Error("Cannot copy a folder into itself.");
    }
    // Flush before copying, or the copy captures the last-saved text rather
    // than what is on screen — silently, since nothing else about the copy
    // looks wrong.
    const editor = useEditorStore.getState();
    const editorAffected =
      editor.filePath === from || (!!editor.filePath && isStrictDescendant(from, editor.filePath));
    if (editorAffected && editor.isDirty) await editor.saveNow();

    const to = await resolveCopyTarget(destDir, baseNameOf(from), isDir, fileExists);
    await copyPath(from, to);
    await get().refreshFileTree();
    return to;
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

  setClipboard: (entry) => set({ clipboard: entry }),

  setDirExpanded: (path, open) =>
    set((s) => ({ expandedDirs: { ...s.expandedDirs, [path]: open } })),
  setWordCount: (n) => set({ wordCount: n }),
  setCharCount: (n) => set({ charCount: n }),
}));

/**
 * The active profile's document model, **subscribed** — for components.
 *
 * Components must not read `docModel()` from `lib/profile/active` directly: that
 * singleton is not reactive, so a component whose only other subscriptions are
 * unrelated would keep rendering the previous profile's UI after a switch. Going
 * through the store is what the mirrored `profile` state is for. Non-React code
 * (aiTaskStore, agentStore) still uses the singleton — it reads once per run.
 *
 * The reference is stable while the profile is, so this triggers no extra renders.
 */
export function useDocModel(): DocModel {
  return useProjectStore((s) => s.profile.docModel);
}

/**
 * The active profile's UI vocabulary in the active language — what a component
 * calls a document, a folder of them, the knowledge base. Same reactivity
 * contract as `useDocModel`; non-React code resolves `profileTerms` against the
 * singleton itself. Memoised so consumers can use the object in dependency
 * arrays without re-firing every render.
 */
export function useTerms(): ResolvedTerms {
  const profile = useProjectStore((s) => s.profile);
  const language = useAppStore((s) => s.language);
  return useMemo(() => profileTerms(profile, language === "zh-CN"), [profile, language]);
}

/**
 * The active profile's 【…】 label for one prompt block — the reactive
 * counterpart of `sectionLabel()` for UI copy that *mentions* a block
 * (e.g. "【设定资料】最多占用…" must say 【企业知识库】 in a bid project).
 */
export function useSectionLabel(id: SectionId): string {
  return useProjectStore((s) => s.profile.sections[id] ?? DEFAULT_SECTION_LABELS[id]);
}

/**
 * The main view to actually render, which is not always the stored one.
 *
 * `mainView` is persisted, so it can point at the full outline view after the
 * author switches a project to a profile with no ordered spine — and the rail no
 * longer offers a button to leave it. This falls back instead of rewriting the
 * stored value, so switching back restores where they were.
 *
 * Every consumer must go through here, not `appStore.mainView`: App renders the
 * sidebar off the effective view while IconRail highlights off it, and the two
 * disagreeing shows up as a rendered panel whose rail icon isn't lit.
 */
export function useMainView(): MainView {
  const mainView = useAppStore((s) => s.mainView);
  const { ordered } = useDocModel();
  return mainView === "outline-full" && !ordered ? "editor" : mainView;
}
