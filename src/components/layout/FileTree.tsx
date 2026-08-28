import {
  useState, useRef, useEffect, useMemo, createContext, useContext, memo,
  type DragEvent, type KeyboardEvent, type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Folder, FolderOpen, FolderInput, FileText, File, FileCode, FileImage, ChevronRight,
  FilePlus, FolderPlus, FileInput, RotateCw, LogOut, Pencil, Trash2,
  Scissors, Copy, ClipboardPaste, TextCursorInput, AppWindow, Sparkles,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { classifyProjectFile, isHtmlPath, isImagePath, type ProjectFile } from "../../lib/fs/images";
import { fileExists } from "../../lib/fs/fileio";
import { baseNameOf, dropRejection, parentDirOf, type TransferMode } from "../../lib/fs/moveCopy";
import {
  allRows, flattenVisible, isDirOpen, pruneNested, pruneSelection, rangeBetween,
} from "../../lib/fs/selection";
import { insertAtCursor } from "../../lib/editor/format";
import { imageMarkdown } from "../../lib/image/assets";
import { baseName, importDocumentsDialog } from "../../lib/import";
import { useImeGuard } from "../../lib/ime";
import { openInNewWindow } from "../../lib/instance";
import { isSamePath, relativePathFrom } from "../../lib/paths";
import { IS_MAC } from "../../lib/platform";
import { attachProjectFile, attachedKey } from "../../lib/lore/aiTask";
import { useAppStore } from "../../stores/appStore";
import { useComposerStore } from "../../stores/composerStore";
import { useEditorStore } from "../../stores/editorStore";
import { useProjectStore } from "../../stores/projectStore";
import type { FileNode } from "../../lib/project";
import { ContextMenu, type ContextMenuEntry } from "../common/ContextMenu";
import styles from "./FileTree.module.css";

/** A dragged or clipboarded entry — the pair every transfer needs. */
interface TransferSource { path: string; isDir: boolean }

/**
 * Hold Ctrl (or Alt, the macOS convention) while dropping to copy instead of
 * move. Accepting either means the gesture works whichever OS the author's
 * fingers come from.
 */
function isCopyDrag(e: DragEvent): boolean {
  return e.ctrlKey || e.altKey;
}

/**
 * The "add to the selection" modifier: ⌘ on macOS, Ctrl elsewhere. Ctrl is
 * deliberately *not* accepted on macOS — there it opens the context menu, and
 * a Ctrl-click that both toggled the selection and raised a menu would leave
 * the menu acting on a set the author never meant to build.
 */
function isAdditiveClick(e: MouseEvent): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

/** How long a folder must be hovered mid-drag before it springs open. */
const SPRING_OPEN_MS = 700;

/**
 * Replace the drag ghost with a badge naming how many entries are travelling.
 * Without it a multi-entry drag looks exactly like a single-entry one — the
 * browser paints only the row the gesture started on.
 */
function setMultiDragImage(e: DragEvent, label: string): void {
  const ghost = document.createElement("div");
  ghost.textContent = label;
  ghost.className = styles.dragBadge;
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 14, 14);
  // The browser snapshots the element synchronously; it only has to survive
  // this tick.
  window.setTimeout(() => ghost.remove(), 0);
}

// ── Context ───────────────────────────────────────────────────────────────────

interface TreeCtx {
  activeFilePath: string | null;
  /** Paths in the sidebar selection — one after a plain click, more after ⌘/⇧. */
  selected: ReadonlySet<string>;
  /** Click a row: updates the selection, and opens the file unless modified. */
  onRowClick: (e: MouseEvent, node: FileNode) => void;
  creatingIn: string | null;
  creatingType: "file" | "folder";
  startCreate: (parentPath: string, type: "file" | "folder") => void;
  cancelCreate: () => void;
  confirmCreate: (name: string) => Promise<void>;
  createError: string | null;
  renamingPath: string | null;
  renameError: string | null;
  confirmRename: (node: FileNode, name: string) => Promise<void>;
  cancelRename: () => void;
  openMenu: (e: MouseEvent, node: FileNode | null) => void;
  /** Paths being dragged right now, so they can dim themselves. */
  draggingPaths: ReadonlySet<string>;
  /** Path of the folder row currently lit up as the drop target. */
  dragOverDir: string | null;
  /** Paths waiting to be pasted by a cut, dimmed until then. */
  cutPaths: ReadonlySet<string>;
  /** Documents under each folder, at any depth — precomputed once per tree. */
  docCounts: ReadonlyMap<string, number>;
  onDragStart: (e: DragEvent, node: FileNode) => void;
  onDragEnd: () => void;
  onDragOverDir: (e: DragEvent, node: FileNode) => void;
  onDragLeaveDir: (e: DragEvent, node: FileNode) => void;
  onDropInDir: (e: DragEvent, node: FileNode) => void;
}

const TreeCtx = createContext<TreeCtx>(null!);

// ── Inline create input ───────────────────────────────────────────────────────

/**
 * `depth` is the depth of the row the new entry is being created *under* — so
 * a create at the project root passes -1, which lands the input at the same
 * indent as a top-level row.
 */
function CreateInput({ depth }: { depth: number }) {
  const { t } = useTranslation();
  const { cancelCreate, confirmCreate, createError, creatingType } = useContext(TreeCtx);
  const [name, setName] = useState("");
  const submittingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSubmit = async () => {
    const raw = name.trim();
    if (!raw) { cancelCreate(); return; }
    submittingRef.current = true;
    await confirmCreate(raw);
    submittingRef.current = false;
  };

  // A Chinese name is committed with Enter too — that Enter belongs to the IME.
  const ime = useImeGuard();
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (ime.isComposing(e)) return;
    if (e.key === "Enter") { e.preventDefault(); void handleSubmit(); }
    if (e.key === "Escape") cancelCreate();
  };

  const handleBlur = () => {
    if (!submittingRef.current) cancelCreate();
  };

  return (
    <>
      <div
        className={styles.createInputRow}
        style={{ paddingLeft: `${18 + (depth + 1) * 12}px` }}
      >
        <span className={styles.chevron} />
        <span className={styles.nodeIcon}>
          {creatingType === "folder"
            ? <Folder size={14} className={styles.folderIcon} />
            : <FileText size={14} className={styles.fileIcon} />}
        </span>
        <input
          ref={inputRef}
          className={styles.createInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          {...ime.imeProps}
          onBlur={handleBlur}
          placeholder={creatingType === "folder" ? t("fileTree.folderNamePlaceholder") : t("fileTree.fileNamePlaceholder")}
        />
      </div>
      {createError && <div className={styles.createError}>{createError}</div>}
    </>
  );
}

// ── Inline rename input ───────────────────────────────────────────────────────

function RenameInput({ node }: { node: FileNode }) {
  const { cancelRename, confirmRename } = useContext(TreeCtx);
  const [name, setName] = useState(node.name);
  const submittingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Pre-select the basename so typing replaces it but the extension survives.
    const dot = node.is_dir ? -1 : node.name.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : node.name.length);
  }, [node]);

  const handleSubmit = async () => {
    submittingRef.current = true;
    await confirmRename(node, name);
    submittingRef.current = false;
  };

  const ime = useImeGuard();
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (ime.isComposing(e)) return;
    if (e.key === "Enter") { e.preventDefault(); void handleSubmit(); }
    if (e.key === "Escape") cancelRename();
  };

  return (
    <input
      ref={inputRef}
      className={styles.createInput}
      value={name}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={handleKeyDown}
      {...ime.imeProps}
      onBlur={() => { if (!submittingRef.current) cancelRename(); }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}

// ── File icon by extension ────────────────────────────────────────────────────

function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["md", "txt", "markdown"].includes(ext))
    return <FileText size={14} className={styles.fileIcon} />;
  if (isImagePath(name))
    return <FileImage size={14} className={styles.fileIcon} />;
  if (isHtmlPath(name))
    return <FileCode size={14} className={styles.fileIcon} />;
  return <File size={14} className={styles.fileIcon} />;
}

// ── Tree node ─────────────────────────────────────────────────────────────────

// memo: the tree renders one of these per visible row, and the rows all hang
// off one context — memoizing keeps a FileTree-local state change that does
// *not* feed the (memoized) context value, like opening the context menu,
// from re-rendering every row in the project.
const TreeNode = memo(function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const { t } = useTranslation();
  const {
    activeFilePath, selected, onRowClick, creatingIn, startCreate,
    renamingPath, renameError, openMenu,
    draggingPaths, dragOverDir, cutPaths, docCounts,
    onDragStart, onDragEnd, onDragOverDir, onDragLeaveDir, onDropInDir,
  } = useContext(TreeCtx);
  // Expansion is stored per project (projectStore.expandedDirs), not per node:
  // the sidebar's tab transition remounts this tree, so local state would
  // collapse every folder the author opened whenever they looked at another tab.
  // `isDirOpen` owns the default so the rendered tree and the flattened one the
  // selection ranges over cannot disagree about which rows exist.
  const stored = useProjectStore((s) => s.expandedDirs[node.path]);
  const open = isDirOpen(stored, depth);
  const setOpen = (next: boolean) =>
    useProjectStore.getState().setDirExpanded(node.path, next);
  const isActive = !node.is_dir && isSamePath(activeFilePath, node.path);
  const isRenaming = renamingPath === node.path;
  // 设计稿 01: 卷行右侧带章数 — the documents under this folder, at any depth.
  const docCount = node.is_dir ? (docCounts.get(node.path) ?? 0) : 0;

  // Auto-expand when this folder becomes the target of an inline create
  // (context menu can trigger creates on collapsed folders).
  useEffect(() => {
    if (creatingIn === node.path) {
      useProjectStore.getState().setDirExpanded(node.path, true);
    }
  }, [creatingIn, node.path]);

  const handleClick = (e: MouseEvent) => {
    if (isRenaming) return;
    onRowClick(e, node);
    // A modified click is about building a selection, nothing else: opening a
    // document or toggling a folder on the way would undo what the author is
    // in the middle of assembling.
    if (e.shiftKey || isAdditiveClick(e)) return;
    if (node.is_dir) setOpen(!open);
  };

  const classes = [
    styles.node,
    isActive ? styles.active : "",
    selected.has(node.path) ? styles.selected : "",
    draggingPaths.has(node.path) ? styles.dragging : "",
    dragOverDir === node.path ? styles.dropTarget : "",
    cutPaths.has(node.path) ? styles.cut : "",
  ].filter(Boolean).join(" ");

  return (
    <div>
      <div
        className={classes}
        style={{ paddingLeft: `${18 + depth * 12}px` }}
        onClick={handleClick}
        onContextMenu={(e) => openMenu(e, node)}
        // Renaming turns the label into a text input; a draggable ancestor
        // would steal the pointer before a selection could be made.
        draggable={!isRenaming}
        onDragStart={(e) => onDragStart(e, node)}
        onDragEnd={onDragEnd}
        onDragOver={(e) => onDragOverDir(e, node)}
        onDragLeave={(e) => onDragLeaveDir(e, node)}
        onDrop={(e) => onDropInDir(e, node)}
        role="button"
        tabIndex={-1}
      >
        <span className={styles.chevron}>
          {node.is_dir && (
            <ChevronRight
              size={12}
              className={`${styles.chevronIcon} ${open ? styles.open : ""}`}
            />
          )}
        </span>
        <span className={styles.nodeIcon}>
          {node.is_dir
            ? open
              ? <FolderOpen size={14} className={styles.folderIcon} />
              : <Folder size={14} className={styles.folderIcon} />
            : <FileIcon name={node.name} />}
        </span>
        {isRenaming
          ? <RenameInput node={node} />
          : (
            <span className={styles.label}>
              {node.is_dir ? node.name : node.name.replace(/\.md$/i, "")}
            </span>
          )}

        {node.is_dir && !isRenaming && docCount > 0 && (
          <span className={styles.dirCount}>{docCount}</span>
        )}

        {node.is_dir && !isRenaming && (
          <span className={styles.nodeActions} onClick={(e) => e.stopPropagation()}>
            <button
              className={styles.nodeActionBtn}
              title={t("fileTree.newFile")}
              onClick={() => { setOpen(true); startCreate(node.path, "file"); }}
            >
              <FilePlus size={12} />
            </button>
            <button
              className={styles.nodeActionBtn}
              title={t("fileTree.newFolder")}
              onClick={() => { setOpen(true); startCreate(node.path, "folder"); }}
            >
              <FolderPlus size={12} />
            </button>
          </span>
        )}
      </div>
      {isRenaming && renameError && (
        <div className={styles.createError}>{renameError}</div>
      )}

      {node.is_dir && open && (
        <div>
          {creatingIn === node.path && <CreateInput depth={depth} />}
          {node.children?.map((child) => (
            <TreeNode key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
});

// ── Context menu ──────────────────────────────────────────────────────────────

interface CtxMenuState { x: number; y: number; node: FileNode | null }

// ── Main FileTree ─────────────────────────────────────────────────────────────

export function FileTree() {
  const { t } = useTranslation();
  // Field selectors, not a whole-store destructure: projectStore is also where
  // the word/char counters live, and those are written on every keystroke —
  // an unselected subscription re-rendered the entire tree per character typed.
  const fileTree = useProjectStore((s) => s.fileTree);
  const expandedDirs = useProjectStore((s) => s.expandedDirs);
  const projectPath = useProjectStore((s) => s.projectPath);
  const refreshFileTree = useProjectStore((s) => s.refreshFileTree);
  const activeFilePath = useProjectStore((s) => s.activeFilePath);
  const setActiveFilePath = useProjectStore((s) => s.setActiveFilePath);
  const openProject = useProjectStore((s) => s.openProject);
  const closeProject = useProjectStore((s) => s.closeProject);
  const createEntry = useProjectStore((s) => s.createEntry);
  const moveEntry = useProjectStore((s) => s.moveEntry);
  const copyEntry = useProjectStore((s) => s.copyEntry);
  const deleteEntry = useProjectStore((s) => s.deleteEntry);
  const clipboard = useProjectStore((s) => s.clipboard);
  const setClipboard = useProjectStore((s) => s.setClipboard);

  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [creatingType, setCreatingType] = useState<"file" | "folder">("file");
  const [createError, setCreateError] = useState<string | null>(null);
  const [menu, setMenu] = useState<CtxMenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [draggingPaths, setDraggingPaths] = useState<ReadonlySet<string>>(new Set());
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Where a shift-range starts. Held separately from the selection because it
  // must survive the range being redrawn: dragging a shift-click up and down
  // has to grow and shrink one span, not chain new ones off the last row.
  const [anchor, setAnchor] = useState<string | null>(null);
  // The dragged entries also live in a ref: `dragover` fires dozens of times a
  // second and cannot read dataTransfer (browsers withhold it until the drop),
  // so the validity check has to consult something synchronous.
  const dragRef = useRef<TransferSource[] | null>(null);
  const springTimer = useRef<{ path: string; id: number } | null>(null);

  // Every row of the tree, and the subset currently on screen. The first
  // answers "what does this selected path point at"; the second is what a
  // shift-range walks, since a range must not reach into a collapsed folder.
  const everyRow = useMemo(() => allRows(fileTree), [fileTree]);
  const visibleRows = useMemo(
    () => flattenVisible(fileTree, expandedDirs),
    [fileTree, expandedDirs],
  );

  // 卷行右侧的章数, one walk for the whole tree. Each directory row counting
  // its own subtree on every render was O(nodes × depth) per tree render.
  const docCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const walk = (node: FileNode): number => {
      let n = 0;
      for (const child of node.children ?? []) {
        if (child.is_dir) n += walk(child);
        else if (/\.md$/i.test(child.name)) n++;
      }
      counts.set(node.path, n);
      return n;
    };
    for (const node of fileTree) if (node.is_dir) walk(node);
    return counts;
  }, [fileTree]);

  // A selection outlives the gesture that acted on it — a move rewrites every
  // selected path, a delete removes them — so anything no longer on disk has
  // to drop out before it can widen the *next* gesture.
  useEffect(() => {
    setSelected((prev) => {
      const next = pruneSelection(prev, everyRow);
      return next.size === prev.size ? prev : next;
    });
  }, [everyRow]);

  // Opening a document from anywhere else (command palette, outline, a link)
  // moves the selection with it, so the sidebar never shows one file open and
  // a different one selected.
  useEffect(() => {
    if (!activeFilePath) return;
    setSelected((prev) => (prev.has(activeFilePath) ? prev : new Set([activeFilePath])));
    setAnchor(activeFilePath);
  }, [activeFilePath]);

  /** The selected rows, in tree order, as transfer sources. */
  const selectedSources = (): TransferSource[] =>
    everyRow.filter((r) => selected.has(r.path)).map((r) => ({ path: r.path, isDir: r.isDir }));

  /**
   * Whether 插入到当前位置 has anywhere to insert *into*: a markdown document
   * open in a live editor, which is where the cursor is. EditorArea swaps the
   * CodeEditor out for an image preview or a load notice, and `editorView` is
   * null for exactly those — so it answers the question on its own.
   */
  const openDocPath = useEditorStore((s) => s.filePath);
  const hasLiveEditor = useEditorStore((s) => s.editorView !== null);
  const canInsertIntoDoc = hasLiveEditor && !!openDocPath && /\.md$/i.test(openDocPath);

  const cancelSpring = () => {
    if (springTimer.current) clearTimeout(springTimer.current.id);
    springTimer.current = null;
  };

  /** Open a collapsed folder that has been hovered long enough mid-drag. */
  const scheduleSpring = (path: string) => {
    if (springTimer.current?.path === path) return;
    cancelSpring();
    const id = window.setTimeout(() => {
      useProjectStore.getState().setDirExpanded(path, true);
      springTimer.current = null;
    }, SPRING_OPEN_MS);
    springTimer.current = { path, id };
  };

  const endDrag = () => {
    cancelSpring();
    dragRef.current = null;
    setDraggingPaths(new Set());
    setDragOverDir(null);
  };

  useEffect(() => cancelSpring, []);

  // ── Selection ───────────────────────────────────────────────────────────────

  const onRowClick = (e: MouseEvent, node: FileNode) => {
    if (e.shiftKey && anchor) {
      const range = rangeBetween(visibleRows, anchor, node.path);
      if (range.length > 0) {
        setSelected(new Set(range));
        return; // anchor stays put, so the span can be redrawn from it
      }
    }
    if (isAdditiveClick(e)) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (!next.delete(node.path)) next.add(node.path);
        return next;
      });
      setAnchor(node.path);
      return;
    }
    setSelected(new Set([node.path]));
    setAnchor(node.path);
    if (!node.is_dir) setActiveFilePath(node.path);
  };

  const clearSelection = () => {
    setSelected(new Set());
    setAnchor(null);
  };

  // ── Transfers ───────────────────────────────────────────────────────────────

  /**
   * Move or copy entries into `destDir` — the one path behind the drop
   * gesture, the paste menu item and the root drop zone, so they cannot drift
   * apart.
   *
   * Every source is attempted: one entry that cannot land (an occupied name, a
   * folder dropped into itself) must not strand the rest of a multi-selection
   * halfway. What did fail is reported together at the end.
   */
  const transferMany = async (
    sources: readonly TransferSource[],
    destDir: string,
    mode: TransferMode,
  ) => {
    setTransferError(null);
    const errors: string[] = [];
    const landed: string[] = [];
    // A folder carries its contents, so a selection holding both is not a
    // conflict — the descendants are simply already covered.
    for (const src of pruneNested(sources)) {
      const rejection = dropRejection(src.path, destDir, mode);
      // "same-parent" means the entry was dropped back where it already is —
      // an accident, not a failure, so it passes silently.
      if (rejection === "same-parent") continue;
      if (rejection === "into-self") { errors.push(t("fileTree.moveIntoSelf")); continue; }
      const name = baseNameOf(src.path);
      try {
        if (mode === "copy") {
          landed.push(await copyEntry(src.path, destDir, src.isDir));
        } else {
          // moveEntry refuses an occupied destination too; checking here is
          // what turns that into a sentence naming the file, in the author's
          // language.
          const dest = `${destDir}/${name}`;
          if (await fileExists(dest)) {
            errors.push(t("fileTree.moveExists", { name }));
            continue;
          }
          await moveEntry(src.path, dest);
          landed.push(dest);
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    // De-duplicated: five files blocked by the same folder is one sentence.
    setTransferError(errors.length > 0 ? [...new Set(errors)].join(" ") : null);
    if (landed.length > 0) {
      useProjectStore.getState().setDirExpanded(destDir, true);
      // Follow the entries to where they went. Leaving the selection on the
      // old paths would let the next gesture act on a set that no longer
      // exists, and the author has just said these are the entries they care
      // about.
      setSelected(new Set(landed));
      setAnchor(landed[landed.length - 1]);
    }
  };

  /** Whether at least one dragged entry could land in `destDir`. */
  const canDropInto = (destDir: string, mode: TransferMode): boolean => {
    const sources = dragRef.current;
    return !!sources && sources.some((s) => !dropRejection(s.path, destDir, mode));
  };

  const onDragStart = (e: DragEvent, node: FileNode) => {
    // Dragging a row inside the selection carries the whole selection;
    // dragging one outside it means the author changed their mind about what
    // they were pointing at, so the selection follows the pointer.
    let sources: TransferSource[];
    if (selected.has(node.path) && selected.size > 1) {
      sources = selectedSources();
    } else {
      sources = [{ path: node.path, isDir: node.is_dir }];
      setSelected(new Set([node.path]));
      setAnchor(node.path);
    }
    sources = pruneNested(sources);
    dragRef.current = sources;
    setDraggingPaths(new Set(sources.map((s) => s.path)));
    setTransferError(null);
    e.dataTransfer.effectAllowed = "copyMove";
    // Some engines abort a drag that carries no payload at all.
    e.dataTransfer.setData("text/plain", sources.map((s) => s.path).join("\n"));
    if (sources.length > 1) {
      setMultiDragImage(e, t("fileTree.dragCount", { count: sources.length }));
    }
  };

  const onDragOverDir = (e: DragEvent, node: FileNode) => {
    // The row decides, always — letting the event reach the container would
    // make the tree's root drop zone silently claim a drag aimed at a file.
    if (!dragRef.current) return; // an OS file drag must fall through untouched
    e.stopPropagation();
    if (!node.is_dir || !canDropInto(node.path, isCopyDrag(e) ? "copy" : "move")) {
      cancelSpring();
      setDragOverDir(null);
      return; // no preventDefault → the row shows "no drop" and fires no drop
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = isCopyDrag(e) ? "copy" : "move";
    setDragOverDir(node.path);
    scheduleSpring(node.path);
  };

  const onDragLeaveDir = (e: DragEvent, node: FileNode) => {
    // The row's own icon and label are children: moving onto them fires
    // dragleave, and reacting to that would cancel the spring-open timer on
    // every pixel of travel.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (springTimer.current?.path === node.path) cancelSpring();
    setDragOverDir((cur) => (cur === node.path ? null : cur));
  };

  const onDropInDir = (e: DragEvent, node: FileNode) => {
    if (!dragRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const sources = dragRef.current;
    const mode: TransferMode = isCopyDrag(e) ? "copy" : "move";
    endDrag();
    if (node.is_dir) void transferMany(sources, node.path, mode);
  };

  // ── Root drop zone ──────────────────────────────────────────────────────────
  // The empty space of the tree is the project root. Without it the root is the
  // one folder an entry can be dragged *out of* but never back into — the
  // workspace is the whole project directory now, and its top level has to be
  // as reachable as any folder in it.

  const onDragOverTree = (e: DragEvent) => {
    if (!dragRef.current || !projectPath) return;
    if (!canDropInto(projectPath, isCopyDrag(e) ? "copy" : "move")) {
      setDragOverDir(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = isCopyDrag(e) ? "copy" : "move";
    cancelSpring();
    setDragOverDir(projectPath);
  };

  const onDragLeaveTree = (e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOverDir((cur) => (cur === projectPath ? null : cur));
  };

  const onDropInTree = (e: DragEvent) => {
    const sources = dragRef.current;
    if (!sources || !projectPath) return;
    e.preventDefault();
    const mode: TransferMode = isCopyDrag(e) ? "copy" : "move";
    endDrag();
    void transferMany(sources, projectPath, mode);
  };

  /** Where a paste aimed at this row lands: a folder itself, else its parent. */
  const pasteTargetOf = (node: FileNode | null): string | null => {
    if (!node) return projectPath || null;
    return node.is_dir ? node.path : parentDirOf(node.path);
  };

  const handlePaste = async (node: FileNode | null) => {
    const dest = pasteTargetOf(node);
    if (!clipboard || !dest) return;
    await transferMany(clipboard.entries, dest, clipboard.mode);
    // A cut is spent once pasted; a copy stays, so it can be pasted again.
    if (clipboard.mode === "move") setClipboard(null);
  };

  // Bring picked files into destDir: docx/xlsx/pdf are converted to markdown,
  // text (txt/md/html) and images are copied in as-is (see lib/import).
  // Single-flight: a pdf conversion can take seconds, and a second dialog over
  // a running batch would interleave two writes into the same folder.
  const handleImport = async (destDir: string) => {
    if (importing) return;
    setImporting(true);
    try {
      const outcome = await importDocumentsDialog(destDir, t("fileTree.importFilter"));
      if (!outcome) return;
      if (outcome.imported.length > 0) {
        await refreshFileTree();
        setActiveFilePath(outcome.imported[0].path);
      }
      if (outcome.failures.length > 0) {
        const lines = outcome.failures.map((f) => `${baseName(f.source)}: ${f.error}`);
        window.alert(`${t("fileTree.importFailed")}\n${lines.join("\n")}`);
      }
    } finally {
      setImporting(false);
    }
  };

  const startCreate = (parentPath: string, type: "file" | "folder") => {
    setCreatingIn(parentPath);
    setCreatingType(type);
    setCreateError(null);
  };

  const cancelCreate = () => {
    setCreatingIn(null);
    setCreateError(null);
  };

  const confirmCreate = async (name: string) => {
    if (!creatingIn) return;
    try {
      const path = await createEntry(creatingIn, name, creatingType);
      if (creatingType === "file") setActiveFilePath(path);
      setSelected(new Set([path]));
      setAnchor(path);
      cancelCreate();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    }
  };

  const startRename = (node: FileNode) => {
    setMenu(null);
    setRenamingPath(node.path);
    setRenameError(null);
  };

  const cancelRename = () => {
    setRenamingPath(null);
    setRenameError(null);
  };

  const confirmRename = async (node: FileNode, rawName: string) => {
    const name = rawName.trim();
    if (!name || name === node.name) { cancelRename(); return; }
    try {
      await moveEntry(node.path, `${parentDirOf(node.path)}/${name}`);
      cancelRename();
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Delete every target behind one confirmation. Failures are logged rather
   * than raised: a delete that fails partway through a selection should still
   * remove the entries it can, and the tree refresh shows what survived.
   *
   * With `backup` — the sidebar offers no undo of its own, and the agent's
   * deletes have always been snapshotted; the author's own hand deserves at
   * least the safety net the model gets. The confirm copy says where the
   * snapshot goes, so 确认 is informed rather than a leap.
   */
  const handleDelete = async (targets: readonly TransferSource[]) => {
    setMenu(null);
    const ok = window.confirm(
      targets.length > 1
        ? t("fileTree.deleteManyConfirm", { count: targets.length })
        : t(targets[0].isDir ? "fileTree.deleteFolderConfirm" : "fileTree.deleteConfirm"),
    );
    if (!ok) return;
    for (const target of pruneNested(targets)) {
      try {
        await deleteEntry(target.path, target.isDir, { backup: true });
      } catch (err) {
        console.error("[fileTree] delete failed:", err);
      }
    }
    clearSelection();
  };

  const openMenu = (e: MouseEvent, node: FileNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    // Right-clicking outside the selection retargets it, the way every file
    // manager does — otherwise 删除 5 项 could appear over a row that is not
    // one of the five.
    if (node && !selected.has(node.path)) {
      setSelected(new Set([node.path]));
      setAnchor(node.path);
    }
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  /**
   * Link a picture from the tree into the open document at the cursor.
   *
   * A **relative link to where the file already is** — it is inside the project
   * the author picked it from, so copying it would put a second one beside the
   * first and leave them to notice the duplicate later. (The editor's own
   * 插入图片… does copy, because there the file comes from outside the project
   * and a link to it would break the moment the folder moves machines.)
   *
   * Relative rather than absolute for the same reason as every other
   * illustration link: it has to survive the project being synced, moved, or
   * opened on another machine.
   */
  const insertImageIntoDoc = (node: FileNode) => {
    setMenu(null);
    const { filePath, editorView } = useEditorStore.getState();
    if (!editorView || !filePath) return;
    const rel = relativePathFrom(parentDirOf(filePath), node.path);
    // Alt text stands in for the picture wherever it can't be shown — a
    // text-only model reading the document, the exported HTML. The filename is
    // the only description available here.
    insertAtCursor(editorView, imageMarkdown(rel, node.name.replace(/\.[^.]+$/, "")));
  };

  /**
   * 发送到助手：把这份文件作为 `@` 引用挂进对话助手的输入框，并打开抽屉。
   *
   * 与 `@` 选择器同一条构造路（attachProjectFile）、同一份去重键——从树上送
   * 过去和在输入框里 @ 出来，得到的是同一种附件，也照 `@` 的约定在草稿里落
   * 一个 `@[名字]`。图片不看当前模型是否读图：树不认识模型，作者发送前还可
   * 能换模型，而 buildChatMessage 对读不了图的模型会点名附件并给出 vision
   * 子代理的读法——降级是诚实的，不值得为它把 AI 配置耦合进文件树。
   */
  const sendToAssistant = async (file: ProjectFile) => {
    setMenu(null);
    const outcome = await attachProjectFile(file);
    if (!outcome.ok) {
      window.alert(
        outcome.reason === "too-large"
          ? t("ai.chat.imageTooLarge", { name: file.name, size: outcome.sizeMb, max: outcome.maxMb })
          : t("ai.chat.refUnreadable", { name: file.name }),
      );
      return;
    }
    const { chatRefs, setChatRefs, setChatDraft } = useComposerStore.getState();
    if (!chatRefs.some((r) => attachedKey(r) === attachedKey(outcome.item))) {
      setChatRefs((prev) => [...prev, outcome.item]);
      setChatDraft((prev) => {
        const sep = prev && !/\s$/.test(prev) ? " " : "";
        return `${prev}${sep}@[${file.name}] `;
      });
    }
    // 已经挂着同一份时只打开抽屉——重复的 chip 和重复的 @ 都是噪声。
    useAppStore.getState().setShowAiDrawer(true, "chat");
  };

  const buildMenuItems = (node: FileNode | null): ContextMenuEntry[] => {
    const reveal = (path: string) => {
      revealItemInDir(path).catch(() => { /* best-effort */ });
    };

    /**
     * The paste entry, or nothing when the clipboard is empty — an item that is
     * always there but usually greyed out is noise in a menu this short.
     */
    const pasteItem = (): ContextMenuEntry[] => {
      if (!clipboard) return [];
      const dest = pasteTargetOf(node);
      const blocked =
        !dest || clipboard.entries.every((entry) => !!dropRejection(entry.path, dest, clipboard.mode));
      return [{
        kind: "item",
        icon: <ClipboardPaste size={13} />,
        label: clipboard.entries.length > 1
          ? t("fileTree.pasteEntries", { count: clipboard.entries.length })
          : t("fileTree.pasteEntry", { name: baseNameOf(clipboard.entries[0].path) }),
        disabled: blocked,
        action: () => void handlePaste(node),
      }];
    };

    if (!node) {
      return [
        { kind: "item", icon: <FilePlus size={13} />, label: t("fileTree.newFile"),
          action: () => { if (projectPath) startCreate(projectPath, "file"); } },
        { kind: "item", icon: <FolderPlus size={13} />, label: t("fileTree.newFolder"),
          action: () => { if (projectPath) startCreate(projectPath, "folder"); } },
        { kind: "item", icon: <FileInput size={13} />, label: t("fileTree.importDoc"),
          action: () => { if (projectPath) void handleImport(projectPath); } },
        ...pasteItem(),
        { kind: "divider" },
        { kind: "item", icon: <FolderOpen size={13} />, label: t("fileTree.reveal"),
          action: () => { if (projectPath) reveal(projectPath); } },
        { kind: "item", icon: <RotateCw size={13} />, label: t("fileTree.refresh"),
          action: () => void refreshFileTree() },
      ];
    }

    // `openMenu` has already made sure the clicked row is in the selection, so
    // the menu can act on all of it. Everything that only makes sense for one
    // entry — 打开, 重命名, 新建 — drops out when there are several.
    const targets = selected.has(node.path) && selected.size > 1
      ? selectedSources()
      : [{ path: node.path, isDir: node.is_dir }];
    const count = targets.length;

    if (count > 1) {
      return [
        { kind: "item", icon: <Scissors size={13} />, label: t("fileTree.cutMany", { count }),
          action: () => setClipboard({ entries: targets, mode: "move" }) },
        { kind: "item", icon: <Copy size={13} />, label: t("fileTree.copyMany", { count }),
          action: () => setClipboard({ entries: targets, mode: "copy" }) },
        ...pasteItem(),
        { kind: "divider" },
        { kind: "item", icon: <Trash2 size={13} />, label: t("fileTree.deleteMany", { count }),
          danger: true, action: () => void handleDelete(targets) },
      ];
    }

    const items: ContextMenuEntry[] = [];
    if (node.is_dir) {
      items.push(
        { kind: "item", icon: <FilePlus size={13} />, label: t("fileTree.newFile"),
          action: () => startCreate(node.path, "file") },
        { kind: "item", icon: <FolderPlus size={13} />, label: t("fileTree.newFolder"),
          action: () => startCreate(node.path, "folder") },
        { kind: "item", icon: <FileInput size={13} />, label: t("fileTree.importDoc"),
          action: () => void handleImport(node.path) },
      );
    } else {
      items.push(
        { kind: "item", icon: <FileText size={13} />, label: t("fileTree.open"),
          action: () => setActiveFilePath(node.path) },
      );
      // Only on files the assistant can take (the `@` picker's own kinds) —
      // on a .docx the entry would be a promise the composer can't keep.
      const attachable = classifyProjectFile(node.name, node.path);
      if (attachable) {
        items.push({
          kind: "item",
          icon: <Sparkles size={13} />,
          label: t("fileTree.sendToAssistant"),
          action: () => void sendToAssistant(attachable),
        });
      }
      // Only on a picture, so it isn't noise on every file — but shown greyed
      // rather than hidden when there is nowhere to insert into: the author
      // right-clicked an image meaning to place it, and a missing entry would
      // read as "this app can't do that" instead of "open a document first".
      if (isImagePath(node.path)) {
        items.push({
          kind: "item",
          icon: <TextCursorInput size={13} />,
          label: t("fileTree.insertImage"),
          disabled: !canInsertIntoDoc,
          action: () => insertImageIntoDoc(node),
        });
      }
    }
    items.push(
      { kind: "divider" },
      { kind: "item", icon: <Scissors size={13} />, label: t("fileTree.cut"),
        action: () => setClipboard({ entries: targets, mode: "move" }) },
      { kind: "item", icon: <Copy size={13} />, label: t("fileTree.copy"),
        action: () => setClipboard({ entries: targets, mode: "copy" }) },
      ...pasteItem(),
      { kind: "divider" },
      { kind: "item", icon: <Pencil size={13} />, label: t("fileTree.rename"),
        action: () => startRename(node) },
      { kind: "item", icon: <FolderOpen size={13} />, label: t("fileTree.reveal"),
        action: () => reveal(node.path) },
      { kind: "divider" },
      { kind: "item", icon: <Trash2 size={13} />, label: t("fileTree.delete"), danger: true,
        action: () => void handleDelete(targets) },
    );
    return items;
  };

  const projectName = baseName(projectPath ?? "").toUpperCase();
  const creatingAtRoot = !!projectPath && creatingIn === projectPath;

  const cutPaths = useMemo<ReadonlySet<string>>(
    () =>
      clipboard?.mode === "move"
        ? new Set(clipboard.entries.map((entry) => entry.path))
        : new Set<string>(),
    [clipboard],
  );

  // The handlers above close over fresh state each render, so putting them in
  // the context directly would give it a new identity every render — and a new
  // context value re-renders every row, memo or not. The context instead
  // carries stable forwarders that read the current handlers through a ref
  // (updated in an effect; events only ever fire after effects have run).
  const handlers = {
    onRowClick, startCreate, cancelCreate, confirmCreate, confirmRename,
    cancelRename, openMenu, onDragStart, onDragEnd: endDrag,
    onDragOverDir, onDragLeaveDir, onDropInDir,
  };
  const handlersRef = useRef(handlers);
  useEffect(() => { handlersRef.current = handlers; });
  const stableHandlers = useMemo<Pick<TreeCtx, keyof typeof handlers>>(() => ({
    onRowClick: (e, node) => handlersRef.current.onRowClick(e, node),
    startCreate: (parentPath, type) => handlersRef.current.startCreate(parentPath, type),
    cancelCreate: () => handlersRef.current.cancelCreate(),
    confirmCreate: (name) => handlersRef.current.confirmCreate(name),
    confirmRename: (node, name) => handlersRef.current.confirmRename(node, name),
    cancelRename: () => handlersRef.current.cancelRename(),
    openMenu: (e, node) => handlersRef.current.openMenu(e, node),
    onDragStart: (e, node) => handlersRef.current.onDragStart(e, node),
    onDragEnd: () => handlersRef.current.onDragEnd(),
    onDragOverDir: (e, node) => handlersRef.current.onDragOverDir(e, node),
    onDragLeaveDir: (e, node) => handlersRef.current.onDragLeaveDir(e, node),
    onDropInDir: (e, node) => handlersRef.current.onDropInDir(e, node),
  }), []);

  const ctx = useMemo<TreeCtx>(() => ({
    activeFilePath,
    selected,
    creatingIn,
    creatingType,
    createError,
    renamingPath,
    renameError,
    draggingPaths,
    dragOverDir,
    cutPaths,
    docCounts,
    ...stableHandlers,
  }), [
    activeFilePath, selected, creatingIn, creatingType, createError,
    renamingPath, renameError, draggingPaths, dragOverDir, cutPaths,
    docCounts, stableHandlers,
  ]);

  return (
    <TreeCtx.Provider value={ctx}>
      <div className={styles.container}>
        {/* Toolbar with project name + actions */}
        <div className={styles.toolbar}>
          <span className={styles.rootLabel}>{projectName}</span>
          <span className={styles.toolbarActions}>
            <button
              className={styles.toolbarBtn}
              title={t("project.switchProject")}
              onClick={() => void openProject()}
            >
              <FolderInput size={14} />
            </button>
            {/* A second workspace side by side: a sibling *process* (the
                stores are singletons sized to one project — see lib/instance),
                started blank on purpose — handing it the current project
                would just bounce: the sibling finds the folder held here,
                focuses this window and closes itself. */}
            <button
              className={styles.toolbarBtn}
              title={t("project.newWindow")}
              onClick={() => void openInNewWindow().catch((e) => console.warn("[instance]", e))}
            >
              <AppWindow size={14} />
            </button>
            <button
              className={styles.toolbarBtn}
              title={t("project.closeProject")}
              onClick={() => void closeProject()}
            >
              <LogOut size={14} />
            </button>
            <button
              className={styles.toolbarBtn}
              title={t("fileTree.newFileAtRoot")}
              onClick={() => projectPath && startCreate(projectPath, "file")}
            >
              <FilePlus size={14} />
            </button>
            <button
              className={styles.toolbarBtn}
              title={t("fileTree.newFolderAtRoot")}
              onClick={() => projectPath && startCreate(projectPath, "folder")}
            >
              <FolderPlus size={14} />
            </button>
            <button
              className={styles.toolbarBtn}
              title={t("fileTree.importDoc")}
              disabled={importing}
              onClick={() => projectPath && void handleImport(projectPath)}
            >
              <FileInput size={14} />
            </button>
            <button
              className={styles.toolbarBtn}
              title={t("fileTree.refresh")}
              onClick={() => void refreshFileTree()}
            >
              <RotateCw size={13} />
            </button>
          </span>
        </div>

        {/* Why the last move/copy could not happen. Click to dismiss. */}
        {transferError && (
          <div
            className={styles.transferError}
            role="alert"
            onClick={() => setTransferError(null)}
          >
            {transferError}
          </div>
        )}

        {/* Tree or empty state. The container itself is the project root: its
            empty space takes drops, its background clears the selection, and
            a root-level create renders its input here rather than under a row
            (the root has no row of its own — `readDirRecursive` returns the
            project's children, not the project). */}
        <div
          className={`${styles.tree} ${dragOverDir === projectPath ? styles.rootDropTarget : ""}`}
          onContextMenu={(e) => openMenu(e, null)}
          onClick={(e) => { if (e.target === e.currentTarget) clearSelection(); }}
          onDragOver={onDragOverTree}
          onDragLeave={onDragLeaveTree}
          onDrop={onDropInTree}
        >
          {creatingAtRoot && <CreateInput depth={-1} />}
          {fileTree.length === 0 && !creatingAtRoot ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyText}>{t("project.emptyTree")}</div>
              <button
                className={styles.createBtn}
                onClick={() => projectPath && startCreate(projectPath, "file")}
              >
                <FilePlus size={13} />
                {t("fileTree.newFile")}
              </button>
            </div>
          ) : (
            fileTree.map((node) => (
              <TreeNode key={node.path} node={node} depth={0} />
            ))
          )}
        </div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.node)}
          onClose={() => setMenu(null)}
        />
      )}
    </TreeCtx.Provider>
  );
}
