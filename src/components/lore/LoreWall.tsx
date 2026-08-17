import { useState, useMemo, useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Search, Sparkles, Plus, Camera, BookOpen, Pencil, FolderOpen, RotateCw, Trash2, FileDown, FileUp, AlertTriangle } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile as readBinaryFile } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useLoreStore } from "../../stores/loreStore";
import { useProjectStore, useTerms } from "../../stores/projectStore";
import {
  applyLoreImport,
  cancelLoreImport,
  exportLoreBundle,
  setEntityAvatar,
  slugifyEntityId,
  stageLoreImport,
  uniqueEntityId,
  type CategoryId,
  type ConflictStrategy,
  type LoreEntity,
  type StagedLoreImport,
} from "../../lib/lore";
import { appTerms, categoryLabel, defaultCategoryId, findCategory, loreCategories, loreCategoryIds, suggestCategoryId } from "../../lib/profile";
import { useAppStore } from "../../stores/appStore";
import { imageToDataUrl } from "../../lib/fs/images";
import { MOD_K_SPACED } from "../../lib/platform";
import { useImeGuard } from "../../lib/ime";
import { LoreGenerator } from "./LoreGenerator";
import { NewEntryTabs, type NewEntryMode } from "./ai/NewEntryTabs";
import { LoreDetail } from "./LoreDetail";
import { ContextMenu, type ContextMenuEntry } from "../common/ContextMenu";
import { ModalShell } from "../common/ModalShell";
import { fillLayer, pushBackdrop, pushForward, springScreen } from "../../lib/motion";
import styles from "./LoreWall.module.css";

import { categoryColor } from "./catColor";

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
  const { index, scanProject, createNewEntity, deleteEntity, detailPath, detailEditing, openDetail } = useLoreStore();
  const { projectPath } = useProjectStore();
  const terms = useTerms();
  // The eyebrow is decorative English regardless of UI language (matching
  // "DOCUMENTS · 文档"), so it resolves the en term explicitly.
  const kbEyebrow = appTerms(false).kb.toUpperCase();
  const setShowCommandPalette = useAppStore((s) => s.setShowCommandPalette);

  // Entering the wall re-reads disk. There is no filesystem watcher, and this
  // component is unmounted on every view switch, so it otherwise renders
  // whatever index the store happens to hold — stale after an agent write that
  // landed while another view was up, or after a scan that failed. The store
  // coalesces queued scans, so a fast view toggle costs one walk, not several.
  useEffect(() => {
    if (projectPath) void scanProject(projectPath);
  }, [projectPath, scanProject]);

  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [showNewCategory, setShowNewCategory] = useState(false);
  // Unified new-entry flow: null = closed, else which mode the modal opens in.
  const [newMode, setNewMode] = useState<NewEntryMode | null>(null);
  // A passage the editor's 提取为设定 handed over. Read once, and held here for
  // the life of the modal so re-renders don't re-seed a description the author
  // has since edited.
  const pendingExtract = useLoreStore((s) => s.pendingExtract);
  const takePendingExtract = useLoreStore((s) => s.takePendingExtract);
  const [extractSeed, setExtractSeed] = useState<string | null>(null);
  useEffect(() => {
    if (pendingExtract === null) return;
    setExtractSeed(takePendingExtract());
    setNewMode("ai");
  }, [pendingExtract, takePendingExtract]);
  const [menu, setMenu] = useState<{ x: number; y: number; entity: LoreEntity | null } | null>(null);
  // Lore bundle transfer: staged import awaiting the user's conflict decision.
  const [importStaged, setImportStaged] = useState<StagedLoreImport | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);

  // Avatar rendering uses data URLs (see LoreDetail rationale: Webview2's strict
  // URL parsing on Windows drive-letter paths makes the ai-writer-asset://
  // protocol unreliable). Keyed by entity id so the lookup is stable across
  // re-scans even if the entity object identity changes.
  const [avatarDataUrls, setAvatarDataUrls] = useState<Record<string, string>>({});
  const [avatarBusy, setAvatarBusy] = useState<string | null>(null);

  // Which entity the detail view is showing. Resolved from the index on every
  // render rather than held as an object: the open entity survives a re-scan,
  // and a path opened before the index was ready (a citation click during a
  // scan) starts rendering the moment it resolves.
  const detailEntity = useMemo<LoreEntity | null>(() => {
    if (!detailPath) return null;
    return Object.values(index).flat().find((e) => e.dirPath === detailPath) ?? null;
  }, [detailPath, index]);

  // Keyed on the avatars, not on `index`: every rescan produces a fresh index
  // object, and re-running this would re-base64 every avatar on the wall for a
  // change that touched none of them. With a rescan on mount and one per agent
  // lore write, that is the difference between a free re-render and an O(images)
  // encode pass each time.
  const avatarKey = useMemo(
    () => Object.values(index).flat().map((e) => `${e.id}:${e.avatarPath ?? ""}`).join("|"),
    [index],
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const cat of loreCategories()) {
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
    // `index` is read inside but deliberately not a dep — avatarKey is its
    // avatar-relevant projection, and the read is always of the current render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarKey]);

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
    for (const cat of loreCategories()) {
      for (const e of (index[cat.id] ?? [])) flat.push(e);
    }
    return flat;
  }, [index]);

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: allEntities.length };
    for (const cat of loreCategories()) {
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

  const handleExport = async () => {
    if (!projectPath || transferBusy) return;
    setTransferBusy(true);
    try {
      const saved = await exportLoreBundle(projectPath);
      // Show the bundle where it landed instead of an alert.
      if (saved) revealItemInDir(saved).catch(() => { /* best-effort */ });
    } catch (err) {
      window.alert(`${t("lore.transfer.exportFailed", { kb: terms.kb })}\n${err}`);
    } finally {
      setTransferBusy(false);
    }
  };

  const handleImport = async () => {
    if (!projectPath || transferBusy) return;
    setTransferBusy(true);
    try {
      const staged = await stageLoreImport(projectPath);
      if (staged) setImportStaged(staged);
    } catch (err) {
      const empty = err instanceof Error && err.message === "empty-bundle";
      window.alert(empty
        ? t("lore.transfer.emptyBundle", { kb: terms.kb })
        : `${t("lore.transfer.importFailed", { kb: terms.kb })}\n${err}`);
    } finally {
      setTransferBusy(false);
    }
  };

  const handleApplyImport = async (strategy: ConflictStrategy) => {
    if (!projectPath || !importStaged) return;
    try {
      const summary = await applyLoreImport(projectPath, importStaged, strategy);
      setImportStaged(null);
      await scanProject(projectPath);
      let msg = t("lore.transfer.importDone", { imported: summary.imported, skipped: summary.skipped });
      if (summary.hiddenCategories.length > 0) {
        msg += `\n${t("lore.transfer.hiddenCategories", { categories: summary.hiddenCategories.join(", ") })}`;
      }
      window.alert(msg);
    } catch (err) {
      setImportStaged(null);
      window.alert(`${t("lore.transfer.importFailed", { kb: terms.kb })}\n${err}`);
    }
  };

  const buildMenuItems = (e: LoreEntity | null): ContextMenuEntry[] => {
    if (!e) {
      return [
        { kind: "item", icon: <Plus size={13} />, label: t("lore.panel.newEntry"),
          action: () => setNewMode("manual") },
        { kind: "item", icon: <Sparkles size={13} />, label: t("lore.newEntry.ai", { defaultValue: "AI 提取" }),
          action: () => setNewMode("ai") },
        { kind: "divider" },
        { kind: "item", icon: <FileDown size={13} />, label: t("lore.transfer.export"),
          action: () => void handleExport() },
        { kind: "item", icon: <FileUp size={13} />, label: t("lore.transfer.import"),
          action: () => void handleImport() },
        { kind: "divider" },
        { kind: "item", icon: <RotateCw size={13} />, label: t("fileTree.refresh"),
          action: () => { if (projectPath) void scanProject(projectPath); } },
      ];
    }
    return [
      { kind: "item", icon: <BookOpen size={13} />, label: t("fileTree.open"),
        action: () => openDetail(e.dirPath) },
      { kind: "item", icon: <Pencil size={13} />, label: t("lore.detail.edit", { defaultValue: "编辑" }),
        action: () => openDetail(e.dirPath, true) },
      { kind: "item", icon: <Camera size={13} />, label: t("lore.wall.changeAvatar", { defaultValue: "更换头像" }),
        action: () => void handleAvatarPick(e) },
      { kind: "item", icon: <FolderOpen size={13} />, label: t("lore.panel.showInBrowser"),
        action: () => { revealItemInDir(e.dirPath).catch(() => { /* best-effort */ }); } },
      { kind: "divider" },
      { kind: "item", icon: <Trash2 size={13} />, label: t("lore.panel.deleteEntity"), danger: true,
        action: () => void handleDeleteEntity(e) },
    ];
  };

  return (
    <div style={{ position: "relative", flex: 1, minWidth: 0, height: "100%", display: "flex", overflow: "hidden" }}>
      <AnimatePresence initial={false}>
        {/* Keyed by entity: LoreDetail seeds internal state from the entity it
            mounted with, so going straight from one entry to another (a
            citation click, a history step) has to remount it. */}
        {detailEntity ? (
          <motion.div
            key={`detail:${detailEntity.dirPath}`}
            variants={pushForward}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={springScreen}
            style={fillLayer}
          >
            <LoreDetail
              entity={detailEntity}
              initialEditing={detailEditing}
              onBack={() => openDetail(null)}
            />
          </motion.div>
        ) : (
          <motion.div
            key="grid"
            variants={pushBackdrop}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={springScreen}
            style={fillLayer}
          >
            <div className={styles.wall}>
      {newMode === "ai" && (
        <LoreGenerator
          initialDescription={extractSeed ?? undefined}
          onClose={() => { setNewMode(null); setExtractSeed(null); }}
          onModeChange={setNewMode}
        />
      )}
      {showNewCategory && (
        <NewCategoryModal
          onClose={() => setShowNewCategory(false)}
          onCreate={async (label) => {
            const id = suggestCategoryId(label, loreCategoryIds());
            const store = useProjectStore.getState();
            await store.setCustomCategories([
              ...store.customCategories,
              { id, labelZh: label, labelEn: label },
            ]);
            setShowNewCategory(false);
            setFilter(id);
          }}
        />
      )}
      {newMode === "manual" && (
        <NewEntryModal
          initialCategory={filter !== "all" ? (filter as CategoryId) : defaultCategoryId()}
          onClose={() => setNewMode(null)}
          onModeChange={setNewMode}
          onCreate={async (category, name) => {
            if (!projectPath) return;
            const baseId = slugifyEntityId(name);
            const id = await uniqueEntityId(projectPath, category, baseId);
            await createNewEntity(projectPath, category, id, name.trim());
            setNewMode(null);
            const created = useLoreStore.getState().index[category]?.find((e) => e.id === id);
            if (created) openDetail(created.dirPath);
          }}
        />
      )}

      <div className={styles.header}>
        <div className={styles.headerRow}>
          <div className={styles.eyebrow}>{kbEyebrow}</div>
          <div className={styles.title}>{terms.kb}</div>
          <div className={styles.subtitle}>
            {projectPath ? `${projectPath.split(/[\\/]/).pop()} · ` : ""}
            {t("lore.wallStats", {
              defaultValue: "{{n}} 条 · {{r}} 关系",
              n: counts.all,
              r: totalRelations,
              entries: terms.entries,
            })}
          </div>
          <span className={styles.spacer} />

          <div className={styles.search}>
            <Search size={12} color="var(--color-text-muted)" strokeWidth={1.6} />
            <input
              className={styles.searchInput}
              placeholder={t("sidebar.projectSearch", { entries: terms.entries })}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className={styles.searchKey} onClick={() => setShowCommandPalette(true)} style={{ cursor: "pointer" }}>{MOD_K_SPACED}</span>
          </div>

          <button
            className={styles.btnSecondary}
            onClick={() => setNewMode("ai")}
            title={t("lore.newEntry.aiHint", { defaultValue: "从手稿或描述中提取设定" })}
          >
            <Sparkles size={12} strokeWidth={1.8} />
            {t("lore.newEntry.ai", { defaultValue: "AI 提取" })}
          </button>
          <button className={styles.btnPrimary} onClick={() => setNewMode("manual")}>
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
          {loreCategories().map((cat) => (
            <span
              key={cat.id}
              className={`${styles.chip} ${filter === cat.id ? styles.chipActive : ""}`}
              onClick={() => setFilter(cat.id)}
            >
              <span className={styles.chipDot} style={{ background: categoryColor(cat.id) }} />
              {categoryLabel(cat, isZh)}
              <span className={styles.chipCount}>{counts[cat.id] ?? 0}</span>
            </span>
          ))}
          <span
            className={styles.chip}
            onClick={() => setShowNewCategory(true)}
            title={t("lore.newCategory.hint", { defaultValue: isZh ? "新建一个知识库分类" : "Create a knowledge-base category" })}
          >
            <Plus size={11} strokeWidth={2.2} />
            {t("lore.newCategory.cta", { defaultValue: isZh ? "新建分类" : "New category" })}
          </span>
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
              ? t("lore.wallNoMatch", { defaultValue: "未找到匹配的{{entry}}", entry: terms.entry })
              : t("lore.wallEmpty", {
                  defaultValue: "{{kb}}为空 — 用 AI 提取或新建条目开始积累",
                  kb: terms.kb,
                })}
          </div>
        ) : (
          <div className={styles.grid}>
            {filtered.map((e, idx) => {
              const featured = idx === 0 && filter === "all";
              const rot = rotationFor(e.id);
              const cat = findCategory(e.category);
              return (
                <div
                  key={e.id}
                  className={`${styles.card} ${featured ? styles.cardFeatured : ""}`}
                  style={{ transform: `rotate(${rot}deg)` }}
                  onClick={() => openDetail(e.dirPath)}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    setMenu({ x: ev.clientX, y: ev.clientY, entity: e });
                  }}
                >
                  <div className={styles.cardTop}>
                    <span className={styles.cardLabel}>
                      {cat ? categoryLabel(cat, isZh) : e.category}
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
                          style={{ background: categoryColor(e.category) }}
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
            <div className={styles.newCard} onClick={() => setNewMode("manual")}>
              <Plus size={22} color="var(--color-sienna)" strokeWidth={1.6} />
              <div className={styles.newCardLabel}>{t("lore.panel.newEntry")}</div>
              <div className={styles.newCardHint}>{isZh ? "手填或从手稿提取" : "Fill in, or extract from the manuscript"}</div>
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

      {importStaged && (
        <LoreImportModal
          staged={importStaged}
          onCancel={() => {
            void cancelLoreImport(importStaged.tempDir);
            setImportStaged(null);
          }}
          onApply={handleApplyImport}
        />
      )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Create one user-defined knowledge-base category. The author names it; the
 * folder id is derived (`suggestCategoryId`) so the dialog never has to
 * explain folder-name rules. One label serves both languages — a per-language
 * pair here would be ceremony for a personal organisational bucket.
 */
function NewCategoryModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (label: string) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ime = useImeGuard();

  const handleSubmit = async () => {
    if (!label.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate(label.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell overlayClassName={styles.modalBackdrop} onClose={onClose} isDirty={label.trim().length > 0} closeOnBackdrop={false}>
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <div className={styles.modalEyebrow}>{isZh ? "新建分类" : "NEW CATEGORY"}</div>
          <div className={styles.modalTitle}>
            {t("lore.newCategory.title", { defaultValue: isZh ? "新建知识库分类" : "New knowledge-base category" })}
          </div>
        </div>

        <div className={styles.modalBody}>
          <label className={styles.modalLabel}>{isZh ? "名称" : "Name"}</label>
          <input
            className={styles.modalInput}
            placeholder={t("lore.newCategory.placeholder", { defaultValue: isZh ? "如：会议纪要、竞品调研…" : "e.g. Meeting notes, Research…" })}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={40}
            {...ime.imeProps}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !ime.isComposing(e)) void handleSubmit();
            }}
            autoFocus
          />
          {error && (
            <div style={{ marginTop: 6, font: "400 12px/1.5 var(--font-sans)", color: "var(--color-red, #b91c1c)" }}>
              {error}
            </div>
          )}
        </div>

        <div className={styles.modalActions}>
          <button className={styles.btnSecondary} onClick={onClose}>
            {t("lore.form.cancel", { defaultValue: isZh ? "取消" : "Cancel" })}
          </button>
          <button className={styles.btnPrimary} onClick={handleSubmit} disabled={!label.trim() || saving}>
            {saving
              ? t("lore.form.creating", { defaultValue: isZh ? "创建中…" : "Creating…" })
              : t("lore.form.create", { defaultValue: isZh ? "创建" : "Create" })}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function NewEntryModal({
  initialCategory,
  onClose,
  onModeChange,
  onCreate,
}: {
  initialCategory: CategoryId;
  onClose: () => void;
  onModeChange: (mode: NewEntryMode) => void;
  onCreate: (category: CategoryId, name: string) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const [category, setCategory] = useState<CategoryId>(initialCategory);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const ime = useImeGuard();

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
    <ModalShell overlayClassName={styles.modalBackdrop} onClose={onClose} isDirty={name.trim().length > 0} closeOnBackdrop={false}>
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <div className={styles.modalEyebrow}>{isZh ? "新建条目" : "NEW ENTRY"}</div>
          <div className={styles.modalTitle}>{t("lore.panel.newEntry")}</div>
        </div>

        <div className={styles.modalBody}>
          <NewEntryTabs value="manual" onChange={onModeChange} />
          <label className={styles.modalLabel}>{isZh ? "分类" : "Category"}</label>
          <div className={styles.modalCats}>
            {loreCategories().map((cat) => (
              <span
                key={cat.id}
                className={`${styles.chip} ${category === cat.id ? styles.chipActive : ""}`}
                onClick={() => setCategory(cat.id)}
              >
                <span className={styles.chipDot} style={{ background: categoryColor(cat.id) }} />
                {categoryLabel(cat, isZh)}
              </span>
            ))}
          </div>

          <label className={styles.modalLabel}>{isZh ? "名称" : "Name"}</label>
          <input
            className={styles.modalInput}
            placeholder={t("lore.form.namePlaceholder", { defaultValue: isZh ? "条目名称" : "Entry name" })}
            value={name}
            onChange={(e) => setName(e.target.value)}
            {...ime.imeProps}
            onKeyDown={(e) => {
              // Escape is handled by ModalShell (with an unsaved-changes guard).
              // An Enter that ends a pinyin word belongs to the IME, not to us.
              if (e.key === "Enter" && !ime.isComposing(e)) void handleSubmit();
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
    </ModalShell>
  );
}

/**
 * Confirmation step of a lore bundle import: shows what the bundle contains,
 * and — when some entities already exist — lets the user pick the conflict
 * strategy before anything is written into the real lore tree.
 */
function LoreImportModal({
  staged,
  onCancel,
  onApply,
}: {
  staged: StagedLoreImport;
  onCancel: () => void;
  onApply: (strategy: ConflictStrategy) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const terms = useTerms();
  const [strategy, setStrategy] = useState<ConflictStrategy>("skip");
  const [applying, setApplying] = useState(false);

  const conflicts = staged.entities.filter((e) => e.conflicts);
  const strategies: { value: ConflictStrategy; label: string }[] = [
    { value: "skip", label: t("lore.transfer.strategySkip") },
    { value: "overwrite", label: t("lore.transfer.strategyOverwrite") },
    { value: "keepBoth", label: t("lore.transfer.strategyKeepBoth") },
  ];

  const handleApply = async () => {
    if (applying) return;
    setApplying(true);
    try {
      await onApply(strategy);
    } finally {
      setApplying(false);
    }
  };

  return (
    <ModalShell overlayClassName={styles.modalBackdrop} onClose={onCancel} closeOnBackdrop={false}>
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <div className={styles.modalEyebrow}>{isZh ? `导入${terms.kb}` : "IMPORT"}</div>
          <div className={styles.modalTitle}>{t("lore.transfer.import")}</div>
        </div>

        <div className={styles.modalBody}>
          <div style={{ font: "400 12.5px/1.7 var(--font-sans)", color: "var(--color-text-secondary)" }}>
            {t("lore.transfer.stagedSummary", { count: staged.entities.length })}
            {staged.manifest?.profileId && (
              <> · {t("lore.transfer.sourceProfile", { profile: staged.manifest.profileId })}</>
            )}
          </div>

          {conflicts.length > 0 && (
            <>
              <div style={{
                display: "flex", alignItems: "center", gap: 6, marginTop: 10,
                font: "500 12px/1.5 var(--font-sans)", color: "var(--color-amber, #b45309)",
              }}>
                <AlertTriangle size={13} />
                {t("lore.transfer.conflictCount", { count: conflicts.length })}
              </div>
              <div style={{ font: "400 12px/1.6 var(--font-sans)", color: "var(--color-text-muted)", marginTop: 4 }}>
                {conflicts.slice(0, 8).map((e) => e.name).join("、")}
                {conflicts.length > 8 && ` …(+${conflicts.length - 8})`}
              </div>

              <label className={styles.modalLabel}>{t("lore.transfer.strategyLabel")}</label>
              <div className={styles.modalCats}>
                {strategies.map((s) => (
                  <span
                    key={s.value}
                    className={`${styles.chip} ${strategy === s.value ? styles.chipActive : ""}`}
                    onClick={() => setStrategy(s.value)}
                  >
                    {s.label}
                  </span>
                ))}
              </div>
              {strategy === "overwrite" && (
                <div style={{ font: "400 12px/1.6 var(--font-sans)", color: "var(--color-text-muted)", marginTop: 6 }}>
                  {t("lore.transfer.strategyOverwriteHint")}
                </div>
              )}
            </>
          )}
        </div>

        <div className={styles.modalActions}>
          <button className={styles.btnSecondary} onClick={onCancel} disabled={applying}>
            {t("lore.form.cancel", { defaultValue: isZh ? "取消" : "Cancel" })}
          </button>
          <button className={styles.btnPrimary} onClick={handleApply} disabled={applying}>
            {applying ? t("lore.transfer.importing") : t("lore.transfer.importConfirm")}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
