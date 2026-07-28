import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import styles from "./AiRail.module.css";

export function AiRail() {
  const { t } = useTranslation();
  const setShowAiDrawer = useAppStore((s) => s.setShowAiDrawer);

  return (
    <div className={styles.rail}>
      {/* No mode passed: this is the generic "summon the assistant" handle, so
          the drawer reopens on whatever tab was last used. */}
      <button
        className={styles.handle}
        onClick={() => setShowAiDrawer(true)}
        title={t("titleBar.summonAi")}
      >
        {t("titleBar.summonAi")}
      </button>
      <span className={styles.spacer} />
    </div>
  );
}
