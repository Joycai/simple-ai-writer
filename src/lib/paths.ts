/**
 * Path helpers shared across layers — and the one place that knows how paths
 * differ between Windows and Linux/macOS.
 *
 * `resolveRelativePath` serves markdown link resolution; the containment pair
 * below is the project's single answer to "is this path allowed?" — used both
 * by the agent tools (where paths come from a model) and by the file-mutation
 * actions in stores/projectStore (where a move must not swallow its own
 * source). One implementation, so a fix reaches every caller.
 *
 * Everything here works on the **POSIX spelling** of a path: `/` separators,
 * no trailing slash, `.`/`..` collapsed. Paths enter the app in the host OS's
 * own spelling (Rust hands back `D:\书\第一章.md` on Windows and
 * `/home/me/书/第一章.md` elsewhere), so the two platform questions —
 * "does `\` separate segments?" and "does case matter?" — are answered once,
 * here, from the *shape of the path* rather than from the host. That keeps
 * these functions pure and lets one test file cover both worlds.
 */

// ─── Platform ────────────────────────────────────────────────────────────────

/**
 * Whether `\` separates segments in `p`, or is an ordinary character in a name.
 *
 * On Linux and macOS a backslash is perfectly legal *inside* a filename, so
 * splitting on it would invent directories that do not exist — and a POSIX
 * absolute path (`/…`, but not the `//server/share` of a UNC share) is the one
 * shape that says for certain we are looking at such a file. Everything else —
 * drive letters, UNC, and relative paths, which carry no shape at all — keeps
 * the Windows reading, because there a backslash is overwhelmingly a separator.
 */
function backslashSeparates(p: string): boolean {
  return !/^\/(?!\/)/.test(p);
}

/**
 * Whether `p` is a Windows path — a drive letter or a UNC share.
 *
 * Asked of the path rather than of the host: `D:\书` is a Windows path
 * whichever machine reads it. Only used to decide case-folding (see
 * {@link pathKey}), so a wrong answer costs correctness on a comparison, never
 * the location of a file.
 */
function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:[/\\]/.test(p) || /^[/\\]{2}/.test(p);
}

/**
 * The path with separators spelled `/` — the app's internal form.
 *
 * Nothing else about the path is touched: no `.`/`..` collapsing, no trailing
 * slash trimmed. {@link normalizePathSegments} is the one that does all three.
 */
export function toPosixPath(p: string): string {
  if (!backslashSeparates(p)) return p;
  const body = p.replace(/\\/g, "/");
  // A UNC share's two leading slashes are the host, not an empty segment.
  return /^[/\\]{2}/.test(p) ? `//${body.replace(/^\/+/, "")}` : body;
}

// ─── Containment ─────────────────────────────────────────────────────────────

/** Lexically resolve `.`/`..` segments, in the POSIX spelling. */
export function normalizePathSegments(p: string): string {
  const posix = toPosixPath(p);
  const root = posix.startsWith("//") ? "//" : posix.startsWith("/") ? "/" : "";
  const out: string[] = [];
  for (const part of posix.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop(); // no-op at root — `..` cannot climb above it
      continue;
    }
    out.push(part);
  }
  return root + out.join("/");
}

/**
 * The string two paths must share to be the same path — normalized, and
 * case-folded when the path is a Windows one.
 *
 * Case is the second thing that differs between the platforms, and getting it
 * wrong is silent both ways: `D:\Proj\A.md` and `d:\proj\a.md` are one file on
 * Windows, while `/proj/A.md` and `/proj/a.md` are genuinely two on Linux. Every
 * comparison in this module goes through here so they cannot drift apart —
 * which they had, `projectRelativePath` folding case where its neighbours did
 * not.
 */
export function pathKey(p: string): string {
  const norm = normalizePathSegments(p);
  return isWindowsPath(norm) ? norm.toLowerCase() : norm;
}

/**
 * True when `target` equals `base` or lives inside it, comparing normalized
 * paths on whole component boundaries (so `/project-evil` is NOT within
 * `/project`, and `/project/../etc` is rejected).
 */
export function isPathWithin(base: string, target: string): boolean {
  const b = pathKey(base);
  const t = pathKey(target);
  return t === b || t.startsWith(b + "/");
}

/**
 * True when `target` is strictly *inside* `base` — the check a move needs, so
 * that dragging a folder into its own subtree is refused instead of producing
 * an unreachable directory.
 */
export function isStrictDescendant(base: string, target: string): boolean {
  const b = pathKey(base);
  const t = pathKey(target);
  return t !== b && t.startsWith(b + "/");
}

/**
 * True when `target` touches the app's own data directory
 * (`<projectPath>/.ai-writer`, the directory itself included).
 *
 * An empty `projectPath` answers true — fail closed. `` `${""}/.ai-writer` ``
 * would otherwise make the base a relative path that matches nothing, and the
 * caller's "not protected" branch would wave the path through.
 */
export function isProtectedPath(projectPath: string, target: string): boolean {
  if (!projectPath) return true;
  return isPathWithin(`${projectPath}/.ai-writer`, target);
}

/**
 * The agent tools' single "may I touch this path?" answer: a non-empty
 * project, the path inside it, and not inside `.ai-writer/`.
 *
 * The empty-project guard is load-bearing, not belt-and-braces: the tools used
 * to scope to `${projectPath}/writing`, whose `/writing` suffix kept the base
 * non-empty by accident. With the base now the project root, an unset
 * `projectPath` would degrade `isPathWithin` into a match-everything prefix —
 * so the guard lives here, once, instead of in every tool handler.
 *
 * `.ai-writer` stays off-limits because the manuscript tools must not be a
 * back door into lore, memory, or profile.json — those have their own tools
 * with their own approval protocols (`propose_lore_plan` et al.).
 */
export function isWorkspacePath(projectPath: string, target: string): boolean {
  return (
    !!projectPath &&
    isPathWithin(projectPath, target) &&
    !isProtectedPath(projectPath, target)
  );
}

/**
 * The path a **model** named, turned into one the tools can use — or null when
 * it points somewhere they may not touch.
 *
 * A model does not reliably spell paths absolutely: the prompt's 【当前文件】
 * block carries a project-relative one, so the next thing it says is usually
 * relative too. Rebasing here means "卷一/第31章.md" and the absolute form of
 * the same file are one path, instead of one working file and one refusal that
 * reads as "outside the project" for a file plainly inside it.
 *
 * Absolute inputs come back normalized but unmoved, and `..` cannot climb out:
 * containment is still {@link isWorkspacePath}, applied after resolution.
 */
export function resolveWorkspacePath(projectPath: string, raw: string): string | null {
  if (!projectPath) return null;
  const abs = resolveRelativePath(projectPath, raw);
  return isWorkspacePath(projectPath, abs) ? abs : null;
}

/**
 * Whether two paths name the same file, separators and `.`/`..` aside.
 *
 * `===` is not enough once a path can arrive from the model: the same file is
 * `D:\proj\第1章.md` from the file tree and `D:/proj/第1章.md` after
 * {@link resolveWorkspacePath}, and a store that compares them raw would decide
 * the open document is a different file and write behind the editor's back.
 */
export function isSamePath(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  // Nullable on purpose: nearly every caller compares against an *open* file or
  // an *active* document, which is routinely absent. Taking the nulls here is
  // what keeps the call sites reading as the question they are asking.
  if (!a || !b) return false;
  return pathKey(a) === pathKey(b);
}

// ─── Segments ────────────────────────────────────────────────────────────────

/**
 * The last segment of a path — the file's or folder's own name.
 *
 * The repo grew a dozen copies of `p.split(/[\\/]/).pop()`, one of which
 * (`FileTree`'s project name) split on `/` only and so printed the whole path
 * on Windows. This is that expression, once, in a place that knows when a
 * backslash is a separator. Empty for an empty path or a bare root.
 */
export function baseName(p: string): string {
  const segs = toPosixPath(p).split("/");
  while (segs.length && segs[segs.length - 1] === "") segs.pop();
  return segs[segs.length - 1] ?? "";
}

/**
 * Everything before the last segment. `""` when there is no separator at all,
 * so a caller can tell "no parent" from "the root".
 */
export function dirName(p: string): string {
  const posix = toPosixPath(p).replace(/(?!^)\/+$/, "");
  const cut = posix.lastIndexOf("/");
  if (cut < 0) return "";
  return cut === 0 ? "/" : posix.slice(0, cut);
}

/**
 * Join path pieces with a single `/`, in the POSIX spelling.
 *
 * The app already joins with `/` by template literal in a hundred places and
 * that is fine — this is for the cases where a piece may arrive with the host's
 * separators or a trailing slash, and `<root>//<name>` would result.
 */
export function joinPath(...parts: string[]): string {
  const cleaned = parts
    .map((p, i) => (i === 0 ? toPosixPath(p).replace(/(?!^)\/+$/, "") : toPosixPath(p).replace(/^\/+|\/+$/g, "")))
    .filter((p, i) => i === 0 || p !== "");
  return cleaned.join("/");
}

/**
 * `absPath` as written from inside `projectPath`, or null when it is not in
 * there at all.
 *
 * The single answer to "strip the project prefix", which three call sites used
 * to give differently — `lib/context/memory` folding case, `agent/backup` and
 * the approval card not. Case now follows {@link pathKey}, so the answer is
 * right on both platforms instead of right on one.
 */
export function projectRelative(projectPath: string, absPath: string): string | null {
  if (!projectPath) return null;
  if (!isStrictDescendant(projectPath, absPath)) return null;
  // Sliced off the *normalized* path, so the result keeps the original
  // spelling of its segments — only the comparison was case-folded.
  const base = normalizePathSegments(projectPath);
  return normalizePathSegments(absPath).slice(base.endsWith("/") ? base.length : base.length + 1);
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
  return resolveRelativePath(baseDir, decodeLinkSegments(src));
}

/**
 * The decoding half of {@link resolveLinkPath}, for the callers that need the
 * candidate path rather than the resolved one — `read_image` tries the link
 * both as written and decoded, since a filename may legitimately contain a `%`.
 */
export function decodeLinkSegments(src: string): string {
  try {
    return src.split("/").map(decodeURIComponent).join("/");
  } catch {
    return src; // malformed escape — the raw form is the only candidate
  }
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
  const relN = toPosixPath(rel);

  const isAbsolute = /^[a-zA-Z]:\//.test(relN) || relN.startsWith("/");
  const combined = isAbsolute ? relN : `${toPosixPath(baseDir)}/${relN}`;

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
