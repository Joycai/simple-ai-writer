import {
  useState, useRef, useEffect, createContext, useContext,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Folder, FolderOpen, FileText, File, ChevronRight,
  FilePlus, FolderPlus, RotateCw,
} from "lucide-react";
import { writeFile, makeDir } from "../../lib/fileio";
import { useProjectStore } from "../../stores/projectStore";
import type { FileNode } from "../../lib/project";
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
}

const TreeCtx = createContext<TreeCtx>(null!);

// ── Inline create input ───────────────────────────────────────────────────────

function CreateInput({ depth }: { depth: number }) {
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
          placeholder={creatingType === "folder" ? "folder name" : "filename.md"}
        />
      </div>
      {createError && <div className={styles.createError}>{createError}</div>}
    </>
  );
}

// ── File icon by extension ────────────────────────────────────────────────────

function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["md", "txt", "markdown"].includes(ext))
    return <FileText size={14} className={styles.fileIcon} />;
  return <File size={14} className={styles.fileIcon} />;
}

// ── Tree node ─────────────────────────────────────────────────────────────────

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const { activeFilePath, setActiveFilePath, creatingIn, startCreate } = useContext(TreeCtx);
  const [open, setOpen] = useState(depth === 0 || node.name === "writing");
  const isActive = !node.is_dir && activeFilePath === node.path;

  const handleClick = () => {
    if (node.is_dir) setOpen((o) => !o);
    else setActiveFilePath(node.path);
  };

  return (
    <div>
      <div
        className={`${styles.node} ${isActive ? styles.active : ""}`}
        style={{ paddingLeft: `${4 + depth * 12}px` }}
        onClick={handleClick}
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
        <span className={styles.label}>{node.name}</span>

        {node.is_dir && (
          <span className={styles.nodeActions} onClick={(e) => e.stopPropagation()}>
            <button
              className={styles.nodeActionBtn}
              title="New File"
              onClick={() => { setOpen(true); startCreate(node.path, "file"); }}
            >
              <FilePlus size={12} />
            </button>
            <button
              className={styles.nodeActionBtn}
              title="New Folder"
              onClick={() => { setOpen(true); startCreate(node.path, "folder"); }}
            >
              <FolderPlus size={12} />
            </button>
          </span>
        )}
      </div>

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

// ── Main FileTree ─────────────────────────────────────────────────────────────

export function FileTree() {
  const { t } = useTranslation();
  const { fileTree, projectPath, refreshFileTree, activeFilePath, setActiveFilePath } =
    useProjectStore();

  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [creatingType, setCreatingType] = useState<"file" | "folder">("file");
  const [createError, setCreateError] = useState<string | null>(null);

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
              title={t("fileTree.newFile")}
              onClick={() => projectPath && startCreate(`${projectPath}/writing`, "file")}
            >
              <FilePlus size={14} />
            </button>
            <button
              className={styles.toolbarBtn}
              title="Refresh"
              onClick={() => void refreshFileTree()}
            >
              <RotateCw size={13} />
            </button>
          </span>
        </div>

        {/* Tree or empty state */}
        <div className={styles.tree}>
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
    </TreeCtx.Provider>
  );
}
