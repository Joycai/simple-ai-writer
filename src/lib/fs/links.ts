/**
 * Which documents link to a file — the one fact a deletion card can only
 * establish *before* the deletion (设计稿 02h 1c).
 *
 * Everything else on that card can be recovered afterwards: the text is in the
 * backup, the size is on the backup, the name is in the log. What cannot be
 * recovered is the sentence 「被 2 个文档引用」, because after the file is gone
 * those two links are just broken and nobody knows they were ever whole.
 *
 * Only real links count — a markdown `](path)` or a `[[wiki]]` — not bare
 * mentions of the name. A card that says 「被 12 个文档引用」 because the file is
 * called `序.md` and the word 序 appears in a dozen chapters has taught the
 * author to stop reading the line.
 */

import { readDirRecursive, type FileNode } from "../project";
import { isChapterFile } from "../context/outline";
import { readFile } from "./fileio";
import { baseName, dirName, joinPath, projectRelative, toPosixPath } from "../paths";

/**
 * Documents scanned before the answer is given up on.
 *
 * A backlink scan reads the workspace, and a deletion is rare enough to pay for
 * that. It is not, however, worth an unbounded wait on a project someone has
 * pasted a library into — past this the card says nothing rather than guessing,
 * which is what {@link Backlinks.complete} is for.
 */
export const BACKLINK_MAX_FILES = 600;

export interface Backlinks {
  /** Target path (as given) → the documents that link to it, project-relative. */
  byTarget: Map<string, string[]>;
  /** False when the scan hit its cap: the answer is a floor, not a total. */
  complete: boolean;
}

/**
 * Find every document that links to any of `targets`.
 *
 * One pass for the whole set, because a folder deletion asks the question about
 * a dozen files at once and reading the workspace once per file is how a
 * deletion card starts taking seconds.
 */
export async function backlinksOf(
  projectPath: string,
  targets: readonly string[],
): Promise<Backlinks> {
  const byTarget = new Map<string, string[]>();
  for (const target of targets) byTarget.set(target, []);
  if (targets.length === 0) return { byTarget, complete: true };

  // Keyed by the normalised absolute path so a link written as `../废稿/x.md`
  // and one written as `废稿/x.md` land on the same entry.
  const wanted = new Map<string, string>();
  for (const target of targets) wanted.set(toPosixPath(target).toLowerCase(), target);

  let files: string[] = [];
  try {
    files = documentsIn(await readDirRecursive(projectPath));
  } catch {
    return { byTarget, complete: false };
  }

  const complete = files.length <= BACKLINK_MAX_FILES;
  for (const file of files.slice(0, BACKLINK_MAX_FILES)) {
    if (wanted.has(toPosixPath(file).toLowerCase())) continue; // a file's own links to itself
    let text: string;
    try {
      text = await readFile(file);
    } catch {
      continue;
    }
    const from = projectRelative(projectPath, file) || baseName(file);
    for (const link of linkTargets(text)) {
      const resolved = resolveLink(dirName(file), link);
      const hit = resolved && wanted.get(resolved.toLowerCase());
      if (hit) {
        const list = byTarget.get(hit)!;
        if (!list.includes(from)) list.push(from);
      }
    }
  }

  return { byTarget, complete };
}

/** Text documents only — a picture cannot link to anything. */
function documentsIn(nodes: readonly FileNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.is_dir) out.push(...documentsIn(node.children ?? []));
    else if (isChapterFile(node.name)) out.push(node.path);
  }
  return out;
}

const MARKDOWN_LINK = /\]\(\s*<?([^)>\s]+)>?\s*(?:"[^"]*")?\s*\)/g;
const WIKI_LINK = /\[\[([^\]|#]+)/g;

/** Every path a document points at. */
function linkTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MARKDOWN_LINK)) out.push(m[1]);
  for (const m of text.matchAll(WIKI_LINK)) {
    // `[[lore:角色/莉安]]` is a knowledge-base citation, not a file link.
    if (!m[1].startsWith("lore:")) out.push(m[1].trim());
  }
  return out;
}

/** A link's absolute path, or null when it points outside the filesystem. */
function resolveLink(fromDir: string, link: string): string | null {
  const raw = link.split("#")[0].trim();
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null; // http:, mailto:, data:
  let decoded = raw;
  try {
    decoded = decodeURI(raw);
  } catch {
    // A malformed escape is not a link worth resolving.
  }
  const posix = toPosixPath(decoded);
  if (posix.startsWith("/")) return posix;

  const parts = posix.split("/");
  let dir = fromDir;
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === "." || parts[i] === "") continue;
    dir = parts[i] === ".." ? dirName(dir) : joinPath(dir, parts[i]);
  }
  const last = parts[parts.length - 1];
  return last === "" ? dir : joinPath(dir, last);
}
