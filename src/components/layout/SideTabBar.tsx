import { useTranslation } from "react-i18next";
import { FolderTree, BookOpen, Search } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import styles from "./SideTabBar.module.css";

const TABS = [
  { id: "files" as const, icon: <FolderTree size={20} strokeWidth={1.5} />, labelKey: "sidebar.files" },
  { id: "lore" as const, icon: <BookOpen size={20} strokeWidth={1.5} />, labelKey: "sidebar.lore" },
  { id: "search" as const, icon: <Search size={20} strokeWidth={1.5} />, labelKey: "sidebar.search" },
];

export function SideTabBar() {
  const { t } = useTranslation();
  const { activeSideTab, setActiveSideTab } = useAppStore();

  return (
    <div className={styles.tabBar}>
      {TABS.map((tab) => (
        <button
          key={tab.id}
          className={`${styles.tab} ${activeSideTab === tab.id ? styles.active : ""}`}
          onClick={() => setActiveSideTab(tab.id)}
          title={t(tab.labelKey)}
        >
          <span className={styles.tabIcon}>{tab.icon}</span>
          <span className={styles.tabLabel}>{t(tab.labelKey)}</span>
        </button>
      ))}
    </div>
  );
}
