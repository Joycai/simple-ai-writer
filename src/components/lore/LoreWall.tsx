import { useState, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Search, Sparkles, Plus, Camera, BookOpen, Pencil, FolderOpen, RotateCw, Trash2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile as readBinaryFile } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useLoreStore } from "../../stores/loreStore";
import { useProjectStore } from "../../stores/projectStore";
import { LORE_CATEGORIES, setEntityAvatar, slugifyEntityId, uniqueEntityId, type CategoryId, type LoreEntity } from "../../lib/lore";
import { useAppStore } from "../../stores/appStore";
import { imageToDataUrl } from "../../lib/fs/images";
import { MOD_K_SPACED } from "../../lib/platform";
import { LoreGenerator } from "./LoreGenerator";
import { LoreDetail } from "./LoreDetail";
import { ContextMenu, type ContextMenuEntry } from "../common/ContextMenu";
import styles from "./LoreWall.module.css";

// Per-category accent dot color
const CAT_COLOR: Record<string, string> = {
  characters: "var(--color-sienna)",
  world:      "var(--color-success)",
  items:      "var(--color-amber)",
  factions:   "var(--color-text-primary)",
  skills:     "#7BA8A6",
  style:      "#A78BBA",
  custom:     "var(--color-text-muted)",
};

// Stable, deterministic small rotation per entity id
function rotationFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const r = ((h % 9) - 4) * 0.1; // -0.4 .. +0.4 deg
  return Number(r.toFixed(2));
}

export function LoreWall() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const { index, scanProject, createNewEntity, deleteEntity } = useLoreStore();
  const { projectPath } = useProjectStore();
  const setShowCommandPalette = useAppStore((s) => s.setShowCommandPalette);

  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [showGenerator, setShowGenerator] = useState(false);
  const [showNewEntry, setShowNewEntry] = useState(false);
  const [detailEntity, setDetailEntity] = useState<LoreEntity | null>(null);
  const [detailEditing, setDetailEditing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; entity: LoreEntity | null } | null>(null);

  // Avatar rendering uses data URLs (see LoreDetail rationale: Webview2's strict
  // URL parsing on Windows drive-letter paths makes the ai-writer-asset://
  // protocol unreliable). Keyed by entity id so the lookup is stable across
  // re-scans even if the entity object identity changes.
  const [avatarDataUrls, setAvatarDataUrls] = useState<Record<string, string>>({});
  const [avatarBusy, setAvatarBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const cat of LORE_CATEGORIES) {
        for (const e of (index[cat.id] ?? [])) {
          if (!e.avatarPath) continue;
          try {
            const { dataUrl } = await imageToDataUrl(e.avatarPath);
            next[e.id] = dataUrl;
          } catch {
            // skip — fall back to letter placeholder
          }
        }
      }
      if (!cancelled) setAvatarDataUrls(next);
    })();
    return () => { cancelled = true; };
  }, [index]);

  const handleAvatarPick = async (entity: LoreEntity) => {
    if (!projectPath || avatarBusy) return;
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof picked !== "string") return;
    setAvatarBusy(entity.id);
    try {
      const bytes = await readBinaryFile(picked);
      const ext = (picked.split(".").pop() ?? "png").toLowerCase();
      await setEntityAvatar(entity.dirPath, bytes, ext);
      await scanProject(projectPath);
    } finally {
      setAvatarBusy(null);
    }
  };

  // Flatten + filter
  const allEntities = useMemo(() => {
    const flat: LoreEntity[] = [];
    for (const cat of LORE_CATEGORIES) {
      for (const e of (index[cat.id] ?? [])) flat.push(e);
    }
    return flat;
  }, [index]);

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: allEntities.length };
    for (const cat of LORE_CATEGORIES) {
      out[cat.id] = (index[cat.id] ?? []).length;
    }
    return out;
  }, [allEntities, index]);

  const filtered = useMemo(() => {
    let list = allEntities;
    if (filter !== "all") list = list.filter((e) => e.category === filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.aliases.some((a) => a.toLowerCase().includes(q)) ||
          e.summary.toLowerCase().includes(q),
      );
    }
    return list;
  }, [allEntities, filter, search]);

  const totalRelations = 0; // future

  const handleDeleteEntity = async (e: LoreEntity) => {
    if (!projectPath) return;
    if (!window.confirm(t("lore.panel.deleteConfirm", { name: e.name }))) return;
    await deleteEntity(projectPath, e);
  };

  const buildMenuItems = (e: LoreEntity | null): ContextMenuEntry[] => {
    if (!e) {
      return [
        { kind: "item", icon: <Plus size={13} />, label: t("lore.panel.newEntry"),
          action: () => setShowNewEntry(true) },
        { kind: "item", icon: <Sparkles size={13} />, label: "AI 提取",
          action: () => setShowGenerator(true) },
        { kind: "divider" },
        { kind: "item", icon: <RotateCw size={13} />, label: t("fileTree.refresh"),
          action: () => { if (projectPath) void scanProject(projectPath); } },
      ];
    }
    return [
      { kind: "item", icon: <BookOpen size={13} />, label: t("fileTree.open"),
        action: () => setDetailEntity(e) },
      { kind: "item", icon: <Pencil size={13} />, label: t("lore.detail.edit", { defaultValue: "编辑" }),
        action: () => { setDetailEditing(true); setDetailEntity(e); } },
      { kind: "item", icon: <Camera size={13} />, label: t("lore.wall.changeAvatar", { defaultValue: "更换头像" }),
        action: () => void handleAvatarPick(e) },
      { kind: "item", icon: <FolderOpen size={13} />, label: t("lore.panel.showInBrowser"),
        action: () => { revealItemInDir(e.dirPath).catch(() => { /* best-effort */ }); } },
      { kind: "divider" },
      { kind: "item", icon: <Trash2 size={13} />, label: t("lore.panel.deleteEntity"), danger: true,
        action: () => void handleDeleteEntity(e) },
    ];
  };

  if (detailEntity) {
    return (
      <LoreDetail
        entity={detailEntity}
        initialEditing={detailEditing}
        onBack={() => { setDetailEntity(null); setDetailEditing(false); }}
      />
    );
  }

  return (
    <div className={styles.wall}>
      {showGenerator && <LoreGenerator onClose={() => setShowGenerator(false)} />}
      {showNewEntry && (
        <NewEntryModal
          initialCategory={(filter !== "all" ? (filter as CategoryId) : "characters")}
          onClose={() => setShowNewEntry(false)}
          onCreate={async (category, name) => {
            if (!projectPath) return;
            const baseId = slugifyEntityId(name);
            const id = await uniqueEntityId(projectPath, category, baseId);
            await createNewEntity(projectPath, category, id, name.trim());
            setShowNewEntry(false);
            const created = useLoreStore.getState().index[category]?.find((e) => e.id === id);
            if (created) setDetailEntity(created);
          }}
        />
      )}

      <div className={styles.header}>
        <div className={styles.headerRow}>
          <div className={styles.eyebrow}>LORE LIBRARY</div>
          <div className={styles.title}>{t("sidebar.lore")}</div>
          <div className={styles.subtitle}>
            {counts.all} 条 · {totalRelations} 关系
          </div>
          <span className={styles.spacer} />

          <div className={styles.search}>
            <Search size={12} color="var(--color-text-muted)" strokeWidth={1.6} />
            <input
              className={styles.searchInput}
              placeholder={t("sidebar.projectSearch")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className={styles.searchKey} onClick={() => setShowCommandPalette(true)} style={{ cursor: "pointer" }}>{MOD_K_SPACED}</span>
          </div>

          <button className={styles.btnSecondary} onClick={() => setShowGenerator(true)}>
            <Sparkles size={12} strokeWidth={1.6} />
            AI 提取
          </button>
          <button className={styles.btnPrimary} onClick={() => setShowNewEntry(true)}>
            <Plus size={12} strokeWidth={2.5} />
            {t("lore.panel.newEntry")}
          </button>
        </div>

        <div className={styles.filters}>
          <span
            className={`${styles.chip} ${filter === "all" ? styles.chipActive : ""}`}
            onClick={() => setFilter("all")}
          >
            {isZh ? "全部" : "All"}
            <span className={styles.chipCount}>{counts.all}</span>
          </span>
          {LORE_CATEGORIES.map((cat) => (
            <span
              key={cat.id}
              className={`${styles.chip} ${filter === cat.id ? styles.chipActive : ""}`}
              onClick={() => setFilter(cat.id)}
            >
              <span className={styles.chipDot} style={{ background: CAT_COLOR[cat.id] }} />
              {isZh ? cat.labelZh : cat.labelEn}
              <span className={styles.chipCount}>{counts[cat.id] ?? 0}</span>
            </span>
          ))}
        </div>
      </div>

      <div
        className={styles.gridWrap}
        onContextMenu={(ev) => {
          ev.preventDefault();
          setMenu({ x: ev.clientX, y: ev.clientY, entity: null });
        }}
      >
        {filtered.length === 0 ? (
          <div className={styles.empty}>
            {search.trim()
              ? "未找到匹配的设定"
              : "设定库为空 — 用 AI 提取或新建条目开始构建你的世界观"}
          </div>
        ) : (
          <div className={styles.grid}>
            {filtered.map((e, idx) => {
              const featured = idx === 0 && filter === "all";
              const rot = rotationFor(e.id);
              const cat = LORE_CATEGORIES.find((c) => c.id === e.category);
              return (
                <div
                  key={e.id}
                  className={`${styles.card} ${featured ? styles.cardFeatured : ""}`}
                  style={{ transform: `rotate(${rot}deg)` }}
                  onClick={() => setDetailEntity(e)}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    setMenu({ x: ev.clientX, y: ev.clientY, entity: e });
                  }}
                >
                  <div className={styles.cardTop}>
                    <span className={styles.cardLabel}>
                      {(isZh ? cat?.labelZh : cat?.labelEn) ?? e.category}
                    </span>
                  </div>
                  <div className={styles.cardHeader}>
                    <div
                      className={styles.cardAvatarWrap}
                      onClick={(ev) => { ev.stopPropagation(); handleAvatarPick(e); }}
                      title={t("lore.wall.changeAvatar", { defaultValue: "更换头像" })}
                    >
                      {avatarDataUrls[e.id] ? (
                        <img
                          src={avatarDataUrls[e.id]}
                          alt={e.name}
                          className={styles.cardAvatarImg}
                        />
                      ) : (
                        <div
                          className={styles.cardAvatar}
                          style={{ background: CAT_COLOR[e.category] }}
                        >
                          {e.name.charAt(0)}
                        </div>
                      )}
                      <div className={styles.cardAvatarOverlay}>
                        <Camera size={14} strokeWidth={1.8} />
                      </div>
                    </div>
                    <div>
                      <div className={styles.cardName}>{e.name}</div>
                      <div className={styles.cardMeta}>{e.aliases.slice(0, 2).join(" · ")}</div>
                    </div>
                  </div>
                  <div className={styles.cardSummary}>
                    {e.summary || "—"}
                  </div>
                  {e.aliases.length > 0 && (
                    <div className={styles.cardTags}>
                      {e.aliases.slice(0, 4).map((a) => (
                        <span key={a} className={styles.cardTag}>{a}</span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* + new card */}
            <div className={styles.newCard} onClick={() => setShowGenerator(true)}>
              <Plus size={22} color="var(--color-sienna)" strokeWidth={1.6} />
              <div className={styles.newCardLabel}>新设定</div>
              <div className={styles.newCardHint}>手填或从手稿提取</div>
            </div>
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.entity)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function NewEntryModal({
  initialCategory,
  onClose,
  onCreate,
}: {
  initialCategory: CategoryId;
  onClose: () => void;
  onCreate: (category: CategoryId, name: string) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const [category, setCategory] = useState<CategoryId>(initialCategory);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await onCreate(category, name);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <div className={styles.modalEyebrow}>{isZh ? "新建条目" : "NEW ENTRY"}</div>
          <div className={styles.modalTitle}>{t("lore.panel.newEntry")}</div>
        </div>

        <div className={styles.modalBody}>
          <label className={styles.modalLabel}>{isZh ? "分类" : "Category"}</label>
          <div className={styles.modalCats}>
            {LORE_CATEGORIES.map((cat) => (
              <span
                key={cat.id}
                className={`${styles.chip} ${category === cat.id ? styles.chipActive : ""}`}
                onClick={() => setCategory(cat.id)}
              >
                <span className={styles.chipDot} style={{ background: CAT_COLOR[cat.id] }} />
                {isZh ? cat.labelZh : cat.labelEn}
              </span>
            ))}
          </div>

          <label className={styles.modalLabel}>{isZh ? "名称" : "Name"}</label>
          <input
            className={styles.modalInput}
            placeholder={t("lore.form.namePlaceholder", { defaultValue: isZh ? "条目名称" : "Entry name" })}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSubmit();
              if (e.key === "Escape") onClose();
            }}
            autoFocus
          />
        </div>

        <div className={styles.modalActions}>
          <button className={styles.btnSecondary} onClick={onClose}>
            {t("lore.form.cancel", { defaultValue: isZh ? "取消" : "Cancel" })}
          </button>
          <button
            className={styles.btnPrimary}
            onClick={handleSubmit}
            disabled={!name.trim() || saving}
          >
            {saving
              ? t("lore.form.creating", { defaultValue: isZh ? "创建中…" : "Creating…" })
              : t("lore.form.create", { defaultValue: isZh ? "创建" : "Create" })}
          </button>
        </div>
      </div>
    </div>
  );
}
