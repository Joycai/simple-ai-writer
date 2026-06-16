import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { useEditorStore } from "../../stores/editorStore";
import { OutlinePanel } from "../editor/OutlinePanel";
import { AiPanel } from "../ai/AiPanel";
import styles from "./RightPanel.module.css";

const TABS = [
  { id: "outline" as const, labelKey: "rightPanel.outline" },
  { id: "ai" as const, labelKey: "rightPanel.ai" },
];

export function RightPanel() {
  const { t } = useTranslation();
  const { rightPanelCollapsed, activeRightTab, setActiveRightTab } = useAppStore();
  const { headings } = useEditorStore();

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
        {activeRightTab === "outline" && (
          <OutlinePanel headings={headings} />
        )}
        {activeRightTab === "ai" && <AiPanel />}
      </div>
    </div>
  );
}
