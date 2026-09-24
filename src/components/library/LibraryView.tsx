import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  Sparkles, ChevronUp, ChevronDown, ChevronsUp, ChevronsDown, ChevronLeft, ChevronRight,
  Loader2, X, FolderPlus, Trash2, Check, PenLine, Pencil, FileText, File as FileIcon,
  ListPlus, FolderMinus, FileMinus,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useDocModel, useProjectStore, useTerms } from "../../stores/projectStore";
import { appTerms } from "../../lib/profile";
import { useEditorStore } from "../../stores/editorStore";
import { useMemoryStore } from "../../stores/memoryStore";
import { useAiStore } from "../../stores/aiStore";
import { chatModels } from "../../lib/ai/configDb";
import { useLoreStore } from "../../stores/loreStore";
import { useDigestStore } from "../../stores/digestStore";
import { ContextMenu, type ContextMenuEntry } from "../common/ContextMenu";
import {
  groupVolumes,
  libraryVolumes,
  spineFromVolumes,
  loadSpine,
  saveSpine,
  parentDir,
  chapterTitle,
  type BookSpine,
  type Volume,
  type Chapter,
  type ResourceFile,
} from "../../lib/context/outline";
import {
  addDoc, emptyMembers, pruneMembers, removeDoc, setFolder, type LibraryMembers,
} from "../../lib/context/library";
import { LibraryPicker } from "./LibraryPicker";
import {
  loadMemory, memoryStatus, moveMemory, memoryFilePath, projectRelativePath, type MemoryStatus,
} from "../../lib/context/memory";
import {
  digestStatus,
  loadDigest,
  type CollectionDigest,
  type DigestStatus,
} from "../../lib/context/collectionDigest";
import { matchEntitiesInText, type LoreEntity } from "../../lib/lore";
import { readFile, makeDir, removeDir, renamePath, fileExists } from "../../lib/fs/fileio";
import { ASSETS_DIR } from "../../lib/image/assets";
import { imageToThumbnailDataUrl, isImagePath } from "../../lib/fs/images";
import { useImeGuard } from "../../lib/ime";
import { Select } from "../common/Select";
import styles from "./LibraryView.module.css";
import { isSamePath, isStrictDescendant } from "../../lib/paths";
import type { FileNode } from "../../lib/project";

/** The tree node at `path`, if the loaded tree has it. */
function findTreeNode(nodes: FileNode[], path: string): FileNode | undefined {
  for (const n of nodes) {
    if (isSamePath(n.path, path)) return n;
    if (n.is_dir && n.children && isStrictDescendant(n.path, path)) return findTreeNode(n.children, path);
  }
  return undefined;
}

/** Move an array item from one index to another (immutably). */
function move<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * The dragged chapter, captured at dragstart — volumes can recompute mid-drag
 * (tree refreshes), so the drop must not rely on indexing back into them.
 */
interface DragState {
  volRel: string;
  from: number;
  path: string;
  name: string;
  rel: string;
}

/** Where a drop would land: a chapter index, or the end of a volume's list. */
interface DropTarget {
  volRel: string;
  index: number;
}

/** Per-chapter memory badge + inline generate/update trigger. */
function MemoBadge({ chapter, status }: { chapter: Chapter; status?: MemoryStatus }) {
  const { t } = useTranslation();
  const chapterGen = useMemoryStore((s) => s.chapterGen);
  const generateForFile = useMemoryStore((s) => s.generateForFile);
  const abortChapterGen = useMemoryStore((s) => s.abortChapterGen);

  if (chapterGen?.path === chapter.path) {
    return (
      <span className={styles.memoCell} onClick={(e) => e.stopPropagation()}>
        <Loader2 size={12} className={styles.memoSpin} />
        <span className={styles.memoGenText}>
          {chapterGen.total > 0 ? `${chapterGen.done}/${chapterGen.total}` : t("ai.memory.generating")}
        </span>
        <button className={styles.memoCancel} title={t("library.memoCancel")} onClick={abortChapterGen}>
          <X size={11} />
        </button>
      </span>
    );
  }

  if (!status) return null;

  const meta: Record<MemoryStatus, { cls: string; label: string }> = {
    fresh: { cls: styles.memoFresh, label: t("library.memoFresh") },
    stale: { cls: styles.memoStale, label: t("library.memoStale") },
    none: { cls: styles.memoNone, label: t("library.memoNone") },
    short: { cls: styles.memoShort, label: t("library.memoShort") },
  };
  const m = meta[status];
  // "short" chapters can still be summarized here (forced whole-chapter recap).
  const force = status === "short";
  const actionLabel = status === "fresh" ? t("library.memoUpdate") : t("library.memoGenerate");
  return (
    <span className={styles.memoCell} onClick={(e) => e.stopPropagation()}>
      <span className={`${styles.memoChip} ${m.cls}`}>{m.label}</span>
      <button
        className={styles.memoBtn}
        title={actionLabel}
        disabled={!!chapterGen}
        onClick={() => void generateForFile(chapter.path, force)}
      >
        <Sparkles size={11} strokeWidth={1.9} />
      </button>
    </span>
  );
}

/**
 * A volume's non-chapter file (image, PDF…), shown compactly under its
 * chapters. Images load a small thumbnail the same way ImagePreview does
 * (data URL — the asset protocol is unreliable on Windows drive paths).
 */
function ResourceRow({ resource, onOpen }: { resource: ResourceFile; onOpen: () => void }) {
  const isImage = isImagePath(resource.name);
  const [thumb, setThumb] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    if (!isImage) return;
    let cancelled = false;
    setThumb(null);
    setBroken(false);
    // Thumbnail tier, not the full-resolution encoder: this renders at
    // resourceThumb size, and a full-size photo inlined as base64 is megabytes
    // of string in state for a 26px-tall row (see lib/fs/images).
    imageToThumbnailDataUrl(resource.path, 160)
      .then((dataUrl) => { if (!cancelled) setThumb(dataUrl); })
      .catch(() => { if (!cancelled) setBroken(true); });
    return () => { cancelled = true; };
  }, [resource.path, isImage]);

  return (
    <button className={styles.resource} title={resource.name} onClick={onOpen}>
      {isImage && thumb && !broken ? (
        <img src={thumb} alt="" className={styles.resourceThumb} />
      ) : (
        <span className={styles.resourceIcon}>
          <FileIcon size={13} strokeWidth={1.6} />
        </span>
      )}
      <span className={styles.resourceName}>{resource.name}</span>
    </button>
  );
}

/** What the view derives per volume from one read of its chapters. */
interface VolumeMeta {
  digest: CollectionDigest | null;
  status: DigestStatus;
  /** Lore entities mentioned anywhere in the volume's chapters. */
  refs: LoreEntity[];
}

/**
 * Collection digest card: AI summary of the whole volume + the lore entities
 * its chapters mention. The summary persists as an editable markdown file
 * (lib/context/collectionDigest); the lore chips are recomputed locally on
 * every visit — no AI cost, never stale.
 */
function DigestCard({ volume, meta }: { volume: Volume; meta?: VolumeMeta }) {
  const { t } = useTranslation();
  const terms = useTerms();
  const gen = useDigestStore((s) => s.gen);
  const error = useDigestStore((s) => s.error);
  const errorVol = useDigestStore((s) => s.errorVol);
  const generateForVolume = useDigestStore((s) => s.generateForVolume);
  const abortGen = useDigestStore((s) => s.abortGen);
  const setMainView = useAppStore((s) => s.setMainView);
  const [expanded, setExpanded] = useState(false);

  if (volume.chapters.length === 0) return null;

  const status: DigestStatus = meta?.status ?? "none";
  const running = gen === volume.relPath;
  const chipMeta: Record<DigestStatus, { cls: string; label: string }> = {
    fresh: { cls: styles.memoFresh, label: t("library.memoFresh") },
    stale: { cls: styles.memoStale, label: t("library.memoStale") },
    none: { cls: styles.memoNone, label: t("library.memoNone") },
  };
  const chip = chipMeta[status];
  const actionLabel =
    status === "none"
      ? t("library.digestGenerate", { group: terms.group })
      : t("library.digestUpdate", { group: terms.group });

  const openLore = (entity: LoreEntity) => {
    useLoreStore.getState().openDetail(entity.dirPath);
    setMainView("lore-wall");
  };

  return (
    <div className={styles.digestCard}>
      <div className={styles.digestHead}>
        <span className={styles.digestLabel}>{t("library.digestLabel", { group: terms.group })}</span>
        {running ? (
          <span className={styles.memoCell}>
            <Loader2 size={12} className={styles.memoSpin} />
            <button className={styles.memoCancel} title={t("library.memoCancel")} onClick={abortGen}>
              <X size={11} />
            </button>
          </span>
        ) : (
          <span className={styles.memoCell}>
            <span className={`${styles.memoChip} ${chip.cls}`}>{chip.label}</span>
            <button
              className={styles.digestBtn}
              title={actionLabel}
              disabled={gen !== null}
              onClick={() => void generateForVolume(volume)}
            >
              <Sparkles size={11} strokeWidth={1.9} />
            </button>
          </span>
        )}
      </div>
      {errorVol === volume.relPath && error && <div className={styles.digestError}>{error}</div>}
      {meta?.digest?.summary && (
        <div
          className={expanded ? styles.digestBody : styles.digestBodyClamped}
          onClick={() => setExpanded((v) => !v)}
        >
          {meta.digest.summary}
        </div>
      )}
      {meta && meta.refs.length > 0 && (
        <div className={styles.loreChips}>
          <span className={styles.loreChipsLabel}>
            {t("library.loreRefs", { entries: terms.entries })}
          </span>
          {meta.refs.map((entity) => (
            <button
              key={entity.dirPath}
              className={styles.loreChip}
              title={entity.summary || entity.name}
              onClick={() => openLore(entity)}
            >
              {entity.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function LibraryView() {
  const { t } = useTranslation();
  // Field selectors — the whole-store subscription re-rendered this view on
  // every projectStore write, including the counters typed into the editor.
  const fileTree = useProjectStore((s) => s.fileTree);
  const projectPath = useProjectStore((s) => s.projectPath);
  const activeFilePath = useProjectStore((s) => s.activeFilePath);
  const setActiveFilePath = useProjectStore((s) => s.setActiveFilePath);
  const wordCount = useEditorStore((s) => s.wordCount);
  const refreshFileTree = useProjectStore((s) => s.refreshFileTree);
  const createEntry = useProjectStore((s) => s.createEntry);
  const moveEntry = useProjectStore((s) => s.moveEntry);
  const deleteEntry = useProjectStore((s) => s.deleteEntry);
  const spineChanged = useProjectStore((s) => s.spineChanged);
  const setMainView = useAppStore((s) => s.setMainView);
  const terms = useTerms();
  const docs = useDocModel();
  // Column eyebrows are decorative English regardless of UI language.
  const groupEyebrow = appTerms(false).group.toUpperCase();
  // The per-chapter recaps generated here feed the prior-context and rolling
  // memory layers. When the profile injects neither, a generated summary has no
  // consumer — offering the button would just burn tokens — so the whole memo
  // column and its model picker disappear.
  const showMemo = docs.priorContext || docs.memory;

  const models = useAiStore((s) => s.models);
  const activeModelId = useAiStore((s) => s.activeModelId);
  const memoryModelId = useAiStore((s) => s.memoryModelId);
  const setMemoryModel = useAiStore((s) => s.setMemoryModel);

  const spineRev = useProjectStore((s) => s.spineRev);
  const [spine, setSpine] = useState<BookSpine | null>(null);
  // Which project the spine in state belongs to — until it matches, the
  // library isn't known yet (empty-state would flash for a populated one).
  const [spineFor, setSpineFor] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Bumped on every local write: a reload that started before it is stale.
  const writeSeq = useRef(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dragOver, setDragOver] = useState<DropTarget | null>(null);
  const [statuses, setStatuses] = useState<Record<string, MemoryStatus>>({});
  const [volMeta, setVolMeta] = useState<Record<string, VolumeMeta>>({});
  const loreIndex = useLoreStore((s) => s.index);
  const digestVersion = useDigestStore((s) => s.version);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creatingVol, setCreatingVol] = useState(false);
  const [newVolName, setNewVolName] = useState("");
  const [creatingChapterIn, setCreatingChapterIn] = useState<string | null>(null);
  const [newChapterName, setNewChapterName] = useState("");
  const [renamingChapter, setRenamingChapter] = useState<Chapter | null>(null);
  const [renameChapterName, setRenameChapterName] = useState("");
  const [renamingVol, setRenamingVol] = useState<Volume | null>(null);
  const [renameVolName, setRenameVolName] = useState("");
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; chapter: Chapter } | null>(null);
  const chapterGen = useMemoryStore((s) => s.chapterGen);

  // Load the spine (order + library members) when the project changes, and
  // again whenever something outside this view rewrote it (spineRev: a move
  // in the sidebar or by the agent, the AI panel's 加入文库).
  const projectRef = useRef(projectPath);
  projectRef.current = projectPath;
  // A new project starts unknown — never the previous project's spine over
  // the new project's tree.
  useEffect(() => { setSpine(null); setSpineFor(null); }, [projectPath]);
  useEffect(() => {
    let cancelled = false;
    if (!projectPath) return;
    const seq = writeSeq.current;
    loadSpine(projectPath).then((s) => {
      if (cancelled || seq !== writeSeq.current) return;
      setSpine(s);
      setSpineFor(projectPath);
    });
    return () => { cancelled = true; };
  }, [projectPath, spineRev]);
  const spineLoaded = spineFor !== null && spineFor === projectPath;

  // Every folder of the workspace (the picker's tree, the empty state's
  // counts, pruning) vs. the library itself: only what the author put in.
  const volumesAll = useMemo(
    () => (projectPath ? groupVolumes(fileTree, projectPath) : []),
    [fileTree, projectPath],
  );
  const volumes = useMemo(() => libraryVolumes(volumesAll, spine), [volumesAll, spine]);
  const allByRel = useMemo(() => new Map(volumesAll.map((v) => [v.relPath, v])), [volumesAll]);
  const members = spine?.members ?? emptyMembers();

  // Drop selections that no longer point at an existing chapter (after moves/deletes).
  useEffect(() => {
    const live = new Set(volumes.flatMap((v) => v.chapters).map((c) => c.path));
    setSelected((prev) => {
      const next = new Set([...prev].filter((p) => live.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [volumes]);

  // Mount-lifetime caches for the effect below. While this view is mounted the
  // editor is hidden (App renders one main view at a time), so a chapter's
  // text cannot change under the cache — the only paths that could are the
  // active file (read live from editorStore each pass, never cached) and a
  // renamed/created chapter, which arrives as a new path. Without these, every
  // trigger — a tree refresh, a lore rescan, a saved digest — re-read the
  // whole manuscript: two serialized IPC round-trips per chapter.
  const chapterCache = useRef(new Map<string, string>());
  const memoryCache = useRef(new Map<string, Awaited<ReturnType<typeof loadMemory>>>());
  useEffect(() => { chapterCache.current.clear(); }, [projectPath]);
  // A finished generation is exactly a memory file changing on disk.
  useEffect(() => { memoryCache.current.clear(); }, [projectPath, chapterGen]);

  // One read of every chapter drives all derived state: the per-chapter memory
  // badge, and per volume the digest freshness + referenced lore entities.
  // Recomputed when the chapter set changes, a memory generation starts/
  // finishes (chapterGen), a digest is saved (digestVersion), or the lore
  // index rescans.
  useEffect(() => {
    let cancelled = false;
    if (!projectPath) { setStatuses({}); setVolMeta({}); return; }
    (async () => {
      const activePath = useProjectStore.getState().activeFilePath;
      const activeContent = useEditorStore.getState().content;
      const statusEntries: [string, MemoryStatus][] = [];
      const metaEntries: [string, VolumeMeta][] = [];
      for (const vol of volumes) {
        // A chapter that fails to read is skipped here, which digestStatus
        // then sees as a shorter chapter list — i.e. "stale", not "fresh".
        const contents: { rel: string; content: string }[] = [];
        for (const ch of vol.chapters) {
          try {
            let content: string;
            if (isSamePath(ch.path, activePath)) {
              content = activeContent;
            } else {
              const hit = chapterCache.current.get(ch.path);
              if (hit !== undefined) {
                content = hit;
              } else {
                content = await readFile(ch.path);
                chapterCache.current.set(ch.path, content);
              }
            }
            let mem = memoryCache.current.get(ch.path);
            if (mem === undefined) {
              mem = await loadMemory(projectPath, ch.path);
              memoryCache.current.set(ch.path, mem);
            }
            statusEntries.push([ch.path, memoryStatus(content, mem)]);
            contents.push({ rel: ch.relPath, content });
          } catch {
            statusEntries.push([ch.path, "none"]);
          }
          if (cancelled) return;
        }
        if (vol.chapters.length > 0) {
          const digest = await loadDigest(projectPath, vol.relPath);
          metaEntries.push([vol.relPath, {
            digest,
            status: digestStatus(digest, contents),
            refs: matchEntitiesInText(contents.map((c) => c.content).join("\n"), loreIndex),
          }]);
        }
        if (cancelled) return;
      }
      if (!cancelled) {
        setStatuses(Object.fromEntries(statusEntries));
        setVolMeta(Object.fromEntries(metaEntries));
      }
    })();
    return () => { cancelled = true; };
  }, [volumes, projectPath, chapterGen, loreIndex, digestVersion]);

  const allChaptersCount = useMemo(
    () => volumes.reduce((s, v) => s + v.chapters.length, 0),
    [volumes],
  );
  const activeVolumeIdx = useMemo(
    () => volumes.findIndex((v) => v.chapters.some((c) => c.path === activeFilePath)),
    [volumes, activeFilePath],
  );
  const enabledModels = chatModels(models).filter((m) => m.enabled);
  const memoModelValue = memoryModelId ?? activeModelId ?? "";
  const isWriting = (ch: Chapter) => spine?.status?.[ch.relPath] === "writing";
  const writingCount = useMemo(
    () => volumes.reduce((n, v) => n + v.chapters.filter((ch) => spine?.status?.[ch.relPath] === "writing").length, 0),
    [volumes, spine],
  );

  // Local writes land in order, and anything that reads the file back
  // (reloadSpine, a drop) waits for them — otherwise it reads the version
  // before the write and writes that back over it.
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const persistSpine = (next: BookSpine) => {
    writeSeq.current += 1;
    setSpine(next);
    if (!projectPath) return;
    const path = projectPath;
    saveChain.current = saveChain.current
      .then(() => saveSpine(path, next))
      // The AI panel (outside this view, never unmounted) reads the library
      // too — its 不在文库 note and bridge candidates must follow.
      .then(() => spineChanged())
      .catch((e) => console.error("[library] saving the spine failed:", e));
  };

  /** The spine on disk once this view's pending writes landed; undefined if the project changed meanwhile. */
  const diskSpine = async (): Promise<BookSpine | null | undefined> => {
    const path = projectPath;
    if (!path) return undefined;
    await saveChain.current;
    const fresh = await loadSpine(path);
    return projectRef.current === path ? fresh : undefined;
  };

  /**
   * Re-read the spine after a move: `moveEntry` already rewrote it on disk
   * (paths, 在写, membership — lib/context/outline moveInSpine), and the copy
   * in state predates the move.
   */
  const reloadSpine = async (): Promise<void> => {
    const fresh = await diskSpine();
    if (fresh === undefined) return;
    writeSeq.current += 1;
    setSpine(fresh);
  };

  /**
   * Change the members and persist. The order is re-captured from the library
   * the new members produce, so a folder leaving the library takes its order
   * with it (01f 1z ③); 在写 marks stay.
   */
  const changeMembers = (change: (m: LibraryMembers) => LibraryMembers, prune = false) => {
    if (!projectPath) return;
    let next = change(members);
    if (prune) next = pruneMembers(next, volumesAll);
    const base: BookSpine = { ...(spine ?? { version: 1, order: {} }), members: next };
    persistSpine(spineFromVolumes(libraryVolumes(volumesAll, base), base));
  };

  const reorder = (vol: Volume, from: number, to: number) => {
    if (from === to || !projectPath) return;
    const reordered = move(vol.chapters, from, to);
    const next = spineFromVolumes(volumes, spine);
    next.order[vol.relPath] = reordered.map((c) => c.relPath);
    persistSpine(next);
  };

  /** Reorder the columns themselves (persisted as spine.volumes). */
  const reorderVolume = (from: number, to: number) => {
    if (from === to || to < 0 || to >= volumes.length || !projectPath) return;
    persistSpine(spineFromVolumes(move(volumes, from, to), spine));
  };

  /** Create a chapter file inside a volume (the empty-volume placeholder CTA). */
  const createChapter = async (vol: Volume) => {
    const name = newChapterName.trim();
    setCreatingChapterIn(null);
    setNewChapterName("");
    if (!name || !projectPath) return;
    try {
      const path = await createEntry(vol.path, name, "file");
      // A column of picked docs only shows what is picked — the new one too.
      const rel = projectRelativePath(projectPath, path);
      if (vol.partial && rel) changeMembers((m) => addDoc(m, rel));
      openChapter(path);
    } catch (e) {
      window.alert(String(e));
    }
  };

  /**
   * Rename a chapter file in place, carrying its spine position, 在写 status
   * and story memory over to the new relPath. A bare new name keeps the old
   * extension (a .txt chapter must not silently become .md).
   */
  const submitRenameChapter = async () => {
    const ch = renamingChapter;
    const name = renameChapterName.trim();
    setRenamingChapter(null);
    setRenameChapterName("");
    if (!ch || !name || !projectPath) return;
    const ext = ch.name.slice(ch.name.lastIndexOf("."));
    const finalName = name.includes(".") ? name : `${name}${ext}`;
    if (finalName === ch.name) return;
    const newPath = `${parentDir(ch.path)}/${finalName}`;
    try {
      // editor flush + assets + active path + the spine's paths (order, 在写, membership)
      await moveEntry(ch.path, newPath);
      const newRel = projectRelativePath(projectPath, newPath);
      if (!newRel) return;
      await moveMemory(projectPath, ch.relPath, newRel);
      await reloadSpine();
    } catch (e) {
      window.alert(String(e));
    }
  };

  /** Delete a chapter (snapshotted into .ai-writer/backups first, like the file tree). */
  const deleteChapter = async (ch: Chapter) => {
    if (!projectPath) return;
    if (!window.confirm(t("library.deleteChapterConfirm", { name: chapterTitle(ch) }))) return;
    try {
      await deleteEntry(ch.path, false, { backup: true });
      // The order overlay self-heals (missing files are dropped), but a status
      // entry would linger in the file forever.
      if (spine?.status?.[ch.relPath]) {
        const next = spineFromVolumes(
          volumes.map((v) => ({ ...v, chapters: v.chapters.filter((c) => c.path !== ch.path) })),
          spine,
        );
        delete next.status?.[ch.relPath];
        persistSpine(next);
      }
    } catch (e) {
      console.error("[library] delete chapter failed:", e);
    }
  };

  /**
   * Rename a volume folder. The memory and digest trees mirror the document
   * tree, so their subfolders travel along; the spine is prefix-rewritten
   * (nested volume keys included) via renameVolumeInSpine.
   */
  const submitRenameVolume = async () => {
    const vol = renamingVol;
    const name = renameVolName.trim();
    setRenamingVol(null);
    setRenameVolName("");
    if (!vol || !projectPath || vol.relPath === "") return;
    if (!name || name === vol.name || name === ASSETS_DIR || name.startsWith(".")) return;
    const newPath = `${parentDir(vol.path)}/${name}`;
    try {
      await moveEntry(vol.path, newPath); // editor flush + active path descendants
    } catch (e) {
      window.alert(String(e));
      return;
    }
    const newRel = projectRelativePath(projectPath, newPath);
    if (!newRel) return;
    for (const mirrored of [memoryFilePath(projectPath, vol.relPath), `${projectPath}/.ai-writer/collections/${vol.relPath}`]) {
      const to = mirrored.slice(0, mirrored.length - vol.relPath.length) + newRel;
      try {
        if (await fileExists(mirrored)) await renamePath(mirrored, to);
      } catch (e) {
        console.error("[library] moving mirrored folder failed:", e);
      }
    }
    await reloadSpine(); // moveEntry rewrote the spine's keys, nested ones included
  };

  /**
   * Drop the dragged chapter at `index` of `targetVol` — an in-volume reorder,
   * or a cross-volume move (file + memory + spine position + status).
   */
  const dropChapter = async (targetVol: Volume, index: number) => {
    const d = drag;
    setDrag(null);
    setDragOver(null);
    if (!d || !projectPath) return;
    if (d.volRel === targetVol.relPath) {
      reorder(targetVol, d.from, Math.min(index, targetVol.chapters.length - 1));
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const newPath = `${targetVol.path}/${d.name}`;
      await moveEntry(d.path, newPath); // also carries 在写 and library membership
      const newRel = projectRelativePath(projectPath, newPath);
      if (newRel) {
        await moveMemory(projectPath, d.rel, newRel);
        // On top of the rewritten spine, only the drop position is ours: the
        // two columns as they were on screen, the doc out of one and in the other.
        const loaded = await diskSpine();
        if (loaded === undefined) return;
        const fresh = loaded ?? { version: 1 as const, order: {} };
        const sourceVol = volumes.find((v) => v.relPath === d.volRel);
        const target = targetVol.chapters.map((c) => c.relPath);
        target.splice(Math.min(index, target.length), 0, newRel);
        const order = { ...fresh.order, [targetVol.relPath]: target };
        if (sourceVol) order[d.volRel] = sourceVol.chapters.map((c) => c.relPath).filter((r) => r !== d.rel);
        persistSpine({ ...fresh, order });
      }
    } catch (e) {
      window.alert(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Mark a chapter as "在写" or clear it (persisted in the spine). */
  const setChapterWriting = (ch: Chapter, writing: boolean) => {
    if (!projectPath) return;
    const next = spineFromVolumes(volumes, spine);
    const status = { ...(next.status ?? {}) };
    if (writing) status[ch.relPath] = "writing";
    else delete status[ch.relPath];
    next.status = status;
    persistSpine(next);
  };

  const toggleSelect = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const openChapter = (path: string) => {
    setActiveFilePath(path);
    setMainView("editor");
  };

  const openMenu = (e: MouseEvent, chapter: Chapter) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, chapter });
  };

  const menuItems = (ch: Chapter): ContextMenuEntry[] => {
    const writing = isWriting(ch);
    return [
      { kind: "item", icon: <FileText size={13} />, label: t("library.openChapter", { doc: terms.doc }), action: () => openChapter(ch.path) },
      {
        kind: "item",
        icon: <PenLine size={13} />,
        label: writing ? t("library.unmarkWriting") : t("library.markWriting"),
        action: () => setChapterWriting(ch, !writing),
      },
      {
        kind: "item",
        icon: <Pencil size={13} />,
        label: t("library.renameChapter"),
        action: () => { setRenamingChapter(ch); setRenameChapterName(chapterTitle(ch)); },
      },
      {
        kind: "item",
        icon: <FileMinus size={13} />,
        label: t("library.removeDoc"),
        hint: t("library.removeDocHint"),
        action: () => changeMembers((m) => removeDoc(m, ch.relPath)),
      },
      { kind: "divider" },
      {
        kind: "item",
        icon: <Trash2 size={13} />,
        label: t("library.deleteChapter", { doc: terms.doc }),
        danger: true,
        action: () => void deleteChapter(ch),
      },
    ];
  };

  const volIme = useImeGuard();
  const chapIme = useImeGuard();
  const renChIme = useImeGuard();
  const renVolIme = useImeGuard();
  const createVolume = async () => {
    const name = newVolName.trim();
    if (!name || !projectPath) { setCreatingVol(false); setNewVolName(""); return; }
    // "assets" is reserved for illustrations and dot-names are invisible in
    // the tree — a volume by either name would silently never appear.
    if (name === ASSETS_DIR || name.startsWith(".")) { setCreatingVol(false); setNewVolName(""); return; }
    try {
      await makeDir(`${projectPath}/${name}`);
      // Created from the library, so it is in the library.
      changeMembers((m) => setFolder(m, name, true));
      await refreshFileTree();
    } catch (e) {
      console.error("[outline] create volume failed:", e);
    }
    setCreatingVol(false);
    setNewVolName("");
  };

  /**
   * Nothing at all in the folder on disk — no subfolder, no assets/, no doc
   * excluded from the library. removeDir is recursive and keeps no backup,
   * so "no chapters or resources of its own" is not enough: a parent added
   * with 连同子分组 shows as an empty column while holding whole volumes.
   */
  const isEmptyFolder = (vol: Volume) => {
    const node = findTreeNode(fileTree, vol.path);
    return !!node && node.is_dir && (node.children ?? []).length === 0;
  };

  const deleteVolume = async (vol: Volume) => {
    // relPath "" is the project root itself — removeDir there would delete the
    // whole workspace, not a volume. Resources count too: a folder holding
    // only images is not "empty", and removeDir would take them with it —
    // and so do docs excluded from the library, hence the on-disk check.
    if (!isEmptyFolder(vol) || vol.relPath === "") return;
    if (!window.confirm(t("library.deleteVolumeConfirm", { group: terms.group }))) return;
    try {
      await removeDir(vol.path);
      changeMembers((m) => setFolder(m, vol.relPath, false));
      await refreshFileTree();
    } catch (e) {
      console.error("[outline] delete volume failed:", e);
    }
  };

  const moveSelectedTo = async (targetVol: Volume) => {
    if (busy || !projectPath) return;
    const chapters = volumes.flatMap((v) => v.chapters);
    const toMove = chapters.filter((c) => selected.has(c.path) && parentDir(c.path) !== targetVol.path);
    if (toMove.length === 0) { setSelected(new Set()); return; }
    setBusy(true);
    try {
      // moveEntry handles the editor flush, the document's assets/ folder and
      // the active-file pointer; memory files stay ours to carry.
      for (const ch of toMove) {
        try {
          const newPath = `${targetVol.path}/${ch.name}`;
          await moveEntry(ch.path, newPath);
          const newRel = projectRelativePath(projectPath, newPath);
          if (newRel) await moveMemory(projectPath, ch.relPath, newRel);
        } catch (e) {
          // A name collision in the target volume shouldn't abort the rest.
          console.error("[library] move failed:", ch.relPath, e);
        }
      }
      setSelected(new Set());
      await reloadSpine();
    } finally {
      setBusy(false);
    }
  };

  const workspaceGroups = volumesAll.filter((v) => v.relPath !== "").length;
  const workspaceDocs = volumesAll.reduce((n, v) => n + v.chapters.length, 0);
  // With members but no columns yet the file tree hasn't arrived — not empty.
  const noMembers = members.folders.length === 0 && members.docs.length === 0;
  const libraryEmpty = spineLoaded && volumes.length === 0 && (noMembers || fileTree.length > 0);
  const picker = pickerOpen && (
    <LibraryPicker
      volumes={volumesAll}
      members={members}
      onApply={(next) => changeMembers(() => next, true)}
      onClose={() => setPickerOpen(false)}
    />
  );

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <div className={styles.headRow}>
          <div className={styles.title}>{t("sidebar.library")}</div>
          <div className={styles.subtitle}>
            {t("library.subtitle", {
              defaultValue: "{{count}} {{docs}} · {{words}} 字",
              count: allChaptersCount,
              docs: terms.docs,
              words: wordCount.toLocaleString(),
            })}
          </div>
          {!libraryEmpty && (
            <div className={styles.reorderHint}>
              {t("library.reorderHint", { doc: terms.doc, group: terms.group })}
            </div>
          )}
          <span className={styles.spacer} />

          {showMemo && (
            <label className={styles.modelPicker} title={t("library.summaryModelHint")}>
              <span className={styles.modelLabel}>{t("library.summaryModel")}</span>
              <Select
                className={styles.modelSelect}
                value={memoModelValue}
                onChange={(v) => setMemoryModel(v || null)}
                options={
                  enabledModels.length === 0
                    ? [{ value: "", label: t("library.noModel") }]
                    : enabledModels.map((m) => ({ value: m.id, label: m.name }))
                }
              />
            </label>
          )}

          <button className={styles.headBtn} onClick={() => setPickerOpen(true)}>
            <ListPlus size={12} strokeWidth={1.8} />
            {t("library.addToLibrary")}
          </button>

          {creatingVol ? (
            <input
              className={styles.volInput}
              autoFocus
              value={newVolName}
              placeholder={t("library.volumeNamePlaceholder", { group: terms.group })}
              onChange={(e) => setNewVolName(e.target.value)}
              {...volIme.imeProps}
              onKeyDown={(e) => {
                if (volIme.isComposing(e)) return;
                if (e.key === "Enter") void createVolume();
                if (e.key === "Escape") { setCreatingVol(false); setNewVolName(""); }
              }}
              onBlur={() => void createVolume()}
            />
          ) : (
            <button className={styles.headBtn} onClick={() => setCreatingVol(true)}>
              <FolderPlus size={12} strokeWidth={1.8} />
              {t("library.newVolume", { group: terms.group })}
            </button>
          )}

        </div>

        {libraryEmpty || !spineLoaded ? null : selected.size > 0 ? (
          <div className={styles.selectionBar}>
            <span className={styles.selectionInfo}>
              <Check size={12} strokeWidth={2} />
              {t("library.selectedCount", { count: selected.size, doc: terms.doc })}
            </span>
            <Select
              className={styles.moveSelect}
              value=""
              disabled={busy}
              placeholder={t("library.moveToVolume", { group: terms.group })}
              ariaLabel={t("library.moveToVolume", { group: terms.group })}
              options={volumes.map((v) => ({ value: v.relPath, label: v.name }))}
              onChange={(v) => {
                const vol = volumes.find((x) => x.relPath === v);
                if (vol) void moveSelectedTo(vol);
              }}
            />
            <button className={styles.clearBtn} onClick={() => setSelected(new Set())}>
              {t("library.clearSelection")}
            </button>
          </div>
        ) : (
          <div className={styles.stats}>
            <span>
              <span className={styles.statValue}>{wordCount.toLocaleString()}</span>{" "}
              {t("library.wordsUnit", { defaultValue: "字" })}
            </span>
            <span className={styles.statSep} />
            <span>
              <span className={styles.statDot} style={{ color: "var(--color-success)" }}>●</span>{" "}
              {t("library.statDone", { defaultValue: "完 {{n}}", n: allChaptersCount - writingCount })}
            </span>
            <span style={{ margin: "0 10px" }} />
            <span>
              <span className={styles.statDot} style={{ color: "var(--color-sienna)" }}>●</span>{" "}
              {t("library.statWriting", { defaultValue: "在写 {{n}}", n: writingCount })}
            </span>
            <span className={styles.spacer} />
            <span>
              {t("library.avgPrefix", { defaultValue: "平均" })}{" "}
              <span className={styles.statValue}>
                {allChaptersCount > 0 ? Math.round(wordCount / allChaptersCount).toLocaleString() : 0}
              </span>{" "}
              {t("library.avgSuffix", { defaultValue: "字 / {{doc}}", doc: terms.doc })}
            </span>
          </div>
        )}
      </div>

      {libraryEmpty ? (
        <div className={styles.emptyWrap}>
          <div className={styles.emptyCard}>
            <div className={styles.emptyEyebrow}>Library · empty</div>
            <div className={styles.emptyTitle}>{t("library.emptyTitle")}</div>
            <div className={styles.emptyBody}>{t("library.emptyBody", { group: terms.group, groups: terms.groups, docs: terms.docs, doc: terms.doc })}</div>
            <div className={styles.emptyMeta}>
              {workspaceDocs > 0
                ? t("library.emptyMeta", {
                    groups: workspaceGroups, docs: workspaceDocs,
                    groupWord: terms.group, groupsWord: terms.groups, docWord: terms.docs,
                  })
                : t("library.emptyMetaNone", { docs: terms.docs })}
            </div>
            <div className={styles.emptyCta}>
              <button className={styles.emptyPrimary} onClick={() => setPickerOpen(true)}>
                <ListPlus size={13} strokeWidth={1.8} />
                {t("library.emptyPick", { group: terms.group, groups: terms.groups, docs: terms.docs })}
              </button>
              <span className={styles.emptyAlt}>{t("library.emptyAlt", { group: terms.group })}</span>
            </div>
          </div>
        </div>
      ) : (
      <div className={styles.columns}>
        {volumes.map((vol, vi) => {
          const isCurrent = vi === activeVolumeIdx;
          const canDelete = isEmptyFolder(vol) && vol.relPath !== "";
          const hiddenResources = vol.partial ? (allByRel.get(vol.relPath)?.resources.length ?? 0) : 0;
          return (
            <div key={vol.path} className={`${styles.column} ${isCurrent ? styles.columnCurrent : ""}`}>
              <div className={styles.colHead}>
                <div className={styles.colHeadMain}>
                  <div className={isCurrent ? styles.colEyebrow : styles.colEyebrowMuted}>
                    {groupEyebrow} {vi + 1}{isCurrent ? " · CURRENT" : ""}
                  </div>
                  {renamingVol?.relPath === vol.relPath ? (
                    <input
                      className={styles.volTitleInput}
                      autoFocus
                      value={renameVolName}
                      onChange={(e) => setRenameVolName(e.target.value)}
                      {...renVolIme.imeProps}
                      onKeyDown={(e) => {
                        if (renVolIme.isComposing(e)) return;
                        if (e.key === "Enter") void submitRenameVolume();
                        if (e.key === "Escape") { setRenamingVol(null); setRenameVolName(""); }
                      }}
                      onBlur={() => void submitRenameVolume()}
                    />
                  ) : (
                    <div className={isCurrent ? styles.colTitle : styles.colTitleMuted}>
                      {vol.name}
                    </div>
                  )}
                  {vol.partial && (
                    <span className={styles.partialTag} title={t("library.partialHint", { docs: terms.docs })}>
                      {t("library.partialTag", { count: vol.chapters.length })}
                    </span>
                  )}
                </div>
                <span className={styles.colHeadRight}>
                  <span className={`${styles.colCount} ${
                    isCurrent ? styles.colCountActive : styles.colCountDone
                  }`}>
                    {vol.chapters.length} {terms.docs}
                  </span>
                  <button
                    className={styles.volBtn}
                    title={t("library.moveVolLeft", { group: terms.group })}
                    disabled={vi === 0}
                    onClick={() => reorderVolume(vi, vi - 1)}
                  >
                    <ChevronLeft size={12} />
                  </button>
                  <button
                    className={styles.volBtn}
                    title={t("library.moveVolRight", { group: terms.group })}
                    disabled={vi === volumes.length - 1}
                    onClick={() => reorderVolume(vi, vi + 1)}
                  >
                    <ChevronRight size={12} />
                  </button>
                  {vol.relPath !== "" && (
                    <button
                      className={styles.volBtn}
                      title={t("library.renameVolume", { group: terms.group })}
                      onClick={() => { setRenamingVol(vol); setRenameVolName(vol.name); }}
                    >
                      <Pencil size={12} />
                    </button>
                  )}
                  {canDelete && (
                    <button
                      className={styles.volDeleteBtn}
                      title={t("library.deleteVolume", { group: terms.group })}
                      onClick={() => void deleteVolume(vol)}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                  <button
                    className={styles.volBtn}
                    title={t("library.removeGroup", { group: terms.group })}
                    aria-label={t("library.removeGroup", { group: terms.group })}
                    onClick={() => changeMembers((m) => setFolder(m, vol.relPath, false))}
                  >
                    <FolderMinus size={12} />
                  </button>
                </span>
              </div>

              <DigestCard volume={vol} meta={volMeta[vol.relPath]} />

              <div
                className={`${styles.chapters} ${
                  dragOver?.volRel === vol.relPath && dragOver.index === vol.chapters.length
                    ? styles.chaptersDropEnd
                    : ""
                }`}
                onDragOver={(e) => {
                  if (!drag) return;
                  e.preventDefault();
                  setDragOver({ volRel: vol.relPath, index: vol.chapters.length });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  void dropChapter(vol, vol.chapters.length);
                }}
              >
                {vol.chapters.map((ch, ci) => {
                  const active = ch.path === activeFilePath;
                  const isSelected = selected.has(ch.path);
                  const title = chapterTitle(ch);
                  const isDragging = drag?.path === ch.path;
                  const isDropTarget =
                    dragOver?.volRel === vol.relPath && dragOver.index === ci && drag?.path !== ch.path;
                  const last = vol.chapters.length - 1;
                  const isFirst = ci === 0;
                  const isLast = ci === last;
                  return (
                    <div
                      key={ch.path}
                      className={`${styles.chapter} ${active ? styles.chapterActive : ""} ${
                        isSelected ? styles.chapterSelected : ""
                      } ${isDragging ? styles.dragging : ""} ${isDropTarget ? styles.dropTarget : ""}`}
                      draggable={renamingChapter?.path !== ch.path}
                      onDragStart={() =>
                        setDrag({ volRel: vol.relPath, from: ci, path: ch.path, name: ch.name, rel: ch.relPath })
                      }
                      onDragOver={(e) => {
                        if (!drag) return;
                        e.preventDefault();
                        e.stopPropagation(); // keep the container's drop-at-end quiet
                        setDragOver({ volRel: vol.relPath, index: ci });
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void dropChapter(vol, ci);
                      }}
                      onDragEnd={() => { setDrag(null); setDragOver(null); }}
                      onClick={() => toggleSelect(ch.path)}
                      onDoubleClick={() => openChapter(ch.path)}
                      onContextMenu={(e) => openMenu(e, ch)}
                    >
                      <div className={styles.chapterTop}>
                        <span className={`${styles.selectDot} ${isSelected ? styles.selectDotOn : ""}`}>
                          {isSelected ? <Check size={11} strokeWidth={2.5} /> : String(ci + 1).padStart(2, "0")}
                        </span>
                        {renamingChapter?.path === ch.path ? (
                          <input
                            className={styles.chapterRenameInput}
                            autoFocus
                            value={renameChapterName}
                            onChange={(e) => setRenameChapterName(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onDoubleClick={(e) => e.stopPropagation()}
                            {...renChIme.imeProps}
                            onKeyDown={(e) => {
                              if (renChIme.isComposing(e)) return;
                              if (e.key === "Enter") void submitRenameChapter();
                              if (e.key === "Escape") { setRenamingChapter(null); setRenameChapterName(""); }
                            }}
                            onBlur={() => void submitRenameChapter()}
                          />
                        ) : (
                          <span className={styles.chapterName}>{title}</span>
                        )}
                        {isWriting(ch) && (
                          <span className={styles.chapterStatus}>
                            {t("library.writingBadge", { defaultValue: "在写" })}
                          </span>
                        )}
                        {showMemo && <MemoBadge chapter={ch} status={statuses[ch.path]} />}
                        <span className={styles.moveControls} onClick={(e) => e.stopPropagation()}>
                          <button
                            className={styles.moveBtn}
                            title={t("library.moveTop")}
                            disabled={isFirst}
                            onClick={() => reorder(vol, ci, 0)}
                          >
                            <ChevronsUp size={13} strokeWidth={1.8} />
                          </button>
                          <button
                            className={styles.moveBtn}
                            title={t("library.moveUp")}
                            disabled={isFirst}
                            onClick={() => reorder(vol, ci, ci - 1)}
                          >
                            <ChevronUp size={13} strokeWidth={1.8} />
                          </button>
                          <button
                            className={styles.moveBtn}
                            title={t("library.moveDown")}
                            disabled={isLast}
                            onClick={() => reorder(vol, ci, ci + 1)}
                          >
                            <ChevronDown size={13} strokeWidth={1.8} />
                          </button>
                          <button
                            className={styles.moveBtn}
                            title={t("library.moveBottom")}
                            disabled={isLast}
                            onClick={() => reorder(vol, ci, last)}
                          >
                            <ChevronsDown size={13} strokeWidth={1.8} />
                          </button>
                        </span>
                      </div>
                    </div>
                  );
                })}

                {vol.chapters.length === 0 && (
                  creatingChapterIn === vol.relPath ? (
                    <input
                      className={styles.chapterCreateInput}
                      autoFocus
                      value={newChapterName}
                      placeholder={t("library.chapterNamePlaceholder", { doc: terms.doc })}
                      onChange={(e) => setNewChapterName(e.target.value)}
                      {...chapIme.imeProps}
                      onKeyDown={(e) => {
                        if (chapIme.isComposing(e)) return;
                        if (e.key === "Enter") void createChapter(vol);
                        if (e.key === "Escape") { setCreatingChapterIn(null); setNewChapterName(""); }
                      }}
                      onBlur={() => void createChapter(vol)}
                    />
                  ) : (
                    <div
                      className={styles.placeholderCard}
                      onClick={() => { setCreatingChapterIn(vol.relPath); setNewChapterName(""); }}
                    >
                      <div>{t("library.newChapter", { doc: terms.doc })}</div>
                      <div>{t("library.emptyVolumeHint", { doc: terms.doc, group: terms.group })}</div>
                    </div>
                  )
                )}
              </div>

              {hiddenResources > 0 && (
                <div className={styles.resourcesHidden}>
                  {t("library.partialResources", { count: vol.chapters.length, n: hiddenResources, group: terms.group })}
                </div>
              )}
              {vol.resources.length > 0 && (
                <div className={styles.resources}>
                  <div className={styles.resourcesLabel}>
                    {t("library.resources", { count: vol.resources.length })}
                  </div>
                  {vol.resources.map((res) => (
                    <ResourceRow
                      key={res.path}
                      resource={res}
                      onOpen={() => openChapter(res.path)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      )}

      {picker}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.chapter)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
