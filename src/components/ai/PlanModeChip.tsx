import { useTranslation } from "react-i18next";
import { useActiveChat, useAgentStore } from "../../stores/agentStore";
import styles from "./sessionSwitch.module.css";

/**
 * 计划模式 — a switch on how the assistant works.
 *
 * It replaced a 「制定计划」 *button*, which sent a one-off turn asking the model
 * to plan whatever the conversation had been about. That put the plan in the
 * wrong place in time: the author could only ask for one after describing the
 * work, the plan covered a transcript rather than a request, and the next
 * message went back to whatever the model would have done anyway. As a mode it
 * applies to the work the author is about to ask for — every turn while it is
 * on carries the instruction (see agentStore.planMode).
 *
 * It is the one session switch that stays **outside** 能力 (设计稿 02g 屏 1c):
 * of everything in that class it is the one the author flips most, so it keeps
 * a one-click home. Borderless, with the same 7px square the capability menu
 * uses for on/off — a frame in this row means "material this message carries",
 * and this changes neither the message nor the model.
 */
export function PlanModeChip() {
  const { t } = useTranslation();
  const planMode = useActiveChat((c) => c.planMode);
  const setPlanMode = useAgentStore((s) => s.setPlanMode);

  return (
    <button
      type="button"
      className={`${styles.switch} ${planMode ? styles.switchOn : ""}`}
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
      <span className={`${styles.mark} ${planMode ? "" : styles.markOff}`} aria-hidden />
      <span className={styles.label}>{t("ai.chat.planMode", { defaultValue: "计划模式" })}</span>
    </button>
  );
}
