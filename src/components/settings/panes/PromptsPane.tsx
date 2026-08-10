import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, X } from "lucide-react";
import { useAiStore } from "../../../stores/aiStore";
import { useProjectStore } from "../../../stores/projectStore";
import type { Prompt } from "../../../lib/ai/configDb";
import { activeProfile, findTask, profileLabel, promptParams } from "../../../lib/profile";
import { PromptDrawer, SNIPPET_SCENE } from "./PromptDrawer";
import { Pane, PaneHeader, Section } from "./bits";
import ui from "../settingsUi.module.css";
import hub from "./ProvidersModels.module.css";

const BUILTIN_PROMPTS_CONFIG = [
  { scene: "system", instructionKey: "ai.instructions.system" },
  { scene: "continue", instructionKey: "ai.instructions.continue" },
  { scene: "polish", instructionKey: "ai.instructions.polish" },
  { scene: "rewrite", instructionKey: "ai.instructions.rewrite" },
  { scene: "summary", instructionKey: "ai.instructions.summary" },
  { scene: "lore", instructionKey: "ai.instructions.lore" },
];

/** Collapsed rows show the opening of the instruction, on one line. */
function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

interface Props {
  onEscapeInterceptChange: (handler: (() => void) | null) => void;
}

export function PromptsPane({ onEscapeInterceptChange }: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith("zh");
  const { prompts, removePrompt } = useAiStore();
  const profile = useProjectStore((s) => s.profile);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<Partial<Prompt> | null>(null);

  // Resolve against the active profile: a scene that is a task id shows the
  // instruction that task actually uses (novel overrides continue/rewrite/
  // summary with its own wording), and "system" shows this profile's system
  // prompt — otherwise the editor would display a text no run ever sends.
  const builtins = BUILTIN_PROMPTS_CONFIG.map((b) => {
    const key = b.scene === "system"
      ? activeProfile().systemPromptKey
      : findTask(b.scene)?.instructionKey ?? b.instructionKey;
    return { ...b, label: t(`ai.tasks.${b.scene}`), text: t(key, promptParams(isZh)) };
  });

  const closeDrawer = () => { setDraft(null); onEscapeInterceptChange(null); };
  const openDrawer = (d: Partial<Prompt>) => {
    setDraft(d);
    onEscapeInterceptChange(() => closeDrawer());
  };

  return (
    <Pane
      drawer={draft && (
        <>
          <div className={hub.scrim} onClick={closeDrawer} />
          <PromptDrawer key={draft.id ?? "new"} draft={draft} onClose={closeDrawer} />
        </>
      )}
    >
      <PaneHeader
        title={t("systemSettings.tabs.prompts")}
        sub={t("aiConfig.prompts.paneSub")}
        action={
          <button className={ui.primaryBtn} onClick={() => openDrawer({ name: "", content: "", scene: "continue" })}>
            + {t("aiConfig.prompts.addCta")}
          </button>
        }
      />

      <Section label={t("aiConfig.prompts.customTitle")}>
        {prompts.length === 0 ? (
          <div className={ui.emptyDashed}>{t("aiConfig.prompts.emptyHint")}</div>
        ) : (
          <div style={{ marginTop: "var(--space-3)" }}>
            {prompts.map((p) => (
              <div
                key={p.id}
                className={ui.customRow}
                role="button"
                tabIndex={0}
                onClick={() => openDrawer(p)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDrawer(p); }
                }}
              >
                <span className={ui.badge}>{p.scene}</span>
                <span className={ui.customName}>{p.name}</span>
                <span className={ui.listPreview}>{preview(p.content, 60)}</span>
                <span className={ui.spacer} />
                {/* A snippet is offered for insertion; it overrides nothing. */}
                {p.scene !== SNIPPET_SCENE && (
                  <span className={ui.overriding}>{t("aiConfig.prompts.overriding")}</span>
                )}
                <button
                  className={ui.iconBtn}
                  title={t("aiConfig.prompts.delete")}
                  onClick={(e) => { e.stopPropagation(); removePrompt(p.id); }}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section label={t("aiConfig.prompts.builtinTitle")}>
        <div className={ui.rowDesc} style={{ marginBottom: "var(--space-3)" }}>
          {t("aiConfig.prompts.builtinHint", { profile: profileLabel(profile, isZh) })}
        </div>
        {builtins.map((b) => {
          const expanded = !!open[b.scene];
          const overridden = prompts.some((p) => p.scene === b.scene);
          return (
            <div className={ui.listCard} key={b.scene}>
              <div
                className={ui.listHead}
                role="button"
                tabIndex={0}
                onClick={() => setOpen((o) => ({ ...o, [b.scene]: !expanded }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setOpen((o) => ({ ...o, [b.scene]: !expanded }));
                  }
                }}
              >
                <span className={`${ui.chevron} ${expanded ? ui.chevronOpen : ""}`}>
                  <ChevronRight size={14} />
                </span>
                <span className={ui.badge}>{b.scene}</span>
                <span className={ui.listTitle}>{b.label}</span>
                {!expanded && <span className={ui.listPreview}>{preview(b.text, 46)}</span>}
                {overridden && (
                  <>
                    <span className={ui.spacer} />
                    <span className={ui.overriding}>{t("aiConfig.prompts.overridden")}</span>
                  </>
                )}
              </div>
              {expanded && (
                <div className={ui.listBody}>
                  <div className={ui.promptText}>{b.text}</div>
                  <div className={ui.listActions}>
                    <button
                      className={ui.overrideBtn}
                      onClick={() => openDrawer({ name: b.label, content: b.text, scene: b.scene })}
                    >
                      {t("aiConfig.prompts.useAsDraft")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </Section>

    </Pane>
  );
}
