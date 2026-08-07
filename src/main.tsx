import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/fonts";
import { hydratePrefs } from "./lib/prefs";
import { installMarkdownThemeStyles } from "./lib/theme/markdownThemes";

// Markdown typography themes are generated (the same generator feeds exported
// HTML), so they arrive as one injected stylesheet rather than a .css import.
installMarkdownThemeStyles();

// Desktop app: suppress the webview's browser context menu everywhere except
// editable surfaces (inputs, textareas, CodeMirror's contenteditable), where
// the native copy/paste menu is still useful. Components that want their own
// menu (e.g. FileTree) handle onContextMenu themselves.
window.addEventListener("contextmenu", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (el?.closest("input, textarea, [contenteditable='true'], [contenteditable='']")) return;
  e.preventDefault();
});

/**
 * Preferences have to be in memory before anything reads one, and the two
 * biggest readers do it as they initialize: i18n takes its language at module
 * init, and `appStore` computes theme, fonts and panel widths at module scope.
 * Both are synchronous and the store behind them is not (see lib/prefs), so
 * everything downstream of a preference is imported *after* hydration rather
 * than alongside it. `index.html`'s splash covers the gap.
 *
 * An async function rather than top-level await: the entry module then stays
 * an ordinary one, which keeps this independent of what the packaged webview
 * makes of an async entry chunk. `hydratePrefs` resolves even when it fails —
 * the app falls back to the previous storage rather than refusing to start —
 * but it is guarded anyway, because nothing here is worth a blank window.
 */
async function boot() {
  try {
    await hydratePrefs();
  } catch (e) {
    console.warn("[boot] preferences unavailable; continuing with defaults:", e);
  }

  await import("./i18n");
  const [{ default: App }, { AppErrorBoundary }] = await Promise.all([
    import("./App"),
    import("./components/common/ErrorBoundary"),
  ]);

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {/* Outermost boundary: a render error anywhere below here shows a recovery
          panel instead of unmounting the tree to a blank window. */}
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </React.StrictMode>,
  );
}

void boot();
