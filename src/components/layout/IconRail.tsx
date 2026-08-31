import { useTranslation } from "react-i18next";
import {
  FolderTree, ListTree, Search, LayoutGrid, Library, Settings,
} from "lucide-react";
import { useAppStore, viewNeedsProject, type SideTab, type MainView } from "../../stores/appStore";
import { useDocModel, useMainView, useProjectStore, useTerms } from "../../stores/projectStore";
import { useLoreStore } from "../../stores/loreStore";
import { useSyncStore } from "../../stores/syncStore";
import { loreEntityCount } from "../../lib/lore";
import { comboLabel } from "../../lib/shortcuts";

import styles from "./IconRail.module.css";

interface Props {
  onOpenSettings: () => void;
}

interface SideItem {
  kind: "side";
  id: SideTab;
  icon: React.ReactNode;
  labelKey: string;
  /** Shown after the label in the tooltip — where else would the author find it? */
  keys: string;
}
interface ViewItem {
  kind: "view";
  id: MainView;
  icon: React.ReactNode;
  labelKey: string;
  keys: string;
}

/** Tooltip text for one rail button: "大纲 ⌘2". */
function railTitle(label: string, keys: string): string {
  return `${label}  ${keys}`;
}

const SIDE_ITEMS: SideItem[] = [
  { kind: "side", id: "files", icon: <FolderTree size={17} strokeWidth={1.5} />, labelKey: "sidebar.files", keys: comboLabel({ mod: true, key: "1" }) },
  { kind: "side", id: "outline", icon: <ListTree size={17} strokeWidth={1.5} />, labelKey: "sidebar.outline", keys: comboLabel({ mod: true, key: "2" }) },
  // Search *is* the command palette (see handleSideClick), so it shows the
  // palette's own binding rather than a screen digit it doesn't have.
  { kind: "side", id: "search", icon: <Search size={17} strokeWidth={1.5} />, labelKey: "sidebar.search", keys: comboLabel({ mod: true, key: "k" }) },
];

const VIEW_ITEMS: ViewItem[] = [
  { kind: "view", id: "lore-wall", icon: <LayoutGrid size={17} strokeWidth={1.5} />, labelKey: "sidebar.lore", keys: comboLabel({ mod: true, key: "3" }) },
  { kind: "view", id: "library", icon: <Library size={17} strokeWidth={1.5} />, labelKey: "sidebar.library", keys: comboLabel({ mod: true, key: "4" }) },
];

/**
 * The library view arranges the book spine (volumes and chapter order), so it
 * only means anything where the documents *have* an order — see
 * DocModel.ordered.
 *
 * The `outline` side tab is NOT gated: it lists the headings inside the
 * current document, which a standalone piece of copy has just as much as a
 * chapter does.
 */
function visibleViewItems(ordered: boolean): ViewItem[] {
  return ordered ? VIEW_ITEMS : VIEW_ITEMS.filter((it) => it.id !== "library");
}

export function IconRail({ onOpenSettings }: Props) {
  const { t } = useTranslation();
  const { ordered } = useDocModel();
  const terms = useTerms();
  // The two view buttons are project data (see viewNeedsProject): before a
  // folder is open they stay on the rail — so the app still says it has a
  // knowledge base — but inert, with the tooltip saying what unlocks them.
  const projectOpen = useProjectStore((s) => s.projectPath !== null);
  const {
    activeSideTab, setActiveSideTab,
    setMainView,
    sidebarCollapsed, setSidebarCollapsed,
    setShowCommandPalette,
  } = useAppStore();
  // The *effective* view, matching what App renders — highlighting off the raw
  // stored value would leave the sidebar showing with no rail icon lit.
  const mainView = useMainView();
  // 设计稿 01: the knowledge-base icon carries an entity-count badge.
  const loreCount = useLoreStore((s) => loreEntityCount(s.index));
  // 设计稿 14 屏 1k:同步只在「两边都有改动」时才配得上写作时的余光——
  // 一枚 5px 点,其余四档什么都不画。点开知识库墙,状态件在那里说全。
  const syncAttention = useSyncStore((s) => s.freshness?.verdict === "diverged");

  const handleSideClick = (id: SideTab) => {
    if (id === "search") {
      setShowCommandPalette(true);
      return;
    }
    // Returning from a non-editor main view (lore wall, library) should
    // just bring the editor back with whatever sidebar state was left behind
    // — not fold it into the toggle below, which would collapse a panel the
    // user never asked to close.
    if (mainView !== "editor") {
      setMainView("editor");
      setActiveSideTab(id);
      return;
    }
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
            title={railTitle(t(it.labelKey), it.keys)}
          >
            {it.icon}
          </button>
        );
      })}

      <span className={styles.spacer} />

      {visibleViewItems(ordered).map((it) => {
        const active = mainView === it.id;
        const gated = !projectOpen && viewNeedsProject(it.id);
        const label = it.id === "lore-wall" ? terms.kb : t(it.labelKey);
        return (
          <button
            key={it.id}
            className={`${styles.item} ${active ? styles.itemActive : ""}`}
            disabled={gated}
            onClick={() => handleViewClick(it.id)}
            // No key hint while gated: ⌘3 / ⌘4 are gated too, and offering a
            // shortcut for a button that does nothing is the wrong promise.
            title={gated ? `${label} · ${t("sidebar.needsProject")}` : railTitle(label, it.keys)}
          >
            {it.icon}
            {/* Both marks report on the open project — a count and a sync
                verdict left over from the last one would be reporting on a
                knowledge base that isn't loaded. */}
            {!gated && it.id === "lore-wall" && loreCount > 0 && (
              <span className={styles.badge}>{loreCount}</span>
            )}
            {!gated && it.id === "lore-wall" && syncAttention && <span className={styles.syncDot} />}
          </button>
        );
      })}

      <button
        className={styles.item}
        onClick={onOpenSettings}
        title={railTitle(t("sidebar.settings"), comboLabel({ mod: true, key: "," }))}
      >
        <Settings size={17} strokeWidth={1.5} />
      </button>
    </div>
  );
}
