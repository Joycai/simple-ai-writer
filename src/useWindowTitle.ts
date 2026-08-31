/**
 * Keeps this window's name in step with the project it holds.
 *
 * Two things read that name and neither is inside the app: macOS's ⌘-Tab /
 * Mission Control / Dock, and the cross-process 「窗口」 menu every other
 * instance builds (`src-tauri/src/windowmenu.rs`) — which is the whole reason
 * a window needs a name at all, since without one every window in that list
 * reads "Simple AI Writer".
 *
 * The project, not the open file: a window *is* its workspace (that is what
 * multi-instance means here), and following the file would re-announce — an
 * IPC call and a menu rebuild in every sibling — on every tab switch, to say
 * something the author can already see in the title bar.
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { announceWindow } from "./lib/instance";
import { baseName } from "./lib/paths";
import { useProjectStore } from "./stores/projectStore";

export function useWindowTitle() {
  const projectPath = useProjectStore((s) => s.projectPath);
  const { t, i18n } = useTranslation();
  useEffect(() => {
    // `t` is re-read on a language switch: an empty window's label is the only
    // translated one, and the author changing language must move it.
    const name = (projectPath && baseName(projectPath)) || t("titleBar.noProject");
    void announceWindow(name, projectPath);
  }, [projectPath, t, i18n.language]);
}
