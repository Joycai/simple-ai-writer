import { useTranslation } from "react-i18next";
import { ShieldOff, X } from "lucide-react";
import { useAgentStore } from "../../stores/agentStore";
import { autoApproveScope } from "../../lib/agent/autoApprove";
import styles from "./AutoApproveChip.module.css";

/**
 * "Auto-approving" indicator, shown only while a grant is live.
 *
 * A mode that applies changes to the manuscript without asking must not be
 * invisible: the card the author pressed 本次都批准 on scrolls away, and from
 * then on the only evidence is edits landing silently. So the grant carries a
 * standing marker, and the marker is also how it is revoked — one click, no
 * settings trip.
 *
 * @param owner Which surface is asking. A chip only lights up for the grant it
 *              owns, so the panel does not advertise chat's authorisation.
 */
export function AutoApproveChip({ owner }: { owner: unknown }) {
  const { t } = useTranslation();
  const autoApprove = useAgentStore((s) => s.autoApprove);
  const clearAutoApprove = useAgentStore((s) => s.clearAutoApprove);

  if (!autoApprove || autoApprove.key !== owner) return null;

  const scope = autoApproveScope(owner);
  const label =
    scope === "session"
      ? t("ai.autoApprove.chipSession", { defaultValue: "本次对话自动批准中" })
      : t("ai.autoApprove.chipRun", { defaultValue: "本次任务自动批准中" });

  return (
    <button
      type="button"
      className={styles.chip}
      onClick={clearAutoApprove}
      title={t("ai.autoApprove.off", { defaultValue: "点击恢复逐条审批" })}
    >
      <ShieldOff size={12} className={styles.icon} />
      <span className={styles.label}>{label}</span>
      <X size={11} className={styles.icon} />
    </button>
  );
}
