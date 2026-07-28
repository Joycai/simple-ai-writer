/**
 * Approval card for a proposed lore plan (see lib/agent/plan.ts).
 *
 * The agent's tool loop is blocked on this decision. Approving records the
 * steps in the run's gate — every lore write that follows must match one of
 * them, and anything else is refused — so this card is the author's single
 * point of control over a whole housekeeping pass, rather than a confirmation
 * per file.
 *
 * The steps are therefore the card: each row leads with the verb (what will
 * happen to the entity) so the destructive ones are scannable at a glance, and
 * the detail is the sentence the author is actually deciding on.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LorePlan, LorePlanAction } from "../../lib/agent/plan";
import { useAgentStore } from "../../stores/agentStore";
import styles from "./PlanCard.module.css";

const ACTION_STYLE: Record<LorePlanAction, string> = {
  create: styles.actionCreate,
  update: styles.actionUpdate,
  move: styles.actionMove,
  delete: styles.actionDelete,
};

export function PlanCard({ plan }: { plan: LorePlan }) {
  const { t } = useTranslation();
  const { approvePlan, rejectPlan } = useAgentStore();
  const [rejectReason, setRejectReason] = useState("");
  const [deciding, setDeciding] = useState(false);

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>{t("ai.plan.title")}</span>
        <span className={styles.headerCount}>
          {t("ai.plan.stepCount", { count: plan.steps.length })}
        </span>
      </div>

      <div className={styles.body}>
        {plan.summary && <div className={styles.summary}>{plan.summary}</div>}
        <ol className={styles.steps}>
          {plan.steps.map((step, i) => (
            <li key={i} className={styles.step}>
              <span className={`${styles.action} ${ACTION_STYLE[step.action]}`}>
                {t(`ai.plan.action.${step.action}`)}
              </span>
              <span className={styles.entity}>
                {step.entity}
                {step.file && <span className={styles.file}> / {step.file}</span>}
              </span>
              <span className={styles.detail}>{step.detail}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className={styles.footer}>
        <input
          className={styles.rejectInput}
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder={t("ai.plan.rejectPlaceholder")}
          disabled={deciding}
        />
        <button
          className={styles.btnReject}
          onClick={() => { setDeciding(true); rejectPlan(plan.id, rejectReason.trim() || undefined); }}
          disabled={deciding}
        >
          {t("ai.plan.reject")}
        </button>
        <button
          className={styles.btnApprove}
          onClick={() => { setDeciding(true); approvePlan(plan.id); }}
          disabled={deciding}
        >
          {t("ai.plan.approve")}
        </button>
      </div>
    </div>
  );
}
