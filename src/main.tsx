import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/fonts";
import "./i18n";
import App from "./App";
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
