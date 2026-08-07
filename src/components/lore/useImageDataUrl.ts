import { useEffect, useState } from "react";
import { imageToDataUrl } from "../../lib/fs/images";

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

/**
 * The same, for a set of paths — returns a path → data URL map, filling in as
 * each read lands so a slow file doesn't hold up the others.
 *
 * Keyed by path rather than index so a re-render with a reordered list keeps
 * showing the right picture for each entry.
 */
export function useImageDataUrls(paths: string[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  // Effects compare dependencies by identity, and callers build this array
  // inline on every render — join it so the reads re-run on real changes only.
  const key = paths.join("|");
  useEffect(() => {
    let cancelled = false;
    // Drop paths that are no longer asked for. Without this the map only ever
    // grew: four 2048×2048 candidates per round is tens of megabytes of base64
    // sitting in React state for as long as the component lives, copied whole
    // on every arrival.
    setUrls((prev) => {
      const wanted = new Set(paths);
      const kept = Object.keys(prev).filter((p) => wanted.has(p));
      if (kept.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(kept.map((p) => [p, prev[p]]));
    });
    for (const path of paths) {
      imageToDataUrl(path)
        .then(({ dataUrl }) => {
          if (!cancelled) setUrls((prev) => (prev[path] ? prev : { ...prev, [path]: dataUrl }));
        })
        .catch(() => { /* leave it out; the caller renders a placeholder */ });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return urls;
}
