import { useState } from "react";
import { useLoreStore } from "../../stores/loreStore";
import { useProjectStore } from "../../stores/projectStore";
import { LORE_CATEGORIES, assetUrl, type CategoryId, type LoreEntity } from "../../lib/lore";
import { CodeEditor } from "../editor/CodeEditor";
import { LoreGenerator } from "./LoreGenerator";
import styles from "./LorePanel.module.css";

// ─── New entity form ─────────────────────────────────────────────────────────

function NewEntityForm({
  category,
  onClose,
}: {
  category: CategoryId;
  onClose: () => void;
}) {
  const { projectPath } = useProjectStore();
  const { createNewEntity } = useLoreStore();
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!projectPath || !name.trim() || !id.trim()) return;
    setSaving(true);
    try {
      await createNewEntity(projectPath, category, id.trim(), name.trim());
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.newEntityForm}>
      <div className={styles.formTitle}>新建设定条目</div>
      <input
        className={styles.input}
        placeholder="名称 (e.g. 艾尔登)"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          if (!id) setId(e.target.value.toLowerCase().replace(/\s+/g, "_"));
        }}
        autoFocus
      />
      <input
        className={styles.input}
        placeholder="目录ID (e.g. elden)"
        value={id}
        onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
      />
      <div className={styles.formActions}>
        <button className={styles.btnSecondary} onClick={onClose}>取消</button>
        <button
          className={styles.btnPrimary}
          onClick={handleCreate}
          disabled={!name.trim() || !id.trim() || saving}
        >
          {saving ? "创建中…" : "创建"}
        </button>
      </div>
    </div>
  );
}

// ─── Entity detail ────────────────────────────────────────────────────────────

function EntityDetail({ entity }: { entity: LoreEntity }) {
  const { selectedFile, fileContent, isDirty, selectFile, setFileContent, saveNow } =
    useLoreStore();
  const catInfo = LORE_CATEGORIES.find((c) => c.id === entity.category);

  return (
    <div className={styles.detail}>
      {/* Header: avatar + name + summary + aliases */}
      <div className={styles.detailHeader}>
        <div className={styles.detailHero}>
          {entity.avatarPath ? (
            <img
              src={assetUrl(entity.avatarPath)}
              alt={entity.name}
              className={styles.detailAvatar}
            />
          ) : (
            <div className={styles.detailAvatarPlaceholder}>
              {catInfo?.icon ?? "📄"}
            </div>
          )}
          <div className={styles.detailInfo}>
            <div className={styles.detailName}>{entity.name}</div>
            {entity.summary && (
              <div className={styles.detailSummary}>{entity.summary}</div>
            )}
            {entity.aliases.length > 0 && (
              <div className={styles.detailAliases}>
                {entity.aliases.map((a) => (
                  <span key={a} className={styles.alias}>{a}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* File tabs */}
      <div className={styles.fileTabs}>
        {entity.mdFiles.map((f) => (
          <button
            key={f}
            className={`${styles.fileTab} ${selectedFile === f ? styles.activeTab : ""}`}
            onClick={() => selectFile(f)}
          >
            {f}
            {isDirty && selectedFile === f && " •"}
          </button>
        ))}
      </div>

      {/* Editor for selected file */}
      {selectedFile ? (
        <div className={styles.entityEditor}>
          <div style={{ height: 30, display: "flex", alignItems: "center", padding: "0 12px", gap: 8, borderBottom: "1px solid var(--color-border)", flexShrink: 0 }}>
            <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)", flex: 1 }}>
              {selectedFile}
            </span>
            {isDirty && (
              <button
                onClick={saveNow}
                style={{ fontSize: "var(--font-size-xs)", color: "var(--color-accent)", padding: "2px 8px", background: "rgba(59,130,246,0.12)", borderRadius: "var(--radius-sm)" }}
              >
                保存
              </button>
            )}
          </div>
          <CodeEditor value={fileContent} onChange={setFileContent} />
        </div>
      ) : (
        <div className={styles.emptyDetail}>选择一个文件查看</div>
      )}
    </div>
  );
}

// ─── Main LorePanel ───────────────────────────────────────────────────────────

export function LorePanel() {
  const { index, selectedEntity, selectEntity } = useLoreStore();
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
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "4px var(--space-2)", borderBottom: "1px solid var(--color-border)", flexShrink: 0 }}>
        <button
          onClick={() => setShowGenerator(true)}
          style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: "var(--radius-sm)", background: "rgba(59,130,246,0.12)", color: "var(--color-accent)", fontSize: "var(--font-size-xs)", fontWeight: 500 }}
          title="用 AI 根据描述和图片生成设定条目"
        >
          🤖 AI 生成
        </button>
      </div>

      {/* Entity list (top, scrollable) */}
      <div className={styles.categoryList} style={{ maxHeight: "45%" }}>
        {LORE_CATEGORIES.map((cat) => {
          const entities: LoreEntity[] = index[cat.id] ?? [];
          const collapsed = collapsedCats.has(cat.id);
          return (
            <div key={cat.id} className={styles.category}>
              <div className={styles.categoryHeader} onClick={() => toggleCat(cat.id)}>
                <span className={styles.categoryIcon}>{cat.icon}</span>
                <span className={styles.categoryLabel}>{cat.labelZh}</span>
                <span style={{ fontSize: 10, opacity: 0.5, marginRight: 4 }}>
                  {entities.length}
                </span>
                <button
                  className={styles.addBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    setNewEntityCat(cat.id as CategoryId);
                  }}
                  title="新建条目"
                >
                  +
                </button>
              </div>

              {!collapsed && (
                <div className={styles.entityList}>
                  {newEntityCat === cat.id && (
                    <NewEntityForm
                      category={cat.id as CategoryId}
                      onClose={() => setNewEntityCat(null)}
                    />
                  )}
                  {entities.map((entity) => (
                    <div
                      key={entity.id}
                      className={`${styles.entity} ${selectedEntity?.id === entity.id ? styles.active : ""}`}
                      onClick={() => selectEntity(entity)}
                    >
                      {entity.avatarPath ? (
                        <img
                          src={assetUrl(entity.avatarPath)}
                          alt={entity.name}
                          className={styles.entityAvatar}
                        />
                      ) : (
                        <span style={{ fontSize: 14 }}>{cat.icon}</span>
                      )}
                      <span className={styles.entityName}>{entity.name}</span>
                    </div>
                  ))}
                  {entities.length === 0 && newEntityCat !== cat.id && (
                    <div style={{ padding: "2px 12px 4px 28px", fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)" }}>
                      暂无条目
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Entity detail (bottom) */}
      {selectedEntity ? (
        <EntityDetail entity={selectedEntity} />
      ) : (
        <div className={styles.emptyDetail}>选择一个设定条目查看详情</div>
      )}
    </div>
  );
}
