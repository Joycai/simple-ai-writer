import { useTranslation } from "react-i18next";
import { Braces } from "lucide-react";
import { useAgentStore } from "../../stores/agentStore";
import { isSkillStateEnabled } from "../../lib/agent/stateFlag";
import styles from "./toggleChip.module.css";

/**
 * 状态记忆 — the SKILL.state memory mode, as a switch on *this* conversation.
 *
 * Sits beside 计划模式 because it is the same kind of control: how the
 * assistant works, not what the message carries. What it changes is what the
 * model is handed each turn — with it on, everything before the last turn is
 * folded into a structured execution state before every send, instead of
 * being kept verbatim until a threshold fold (lib/agent/skillState,
 * docs/feature/agent/skill-state-memory-plan.md).
 *
 * Absent — not disabled — while the Beta is off (设置 → AI 配置 → 实验室): a
 * switch that changes nothing is worse than no switch. A session that was on
 * the mode when the Beta went off simply folds the ordinary way from then on.
 *
 * Subtractive-by-default like its neighbours: off wears the dashed ghost
 * border, on lights up. The value is the session's (agentStore.stateMemory
 * mirrors chatMeta.stateMode), so it is restored with the conversation.
 */
export function StateMemoryChip() {
  const { t } = useTranslation();
  const on = useAgentStore((s) => s.stateMemory);
  const setStateMemory = useAgentStore((s) => s.setStateMemory);

  if (!isSkillStateEnabled()) return null;

  const label = t("ai.chat.stateMemory", { defaultValue: "状态记忆" });
  return (
    <button
      type="button"
      className={`${styles.chip} ${on ? styles.chipActive : styles.chipDisabled}`}
      onClick={() => setStateMemory(!on)}
      aria-pressed={on}
      title={
        on
          ? t("ai.chat.stateMemoryOn", {
              defaultValue: "状态记忆已开启：每次发送前把上一轮之前的对话折进一份结构化的执行状态，只保留上一轮原文（点击关闭）",
            })
          : t("ai.chat.stateMemoryOff", {
              defaultValue: "状态记忆已关闭：对话原样累积，超过阈值再归纳成摘要（点击开启）",
            })
      }
    >
      <Braces size={12} className={styles.icon} />
      <span className={styles.label}>{label}</span>
    </button>
  );
}
