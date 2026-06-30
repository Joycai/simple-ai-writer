import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Sparkles, FolderOpen, ExternalLink, Plus, Pencil, Trash2, Check, X, ChevronLeft, ChevronRight } from "lucide-react";
import { createPortal } from "react-dom";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile as readBinaryFile } from "@tauri-apps/plugin-fs";
import {
  LORE_CATEGORIES,
  type LoreEntity,
  addLoreImage,
  updateLoreImageDesc,
  removeLoreImage,
} from "../../lib/lore";
import { useProjectStore } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import { useAppStore } from "../../stores/appStore";
import { readFile } from "../../lib/fileio";
import { imageToDataUrl } from "../../lib/loreGenerator";
import { renderMarkdown } from "../../lib/markdown";
import { LoreImproveModal } from "./LoreImproveModal";
import { LoreMetaImproveModal } from "./LoreMetaImproveModal";
import styles from "./LoreDetail.module.css";

interface Props {
  entity: LoreEntity;
  onBack: () => void;
}

const TABS = [
  { id: "summary", label: "概要" },
  { id: "relations", label: "关系" },
  { id: "appearances", label: "出场" },
  { id: "history", label: "历史" },
] as const;

type Tab = (typeof TABS)[number]["id"];

export function LoreDetail({ entity: initialEntity, onBack }: Props) {
  const { t } = useTranslation();
  const { setActiveFilePath, projectPath } = useProjectStore();
  const loreIndex = useLoreStore((s) => s.index);
  const scanProject = useLoreStore((s) => s.scanProject);
  const pendingLoreNav = useAppStore((s) => s.pendingLoreNav);
  const setPendingLoreNav = useAppStore((s) => s.setPendingLoreNav);
  const galleryRef = useRef<HTMLElement | null>(null);

  // After any mutation we re-scan, which produces fresh LoreEntity objects.
  // Re-derive the entity from the store on every render so the gallery picks
  // up new/edited/removed images without the parent having to re-pass props.
  const entity = useMemo<LoreEntity>(() => {
    const fresh = loreIndex[initialEntity.category]?.find((e) => e.id === initialEntity.id);
    return fresh ?? initialEntity;
  }, [loreIndex, initialEntity]);

  const [tab, setTab] = useState<Tab>("summary");
  const [content, setContent] = useState<string>("");
  const [showImprove, setShowImprove] = useState(false);
  const [showMetaImprove, setShowMetaImprove] = useState(false);

  // Gallery edit state
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // Lightbox state: which gallery image to show at full size (index into
  // entity.images), or null when the lightbox is closed.
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  // Wire keyboard nav for the lightbox: Esc closes, ←/→ flip between images.
  // Effect only attaches a listener while open, so it doesn't intercept keys
  // during normal browsing.
  useEffect(() => {
    if (previewIndex === null) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setPreviewIndex(null);
      } else if (ev.key === "ArrowRight" && entity.images.length > 1) {
        setPreviewIndex((i) => (i === null ? null : (i + 1) % entity.images.length));
      } else if (ev.key === "ArrowLeft" && entity.images.length > 1) {
        setPreviewIndex((i) => (i === null ? null : (i - 1 + entity.images.length) % entity.images.length));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewIndex, entity.images.length]);

  // If the previewed image gets removed (delete) while the lightbox is open,
  // close it rather than render an out-of-bounds slide.
  useEffect(() => {
    if (previewIndex !== null && previewIndex >= entity.images.length) {
      setPreviewIndex(null);
    }
  }, [entity.images.length, previewIndex]);

  // Gallery rendering: load each image file as a base64 data URL. Bypasses the
  // `ai-writer-asset://` custom protocol entirely — Webview2's strict URL
  // parsing on Windows drive-letter paths made that path fragile.
  const [imageDataUrls, setImageDataUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const img of entity.images) {
        try {
          const { dataUrl } = await imageToDataUrl(img.absPath);
          next[img.absPath] = dataUrl;
        } catch {
          // skip — broken-image placeholder will render
        }
      }
      if (!cancelled) setImageDataUrls(next);
    })();
    return () => { cancelled = true; };
  }, [entity.images]);

  useEffect(() => {
    const indexPath = `${entity.dirPath}/index.md`;
    readFile(indexPath)
      .then((raw) => {
        const m = raw.match(/^---\n[\s\S]*?\n---\n?/);
        setContent(m ? raw.slice(m[0].length) : raw);
      })
      .catch(() => setContent(""));
  }, [entity.dirPath]);

  // Honor a deep-link anchor (e.g. from the sidebar's "manage images" entry):
  // jump to the gallery section after first paint and clear the nav so a later
  // visit doesn't re-trigger it. Forcing the "summary" tab guarantees the
  // gallery is actually mounted before we scroll.
  useEffect(() => {
    if (!pendingLoreNav || pendingLoreNav.entityId !== entity.id) return;
    if (pendingLoreNav.anchor === "gallery") {
      setTab("summary");
      const raf = requestAnimationFrame(() => {
        galleryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        setPendingLoreNav(null);
      });
      return () => cancelAnimationFrame(raf);
    }
    setPendingLoreNav(null);
  }, [pendingLoreNav, entity.id, setPendingLoreNav]);

  const cat = LORE_CATEGORIES.find((c) => c.id === entity.category);

  const openInEditor = () => {
    setActiveFilePath(`${entity.dirPath}/index.md`);
  };
  const reveal = async () => {
    try { await revealItemInDir(entity.dirPath); } catch { /* best-effort */ }
  };

  const refresh = async () => {
    if (projectPath) await scanProject(projectPath);
  };

  const handleAddImages = async () => {
    if (busy) return;
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (!paths.length) return;
    setBusy(true);
    try {
      for (const srcPath of paths) {
        const bytes = await readBinaryFile(srcPath);
        const basename = srcPath.split(/[\\/]/).pop() || "image";
        await addLoreImage(entity.dirPath, basename, bytes, "");
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (file: string, desc: string) => {
    setEditingFile(file);
    setEditingDraft(desc);
  };
  const cancelEdit = () => {
    setEditingFile(null);
    setEditingDraft("");
  };
  const commitEdit = async () => {
    if (!editingFile || busy) return;
    setBusy(true);
    try {
      await updateLoreImageDesc(entity.dirPath, editingFile, editingDraft);
      await refresh();
      cancelEdit();
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (file: string) => {
    if (busy) return;
    if (!window.confirm(t("lore.detail.removeConfirm", { file, defaultValue: `删除「${file}」？` }))) return;
    setBusy(true);
    try {
      await removeLoreImage(entity.dirPath, file);
      if (editingFile === file) cancelEdit();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const previewImg = previewIndex !== null ? entity.images[previewIndex] : null;

  return (
    <div className={styles.detail}>
      {showImprove && (
        <LoreImproveModal entity={entity} onClose={() => setShowImprove(false)} />
      )}
      {showMetaImprove && (
        <LoreMetaImproveModal entity={entity} onClose={() => setShowMetaImprove(false)} />
      )}

      {previewImg && createPortal(
        <div
          className={styles.lightbox}
          onClick={() => setPreviewIndex(null)}
          role="dialog"
          aria-label={previewImg.desc || previewImg.file}
        >
          {entity.images.length > 1 && (
            <button
              className={`${styles.lightboxNav} ${styles.lightboxPrev}`}
              onClick={(ev) => {
                ev.stopPropagation();
                setPreviewIndex((i) => (i === null ? null : (i - 1 + entity.images.length) % entity.images.length));
              }}
              title={t("lore.detail.previewPrev", { defaultValue: "上一张" })}
            >
              <ChevronLeft size={28} strokeWidth={1.5} />
            </button>
          )}
          <button
            className={styles.lightboxClose}
            onClick={(ev) => { ev.stopPropagation(); setPreviewIndex(null); }}
            title={t("common.close", { defaultValue: "关闭" })}
          >
            <X size={20} strokeWidth={1.8} />
          </button>
          <figure className={styles.lightboxStage} onClick={(ev) => ev.stopPropagation()}>
            <img
              src={imageDataUrls[previewImg.absPath] ?? ""}
              alt={previewImg.desc || previewImg.file}
              className={styles.lightboxImg}
            />
            <figcaption className={styles.lightboxCaption}>
              <div className={styles.lightboxFile}>
                {previewImg.file}
                {entity.images.length > 1 && (
                  <span className={styles.lightboxCounter}>
                    {(previewIndex ?? 0) + 1} / {entity.images.length}
                  </span>
                )}
              </div>
              {previewImg.desc && <div className={styles.lightboxDesc}>{previewImg.desc}</div>}
            </figcaption>
          </figure>
          {entity.images.length > 1 && (
            <button
              className={`${styles.lightboxNav} ${styles.lightboxNext}`}
              onClick={(ev) => {
                ev.stopPropagation();
                setPreviewIndex((i) => (i === null ? null : (i + 1) % entity.images.length));
              }}
              title={t("lore.detail.previewNext", { defaultValue: "下一张" })}
            >
              <ChevronRight size={28} strokeWidth={1.5} />
            </button>
          )}
        </div>,
        document.body,
      )}

      <div className={styles.topBar}>
        <button className={styles.back} onClick={onBack}>
          <ArrowLeft size={11} strokeWidth={1.8} />
          {t("common.back", { defaultValue: "返回" })}
        </button>
        <span className={styles.crumb}>
          LORE <span className={styles.crumbBold}>/</span>
          {cat?.labelZh ?? entity.category} <span className={styles.crumbBold}>/</span>
          <span className={styles.crumbBold}>{entity.name}</span>
        </span>
        <span className={styles.spacer} />
        <button className={styles.actionBtn} onClick={() => setShowMetaImprove(true)}>
          <Sparkles size={11} /> {t("lore.panel.aiImproveMeta", { defaultValue: "AI 优化元数据" })}
        </button>
        <button className={styles.actionBtn} onClick={() => setShowImprove(true)}>
          <Sparkles size={11} /> {t("lore.panel.aiImprove")}
        </button>
        <button className={styles.actionBtn} onClick={openInEditor}>
          <ExternalLink size={11} /> {t("lore.form.save", { defaultValue: "在编辑器中打开" })}
        </button>
        <button className={styles.actionBtn} onClick={reveal}>
          <FolderOpen size={11} /> {t("lore.panel.showInBrowser")}
        </button>
      </div>

      <div className={styles.hero}>
        <div className={styles.avatar}>{entity.name.charAt(0)}</div>
        <div className={styles.heroText}>
          <div className={styles.eyebrow}>{cat?.labelEn ?? entity.category}</div>
          <div className={styles.heroName}>{entity.name}</div>
          {entity.aliases.length > 0 && (
            <div className={styles.heroAliases}>
              {entity.aliases.map((a) => (
                <span key={a} className={styles.alias}>{a}</span>
              ))}
            </div>
          )}
          {entity.summary && <div className={styles.heroSummary}>"{entity.summary}"</div>}
        </div>
      </div>

      <div className={styles.tabs}>
        {TABS.map((tt) => (
          <button
            key={tt.id}
            className={`${styles.tab} ${tab === tt.id ? styles.tabActive : ""}`}
            onClick={() => setTab(tt.id)}
          >
            {tt.label}
          </button>
        ))}
      </div>

      <div className={styles.body}>
        {tab === "summary" ? (
          <>
            {content ? (
              <div
                className={styles.markdown}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
              />
            ) : (
              <div className={styles.notLoaded}>无内容</div>
            )}

            <section className={styles.gallery} ref={galleryRef}>
              <div className={styles.galleryHeader}>
                <div className={styles.galleryHead}>{t("lore.detail.gallery", { defaultValue: "图集" })}</div>
                <span className={styles.galleryCount}>{entity.images.length}</span>
                <span className={styles.spacer} />
                <button
                  className={styles.galleryAddBtn}
                  onClick={handleAddImages}
                  disabled={busy}
                  title={t("lore.detail.addImage", { defaultValue: "添加图片" })}
                >
                  <Plus size={12} strokeWidth={2} />
                  {t("lore.detail.addImage", { defaultValue: "添加图片" })}
                </button>
              </div>

              {entity.images.length === 0 ? (
                <div className={styles.galleryEmpty}>
                  {t("lore.detail.galleryEmpty", { defaultValue: "暂无图片 — 点击「添加图片」选择本地图片，然后填写描述" })}
                </div>
              ) : (
                <div className={styles.galleryGrid}>
                  {entity.images.map((img) => {
                    const isEditing = editingFile === img.file;
                    return (
                      <figure key={img.file} className={styles.galleryItem}>
                        <img
                          src={imageDataUrls[img.absPath] ?? ""}
                          alt={img.desc || img.file}
                          className={styles.galleryImg}
                          style={!imageDataUrls[img.absPath] ? { background: "var(--color-bg-surface)" } : undefined}
                          onClick={() => setPreviewIndex(entity.images.indexOf(img))}
                          title={t("lore.detail.previewImage", { defaultValue: "点击放大预览" })}
                        />
                        <figcaption className={styles.galleryCaption}>
                          <div className={styles.galleryFileRow}>
                            <span className={styles.galleryFile}>{img.file}</span>
                            <div className={styles.galleryActions}>
                              {!isEditing && (
                                <button
                                  className={styles.iconBtn}
                                  onClick={() => startEdit(img.file, img.desc)}
                                  disabled={busy}
                                  title={t("lore.detail.editDesc", { defaultValue: "编辑描述" })}
                                >
                                  <Pencil size={11} strokeWidth={1.8} />
                                </button>
                              )}
                              <button
                                className={styles.iconBtn}
                                onClick={() => handleRemove(img.file)}
                                disabled={busy}
                                title={t("lore.detail.removeImage", { defaultValue: "删除图片" })}
                              >
                                <Trash2 size={11} strokeWidth={1.8} />
                              </button>
                            </div>
                          </div>
                          {isEditing ? (
                            <div className={styles.editArea}>
                              <textarea
                                className={styles.editTextarea}
                                value={editingDraft}
                                onChange={(e) => setEditingDraft(e.target.value)}
                                placeholder={t("lore.detail.descPlaceholder", { defaultValue: "一句话描述这张图片…" })}
                                autoFocus
                                rows={3}
                              />
                              <div className={styles.editButtons}>
                                <button className={styles.iconBtnCommit} onClick={commitEdit} disabled={busy} title="保存">
                                  <Check size={12} strokeWidth={2} />
                                </button>
                                <button className={styles.iconBtn} onClick={cancelEdit} disabled={busy} title="取消">
                                  <X size={12} strokeWidth={2} />
                                </button>
                              </div>
                            </div>
                          ) : img.desc ? (
                            <span className={styles.galleryDesc}>{img.desc}</span>
                          ) : (
                            <span
                              className={styles.galleryDescEmpty}
                              onClick={() => startEdit(img.file, "")}
                            >
                              {t("lore.detail.noDesc", { defaultValue: "（无描述 — 点击添加）" })}
                            </span>
                          )}
                        </figcaption>
                      </figure>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        ) : (
          <div className={styles.notLoaded}>
            {tab === "relations" && "关系图谱 — 待接入"}
            {tab === "appearances" && "出场记录 — 待接入"}
            {tab === "history" && "编辑历史 — 待接入"}
          </div>
        )}
      </div>
    </div>
  );
}
