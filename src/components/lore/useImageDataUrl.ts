import { useEffect, useState } from "react";
import { imageToDataUrl, imageToThumbnailDataUrl } from "../../lib/fs/images";

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
      .catch((e) => { console.warn(`[useImageDataUrl] failed to read ${path}:`, e); });
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
        .catch((e) => {
          // Left out; the caller renders a placeholder — but that placeholder
          // then sits there forever with no visible cause, so at least this
          // makes the failure findable in devtools instead of purely silent.
          console.warn(`[useImageDataUrls] failed to read ${path}:`, e);
        });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return urls;
}

/**
 * Like {@link useImageDataUrls}, but every image is downscaled before it
 * reaches state or the DOM — see {@link imageToThumbnailDataUrl} for why a
 * full-resolution generated picture can silently fail to render as a small
 * thumbnail otherwise. Use this for any fixed-size preview grid (chat
 * pictures, galleries); reserve the full-resolution hooks for views where the
 * pixels themselves are being reviewed (an edit's source image, a lore cover).
 */
export function useImageThumbnails(paths: string[], maxDim = 320): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = paths.join("|");
  useEffect(() => {
    let cancelled = false;
    setUrls((prev) => {
      const wanted = new Set(paths);
      const kept = Object.keys(prev).filter((p) => wanted.has(p));
      if (kept.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(kept.map((p) => [p, prev[p]]));
    });
    for (const path of paths) {
      imageToThumbnailDataUrl(path, maxDim)
        .then((dataUrl) => {
          if (!cancelled) setUrls((prev) => (prev[path] ? prev : { ...prev, [path]: dataUrl }));
        })
        .catch((e) => {
          console.warn(`[useImageThumbnails] failed to read ${path}:`, e);
        });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, maxDim]);
  return urls;
}
