import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Sparkles, FolderOpen, ExternalLink, FileText, Plus, Pencil, Trash2, Check, X, Camera, ChevronLeft, ChevronRight, Layers, MoreHorizontal } from "lucide-react";
import { createPortal } from "react-dom";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile as readBinaryFile } from "@tauri-apps/plugin-fs";
import {
  type CategoryId,
  type LoreEntity,
  type LoreFacet,
  type LoreImage,
  addLoreImage,
  updateLoreImageDesc,
  removeLoreImage,
  saveEntityMetaAndBody,
  setEntityAvatar,
} from "../../lib/lore";
import { categoryLabel, findCategory, loreCategories } from "../../lib/profile";
import { useProjectStore, useTerms } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import { connOptions } from "../../lib/ai/conn";
import { useAppStore } from "../../stores/appStore";
import { replaceLocation } from "../../stores/navStore";
import { useAiStore } from "../../stores/aiStore";
import { loadApiKey } from "../../lib/keyStore";
import { chainCanSeeImages, resolveVisionConn } from "../../lib/agent/subagent";
import { describeLoreImage } from "../../lib/lore/vision";
import { readFile, removeFile } from "../../lib/fs/fileio";
import { imageToDataUrl } from "../../lib/fs/images";
import { useImageDataUrl } from "./useImageDataUrl";
import { useImeGuard } from "../../lib/ime";
import { MarkdownTextarea } from "../common/MarkdownTextarea";
import { MarkdownPreview } from "../common/MarkdownPreview";
import { LoreImproveModal } from "./LoreImproveModal";
import { LoreMetaImproveModal } from "./LoreMetaImproveModal";
import { FacetEditModal } from "./FacetEditModal";
import { LoreSplitModal } from "./LoreSplitModal";
import { EntityAiHubModal } from "./ai/EntityAiHubModal";
import { LoreImageGenModal } from "./ai/LoreImageGenModal";
import { ContextMenu, type ContextMenuEntry } from "../common/ContextMenu";
import { categoryColor } from "./catColor";
import { Select } from "../common/Select";
import styles from "./LoreDetail.module.css";

interface Props {
  entity: LoreEntity;
  onBack: () => void;
  /** Open directly in edit mode (used by the wall's card context menu). */
  initialEditing?: boolean;
}

export function LoreDetail({ entity: initialEntity, onBack, initialEditing = false }: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const { setActiveFilePath, projectPath } = useProjectStore();
  const loreIndex = useLoreStore((s) => s.index);
  const scanProject = useLoreStore((s) => s.scanProject);
  const deleteEntity = useLoreStore((s) => s.deleteEntity);
  const openDetail = useLoreStore((s) => s.openDetail);
  const setMainView = useAppStore((s) => s.setMainView);
  const terms = useTerms();

  // Where the entity currently lives. Normally this is where it was opened
  // from, but saving an edit with a changed category moves the folder — the
  // scanner derives category from folder location — so we track it in state.
  const [loc, setLoc] = useState({ category: initialEntity.category, id: initialEntity.id });

  // After any mutation we re-scan, which produces fresh LoreEntity objects.
  // Re-derive the entity from the store on every render so the gallery picks
  // up new/edited/removed images without the parent having to re-pass props.
  const entity = useMemo<LoreEntity>(() => {
    const fresh = loreIndex[loc.category]?.find((e) => e.id === loc.id);
    return fresh ?? initialEntity;
  }, [loreIndex, loc, initialEntity]);

  // Bumped after replacing the avatar so the data URL re-reads even when the
  // file path stayed identical (same extension overwrite).
  const [avatarVersion, setAvatarVersion] = useState(0);
  const avatarUrl = useImageDataUrl(entity.avatarPath, avatarVersion);

  const [content, setContent] = useState<string>("");
  const [showAiHub, setShowAiHub] = useState(false);
  const [showImprove, setShowImprove] = useState(false);
  const [showMetaImprove, setShowMetaImprove] = useState(false);
  // Facet form modal: { file: null } → create, { file } → edit/convert.
  const [facetModal, setFacetModal] = useState<{ file: string | null } | null>(null);
  const [showSplit, setShowSplit] = useState(false);
  // The hero's ⋯ button opens the secondary actions (open in editor / reveal /
  // delete) as a menu instead of a button row — 设计稿 03's three-button hero.
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);

  // Previous/next entity in wall order, for the breadcrumb's pager. Uses the
  // same flattening as the wall so the ‹ › order matches what the author saw.
  const neighbors = useMemo(() => {
    const flat: LoreEntity[] = [];
    for (const c of loreCategories()) for (const e of (loreIndex[c.id] ?? [])) flat.push(e);
    const i = flat.findIndex((e) => e.dirPath === entity.dirPath);
    return {
      prev: i > 0 ? flat[i - 1] : null,
      next: i >= 0 && i < flat.length - 1 ? flat[i + 1] : null,
    };
  }, [loreIndex, entity.dirPath]);

  // In-place edit mode: draft metadata + body, committed via saveEntityMetaAndBody.
  const [editing, setEditing] = useState(false);
  const [dName, setDName] = useState("");
  const [dAliases, setDAliases] = useState<string[]>([]);
  const [aliasInput, setAliasInput] = useState("");
  const [dCategory, setDCategory] = useState<CategoryId>(initialEntity.category);
  const [dSummary, setDSummary] = useState("");
  const [dBody, setDBody] = useState("");

  // Gallery edit state
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // AI image description: which gallery file is being generated for (null =
  // idle). The output streams into the open edit area so the user reviews and
  // commits it through the normal save flow — nothing touches disk until then.
  const [aiDescFile, setAiDescFile] = useState<string | null>(null);
  const aiDescAbort = useRef<AbortController | null>(null);
  const models = useAiStore((s) => s.models);
  const providers = useAiStore((s) => s.providers);
  const activeModelId = useAiStore((s) => s.activeModelId);
  const subAgents = useAiStore((s) => s.subAgents);
  const activeModel = models.find((m) => m.id === activeModelId);
  const visionReady = chainCanSeeImages(activeModel, subAgents, models);
  // AI image generation needs a model of its own — the active text model can't
  // stand in for it, so the entry point stays disabled until one is configured.
  const imageGenReady = models.some((m) => m.type === "image");
  const [showImageGen, setShowImageGen] = useState(false);

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

  const [contentLoaded, setContentLoaded] = useState(false);
  // True when the read above failed (permissions, non-UTF-8, a transient I/O
  // fault) rather than the entity genuinely having no body yet. Distinct from
  // `!content`, which is also true for a real empty entity — conflating the
  // two would let editing/saving proceed from a blank draft that overwrites
  // whatever is actually on disk.
  const [contentLoadFailed, setContentLoadFailed] = useState(false);
  // Bumped when something outside the edit form rewrites index.md in place
  // (e.g. LoreSplitModal Apply) — the body must be re-read, or a later Edit →
  // Save would write the stale pre-split body back and undo the split.
  const [contentVersion, setContentVersion] = useState(0);
  /** Which path the flags below describe, so a same-path reload doesn't reset them. */
  const loadedPathRef = useRef<string | null>(null);
  // Also keyed on `loreIndex`: the same "Edit → Save writes a stale body back"
  // hazard applies to an *agent* rewriting this entity's index.md while the
  // page is open, and only a rescan announces that. Re-reading during an edit
  // is safe — `dBody` is a separate draft, seeded from `content` once when edit
  // mode opens — and it is what makes the *next* edit start from the truth.
  useEffect(() => {
    const indexPath = `${entity.dirPath}/index.md`;
    // Only a genuine navigation clears these: they gate the Edit button and the
    // autoEdit effect below, so flipping them on every rescan would flicker the
    // button and could re-trip autoEdit mid-session.
    if (loadedPathRef.current !== indexPath) {
      loadedPathRef.current = indexPath;
      setContentLoaded(false);
      setContentLoadFailed(false);
    }
    // Now that this fires on every rescan, two reads can be in flight at once;
    // without the guard the slower (older) one wins and reinstates a stale body.
    let cancelled = false;
    readFile(indexPath)
      .then((rawFile) => {
        if (cancelled) return;
        const raw = rawFile.replace(/\r\n/g, "\n"); // CRLF-safe frontmatter match
        const m = raw.match(/^---\n[\s\S]*?\n---\n?/);
        setContent(m ? raw.slice(m[0].length) : raw);
        setContentLoadFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setContent("");
        setContentLoadFailed(true);
      })
      .finally(() => { if (!cancelled) setContentLoaded(true); });
    return () => { cancelled = true; };
  }, [entity.dirPath, contentVersion, loreIndex]);

  const cat = findCategory(entity.category);

  // Opening a file only sets the active path — the editor lives in the
  // "editor" main view, so switch back to it or the open is invisible.
  const openFileInEditor = (filename: string) => {
    setActiveFilePath(`${entity.dirPath}/${filename}`);
    setMainView("editor");
  };
  const openInEditor = () => openFileInEditor("index.md");
  const reveal = async () => {
    try { await revealItemInDir(entity.dirPath); } catch { /* best-effort */ }
  };

  const handleDelete = async () => {
    if (!projectPath || busy) return;
    if (!window.confirm(t("lore.panel.deleteConfirm", { name: entity.name }))) return;
    setBusy(true);
    try {
      await deleteEntity(projectPath, entity);
      onBack();
    } finally {
      setBusy(false);
    }
  };

  // Same flow as the wall cards: pick a local image, replace avatar.<ext>,
  // re-scan, then bump the version so the unchanged path still re-reads.
  const handleAvatarPick = async () => {
    if (!projectPath || busy) return;
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      const bytes = await readBinaryFile(picked);
      const ext = (picked.split(".").pop() ?? "png").toLowerCase();
      await setEntityAvatar(entity.dirPath, bytes, ext);
      await scanProject(projectPath);
      setAvatarVersion((v) => v + 1);
    } finally {
      setBusy(false);
    }
  };

  const startEntityEdit = () => {
    // The button that calls this is disabled in the same state (see the
    // render below), but startEntityEdit is also called from the autoEdit
    // effect right below, so the refusal has to live here too.
    if (contentLoadFailed) return;
    setDName(entity.name);
    setDAliases(entity.aliases);
    setAliasInput("");
    setDCategory(entity.category);
    setDSummary(entity.summary);
    setDBody(content);
    setEditing(true);
  };

  // When opened via the wall's "编辑" context-menu item, enter edit mode as
  // soon as the body has loaded — drafting from unloaded content would save
  // back an empty body. Also holds off (rather than consuming autoEdit) when
  // the load itself failed: retrying startEntityEdit here would be a no-op
  // per the guard above, so autoEdit would never get cleared and the author
  // would be stuck unable to enter edit mode even after a successful retry.
  const [autoEdit, setAutoEdit] = useState(initialEditing);
  useEffect(() => {
    if (autoEdit && contentLoaded && !contentLoadFailed) {
      startEntityEdit();
      setAutoEdit(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEdit, contentLoaded]);

  const aliasIme = useImeGuard();
  const addDraftAlias = () => {
    const v = aliasInput.trim();
    if (v && !dAliases.includes(v)) setDAliases([...dAliases, v]);
    setAliasInput("");
  };

  const handleSaveEdit = async () => {
    if (!projectPath || busy || !dName.trim()) return;
    setBusy(true);
    try {
      const moved = await saveEntityMetaAndBody(projectPath, entity, {
        name: dName.trim(),
        aliases: dAliases.map((a) => a.trim()).filter(Boolean),
        category: dCategory,
        summary: dSummary.trim(),
      }, dBody);
      await scanProject(projectPath);
      // Follow the entity to its (possibly new) folder, and refresh the local
      // body copy — the read-back effect only reruns when dirPath changes.
      setLoc({ category: moved.category, id: moved.id });
      // The wall resolves its detail view by dirPath, so it has to follow too.
      // replaceLocation, not a plain call: the author is still looking at the
      // same entry, so this must not become a step in the history.
      replaceLocation(() => useLoreStore.getState().openDetail(moved.dirPath));
      setContent(dBody.trimStart());
      setEditing(false);
    } finally {
      setBusy(false);
    }
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
    aiDescAbort.current?.abort(); // also stops an in-flight AI description
    setEditingFile(null);
    setEditingDraft("");
  };
  const commitEdit = async () => {
    if (!editingFile || busy || aiDescFile) return;
    setBusy(true);
    try {
      await updateLoreImageDesc(entity.dirPath, editingFile, editingDraft);
      await refresh();
      cancelEdit();
    } finally {
      setBusy(false);
    }
  };

  // Generate a textual description of one gallery image with the active
  // multimodal model or configured vision subagent. Streams into the edit area;
  // the user commits via the regular ✓ button, so a bad generation is just an X away.
  const handleAiDesc = async (img: LoreImage) => {
    if (busy || aiDescFile) return;
    const conn = await resolveVisionConn(models, providers, activeModelId, subAgents, loadApiKey);
    // Say why rather than doing nothing: the author just pressed a button that
    // the chain-level check said was available, so silence reads as a bug.
    if ("error" in conn) { window.alert(conn.error); return; }

    const ctrl = new AbortController();
    aiDescAbort.current = ctrl;
    setAiDescFile(img.file);
    startEdit(img.file, img.desc);
    try {
      // Reuse the already-loaded gallery data URL; fall back to a fresh read
      // if that load failed (broken thumbnail but readable file).
      const dataUrl = imageDataUrls[img.absPath] ?? (await imageToDataUrl(img.absPath)).dataUrl;
      const text = await describeLoreImage({
        dataUrl,
        entityName: entity.name,
        entitySummary: entity.summary,
        existingDesc: img.desc,
        language: i18n.language,
        ...connOptions(conn),
        signal: ctrl.signal,
        onProgress: (acc) => setEditingDraft(acc),
      });
      setEditingDraft(text);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        window.alert(e instanceof Error ? e.message : String(e));
      }
    } finally {
      aiDescAbort.current = null;
      setAiDescFile(null);
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

  const handleDeleteFacet = async (file: string, title: string) => {
    if (busy) return;
    if (!window.confirm(t("lore.facet.deleteConfirm", { title, defaultValue: `删除特征「${title}」？文件将从磁盘移除。` }))) return;
    setBusy(true);
    try {
      await removeFile(`${entity.dirPath}/${file}`);
      await refresh();
    } catch (e) {
      // Surface instead of leaving an unhandled rejection — the card staying
      // put after a confirmed delete needs an explanation.
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Facet cards + leftover plain attachments (non-facet, non-reserved mds).
  const facetFileSet = new Set(entity.facets.map((f) => f.file));
  const attachments = entity.mdFiles
    .filter((f) => f !== "index.md" && f !== "images.md" && !facetFileSet.has(f))
    .sort((a, b) => a.localeCompare(b));

  // 屏 15 lays the 特征 column out as loose rows with the mutual-exclusion
  // groups boxed together, so the flat facet list is folded into blocks: a
  // group takes the position of its first member and collects the rest,
  // highest priority first (only one of them ever injects).
  const facetBlocks = useMemo(() => {
    type Block =
      | { kind: "facet"; facet: LoreFacet }
      | { kind: "group"; group: string; facets: LoreFacet[] };
    const blocks: Block[] = [];
    const byGroup = new Map<string, LoreFacet[]>();
    for (const f of entity.facets) {
      if (!f.group) { blocks.push({ kind: "facet", facet: f }); continue; }
      const existing = byGroup.get(f.group);
      if (existing) { existing.push(f); continue; }
      const list = [f];
      byGroup.set(f.group, list);
      blocks.push({ kind: "group", group: f.group, facets: list });
    }
    for (const list of byGroup.values()) list.sort((a, b) => b.priority - a.priority);
    return blocks;
  }, [entity.facets]);

  const modeLabel = (mode: LoreFacet["mode"]) =>
    mode === "auto"
      ? t("lore.facet.modeAutoShort", { defaultValue: "自动" })
      : mode === "always"
        ? t("lore.facet.modeAlwaysShort", { defaultValue: "常驻" })
        : t("lore.facet.modeManualShort", { defaultValue: "手动" });
  const modeTitle = (mode: LoreFacet["mode"]) =>
    mode === "auto"
      ? t("lore.facet.modeAutoHint", { defaultValue: "主词条命中 + 出现任一触发词" })
      : mode === "always"
        ? t("lore.facet.modeAlwaysHint", { defaultValue: "主词条命中即注入" })
        : t("lore.facet.modeManualHint", { defaultValue: "仅在对话中手动引用时注入" });
  const MODE_CLASS: Record<LoreFacet["mode"], string> = {
    auto: styles.facetModeAuto,
    always: styles.facetModeAlways,
    manual: styles.facetModeManual,
  };

  /** One facet row (屏 15). `inGroup` swaps the metric for 优先级 N · 字数. */
  const renderFacetRow = (f: LoreFacet, inGroup: boolean) => (
    <div
      key={f.file}
      className={`${styles.facetRow} ${f.mode === "always" ? styles.facetRowAlways : ""} ${f.mode === "manual" ? styles.facetRowManual : ""}`}
      onClick={() => setFacetModal({ file: f.file })}
      title={t("lore.facet.editTitle", { defaultValue: "编辑特征" })}
    >
      <div className={styles.facetRowHead}>
        <span className={styles.facetTitle}>{f.title}</span>
        <span className={`${styles.facetMode} ${MODE_CLASS[f.mode]}`} title={modeTitle(f.mode)}>
          {modeLabel(f.mode)}
        </span>
        {f.mode === "manual" && (
          <span className={styles.facetNote}>
            {t("lore.facet.manualNote", { defaultValue: "仅在手动引用时注入" })}
          </span>
        )}
        <span className={styles.spacer} />
        <span className={styles.facetChars}>
          {inGroup
            ? t("lore.facet.priorityChars", {
                priority: f.priority,
                chars: f.charCount.toLocaleString("en-US"),
                defaultValue: `优先级 ${f.priority} · ${f.charCount} 字`,
              })
            : t("lore.facet.chars", {
                chars: f.charCount.toLocaleString("en-US"),
                defaultValue: `${f.charCount} 字`,
              })}
        </span>
        <div className={styles.facetActions} onClick={(ev) => ev.stopPropagation()}>
          <button
            className={styles.iconBtn}
            onClick={() => openFileInEditor(f.file)}
            disabled={busy}
            title={t("lore.detail.openInEditor", { defaultValue: "在编辑器中打开" })}
          >
            <ExternalLink size={11} strokeWidth={1.8} />
          </button>
          <button
            className={styles.iconBtn}
            onClick={() => handleDeleteFacet(f.file, f.title)}
            disabled={busy}
            title={t("lore.facet.delete", { defaultValue: "删除特征" })}
          >
            <Trash2 size={11} strokeWidth={1.8} />
          </button>
        </div>
      </div>
      {f.keys.length > 0 ? (
        <div className={styles.facetKeys}>
          <span className={styles.facetKeysLabel}>
            {t("lore.facet.fieldKeys", { defaultValue: "触发词" })}
          </span>
          {f.keys.map((k) => (
            <span key={k} className={styles.facetKey}>{k}</span>
          ))}
        </div>
      ) : f.mode === "auto" ? (
        <div className={styles.facetWarn}>
          {t("lore.facet.keysEmptyWarn", { defaultValue: "自动模式下没有关键词，此特征永远不会被自动注入" })}
        </div>
      ) : null}
    </div>
  );

  const previewImg = previewIndex !== null ? entity.images[previewIndex] : null;

  return (
    <div className={styles.detail}>
      {showAiHub && (
        <EntityAiHubModal
          entityName={entity.name}
          imageGenReady={imageGenReady}
          onClose={() => setShowAiHub(false)}
          onPick={(task) => {
            setShowAiHub(false);
            if (task === "meta") setShowMetaImprove(true);
            else if (task === "improve") setShowImprove(true);
            else if (task === "image") setShowImageGen(true);
            else setShowSplit(true);
          }}
        />
      )}
      {showImprove && (
        <LoreImproveModal
          entity={entity}
          // Re-read on close: the modal may have rewritten index.md (Apply);
          // re-reading on cancel is a harmless no-op.
          onClose={() => { setShowImprove(false); setContentVersion((v) => v + 1); }}
        />
      )}
      {showMetaImprove && (
        <LoreMetaImproveModal entity={entity} onClose={() => setShowMetaImprove(false)} />
      )}
      {facetModal && (
        <FacetEditModal entity={entity} file={facetModal.file} onClose={() => setFacetModal(null)} />
      )}
      {showSplit && (
        <LoreSplitModal
          entity={entity}
          onClose={() => setShowSplit(false)}
          onApplied={() => setContentVersion((v) => v + 1)}
        />
      )}

      {showImageGen && (
        <LoreImageGenModal
          entity={entity}
          onClose={() => setShowImageGen(false)}
          onSaved={() => { void refresh(); }}
        />
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

      <div className={styles.crumbBar}>
        <button className={styles.back} onClick={onBack} title={t("common.back", { defaultValue: "返回" })}>
          <ArrowLeft size={11} strokeWidth={1.8} />
        </button>
        <span className={styles.crumbPart}>{terms.kb}</span>
        <span className={styles.crumbSep}>/</span>
        <span className={styles.crumbCat}>
          <span className={styles.crumbDot} style={{ background: categoryColor(entity.category) }} />
          {/* Through `categoryLabel`, like every other category label in this
              file — reading `labelZh` directly showed an English UI the
              Chinese name. */}
          {cat ? categoryLabel(cat, isZh) : entity.category}
        </span>
        <span className={styles.crumbSep}>/</span>
        <span className={styles.crumbName}>{entity.name}</span>
        <span className={styles.spacer} />
        {editing ? (
          <>
            <button className={styles.actionBtn} onClick={() => setEditing(false)} disabled={busy}>
              <X size={11} /> {t("lore.detail.cancelEdit", { defaultValue: "取消" })}
            </button>
            <button
              className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
              onClick={handleSaveEdit}
              disabled={busy || !dName.trim()}
            >
              <Check size={11} />
              {busy
                ? t("lore.detail.saving", { defaultValue: "保存中…" })
                : t("lore.detail.saveEdit", { defaultValue: "保存" })}
            </button>
          </>
        ) : (
          <>
            <span className={styles.crumbId}>id: {entity.id}</span>
            <span className={styles.crumbDivider} />
            <button
              className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
              onClick={startEntityEdit}
              disabled={contentLoadFailed}
              title={contentLoadFailed ? t("lore.detail.loadErrorEditTitle", { defaultValue: "内容未能读取，暂不能编辑" }) : undefined}
            >
              <Pencil size={11} strokeWidth={1.8} />
              {t("lore.detail.edit", { defaultValue: "编辑" })}
            </button>
            <button
              className={styles.actionBtn}
              onClick={(ev) => {
                const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                setMoreMenu({ x: r.left, y: r.bottom + 4 });
              }}
              title={t("lore.detail.moreActions", { defaultValue: "更多操作" })}
            >
              <MoreHorizontal size={12} strokeWidth={1.8} />
            </button>
            {(neighbors.prev || neighbors.next) && <span className={styles.crumbDivider} />}
            {neighbors.prev && (
              <button className={styles.navBtn} onClick={() => openDetail(neighbors.prev!.dirPath)}>
                ‹ {neighbors.prev.name}
              </button>
            )}
            {neighbors.next && (
              <button className={styles.navBtn} onClick={() => openDetail(neighbors.next!.dirPath)}>
                {neighbors.next.name} ›
              </button>
            )}
          </>
        )}
      </div>

      {editing ? (
        <div className={styles.body}>
          <div className={styles.editForm}>
            <div className={styles.editGrid}>
              <label className={styles.eLabel}>
                {t("lore.detail.fieldName", { defaultValue: isZh ? "名称" : "Name" })}
              </label>
              <input
                className={styles.eInput}
                value={dName}
                onChange={(e) => setDName(e.target.value)}
                autoFocus
              />

              <label className={styles.eLabel}>
                {t("lore.detail.fieldCategory", { defaultValue: isZh ? "分类" : "Category" })}
              </label>
              <Select
                className={styles.eSelect}
                value={dCategory}
                onChange={(v) => setDCategory(v as CategoryId)}
                options={loreCategories().map((c) => ({ value: c.id, label: categoryLabel(c, isZh) }))}
              />

              <label className={styles.eLabel}>
                {t("lore.detail.fieldAliases", { defaultValue: isZh ? "别名" : "Aliases" })}
              </label>
              <div>
                {dAliases.length > 0 && (
                  <div className={styles.chips}>
                    {dAliases.map((a, i) => (
                      <span key={`${a}-${i}`} className={styles.chipTag}>
                        {a}
                        <button
                          className={styles.chipRemove}
                          onClick={() => setDAliases(dAliases.filter((_, x) => x !== i))}
                          title={t("lore.detail.removeAlias", { defaultValue: isZh ? "移除" : "Remove" })}
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <input
                  className={styles.eInput}
                  value={aliasInput}
                  onChange={(e) => setAliasInput(e.target.value)}
                  {...aliasIme.imeProps}
                  onKeyDown={(e) => {
                    if (aliasIme.isComposing(e)) return;
                    if (e.key === "Enter") { e.preventDefault(); addDraftAlias(); }
                  }}
                  placeholder={t("lore.detail.aliasPlaceholder", { defaultValue: isZh ? "添加别名（回车确认）" : "Add alias (press Enter)" })}
                />
              </div>

              <label className={styles.eLabel}>
                {t("lore.detail.fieldSummary", { defaultValue: isZh ? "概要" : "Summary" })}
              </label>
              <MarkdownTextarea
                className={`${styles.eInput} ${styles.eTextarea}`}
                rows={2}
                value={dSummary}
                onChange={(e) => setDSummary(e.target.value)}
              />
            </div>

            <div className={styles.editBodyBlock}>
              <label className={styles.eLabel}>
                {t("lore.detail.fieldBody", { defaultValue: isZh ? "正文 · Markdown" : "Content · Markdown" })}
              </label>
              <MarkdownTextarea
                className={styles.bodyTextarea}
                value={dBody}
                onChange={(e) => setDBody(e.target.value)}
                spellCheck={false}
              />
            </div>
          </div>
        </div>
      ) : (<>
      {moreMenu && (
        <ContextMenu
          x={moreMenu.x}
          y={moreMenu.y}
          items={([
            { kind: "item", icon: <ExternalLink size={13} />, label: t("lore.detail.openInEditor", { defaultValue: "在编辑器中打开" }),
              action: openInEditor },
            { kind: "item", icon: <FolderOpen size={13} />, label: t("lore.panel.showInBrowser"),
              action: () => void reveal() },
            { kind: "divider" },
            { kind: "item", icon: <Trash2 size={13} />, label: t("lore.panel.deleteEntity"), danger: true,
              action: () => void handleDelete() },
          ] satisfies ContextMenuEntry[])}
          onClose={() => setMoreMenu(null)}
        />
      )}

      {/* 设计稿 03 · 屏 15 — 三段结构直接对应数据模型:
          主词条 index.md | 特征 *.md | 配图 images.md */}
      <div className={styles.cols}>

        {/* ── 主词条 · index.md ─────────────────────────────────────────── */}
        <div className={styles.colIndex}>
          <div className={styles.indexHead}>
            <span className={styles.colHead}>
              {t("lore.detail.colIndex", { defaultValue: "主词条 · index.md" })}
            </span>
          </div>

          <div className={styles.indexScroll}>
            <div
              className={styles.avatarWrap}
              onClick={handleAvatarPick}
              title={t("lore.wall.changeAvatar", { defaultValue: "更换头像" })}
            >
              {avatarUrl ? (
                <img src={avatarUrl} alt={entity.name} className={styles.avatarImg} />
              ) : (
                <div className={styles.avatar} style={{ background: categoryColor(entity.category) }}>
                  {entity.name.charAt(0)}
                </div>
              )}
              <div className={styles.avatarOverlay}>
                <Camera size={18} strokeWidth={1.8} />
              </div>
            </div>

            <div>
              <div className={styles.heroName}>{entity.name}</div>
              {entity.aliases.length > 0 && (
                <div className={styles.heroAliases}>
                  {t("lore.detail.fieldAliases", { defaultValue: "别名" })}：{entity.aliases.join(" · ")}
                </div>
              )}
            </div>

            <div className={styles.catRow}>
              <span className={styles.catLabel}>
                {t("lore.detail.fieldCategory", { defaultValue: "分类" })}
              </span>
              <button
                className={styles.catChip}
                onClick={startEntityEdit}
                disabled={contentLoadFailed}
                title={t("lore.detail.edit", { defaultValue: "编辑" })}
              >
                <span className={styles.crumbDot} style={{ background: categoryColor(entity.category) }} />
                {cat ? categoryLabel(cat, isZh) : entity.category}
              </button>
            </div>

            <div>
              <div className={styles.fieldHead}>
                {t("lore.detail.summaryHead", { defaultValue: "摘要 · 命中即注入" })}
              </div>
              {entity.summary ? (
                <div className={styles.summaryBox}>{entity.summary}</div>
              ) : (
                <button className={styles.summaryEmpty} onClick={startEntityEdit} disabled={contentLoadFailed}>
                  {t("lore.detail.summaryEmpty", { defaultValue: "（无摘要 — 点击填写）" })}
                </button>
              )}
            </div>

            <div className={styles.indexBody}>
              <div className={styles.fieldHead}>
                {t("lore.detail.bodyHead", { defaultValue: "正文" })}
              </div>
              {content ? (
                <MarkdownPreview
                  source={content}
                  basePath={entity.dirPath}
                  className={styles.markdown}
                />
              ) : contentLoadFailed ? (
                <div className={styles.notLoaded}>
                  {t("lore.detail.loadError", { defaultValue: "内容读取失败，磁盘上的文件未被改动" })}
                </div>
              ) : (
                <div className={styles.notLoaded}>{t("lore.detail.noContent")}</div>
              )}
            </div>
          </div>

          {/* 落款: 屏 15 把文件清单和两个按钮压在栏底 — 钉住, 不随正文滚。 */}
          <div className={styles.indexFoot}>
            {/* What the entity is on disk — the mockup's mono file listing. */}
            <div className={styles.fileTree}>
              <div>lore/{entity.category}/{entity.id}/</div>
              <div>├ index.md</div>
              <div>├ images.md{entity.images.length > 0 ? ` · ${entity.images.length}` : ""}</div>
              <div>└ {entity.facets.length} × {t("lore.facet.section", { defaultValue: "特征" })} .md</div>
            </div>

            <div className={styles.colActions}>
              <button className={styles.colActionPrimary} onClick={() => setShowAiHub(true)}>
                <Sparkles size={11} strokeWidth={2} />
                {t("lore.aiHub.title", { defaultValue: "AI 编辑助手" })}
              </button>
              <button className={styles.colAction} onClick={() => setShowSplit(true)}>
                {t("lore.detail.splitEntry", { defaultValue: "拆分条目" })}
              </button>
            </div>
          </div>
        </div>

        {/* ── 特征 ──────────────────────────────────────────────────────── */}
        <div className={styles.colFacets}>
          <div className={styles.sectionHeader}>
            <span className={styles.colHead}>
              {t("lore.facet.section", { defaultValue: "特征" })} · {entity.facets.length}
            </span>
            <span className={styles.sectionHint}>
              {t("lore.facet.sectionHint", { defaultValue: "每条特征独立决定是否注入上下文" })}
            </span>
            <span className={styles.spacer} />
            <button
              className={styles.addBtn}
              onClick={() => setFacetModal({ file: null })}
              disabled={busy}
            >
              <Plus size={12} strokeWidth={2} />
              {t("lore.facet.new", { defaultValue: "新建特征" })}
            </button>
          </div>

          <div className={styles.colScroll}>
            {entity.facets.length === 0 ? (
              <div className={styles.facetsEmpty}>
                {t("lore.facet.empty", { defaultValue: "暂无特征 — 把条目的不同侧面拆成独立特征，写作时按需注入" })}
              </div>
            ) : (
              facetBlocks.map((block) =>
                block.kind === "facet"
                  ? renderFacetRow(block.facet, false)
                  : (
                    <div key={`g:${block.group}`} className={styles.groupBox}>
                      <div className={styles.groupHead}>
                        <span className={styles.groupName}>
                          {t("lore.facet.groupBoxHead", { group: block.group, defaultValue: `互斥组 · ${block.group}` })}
                        </span>
                        <span className={styles.groupHint}>
                          {t("lore.facet.groupBoxHint", { defaultValue: "同组按优先级只注入一条" })}
                        </span>
                      </div>
                      <div className={styles.groupRows}>
                        {block.facets.map((f) => renderFacetRow(f, true))}
                      </div>
                    </div>
                  ),
              )
            )}

            {attachments.length > 0 && (
              <>
                <div className={styles.filesHead}>
                  {t("lore.facet.attachments", { defaultValue: "附件（不参与注入）" })}
                </div>
                <div className={styles.fileList}>
                  {attachments.map((f) => (
                    <div key={f} className={styles.attachmentRow}>
                      <button
                        className={styles.fileItem}
                        onClick={() => openFileInEditor(f)}
                        title={t("lore.detail.openInEditor", { defaultValue: "在编辑器中打开" })}
                      >
                        <FileText size={11} strokeWidth={1.8} />
                        <span className={styles.fileName}>{f}</span>
                      </button>
                      <button
                        className={styles.convertBtn}
                        onClick={() => setFacetModal({ file: f })}
                        disabled={busy}
                        title={t("lore.facet.convertHint", { defaultValue: "补全触发关键词等信息，使其可被按需注入" })}
                      >
                        <Layers size={10} strokeWidth={1.8} />
                        {t("lore.facet.convert", { defaultValue: "转为特征" })}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── 配图 · images.md ──────────────────────────────────────────── */}
        <div className={styles.colImages}>
          <div className={styles.sectionHeader}>
            <span className={styles.colHead}>
              {t("lore.detail.colImages", { defaultValue: "配图 · images.md" })}
            </span>
            <span className={styles.galleryCount}>{entity.images.length}</span>
            <span className={styles.spacer} />
            <button
              className={styles.iconBtn}
              onClick={() => setShowImageGen(true)}
              disabled={busy || !imageGenReady}
              title={imageGenReady
                ? t("lore.detail.aiGenImage")
                : t("lore.detail.aiGenImageNeedModel")}
            >
              <Sparkles size={13} strokeWidth={1.8} />
            </button>
            <button className={styles.addLink} onClick={handleAddImages} disabled={busy}>
              + {t("lore.detail.addImageShort", { defaultValue: "添加" })}
            </button>
          </div>

          <div className={styles.colScroll}>
            {entity.images.length === 0 ? (
              <div className={styles.galleryEmpty}>
                {t("lore.detail.galleryEmpty", { defaultValue: "暂无图片 — 点击「添加」选择本地图片，然后填写描述" })}
              </div>
            ) : (
              entity.images.map((img) => {
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
                          <button
                            className={styles.iconBtn}
                            onClick={() => handleAiDesc(img)}
                            disabled={busy || !visionReady || aiDescFile !== null}
                            title={visionReady
                              ? t("lore.detail.aiDesc", { defaultValue: "AI 生成描述" })
                              : t("lore.detail.aiDescNeedMultimodal", { defaultValue: "需要多模态模型 — 请在设置中选择支持图片输入的模型" })}
                          >
                            <Sparkles size={11} strokeWidth={1.8} />
                          </button>
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
                          <MarkdownTextarea
                            format={false}
                            className={styles.editTextarea}
                            value={editingDraft}
                            onChange={(e) => setEditingDraft(e.target.value)}
                            placeholder={t("lore.detail.descPlaceholder", { defaultValue: "一句话描述这张图片…" })}
                            autoFocus
                            rows={3}
                          />
                          <div className={styles.editButtons}>
                            <button className={styles.iconBtnCommit} onClick={commitEdit} disabled={busy || aiDescFile !== null} title="保存">
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
              })
            )}
          </div>

          <div className={styles.colFootNote}>
            {t("lore.detail.imagesFootNote", { defaultValue: "文字描述供纯文本模型阅读，也用于图库检索。" })}
          </div>
        </div>
      </div>
      </>)}
    </div>
  );
}
