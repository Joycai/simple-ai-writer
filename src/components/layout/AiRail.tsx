import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { MOD_K } from "../../lib/platform";
import styles from "./AiRail.module.css";

export function AiRail() {
  const { t } = useTranslation();
  const setShowAiDrawer = useAppStore((s) => s.setShowAiDrawer);

  return (
    <div className={styles.rail}>
      {/* No mode passed: this is the generic "summon the assistant" handle, so
          the drawer reopens on whatever tab was last used. The shortcut is
          shown in the tooltip only — mixing "AI 助手" with "· Ctrl+K" in the
          same vertical-rl string reorients the Latin runs sideways against
          the upright CJK ones, producing garbled-looking text. */}
      <button
        className={styles.handle}
        onClick={() => setShowAiDrawer(true)}
        title={`${t("titleBar.summonAi")} · ${MOD_K}`}
      >
        {t("titleBar.summonAi")}
      </button>
      <span className={styles.spacer} />
    </div>
  );
}
