import { useEffect, useRef, useState } from "react";
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
  return useLoadedByPath(paths, "useImageDataUrls", null, (path) =>
    imageToDataUrl(path).then(({ dataUrl }) => dataUrl));
}

/**
 * What one change of the path list means for the map: which held entries
 * survive (every one still asked for) and which paths need a read (every one
 * asked for that is not held). Pure, so the rule is testable without a DOM.
 */
export function planImageReads(
  held: Record<string, string>,
  paths: string[],
): { kept: Record<string, string>; toLoad: string[] } {
  const wanted = new Set(paths);
  const kept: Record<string, string> = {};
  for (const [p, url] of Object.entries(held)) if (wanted.has(p)) kept[p] = url;
  // De-duplicated: a list naming one file twice must not read it twice.
  const toLoad = [...wanted].filter((p) => !kept[p]);
  return { kept, toLoad };
}

/**
 * The shared body of {@link useImageDataUrls} and {@link useImageThumbnails}:
 * a path → data URL map that reads **only the paths it does not hold yet**.
 *
 * It used to re-read every path whenever the list changed and throw the
 * result away on arrival if the map already had it. That is not a cache, it
 * is a delay: adding the 21st picture to a gallery read, decoded and
 * re-encoded all 21, and setting one avatar on the wall did the same for
 * every avatar on it. Deciding *before* the read is the whole fix.
 *
 * `variant` (the thumbnail size) is part of what a held entry means, so a
 * change of it empties the map — an entry encoded at another size is not the
 * one asked for.
 */
function useLoadedByPath(
  paths: string[],
  tag: string,
  variant: unknown,
  load: (path: string) => Promise<string>,
): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  // What the effect reads to decide what to skip. A ref rather than `urls` in
  // the dependency list, which would re-run the effect on every arrival.
  const held = useRef<{ urls: Record<string, string>; variant: unknown }>({ urls, variant });
  held.current.urls = urls;
  // Effects compare dependencies by identity, and callers build this array
  // inline on every render — join it so the reads re-run on real changes only.
  const key = paths.join("|");
  useEffect(() => {
    let cancelled = false;
    // Drop paths that are no longer asked for. Without this the map only ever
    // grew: four 2048×2048 candidates per round is tens of megabytes of base64
    // sitting in React state for as long as the component lives, copied whole
    // on every arrival.
    const prev = held.current.variant === variant ? held.current.urls : {};
    held.current.variant = variant;
    const { kept, toLoad } = planImageReads(prev, paths);
    if (Object.keys(kept).length !== Object.keys(held.current.urls).length) setUrls(kept);
    for (const path of toLoad) {
      load(path)
        .then((dataUrl) => {
          if (!cancelled) setUrls((now) => (now[path] ? now : { ...now, [path]: dataUrl }));
        })
        .catch((e) => {
          // Left out; the caller renders a placeholder — but that placeholder
          // then sits there forever with no visible cause, so at least this
          // makes the failure findable in devtools instead of purely silent.
          console.warn(`[${tag}] failed to read ${path}:`, e);
        });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, variant]);
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
  return useLoadedByPath(paths, "useImageThumbnails", maxDim, (path) =>
    imageToThumbnailDataUrl(path, maxDim));
}
