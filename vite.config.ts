import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Pre-bundle every heavy dependency up front — including the LAZILY imported
  // ones (mermaid, the agent/lore modules pull several of these dynamically).
  // Without this, vite discovers them mid-session, logs "new dependencies
  // optimized: reloading page" and force-reloads — which on a cold transform
  // cache looks like the window suddenly going blank for ~20s.
  optimizeDeps: {
    include: [
      "react",
      "react-dom/client",
      "zustand",
      "i18next",
      "react-i18next",
      "motion/react",
      "lucide-react",
      "nanoid",
      "gray-matter",
      "markdown-it",
      "markdown-it-katex",
      "mermaid",
      "codemirror",
      "@codemirror/commands",
      "@codemirror/lang-markdown",
      "@codemirror/language",
      "@codemirror/language-data",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
      "@lezer/highlight",
      "@tauri-apps/api/app",
      "@tauri-apps/api/core",
      "@tauri-apps/api/path",
      "@tauri-apps/plugin-dialog",
      "@tauri-apps/plugin-fs",
      "@tauri-apps/plugin-http",
      "@tauri-apps/plugin-opener",
      "@tauri-apps/plugin-sql",
    ],
  },

  build: {
    // This app is packaged and served from local disk by Tauri, not downloaded
    // over a network, so Vite's web-oriented 500 kB chunk warning doesn't apply.
    // The genuinely heavy libs (mermaid + its diagram/cytoscape deps, katex,
    // CodeMirror language modes) are already code-split into lazy chunks that
    // only load on demand — e.g. mermaid loads only when a preview actually
    // renders a diagram (see components/editor/Preview.tsx). Raise the limit so
    // the false alarm doesn't clutter the build log.
    chunkSizeWarningLimit: 1600,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // Pin to IPv4 loopback: with `false`/"localhost", newer Node on macOS
    // resolves localhost to ::1 and vite binds ONLY IPv6 — the Tauri window
    // then shows blank because http://127.0.0.1:1420 refuses connections
    // (and system proxies make `localhost` flaky in WKWebView). devUrl in
    // tauri.conf.json points at 127.0.0.1 to match.
    host: host || "127.0.0.1",
    // Transform the whole entry graph as soon as the server starts instead of
    // waiting for the webview's first request wave — cuts the cold-start blank.
    warmup: { clientFiles: ["./src/main.tsx"] },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
