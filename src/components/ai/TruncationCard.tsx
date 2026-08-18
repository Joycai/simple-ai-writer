/**
 * Repeated-truncation decision card.
 *
 * The loop is blocked on this choice: the endpoint has cut the model off at its
 * output cap several times running, and the runtime has already recovered from
 * each one silently (asked it to continue, or told it the truncated tool call
 * was dropped). Past that point the retries are worth questioning — every one
 * is another paid request, and the usual causes are worth the author knowing
 * about: an output cap set far too low for the model, or a model that keeps
 * trying to emit a whole large file in one reply.
 */

import { useTranslation } from "react-i18next";
import { useAgentStore, type PendingTruncation } from "../../stores/agentStore";
import styles from "./RoundLimitCard.module.css";

export function TruncationCard({ item }: { item: PendingTruncation }) {
  const { t } = useTranslation();
  const resolveTruncation = useAgentStore((s) => s.resolveTruncation);

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          {t("ai.truncation.title", { defaultValue: "输出反复被上限截断" })}
        </span>
        <span className={styles.headerRounds}>
          {t("ai.truncation.count", { defaultValue: "{{n}} 次", n: item.recoveries })}
        </span>
      </div>
      <div className={styles.body}>
        {t("ai.truncation.body", {
          defaultValue:
            "模型的输出已经连续 {{n}} 次被单次回复的上限切断，前几次已自动让它接着写。"
            + "继续会再自动重试 {{n}} 次；也可以就此打住，去模型设置里把「最大输出」调高，"
            + "或让它把大文件分段写（create_file 建骨架 + append_file 逐段追加）。",
          n: item.recoveries,
        })}
      </div>
      <div className={styles.footer}>
        <button
          className={styles.btnFinish}
          onClick={() => resolveTruncation(item.runId, { action: "stop" })}
        >
          {t("ai.truncation.stop", { defaultValue: "到此为止" })}
        </button>
        <button
          className={styles.btnContinue}
          onClick={() => resolveTruncation(item.runId, { action: "continue" })}
        >
          {t("ai.truncation.continue", { defaultValue: "继续重试" })}
        </button>
      </div>
    </div>
  );
}
