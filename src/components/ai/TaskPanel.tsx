/**
 * Band ④ of the execution surface: the task the agent split the work into.
 *
 * **Session-level, deliberately.** The other three bands describe one run and
 * live inside `AgentLog`, which the chat renders once per assistant turn. A
 * plan does not belong to a turn — it is written in round 3 of turn 1 and
 * ticked off in turn 4 — so putting it there would print the same five steps
 * ten times down a long conversation. One panel, pinned above the composer.
 *
 * **Read from disk, not from the event stream.** `task_plan`'s arguments are
 * truncated to 400 chars like every other call's, and a six-step Chinese plan
 * does not survive that; more importantly, a task resumed after a pause has its
 * plan only in `.ai-writer/tasks/<id>/task.md` — the new conversation's events
 * know nothing about it. `taskDocRevision` says when to re-read.
 *
 * Absent until the agent actually splits the work: a workspace with notes but
 * no steps is not a plan, and an empty progress bar above the input is chrome
 * that costs message space on every session to say nothing.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  loadTaskDoc,
  parseSteps,
  taskTitle,
  type StepStatus,
  type TaskStatus,
  type TaskStep,
} from "../../lib/agent/taskWorkspace";
import { formatTokenCount } from "../../lib/agent/logFormat";
import type { TokenTotals } from "../../lib/agent/logModel";
import styles from "./TaskPanel.module.css";

interface Plan {
  title: string | null;
  status: TaskStatus;
  steps: TaskStep[];
}

function useTaskPlan(
  projectPath: string | null,
  taskId: string | null | undefined,
  revision: number,
): Plan | null {
  const [plan, setPlan] = useState<Plan | null>(null);

  useEffect(() => {
    if (!projectPath || !taskId) {
      setPlan(null);
      return;
    }
    // The read is async and the task can change under it (a new session, a
    // resume) — a late resolve must not repaint the panel with the old task's
    // plan.
    let live = true;
    loadTaskDoc(projectPath, taskId)
      .then((doc) => {
        if (!live) return;
        setPlan(
          doc
            ? { title: taskTitle(doc.body), status: doc.meta.status, steps: parseSteps(doc.body) }
            : null,
        );
      })
      .catch(() => {
        if (live) setPlan(null);
      });
    return () => {
      live = false;
    };
  }, [projectPath, taskId, revision]);

  return plan;
}

/** Step state as a glyph — the same vocabulary `task.md` uses on disk. */
function StepMark({ status }: { status: StepStatus }) {
  return <span className={`${styles.mark} ${styles[`mark_${status}`]}`} />;
}

export function TaskPanel({
  projectPath, taskId, revision, tokens,
}: {
  projectPath: string | null;
  taskId: string | null | undefined;
  revision: number;
  tokens: TokenTotals;
}) {
  const plan = useTaskPlan(projectPath, taskId, revision);
  // No steps, no plan — see the header comment.
  if (!plan || plan.steps.length === 0) return null;
  return <TaskPlanCard plan={plan} tokens={tokens} />;
}

/** The panel itself, given a plan. Split from the loading so it can be looked at. */
export function TaskPlanCard({ plan, tokens }: { plan: Plan; tokens: TokenTotals }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const done = plan.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const total = tokens.input + tokens.output + tokens.subInput + tokens.subOutput;
  const subTotal = tokens.subInput + tokens.subOutput;

  return (
    <div className={styles.panel}>
      <button
        type="button"
        className={styles.head}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={styles.chevron}>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <span className={styles.title}>
          {plan.title ?? t("ai.taskPanel.untitled", { defaultValue: "当前任务" })}
        </span>
        {plan.status === "paused" && (
          <span className={styles.paused}>
            {t("ai.taskPanel.paused", { defaultValue: "已暂停" })}
          </span>
        )}
        <span className={styles.progress}>
          {done}/{plan.steps.length}
        </span>
        {total > 0 && (
          <span
            className={styles.tokens}
            // The breakdown, because the two halves are different bills: the
            // specialists ran on their own models at their own prices.
            title={
              subTotal > 0
                ? t("ai.taskPanel.tokensBreakdown", {
                    defaultValue: "主模型 {{main}} · 子代理 {{sub}}",
                    main: formatTokenCount(tokens.input + tokens.output),
                    sub: formatTokenCount(subTotal),
                  })
                : undefined
            }
          >
            {formatTokenCount(total)} tk
          </span>
        )}
      </button>

      {/* Collapsed: the steps as a strip of marks, so progress is legible
          without opening anything. Expanded: the same steps, named. */}
      {open ? (
        <ol className={styles.steps}>
          {plan.steps.map((step) => (
            <li key={step.index} className={`${styles.step} ${styles[`step_${step.status}`]}`}>
              <StepMark status={step.status} />
              <span className={styles.stepTitle}>{step.title}</span>
            </li>
          ))}
        </ol>
      ) : (
        <div className={styles.strip} aria-hidden>
          {plan.steps.map((step) => (
            <span key={step.index} className={`${styles.pip} ${styles[`mark_${step.status}`]}`} />
          ))}
        </div>
      )}
    </div>
  );
}
