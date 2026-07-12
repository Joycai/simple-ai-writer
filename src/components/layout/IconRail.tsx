import { useTranslation } from "react-i18next";
import {
  FolderTree, ListTree, Search, LayoutGrid, GitBranch, Settings,
} from "lucide-react";
import { useAppStore, type SideTab, type MainView } from "../../stores/appStore";

import styles from "./IconRail.module.css";

interface Props {
  onOpenSettings: () => void;
}

interface SideItem {
  kind: "side";
  id: SideTab;
  icon: React.ReactNode;
  labelKey: string;
}
interface ViewItem {
  kind: "view";
  id: MainView;
  icon: React.ReactNode;
  labelKey: string;
}

const SIDE_ITEMS: SideItem[] = [
  { kind: "side", id: "files", icon: <FolderTree size={17} strokeWidth={1.5} />, labelKey: "sidebar.files" },
  { kind: "side", id: "outline", icon: <ListTree size={17} strokeWidth={1.5} />, labelKey: "sidebar.outline" },
  { kind: "side", id: "search", icon: <Search size={17} strokeWidth={1.5} />, labelKey: "sidebar.search" },
];

const VIEW_ITEMS: ViewItem[] = [
  { kind: "view", id: "lore-wall", icon: <LayoutGrid size={17} strokeWidth={1.5} />, labelKey: "sidebar.lore" },
  { kind: "view", id: "outline-full", icon: <GitBranch size={17} strokeWidth={1.5} />, labelKey: "sidebar.outlineFull" },
];

export function IconRail({ onOpenSettings }: Props) {
  const { t } = useTranslation();
  const {
    activeSideTab, setActiveSideTab,
    mainView, setMainView,
    sidebarCollapsed, setSidebarCollapsed,
    setShowCommandPalette,
  } = useAppStore();

  const handleSideClick = (id: SideTab) => {
    if (id === "search") {
      setShowCommandPalette(true);
      return;
    }
    if (mainView !== "editor") setMainView("editor");
    if (activeSideTab === id && !sidebarCollapsed) {
      setSidebarCollapsed(true);
    } else {
      setActiveSideTab(id);
      setSidebarCollapsed(false);
    }
  };

  const handleViewClick = (id: MainView) => {
    setMainView(mainView === id ? "editor" : id);
  };

  return (
    <div className={styles.rail}>
      {SIDE_ITEMS.map((it) => {
        const active = !sidebarCollapsed && mainView === "editor" && activeSideTab === it.id;
        return (
          <button
            key={it.id}
            className={`${styles.item} ${active ? styles.itemActive : ""}`}
            onClick={() => handleSideClick(it.id)}
            title={t(it.labelKey)}
          >
            {it.icon}
          </button>
        );
      })}

      <span className={styles.spacer} />

      {VIEW_ITEMS.map((it) => {
        const active = mainView === it.id;
        return (
          <button
            key={it.id}
            className={`${styles.item} ${active ? styles.itemActive : ""}`}
            onClick={() => handleViewClick(it.id)}
            title={t(it.labelKey)}
          >
            {it.icon}
          </button>
        );
      })}

      <button
        className={styles.item}
        onClick={onOpenSettings}
        title={t("sidebar.settings")}
      >
        <Settings size={17} strokeWidth={1.5} />
      </button>
    </div>
  );
}
