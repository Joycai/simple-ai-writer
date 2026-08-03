/**
 * Flushes the manuscript editor's pending autosave before the window
 * actually closes.
 *
 * setContent's autosave is a trailing 2s debounce, reset on every keystroke
 * — nothing else waits for it. Without this, closing the window mid-typing
 * (no pause long enough for the timer to fire) loses everything since the
 * last save. Project switches already flush (see projectStore.openProject);
 * this is the other place content changes without the timer's cooperation.
 */
import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEditorStore } from "./stores/editorStore";

/** Same check http.ts uses — `pnpm dev` runs the plain Vite dev server with
 *  no Tauri window behind it, where getCurrentWindow() has nothing to bind to. */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function useWindowCloseFlush() {
  useEffect(() => {
    if (!inTauri) return;
    const win = getCurrentWindow();
    const unlistenPromise = win.onCloseRequested(async (event) => {
      const { saveTimer, isDirty } = useEditorStore.getState();
      if (!saveTimer && !isDirty) return; // nothing pending — let it close

      event.preventDefault();
      if (saveTimer) clearTimeout(saveTimer);
      try {
        await useEditorStore.getState().saveNow();
      } catch {
        // saveNow already logs and keeps isDirty true; closing anyway beats
        // trapping the author in a window they explicitly asked to close.
      }
      // destroy(), not close(): close() re-emits closeRequested, which would
      // just run this handler again — harmlessly (isDirty is now false), but
      // destroy() skips the round-trip and actually closes.
      await win.destroy();
    });
    return () => { void unlistenPromise.then((unlisten) => unlisten()); };
  }, []);
}
