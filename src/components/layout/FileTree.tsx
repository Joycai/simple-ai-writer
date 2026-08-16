import {
  useState, useRef, useEffect, createContext, useContext,
  type DragEvent, type KeyboardEvent, type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Folder, FolderOpen, FolderInput, FileText, File, FileImage, ChevronRight,
  FilePlus, FolderPlus, FileInput, RotateCw, LogOut, Pencil, Trash2,
  Scissors, Copy, ClipboardPaste, TextCursorInput,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { isImagePath } from "../../lib/fs/images";
import { fileExists } from "../../lib/fs/fileio";
import { baseNameOf, dropRejection, parentDirOf, type TransferMode } from "../../lib/fs/moveCopy";
import { insertAtCursor } from "../../lib/editor/format";
import { imageMarkdown } from "../../lib/image/assets";
import { baseName, importDocumentsDialog } from "../../lib/import";
import { useImeGuard } from "../../lib/ime";
import { relativePathFrom } from "../../lib/paths";
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

/** How long a folder must be hovered mid-drag before it springs open. */
const SPRING_OPEN_MS = 700;

// ── Context ───────────────────────────────────────────────────────────────────

interface TreeCtx {
  activeFilePath: string | null;
  setActiveFilePath: (p: string) => void;
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
  /** Path of the row being dragged right now, so it can dim itself. */
  draggingPath: string | null;
  /** Path of the folder row currently lit up as the drop target. */
  dragOverDir: string | null;
  /** Path of the entry waiting to be pasted by a cut, dimmed until then. */
  cutPath: string | null;
  onDragStart: (e: DragEvent, node: FileNode) => void;
  onDragEnd: () => void;
  onDragOverDir: (e: DragEvent, node: FileNode) => void;
  onDragLeaveDir: (e: DragEvent, node: FileNode) => void;
  onDropInDir: (e: DragEvent, node: FileNode) => void;
}

const TreeCtx = createContext<TreeCtx>(null!);

// ── Inline create input ───────────────────────────────────────────────────────

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
  return <File size={14} className={styles.fileIcon} />;
}

// ── Tree node ─────────────────────────────────────────────────────────────────

function countDocsIn(node: FileNode): number {
  let n = 0;
  for (const child of node.children ?? []) {
    if (child.is_dir) n += countDocsIn(child);
    else if (/\.md$/i.test(child.name)) n++;
  }
  return n;
}

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const { t } = useTranslation();
  const {
    activeFilePath, setActiveFilePath, creatingIn, startCreate,
    renamingPath, renameError, openMenu,
    draggingPath, dragOverDir, cutPath,
    onDragStart, onDragEnd, onDragOverDir, onDragLeaveDir, onDropInDir,
  } = useContext(TreeCtx);
  // Expansion is stored per project (projectStore.expandedDirs), not per node:
  // the sidebar's tab transition remounts this tree, so local state would
  // collapse every folder the author opened whenever they looked at another tab.
  // No entry yet = never touched = the default below.
  const stored = useProjectStore((s) => s.expandedDirs[node.path]);
  const open = stored ?? depth === 0;
  const setOpen = (next: boolean) =>
    useProjectStore.getState().setDirExpanded(node.path, next);
  const isActive = !node.is_dir && activeFilePath === node.path;
  const isRenaming = renamingPath === node.path;
  // 设计稿 01: 卷行右侧带章数 — the documents under this folder, at any depth.
  const docCount = node.is_dir ? countDocsIn(node) : 0;

  // Auto-expand when this folder becomes the target of an inline create
  // (context menu can trigger creates on collapsed folders).
  useEffect(() => {
    if (creatingIn === node.path) {
      useProjectStore.getState().setDirExpanded(node.path, true);
    }
  }, [creatingIn, node.path]);

  const handleClick = () => {
    if (isRenaming) return;
    if (node.is_dir) setOpen(!open);
    else setActiveFilePath(node.path);
  };

  const classes = [
    styles.node,
    isActive ? styles.active : "",
    draggingPath === node.path ? styles.dragging : "",
    dragOverDir === node.path ? styles.dropTarget : "",
    cutPath === node.path ? styles.cut : "",
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
}

// ── Context menu ──────────────────────────────────────────────────────────────

interface CtxMenuState { x: number; y: number; node: FileNode | null }

// ── Main FileTree ─────────────────────────────────────────────────────────────

export function FileTree() {
  const { t } = useTranslation();
  const { fileTree, projectPath, refreshFileTree, activeFilePath, setActiveFilePath,
          openProject, closeProject, createEntry, moveEntry, copyEntry, deleteEntry,
          clipboard, setClipboard } =
    useProjectStore();

  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [creatingType, setCreatingType] = useState<"file" | "folder">("file");
  const [createError, setCreateError] = useState<string | null>(null);
  const [menu, setMenu] = useState<CtxMenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);
  // The dragged entry also lives in a ref: `dragover` fires dozens of times a
  // second and cannot read dataTransfer (browsers withhold it until the drop),
  // so the validity check has to consult something synchronous.
  const dragRef = useRef<TransferSource | null>(null);
  const springTimer = useRef<{ path: string; id: number } | null>(null);

  // Whether 插入到当前位置 has anywhere to insert *into*: a markdown document
  // open in a live editor, which is where the cursor is. EditorArea swaps the
  // CodeEditor out for an image preview or a load notice, and `editorView` is
  // null for exactly those — so it answers the question on its own.
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
    setDraggingPath(null);
    setDragOverDir(null);
  };

  useEffect(() => cancelSpring, []);

  /**
   * Move or copy an entry into `destDir` — the one path behind both the drop
   * gesture and the paste menu item, so the two cannot drift apart.
   */
  const transfer = async (src: TransferSource, destDir: string, mode: TransferMode) => {
    const rejection = dropRejection(src.path, destDir, mode);
    if (rejection) {
      // "same-parent" means the author dropped an entry back where it already
      // is — an accident, not a failure, so it passes silently.
      setTransferError(rejection === "into-self" ? t("fileTree.moveIntoSelf") : null);
      return;
    }
    setTransferError(null);
    const name = baseNameOf(src.path);
    try {
      if (mode === "copy") {
        await copyEntry(src.path, destDir, src.isDir);
      } else {
        // moveEntry refuses an occupied destination too; checking here is what
        // turns that into a sentence naming the file, in the author's language.
        const dest = `${destDir}/${name}`;
        if (await fileExists(dest)) {
          setTransferError(t("fileTree.moveExists", { name }));
          return;
        }
        await moveEntry(src.path, dest);
      }
      useProjectStore.getState().setDirExpanded(destDir, true);
    } catch (err) {
      setTransferError(err instanceof Error ? err.message : String(err));
    }
  };

  const onDragStart = (e: DragEvent, node: FileNode) => {
    const src = { path: node.path, isDir: node.is_dir };
    dragRef.current = src;
    setDraggingPath(node.path);
    setTransferError(null);
    e.dataTransfer.effectAllowed = "copyMove";
    // Some engines abort a drag that carries no payload at all.
    e.dataTransfer.setData("text/plain", node.path);
  };

  const onDragOverDir = (e: DragEvent, node: FileNode) => {
    const src = dragRef.current;
    // Only folders take drops, and only from a drag that started in this tree
    // (an OS file drag has no ref and must fall through untouched).
    if (!src || !node.is_dir) return;
    if (dropRejection(src.path, node.path, isCopyDrag(e) ? "copy" : "move")) {
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
    e.preventDefault();
    const src = dragRef.current;
    const mode: TransferMode = isCopyDrag(e) ? "copy" : "move";
    endDrag();
    if (src && node.is_dir) void transfer(src, node.path, mode);
  };

  /** Where a paste aimed at this row lands: a folder itself, else its parent. */
  const pasteTargetOf = (node: FileNode | null): string | null => {
    if (!node) return projectPath || null;
    return node.is_dir ? node.path : parentDirOf(node.path);
  };

  const handlePaste = async (node: FileNode | null) => {
    const dest = pasteTargetOf(node);
    if (!clipboard || !dest) return;
    const { path, isDir, mode } = clipboard;
    await transfer({ path, isDir }, dest, mode);
    // A cut is spent once pasted; a copy stays, so it can be pasted again.
    if (mode === "move") setClipboard(null);
  };

  // Convert picked documents (docx/pdf/txt/md) into markdown files in destDir.
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

  const handleDelete = async (node: FileNode) => {
    setMenu(null);
    const ok = window.confirm(
      t(node.is_dir ? "fileTree.deleteFolderConfirm" : "fileTree.deleteConfirm"),
    );
    if (!ok) return;
    try {
      await deleteEntry(node.path, node.is_dir);
    } catch (err) {
      console.error("[fileTree] delete failed:", err);
    }
  };

  const openMenu = (e: MouseEvent, node: FileNode | null) => {
    e.preventDefault();
    e.stopPropagation();
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
      const blocked = !dest || !!dropRejection(clipboard.path, dest, clipboard.mode);
      return [{
        kind: "item",
        icon: <ClipboardPaste size={13} />,
        label: t("fileTree.pasteEntry", { name: baseNameOf(clipboard.path) }),
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
    const source: TransferSource = { path: node.path, isDir: node.is_dir };
    items.push(
      { kind: "divider" },
      { kind: "item", icon: <Scissors size={13} />, label: t("fileTree.cut"),
        action: () => setClipboard({ ...source, mode: "move" }) },
      { kind: "item", icon: <Copy size={13} />, label: t("fileTree.copy"),
        action: () => setClipboard({ ...source, mode: "copy" }) },
      ...pasteItem(),
      { kind: "divider" },
      { kind: "item", icon: <Pencil size={13} />, label: t("fileTree.rename"),
        action: () => startRename(node) },
      { kind: "item", icon: <FolderOpen size={13} />, label: t("fileTree.reveal"),
        action: () => reveal(node.path) },
      { kind: "divider" },
      { kind: "item", icon: <Trash2 size={13} />, label: t("fileTree.delete"), danger: true,
        action: () => void handleDelete(node) },
    );
    return items;
  };

  const projectName = projectPath?.split("/").pop()?.toUpperCase() ?? "";

  const ctx: TreeCtx = {
    activeFilePath,
    setActiveFilePath,
    creatingIn,
    creatingType,
    startCreate,
    cancelCreate,
    confirmCreate,
    createError,
    renamingPath,
    renameError,
    confirmRename,
    cancelRename,
    openMenu,
    draggingPath,
    dragOverDir,
    cutPath: clipboard?.mode === "move" ? clipboard.path : null,
    onDragStart,
    onDragEnd: endDrag,
    onDragOverDir,
    onDragLeaveDir,
    onDropInDir,
  };

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
            <button
              className={styles.toolbarBtn}
              title={t("project.closeProject")}
              onClick={() => void closeProject()}
            >
              <LogOut size={14} />
            </button>
            <button
              className={styles.toolbarBtn}
              title={t("fileTree.newFile")}
              onClick={() => projectPath && startCreate(projectPath, "file")}
            >
              <FilePlus size={14} />
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

        {/* Tree or empty state */}
        <div className={styles.tree} onContextMenu={(e) => openMenu(e, null)}>
          {fileTree.length === 0 ? (
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
