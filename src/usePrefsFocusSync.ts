/**
 * Re-reads the shared preference store when the window regains focus.
 *
 * Multi-instance support: every app process shares one `config.db`, but after
 * hydration each treats its in-memory cache as truth (see lib/prefs) — so a
 * theme switched or a project opened in one window never showed up in another
 * until restart. Focus is the right trigger for the same reason it is for the
 * file tree (see useExternalFileRefresh): it is exactly the moment the author
 * arrives *from* the other window.
 *
 * Not everything is the other window's to change, though. `refreshPrefs`
 * declines to adopt the window-local keys at all (the assistant's tab, the
 * selected model, the panel widths — see `WINDOW_LOCAL_PREF_KEYS`) and reports
 * the keys that did move; passing that list on means a focus repaints only the
 * parts that moved. Both halves matter: without the first, the author's drawer
 * tab jumps to the other window's; without the second, *any* preference write
 * anywhere — another window merely opening a project — fires the animated
 * theme transition here for a theme that never changed.
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
        if (changed.length) useAppStore.getState().reloadFromPrefs(changed);
      });
    });
    return () => { void unlistenPromise.then((unlisten) => unlisten()); };
  }, []);
}
