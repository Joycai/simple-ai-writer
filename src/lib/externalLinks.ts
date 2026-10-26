import { openUrl } from "@tauri-apps/plugin-opener";

/** Keep external links from replacing the app, including dynamically rendered markdown. */
export function installExternalLinkNavigation(): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || (event.type === "auxclick" ? event.button !== 1 : event.button !== 0)) return;
    const anchor = (event.target as Element | null)?.closest?.("a[href]");
    const href = anchor?.getAttribute("href")?.trim();
    if (!href || !/^(https?:|mailto:|\/\/)/i.test(href)) return;
    // Cancel synchronously: even a failed OS open must never navigate the webview.
    event.preventDefault();
    const url = href.startsWith("//") ? `https:${href}` : href;
    void openUrl(url).catch((error: unknown) => {
      console.warn("[external-links] Could not open link:", error);
    });
  };
  document.addEventListener("click", onClick);
  document.addEventListener("auxclick", onClick);
  return () => {
    document.removeEventListener("click", onClick);
    document.removeEventListener("auxclick", onClick);
  };
}
