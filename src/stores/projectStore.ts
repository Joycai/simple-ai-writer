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
  appTerms,
  builtinProfile,
  loadProfileFile,
  parseCategoryList,
  resetActiveWorkspace,
  resolveWorkspace,
  saveProfileFile,
  setActiveWorkspace,
  DEFAULT_DOC_MODEL,
  DEFAULT_SECTION_LABELS,
  NOVEL_PROFILE,
  type DocModel,
  type ProfileCategory,
  type ResolvedTerms,
  type ResolvedWorkspace,
  type SectionId,
  type WorkspaceProfile,
} from "../lib/profile";
import { normalizeChapterFileName } from "../lib/context/outline";
import { copyPath, fileExists, makeDir, removeDir, removeFile, renamePath, writeFile } from "../lib/fs/fileio";
import { baseNameOf, resolveCopyTarget, type TransferMode } from "../lib/fs/moveCopy";
import { discardDocumentAssets, moveDocumentAssets } from "../lib/image/assets";
import { isStrictDescendant } from "../lib/paths";
import { useLoreStore } from "./loreStore";
import { useEditorStore } from "./editorStore";
import { useAppStore, type MainView } from "./appStore";

/**
 * Persist any unsaved editor/lore edits and cancel their pending autosave timers.
 *
 * Exported because anything that reads the project *off disk* — closing it,
 * switching projects, taking a backup — needs the in-memory edits down first,
 * and each caller re-deriving "which stores might be dirty" is how one of them
 * ends up missing the lore panel.
 */
export async function flushDirtyDocuments(): Promise<void> {
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

/** The workspace with no project open: the novel pack, alone. */
const DEFAULT_WORKSPACE = resolveWorkspace([NOVEL_PROFILE]);

interface ProjectState {
  projectPath: string | null;
  /**
   * The merged view of every enabled pack plus the project's user-defined
   * categories. Mirrors the `lib/profile/active` singleton, which is what
   * non-React code reads; this copy exists so components re-render when the
   * selection changes. **This store is the only writer of both**: keeping
   * them in sync anywhere else would let the UI and the prompt disagree about
   * which packs are in force.
   */
  workspace: ResolvedWorkspace;
  /**
   * The hand-written packs the project's profile.json carries (usually none).
   * Held so `setPacks` can resolve their ids and `saveProfileFile` can write
   * them back — dropping them on save would delete the author's own pack.
   */
  customPacks: WorkspaceProfile[];
  /**
   * The project's user-defined knowledge-base categories, as stored in
   * profile.json. The merged view (`workspace.categories`) already contains
   * them; this is the editable source list `setCustomCategories` works from.
   */
  customCategories: ProfileCategory[];
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
   * The entries the author cut or copied from the sidebar, waiting for a
   * paste. Lives here for the same reason `expandedDirs` does — the sidebar's
   * tab transition remounts the tree, and a clipboard that emptied itself
   * whenever the author looked at the lore tab would be worse than not having
   * one. A **list**, because the sidebar selection is one: a clipboard that
   * held a single entry would quietly drop the rest of a multi-selection cut.
   */
  clipboard: { entries: { path: string; isDir: boolean }[]; mode: TransferMode } | null;
  wordCount: number;
  charCount: number;
  isLoading: boolean;

  openProject: (path?: string) => Promise<void>;
  closeProject: () => Promise<void>;
  refreshFileTree: () => Promise<void>;
  /**
   * Change the open project's pack selection: persist it, scaffold any new
   * category folders, and rescan. Non-destructive — a disabled pack's folders
   * and the entities in them stay on disk, so re-enabling it restores them
   * (they are simply not scanned while the pack is disabled). Ids resolve
   * against the project's custom packs first, then the built-ins.
   */
  setPacks: (enabledIds: string[]) => Promise<void>;
  /**
   * Replace the project's user-defined knowledge-base categories: persist,
   * scaffold new folders, rescan. Same non-destructive contract as `setPacks`
   * — removing a category only hides its directory, never deletes it.
   */
  setCustomCategories: (categories: ProfileCategory[]) => Promise<void>;

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
  setClipboard: (
    entry: { entries: { path: string; isDir: boolean }[]; mode: TransferMode } | null,
  ) => void;
  setDirExpanded: (path: string, open: boolean) => void;
  setWordCount: (n: number) => void;
  setCharCount: (n: number) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projectPath: null,
  workspace: DEFAULT_WORKSPACE,
  customPacks: [],
  customCategories: [],
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
      // Resolve the pack selection before the scaffold, which creates the
      // folders it names — but don't *activate* it until the open can no
      // longer fail. Activating early would leave the still-open previous
      // project reading the failed project's categories.
      const selection = await loadProfileFile(target);
      const workspace = selection
        ? resolveWorkspace(selection.enabled, selection.customCategories)
        : DEFAULT_WORKSPACE;
      if (workspace.issues.length > 0) {
        console.warn(`[profile] ${target} merge problems:\n  - ${workspace.issues.join("\n  - ")}`);
      }
      await scaffoldProject(target, workspace.categories.map((c) => c.id));
      resetDb();
      resetDocuments();
      await getDb(target);
      setActiveWorkspace(workspace);
      set({ projectPath: target, workspace, customPacks: selection?.customPacks ?? [], customCategories: selection?.customCategories ?? [], activeFilePath: null, fileTree: [], expandedDirs: {}, clipboard: null, wordCount: 0, charCount: 0 });
      await get().refreshFileTree();
      await useLoreStore.getState().scanProject(target);
      useAppStore.getState().addRecentProject(target);
      // Chat sessions are project-scoped: drop the previous project's from
      // view and restore this one's newest. Lazy import — agentStore reaches
      // back into this store (see its module doc on circular deps).
      const { useAgentStore } = await import("./agentStore");
      await useAgentStore.getState().resetChatForProject(target);
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
    const { useAgentStore } = await import("./agentStore");
    await useAgentStore.getState().resetChatForProject(null);
    resetDb();
    // Back to the default workspace: with no project open, anything that reads
    // the active workspace must not still see the closed project's categories.
    resetActiveWorkspace();
    set({ projectPath: null, workspace: DEFAULT_WORKSPACE, customPacks: [], customCategories: [], activeFilePath: null, fileTree: [], expandedDirs: {}, clipboard: null, wordCount: 0, charCount: 0 });
  },

  setPacks: async (enabledIds) => {
    const { projectPath, workspace, customPacks, customCategories } = get();
    if (!projectPath) throw new Error("Open a project before changing its packs.");

    // A project's own pack beats the built-in of the same id — the same
    // "file overrides built-in" contract profile.json has always had.
    const resolvePack = (id: string): WorkspaceProfile => {
      const pack = customPacks.find((p) => p.id === id) ?? builtinProfile(id);
      if (!pack) throw new Error(`Unknown pack "${id}".`); // UI passes known ids; loud beats silent
      return pack;
    };
    const enabled: WorkspaceProfile[] = [];
    for (const id of enabledIds) {
      if (enabled.some((p) => p.id === id)) continue;
      enabled.push(resolvePack(id));
    }

    const next = resolveWorkspace(enabled, customCategories);
    if (next.issues.length > 0) {
      console.warn(`[profile] merge problems:\n  - ${next.issues.join("\n  - ")}`);
    }
    // Same selection in the same order — nothing to do (the "clicked the
    // current card" case, like the old same-profile check).
    if (
      next.enabled.length === workspace.enabled.length &&
      next.enabled.every((p, i) => p.id === workspace.enabled[i].id)
    ) {
      return;
    }

    // Persist first: if writing profile.json fails, nothing else has moved and
    // the next open still resolves the previous selection.
    await saveProfileFile(projectPath, { enabled: next.enabled, customPacks, customCategories, issues: [] });
    setActiveWorkspace(next);
    set({ workspace: next });
    await scaffoldProject(projectPath, next.categories.map((c) => c.id));
    await get().refreshFileTree();
    // The lore index is keyed by category, so it is entirely stale now.
    await useLoreStore.getState().scanProject(projectPath);
  },

  setCustomCategories: async (categories) => {
    const { projectPath, workspace, customPacks, customCategories } = get();
    if (!projectPath) throw new Error("Open a project before changing its categories.");

    // Run the list through the same validator profile.json goes through, so a
    // bad id from the UI fails here rather than surviving until the next open.
    const issues: string[] = [];
    const cleaned = parseCategoryList(categories, issues);
    if (issues.length > 0) {
      throw new Error(`Invalid categories:\n  - ${issues.join("\n  - ")}`);
    }
    if (
      cleaned.length === customCategories.length &&
      cleaned.every(
        (c, i) =>
          c.id === customCategories[i].id &&
          c.labelZh === customCategories[i].labelZh &&
          c.labelEn === customCategories[i].labelEn,
      )
    ) {
      return;
    }

    const next = resolveWorkspace(workspace.enabled, cleaned);
    // Persist first, same contract as setPacks.
    await saveProfileFile(projectPath, { enabled: workspace.enabled, customPacks, customCategories: cleaned, issues: [] });
    setActiveWorkspace(next);
    set({ workspace: next, customCategories: cleaned });
    await scaffoldProject(projectPath, next.categories.map((c) => c.id));
    await get().refreshFileTree();
    // A removed category hides its entities; an added one may reveal parked
    // ones — either way the index is stale.
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
    // The illustration folder is named after the document and the links in it
    // are relative, so it has to travel too. Before `activeFilePath` changes:
    // that is what makes the editor reload the file, and it should reload the
    // rewritten text rather than the version pointing at the old folder.
    await moveDocumentAssets(from, to);

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
        // Move rather than copy, for folders and files alike: one rename both
        // backs the entry up and removes it, so there is no half-deleted
        // state, and it is byte-exact whatever the entry holds. The old
        // file branch copied through backupFile, whose text-only IPC fails on
        // a picture — and a failed backup must abort the delete, so images
        // would have become undeletable the moment the sidebar started
        // backing up.
        const backupRoot = `${projectPath}/.ai-writer/backups`;
        await makeDir(backupRoot);
        const flat = path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "entry";
        backupPath = `${backupRoot}/deleted-${Date.now()}-${flat}`;
        await renamePath(path, backupPath);
        // The document's pictures go beside the backup, so a restore brings
        // back a document whose image links still resolve.
        if (!isDir) await discardDocumentAssets(path, backupPath);
        return backupPath;
      }
      if (isDir) {
        await removeDir(path);
      } else {
        await removeFile(path);
        // Otherwise the document's pictures stay on disk attached to nothing,
        // still visible in the tree.
        await discardDocumentAssets(path, null);
      }
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
 * The document model — app-level and all-on since packs became additive.
 * Kept as a hook (rather than deleting the seam) so components stay wired for
 * a future per-project setting; today it never changes, so it subscribes to
 * nothing.
 */
export function useDocModel(): DocModel {
  return DEFAULT_DOC_MODEL;
}

/**
 * The app vocabulary in the active language — what a component calls a
 * document, a folder of them, the knowledge base. Uniform across projects
 * (知识库/文档/分组/条目); only the language varies. Memoised so consumers can
 * use the object in dependency arrays without re-firing every render.
 */
export function useTerms(): ResolvedTerms {
  const language = useAppStore((s) => s.language);
  return useMemo(() => appTerms(language === "zh-CN"), [language]);
}

/**
 * The 【…】 label for one prompt block, for UI copy that *mentions* a block
 * (e.g. "【知识库】最多占用…"). App-level neutral wording — pack overrides
 * apply only inside a pack task's own prompt, which UI copy is not.
 */
export function useSectionLabel(id: SectionId): string {
  return DEFAULT_SECTION_LABELS[id];
}

/**
 * The main view to actually render, which is not always the stored one.
 *
 * `mainView` is persisted; the fallback used to matter when a profile could
 * turn the ordered spine off. The doc model is always all-on now, so this is
 * a pass-through that keeps the seam (and its consumers) intact.
 *
 * Every consumer must go through here, not `appStore.mainView`: App renders the
 * sidebar off the effective view while IconRail highlights off it, and the two
 * disagreeing shows up as a rendered panel whose rail icon isn't lit.
 */
export function useMainView(): MainView {
  const mainView = useAppStore((s) => s.mainView);
  const { ordered } = useDocModel();
  return mainView === "library" && !ordered ? "editor" : mainView;
}
