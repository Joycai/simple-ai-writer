import { useTranslation } from "react-i18next";
import {
  FolderTree, ListTree, Search, LayoutGrid, GitBranch, Settings,
} from "lucide-react";
import { useAppStore, type SideTab, type MainView } from "../../stores/appStore";
import { useDocModel, useMainView } from "../../stores/projectStore";

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

/**
 * The full outline view arranges the book spine (volumes and chapter order), so
 * it only means anything where the documents *have* an order — see
 * DocModel.ordered.
 *
 * The `outline` side tab is deliberately NOT gated: despite the shared name it
 * lists the headings inside the current document, which a standalone piece of
 * copy has just as much as a chapter does.
 */
function visibleViewItems(ordered: boolean): ViewItem[] {
  return ordered ? VIEW_ITEMS : VIEW_ITEMS.filter((it) => it.id !== "outline-full");
}

export function IconRail({ onOpenSettings }: Props) {
  const { t } = useTranslation();
  const { ordered } = useDocModel();
  const {
    activeSideTab, setActiveSideTab,
    setMainView,
    sidebarCollapsed, setSidebarCollapsed,
    setShowCommandPalette,
  } = useAppStore();
  // The *effective* view, matching what App renders — highlighting off the raw
  // stored value would leave the sidebar showing with no rail icon lit.
  const mainView = useMainView();

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

      {visibleViewItems(ordered).map((it) => {
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
