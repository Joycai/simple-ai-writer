/**
 * Re-reads the shared preference store when the window regains focus.
 *
 * Multi-instance support: every app process shares one `config.db`, but after
 * hydration each treats its in-memory cache as truth (see lib/prefs) — so a
 * theme switched, a model picked or a project opened in one window never
 * showed up in another until restart. Focus is the right trigger for the same
 * reason it is for the file tree (see useExternalFileRefresh): it is exactly
 * the moment the author arrives *from* the other window. Repaint only when
 * something actually changed — `reloadFromPrefs` runs an animated theme
 * transition, which a no-op focus must not fire.
 */
import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IS_TAURI } from "./lib/platform";
import { refreshPrefs } from "./lib/prefs";
import { useAppStore } from "./stores/appStore";

/** Same throttle as the tree's refresh: alt-tabbing back and forth fires the
 *  focus event repeatedly, and once per switch is plenty. */
const MIN_INTERVAL_MS = 1500;

export function usePrefsFocusSync() {
  useEffect(() => {
    if (!IS_TAURI) return;
    let last = 0;
    const unlistenPromise = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      const now = Date.now();
      if (now - last < MIN_INTERVAL_MS) return;
      last = now;
      void refreshPrefs().then((changed) => {
        if (changed) useAppStore.getState().reloadFromPrefs();
      });
    });
    return () => { void unlistenPromise.then((unlisten) => unlisten()); };
  }, []);
}
