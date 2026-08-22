import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAiStore } from "../../../stores/aiStore";
import {
  DELEGATE_KINDS,
  MAX_PDF_BYTES,
  MAX_PDF_FILES,
  SUBAGENT_KINDS,
  SUB_PRESETS,
  type DelegateKind,
  type SubAgentKind,
} from "../../../lib/agent/subagent";
import type { Model } from "../../../lib/ai/configDb";
import { Pane, Toggle } from "./bits";
import { Select } from "../../common/Select";
import ui from "../settingsUi.module.css";
import css from "./SubAgents.module.css";

/**
 * Binds each specialist subagent to a model and turns it on.
 *
 * Application-scoped, like the image and memory model pickers it generalises:
 * which model can browse or read pictures is a property of what the author
 * bought, not of the project they happen to have open.
 *
 * A subagent is only ever a *pair* — the specialist and the model running it —
 * and half a pair is worth nothing, so each one is one card that answers "does
 * this work?" in a glance: a status dot, the capability the model must have,
 * the switch, the binding, and the caution it has earned (设计稿 04). What a
 * subagent *does* (its tool set, round budget, output contract) is code, not
 * configuration; see `lib/agent/subagent.ts` and docs/feature/agent/subagent-lld.md §5.2.
 */
export function SubAgentsPane() {
  const { t } = useTranslation();
  const models = useAiStore((s) => s.models);
  const subAgents = useAiStore((s) => s.subAgents);
  const setSubAgent = useAiStore((s) => s.setSubAgent);

  // Image models can't hold a conversation, so the conversational kinds never
  // offer them — and the imagegen kind offers nothing else: it exists to draw,
  // and binding it to a text model would be the mirror image of the mistake.
  const textCandidates = models.filter((m) => m.enabled && m.type !== "image");
  const imageCandidates = models.filter((m) => m.enabled && m.type === "image");
  const candidatesFor = (kind: SubAgentKind): Model[] =>
    kind === "imagegen" ? imageCandidates : textCandidates;

  /**
   * Why a bound model can't do this job, if it can't.
   *
   * Surfaced here as well as refused at run time (lib/agent/subagent): by the
   * time the run reports it, the author has waited through a round trip to be
   * told something this screen already knew. An enabled kind with nothing
   * resolvable bound is the same failure a step earlier — including a binding
   * that has gone stale because the model was disabled or retyped.
   */
  const warningFor = (kind: SubAgentKind, model: Model | undefined): string | undefined => {
    if (!model) return subAgents[kind].enabled ? t("systemSettings.subagents.warnNoModel") : undefined;
    if (kind === "search" && !model.serverTools?.includes("web_search")) {
      return t("systemSettings.subagents.warnNoSearch");
    }
    if (kind === "vision" && model.type !== "multimodal") {
      return t("systemSettings.subagents.warnNotMultimodal");
    }
    if (kind === "pdf" && !model.pdfInput) {
      return t("systemSettings.subagents.warnNoPdf");
    }
    if (kind === "imagegen" && model.type !== "image") {
      return t("systemSettings.subagents.warnNotImage");
    }
    return undefined;
  };

  /** The preset's own numbers, so this line can't drift from what runs. */
  const metaFor = (kind: SubAgentKind): string => {
    if (kind === "imagegen") return t("systemSettings.subagents.imagegenMeta");
    const preset = SUB_PRESETS[kind as DelegateKind];
    const parts = [
      preset.maxRounds === 1
        ? t("systemSettings.subagents.singleShot")
        : t("systemSettings.subagents.rounds", { n: preset.maxRounds }),
    ];
    if (kind === "pdf") {
      parts.push(
        t("systemSettings.subagents.pdfLimits", {
          files: MAX_PDF_FILES,
          mb: Math.round(MAX_PDF_BYTES / 1024 / 1024),
        }),
      );
    }
    if (preset.serverTools === "always") parts.push(t("systemSettings.subagents.searchAlways"));
    return parts.join(" · ");
  };

  const state = SUBAGENT_KINDS.map((kind) => {
    const cfg = subAgents[kind];
    const candidates = candidatesFor(kind);
    const model = candidates.find((m) => m.id === cfg.modelId);
    const warn = warningFor(kind, model);
    return { kind, cfg, candidates, warn, broken: cfg.enabled && !!warn };
  });

  const enabled = state.filter((s) => s.cfg.enabled).length;
  const broken = state.filter((s) => s.broken).length;
  const summary = [
    t("systemSettings.subagents.summary", { on: enabled, total: state.length }),
    ...(broken ? [t("systemSettings.subagents.summaryAttention", { n: broken })] : []),
  ].join(" · ");

  // Two groups, and the split is the one the runtime makes: `delegate` can
  // dispatch to a conversation, `imagegen` is reached as a tool instead.
  const groups: { id: string; kinds: SubAgentKind[] }[] = [
    { id: "Delegate", kinds: [...DELEGATE_KINDS] },
    { id: "Tool", kinds: SUBAGENT_KINDS.filter((k) => !DELEGATE_KINDS.includes(k as DelegateKind)) },
  ];

  return (
    <Pane>
      <div className={ui.paneHead}>
        <div>
          <div className={css.titleLine}>
            <span className={ui.paneTitle}>{t("systemSettings.tabs.subagents")}</span>
            <span className={css.summary}>{summary}</span>
          </div>
          <div className={ui.paneSub}>{t("systemSettings.subagents.paneSub")}</div>
        </div>
      </div>

      {groups.map((group) => (
        <div key={group.id} className={css.group}>
          <div className={css.groupHead}>
            <span className={css.groupLabel}>{t(`systemSettings.subagents.group${group.id}`)}</span>
            <span className={css.groupHint}>{t(`systemSettings.subagents.group${group.id}Hint`)}</span>
          </div>
          <div className={css.groupRule} />

          <div className={css.cards}>
            {group.kinds.map((kind) => {
              const { cfg, candidates, warn, broken: bad } = state.find((s) => s.kind === kind)!;
              const name = t(`systemSettings.subagents.${kind}`);
              const status = !cfg.enabled
                ? t("systemSettings.subagents.statusOff")
                : bad
                  ? t("systemSettings.subagents.statusAttention")
                  : t("systemSettings.subagents.statusReady");
              return (
                <div key={kind} className={`${css.card} ${bad ? css.cardWarn : ""}`}>
                  <div className={`${css.body} ${cfg.enabled ? css.bodyOn : ""}`}>
                    <div className={css.head}>
                      <span
                        className={`${css.dot} ${!cfg.enabled ? "" : bad ? css.dotWarn : css.dotReady}`}
                      />
                      <span className={css.name}>{name}</span>
                      <span className={css.req}>{t(`systemSettings.subagents.${kind}Req`)}</span>
                      <span className={css.spacer} />
                      <span
                        className={`${css.status} ${!cfg.enabled ? "" : bad ? css.statusWarn : css.statusReady}`}
                      >
                        {status}
                      </span>
                      <Toggle
                        on={cfg.enabled}
                        onChange={(next) => setSubAgent(kind, { enabled: next })}
                        label={`${t("systemSettings.subagents.enable")} ${name}`}
                      />
                    </div>

                    <div className={css.desc}>{t(`systemSettings.subagents.${kind}Sub`)}</div>

                    <div className={css.bind}>
                      <span className={css.bindLabel}>{t("systemSettings.subagents.runModel")}</span>
                      <Select
                        className={css.bindSelect}
                        value={cfg.modelId ?? ""}
                        onChange={(v) => setSubAgent(kind, { modelId: v || null })}
                        options={[
                          { value: "", label: t("systemSettings.subagents.noModel") },
                          ...candidates.map((m) => ({ value: m.id, label: m.name })),
                        ]}
                        ariaLabel={`${t("systemSettings.subagents.runModel")} — ${name}`}
                      />
                      <span className={css.meta}>{metaFor(kind)}</span>
                    </div>
                  </div>

                  {warn && (
                    <div className={css.warn}>
                      <AlertTriangle size={13} className={css.warnIcon} />
                      <span>{warn}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className={css.foot}>{t("systemSettings.subagents.foot")}</div>
    </Pane>
  );
}
