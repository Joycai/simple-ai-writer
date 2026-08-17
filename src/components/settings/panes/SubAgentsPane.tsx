import { useTranslation } from "react-i18next";
import { useAiStore } from "../../../stores/aiStore";
import { SUBAGENT_KINDS, type SubAgentKind } from "../../../lib/agent/subagent";
import type { Model } from "../../../lib/ai/configDb";
import { Pane, PaneHeader, Section, Row, Toggle } from "./bits";
import { Select } from "../../common/Select";
import common from "../settingsCommon.module.css";

/**
 * Binds each specialist subagent to a model and turns it on.
 *
 * Application-scoped, like the image and memory model pickers it generalises:
 * which model can browse or read pictures is a property of what the author
 * bought, not of the project they happen to have open.
 *
 * Deliberately thin — a switch and a dropdown per kind. What a subagent *does*
 * (its tool set, round budget, output contract) is code, not configuration;
 * see `lib/agent/subagent.ts` and docs/subagent-lld.md §5.2.
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
   * told something this screen already knew.
   */
  const warningFor = (kind: SubAgentKind, model: Model | undefined): string | undefined => {
    if (!model) return undefined;
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

  return (
    <Pane>
      <PaneHeader
        title={t("systemSettings.tabs.subagents")}
        sub={t("systemSettings.subagents.paneSub")}
      />

      {SUBAGENT_KINDS.map((kind) => {
        const cfg = subAgents[kind];
        const candidates = candidatesFor(kind);
        const model = candidates.find((m) => m.id === cfg.modelId);
        return (
          <Section key={kind} label={t(`systemSettings.subagents.${kind}`)}>
            {/* The section already names the kind — repeating it on the row
                read as a stutter ("联网检索 / 联网检索"). */}
            <Row title={t("systemSettings.subagents.enable")} desc={t(`systemSettings.subagents.${kind}Sub`)}>
              <Toggle
                on={cfg.enabled}
                onChange={(next) => setSubAgent(kind, { enabled: next })}
                label={t(`systemSettings.subagents.${kind}`)}
              />
            </Row>
            <Row title={t("systemSettings.subagents.pickModel")} warn={warningFor(kind, model)} last>
              <Select
                className={common.rowSelect}
                value={cfg.modelId ?? ""}
                onChange={(v) => setSubAgent(kind, { modelId: v || null })}
                options={[
                  { value: "", label: t("systemSettings.subagents.noModel") },
                  ...candidates.map((m) => ({ value: m.id, label: m.name })),
                ]}
                ariaLabel={t("systemSettings.subagents.pickModel")}
              />
            </Row>
          </Section>
        );
      })}
    </Pane>
  );
}
