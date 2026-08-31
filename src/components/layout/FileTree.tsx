import {
  useState, useRef, useEffect, useMemo, createContext, useContext, memo,
  type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Folder, FolderOpen, FileText, File, FileCode, FileImage, ChevronRight,
  FilePlus, FolderPlus, FileInput, RotateCw, Pencil, Trash2, AlertTriangle,
  Scissors, Copy, ClipboardPaste, TextCursorInput, Sparkles, Images,
  ChevronsDownUp, ChevronsUpDown, MoreHorizontal, Crosshair, Link2, FileOutput,
  Monitor, Presentation,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { classifyProjectFile, isImagePath, type ProjectFile } from "../../lib/fs/images";
import { fileExists, previewHtmlWindow } from "../../lib/fs/fileio";
import { baseNameOf, dropRejection, parentDirOf, type TransferMode } from "../../lib/fs/moveCopy";
import {
  allRows, ancestorsOf, flattenVisible, hasOpenDir, isDirOpen, openDirCount,
  pruneNested, pruneSelection, rangeBetween,
} from "../../lib/fs/selection";
import {
  extLabel, isSecondary, orphanedAssetGroups, relinkCandidates, rowKind, type RowKind,
} from "../../lib/fs/rowMeta";
import { insertAtCursor } from "../../lib/editor/format";
import { imageMarkdown } from "../../lib/image/assets";
import { baseName, convertExtOf, convertProjectFile, importDocumentsDialog } from "../../lib/import";
import { useImeGuard } from "../../lib/ime";
import { isPptxExportEnabled } from "../../lib/pptx/flag";
import { isSamePath, relativePathFrom } from "../../lib/paths";
import { IS_MAC } from "../../lib/platform";
import { comboLabel, matchesCombo } from "../../lib/shortcuts";
import { attachProjectFile, attachedKey } from "../../lib/lore/aiTask";
import { useAppStore } from "../../stores/appStore";
import { useComposerStore } from "../../stores/composerStore";
import { useEditorStore } from "../../stores/editorStore";
import { useLoreStore } from "../../stores/loreStore";
import { useProjectStore, useTerms } from "../../stores/projectStore";
import { loreEntityCount } from "../../lib/lore";
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

/** How long 「已折叠 N 个分组」 stays before it fades out on its own. */
const NOTICE_MS = 4000;

/** 工具行与右键菜单里共用的绑定 —— 标签与行为出自同一个常量。 */
const COMBO_COLLAPSE_ALL = { mod: true, alt: true, key: "ArrowLeft" } as const;
/**
 * 设计稿写的是 ⇧⌘L，但那已经是「AI 润色」的全局绑定（lib/shortcuts.ts），而两个
 * dispatch 级的绑定撞在一起是静默的：先注册的赢，另一个永远不响。⌥⌘L 空着。
 */
const COMBO_REVEAL_DOC = { mod: true, alt: true, key: "l" } as const;
const COMBO_NEW_DOC = { mod: true, key: "n" } as const;
const COMBO_NEW_GROUP = { mod: true, shift: true, key: "n" } as const;

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
  /** The folder counting down to a spring-open, so its chevron can fill. */
  springPath: string | null;
  /** Paths waiting to be pasted by a cut, dimmed until then. */
  cutPaths: ReadonlySet<string>;
  /** Documents under each folder, at any depth — precomputed once per tree. */
  docCounts: ReadonlyMap<string, number>;
  /** `assets/<组>` folders whose document is gone — one walk, not a lookup per row. */
  orphanAssets: ReadonlySet<string>;
  /** The delete confirmation, rendered under the last row it would remove. */
  deleteAsk: { afterPath: string; text: string } | null;
  confirmDelete: () => void;
  cancelDelete: () => void;
  /** 失配 `assets/<组>` 的修复选择器，长在那一行下面。 */
  relinkAsk: { groupPath: string; candidates: readonly FileNode[] } | null;
  confirmRelink: (docPath: string) => void;
  cancelRelink: () => void;
  onDragStart: (e: DragEvent, node: FileNode) => void;
  onDragEnd: () => void;
  onDragOverDir: (e: DragEvent, node: FileNode) => void;
  onDragLeaveDir: (e: DragEvent, node: FileNode) => void;
  onDropInDir: (e: DragEvent, node: FileNode) => void;
}

const TreeCtx = createContext<TreeCtx>(null!);

/** `--depth` drives the row's indent in CSS — see FileTree.module.css `.node`. */
function depthVar(depth: number): CSSProperties {
  return { "--depth": depth } as CSSProperties;
}

// ── Row icon ──────────────────────────────────────────────────────────────────

/**
 * 六种图标，两级灰，一个颜色都不加（设计稿 17 §2g）：这个面板只有一个强调色，而
 * 赭石已经被「当前打开」和「选区」占满 —— 再给文件种类分色，等于用色相说三件互不
 * 相关的事。容器与叶子的区别交给**填充**：分组实心，文档描边。
 */
function RowIcon({ kind, open, orphan }: { kind: RowKind; open: boolean; orphan: boolean }) {
  const cls = [
    styles.nodeIcon,
    kind === "folder" ? styles.filled : "",
    isSecondary(kind) ? styles.secondary : "",
  ].filter(Boolean).join(" ");
  const icon = () => {
    switch (kind) {
      case "folder": return open ? <FolderOpen size={16} strokeWidth={1.6} /> : <Folder size={16} strokeWidth={1.6} />;
      case "assets": return orphan ? <Link2 size={16} strokeWidth={1.5} /> : <Images size={16} strokeWidth={1.5} />;
      case "doc": return <FileText size={16} strokeWidth={1.6} />;
      case "deliverable": return <FileCode size={16} strokeWidth={1.6} />;
      case "image": return <FileImage size={16} strokeWidth={1.5} />;
      default: return <File size={16} strokeWidth={1.6} />;
    }
  };
  return <span className={cls}>{icon()}</span>;
}

// ── Inline name input (create + rename share the row) ─────────────────────────

/**
 * 输入行不改变树的行数：新建时插入一行（在父级的**第一个**位置——作者刚点了「在
 * 这里新建」，视线在那个分组的标题上），重命名时**替换**原行。任何情况下下面的行
 * 都不移位超过 26px，而全量渲染的树里一次布局就是几百行。
 */
function NameInputRow({
  depth, icon, initial, selectTo, placeholder, error, onSubmit, onCancel,
}: {
  depth: number;
  icon: React.ReactNode;
  initial: string;
  /** How much of the name to pre-select; `undefined` = all of it. */
  selectTo?: number;
  placeholder?: string;
  error: string | null;
  onSubmit: (name: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const submittingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(0, selectTo ?? initial.length);
    // Mount only: re-running would fight the author's own caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    submittingRef.current = true;
    await onSubmit(name.trim());
    submittingRef.current = false;
  };

  // A Chinese name is committed with Enter too — that Enter belongs to the IME.
  const ime = useImeGuard();
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (ime.isComposing(e)) return;
    // The tree's own keymap must not see these: ⌫ deletes the selection there.
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); void submit(); }
    if (e.key === "Escape") onCancel();
  };

  return (
    <>
      <div
        className={`${styles.inputRow} ${error ? styles.invalid : ""}`}
        style={depthVar(depth)}
        onClick={(e) => e.stopPropagation()}
      >
        <span className={styles.chevron} />
        {icon}
        <input
          ref={inputRef}
          className={styles.nameInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          {...ime.imeProps}
          onBlur={() => { if (!submittingRef.current) onCancel(); }}
          placeholder={placeholder}
        />
      </div>
      {/* 出错只改颜色，不改几何：不抖、不清空、光标不动。 */}
      {error && <div className={styles.inputError} style={depthVar(depth)}>{error}</div>}
    </>
  );
}

/**
 * `depth` is the depth of the row the new entry is being created *under* — so
 * a create at the project root passes -1, which lands the input at the same
 * indent as a top-level row.
 */
function CreateInput({ depth }: { depth: number }) {
  const { t } = useTranslation();
  const { cancelCreate, confirmCreate, createError, creatingType } = useContext(TreeCtx);
  return (
    <NameInputRow
      depth={depth + 1}
      // 图标先于名字：「我正在造一个什么」不需要文案说明。
      icon={
        <span className={`${styles.nodeIcon} ${styles.creating} ${creatingType === "folder" ? styles.filled : ""}`}>
          {creatingType === "folder"
            ? <Folder size={16} strokeWidth={1.6} />
            : <FileText size={16} strokeWidth={1.6} />}
        </span>
      }
      initial=""
      error={createError}
      placeholder={creatingType === "folder" ? t("fileTree.folderNamePlaceholder") : t("fileTree.fileNamePlaceholder")}
      onSubmit={(name) => (name ? confirmCreate(name) : cancelCreate())}
      onCancel={cancelCreate}
    />
  );
}

function RenameInput({ node, depth, kind, orphan }: { node: FileNode; depth: number; kind: RowKind; orphan: boolean }) {
  const { cancelRename, confirmRename, renameError } = useContext(TreeCtx);
  // Only the stem is offered for editing; the extension survives untouched.
  const dot = node.is_dir ? -1 : node.name.lastIndexOf(".");
  return (
    <NameInputRow
      depth={depth}
      icon={<RowIcon kind={kind} open={false} orphan={orphan} />}
      initial={node.name}
      selectTo={dot > 0 ? dot : undefined}
      error={renameError}
      onSubmit={(name) => confirmRename(node, name)}
      onCancel={cancelRename}
    />
  );
}

// ── Tree node ─────────────────────────────────────────────────────────────────

// memo: the tree renders one of these per visible row, and the rows all hang
// off one context — memoizing keeps a FileTree-local state change that does
// *not* feed the (memoized) context value, like opening the context menu,
// from re-rendering every row in the project.
const TreeNode = memo(function TreeNode({
  node, depth, parentName,
}: { node: FileNode; depth: number; parentName: string | null }) {
  const { t } = useTranslation();
  const {
    activeFilePath, selected, onRowClick, creatingIn,
    renamingPath, openMenu, deleteAsk, confirmDelete, cancelDelete,
    relinkAsk, confirmRelink, cancelRelink,
    draggingPaths, dragOverDir, springPath, cutPaths, docCounts, orphanAssets,
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
  const kind = rowKind(node.name, node.is_dir, parentName);
  const orphan = orphanAssets.has(node.path);
  // 一列两义：分组显示它下面任意深度的 .md 篇数，文档显示后缀标签。
  const docCount = node.is_dir ? (docCounts.get(node.path) ?? 0) : 0;
  const ext = extLabel(node.name, kind);

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
    draggingPaths.has(node.path) || cutPaths.has(node.path) ? styles.leaving : "",
    dragOverDir === node.path ? styles.dropTarget : "",
  ].filter(Boolean).join(" ");

  const rightCol = () => {
    if (orphan) {
      return (
        <span className={styles.rightCol} title={t("fileTree.assetsOrphan")}>
          <AlertTriangle size={10} strokeWidth={1.8} />
        </span>
      );
    }
    if (kind === "assets") return <span className={`${styles.rightCol} ${styles.ext}`}>{t("fileTree.assetsLabel")}</span>;
    if (node.is_dir) {
      return docCount > 0
        ? <span className={styles.rightCol} title={t("fileTree.dirCount", { count: docCount })}>{docCount}</span>
        : <span className={styles.rightCol} />;
    }
    return ext ? <span className={`${styles.rightCol} ${styles.ext}`}>{ext}</span> : <span className={styles.rightCol} />;
  };

  return (
    <div>
      {isRenaming ? (
        <RenameInput node={node} depth={depth} kind={kind} orphan={orphan} />
      ) : (
        <div
          className={classes}
          style={depthVar(depth)}
          data-path={node.path}
          onClick={handleClick}
          onContextMenu={(e) => openMenu(e, node)}
          draggable
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
                size={14}
                strokeWidth={2}
                className={[
                  styles.chevronIcon,
                  open ? styles.open : "",
                  springPath === node.path ? styles.springing : "",
                ].filter(Boolean).join(" ")}
              />
            )}
          </span>
          <RowIcon kind={kind} open={node.is_dir && open} orphan={orphan} />
          <span
            className={[
              styles.label,
              node.is_dir && kind === "folder" ? styles.group : "",
              isSecondary(kind) ? styles.secondary : "",
            ].filter(Boolean).join(" ")}
          >
            {node.is_dir ? node.name : node.name.replace(/\.md$/i, "")}
          </span>
          {rightCol()}
        </div>
      )}

      {/* 删除确认长在**选区最后一行的下面**，而不是树顶：那里正是作者刚才操作的
          地方，而上面那几条赭石竖条就是「删哪几个」的清单。 */}
      {deleteAsk?.afterPath === node.path && (
        <div className={styles.deleteAsk} onClick={(e) => e.stopPropagation()}>
          <div className={styles.deleteAskText}>{deleteAsk.text}</div>
          <div className={styles.deleteAskRow}>
            <button className={styles.deleteAskGo} onClick={confirmDelete}>{t("fileTree.delete")}</button>
            <button className={styles.deleteAskCancel} onClick={cancelDelete}>{t("common.cancel")}</button>
          </div>
        </div>
      )}

      {/* 修复选择器长在失配的那一行下面，和删除确认同一条规矩：手指刚才在哪，
          问题就在哪问。语气是警告不是危险 —— 这是一次修补，不是一次销毁。 */}
      {relinkAsk?.groupPath === node.path && (
        <div className={styles.relinkAsk} onClick={(e) => e.stopPropagation()}>
          <div className={styles.deleteAskText}>
            {t("fileTree.relinkAskText", { name: node.name })}
          </div>
          <div className={styles.relinkChips}>
            {relinkAsk.candidates.map((doc) => (
              <button
                key={doc.path}
                className={styles.relinkChip}
                onClick={() => confirmRelink(doc.path)}
                title={t("fileTree.relinkTo", { name: doc.name.replace(/\.md$/i, "") })}
              >
                {doc.name.replace(/\.md$/i, "")}
              </button>
            ))}
          </div>
          <div className={styles.deleteAskRow}>
            <button className={styles.deleteAskCancel} onClick={cancelRelink}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      {node.is_dir && open && (
        <div>
          {creatingIn === node.path && <CreateInput depth={depth} />}
          {node.children?.map((child) => (
            <TreeNode key={child.path} node={child} depth={depth + 1} parentName={node.name} />
          ))}
        </div>
      )}
    </div>
  );
});

// ── Footer counters ───────────────────────────────────────────────────────────

/**
 * 三个计数，在自己的组件里 —— `wordCount` 每敲一个字就写一次，而订阅它的组件如果
 * 是 FileTree 本身，整棵树就会跟着每个字符重渲一遍。
 */
/** 12,431 → 12.4k —— 窄栏里三个计数只剩两段，字数也跟着让出四个字符。 */
function shortCount(n: number): string {
  return n < 10000 ? n.toLocaleString() : `${(n / 1000).toFixed(1)}k`;
}

function FooterCounts() {
  const { t } = useTranslation();
  const wordCount = useProjectStore((s) => s.wordCount);
  const fileTree = useProjectStore((s) => s.fileTree);
  const loreCount = useLoreStore((s) => loreEntityCount(s.index));
  const terms = useTerms();
  const docCount = useMemo(() => {
    const count = (nodes: FileNode[]): number =>
      nodes.reduce(
        (n, node) => n + (!node.is_dir && /\.md$/i.test(node.name) ? 1 : 0) + count(node.children ?? []),
        0,
      );
    return count(fileTree);
  }, [fileTree]);
  // 容器查询换得了版式，换不了字：两种拼法都渲染，让 CSS 藏掉一种
  // （design-system → Density tiers inside a resizable panel）。
  return (
    <>
      <span className={`${styles.footerText} ${styles.wideOnly}`}>
        {t("fileTree.footerCounts", {
          words: wordCount.toLocaleString(),
          docs: docCount,
          docLabel: terms.docs,
          entries: loreCount,
          entryLabel: terms.entries,
        })}
      </span>
      <span className={`${styles.footerText} ${styles.narrowOnly}`}>
        {t("fileTree.footerCountsNarrow", {
          words: shortCount(wordCount),
          docs: docCount,
          docLabel: terms.docs,
        })}
      </span>
    </>
  );
}

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
  const createEntry = useProjectStore((s) => s.createEntry);
  const moveEntry = useProjectStore((s) => s.moveEntry);
  const relinkAssets = useProjectStore((s) => s.relinkAssets);
  const copyEntry = useProjectStore((s) => s.copyEntry);
  const deleteEntry = useProjectStore((s) => s.deleteEntry);
  const clipboard = useProjectStore((s) => s.clipboard);
  const setClipboard = useProjectStore((s) => s.setClipboard);

  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [creatingType, setCreatingType] = useState<"file" | "folder">("file");
  const [createError, setCreateError] = useState<string | null>(null);
  const [menu, setMenu] = useState<CtxMenuState | null>(null);
  const [overflowAt, setOverflowAt] = useState<{ x: number; y: number } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  /**
   * 一次只做一件慢活。转换和导出都要把整份文档读进来跑上几秒，而且都会往目标目录
   * 里写 —— 两个并发就是两串写入交织。文案随手做的事变，位置不变。
   */
  const [busy, setBusy] = useState<{ path: string; text: string } | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [draggingPaths, setDraggingPaths] = useState<ReadonlySet<string>>(new Set());
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);
  const [springPath, setSpringPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null);
  const [deleteAsk, setDeleteAsk] = useState<{ targets: TransferSource[]; afterPath: string; text: string } | null>(null);
  const [relinkAsk, setRelinkAsk] = useState<{ groupPath: string; candidates: FileNode[] } | null>(null);
  // Where a shift-range starts. Held separately from the selection because it
  // must survive the range being redrawn: dragging a shift-click up and down
  // has to grow and shrink one span, not chain new ones off the last row.
  const [anchor, setAnchor] = useState<string | null>(null);
  // The dragged entries also live in a ref: `dragover` fires dozens of times a
  // second and cannot read dataTransfer (browsers withhold it until the drop),
  // so the validity check has to consult something synchronous.
  const dragRef = useRef<TransferSource[] | null>(null);
  const springTimer = useRef<{ path: string; id: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  // Every row of the tree, and the subset currently on screen. The first
  // answers "what does this selected path point at"; the second is what a
  // shift-range walks, since a range must not reach into a collapsed folder.
  const everyRow = useMemo(() => allRows(fileTree), [fileTree]);
  const visibleRows = useMemo(
    () => flattenVisible(fileTree, expandedDirs),
    [fileTree, expandedDirs],
  );
  const visiblePaths = useMemo(() => new Set(visibleRows.map((r) => r.path)), [visibleRows]);

  // 分组行右列的篇数, one walk for the whole tree. Each directory row counting
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

  const orphanAssets = useMemo(() => orphanedAssetGroups(fileTree), [fileTree]);

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

  // 「已折叠 N 个分组」 says its piece and goes. No layout animation: it is the
  // one thing on screen that must not move the tree it is describing.
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(id);
  }, [notice]);

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
    setSpringPath(null);
  };

  /** Open a collapsed folder that has been hovered long enough mid-drag. */
  const scheduleSpring = (path: string) => {
    if (springTimer.current?.path === path) return;
    cancelSpring();
    const id = window.setTimeout(() => {
      useProjectStore.getState().setDirExpanded(path, true);
      springTimer.current = null;
      setSpringPath(null);
    }, SPRING_OPEN_MS);
    springTimer.current = { path, id };
    // 正在计时 —— chevron 在这 700ms 里由描边渐变为实心，一个只占 14px 的进度条。
    setSpringPath(path);
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
    setNotice(null);
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

  // ── 全部折叠 / 全部展开 ─────────────────────────────────────────────────────

  const anyOpenDir = useMemo(() => hasOpenDir(fileTree, expandedDirs), [fileTree, expandedDirs]);
  const hasAnyFolder = useMemo(() => everyRow.some((r) => r.isDir), [everyRow]);

  /**
   * 反馈的主体是按钮，不是树（设计稿 17 §2c）。按钮翻成实底赭石就留在那里，所以
   * 「再点一次＝全部展开」在同一个位置、同一个手指；这里第二重的确认条说的是**数
   * 量**，那是树自己没法说的话。
   *
   * 选区收敛给的是半句话，不是动画：作者刚亲手按下一个「把东西藏起来」的按钮，选
   * 区变小可以预期；但删除和移动都作用于选区，所以「现在只剩 2 项」必须在按下的同
   * 一时刻、同一位置说清，否则下一次 ⌫ 就是一个惊喜。
   */
  const toggleCollapseAll = () => {
    const { collapseAllDirs, expandAllDirs, setExpandedDirs } = useProjectStore.getState();
    if (!anyOpenDir) {
      expandAllDirs();
      setNotice(null);
      return;
    }
    const prevDirs = expandedDirs;
    const prevSelected = selected;
    const groups = openDirCount(fileTree, expandedDirs);
    collapseAllDirs();
    // Only the top-level rows survive a full collapse, so the selection that
    // survives with them is exactly the part still on screen.
    const top = new Set(fileTree.map((n) => n.path));
    const kept = new Set([...selected].filter((p) => top.has(p)));
    const shrank = kept.size !== selected.size;
    if (shrank) setSelected(kept);
    setNotice({
      text: shrank
        ? `${t("fileTree.collapsedGroups", { count: groups })} · ${t("fileTree.selectionShrank", { count: kept.size })}`
        : t("fileTree.collapsedGroups", { count: groups }),
      undo: () => {
        setExpandedDirs(prevDirs);
        setSelected(prevSelected);
        setNotice(null);
      },
    });
  };

  /**
   * 定位当前文档 —— 只在当前文档**不可见**时出现在脚线左端。
   *
   * 「不可见」有两种，而它们的判据完全不同：
   *
   * 1. **被折叠掉**：行根本不在渲染出的可见行集合里。一次集合查询，下面这一行。
   * 2. **滚出视野**：行在 DOM 里，但滚动区把它推出去了。
   *
   * 第二种曾经不做，理由是「要按行测量几何，而整稿的性能保证正是不按行测量」——
   * 那个理由只对**遍历**成立。这里观察的是**一行**：当前文档那一行，一个
   * IntersectionObserver，滚动时由浏览器自己回调，主线程一次布局都不多做。
   */
  const currentHidden = !!activeFilePath
    && everyRow.some((r) => r.path === activeFilePath)
    && !visiblePaths.has(activeFilePath);
  const [currentOffscreen, setCurrentOffscreen] = useState(false);
  const currentAway = currentHidden || currentOffscreen;

  useEffect(() => {
    setCurrentOffscreen(false);
    // 折叠掉的那一支不进这里：行不存在，没有可观察的东西，而 currentHidden
    // 已经答对了。重命名中的行也一样 —— 那一刻 [data-path] 被输入框顶掉了。
    if (!activeFilePath || currentHidden) return;
    const root = treeRef.current;
    const row = root?.querySelector(`[data-path="${CSS.escape(activeFilePath)}"]`);
    if (!root || !row) return;
    const io = new IntersectionObserver(
      ([entry]) => setCurrentOffscreen(!entry.isIntersecting && entry.target.isConnected),
      { root },
    );
    io.observe(row);
    return () => io.disconnect();
    // visiblePaths / renamingPath 变了就意味着那个 DOM 节点可能已经换人：
    // 观察一个已经摘下来的节点会一直报「不相交」，而那正好是假的「滚出视野」。
  }, [activeFilePath, currentHidden, visiblePaths, renamingPath]);

  const revealCurrent = () => {
    if (!activeFilePath) return;
    const { expandedDirs: dirs, setExpandedDirs } = useProjectStore.getState();
    const chain = ancestorsOf(fileTree, activeFilePath);
    if (chain.length > 0) {
      const next = { ...dirs };
      for (const dir of chain) next[dir] = true;
      setExpandedDirs(next);
    }
    setSelected(new Set([activeFilePath]));
    setAnchor(activeFilePath);
    // After the expansion has rendered — the row does not exist before it.
    window.requestAnimationFrame(() => {
      treeRef.current
        ?.querySelector(`[data-path="${CSS.escape(activeFilePath)}"]`)
        ?.scrollIntoView({ block: "center" });
    });
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
    // 徽标只说数量。⌥ 复制时前面加一个 ＋ —— 这是「移动 / 复制」唯一的区别，
    // 别处不重复说。
    setMultiDragImage(
      e,
      isCopyDrag(e)
        ? t("fileTree.dragCountCopy", { count: sources.length })
        : t("fileTree.dragCount", { count: sources.length }),
    );
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

  const pasteInto = async (dest: string | null) => {
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
        setTransferError(`${t("fileTree.importFailed")} ${lines.join(" · ")}`);
      }
    } finally {
      setImporting(false);
    }
  };

  /**
   * 把树里已有的 .docx / .xlsx / .pdf / .pptx 转成同目录下的 .md，**原件保留**
   * （见 lib/import 的 `convertProjectFile`：转换是有损的，作者撤不回来）。
   *
   * 之前这件事只在**导入那一刻**发生，于是拖进来的、git 拉下来的、上个版本导入
   * 时还没有转换器的那些文档，在应用里就是一个打不开的行。
   *
   * 单飞与导入同理：一份几十页的 pdf 要转好几秒，两次并发会往同一个
   * `assets/<文档名>/` 里写。转完把新文档打开——作者点它就是为了读它。
   */
  const handleConvert = async (node: FileNode) => {
    if (busy) return;
    setBusy({ path: node.path, text: t("fileTree.converting", { name: node.name }) });
    setTransferError(null);
    try {
      const target = await convertProjectFile(node.path);
      await refreshFileTree();
      setActiveFilePath(target);
      setNotice({ text: t("fileTree.converted", { name: baseName(target) }) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTransferError(`${t("fileTree.convertFailed", { name: node.name })} ${message}`);
    } finally {
      setBusy(null);
    }
  };

  /**
   * `.html` 的两件事，和预览工具条上的那两个按钮是**同一段代码**（`previewHtmlWindow`
   * / `exportHtmlToPptx`），只是从树上够得着 —— 一份交付稿不必先在编辑器里打开才能
   * 预览或导出。
   *
   * 两者都先 flush 编辑器：它们都从**磁盘**读那份文件，而作者刚敲的字可能还在缓冲区
   * 里，导出上一次自动保存的版本是一句悄悄话式的谎。
   */
  const flushIfOpen = async (path: string) => {
    const editor = useEditorStore.getState();
    if (isSamePath(editor.filePath, path) && editor.isDirty) await editor.saveNow();
  };

  const handlePreviewHtml = async (node: FileNode) => {
    try {
      await flushIfOpen(node.path);
      await previewHtmlWindow(node.path);
    } catch (err) {
      console.error("[fileTree] preview failed:", err);
      setTransferError(`${t("fileTree.previewFailed", { name: node.name })} ${err}`);
    }
  };

  const handleExportPptx = async (node: FileNode) => {
    if (busy) return;
    setBusy({ path: node.path, text: t("fileTree.exportingPptx", { name: node.name }) });
    setTransferError(null);
    try {
      await flushIfOpen(node.path);
      // 懒加载：pptxgenjs 有自己的 chunk，没开这个 Beta 的项目不该为它付下载。
      const { exportHtmlToPptx } = await import("../../lib/pptx");
      const result = await exportHtmlToPptx(node.path);
      await refreshFileTree();
      setNotice({
        text: t("fileTree.exportedPptx", { name: baseName(result.path), count: result.slides }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTransferError(`${t("fileTree.exportPptxFailed", { name: node.name })} ${message}`);
    } finally {
      setBusy(null);
    }
  };

  /**
   * 工具栏的「新建」落在**当前选中的分组**（选中的是文档就落在它的分组里，什么都
   * 没选就落在项目根）—— 行上那对 hover 按钮因此不是唯一入口，也不是最快入口，可以
   * 整对删除，右列的篇数于是再也不用给它们让位。
   */
  const createTarget = (): string | null => {
    const one = [...selected][selected.size - 1];
    const row = one ? everyRow.find((r) => r.path === one) : null;
    if (row) return row.isDir ? row.path : parentDirOf(row.path);
    return projectPath;
  };

  const startCreate = (parentPath: string, type: "file" | "folder") => {
    setCreatingIn(parentPath);
    setCreatingType(type);
    setCreateError(null);
  };

  const startCreateHere = (type: "file" | "folder") => {
    const dest = createTarget();
    if (dest) startCreate(dest, type);
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
   * 删除：确认条就地展开在选区最后一行下面，不弹模态（应用惯例）。
   *
   * With `backup` — the sidebar offers no undo of its own, and the agent's
   * deletes have always been snapshotted; the author's own hand deserves at
   * least the safety net the model gets. The confirm copy says the snapshot is
   * restorable, so 确认 is informed rather than a leap.
   */
  const askDelete = (targets: readonly TransferSource[]) => {
    setMenu(null);
    if (targets.length === 0) return;
    // Tree order, so the bar lands under the *last* row it would remove.
    const ordered = everyRow.filter((r) => targets.some((tg) => tg.path === r.path));
    const last = ordered[ordered.length - 1]?.path ?? targets[targets.length - 1].path;
    const dirs = targets.filter((tg) => tg.isDir).length;
    const text = targets.length > 1
      ? t("fileTree.deleteManyAsk", { count: targets.length })
      : t(dirs > 0 ? "fileTree.deleteFolderAsk" : "fileTree.deleteAsk", { name: baseNameOf(targets[0].path) });
    setDeleteAsk({ targets: [...targets], afterPath: last, text });
  };

  const confirmDelete = async () => {
    const targets = deleteAsk?.targets ?? [];
    setDeleteAsk(null);
    for (const target of pruneNested(targets)) {
      try {
        await deleteEntry(target.path, target.isDir, { backup: true });
      } catch (err) {
        console.error("[fileTree] delete failed:", err);
      }
    }
    clearSelection();
  };

  /**
   * 修好一个失配的 `assets/<组>`：把它重新关联到旁边的某一份文档。
   *
   * 候选清单是纯的（`relinkCandidates`），并且**已经把自己有图库的文档滤掉了** ——
   * 合并两个图库需要逐文件处理冲突，还可能覆盖目标文档自己的图，所以那个选择干脆
   * 不提供，而不是提供了再拒绝。
   */
  const askRelink = (node: FileNode) => {
    setMenu(null);
    const candidates = relinkCandidates(fileTree, node.path) as FileNode[];
    if (candidates.length === 0) return;
    setRelinkAsk({ groupPath: node.path, candidates });
  };

  const confirmRelink = async (docPath: string) => {
    const groupPath = relinkAsk?.groupPath;
    setRelinkAsk(null);
    if (!groupPath) return;
    try {
      await relinkAssets(groupPath, docPath);
      setNotice({ text: t("fileTree.relinked", { name: baseNameOf(docPath).replace(/\.md$/i, "") }) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTransferError(`${t("fileTree.relinkFailed")} ${message}`);
    }
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
   * 一个 `@[名字]`。
   */
  const sendToAssistant = async (file: ProjectFile) => {
    setMenu(null);
    const outcome = await attachProjectFile(file);
    if (!outcome.ok) {
      setTransferError(
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

  const reveal = (path: string) => {
    revealItemInDir(path).catch(() => { /* best-effort */ });
  };

  const copyPath = (path: string) => {
    void navigator.clipboard?.writeText(path).catch(() => { /* best-effort */ });
  };

  // ── Menus ───────────────────────────────────────────────────────────────────

  /**
   * 三条规则（设计稿 17 §1j）：**不成立的项不渲染，而不是禁用**（剪贴板空 → 没有
   * 「粘贴」；多选 → 没有「重命名」）；顺序固定为**造 → 搬 → 查 → 毁**，三种菜单里
   * 项的相对顺序永不变，只增删；删除永远在最后、永远隔一条线。
   */
  const buildMenuItems = (node: FileNode | null): ContextMenuEntry[] => {
    const pasteItem = (): ContextMenuEntry[] => {
      if (!clipboard) return [];
      const dest = pasteTargetOf(node);
      const blocked =
        !dest || clipboard.entries.every((entry) => !!dropRejection(entry.path, dest, clipboard.mode));
      if (blocked) return [];
      return [{
        kind: "item",
        icon: <ClipboardPaste size={13} />,
        label: node
          ? t("fileTree.pasteHere", { count: clipboard.entries.length })
          : clipboard.entries.length > 1
            ? t("fileTree.pasteEntries", { count: clipboard.entries.length })
            : t("fileTree.pasteEntry", { name: baseNameOf(clipboard.entries[0].path) }),
        shortcut: comboLabel({ mod: true, key: "v" }),
        action: () => void pasteInto(pasteTargetOf(node)),
      }];
    };

    if (!node) {
      return [
        { kind: "item", icon: <FilePlus size={13} />, label: t("fileTree.newFile"),
          shortcut: comboLabel(COMBO_NEW_DOC),
          action: () => { if (projectPath) startCreate(projectPath, "file"); } },
        { kind: "item", icon: <FolderPlus size={13} />, label: t("fileTree.newFolder"),
          shortcut: comboLabel(COMBO_NEW_GROUP),
          action: () => { if (projectPath) startCreate(projectPath, "folder"); } },
        ...(clipboard ? [{ kind: "divider" } as ContextMenuEntry] : []),
        ...pasteItem(),
        { kind: "divider" },
        { kind: "item", icon: <FileInput size={13} />, label: t("fileTree.importDoc"),
          action: () => { if (projectPath) void handleImport(projectPath); } },
        ...(hasAnyFolder ? [{
          kind: "item", icon: <ChevronsDownUp size={13} />, label: t("fileTree.collapseAll"),
          shortcut: comboLabel(COMBO_COLLAPSE_ALL), action: toggleCollapseAll,
        } as ContextMenuEntry] : []),
        { kind: "item", icon: <RotateCw size={13} />, label: t("fileTree.refresh"),
          action: () => void refreshFileTree() },
        { kind: "divider" },
        { kind: "item", icon: <FolderOpen size={13} />, label: t("fileTree.reveal"),
          action: () => { if (projectPath) reveal(projectPath); } },
      ];
    }

    // `openMenu` has already made sure the clicked row is in the selection, so
    // the menu can act on all of it. Everything that only makes sense for one
    // entry — 打开, 重命名, 复制路径 — drops out when there are several.
    const targets = selected.has(node.path) && selected.size > 1
      ? selectedSources()
      : [{ path: node.path, isDir: node.is_dir }];
    const count = targets.length;

    if (count > 1) {
      return [
        // 第一行是不可点的选区抬头 —— 右键之后菜单盖住半棵树，抬头是「我到底选了
        // 几个」唯一还看得见的答案。
        { kind: "item", label: t("fileTree.selectedCount", { count }), disabled: true, action: () => {} },
        { kind: "divider" },
        { kind: "item", icon: <Scissors size={13} />, label: t("fileTree.cutMany", { count }),
          shortcut: comboLabel({ mod: true, key: "x" }),
          action: () => setClipboard({ entries: targets, mode: "move" }) },
        { kind: "item", icon: <Copy size={13} />, label: t("fileTree.copyMany", { count }),
          shortcut: comboLabel({ mod: true, key: "c" }),
          action: () => setClipboard({ entries: targets, mode: "copy" }) },
        ...pasteItem(),
        { kind: "divider" },
        { kind: "item", icon: <FolderOpen size={13} />, label: t("fileTree.reveal"),
          action: () => reveal(node.path) },
        { kind: "divider" },
        { kind: "item", icon: <Trash2 size={13} />, label: t("fileTree.deleteMany", { count }),
          danger: true, action: () => askDelete(targets) },
      ];
    }

    const items: ContextMenuEntry[] = [];
    if (node.is_dir) {
      // 行上撤掉的那对按钮的落点。
      items.push(
        { kind: "item", icon: <FilePlus size={13} />, label: t("fileTree.newFileHere"),
          action: () => startCreate(node.path, "file") },
        { kind: "item", icon: <FolderPlus size={13} />, label: t("fileTree.newFolderHere"),
          action: () => startCreate(node.path, "folder") },
        { kind: "item", icon: <FileInput size={13} />, label: t("fileTree.importDoc"),
          action: () => void handleImport(node.path) },
      );
      // 只长在戴着 ⚠ 的那种分组上，而且只在真有可选的文档时 —— 一项点开发现
      // 「没有候选」的菜单项，比没有这一项更糟。
      if (orphanAssets.has(node.path) && relinkCandidates(fileTree, node.path).length > 0) {
        items.push({
          kind: "item", icon: <Link2 size={13} />, label: t("fileTree.relink"),
          action: () => askRelink(node),
        });
      }
      items.push({ kind: "divider" });
    } else {
      items.push(
        { kind: "item", icon: <FileText size={13} />, label: t("fileTree.open"),
          action: () => setActiveFilePath(node.path) },
      );
      // 「预览」指的是**另开的预览窗口**，不是编辑器右边那半 —— 打开这份文件本来
      // 就会显示预览面板，菜单里再放一个同义的项没有意义。那个窗口有自己的自定义
      // 协议、不在应用的 CSP 底下，是页面里的脚本**真正跑起来**的唯一地方。
      if (rowKind(node.name, false, null) === "deliverable") {
        items.push({
          kind: "item", icon: <Monitor size={13} />, label: t("fileTree.previewHtml"),
          action: () => void handlePreviewHtml(node),
        });
      }
      // 这一格从上到下是三问：用它 / 拿它造一个新文件 / 把它交到别处去。中间这段
      // 的两项互斥 —— 能转换的四种格式恰好是 `classifyProjectFile` 认不出的那些
      // （模型收不下 zip 包），而导出成幻灯只发生在 `.html` 上。
      if (convertExtOf(node.name)) {
        items.push({
          kind: "item",
          icon: <FileOutput size={13} />,
          label: t("fileTree.convertDoc"),
          disabled: busy !== null,
          action: () => void handleConvert(node),
        });
      }
      // Beta 关着时**不是禁用而是不存在**（与 `export_pptx` 工具同一条规矩）：
      // 一个作者没打开的能力，不该在菜单里留一行灰字解释自己。
      if (rowKind(node.name, false, null) === "deliverable" && isPptxExportEnabled()) {
        items.push({
          kind: "item", icon: <Presentation size={13} />, label: t("fileTree.exportPptx"),
          disabled: busy !== null,
          action: () => void handleExportPptx(node),
        });
      }
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
      items.push({ kind: "divider" });
    }
    items.push(
      { kind: "item", icon: <Pencil size={13} />, label: t("fileTree.rename"),
        shortcut: "↩", action: () => startRename(node) },
      { kind: "item", icon: <Scissors size={13} />, label: t("fileTree.cut"),
        shortcut: comboLabel({ mod: true, key: "x" }),
        action: () => setClipboard({ entries: targets, mode: "move" }) },
      { kind: "item", icon: <Copy size={13} />, label: t("fileTree.copy"),
        shortcut: comboLabel({ mod: true, key: "c" }),
        action: () => setClipboard({ entries: targets, mode: "copy" }) },
      ...pasteItem(),
      { kind: "divider" },
      { kind: "item", icon: <Copy size={13} />, label: t("fileTree.copyPath"),
        action: () => copyPath(node.path) },
      { kind: "item", icon: <FolderOpen size={13} />, label: t("fileTree.reveal"),
        action: () => reveal(node.path) },
      { kind: "divider" },
      { kind: "item", icon: <Trash2 size={13} />, label: t("fileTree.delete"), danger: true,
        shortcut: IS_MAC ? "⌫" : "Del",
        action: () => askDelete(targets) },
    );
    return items;
  };

  /**
   * ⋯ 的内容随宽度变：≥360px 时「导入文件 / 刷新」已经升到工具栏上，菜单里就只剩
   * 上面两项。档位是容器查询，JS 看不见它——所以在**打开菜单的这一刻**量一次容器，
   * 一次测量，不是每行一次。
   */
  const overflowItems = (): ContextMenuEntry[] => {
    const wide = (containerRef.current?.clientWidth ?? 240) >= 359;
    const items: ContextMenuEntry[] = [
      { kind: "item", icon: <Crosshair size={13} />, label: t("fileTree.revealCurrent"),
        shortcut: comboLabel(COMBO_REVEAL_DOC),
        disabled: !activeFilePath, action: revealCurrent },
      { kind: "item", icon: <ChevronsUpDown size={13} />, label: t("fileTree.expandAll"),
        disabled: !hasAnyFolder,
        action: () => { useProjectStore.getState().expandAllDirs(); setNotice(null); } },
    ];
    if (!wide) {
      items.push(
        { kind: "divider" },
        { kind: "item", icon: <FileInput size={13} />, label: t("fileTree.importDoc"),
          action: () => { const d = createTarget(); if (d) void handleImport(d); } },
        { kind: "item", icon: <RotateCw size={13} />, label: t("fileTree.refresh"),
          action: () => void refreshFileTree() },
      );
    }
    return items;
  };

  // ── Keyboard (scoped to the tree, which takes focus on click) ────────────────

  const onTreeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const native = e.nativeEvent;
    const targets = selectedSources();
    if (matchesCombo(native, COMBO_NEW_GROUP)) {
      e.preventDefault();
      startCreateHere("folder");
    } else if (matchesCombo(native, COMBO_NEW_DOC)) {
      e.preventDefault();
      startCreateHere("file");
    } else if (matchesCombo(native, { mod: true, key: "x" }) && targets.length > 0) {
      e.preventDefault();
      setClipboard({ entries: targets, mode: "move" });
    } else if (matchesCombo(native, { mod: true, key: "c" }) && targets.length > 0) {
      e.preventDefault();
      setClipboard({ entries: targets, mode: "copy" });
    } else if (matchesCombo(native, { mod: true, key: "v" }) && clipboard) {
      e.preventDefault();
      // 落点与工具栏的「新建」同一条规则：选中的分组，否则选中文档所在的分组，
      // 什么都没选就是项目根。
      void pasteInto(createTarget());
    } else if ((e.key === "Backspace" || e.key === "Delete") && targets.length > 0) {
      e.preventDefault();
      askDelete(targets);
    } else if (e.key === "Enter" && selected.size === 1) {
      const one = [...selected][0];
      const row = everyRow.find((r) => r.path === one);
      if (!row) return;
      e.preventDefault();
      startRename({ path: row.path, is_dir: row.isDir, name: baseNameOf(row.path) });
    } else if (e.key === "Escape") {
      // 剪贴板与折叠提示都在这里退场，和「点一下别处」是同一件事。
      if (clipboard) setClipboard(null);
      setNotice(null);
    }
  };

  // 全部折叠 / 定位当前文档 —— 面板自己的两条绑定，只在「文件」标签页挂着的时候
  // 生效（这个组件只在那时渲染）。注册在窗口上而不是树上：作者的手可能在正文里。
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (matchesCombo(e, COMBO_COLLAPSE_ALL)) {
        if (!hasAnyFolder) return;
        e.preventDefault();
        toggleCollapseAll();
      } else if (matchesCombo(e, COMBO_REVEAL_DOC)) {
        if (!activeFilePath) return;
        e.preventDefault();
        revealCurrent();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
    onRowClick, cancelCreate, confirmCreate, confirmRename,
    cancelRename, openMenu, onDragStart, onDragEnd: endDrag,
    onDragOverDir, onDragLeaveDir, onDropInDir, confirmDelete,
    cancelDelete: () => setDeleteAsk(null),
    confirmRelink, cancelRelink: () => setRelinkAsk(null),
  };
  const handlersRef = useRef(handlers);
  useEffect(() => { handlersRef.current = handlers; });
  const stableHandlers = useMemo<Pick<TreeCtx, keyof typeof handlers>>(() => ({
    onRowClick: (e, node) => handlersRef.current.onRowClick(e, node),
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
    confirmDelete: () => void handlersRef.current.confirmDelete(),
    cancelDelete: () => handlersRef.current.cancelDelete(),
    confirmRelink: (docPath) => void handlersRef.current.confirmRelink(docPath),
    cancelRelink: () => handlersRef.current.cancelRelink(),
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
    springPath,
    cutPaths,
    docCounts,
    orphanAssets,
    deleteAsk: deleteAsk ? { afterPath: deleteAsk.afterPath, text: deleteAsk.text } : null,
    relinkAsk,
    ...stableHandlers,
  }), [
    activeFilePath, selected, creatingIn, creatingType, createError,
    renamingPath, renameError, draggingPaths, dragOverDir, springPath, cutPaths,
    docCounts, orphanAssets, deleteAsk, relinkAsk, stableHandlers,
  ]);

  const footer = () => {
    // 三件事共用这一行，永不叠加：剪贴板活着的时候，字数不是当下最重要的信息。
    if (clipboard) {
      const count = clipboard.entries.length;
      const paste = comboLabel({ mod: true, key: "v" });
      return (
        <div className={`${styles.footer} ${styles.clip}`}>
          <span className={styles.footerIcon}>
            {clipboard.mode === "move" ? <Scissors size={11} strokeWidth={1.8} /> : <Copy size={11} strokeWidth={1.8} />}
          </span>
          <span className={styles.footerText}>
            {t(clipboard.mode === "move" ? "fileTree.clipCut" : "fileTree.clipCopied", { count, paste })}
          </span>
          <button className={styles.footerAction} onClick={() => setClipboard(null)}>
            {t("common.cancel")}
          </button>
        </div>
      );
    }
    if (currentAway) {
      return (
        <div className={`${styles.footer} ${styles.reveal}`} onClick={revealCurrent} title={t("fileTree.revealCurrent")}>
          <span className={styles.footerIcon}><Crosshair size={11} strokeWidth={1.8} /></span>
          <span className={styles.footerText}>{baseNameOf(activeFilePath ?? "").replace(/\.md$/i, "")}</span>
        </div>
      );
    }
    return <div className={styles.footer}><FooterCounts /></div>;
  };

  return (
    <TreeCtx.Provider value={ctx}>
      <div className={styles.container} ref={containerRef}>
        {/* 节标题与工具栏本来就是同一行的左右两半（设计稿 17 §1f）。 */}
        <div className={styles.toolbar}>
          <span className={styles.toolbarLabel}>{t("sidebar.files")}</span>
          <span className={styles.toolbarSpacer} />
          <button
            className={styles.toolbarBtn}
            title={t("fileTree.newFile")}
            onClick={() => startCreateHere("file")}
          >
            <FilePlus size={14} strokeWidth={1.6} />
          </button>
          <button
            className={styles.toolbarBtn}
            title={t("fileTree.newFolder")}
            onClick={() => startCreateHere("folder")}
          >
            <FolderPlus size={14} strokeWidth={1.6} />
          </button>
          {/* 导入组 —— 只在 ≥360px 的宽档从 ⋯ 里升上来。 */}
          <span className={`${styles.toolbarDivider} ${styles.wide}`} />
          <button
            className={`${styles.toolbarBtn} ${styles.wide}`}
            title={t("fileTree.importDoc")}
            disabled={importing}
            onClick={() => { const d = createTarget(); if (d) void handleImport(d); }}
          >
            <FileInput size={14} strokeWidth={1.6} />
          </button>
          <button
            className={`${styles.toolbarBtn} ${styles.wide}`}
            title={t("fileTree.refresh")}
            onClick={() => void refreshFileTree()}
          >
            <RotateCw size={13} strokeWidth={1.6} />
          </button>
          {/* 视图组 */}
          <span className={`${styles.toolbarDivider} ${styles.wide}`} />
          <button
            className={`${styles.toolbarBtn} ${!anyOpenDir && hasAnyFolder ? styles.armed : ""}`}
            title={hasAnyFolder
              ? `${t(anyOpenDir ? "fileTree.collapseAll" : "fileTree.expandAll")} · ${comboLabel(COMBO_COLLAPSE_ALL)}`
              : undefined}
            disabled={!hasAnyFolder}
            onClick={toggleCollapseAll}
          >
            {anyOpenDir
              ? <ChevronsDownUp size={14} strokeWidth={1.7} />
              : <ChevronsUpDown size={14} strokeWidth={1.8} />}
          </button>
          <button
            className={styles.toolbarBtn}
            title={t("fileTree.more")}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setOverflowAt({ x: r.right - 4, y: r.bottom + 2 });
            }}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>

        {/* 就地展开的确认条，不弹模态。说的是**数量** —— 那是树自己没法说的话。
            慢活的提示走同一条：它没有倒计时（一份几十页的 pdf、一页要离屏渲染的
            幻灯都会跑过 NOTICE_MS），所以不能用 notice 本身来表达，否则条会在事
            情还没做完的时候自己消失。 */}
        {busy ? (
          <div className={styles.notice} role="status">
            <span className={styles.noticeText}>{busy.text}</span>
          </div>
        ) : notice && (
          <div className={styles.notice} role="status">
            <span className={styles.noticeText}>{notice.text}</span>
            {notice.undo && (
              <button className={styles.noticeAction} onClick={notice.undo}>{t("common.undo")}</button>
            )}
          </div>
        )}

        {/* Why the last move/copy could not happen. Click to dismiss. */}
        {transferError && (
          <div className={styles.transferError} role="alert">
            <span className={styles.noticeText}>{transferError}</span>
            <button className={styles.noticeAction} onClick={() => setTransferError(null)}>
              {t("common.gotIt")}
            </button>
          </div>
        )}

        {/* Tree or empty state. The container itself is the project root: its
            empty space takes drops, its background clears the selection, and
            a root-level create renders its input here rather than under a row
            (the root has no row of its own — `readDirRecursive` returns the
            project's children, not the project). */}
        <div
          ref={treeRef}
          className={`${styles.tree} ${dragOverDir === projectPath ? styles.rootDropTarget : ""}`}
          tabIndex={0}
          onKeyDown={onTreeKeyDown}
          onContextMenu={(e) => openMenu(e, null)}
          onClick={(e) => { if (e.target === e.currentTarget) { clearSelection(); setNotice(null); } }}
          onDragOver={onDragOverTree}
          onDragLeave={onDragLeaveTree}
          onDrop={onDropInTree}
        >
          {creatingAtRoot && <CreateInput depth={-1} />}
          {fileTree.length === 0 && !creatingAtRoot ? (
            // 一句陈述、一个主行动、一个次行动，加一行 ⌘K 提示压在底部 —— 那是命令
            // 面板唯一的教学位置，也是拆掉假搜索框之后的补偿。
            <div className={styles.emptyState}>
              <div className={styles.emptyText}>{t("project.emptyTree")}</div>
              <div className={styles.emptyActions}>
                <button className={styles.emptyPrimary} onClick={() => startCreateHere("file")}>
                  {t("fileTree.newFile")}
                </button>
                <button
                  className={styles.emptySecondary}
                  onClick={() => { if (projectPath) void handleImport(projectPath); }}
                >
                  {t("fileTree.importDoc")}
                </button>
              </div>
              <div className={styles.emptyHint}>
                {t("fileTree.emptyPaletteHint", { key: comboLabel({ mod: true, key: "k" }) })}
              </div>
            </div>
          ) : (
            fileTree.map((node) => (
              <TreeNode key={node.path} node={node} depth={0} parentName={null} />
            ))
          )}
          {/* 说明只在拖拽悬停空白时出现。 */}
          {dragOverDir === projectPath && projectPath && (
            <div className={styles.rootDropHint}>
              {t("fileTree.dropToRoot", { name: baseName(projectPath) })}
            </div>
          )}
        </div>

        {footer()}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.node)}
          onClose={() => setMenu(null)}
        />
      )}
      {overflowAt && (
        <ContextMenu
          x={overflowAt.x}
          y={overflowAt.y}
          items={overflowItems()}
          onClose={() => setOverflowAt(null)}
        />
      )}
    </TreeCtx.Provider>
  );
}
