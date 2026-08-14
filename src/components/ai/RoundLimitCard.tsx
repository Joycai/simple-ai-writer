/**
 * Round-cap decision card.
 *
 * The agent loop is blocked on this choice: it reached its round budget with
 * the model still calling tools. 继续 grants another block of rounds (the
 * preset's own cap again) and the loop resumes exactly where it stopped;
 * 就此收尾 keeps the old behaviour — tools are withheld and the model is told
 * to write its answer with what it has.
 */

import { useTranslation } from "react-i18next";
import { useAgentStore, type PendingRoundLimit } from "../../stores/agentStore";
import styles from "./RoundLimitCard.module.css";

export function RoundLimitCard({ item }: { item: PendingRoundLimit }) {
  const { t } = useTranslation();
  const resolveRoundLimit = useAgentStore((s) => s.resolveRoundLimit);
  const chatTaskWorkspace = useAgentStore((s) => s.chatTaskWorkspace);

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          {t("ai.roundLimit.title", { defaultValue: "已达轮数上限" })}
        </span>
        <span className={styles.headerRounds}>
          {t("ai.roundLimit.rounds", { defaultValue: "{{n}} 轮", n: item.roundsUsed })}
        </span>
      </div>
      <div className={styles.body}>
        {t("ai.roundLimit.body", {
          defaultValue:
            "Agent 已连续调用 {{n}} 轮工具，仍未完成。继续会再给它 {{extra}} 轮；就此收尾则让它用已有的信息直接给出结果。",
          n: item.roundsUsed,
          extra: item.extension,
        })}
      </div>
      <div className={styles.footer}>
        <button
          className={styles.btnFinish}
          onClick={() => resolveRoundLimit(item.runId, { action: "finish" })}
        >
          {t("ai.roundLimit.finish", { defaultValue: "就此收尾" })}
        </button>
        {chatTaskWorkspace && (
          <button
            className={styles.btnPause}
            onClick={() => resolveRoundLimit(item.runId, { action: "pause" })}
          >
            {t("ai.roundLimit.pause", { defaultValue: "存盘并暂停" })}
          </button>
        )}
        <button
          className={styles.btnContinue}
          onClick={() => resolveRoundLimit(item.runId, { action: "extend", rounds: item.extension })}
        >
          {t("ai.roundLimit.continue", { defaultValue: "继续（再 {{n}} 轮）", n: item.extension })}
        </button>
      </div>
    </div>
  );
}
