/**
 * What a turn wrote, where the author will actually look (设计稿 02h 1j).
 *
 * Under 本次都批准 the approval cards never appear, so every manuscript write
 * would otherwise be a tool row inside a collapsed round. This band is the card
 * that did not appear, moved into the log: one row per write with the card's
 * own header — verb, file, what it added and removed, 「自动批准」 when nobody
 * read it — opening onto the same windows, and one line at the end that sums
 * the turn.
 *
 * Shown once the run has finished, and for every turn that wrote something, not
 * only auto-approved ones: a card approved half an hour ago is no easier to find
 * in a transcript than one that was never shown.
 *
 * Writes that carried out a lore plan step are listed in the plan ledger above
 * instead; the summary line counts them, the rows do not repeat them.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TurnWriteRow, TurnWritesSummary } from "../../lib/agent/planLedger";
import { baseName, joinPath } from "../../lib/paths";
import { useProjectStore, useTerms } from "../../stores/projectStore";
import { ChangeView, refusalText, type UndoHandler } from "./PlanLedger";
import styles from "./TurnWrites.module.css";

export function TurnWritesBand({
  summary,
  onUndo,
}: {
  summary: TurnWritesSummary;
  /** Absent where undo cannot be carried out; the band is then read-only. */
  onUndo?: UndoHandler;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  if (summary.rows.length === 0) return null;

  const standing = summary.rows.filter((r) => r.undo?.outcome !== "undone");
  const run = onUndo
    ? async (ids: string[]) => {
        setBusy(true);
        try {
          await onUndo(ids);
        } finally {
          setBusy(false);
        }
      }
    : undefined;
  const rows = summary.rows.filter((r) => !r.planned);

  return (
    <div className={styles.band}>
      {rows.length > 0 && (
        <ul className={styles.rows}>
          {rows.map((row) => (
            <WriteRow key={row.toolCallId} row={row} busy={busy} onUndo={run} />
          ))}
        </ul>
      )}
      <div className={styles.summary}>
        <span className={styles.summaryTitle}>{t("ai.agent.writes.title")}</span>
        {summary.documents > 0 && <span>{t("ai.agent.writes.documents", { n: summary.documents })}</span>}
        {summary.entries > 0 && <span>{t("ai.agent.writes.entries", { n: summary.entries })}</span>}
        <span className={styles.numbers}>
          <span className={styles.add}>+{summary.added}</span>{" "}
          <span className={styles.del}>−{summary.removed}</span> {t("ai.agent.writes.unitChars")}
        </span>
        {/* The one figure that must survive every fold: paragraphs that are gone. */}
        {summary.deletedBlocks > 0 && (
          <span className={styles.del}>{t("ai.agent.writes.deletedBlocks", { n: summary.deletedBlocks })}</span>
        )}
        {run && standing.length > 0 && (
          <button
            type="button"
            className={styles.undoAll}
            disabled={busy}
            onClick={() => void run(standing.map((r) => r.toolCallId))}
          >
            {t("ai.agent.writes.undoAll")}
          </button>
        )}
      </div>
    </div>
  );
}

function WriteRow({
  row,
  busy,
  onUndo,
}: {
  row: TurnWriteRow;
  busy: boolean;
  onUndo?: (ids: string[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const terms = useTerms();
  const [open, setOpen] = useState(false);
  const undone = row.undo?.outcome === "undone";
  const refused = row.undo?.outcome === "refused" ? row.undo : undefined;
  // App data (.ai-writer) is not something the editor opens as a document.
  const openable = !row.change.path.startsWith(".ai-writer/") && row.change.action !== "delete" && !undone;

  return (
    <li className={styles.row}>
      <div className={styles.line}>
        <button
          type="button"
          className={styles.head}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className={styles.verb}>
            {t(`ai.agent.tool.${row.toolName}`, { defaultValue: row.toolName, doc: terms.doc, entry: terms.entry })}
          </span>
          <span className={styles.file} title={row.change.path}>
            {baseName(row.change.path) || row.change.path}
          </span>
          {undone ? (
            <span className={styles.undone}>{t("ai.plan.ledger.undo.undone")}</span>
          ) : (
            <span className={styles.numbers}>
              <span className={styles.add}>+{row.added}</span>{" "}
              <span className={styles.del}>−{row.removed}</span>
            </span>
          )}
          {row.autoApproved && <span className={styles.auto}>{t("ai.agent.writes.autoApproved")}</span>}
          <span className={styles.chevron}>
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        </button>
        {onUndo && !undone && (
          <button
            type="button"
            className={styles.undo}
            disabled={busy}
            onClick={() => void onUndo([row.toolCallId])}
          >
            {t("ai.plan.ledger.undo.button")}
          </button>
        )}
      </div>
      {refused && <div className={styles.refusal}>{refusalText(t, refused, terms)}</div>}
      {open && (
        <div className={styles.detail}>
          <ChangeView change={row.change} />
          {/* The card is not a reader, but after the fact there should be one to
              go to. Only here, never on an approval card: before approving, the
              author is not meant to leave. */}
          {openable && (
            <button
              type="button"
              className={styles.open}
              onClick={() => {
                const { projectPath, setActiveFilePath } = useProjectStore.getState();
                if (projectPath) setActiveFilePath(joinPath(projectPath, row.change.path));
              }}
            >
              {t("ai.agent.writes.openInEditor")}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
