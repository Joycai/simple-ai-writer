import { useEffect, useState } from "react";
import { imageToDataUrl } from "../../lib/loreGenerator";

/**
 * Load a local image file as a base64 data URL for <img> rendering.
 * Bypasses the `ai-writer-asset://` custom protocol — Webview2's strict URL
 * parsing on Windows drive-letter paths makes that protocol unreliable, so
 * every avatar/gallery consumer renders data URLs instead.
 * Returns null while loading, on failure, or when `path` is empty.
 *
 * `refreshKey`: bump to force a re-read when the file changed on disk but its
 * path did not (e.g. replacing avatar.png with a new image of the same name).
 */
export function useImageDataUrl(path: string | null | undefined, refreshKey?: unknown): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    if (!path) return;
    imageToDataUrl(path)
      .then(({ dataUrl }) => { if (!cancelled) setUrl(dataUrl); })
      .catch(() => { /* fall back to placeholder */ });
    return () => { cancelled = true; };
  }, [path, refreshKey]);
  return url;
}
