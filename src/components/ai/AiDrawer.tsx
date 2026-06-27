import { useTranslation } from "react-i18next";
import { Sparkles, CheckCircle2 } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useAiStore } from "../../stores/aiStore";
import { AiPanel } from "./AiPanel";
import { ConsistencyCheck } from "./ConsistencyCheck";
import styles from "./AiDrawer.module.css";

export function AiDrawer() {
  const { t } = useTranslation();
  const { showAiDrawer, aiDrawerMode, setShowAiDrawer } = useAppStore();
  const { models, providers, activeModelId } = useAiStore();

  if (!showAiDrawer) return null;

  const close = () => setShowAiDrawer(false);
  const setMode = (m: "generate" | "consistency") => setShowAiDrawer(true, m);

  const activeModel = models.find((m) => m.id === activeModelId);
  const activeProvider = activeModel ? providers.find((p) => p.id === activeModel.providerId) : null;

  const headerTitle =
    aiDrawerMode === "consistency"
      ? t("ai.drawer.consistencyTitle", { defaultValue: "一致性检查" })
      : t("ai.drawer.generateTitle", { defaultValue: "AI 助手" });

  return (
    <>
      <div className={styles.backdrop} onClick={close} />
      <aside className={styles.drawer} role="dialog" aria-modal>
        <div className={styles.header}>
          <div className={styles.avatar}>
            {aiDrawerMode === "consistency"
              ? <CheckCircle2 size={16} strokeWidth={1.6} />
              : <Sparkles size={16} strokeWidth={1.6} />}
          </div>
          <div className={styles.titleBlock}>
            <div className={styles.title}>{headerTitle}</div>
            <div className={styles.subtitle}>
              {activeProvider && activeModel ? (
                <span className={styles.modelChip}>
                  {activeProvider.name} <strong>/</strong> {activeModel.name}
                </span>
              ) : (
                <span className={styles.modelChip}>{t("ai.panel.selectModel")}</span>
              )}
            </div>
          </div>

          <div className={styles.modeTabs}>
            <button
              className={`${styles.modeTab} ${aiDrawerMode === "generate" ? styles.modeTabActive : ""}`}
              onClick={() => setMode("generate")}
            >
              {t("ai.tasks.continue")}
            </button>
            <button
              className={`${styles.modeTab} ${aiDrawerMode === "consistency" ? styles.modeTabActive : ""}`}
              onClick={() => setMode("consistency")}
            >
              {t("ai.drawer.consistency", { defaultValue: "一致性" })}
            </button>
          </div>

          <button className={styles.closeBtn} onClick={close} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          {aiDrawerMode === "generate" ? <AiPanel /> : <ConsistencyCheck />}
        </div>
      </aside>
    </>
  );
}
