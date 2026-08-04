/**
 * Batch clause run — split the open document into clauses, let the author
 * review the split (uncheck cover pages, mis-splits), then run the task once
 * per clause into an output markdown file (see stores/batchStore for why the
 * run is a sequential loop over the normal pipeline).
 *
 * The modal stays open during the run to show per-item progress, but closing
 * it does not stop the batch — the store owns the run, the file collects the
 * results either way.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ListChecks, Square, X } from "lucide-react";
import { splitClauses } from "../../lib/batch/clauses";
import { useBatchStore, type BatchItem } from "../../stores/batchStore";
import { useEditorStore } from "../../stores/editorStore";
import { useProjectStore } from "../../stores/projectStore";
import styles from "./BatchRunModal.module.css";

interface Props {
  taskId: string;
  taskLabel: string;
  onClose: () => void;
}

/** "…/writing/招标文件.md" → ("…/writing", "招标文件") */
function splitPath(path: string): { dir: string; stem: string } {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = path.slice(sep + 1);
  const dot = name.lastIndexOf(".");
  return { dir: path.slice(0, sep), stem: dot > 0 ? name.slice(0, dot) : name };
}

function statusGlyph(item: BatchItem): string {
  switch (item.status) {
    case "pending": return "·";
    case "running": return "…";
    case "done": return "✓";
    case "failed": return "✕";
    case "skipped": return "—";
  }
}

export function BatchRunModal({ taskId, taskLabel, onClose }: Props) {
  const { t } = useTranslation();
  const content = useEditorStore((s) => s.content);
  const filePath = useEditorStore((s) => s.filePath);
  const setActiveFilePath = useProjectStore((s) => s.setActiveFilePath);
  const refreshFileTree = useProjectStore((s) => s.refreshFileTree);
  const { running, items, outputPath, start, stop, reset } = useBatchStore();

  // Split once per open — the author reviews *this* snapshot, and edits made
  // mid-review shouldn't silently reshuffle what the checkboxes point at.
  const split = useMemo(() => splitClauses(content), [content]);
  // Cover pages / tables of contents default to unchecked.
  const [checked, setChecked] = useState<boolean[]>(() =>
    split.clauses.map((c) => !c.preamble),
  );
  const [outputName, setOutputName] = useState(() =>
    filePath ? `${splitPath(filePath).stem}-${t("ai.batch.outputSuffix")}.md` : "",
  );

  const selected = split.clauses.filter((_, i) => checked[i]);
  const finished = !running && items.length > 0;
  const doneCount = items.filter((i) => i.status === "done").length;
  const failedCount = items.filter((i) => i.status === "failed").length;

  const handleStart = () => {
    if (!filePath || running || selected.length === 0) return;
    const { dir, stem } = splitPath(filePath);
    const name = outputName.trim() || `${stem}-${t("ai.batch.outputSuffix")}.md`;
    void start(taskId, selected, `${dir}/${name}`, stem).then(() => {
      void refreshFileTree();
    });
  };

  const handleOpenOutput = () => {
    if (outputPath) setActiveFilePath(outputPath);
    onClose();
  };

  const handleClose = () => {
    if (!running) reset();
    onClose();
  };

  return (
    <div className={styles.overlay} onClick={handleClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <ListChecks size={18} className={styles.headerIcon} />
            <div>
              <div className={styles.headerName}>
                {t("ai.batch.title", { task: taskLabel })}
              </div>
              <div className={styles.headerSub}>
                {running
                  ? t("ai.batch.progress", {
                      done: items.filter((i) => i.status !== "pending" && i.status !== "running").length,
                      total: items.length,
                    })
                  : finished
                    ? t("ai.batch.finished", { done: doneCount, failed: failedCount })
                    : t("ai.batch.detected", {
                        count: split.clauses.length,
                        mode: t(`ai.batch.mode.${split.mode}`),
                      })}
              </div>
            </div>
          </div>
          <button className={styles.iconBtn} onClick={handleClose} title={t("common.close", { defaultValue: "关闭" })}>
            <X size={16} />
          </button>
        </div>

        <div className={styles.body}>
          {items.length === 0 ? (
            // ── Review the split before running ──
            split.clauses.length === 0 ? (
              <div className={styles.empty}>{t("ai.batch.emptyDoc")}</div>
            ) : (
              <ul className={styles.list}>
                {split.clauses.map((clause, i) => (
                  <li key={i} className={styles.row}>
                    <label className={styles.rowLabel}>
                      <input
                        type="checkbox"
                        checked={checked[i] ?? false}
                        onChange={(e) =>
                          setChecked((prev) => prev.map((v, j) => (j === i ? e.target.checked : v)))
                        }
                      />
                      <span className={styles.rowTitle}>
                        {clause.title.replace(/^#{1,6}\s*/, "") || t("ai.batch.untitled")}
                        {clause.preamble && (
                          <span className={styles.preambleTag}>{t("ai.batch.preamble")}</span>
                        )}
                      </span>
                      <span className={styles.rowMeta}>
                        {t("ai.batch.charCount", { count: clause.text.length })}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )
          ) : (
            // ── Run progress ──
            <ul className={styles.list}>
              {items.map((item) => (
                <li key={item.id} className={styles.row} data-status={item.status}>
                  <span className={styles.statusGlyph}>{statusGlyph(item)}</span>
                  <span className={styles.rowTitle}>{item.title || t("ai.batch.untitled")}</span>
                  <span className={styles.rowMeta}>
                    {item.status === "done" && t("ai.batch.charCount", { count: item.chars })}
                    {item.status === "failed" && (item.error ?? "")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={styles.footer}>
          {items.length === 0 ? (
            <>
              <input
                className={styles.outputInput}
                value={outputName}
                onChange={(e) => setOutputName(e.target.value)}
                placeholder={t("ai.batch.outputPlaceholder")}
                spellCheck={false}
              />
              <button
                className={styles.primaryBtn}
                disabled={!filePath || selected.length === 0}
                onClick={handleStart}
              >
                {t("ai.batch.run", { count: selected.length })}
              </button>
            </>
          ) : running ? (
            <button className={styles.dangerBtn} onClick={stop}>
              <Square size={12} />
              {t("ai.batch.stop")}
            </button>
          ) : (
            <button className={styles.primaryBtn} onClick={handleOpenOutput} disabled={!outputPath}>
              {t("ai.batch.openOutput")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
