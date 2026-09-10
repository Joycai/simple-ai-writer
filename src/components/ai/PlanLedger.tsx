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
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { rewriteWindows } from "../../lib/diff/blocks";
import type { ChangeRecord, ToolStep } from "../../lib/agent/events";
import { formatToolArgs } from "../../lib/agent/logFormat";
import { stepTarget, type LorePlanAction } from "../../lib/agent/plan";
import type { LedgerStep, PlanLedger } from "../../lib/agent/planLedger";
import { useTerms } from "../../stores/projectStore";
import { BlockWindows } from "./BlockWindows";
import styles from "./PlanLedger.module.css";

const ACTION_STYLE: Record<LorePlanAction, string> = {
  create: styles.actionCreate,
  update: styles.actionUpdate,
  move: styles.actionMove,
  delete: styles.actionDelete,
};

/**
 * Every approved plan in a run, as one band of the log.
 *
 * Not inside the log's `.list`: that list scrolls at 280px, and a ledger whose
 * opened step windows are clipped into a scroll box inside another scroll box is
 * the log hiding the one thing it was asked to show.
 */
export function PlanLedgerBand({ ledgers }: { ledgers: readonly PlanLedger[] }) {
  if (ledgers.length === 0) return null;
  return (
    <ul className={styles.band}>
      {ledgers.map((ledger) => (
        <PlanLedgerBlock key={ledger.toolCallId} ledger={ledger} />
      ))}
    </ul>
  );
}

export function PlanLedgerBlock({ ledger }: { ledger: PlanLedger }) {
  const { t } = useTranslation();
  const terms = useTerms();
  const total = ledger.steps.length;

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
          <LedgerStepRow key={entry.index} entry={entry} />
        ))}
        {ledger.refused.map((step) => (
          <RefusedRow key={step.toolCallId} step={step} />
        ))}
      </ol>
    </li>
  );
}

function LedgerStepRow({ entry }: { entry: LedgerStep }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const changes = entry.writes
    .map((w) => w.change)
    .filter((c): c is ChangeRecord => c !== undefined);
  const kind = stepTarget(entry.step);
  const written = entry.writes.length > 0;
  const expandable = changes.length > 0;

  return (
    <li className={styles.step}>
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
        <span className={written ? styles.receipt : styles.receiptPending}>
          {written ? (
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

/**
 * One write's change, as paragraph windows — the knowledge base is compared at
 * the same grain as a whole-document rewrite (1z B), since an entry is prose.
 */
function ChangeView({ change }: { change: ChangeRecord }) {
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
      drawable
        ? rewriteWindows(change.before ?? "", change.after ?? "", { context: 1, maxWindows: 6 })
        : null,
    [drawable, change.before, change.after],
  );

  return (
    <div className={styles.change}>
      <div className={styles.changePath}>{change.path}</div>
      {!model ? (
        <div className={styles.note}>
          {change.backupPath
            ? t("ai.plan.ledger.tooBig", { path: change.backupPath })
            : t("ai.plan.ledger.noText")}
        </div>
      ) : model.empty ? (
        <div className={styles.note}>{t("ai.plan.ledger.unchanged")}</div>
      ) : (
        <BlockWindows windows={model.windows} lineNumbers />
      )}
    </div>
  );
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
