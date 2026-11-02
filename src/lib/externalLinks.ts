import { openUrl } from "@tauri-apps/plugin-opener";
import { isWorkspacePath, resolveLinkPath } from "./paths";

interface AssistantLinkNavigation {
  projectPath: () => string | null;
  openFile: (path: string) => void | Promise<void>;
}

/** Chat links are relative to the project, never the webview's URL. */
export function assistantLinkPath(projectPath: string | null, href: string): string | null {
  if (!projectPath) return null;
  let raw = href.split(/[?#]/, 1)[0];
  if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.hostname && url.hostname !== "localhost") return null;
      raw = url.pathname.replace(/^\/([a-z]:\/)/i, "$1");
    } catch { return null; }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^[a-z]:[/\\]/i.test(raw)) {
    return null;
  }
  if (!raw) return null;
  const path = resolveLinkPath(projectPath, raw);
  return isWorkspacePath(projectPath, path) ? path : null;
}

/** Keep external links from replacing the app, including dynamically rendered markdown. */
export function installExternalLinkNavigation(assistant?: AssistantLinkNavigation): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || (event.type === "auxclick" ? event.button !== 1 : event.button !== 0)) return;
    const anchor = (event.target as Element | null)?.closest?.("a[href]");
    const href = anchor?.getAttribute("href")?.trim();
    if (!href || href.startsWith("#")) return;
    const external = /^(https?:|mailto:|\/\/)/i.test(href);
    if (!external && !anchor?.closest("[data-ai-surface]")) return;
    // Cancel synchronously: even a failed OS open must never navigate the webview.
    event.preventDefault();
    const open = async () => {
      if (external) {
        await openUrl(href.startsWith("//") ? `https:${href}` : href);
      } else if (assistant) {
        const path = assistantLinkPath(assistant.projectPath(), href);
        if (path) await assistant.openFile(path);
      }
    };
    void open().catch((error: unknown) => {
      console.warn("[external-links] Could not open link:", error);
    });
  };
  // Assistant portals may stop bubbling; cancel their navigation before React
  // handlers run. Other surfaces retain their own link handlers.
  const onCapture = (event: MouseEvent) => {
    if ((event.target as Element | null)?.closest?.("[data-ai-surface]")) onClick(event);
  };
  document.addEventListener("click", onCapture, true);
  document.addEventListener("auxclick", onCapture, true);
  document.addEventListener("click", onClick);
  document.addEventListener("auxclick", onClick);
  return () => {
    document.removeEventListener("click", onCapture, true);
    document.removeEventListener("auxclick", onCapture, true);
    document.removeEventListener("click", onClick);
    document.removeEventListener("auxclick", onClick);
  };
}
