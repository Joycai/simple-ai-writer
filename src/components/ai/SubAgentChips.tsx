import { useTranslation } from "react-i18next";
import { Globe, Eye, BookOpen, FileText, ImagePlus, Languages, PenLine, type LucideIcon } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useAgentStore } from "../../stores/agentStore";
import { subAgentModel, SUBAGENT_KINDS, type SubAgentKind } from "../../lib/agent/subagent";
import styles from "./toggleChip.module.css";

const ICONS: Record<SubAgentKind, LucideIcon> = {
  search: Globe,
  vision: Eye,
  longread: BookOpen,
  pdf: FileText,
  imagegen: ImagePlus,
  translate: Languages,
  writer: PenLine,
};

/**
 * Per-conversation switches for the subagents Settings has enabled.
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
 * `kinds` narrows which switches this surface shows at all. Not cosmetic: a
 * subagent whose surface never consults it would be a chip that changes nothing
 * when pressed — the same "enabled but does nothing" failure the whole
 * usable-not-merely-enabled rule below exists to prevent. Roleplay passes this
 * to leave out `writer`, whose handoff only the chat assistant opts into
 * (lib/agent/routing RouteOptions).
 */
export function SubAgentChips({ disabled, onToggle, kinds = SUBAGENT_KINDS }: {
  disabled?: readonly SubAgentKind[];
  onToggle?: (kind: SubAgentKind) => void;
  kinds?: readonly SubAgentKind[];
} = {}) {
  const { t } = useTranslation();
  const subAgents = useAiStore((s) => s.subAgents);
  const models = useAiStore((s) => s.models);
  const chatDisabled = useAgentStore((s) => s.disabledSubAgents);
  const chatToggle = useAgentStore((s) => s.toggleSubAgent);
  const disabledSubAgents = disabled ?? chatDisabled;
  const toggleSubAgent = onToggle ?? chatToggle;

  // Usable, not merely enabled: a vision subagent bound to a text model, or a
  // search one whose model cannot browse, would give the author a switch that
  // changes nothing — every other surface has already decided it is off.
  const configuredKinds = kinds.filter(
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
          defaultValue:
            kind === "search" ? "联网"
            : kind === "vision" ? "识图"
            : kind === "pdf" ? "PDF"
            : kind === "imagegen" ? "绘图"
            : kind === "writer" ? "写手"
            : "长文",
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
