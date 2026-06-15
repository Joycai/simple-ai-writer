import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import styles from "./RightPanel.module.css";

const TABS = [
  { id: "outline" as const, labelKey: "rightPanel.outline" },
  { id: "ai" as const, labelKey: "rightPanel.ai" },
  { id: "loreCards" as const, labelKey: "rightPanel.loreCards" },
];

export function RightPanel() {
  const { t } = useTranslation();
  const { rightPanelCollapsed, activeRightTab, setActiveRightTab } = useAppStore();

  return (
    <div className={`${styles.panel} ${rightPanelCollapsed ? styles.collapsed : ""}`}>
      <div className={styles.tabs}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`${styles.tab} ${activeRightTab === tab.id ? styles.active : ""}`}
            onClick={() => setActiveRightTab(tab.id)}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>
      <div className={styles.content}>
        {activeRightTab === "outline" && <span>Outline — coming in Phase 2</span>}
        {activeRightTab === "ai" && <span>AI Assistant — coming in Phase 5</span>}
        {activeRightTab === "loreCards" && <span>Lore Cards — coming in Phase 5</span>}
      </div>
    </div>
  );
}
