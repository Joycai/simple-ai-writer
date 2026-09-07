import { useTranslation } from "react-i18next";
import { Globe, Eye, BookOpen, FileText, ImagePlus, Languages, type LucideIcon } from "lucide-react";
import { useActiveChat, useAgentStore } from "../../stores/agentStore";
import type { SubAgentKind } from "../../lib/agent/subagent";
import { useConfiguredKinds, FALLBACK_LABELS, type ChipKind } from "./subagentChipModel";
import styles from "./toggleChip.module.css";

const ICONS: Record<ChipKind, LucideIcon> = {
  search: Globe,
  vision: Eye,
  longread: BookOpen,
  pdf: FileText,
  imagegen: ImagePlus,
  translate: Languages,
};

/**
 * Per-conversation switches for the subagents Settings has enabled, as six
 * boxes.
 *
 * This is the **settings-block** rendering, and after 设计稿 02g it is 一致性检查's
 * alone: that surface is a form the author reads once before starting a run, so
 * six open boxes cost nothing and save a click. On a composer — where the row
 * is paid for on every message — the same switches collapse into one word; see
 * `CapabilityMenu`. What the two share (which kinds exist, which are usable,
 * what each is called) lives in `subagentChipModel`, so only the shapes differ.
 *
 * Subtractive only — a chip turns one off for this conversation; it can never
 * turn on something with no model bound. By default the state lives in
 * agentStore and is cleared whenever the conversation changes (new chat, or
 * switching sessions).
 *
 * `disabled` + `onToggle` hand that state to the caller instead. The roleplay
 * panel needs it: the assistant and three concurrent roleplay agents are four
 * unrelated conversations, and sharing one "turned off for this conversation"
 * set would mean each of them silently editing the others' settings.
 *
 * **The writer is never one of these**, on any surface. Every chip here says
 * "this ability is available" — a switch among equals, and turning one off
 * changes what the assistant *can reach*. The writer says "from now on every
 * sentence is written by it": it always takes effect, and it changes the cost
 * and the wait of every turn. A seventh identical box would file the most
 * consequential switch in the row under the least consequential shape. It gets
 * the composer's own separator line instead — see WriterStrip
 * (设计稿 04d · 屏 5a「写手不是第七个芯片」).
 */
export function SubAgentChips({ disabled, onToggle }: {
  disabled?: readonly SubAgentKind[];
  onToggle?: (kind: SubAgentKind) => void;
} = {}) {
  const { t } = useTranslation();
  const chatDisabled = useActiveChat((c) => c.disabledSubAgents);
  const chatToggle = useAgentStore((s) => s.toggleSubAgent);
  const disabledSubAgents = disabled ?? chatDisabled;
  const toggleSubAgent = onToggle ?? chatToggle;
  const configuredKinds = useConfiguredKinds();

  if (configuredKinds.length === 0) return null;

  return (
    <div
      className={styles.chipsRow}
      role="group"
      aria-label={t("ai.chat.subagentChipsLabel", { defaultValue: "会话子代理开关" })}
    >
      {configuredKinds.map((kind) => {
        const Icon = ICONS[kind];
        const isDisabledThisSession = disabledSubAgents.includes(kind);
        const label = t(`ai.chat.subagentChip.${kind}`, {
          defaultValue: FALLBACK_LABELS[kind],
        });
        const title = isDisabledThisSession
          ? t(`ai.chat.subagentChip.${kind}Disabled`, {
              defaultValue: `${label}子代理已在本次对话停用（点击启用）`,
            })
          : t(`ai.chat.subagentChip.${kind}Active`, {
              defaultValue: `${label}子代理已启用（点击在本次对话停用）`,
            });

        return (
          <button
            key={kind}
            type="button"
            className={`${styles.chip} ${isDisabledThisSession ? styles.chipDisabled : styles.chipActive}`}
            onClick={() => toggleSubAgent(kind)}
            title={title}
            aria-pressed={!isDisabledThisSession}
          >
            <Icon size={12} className={styles.icon} />
            <span className={styles.label}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
