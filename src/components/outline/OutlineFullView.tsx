import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, ChevronUp, ChevronDown, ChevronsUp, ChevronsDown, Loader2, X } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useProjectStore } from "../../stores/projectStore";
import { useEditorStore } from "../../stores/editorStore";
import { useMemoryStore } from "../../stores/memoryStore";
import {
  groupVolumes,
  applySpine,
  spineFromVolumes,
  loadSpine,
  saveSpine,
  type BookSpine,
  type Volume,
  type Chapter,
} from "../../lib/outline";
import { loadMemory, memoryStatus, type MemoryStatus } from "../../lib/memory";
import { readFile } from "../../lib/fileio";
import styles from "./OutlineFullView.module.css";

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

  if (!status || status === "short") {
    return status === "short"
      ? <span className={`${styles.memoChip} ${styles.memoShort}`}>{t("outline.memoShort")}</span>
      : null;
  }

  const meta: Record<"fresh" | "stale" | "none", { cls: string; label: string }> = {
    fresh: { cls: styles.memoFresh, label: t("outline.memoFresh") },
    stale: { cls: styles.memoStale, label: t("outline.memoStale") },
    none: { cls: styles.memoNone, label: t("outline.memoNone") },
  };
  const m = meta[status];
  const actionLabel = status === "fresh" ? t("outline.memoUpdate") : t("outline.memoGenerate");
  return (
    <span className={styles.memoCell} onClick={(e) => e.stopPropagation()}>
      <span className={`${styles.memoChip} ${m.cls}`}>{m.label}</span>
      <button
        className={styles.memoBtn}
        title={actionLabel}
        disabled={!!chapterGen}
        onClick={() => void generateForFile(chapter.path)}
      >
        <Sparkles size={11} strokeWidth={1.9} />
      </button>
    </span>
  );
}

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

export function OutlineFullView() {
  const { t } = useTranslation();
  const { fileTree, projectPath, activeFilePath, setActiveFilePath, wordCount } = useProjectStore();
  const setMainView = useAppStore((s) => s.setMainView);

  const [spine, setSpine] = useState<BookSpine | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [statuses, setStatuses] = useState<Record<string, MemoryStatus>>({});
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

  const reorder = (vol: Volume, from: number, to: number) => {
    if (from === to || !projectPath) return;
    const reordered = move(vol.chapters, from, to);
    // Capture the whole book's current order, then override this one volume, so
    // unrelated volumes stay put and future appends remain stable.
    const next = spineFromVolumes(volumes);
    next.order[vol.relPath] = reordered.map((c) => c.relPath);
    setSpine(next);
    void saveSpine(projectPath, next);
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
            defaultValue: "未发现卷/章节结构 — 在 writing/ 下创建子文件夹来组织卷",
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
            {allChaptersCount} 章 · {wordCount.toLocaleString()} 字
          </div>
          <div className={styles.reorderHint}>{t("outline.reorderHint")}</div>
          <span className={styles.spacer} />
          <div className={styles.viewToggle}>
            <button className={`${styles.viewTab} ${styles.viewTabActive}`}>章节卡</button>
            <button className={styles.viewTab}>时间线</button>
            <button className={styles.viewTab}>看板</button>
          </div>
          <button className={styles.aiSuggestBtn}>
            <Sparkles size={10} strokeWidth={1.8} />
            AI 建议下一章
          </button>
        </div>
        <div className={styles.stats}>
          <span>
            <span className={styles.statValue}>{wordCount.toLocaleString()}</span> 字
          </span>
          <span className={styles.statSep} />
          <span><span className={styles.statDot} style={{ color: "var(--color-success)" }}>●</span> 完 {allChaptersCount}</span>
          <span style={{ margin: "0 10px" }} />
          <span><span className={styles.statDot} style={{ color: "var(--color-sienna)" }}>●</span> 在写 {activeFilePath ? 1 : 0}</span>
          <span className={styles.spacer} />
          <span>平均 <span className={styles.statValue}>{allChaptersCount > 0 ? Math.round(wordCount / allChaptersCount).toLocaleString() : 0}</span> 字 / 章</span>
        </div>
      </div>

      <div className={styles.columns}>
        {volumes.map((vol, vi) => {
          const isCurrent = vi === activeVolumeIdx;
          return (
            <div key={vol.path} className={`${styles.column} ${isCurrent ? styles.columnCurrent : ""}`}>
              <div className={styles.colHead}>
                <div>
                  <div className={isCurrent ? styles.colEyebrow : styles.colEyebrowMuted}>
                    VOL {vi + 1}{isCurrent ? " · CURRENT" : ""}
                  </div>
                  <div className={isCurrent ? styles.colTitle : styles.colTitleMuted}>
                    {vol.name}
                  </div>
                </div>
                <span className={`${styles.colCount} ${
                  isCurrent ? styles.colCountActive : styles.colCountDone
                }`}>
                  {vol.chapters.length} 章
                </span>
              </div>

              <div className={styles.chapters}>
                {vol.chapters.map((ch, ci) => {
                  const active = ch.path === activeFilePath;
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
                        isDragging ? styles.dragging : ""
                      } ${isDropTarget ? styles.dropTarget : ""}`}
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
                      onClick={() => {
                        setActiveFilePath(ch.path);
                        setMainView("editor");
                      }}
                    >
                      <div className={styles.chapterTop}>
                        <span className={styles.chapterNum}>{String(ci + 1).padStart(2, "0")}</span>
                        <span className={styles.chapterName}>{title}</span>
                        {active && <span className={styles.chapterStatus}>在写</span>}
                        <MemoBadge chapter={ch} status={statuses[ch.path]} />
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
                    <div>+ 待规划</div>
                    <div>AI 可基于现有伏笔生成大纲建议</div>
                  </div>
                )}
              </div>

              {!isCurrent && vi === volumes.length - 1 && (
                <div className={styles.aiCard}>
                  <div className={styles.aiCardHead}>
                    <Sparkles size={11} strokeWidth={1.8} />
                    AI · 下一章建议
                  </div>
                  <div className={styles.aiCardBody}>
                    点击上方"AI 建议下一章"获取基于现有伏笔的章节建议。
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
