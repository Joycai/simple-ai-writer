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
