import { useTranslation } from "react-i18next";
import { Globe, Eye, BookOpen, type LucideIcon } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useAgentStore } from "../../stores/agentStore";
import { subAgentModel, SUBAGENT_KINDS, type SubAgentKind } from "../../lib/agent/subagent";
import styles from "./SubAgentChips.module.css";

const ICONS: Record<SubAgentKind, LucideIcon> = {
  search: Globe,
  vision: Eye,
  longread: BookOpen,
};

/**
 * Per-conversation switches for the subagents Settings has enabled.
 *
 * Subtractive only — a chip turns one off for this conversation; it can never
 * turn on something with no model bound. The state lives in agentStore and is
 * cleared whenever the conversation changes (new chat, or switching sessions).
 */
export function SubAgentChips() {
  const { t } = useTranslation();
  const subAgents = useAiStore((s) => s.subAgents);
  const models = useAiStore((s) => s.models);
  const disabledSubAgents = useAgentStore((s) => s.disabledSubAgents);
  const toggleSubAgent = useAgentStore((s) => s.toggleSubAgent);

  // Usable, not merely enabled: a vision subagent bound to a text model, or a
  // search one whose model cannot browse, would give the author a switch that
  // changes nothing — every other surface has already decided it is off.
  const configuredKinds = SUBAGENT_KINDS.filter(
    (k) => subAgentModel(k, models, subAgents) !== null,
  );

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
          defaultValue: kind === "search" ? "联网" : kind === "vision" ? "识图" : "长文",
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
