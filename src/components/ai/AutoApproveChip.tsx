import { useTranslation } from "react-i18next";
import { ShieldOff, X } from "lucide-react";
import { useAgentStore } from "../../stores/agentStore";
import { autoApproveScope } from "../../lib/agent/autoApprove";
import styles from "./AutoApproveChip.module.css";
import { baseName } from "../../lib/paths";

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
 * @param absent Render the dashed「自动批准 —」placeholder while no grant is
 *              live — the chip row's "absent" vocabulary (设计稿 23 屏 1g), so
 *              the slot is always there to read. Chat asks for it; the panel's
 *              chip row (设计稿 02) has no such slot.
 */
export function AutoApproveChip({ owner, absent = false }: { owner: unknown; absent?: boolean }) {
  const { t } = useTranslation();
  const grant = useAgentStore((s) => s.autoApprove);
  const clearAutoApprove = useAgentStore((s) => s.clearAutoApprove);

  const mine = grant && grant.key === owner ? grant : null;
  const blanket = !!mine && (mine.proposals || mine.plans);
  const appendCount = mine ? mine.appendPaths.length : 0;
  const illustrateLeft = mine ? mine.illustrateLeft : 0;
  if (!mine || (!blanket && appendCount === 0 && illustrateLeft === 0)) {
    if (!absent) return null;
    // Not a control: a grant is given on a card, never from here.
    return (
      <span
        className={styles.absent}
        aria-disabled
        title={t("ai.autoApprove.absentHint", { defaultValue: "没有自动批准：每次写入都会先问你。确认卡上的「本次都批准」会把它打开" })}
      >
        {t("ai.autoApprove.chipAbsent", { defaultValue: "自动批准 —" })}
      </span>
    );
  }
  const autoApprove = mine;

  const scope = autoApproveScope(owner);
  // A per-file append grant is real authorisation and must be visible — but it
  // is not 本次都批准, and wearing that label would overstate what the author
  // agreed to on a card that said "this file". The illustrate budget is money
  // authorisation, so its remaining count rides along whatever else is shown.
  const parts = [
    blanket
      ? scope === "session"
        ? t("ai.autoApprove.chipSession", { defaultValue: "本次对话自动批准中" })
        : t("ai.autoApprove.chipRun", { defaultValue: "本次任务自动批准中" })
      : appendCount > 0
        ? t("ai.autoApprove.chipAppend", { defaultValue: "自动追加 {{n}} 个文件", n: appendCount })
        : "",
    illustrateLeft > 0
      ? t("ai.autoApprove.chipIllustrate", { defaultValue: "配图连批 · 剩 {{n}} 张", n: illustrateLeft })
      : "",
  ].filter(Boolean);
  const label = parts.join(" · ");

  return (
    <button
      type="button"
      className={styles.chip}
      onClick={clearAutoApprove}
      title={
        blanket
          ? t("ai.autoApprove.off", { defaultValue: "点击恢复逐条审批" })
          : t("ai.autoApprove.offAppend", {
              defaultValue: "以下文件的追加不再询问：{{files}}（点击恢复逐条审批）",
              files: autoApprove.appendPaths
                .map((p) => baseName(p) || p)
                .join("、"),
            })
      }
    >
      <ShieldOff size={12} className={styles.icon} />
      <span className={styles.label}>{label}</span>
      <X size={11} className={styles.icon} />
    </button>
  );
}
