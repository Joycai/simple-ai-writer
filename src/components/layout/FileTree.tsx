import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../stores/projectStore";
import type { FileNode } from "../../lib/project";
import styles from "./FileTree.module.css";

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const { activeFilePath, setActiveFilePath } = useProjectStore();
  const isActive = activeFilePath === node.path;

  const handleClick = () => {
    if (node.is_dir) {
      setOpen((o) => !o);
    } else {
      setActiveFilePath(node.path);
    }
  };

  const icon = node.is_dir ? (open ? "📂" : "📁") : "📄";

  return (
    <div>
      <div
        className={`${styles.node} ${isActive ? styles.active : ""}`}
        onClick={handleClick}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {node.is_dir && (
          <span className={`${styles.chevron} ${open ? styles.open : ""}`}>›</span>
        )}
        <span className={styles.icon}>{icon}</span>
        <span className={styles.label}>{node.name}</span>
      </div>

      {node.is_dir && open && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree() {
  const { t } = useTranslation();
  const { fileTree } = useProjectStore();

  if (fileTree.length === 0) {
    return (
      <div style={{ padding: "var(--space-3)", color: "var(--color-text-muted)", fontSize: "var(--font-size-xs)" }}>
        {t("project.emptyTree")}
      </div>
    );
  }

  return (
    <div className={styles.tree}>
      {fileTree.map((node) => (
        <TreeNode key={node.path} node={node} depth={0} />
      ))}
    </div>
  );
}
