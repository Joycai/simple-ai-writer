import { useTranslation } from "react-i18next";
import { ListChecks } from "lucide-react";
import { useActiveChat, useAgentStore } from "../../stores/agentStore";
import styles from "./toggleChip.module.css";

/**
 * 计划模式 — a switch on how the assistant works, sitting beside the subagent
 * switches because it is the same kind of control.
 *
 * It replaced a 「制定计划」 *button*, which sent a one-off turn asking the model
 * to plan whatever the conversation had been about. That put the plan in the
 * wrong place in time: the author could only ask for one after describing the
 * work, the plan covered a transcript rather than a request, and the next
 * message went back to whatever the model would have done anyway. As a mode it
 * applies to the work the author is about to ask for — every turn while it is
 * on carries the instruction (see agentStore.planMode).
 *
 * Subtractive-by-default like the chips next to it: off is the plain state, so
 * off wears the dashed ghost border and on lights up.
 */
export function PlanModeChip() {
  const { t } = useTranslation();
  const planMode = useActiveChat((c) => c.planMode);
  const setPlanMode = useAgentStore((s) => s.setPlanMode);

  const label = t("ai.chat.planMode", { defaultValue: "计划模式" });
  return (
    <button
      type="button"
      className={`${styles.chip} ${planMode ? styles.chipActive : styles.chipDisabled}`}
      onClick={() => setPlanMode(!planMode)}
      aria-pressed={planMode}
      title={
        planMode
          ? t("ai.chat.planModeOn", {
              defaultValue: "计划模式已开启：模型会先立可勾选的步骤清单再动手（点击关闭）",
            })
          : t("ai.chat.planModeOff", {
              defaultValue: "计划模式已关闭：模型自行决定要不要立清单（点击开启）",
            })
      }
    >
      <ListChecks size={12} className={styles.icon} />
      <span className={styles.label}>{label}</span>
    </button>
  );
}
