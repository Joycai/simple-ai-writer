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
import { stepTarget, type LorePlanAction } from "../../lib/agent/plan";
import { autoApproveScope } from "../../lib/agent/autoApprove";
import { useAgentStore, type PendingPlan } from "../../stores/agentStore";
import { useTerms } from "../../stores/projectStore";
import styles from "./PlanCard.module.css";

/** How many member names a collection step shows before folding the rest. */
const MEMBER_PREVIEW = 6;

const ACTION_STYLE: Record<LorePlanAction, string> = {
  create: styles.actionCreate,
  update: styles.actionUpdate,
  move: styles.actionMove,
  delete: styles.actionDelete,
};

export function PlanCard({ item }: { item: PendingPlan }) {
  const { t } = useTranslation();
  const terms = useTerms();
  const { approvePlan, rejectPlan, enableAutoApprove } = useAgentStore();
  const [rejectReason, setRejectReason] = useState("");
  const [deciding, setDeciding] = useState(false);

  const { plan, autoApproveKey } = item;

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>{t("ai.plan.title", { entry: terms.entry })}</span>
        <span className={styles.headerCount}>
          {t("ai.plan.stepCount", { count: plan.steps.length })}
        </span>
      </div>

      <div className={styles.body}>
        {plan.summary && <div className={styles.summary}>{plan.summary}</div>}
        <ol className={styles.steps}>
          {plan.steps.map((step, i) => {
            const kind = stepTarget(step);
            const members = step.members ?? [];
            return (
              <li key={i} className={styles.step}>
                <span className={`${styles.action} ${ACTION_STYLE[step.action]}`}>
                  {t(`ai.plan.action.${step.action}`)}
                </span>
                <span className={styles.entity}>
                  {/* 目标类型只在不是「条目」时才出现——条目是默认，给它挂个徽标
                      等于让每一行都多一个恒定不变的词。 */}
                  {kind !== "entity" && (
                    <span className={styles.kind}>{t(`ai.plan.target.${kind}`)}</span>
                  )}
                  {step.entity}
                  {step.file && <span className={styles.file}> / {step.file}</span>}
                </span>
                <span className={styles.detail}>
                  {step.detail}
                  {/* 一条集合一行、条目列在行内：这正是「200 条按作品归类」还能读的
                      原因——作者读 5 行看完一次重整，而不是 200 行。 */}
                  {members.length > 0 && (
                    <span className={styles.members}>
                      {t("ai.plan.members", { count: members.length })}
                      {"："}
                      {members.slice(0, MEMBER_PREVIEW).join("、")}
                      {members.length > MEMBER_PREVIEW &&
                        t("ai.plan.membersMore", { n: members.length - MEMBER_PREVIEW })}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
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
        {autoApproveKey !== undefined && (
          <button
            className={styles.btnApproveAlways}
            onClick={() => {
              setDeciding(true);
              enableAutoApprove(autoApproveKey, "plans");
              approvePlan(plan.id);
            }}
            disabled={deciding}
          >
            {autoApproveScope(autoApproveKey) === "session"
              ? t("ai.plan.approveAlways", { defaultValue: "本次对话都批准" })
              : t("ai.plan.approveAlwaysRun", { defaultValue: "本次任务都批准" })}
          </button>
        )}
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
