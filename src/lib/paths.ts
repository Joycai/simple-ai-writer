/**
 * Path helpers shared across layers.
 *
 * `resolveRelativePath` serves markdown link resolution; the containment pair
 * below is the project's single answer to "is this path allowed?" — used both
 * by the agent tools (where paths come from a model) and by the file-mutation
 * actions in stores/projectStore (where a move must not swallow its own
 * source). One implementation, so a fix reaches every caller.
 */

// ─── Containment ─────────────────────────────────────────────────────────────

/** Lexically resolve `.`/`..` segments (both `/` and `\` separators). */
export function normalizePathSegments(p: string): string {
  const isAbsolute = /^[/\\]/.test(p);
  const out: string[] = [];
  for (const part of p.split(/[/\\]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop(); // no-op at root — `..` cannot climb above it
      continue;
    }
    out.push(part);
  }
  return (isAbsolute ? "/" : "") + out.join("/");
}

/**
 * True when `target` equals `base` or lives inside it, comparing normalized
 * paths on whole component boundaries (so `/project-evil` is NOT within
 * `/project`, and `/project/../etc` is rejected).
 */
export function isPathWithin(base: string, target: string): boolean {
  const b = normalizePathSegments(base);
  const t = normalizePathSegments(target);
  return t === b || t.startsWith(b + "/");
}

/**
 * True when `target` is strictly *inside* `base` — the check a move needs, so
 * that dragging a folder into its own subtree is refused instead of producing
 * an unreachable directory.
 */
export function isStrictDescendant(base: string, target: string): boolean {
  const b = normalizePathSegments(base);
  const t = normalizePathSegments(target);
  return t !== b && t.startsWith(b + "/");
}

// ─── Relative resolution ─────────────────────────────────────────────────────

/**
 * Resolve a possibly-relative resource path against a base directory.
 *
 * Normalizes `/` and `\` separators and collapses `.` / `..` segments so that
 * links written relative to a markdown file (e.g. `../ext_images/foo.png`) map
 * to a real absolute path. Inputs that are already absolute — drive-letter
 * (`C:/…`) or POSIX-root (`/…`) — are returned normalized without rebasing.
 */
/**
 * Resolve a **markdown link's** `src` against the document's folder.
 *
 * `resolveRelativePath` plus the percent-decoding every such link carries:
 * `imageMarkdown` (lib/image/assets) encodes each segment on the way out, so
 * what comes back is `assets/%E7%AC%AC%E4%B8%89%E7%AB%A0/…` and the filesystem
 * wants the characters.
 *
 * Decoding **per segment with `decodeURIComponent`**, never `decodeURI`: by
 * definition that one leaves the escapes of reserved characters alone, so a
 * document titled "第1章 & 终局" resolved to a path containing a literal `%26`
 * and every illustration in it silently vanished. This lives here, in one
 * place, because that rule was worth getting wrong only once — the preview
 * pane and the exporter both need it and had drifted apart on it.
 */
export function resolveLinkPath(baseDir: string, src: string): string {
  let rel = src;
  try {
    rel = src.split("/").map(decodeURIComponent).join("/");
  } catch { /* keep raw on a malformed escape */ }
  return resolveRelativePath(baseDir, rel);
}

/**
 * The path of `target` as written from inside `baseDir` — the inverse of
 * {@link resolveRelativePath}, for turning a file the author picked in the
 * project tree into the link a markdown document can carry.
 *
 * Relative because that is what makes an illustration survive: the project
 * folder gets moved, synced and opened on another machine, and an absolute
 * link breaks on all three.
 *
 * Falls back to the absolute target when the two share no root at all (two
 * Windows drive letters) — there is no relative path to write, and a link that
 * works on this machine beats one that works nowhere.
 */
export function relativePathFrom(baseDir: string, target: string): string {
  const normalizedTarget = normalizePathSegments(target);
  const from = normalizePathSegments(baseDir).split("/").filter(Boolean);
  const to = normalizedTarget.split("/").filter(Boolean);

  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  if (common === 0) return normalizedTarget;

  const up = Array.from({ length: from.length - common }, () => "..");
  return [...up, ...to.slice(common)].join("/");
}

export function resolveRelativePath(baseDir: string, rel: string): string {
  const norm = (s: string) => s.replace(/\\/g, "/");
  const relN = norm(rel);

  const isAbsolute = /^[a-zA-Z]:\//.test(relN) || relN.startsWith("/");
  const combined = isAbsolute ? relN : `${norm(baseDir)}/${relN}`;

  const out: string[] = [];
  combined.split("/").forEach((seg, i) => {
    if (seg === "") {
      if (i === 0) out.push(""); // preserve a leading POSIX root
      return;
    }
    if (seg === ".") return;
    if (seg === "..") {
      const top = out[out.length - 1];
      if (out.length && top !== "" && top !== "..") out.pop();
      else out.push("..");
      return;
    }
    out.push(seg);
  });

  return out.join("/");
}
