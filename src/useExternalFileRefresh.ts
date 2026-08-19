/**
 * Re-reads the project tree when the window regains focus.
 *
 * The tree is a snapshot taken when the project opened and re-taken after
 * every change the *app* makes. Changes made outside it — a file dropped into
 * the folder from Finder/Explorer, a document edited by another tool — had no
 * signal at all: the sidebar's 刷新 button was the only way back in sync, and
 * anything derived from the tree (the `@` picker's file candidates) was stale
 * with nothing on screen saying so.
 *
 * Focus is the right trigger because it is exactly the shape of the problem:
 * the author left for the file manager and came back. No watcher, no polling —
 * a directory watch over an arbitrary project folder is a permission surface
 * and a stream of events the UI would have to debounce anyway.
 */
import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IS_TAURI } from "./lib/platform";
import { useProjectStore } from "./stores/projectStore";

/**
 * Shortest gap between two focus-driven refreshes. Alt-tabbing back and forth
 * fires the event repeatedly, and each refresh is a recursive directory read
 * of the whole project — one per switch is plenty.
 */
const MIN_INTERVAL_MS = 1500;

export function useExternalFileRefresh() {
  useEffect(() => {
    if (!IS_TAURI) return;
    let last = 0;
    const unlistenPromise = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      const now = Date.now();
      if (now - last < MIN_INTERVAL_MS) return;
      last = now;
      const { projectPath, refreshFileTree } = useProjectStore.getState();
      if (!projectPath) return;
      // Best-effort: a failed read leaves the previous tree in place (see
      // refreshFileTree) and the author still has the 刷新 button.
      void refreshFileTree();
    });
    return () => { void unlistenPromise.then((unlisten) => unlisten()); };
  }, []);
}
