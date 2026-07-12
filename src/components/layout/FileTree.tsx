import {
  useState, useRef, useEffect, createContext, useContext,
  type KeyboardEvent, type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Folder, FolderOpen, FolderInput, FileText, File, FileImage, ChevronRight,
  FilePlus, FolderPlus, RotateCw, LogOut, Pencil, Trash2,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { isImagePath } from "../../lib/loreGenerator";
import { writeFile, makeDir, removeFile, removeDir, renamePath } from "../../lib/fileio";
import { useProjectStore } from "../../stores/projectStore";
import { useEditorStore } from "../../stores/editorStore";
import type { FileNode } from "../../lib/project";
import { ContextMenu, type ContextMenuEntry } from "../common/ContextMenu";
import styles from "./FileTree.module.css";

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

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
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
        style={{ paddingLeft: `${4 + (depth + 1) * 12}px` }}
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

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
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

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const { t } = useTranslation();
  const {
    activeFilePath, setActiveFilePath, creatingIn, startCreate,
    renamingPath, renameError, openMenu,
  } = useContext(TreeCtx);
  const [open, setOpen] = useState(depth === 0 || node.name === "writing");
  const isActive = !node.is_dir && activeFilePath === node.path;
  const isRenaming = renamingPath === node.path;

  // Auto-expand when this folder becomes the target of an inline create
  // (context menu can trigger creates on collapsed folders).
  useEffect(() => {
    if (creatingIn === node.path) setOpen(true);
  }, [creatingIn, node.path]);

  const handleClick = () => {
    if (isRenaming) return;
    if (node.is_dir) setOpen((o) => !o);
    else setActiveFilePath(node.path);
  };

  return (
    <div>
      <div
        className={`${styles.node} ${isActive ? styles.active : ""}`}
        style={{ paddingLeft: `${4 + depth * 12}px` }}
        onClick={handleClick}
        onContextMenu={(e) => openMenu(e, node)}
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
          : <span className={styles.label}>{node.name}</span>}

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

/** Return the parent directory of a path (handles both separator styles). */
function parentDir(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(0, sep);
}

// ── Main FileTree ─────────────────────────────────────────────────────────────

export function FileTree() {
  const { t } = useTranslation();
  const { fileTree, projectPath, refreshFileTree, activeFilePath, setActiveFilePath,
          openProject, closeProject } =
    useProjectStore();

  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [creatingType, setCreatingType] = useState<"file" | "folder">("file");
  const [createError, setCreateError] = useState<string | null>(null);
  const [menu, setMenu] = useState<CtxMenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

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
      if (creatingType === "folder") {
        await makeDir(`${creatingIn}/${name}`);
      } else {
        const finalName = name.includes(".") ? name : `${name}.md`;
        const path = `${creatingIn}/${finalName}`;
        await writeFile(path, "");
        setActiveFilePath(path);
      }
      await refreshFileTree();
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
    const newPath = `${parentDir(node.path)}/${name}`;
    try {
      // Flush unsaved editor content living at/under the old path before moving it.
      const editor = useEditorStore.getState();
      const editorAffected = editor.filePath === node.path
        || (node.is_dir && !!editor.filePath?.startsWith(node.path + "/"));
      if (editorAffected && editor.isDirty) await editor.saveNow();

      await renamePath(node.path, newPath);

      // Keep the open document pointed at its new location.
      if (activeFilePath === node.path) {
        setActiveFilePath(newPath);
      } else if (node.is_dir && activeFilePath?.startsWith(node.path + "/")) {
        setActiveFilePath(newPath + activeFilePath.slice(node.path.length));
      }
      await refreshFileTree();
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
      const affected = activeFilePath === node.path
        || (node.is_dir && !!activeFilePath?.startsWith(node.path + "/"));
      if (affected) {
        // Drop editor state first so a pending autosave can't resurrect the file.
        const editor = useEditorStore.getState();
        if (editor.saveTimer) clearTimeout(editor.saveTimer);
        useEditorStore.setState({ content: "", filePath: null, headings: [], isDirty: false, saveTimer: null });
        useProjectStore.getState().setActiveFilePath(null);
      }
      if (node.is_dir) await removeDir(node.path);
      else await removeFile(node.path);
    } catch (err) {
      console.error("[fileTree] delete failed:", err);
    }
    await refreshFileTree();
  };

  const openMenu = (e: MouseEvent, node: FileNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  const buildMenuItems = (node: FileNode | null): ContextMenuEntry[] => {
    const reveal = (path: string) => {
      revealItemInDir(path).catch(() => { /* best-effort */ });
    };
    if (!node) {
      return [
        { kind: "item", icon: <FilePlus size={13} />, label: t("fileTree.newFile"),
          action: () => { if (projectPath) startCreate(`${projectPath}/writing`, "file"); } },
        { kind: "item", icon: <FolderPlus size={13} />, label: t("fileTree.newFolder"),
          action: () => { if (projectPath) startCreate(`${projectPath}/writing`, "folder"); } },
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
      );
    } else {
      items.push(
        { kind: "item", icon: <FileText size={13} />, label: t("fileTree.open"),
          action: () => setActiveFilePath(node.path) },
      );
    }
    items.push(
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
              onClick={() => projectPath && startCreate(`${projectPath}/writing`, "file")}
            >
              <FilePlus size={14} />
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

        {/* Tree or empty state */}
        <div className={styles.tree} onContextMenu={(e) => openMenu(e, null)}>
          {fileTree.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyText}>{t("project.emptyTree")}</div>
              <button
                className={styles.createBtn}
                onClick={() => projectPath && startCreate(`${projectPath}/writing`, "file")}
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
