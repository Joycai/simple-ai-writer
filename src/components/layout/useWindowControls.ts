/**
 * Window-chrome state for the custom titlebar (方案 B, hybrid):
 *
 * - macOS keeps the **native** traffic lights, floating over our TitleBar via
 *   `titleBarStyle: "Overlay"` + `hiddenTitle: true` (tauri.conf.json) — the
 *   bar only reserves blank space for them (`macInset`), collapsed in
 *   fullscreen where the system hides the buttons.
 * - Windows drops the OS chrome entirely (`decorations: false` in
 *   tauri.windows.conf.json) and the bar renders its own caption buttons
 *   (`showCaptionButtons`): minimize / maximize-restore / close.
 *
 * `close()` goes through `window.close()` on purpose: it emits
 * `closeRequested`, so useWindowCloseFlush still gets to flush the pending
 * autosave before the window actually goes away — identical to the OS ✕.
 *
 * In the plain browser (`pnpm dev` without Tauri) everything is inert and the
 * TitleBar falls back to its decorative traffic dots.
 */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IS_MAC, IS_TAURI } from "../../lib/platform";

export function useWindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Default true = render no caption buttons until we know the chrome is
  // really gone. Keeps a decorated window (e.g. Linux, where the base config
  // leaves decorations on) from showing a second set of buttons.
  const [isDecorated, setIsDecorated] = useState(true);

  useEffect(() => {
    if (!IS_TAURI) return;
    const win = getCurrentWindow();
    let disposed = false;

    const sync = async () => {
      try {
        const [max, fs] = await Promise.all([win.isMaximized(), win.isFullscreen()]);
        if (!disposed) {
          setIsMaximized(max);
          setIsFullscreen(fs);
        }
      } catch (e) {
        // Missing capability — leave the defaults; buttons still work.
        console.warn("[windowControls] state query failed", e);
      }
    };

    void win
      .isDecorated()
      .then((d) => {
        if (!disposed) setIsDecorated(d);
      })
      .catch(() => setIsDecorated(false));
    void sync();
    // Covers maximize/restore AND macOS fullscreen transitions — both resize.
    const unlistenPromise = win.onResized(() => void sync());

    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  return {
    /** Reserve room on the left for the native macOS traffic lights. */
    macInset: IS_TAURI && IS_MAC && !isFullscreen,
    /** Render our own minimize/maximize/close (undecorated Windows). */
    showCaptionButtons: IS_TAURI && !IS_MAC && !isDecorated,
    isMaximized,
    minimize: () => void getCurrentWindow().minimize(),
    toggleMaximize: () => void getCurrentWindow().toggleMaximize(),
    close: () => void getCurrentWindow().close(),
  };
}
