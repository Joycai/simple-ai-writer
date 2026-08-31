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
  loreCategoryIds,
  suggestCategoryId,
  type DocModel,
  type ProfileCategory,
  type ResolvedTerms,
  type ResolvedWorkspace,
  type SectionId,
  type WorkspaceProfile,
} from "../lib/profile";
import { normalizeChapterFileName } from "../lib/context/outline";
import type { LoreOrganizer } from "../lib/agent/registry";
import {
  fileEntities,
  normalizeCollections,
  refileCollection,
  // 起别名，因为 store 上有同名的 action：`renameCollection(list, …)` 这种写法在
  // action 体内读起来像递归调用自己，而它其实是那个纯函数。
  removeCollection as removeFromList,
  renameCollection as renameInList,
  sameCollection,
  type LoreEntity,
} from "../lib/lore";
import { copyPath, fileExists, makeDir, removeDir, removeFile, renamePath, writeFile } from "../lib/fs/fileio";
import { projectFilesFromTree, type ProjectFile } from "../lib/fs/images";
import { baseNameOf, resolveCopyTarget, type TransferMode } from "../lib/fs/moveCopy";
import { collapseAllMap } from "../lib/fs/selection";
import { copyDocumentAssets, discardDocumentAssets, moveDocumentAssets } from "../lib/image/assets";
import { baseName, isSamePath, isStrictDescendant } from "../lib/paths";
import { acquireProjectLock, focusExistingInstance, releaseProjectLock } from "../lib/instance";
import { useLoreStore } from "./loreStore";
import { useEditorStore } from "./editorStore";
import { useAppStore, type MainView } from "./appStore";
import { useComposerStore } from "./composerStore";

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

/**
 * How `openProject` ended. Callers that care are rare — the launch-argument
 * path in App.tsx closes its fresh window on `"focused-existing"`, the way
 * `code <folder>` hands off to the window that already has the folder.
 */
export type OpenProjectOutcome = "opened" | "cancelled" | "focused-existing";

/**
 * The advisory multi-instance guard: claim the workspace, and when a live
 * sibling process already holds it, resolve it the VS Code way — bring that
 * window forward and back out of this open. Only when the holder cannot be
 * reached (a crashed instance's recycled PID, a pre-focus-channel lock, a
 * lock from another machine) does it fall back to asking the author. Lock
 * machinery that *fails* counts as claimed (see lib/instance): the guard is a
 * courtesy, the project opening is the point.
 */
async function claimWorkspace(target: string): Promise<"claimed" | "focused-existing" | "declined"> {
  const lock = await acquireProjectLock(target);
  if (lock.status !== "held") return "claimed";
  if (await focusExistingInstance(target)) return "focused-existing";
  // Lazy, like agentStore's import above: the dialog plugin and i18n are only
  // needed on this rare path, and vitest's store tests never reach it.
  const [{ ask }, { default: i18n }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("../i18n"),
  ]);
  const proceed = await ask(
    i18n.t("project.lockHeldBody", { name: baseName(target) || target, pid: lock.pid }),
    {
      title: i18n.t("project.lockHeldTitle"),
      kind: "warning",
      okLabel: i18n.t("project.lockOpenAnyway"),
      cancelLabel: i18n.t("project.lockCancel"),
    },
  );
  if (!proceed) return "declined";
  await acquireProjectLock(target, true);
  return "claimed";
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
  /**
   * The project's declared knowledge-base **collections**, in profile.json
   * order (see lib/lore/collections).
   *
   * Declaration only. What is actually filed where lives on the entries, so
   * `collectionViews(loreIndex, collections)` is the merged view every surface
   * renders — this list contributes the order and the ones that are still
   * empty. Same split as `customCategories` vs `workspace.categories`.
   */
  collections: string[];
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

  openProject: (path?: string) => Promise<OpenProjectOutcome>;
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
   * Replace the project's declared collections: persist to profile.json and,
   * when a collection was renamed or removed, rewrite the membership of every
   * entry that carried it.
   *
   * Rewriting membership is the price of the id being the name itself, which
   * is what keeps `collections: ["小说A"]` readable in the frontmatter the
   * author edits by hand (see lib/lore/collections). Removing a collection
   * **never deletes an entry** — it only unfiles it.
   */
  setCollections: (next: string[]) => Promise<void>;
  /**
   * File entries into / out of collections. Any name that is not declared yet is
   * declared first, so 「新建集合并归入」 is one action rather than two the author
   * has to remember to do in order.
   */
  fileIntoCollections: (
    entities: readonly LoreEntity[],
    add: readonly string[],
    remove: readonly string[],
  ) => Promise<void>;
  /** Rename a collection: the declaration and every member entry's frontmatter. */
  renameCollection: (from: string, to: string) => Promise<void>;
  /**
   * Delete a collection: drop the declaration and unfile every member.
   * **No entry is ever deleted** — they become 未归集 (or keep their other
   * collections, since membership is a list).
   */
  deleteCollection: (name: string) => Promise<void>;

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
   * duplicating an entry into its own folder works. `newName` names the copy
   * (default: the source's name); a copied document's illustration folder is
   * duplicated alongside it, links rewritten, so the copy owns its pictures.
   */
  copyEntry: (from: string, destDir: string, isDir: boolean, newName?: string) => Promise<string>;
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
  /**
   * Close every folder in the tree — the sidebar's 「全部折叠」.
   *
   * One `set`, not a loop over `setDirExpanded`: each of those builds a fresh
   * `expandedDirs`, and FileTree subscribes to the whole object, so N folders
   * would be N re-renders of the entire tree. Why it has to write an explicit
   * `false` for each folder rather than clear the table is in `collapseAllMap`.
   */
  collapseAllDirs: () => void;
  /**
   * Both counters in one `set()`: the caller (editorStore.setContent) runs on
   * every keystroke, and two separate writes meant every subscriber of this
   * store got notified twice per character typed.
   */
  setDocCounts: (words: number, chars: number) => void;
}

/**
 * 交给 agent 运行的**重整能力**（`ToolContext.organize`）。
 *
 * 方法体只是转交给下面那四条 store 动作——UI 走的也是它们。agent 层不能反向 import
 * store，所以由调用方在这里注入，和 `resolveSubAgent` 同一种做法。
 *
 * `collections` 写成 getter 而不是一个数组快照：`ToolContext` 是一次运行的快照，
 * 模型刚用 manage_collection 建的集合，下一句 file_lore_entries 就要能查到它存在。
 * 存成数组的话那次查询会说「没有这个集合」，而错误信息还会理直气壮地把刚建好的
 * 那个漏在列表外。
 */
export function loreOrganizer(): LoreOrganizer {
  const st = () => useProjectStore.getState();
  return {
    get collections() {
      return st().collections;
    },
    createCollection: async (name) => {
      await st().setCollections([...st().collections, name]);
    },
    renameCollection: (from, to) => st().renameCollection(from, to),
    deleteCollection: (name) => st().deleteCollection(name),
    file: async (dirPaths, add, remove) => {
      const index = useLoreStore.getState().index;
      const byDir = new Map<string, LoreEntity>();
      for (const list of Object.values(index)) for (const e of list ?? []) byDir.set(e.dirPath, e);
      const entities = dirPaths
        .map((d) => byDir.get(d))
        .filter((e): e is LoreEntity => !!e);
      await st().fileIntoCollections(entities, add, remove);
    },
    createCategory: async (label) => {
      // 和知识库墙的「新建分类」同一条路：作者给标签，文件夹 id 推导出来，
      // 于是这个工具永远不必向模型解释文件夹名的规则。
      const id = suggestCategoryId(label, loreCategoryIds());
      await st().setCustomCategories([
        ...st().customCategories,
        { id, labelZh: label, labelEn: label },
      ]);
      return id;
    },
  };
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projectPath: null,
  workspace: DEFAULT_WORKSPACE,
  customPacks: [],
  customCategories: [],
  collections: [],
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
    if (!target) return "cancelled";

    // Persist unsaved edits from the currently open project before switching away.
    await flushDirtyDocuments();

    set({ isLoading: true });
    // Whether this open claims a workspace it didn't already hold — reopening
    // the current project must neither re-warn nor release its own lock.
    const previous = get().projectPath;
    const freshClaim = !previous || !isSamePath(previous, target);
    try {
      // Paths from the recents list weren't registered by the dialog — the
      // scoped fs commands reject them until the Rust side verifies the
      // on-disk .ai-writer marker and allows the root.
      if (typeof path === "string") await registerProjectRoot(target);
      // The multi-instance guard, after registration (the lock commands are
      // scope-checked) and before anything is torn down: a handed-off or
      // declined open leaves the previous project exactly as it was.
      if (freshClaim) {
        const claim = await claimWorkspace(target);
        if (claim === "focused-existing") return "focused-existing";
        if (claim === "declined") return "cancelled";
      }
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
      set({ projectPath: target, workspace, customPacks: selection?.customPacks ?? [], customCategories: selection?.customCategories ?? [], collections: selection?.collections ?? [], activeFilePath: null, fileTree: [], expandedDirs: {}, clipboard: null, wordCount: 0, charCount: 0 });
      await get().refreshFileTree();
      await useLoreStore.getState().scanProject(target);
      useAppStore.getState().addRecentProject(target);
      // Only now that the switch cannot fail: hand the previous workspace's
      // lock back, so a sibling instance opening it warns no longer.
      if (previous && freshClaim) void releaseProjectLock(previous);
      // Chat sessions are project-scoped: drop the previous project's from
      // view and restore this one's newest. Lazy import — agentStore reaches
      // back into this store (see its module doc on circular deps).
      const { useAgentStore } = await import("./agentStore");
      await useAgentStore.getState().resetChatForProject(target);
      useComposerStore.getState().resetAll();
      return "opened";
    } catch (err) {
      // The claim on a project that failed to open would otherwise linger
      // until exit, warning a sibling about a window that isn't there.
      // Harmless if never acquired — release only removes our own lock. The
      // projectPath check covers a throw from the post-switch steps above:
      // by then the project *is* open here, and its claim must stand.
      if (freshClaim && !isSamePath(get().projectPath, target)) void releaseProjectLock(target);
      // A recent path that no longer opens (moved/deleted) should drop out of the list.
      if (typeof path === "string") useAppStore.getState().removeRecentProject(path);
      throw err;
    } finally {
      set({ isLoading: false });
    }
  },

  closeProject: async () => {
    const closing = get().projectPath;
    await flushDirtyDocuments();
    resetDocuments();
    const { useAgentStore } = await import("./agentStore");
    await useAgentStore.getState().resetChatForProject(null);
    useComposerStore.getState().resetAll();
    resetDb();
    // Back to the default workspace: with no project open, anything that reads
    // the active workspace must not still see the closed project's categories.
    resetActiveWorkspace();
    set({ projectPath: null, workspace: DEFAULT_WORKSPACE, customPacks: [], customCategories: [], collections: [], activeFilePath: null, fileTree: [], expandedDirs: {}, clipboard: null, wordCount: 0, charCount: 0 });
    if (closing) void releaseProjectLock(closing);
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
    await saveProfileFile(projectPath, { enabled: next.enabled, customPacks, customCategories, collections: get().collections, issues: [] });
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
    await saveProfileFile(projectPath, { enabled: workspace.enabled, customPacks, customCategories: cleaned, collections: get().collections, issues: [] });
    setActiveWorkspace(next);
    set({ workspace: next, customCategories: cleaned });
    await scaffoldProject(projectPath, next.categories.map((c) => c.id));
    await get().refreshFileTree();
    // A removed category hides its entities; an added one may reveal parked
    // ones — either way the index is stale.
    await useLoreStore.getState().scanProject(projectPath);
  },

  setCollections: async (next) => {
    const { projectPath, workspace, customPacks, customCategories, collections } = get();
    if (!projectPath) throw new Error("Open a project before changing its collections.");
    const cleaned = normalizeCollections(next);
    if (cleaned.length === collections.length && cleaned.every((c, i) => c === collections[i])) return;
    // Declaration only — nothing on disk moves. A collection dropped from this
    // list but still named by some entry keeps working; it just stops carrying
    // an author-chosen position (see collectionViews). Unfiling is
    // `deleteCollection`, which is a different intent and says so.
    await saveProfileFile(projectPath, {
      enabled: workspace.enabled, customPacks, customCategories, collections: cleaned, issues: [],
    });
    set({ collections: cleaned });
  },

  fileIntoCollections: async (entities, add, remove) => {
    const { projectPath, workspace, customPacks, customCategories, collections } = get();
    if (!projectPath) throw new Error("Open a project before filing entries.");
    if (entities.length === 0 || (add.length === 0 && remove.length === 0)) return;

    // 先补声明再写条目：声明只贡献顺序与空集合，但少了它，作者刚建的集合会在管理
    // 面板里缺席，而它明明已经有成员了。
    const fresh = add.filter((name) => !collections.some((c) => sameCollection(c, name)));
    if (fresh.length > 0) {
      const next = normalizeCollections([...collections, ...fresh]);
      await saveProfileFile(projectPath, {
        enabled: workspace.enabled, customPacks, customCategories, collections: next, issues: [],
      });
      set({ collections: next });
    }

    await fileEntities(projectPath, entities, add, remove);
    await useLoreStore.getState().scanProject(projectPath);
  },

  renameCollection: async (from, to) => {
    const { projectPath, workspace, customPacks, customCategories, collections } = get();
    if (!projectPath) throw new Error("Open a project before changing its collections.");
    const target = to.trim();
    if (!target || sameCollection(from, target)) return;

    const loreStore = useLoreStore.getState();
    await refileCollection(projectPath, loreStore.index, from, target);
    const next = renameInList(collections, from, target);
    await saveProfileFile(projectPath, {
      enabled: workspace.enabled, customPacks, customCategories, collections: next, issues: [],
    });
    set({ collections: next });
    // 取材范围指着旧名字就一起跟过去——不跟的话围栏会指向一个不再存在的集合，
    // 而那个状态下 AI 一条设定也看不见，且界面上没有任何地方说得出为什么。
    if (loreStore.scope && sameCollection(loreStore.scope, from)) {
      loreStore.setScope(projectPath, target);
    }
    await useLoreStore.getState().scanProject(projectPath);
  },

  deleteCollection: async (name) => {
    const { projectPath, workspace, customPacks, customCategories, collections } = get();
    if (!projectPath) throw new Error("Open a project before changing its collections.");

    const loreStore = useLoreStore.getState();
    await refileCollection(projectPath, loreStore.index, name, null);
    const next = removeFromList(collections, name);
    await saveProfileFile(projectPath, {
      enabled: workspace.enabled, customPacks, customCategories, collections: next, issues: [],
    });
    set({ collections: next });
    if (loreStore.scope && sameCollection(loreStore.scope, name)) {
      loreStore.setScope(projectPath, null);
    }
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
      isSamePath(editor.filePath, from) || (!!editor.filePath && isStrictDescendant(from, editor.filePath));
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
    if (isSamePath(activeFilePath, from)) {
      set({ activeFilePath: to });
    } else if (activeFilePath && isStrictDescendant(from, activeFilePath)) {
      set({ activeFilePath: to + activeFilePath.slice(from.length) });
    }
    await get().refreshFileTree();
  },

  copyEntry: async (from, destDir, isDir, newName) => {
    if (isStrictDescendant(from, destDir) || isSamePath(from, destDir)) {
      throw new Error("Cannot copy a folder into itself.");
    }
    // Flush before copying, or the copy captures the last-saved text rather
    // than what is on screen — silently, since nothing else about the copy
    // looks wrong.
    const editor = useEditorStore.getState();
    const editorAffected =
      isSamePath(editor.filePath, from) || (!!editor.filePath && isStrictDescendant(from, editor.filePath));
    if (editorAffected && editor.isDirty) await editor.saveNow();

    const to = await resolveCopyTarget(destDir, newName?.trim() || baseNameOf(from), isDir, fileExists);
    await copyPath(from, to);
    // The copy owns its pictures from the start — sharing the original's
    // asset folder would make deleting the original delete the copy's images.
    if (!isDir) await copyDocumentAssets(from, to);
    await get().refreshFileTree();
    return to;
  },

  deleteEntry: async (path, isDir, opts) => {
    const { projectPath, activeFilePath } = get();
    const affected =
      isSamePath(activeFilePath, path) || (!!activeFilePath && isStrictDescendant(path, activeFilePath));
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
        const flat = baseName(path) || "entry";
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

  collapseAllDirs: () =>
    set((s) => ({ expandedDirs: { ...s.expandedDirs, ...collapseAllMap(s.fileTree) } })),
  setDocCounts: (words, chars) =>
    set((s) => (s.wordCount === words && s.charCount === chars ? s : { wordCount: words, charCount: chars })),
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
 * The project's `@`-pickable files, derived from the tree the sidebar shows.
 *
 * A hook rather than a per-surface scan: the chat composer and the three lore
 * modals all need the same list, and each keeping its own copy is what made a
 * file added after the project opened invisible to `@` (see
 * `projectFilesFromTree`). Recomputed only when the tree object changes —
 * `refreshFileTree` sets a fresh array, so identity is the right trigger.
 */
export function useProjectFiles(): ProjectFile[] {
  const fileTree = useProjectStore((s) => s.fileTree);
  return useMemo(() => projectFilesFromTree(fileTree), [fileTree]);
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
