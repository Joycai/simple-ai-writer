/**
 * An approved lore plan, kept as the run's ledger (设计稿 02h 1i).
 *
 * The plan card used to vanish the moment it was approved, and the writes that
 * carried it out left nothing but tool rows. This is the card coming back: the
 * same steps, each growing its receipt as the run gets to it — 「已写入 · +9 −1」
 * — and opening onto the change itself in the same windows the approval cards
 * draw.
 *
 * It sits in the log as its own band rather than inside the round that
 * approved the plan, because a finished round is collapsed, and a ledger that
 * has to be dug out of an accordion is not an account anyone reads.
 *
 * Where the surface can carry it out, each written step also offers 撤回, and
 * the ledger 撤回全部 (1h / 1i). The rule behind those buttons lives in
 * `agent/undo`: only a file that is still what the write left comes back, and a
 * refusal is shown under the step rather than swallowed.
 */

import { useMemo, useState } from "react";
import i18next, { type TFunction } from "i18next";
import { modifiedLabel } from "../../lib/fs/modified";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { rewriteWindows } from "../../lib/diff/blocks";
import type { ChangeRecord, ToolStep, UndoEvent } from "../../lib/agent/events";
import { formatToolArgs } from "../../lib/agent/logFormat";
import { stepTarget, type LorePlanAction } from "../../lib/agent/plan";
import type { LedgerStep, PlanLedger } from "../../lib/agent/planLedger";
import { useTerms } from "../../stores/projectStore";
import type { ResolvedTerms } from "../../lib/profile";
import { BlockWindows } from "./BlockWindows";
import styles from "./PlanLedger.module.css";

const ACTION_STYLE: Record<LorePlanAction, string> = {
  create: styles.actionCreate,
  update: styles.actionUpdate,
  move: styles.actionMove,
  delete: styles.actionDelete,
};

/** Undo the given writes; resolves once the attempts are recorded in the log. */
export type UndoHandler = (toolCallIds: string[]) => Promise<void>;

/**
 * Every approved plan in a run, as one band of the log.
 *
 * Not inside the log's `.list`: that list scrolls at 280px, and a ledger whose
 * opened step windows are clipped into a scroll box inside another scroll box is
 * the log hiding the one thing it was asked to show.
 */
export function PlanLedgerBand({
  ledgers,
  onUndo,
}: {
  ledgers: readonly PlanLedger[];
  /** Absent where undo cannot be carried out (or while the run is still going). */
  onUndo?: UndoHandler;
}) {
  if (ledgers.length === 0) return null;
  return (
    <ul className={styles.band}>
      {ledgers.map((ledger) => (
        <PlanLedgerBlock key={ledger.toolCallId} ledger={ledger} onUndo={onUndo} />
      ))}
    </ul>
  );
}

function PlanLedgerBlock({ ledger, onUndo }: { ledger: PlanLedger; onUndo?: UndoHandler }) {
  const { t } = useTranslation();
  const terms = useTerms();
  const [busy, setBusy] = useState(false);
  const total = ledger.steps.length;

  // A step is still undoable while it has writes and has not come back already.
  const undoable = ledger.steps.filter(
    (s) => s.writes.some((w) => w.change) && s.undo?.outcome !== "undone",
  );
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

  return (
    <li className={styles.ledger}>
      <div className={styles.head}>
        <span className={styles.title}>{t("ai.plan.ledger.title", { entry: terms.entry })}</span>
        <span className={styles.progress}>
          {t("ai.plan.ledger.progress", { done: ledger.written, total })}
        </span>
        {(ledger.added > 0 || ledger.removed > 0) && (
          <span className={styles.meta}>
            <span className={styles.add}>+{ledger.added}</span>{" "}
            <span className={styles.del}>−{ledger.removed}</span>
          </span>
        )}
      </div>
      {ledger.plan.summary && <div className={styles.summary}>{ledger.plan.summary}</div>}
      <ol className={styles.steps}>
        {ledger.steps.map((entry) => (
          <LedgerStepRow key={entry.index} entry={entry} busy={busy} onUndo={run} />
        ))}
        {ledger.refused.map((step) => (
          <RefusedRow key={step.toolCallId} step={step} />
        ))}
      </ol>
      {run && undoable.length > 0 && (
        <div className={styles.footer}>
          <span className={styles.footerNote}>{t("ai.plan.ledger.undo.eachBackedUp")}</span>
          <button
            type="button"
            className={styles.undoAll}
            disabled={busy}
            onClick={() => void run(undoable.flatMap((s) => s.writes.map((w) => w.toolCallId)))}
          >
            {t("ai.plan.ledger.undo.all", { n: undoable.length })}
          </button>
        </div>
      )}
    </li>
  );
}

function LedgerStepRow({
  entry,
  busy,
  onUndo,
}: {
  entry: LedgerStep;
  busy: boolean;
  onUndo?: (ids: string[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const terms = useTerms();
  const [open, setOpen] = useState(false);
  const changes = entry.writes
    .map((w) => w.change)
    .filter((c): c is ChangeRecord => c !== undefined);
  const kind = stepTarget(entry.step);
  const written = entry.writes.length > 0;
  const expandable = changes.length > 0;
  const undone = entry.undo?.outcome === "undone";
  const refused = entry.undo?.outcome === "refused" ? entry.undo : undefined;

  return (
    <li className={styles.step}>
      <div className={styles.stepLine}>
        <button
          type="button"
          className={expandable ? styles.stepHeadButton : styles.stepHead}
          onClick={() => expandable && setOpen((v) => !v)}
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
        >
          <span className={`${styles.action} ${ACTION_STYLE[entry.step.action]}`}>
            {t(`ai.plan.action.${entry.step.action}`)}
          </span>
          <span className={styles.entity}>
            {kind !== "entity" && <span className={styles.kind}>{t(`ai.plan.target.${kind}`)}</span>}
            {entry.step.entity}
            {entry.step.file && <span className={styles.file}> / {entry.step.file}</span>}
          </span>
          <span className={styles.detail}>{entry.step.detail}</span>
          <span className={undone ? styles.receiptUndone : written ? styles.receipt : styles.receiptPending}>
            {undone ? (
              t("ai.plan.ledger.undo.undone")
            ) : written ? (
              <>
                {t("ai.plan.ledger.written")}
                {(entry.added > 0 || entry.removed > 0) && (
                  <>
                    {" · "}
                    <span className={styles.add}>+{entry.added}</span>{" "}
                    <span className={styles.del}>−{entry.removed}</span>
                  </>
                )}
              </>
            ) : entry.skipped ? (
              t("ai.plan.ledger.skipped")
            ) : (
              t("ai.plan.ledger.notYet")
            )}
          </span>
          {expandable && (
            <span className={styles.chevron}>
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </span>
          )}
        </button>
        {onUndo && expandable && !undone && (
          <button
            type="button"
            className={styles.undoButton}
            disabled={busy}
            onClick={() => void onUndo(entry.writes.map((w) => w.toolCallId))}
          >
            {t("ai.plan.ledger.undo.button")}
          </button>
        )}
      </div>
      {refused && <div className={styles.refusal}>{refusalText(t, refused, terms)}</div>}
      {open && (
        <div className={styles.changes}>
          {changes.map((change, i) => (
            <ChangeView key={i} change={change} />
          ))}
        </div>
      )}
    </li>
  );
}

/** Why an undo did not happen, in the author's words. */
export function refusalText(t: TFunction, undo: UndoEvent, terms: ResolvedTerms): string {
  if (undo.reason === "changedByLaterWrite") {
    return t("ai.plan.ledger.undo.changedByLaterWrite", {
      tool: t(`ai.agent.tool.${undo.byTool}`, { defaultValue: undo.byTool, doc: terms.doc, entry: terms.entry }),
    });
  }
  if (undo.reason === "changedAfter" && undo.changedAt !== undefined) {
    return t("ai.plan.ledger.undo.changedAfterAt", {
      when: modifiedLabel(t, undo.changedAt, { locale: i18next.language, withTime: true }),
    });
  }
  return t(`ai.plan.ledger.undo.${undo.reason ?? "failed"}`);
}

/**
 * One write's change, as paragraph windows — the knowledge base is compared at
 * the same grain as a whole-document rewrite (1z B), since an entry is prose.
 */
export function ChangeView({ change }: { change: ChangeRecord }) {
  const { t } = useTranslation();
  // What the record kept decides what can be drawn: a create has only an after,
  // a delete only a before, and anything past the cap has neither.
  const drawable =
    change.action === "create"
      ? change.after !== undefined
      : change.action === "delete"
        ? change.before !== undefined
        : change.before !== undefined && change.after !== undefined;
  const model = useMemo(
    () =>
      drawable && !change.dir
        ? rewriteWindows(change.before ?? "", change.after ?? "", { context: 1, maxWindows: 6 })
        : null,
    [drawable, change.dir, change.before, change.after],
  );

  return (
    <div className={styles.change}>
      <div className={styles.changePath}>{change.path}</div>
      {!model && change.diff && change.diff.windows.length > 0 ? (
        // The texts were too long to keep, so the record kept the windows.
        <>
          <BlockWindows windows={change.diff.windows} lineNumbers expandable={false} />
          {change.diff.hiddenTotal > 0 && (
            <div className={styles.note}>
              {t("ai.agent.writes.moreStored", { n: change.diff.hiddenTotal })}
            </div>
          )}
        </>
      ) : !model ? (
        <div className={styles.note}>
          {change.dir
            ? t("ai.plan.ledger.undo.folderMoved")
            : change.backupPath
              ? t("ai.plan.ledger.tooBig", { path: change.backupPath })
              : t("ai.plan.ledger.noText")}
        </div>
      ) : model.empty ? (
        <div className={styles.note}>{t("ai.plan.ledger.unchanged")}</div>
      ) : (
        <BlockWindows windows={model.windows} lineNumbers />
      )}
      {change.backupPath && (
        <div className={styles.note}>
          {t("ai.plan.ledger.undo.backupLine", { path: backupLabel(change.backupPath) })}
        </div>
      )}
    </div>
  );
}

/** `backups/agent-…-外貌.md` — the folder the author would open, and the name in it. */
function backupLabel(path: string): string {
  return path.split(/[\\/]/).slice(-2).join("/");
}

/** A write the gate turned away because no approved step covered it. */
function RefusedRow({ step }: { step: ToolStep }) {
  const { t } = useTranslation();
  const terms = useTerms();
  const args = formatToolArgs(step.argumentSummary);
  return (
    <li className={styles.refused}>
      <span className={styles.refusedMark}>{t("ai.plan.ledger.refused")}</span>
      <span className={styles.refusedCall}>
        {t(`ai.agent.tool.${step.name}`, { defaultValue: step.name, doc: terms.doc, entry: terms.entry })}
        {args && <span className={styles.file}> · {args}</span>}
      </span>
    </li>
  );
}
