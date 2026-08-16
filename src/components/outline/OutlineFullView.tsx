import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  Sparkles, ChevronUp, ChevronDown, ChevronsUp, ChevronsDown,
  Loader2, X, FolderPlus, Trash2, Check, PenLine, FileText,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useDocModel, useProjectStore, useTerms } from "../../stores/projectStore";
import { profileTerms } from "../../lib/profile";
import { useEditorStore } from "../../stores/editorStore";
import { useMemoryStore } from "../../stores/memoryStore";
import { useAiStore } from "../../stores/aiStore";
import { ContextMenu, type ContextMenuEntry } from "../common/ContextMenu";
import {
  groupVolumes,
  applySpine,
  spineFromVolumes,
  loadSpine,
  saveSpine,
  parentDir,
  type BookSpine,
  type Volume,
  type Chapter,
} from "../../lib/context/outline";
import { loadMemory, memoryStatus, moveMemory, projectRelativePath, type MemoryStatus } from "../../lib/context/memory";
import { readFile, makeDir, removeDir, renamePath } from "../../lib/fs/fileio";
import { ASSETS_DIR } from "../../lib/image/assets";
import { useImeGuard } from "../../lib/ime";
import styles from "./OutlineFullView.module.css";

/** Move an array item from one index to another (immutably). */
function move<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

interface DragState {
  volRel: string;
  from: number;
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
        <button className={styles.memoCancel} title={t("outline.memoCancel")} onClick={abortChapterGen}>
          <X size={11} />
        </button>
      </span>
    );
  }

  if (!status) return null;

  const meta: Record<MemoryStatus, { cls: string; label: string }> = {
    fresh: { cls: styles.memoFresh, label: t("outline.memoFresh") },
    stale: { cls: styles.memoStale, label: t("outline.memoStale") },
    none: { cls: styles.memoNone, label: t("outline.memoNone") },
    short: { cls: styles.memoShort, label: t("outline.memoShort") },
  };
  const m = meta[status];
  // "short" chapters can still be summarized here (forced whole-chapter recap).
  const force = status === "short";
  const actionLabel = status === "fresh" ? t("outline.memoUpdate") : t("outline.memoGenerate");
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

export function OutlineFullView() {
  const { t } = useTranslation();
  const { fileTree, projectPath, activeFilePath, setActiveFilePath, wordCount, refreshFileTree } = useProjectStore();
  const setMainView = useAppStore((s) => s.setMainView);
  const terms = useTerms();
  const docs = useDocModel();
  // Column eyebrows are decorative English regardless of UI language.
  const profile = useProjectStore((s) => s.profile);
  const groupEyebrow = profileTerms(profile, false).group.toUpperCase();
  // The per-chapter recaps generated here feed the prior-context and rolling
  // memory layers. When the profile injects neither, a generated summary has no
  // consumer — offering the button would just burn tokens — so the whole memo
  // column and its model picker disappear.
  const showMemo = docs.priorContext || docs.memory;

  const models = useAiStore((s) => s.models);
  const activeModelId = useAiStore((s) => s.activeModelId);
  const memoryModelId = useAiStore((s) => s.memoryModelId);
  const setMemoryModel = useAiStore((s) => s.setMemoryModel);

  const [spine, setSpine] = useState<BookSpine | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [statuses, setStatuses] = useState<Record<string, MemoryStatus>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creatingVol, setCreatingVol] = useState(false);
  const [newVolName, setNewVolName] = useState("");
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; chapter: Chapter } | null>(null);
  const chapterGen = useMemoryStore((s) => s.chapterGen);

  // Load the persisted order whenever the project changes.
  useEffect(() => {
    let cancelled = false;
    if (!projectPath) { setSpine(null); return; }
    loadSpine(projectPath).then((s) => { if (!cancelled) setSpine(s); });
    return () => { cancelled = true; };
  }, [projectPath]);

  const volumesRaw = useMemo(
    () => (projectPath ? groupVolumes(fileTree, projectPath) : []),
    [fileTree, projectPath],
  );
  const volumes = useMemo(() => applySpine(volumesRaw, spine), [volumesRaw, spine]);

  // Drop selections that no longer point at an existing chapter (after moves/deletes).
  useEffect(() => {
    const live = new Set(volumes.flatMap((v) => v.chapters).map((c) => c.path));
    setSelected((prev) => {
      const next = new Set([...prev].filter((p) => live.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [volumes]);

  // Per-chapter memory status. Recomputed when the chapter set changes or a
  // generation starts/finishes (chapterGen toggling picks up the fresh file).
  useEffect(() => {
    let cancelled = false;
    if (!projectPath) { setStatuses({}); return; }
    const chapters = volumes.flatMap((v) => v.chapters);
    if (chapters.length === 0) { setStatuses({}); return; }
    (async () => {
      const activePath = useProjectStore.getState().activeFilePath;
      const activeContent = useEditorStore.getState().content;
      const entries = await Promise.all(
        chapters.map(async (ch): Promise<[string, MemoryStatus]> => {
          try {
            const content = ch.path === activePath ? activeContent : await readFile(ch.path);
            const mem = await loadMemory(projectPath, ch.path);
            return [ch.path, memoryStatus(content, mem)];
          } catch {
            return [ch.path, "none"];
          }
        }),
      );
      if (!cancelled) setStatuses(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [volumes, projectPath, chapterGen]);

  const allChaptersCount = volumes.reduce((s, v) => s + v.chapters.length, 0);
  const activeVolumeIdx = volumes.findIndex((v) => v.chapters.some((c) => c.path === activeFilePath));
  const enabledModels = models.filter((m) => m.enabled);
  const memoModelValue = memoryModelId ?? activeModelId ?? "";
  const isWriting = (ch: Chapter) => spine?.status?.[ch.relPath] === "writing";
  const writingCount = volumes.reduce((n, v) => n + v.chapters.filter(isWriting).length, 0);

  const reorder = (vol: Volume, from: number, to: number) => {
    if (from === to || !projectPath) return;
    const reordered = move(vol.chapters, from, to);
    const next = spineFromVolumes(volumes, spine);
    next.order[vol.relPath] = reordered.map((c) => c.relPath);
    setSpine(next);
    void saveSpine(projectPath, next);
  };

  /** Mark a chapter as "在写" or clear it (persisted in the spine). */
  const setChapterWriting = (ch: Chapter, writing: boolean) => {
    if (!projectPath) return;
    const next = spineFromVolumes(volumes, spine);
    const status = { ...(next.status ?? {}) };
    if (writing) status[ch.relPath] = "writing";
    else delete status[ch.relPath];
    next.status = status;
    setSpine(next);
    void saveSpine(projectPath, next);
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
      { kind: "item", icon: <FileText size={13} />, label: t("outline.openChapter", { doc: terms.doc }), action: () => openChapter(ch.path) },
      {
        kind: "item",
        icon: <PenLine size={13} />,
        label: writing ? t("outline.unmarkWriting") : t("outline.markWriting"),
        action: () => setChapterWriting(ch, !writing),
      },
    ];
  };

  const volIme = useImeGuard();
  const createVolume = async () => {
    const name = newVolName.trim();
    if (!name || !projectPath) { setCreatingVol(false); setNewVolName(""); return; }
    // "assets" is reserved for illustrations and dot-names are invisible in
    // the tree — a volume by either name would silently never appear.
    if (name === ASSETS_DIR || name.startsWith(".")) { setCreatingVol(false); setNewVolName(""); return; }
    try {
      await makeDir(`${projectPath}/${name}`);
      await refreshFileTree();
    } catch (e) {
      console.error("[outline] create volume failed:", e);
    }
    setCreatingVol(false);
    setNewVolName("");
  };

  const deleteVolume = async (vol: Volume) => {
    // relPath "" is the project root itself — removeDir there would delete the
    // whole workspace, not a volume.
    if (vol.chapters.length > 0 || vol.relPath === "") return;
    if (!window.confirm(t("outline.deleteVolumeConfirm", { group: terms.group }))) return;
    try {
      await removeDir(vol.path);
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
      // Flush the open document first if it's among those being moved.
      const editor = useEditorStore.getState();
      if (editor.isDirty && editor.filePath && toMove.some((c) => c.path === editor.filePath)) {
        await editor.saveNow();
      }
      for (const ch of toMove) {
        const newPath = `${targetVol.path}/${ch.name}`;
        await renamePath(ch.path, newPath);
        const newRel = projectRelativePath(projectPath, newPath);
        if (newRel) await moveMemory(projectPath, ch.relPath, newRel);
        if (activeFilePath === ch.path) setActiveFilePath(newPath);
      }
      await refreshFileTree();
      setSelected(new Set());
    } catch (e) {
      console.error("[outline] move failed:", e);
    } finally {
      setBusy(false);
    }
  };

  if (volumes.length === 0) {
    return (
      <div className={styles.view}>
        <div className={styles.header}>
          <div className={styles.headRow}>
            <div className={styles.title}>{t("sidebar.outline")}</div>
            <div className={styles.subtitle}>{t("titleBar.noProject")}</div>
          </div>
        </div>
        <div className={styles.empty}>
          {t("outline.empty", {
            defaultValue: "未发现{{group}}/{{doc}}结构 — 在项目文件夹下创建子文件夹来组织{{group}}",
            group: terms.group,
            doc: terms.doc,
          })}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <div className={styles.headRow}>
          <div className={styles.title}>{t("sidebar.outline")}</div>
          <div className={styles.subtitle}>
            {t("outline.subtitle", {
              defaultValue: "{{count}} {{docs}} · {{words}} 字",
              count: allChaptersCount,
              docs: terms.docs,
              words: wordCount.toLocaleString(),
            })}
          </div>
          <div className={styles.reorderHint}>
            {t("outline.reorderHint", { doc: terms.doc, group: terms.group })}
          </div>
          <span className={styles.spacer} />

          {showMemo && (
            <label className={styles.modelPicker} title={t("outline.summaryModelHint")}>
              <span className={styles.modelLabel}>{t("outline.summaryModel")}</span>
              <select
                className={styles.modelSelect}
                value={memoModelValue}
                onChange={(e) => setMemoryModel(e.target.value || null)}
              >
                {enabledModels.length === 0 && <option value="">{t("outline.noModel")}</option>}
                {enabledModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </label>
          )}

          {creatingVol ? (
            <input
              className={styles.volInput}
              autoFocus
              value={newVolName}
              placeholder={t("outline.volumeNamePlaceholder", { group: terms.group })}
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
              {t("outline.newVolume", { group: terms.group })}
            </button>
          )}

          <div className={styles.viewToggle}>
            <button className={`${styles.viewTab} ${styles.viewTabActive}`}>
              {t("outline.tabCards", { defaultValue: "{{doc}}卡", doc: terms.doc })}
            </button>
            <button className={styles.viewTab}>{t("outline.tabTimeline", { defaultValue: "时间线" })}</button>
            <button className={styles.viewTab}>{t("outline.tabBoard", { defaultValue: "看板" })}</button>
          </div>
          <button className={styles.aiSuggestBtn}>
            <Sparkles size={10} strokeWidth={1.8} />
            {t("outline.aiSuggestNext", { defaultValue: "AI 建议下一{{doc}}", doc: terms.doc })}
          </button>
        </div>

        {selected.size > 0 ? (
          <div className={styles.selectionBar}>
            <span className={styles.selectionInfo}>
              <Check size={12} strokeWidth={2} />
              {t("outline.selectedCount", { count: selected.size, doc: terms.doc })}
            </span>
            <select
              className={styles.moveSelect}
              value=""
              disabled={busy}
              onChange={(e) => {
                const vol = volumes.find((v) => v.relPath === e.target.value);
                if (vol) void moveSelectedTo(vol);
              }}
            >
              <option value="" disabled>{t("outline.moveToVolume", { group: terms.group })}</option>
              {volumes.map((v) => (
                <option key={v.relPath} value={v.relPath}>{v.name}</option>
              ))}
            </select>
            <button className={styles.clearBtn} onClick={() => setSelected(new Set())}>
              {t("outline.clearSelection")}
            </button>
          </div>
        ) : (
          <div className={styles.stats}>
            <span>
              <span className={styles.statValue}>{wordCount.toLocaleString()}</span>{" "}
              {t("outline.wordsUnit", { defaultValue: "字" })}
            </span>
            <span className={styles.statSep} />
            <span>
              <span className={styles.statDot} style={{ color: "var(--color-success)" }}>●</span>{" "}
              {t("outline.statDone", { defaultValue: "完 {{n}}", n: allChaptersCount - writingCount })}
            </span>
            <span style={{ margin: "0 10px" }} />
            <span>
              <span className={styles.statDot} style={{ color: "var(--color-sienna)" }}>●</span>{" "}
              {t("outline.statWriting", { defaultValue: "在写 {{n}}", n: writingCount })}
            </span>
            <span className={styles.spacer} />
            <span>
              {t("outline.avgPrefix", { defaultValue: "平均" })}{" "}
              <span className={styles.statValue}>
                {allChaptersCount > 0 ? Math.round(wordCount / allChaptersCount).toLocaleString() : 0}
              </span>{" "}
              {t("outline.avgSuffix", { defaultValue: "字 / {{doc}}", doc: terms.doc })}
            </span>
          </div>
        )}
      </div>

      <div className={styles.columns}>
        {volumes.map((vol, vi) => {
          const isCurrent = vi === activeVolumeIdx;
          const canDelete = vol.chapters.length === 0 && vol.relPath !== "";
          return (
            <div key={vol.path} className={`${styles.column} ${isCurrent ? styles.columnCurrent : ""}`}>
              <div className={styles.colHead}>
                <div>
                  <div className={isCurrent ? styles.colEyebrow : styles.colEyebrowMuted}>
                    {groupEyebrow} {vi + 1}{isCurrent ? " · CURRENT" : ""}
                  </div>
                  <div className={isCurrent ? styles.colTitle : styles.colTitleMuted}>
                    {vol.name}
                  </div>
                </div>
                <span className={styles.colHeadRight}>
                  <span className={`${styles.colCount} ${
                    isCurrent ? styles.colCountActive : styles.colCountDone
                  }`}>
                    {vol.chapters.length} {terms.docs}
                  </span>
                  {canDelete && (
                    <button
                      className={styles.volDeleteBtn}
                      title={t("outline.deleteVolume", { group: terms.group })}
                      onClick={() => void deleteVolume(vol)}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </span>
              </div>

              <div className={styles.chapters}>
                {vol.chapters.map((ch, ci) => {
                  const active = ch.path === activeFilePath;
                  const isSelected = selected.has(ch.path);
                  const title = ch.name.replace(/\.(md|markdown|txt)$/i, "");
                  const isDragging = drag?.volRel === vol.relPath && drag.from === ci;
                  const isDropTarget =
                    drag?.volRel === vol.relPath && dragOver === ci && drag.from !== ci;
                  const last = vol.chapters.length - 1;
                  const isFirst = ci === 0;
                  const isLast = ci === last;
                  return (
                    <div
                      key={ch.path}
                      className={`${styles.chapter} ${active ? styles.chapterActive : ""} ${
                        isSelected ? styles.chapterSelected : ""
                      } ${isDragging ? styles.dragging : ""} ${isDropTarget ? styles.dropTarget : ""}`}
                      draggable
                      onDragStart={() => setDrag({ volRel: vol.relPath, from: ci })}
                      onDragOver={(e) => {
                        if (drag?.volRel !== vol.relPath) return;
                        e.preventDefault();
                        setDragOver(ci);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (drag?.volRel === vol.relPath) reorder(vol, drag.from, ci);
                        setDrag(null);
                        setDragOver(null);
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
                        <span className={styles.chapterName}>{title}</span>
                        {isWriting(ch) && (
                          <span className={styles.chapterStatus}>
                            {t("outline.writingBadge", { defaultValue: "在写" })}
                          </span>
                        )}
                        {showMemo && <MemoBadge chapter={ch} status={statuses[ch.path]} />}
                        <span className={styles.moveControls} onClick={(e) => e.stopPropagation()}>
                          <button
                            className={styles.moveBtn}
                            title={t("outline.moveTop")}
                            disabled={isFirst}
                            onClick={() => reorder(vol, ci, 0)}
                          >
                            <ChevronsUp size={13} strokeWidth={1.8} />
                          </button>
                          <button
                            className={styles.moveBtn}
                            title={t("outline.moveUp")}
                            disabled={isFirst}
                            onClick={() => reorder(vol, ci, ci - 1)}
                          >
                            <ChevronUp size={13} strokeWidth={1.8} />
                          </button>
                          <button
                            className={styles.moveBtn}
                            title={t("outline.moveDown")}
                            disabled={isLast}
                            onClick={() => reorder(vol, ci, ci + 1)}
                          >
                            <ChevronDown size={13} strokeWidth={1.8} />
                          </button>
                          <button
                            className={styles.moveBtn}
                            title={t("outline.moveBottom")}
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
                  <div className={styles.placeholderCard}>
                    <div>{t("outline.emptyVolume", { group: terms.group })}</div>
                    <div>{t("outline.emptyVolumeHint", { doc: terms.doc, group: terms.group })}</div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

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
