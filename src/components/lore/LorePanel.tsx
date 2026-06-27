import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  User, Globe, Shield, Package, Zap, Grid2X2,
  FileText, Bot, ChevronRight, Plus, Star, Sparkles, Trash2, FolderOpen, Images,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useLoreStore } from "../../stores/loreStore";
import { useProjectStore } from "../../stores/projectStore";
import { useAppStore } from "../../stores/appStore";
import { LORE_CATEGORIES, assetUrl, slugifyEntityId, uniqueEntityId, type CategoryId, type LoreEntity } from "../../lib/lore";
import { LoreGenerator } from "./LoreGenerator";
import { LoreImproveModal } from "./LoreImproveModal";
import styles from "./LorePanel.module.css";

const CAT_ICONS: Record<string, React.ReactNode> = {
  user:    <User size={12} />,
  globe:   <Globe size={12} />,
  shield:  <Shield size={12} />,
  package: <Package size={12} />,
  zap:     <Zap size={12} />,
  grid:    <Grid2X2 size={12} />,
};

const CAT_PLACEHOLDER: Record<string, React.ReactNode> = {
  user:    <User size={15} strokeWidth={1.5} />,
  globe:   <Globe size={15} strokeWidth={1.5} />,
  shield:  <Shield size={15} strokeWidth={1.5} />,
  package: <Package size={15} strokeWidth={1.5} />,
  zap:     <Zap size={15} strokeWidth={1.5} />,
  grid:    <Grid2X2 size={15} strokeWidth={1.5} />,
};

// ── Context menu ─────────────────────────────────────────────────────────────

interface CtxMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  items: { label: string; icon?: React.ReactNode; danger?: boolean; onClick: () => void }[];
}

function ContextMenu({ x, y, onClose, items }: CtxMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    // Use capture so this fires before any other click handlers
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [onClose]);

  // Flip menu left/up if it would overflow viewport
  const style: React.CSSProperties = { position: "fixed", zIndex: 300 };
  if (x + 180 > window.innerWidth) {
    style.right = window.innerWidth - x;
  } else {
    style.left = x;
  }
  if (y + items.length * 34 + 8 > window.innerHeight) {
    style.bottom = window.innerHeight - y;
  } else {
    style.top = y;
  }

  return (
    <div ref={menuRef} className={styles.ctxMenu} style={style}>
      {items.map((item) => (
        <button
          key={item.label}
          className={`${styles.ctxItem} ${item.danger ? styles.ctxItemDanger : ""}`}
          onClick={() => { item.onClick(); onClose(); }}
        >
          {item.icon && <span className={styles.ctxIcon}>{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>
  );
}

// ── Inline new-entity form ────────────────────────────────────────────────────

function NewEntityForm({ category, onClose }: { category: CategoryId; onClose: () => void }) {
  const { t } = useTranslation();
  const { projectPath } = useProjectStore();
  const { createNewEntity } = useLoreStore();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!projectPath || !name.trim()) return;
    setSaving(true);
    try {
      const baseId = slugifyEntityId(name);
      const id = await uniqueEntityId(projectPath, category, baseId);
      await createNewEntity(projectPath, category, id, name.trim());
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.newEntityForm}>
      <input
        className={styles.newEntityInput}
        placeholder={t("lore.form.namePlaceholder")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void handleCreate();
          if (e.key === "Escape") onClose();
        }}
        autoFocus
      />
      <div className={styles.newEntityActions}>
        <button className={styles.btnSecondary} onClick={onClose}>
          {t("lore.form.cancel")}
        </button>
        <button
          className={styles.btnPrimary}
          onClick={handleCreate}
          disabled={!name.trim() || saving}
        >
          {saving ? t("lore.form.creating") : t("lore.form.create")}
        </button>
      </div>
    </div>
  );
}

// ── Delete confirmation ───────────────────────────────────────────────────────

function DeleteConfirm({ entity, onCancel, onConfirm }: {
  entity: LoreEntity;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.deleteConfirm}>
      <span className={styles.deleteMsg}>
        {t("lore.panel.deleteConfirm", { name: entity.name })}
      </span>
      <div className={styles.deleteActions}>
        <button className={styles.btnSecondary} onClick={onCancel}>{t("lore.form.cancel")}</button>
        <button className={styles.btnDanger} onClick={onConfirm}>{t("lore.panel.deleteBtn")}</button>
      </div>
    </div>
  );
}

// ── Entity card ───────────────────────────────────────────────────────────────

function EntityCard({ entity }: { entity: LoreEntity }) {
  const { t } = useTranslation();
  const { activeFilePath, setActiveFilePath, projectPath } = useProjectStore();
  const { deleteEntity: doDelete } = useLoreStore();
  const setMainView = useAppStore((s) => s.setMainView);
  const setPendingLoreNav = useAppStore((s) => s.setPendingLoreNav);
  const [expanded, setExpanded] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [showImprove, setShowImprove] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const catInfo = LORE_CATEGORIES.find((c) => c.id === entity.category);

  const files = [...entity.mdFiles].sort((a, b) => {
    if (a === "index.md") return -1;
    if (b === "index.md") return 1;
    return a.localeCompare(b);
  });

  const openFile = (filename: string) => {
    setActiveFilePath(`${entity.dirPath}/${filename}`);
  };

  const handleReveal = async () => {
    try { await revealItemInDir(entity.dirPath); } catch { /* best-effort */ }
  };

  // Jump to the entity's detail page and auto-scroll to the gallery section.
  // The actual scroll is handled by LoreDetail once it observes pendingLoreNav.
  const handleManageImages = () => {
    setMainView("lore-wall");
    setPendingLoreNav({
      entityId: entity.id,
      category: entity.category,
      anchor: "gallery",
    });
  };

  const handleDelete = async () => {
    if (!projectPath) return;
    await doDelete(projectPath, entity);
  };

  const ctxItems = [
    {
      label: t("lore.panel.manageImages", { defaultValue: "管理图片…" }),
      icon: <Images size={13} />,
      onClick: handleManageImages,
    },
    {
      label: t("lore.panel.showInBrowser"),
      icon: <FolderOpen size={13} />,
      onClick: handleReveal,
    },
    {
      label: t("lore.panel.aiImprove"),
      icon: <Sparkles size={13} />,
      onClick: () => setShowImprove(true),
    },
    {
      label: t("lore.panel.deleteEntity"),
      icon: <Trash2 size={13} />,
      danger: true,
      // Auto-expand the card so the inline DeleteConfirm (which only renders
      // inside the expanded body) actually mounts. Without this, the right-
      // click delete appeared to do nothing on collapsed cards.
      onClick: () => { setExpanded(true); setShowDeleteConfirm(true); },
    },
  ];

  return (
    <>
      {showImprove && (
        <LoreImproveModal entity={entity} onClose={() => setShowImprove(false)} />
      )}

      <div
        className={`${styles.entityCard} ${expanded ? styles.entityCardOpen : ""}`}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtxMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {ctxMenu && (
          <ContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            onClose={() => setCtxMenu(null)}
            items={ctxItems}
          />
        )}

        {/* Header row */}
        <div className={styles.entityRow} onClick={() => setExpanded((v) => !v)}>
          <div className={styles.entityThumb}>
            {entity.avatarPath ? (
              <img
                src={assetUrl(entity.avatarPath)}
                alt={entity.name}
                className={styles.entityThumbImg}
              />
            ) : (
              <div className={styles.entityThumbPlaceholder}>
                {CAT_PLACEHOLDER[catInfo?.icon ?? ""] ?? <FileText size={15} strokeWidth={1.5} />}
              </div>
            )}
          </div>
          <span className={styles.entityCardName}>{entity.name}</span>
          <ChevronRight
            size={12}
            className={`${styles.entityChevron} ${expanded ? styles.entityChevronOpen : ""}`}
          />
        </div>

        {/* Expanded body */}
        {expanded && (
          <div className={styles.entityBody}>
            {/* Meta */}
            {(entity.summary || entity.aliases.length > 0) && (
              <div className={styles.entityMeta}>
                {entity.summary && (
                  <div className={styles.entitySummary}>{entity.summary}</div>
                )}
                {entity.aliases.length > 0 && (
                  <div className={styles.entityAliases}>
                    {entity.aliases.map((a) => (
                      <span key={a} className={styles.alias}>{a}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Delete confirm */}
            {showDeleteConfirm && (
              <DeleteConfirm
                entity={entity}
                onCancel={() => setShowDeleteConfirm(false)}
                onConfirm={handleDelete}
              />
            )}

            {/* Action bar */}
            {!showDeleteConfirm && (
              <div className={styles.entityActions}>
                <button
                  className={styles.entityActionBtn}
                  onClick={() => setShowImprove(true)}
                  title={t("lore.panel.aiImprove")}
                >
                  <Sparkles size={11} />
                  {t("lore.panel.aiImprove")}
                </button>
                <button
                  className={styles.entityActionBtn}
                  onClick={handleManageImages}
                  title={t("lore.panel.manageImages", { defaultValue: "管理图片…" })}
                >
                  <Images size={11} />
                  {entity.images.length > 0 && (
                    <span style={{ marginLeft: 4, fontFamily: "var(--font-mono)", fontSize: 10, opacity: 0.75 }}>
                      {entity.images.length}
                    </span>
                  )}
                </button>
                <button
                  className={styles.entityActionBtn}
                  onClick={handleReveal}
                  title={t("lore.panel.showInBrowser")}
                >
                  <FolderOpen size={11} />
                </button>
                <button
                  className={`${styles.entityActionBtn} ${styles.entityActionDanger}`}
                  onClick={() => setShowDeleteConfirm(true)}
                  title={t("lore.panel.deleteEntity")}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            )}

            {/* File tree */}
            <div className={styles.entityFiles}>
              {files.map((f) => {
                const isEntry = f === "index.md";
                const fullPath = `${entity.dirPath}/${f}`;
                const isActive = activeFilePath === fullPath;
                return (
                  <div
                    key={f}
                    className={`${styles.entityFile} ${isEntry ? styles.entryFile : ""} ${isActive ? styles.activeFile : ""}`}
                    onClick={(e) => { e.stopPropagation(); openFile(f); }}
                  >
                    {isEntry
                      ? <Star size={11} className={styles.entryIcon} />
                      : <FileText size={11} className={styles.fileIcon} />}
                    <span className={styles.fileName}>{f}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ── Main LorePanel ────────────────────────────────────────────────────────────

export function LorePanel() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const { index } = useLoreStore();
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());
  const [newEntityCat, setNewEntityCat] = useState<CategoryId | null>(null);
  const [showGenerator, setShowGenerator] = useState(false);

  const toggleCat = (id: string) =>
    setCollapsedCats((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className={styles.panel}>
      {showGenerator && <LoreGenerator onClose={() => setShowGenerator(false)} />}

      {/* Toolbar */}
      <div className={styles.toolbar}>
        <span className={styles.toolbarTitle}>LORE</span>
        <button className={styles.genBtn} onClick={() => setShowGenerator(true)}>
          <Bot size={12} />
          {t("lore.panel.generate")}
        </button>
      </div>

      {/* Scrollable library */}
      <div className={styles.library}>
        {LORE_CATEGORIES.map((cat) => {
          const entities: LoreEntity[] = index[cat.id] ?? [];
          const collapsed = collapsedCats.has(cat.id);

          return (
            <div key={cat.id} className={styles.category}>
              <div className={styles.categoryHeader} onClick={() => toggleCat(cat.id)}>
                <ChevronRight
                  size={11}
                  className={`${styles.catChevron} ${!collapsed ? styles.catChevronOpen : ""}`}
                />
                <span className={styles.catIcon}>{CAT_ICONS[cat.icon]}</span>
                <span className={styles.catLabel}>{isZh ? cat.labelZh : cat.labelEn}</span>
                <span className={styles.catCount}>{entities.length}</span>
                <button
                  className={styles.catAddBtn}
                  title={t("lore.panel.newEntry")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setCollapsedCats((prev) => {
                      const next = new Set(prev);
                      next.delete(cat.id);
                      return next;
                    });
                    setNewEntityCat(cat.id as CategoryId);
                  }}
                >
                  <Plus size={11} />
                </button>
              </div>

              {!collapsed && (
                <div className={styles.categoryBody}>
                  {newEntityCat === cat.id && (
                    <NewEntityForm
                      category={cat.id as CategoryId}
                      onClose={() => setNewEntityCat(null)}
                    />
                  )}
                  {entities.map((entity) => (
                    <EntityCard key={entity.id} entity={entity} />
                  ))}
                  {entities.length === 0 && newEntityCat !== cat.id && (
                    <div className={styles.catEmpty}>{t("lore.panel.empty")}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
