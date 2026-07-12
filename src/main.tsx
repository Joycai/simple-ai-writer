import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import App from "./App";

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
