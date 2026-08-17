/**
 * Book spine ("大纲书脊") — the authoritative chapter *order* that the outline
 * view lets the author arrange and that the continuation/memory system reads to
 * know "what came before this chapter".
 *
 * The order is an *overlay*, not a rigid list: `.ai-writer/outline.json` records
 * a per-volume ordering of chapter paths, but the filesystem stays the source of
 * truth for existence. Files present on disk but missing from the manifest are
 * appended in natural (numeric-aware) order; manifest entries whose file is gone
 * are dropped. So creating/deleting a chapter outside the outline UI never
 * breaks the ordering — new files just land at the end in a sensible spot.
 *
 * A "volume" is a book: top-level chapter files in the workspace root form a
 * default volume (relPath `""`), and each folder — at any depth — is its own
 * volume holding its direct chapter files. Continuation memory is resolved
 * strictly within the active chapter's volume (see ./bookContext).
 */

import { readFile, writeFile, makeDir, fileExists } from "../fs/fileio";
import { ASSETS_DIR } from "../image/assets";
import { projectRelativePath } from "./memory";
import type { FileNode } from "../project";

export interface Chapter {
  /** File basename (display). */
  name: string;
  /** Absolute path — matches fileTree nodes and activeFilePath. */
  path: string;
  /** Project-relative path, forward slashes — the spine + memory key. */
  relPath: string;
}

/**
 * A non-chapter file living in a volume's folder (image, PDF, spreadsheet…).
 * Purely a display-layer concept for the library view: resources never enter
 * the spine, bookContext, or any AI context assembly.
 */
export interface ResourceFile {
  /** File basename (display). */
  name: string;
  /** Absolute path — matches fileTree nodes and activeFilePath. */
  path: string;
  /** Project-relative path, forward slashes. */
  relPath: string;
}

export interface Volume {
  name: string;
  /** Absolute folder path. */
  path: string;
  /** Project-relative folder path (forward slashes) — the spine key. */
  relPath: string;
  chapters: Chapter[];
  /** Direct non-chapter files of this folder, natural-sorted. */
  resources: ResourceFile[];
}

/** Author-set chapter status (only "writing" for now; absence means done). */
export type ChapterStatus = "writing";

export interface BookSpine {
  version: 1;
  /** volume relPath → ordered chapter relPaths. */
  order: Record<string, string[]>;
  /** chapter relPath → status; absent entries are treated as done. */
  status?: Record<string, ChapterStatus>;
}

const CHAPTER_EXTS = ["md", "markdown", "txt"];

/** Manuscript files count as chapters; images / other files don't. */
export function isChapterFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return CHAPTER_EXTS.includes(ext);
}

/**
 * A chapter filename as it should land on disk. A name the author (or the
 * agent) typed without an extension gets `.md` — an extensionless file would
 * not be recognised as a chapter by `isChapterFile` and would silently vanish
 * from the outline.
 */
export function normalizeChapterFileName(name: string): string {
  const trimmed = name.trim();
  return trimmed.includes(".") ? trimmed : `${trimmed}.md`;
}

/** Strip a chapter file's extension for display / labeling. */
export function chapterTitle(ch: Chapter): string {
  return ch.name.replace(/\.(md|markdown|txt)$/i, "");
}

/** Numeric-aware comparison so 第2章 < 第10章 and 6-1 < 6-2 < 7. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// ─── Volume grouping ─────────────────────────────────────────────────────────

/**
 * Group the workspace's manuscript files into volumes, recursively from the
 * project root. Order here is the raw fileTree order (byte-sorted by the
 * backend), parents before their subfolders; `applySpine` imposes the real
 * order afterward.
 *
 * Chapter files directly in the root form a default volume with relPath `""` —
 * a key no directory can produce, so it never collides with a real volume. A
 * project whose files still live under a `writing/` folder (the pre-freeform
 * layout) groups to the same relPaths as before (`"writing"`, `"writing/卷二"`),
 * which is what keeps an old `outline.json` valid with no migration.
 *
 * `assets/` folders are skipped entirely — they hold a document's
 * illustrations, and every illustrated chapter would otherwise sprout a fake
 * volume beside itself. `.ai-writer` never appears in the tree (the backend
 * skips dotfiles).
 */
export function groupVolumes(fileTree: FileNode[], projectPath: string): Volume[] {
  const rel = (p: string) => projectRelativePath(projectPath, p) ?? p.replace(/\\/g, "/");
  const toChapter = (c: FileNode): Chapter => ({ name: c.name, path: c.path, relPath: rel(c.path) });
  const chaptersOf = (nodes: FileNode[]): Chapter[] =>
    nodes.filter((c) => !c.is_dir && isChapterFile(c.name)).map(toChapter);
  const resourcesOf = (nodes: FileNode[]): ResourceFile[] =>
    nodes
      .filter((c) => !c.is_dir && !isChapterFile(c.name))
      .map((c): ResourceFile => ({ name: c.name, path: c.path, relPath: rel(c.path) }))
      .sort((a, b) => naturalCompare(a.name, b.name));

  const volumes: Volume[] = [];

  // Root-level files → one default volume keyed "" (the project root is not a
  // directory entry, so projectRelativePath can't name it). Resources alone
  // are enough to make it show — a folder of reference images is still a
  // collection worth seeing in the library.
  const rootFiles = chaptersOf(fileTree);
  const rootResources = resourcesOf(fileTree);
  if (rootFiles.length > 0 || rootResources.length > 0) {
    const rootName = projectPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
    volumes.push({ name: rootName, path: projectPath, relPath: "", chapters: rootFiles, resources: rootResources });
  }

  // Every folder, at any depth → its own volume of its direct chapter files
  // (empty ones included, so freshly-created volumes show up as drop targets
  // and can be deleted while empty).
  const walk = (nodes: FileNode[]) => {
    for (const child of nodes) {
      if (!child.is_dir || child.name === ASSETS_DIR) continue;
      const children = child.children ?? [];
      volumes.push({
        name: child.name,
        path: child.path,
        relPath: rel(child.path),
        chapters: chaptersOf(children),
        resources: resourcesOf(children),
      });
      walk(children);
    }
  };
  walk(fileTree);

  return volumes;
}

/** Directory portion of a path (handles both separator styles). */
export function parentDir(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(0, i) : path;
}

/**
 * Impose the spine's order on grouped volumes: manifest order first (skipping
 * entries whose file vanished), then any un-listed files appended in natural
 * order. With no spine entry for a volume, everything falls back to natural sort.
 */
export function applySpine(volumes: Volume[], spine: BookSpine | null): Volume[] {
  return volumes.map((vol) => {
    const wanted = spine?.order[vol.relPath];
    const natural = [...vol.chapters].sort((a, b) => naturalCompare(a.name, b.name));
    if (!wanted || wanted.length === 0) return { ...vol, chapters: natural };

    const byRel = new Map(vol.chapters.map((c) => [c.relPath, c]));
    const ordered: Chapter[] = [];
    const used = new Set<string>();
    for (const rp of wanted) {
      const c = byRel.get(rp);
      if (c && !used.has(rp)) { ordered.push(c); used.add(rp); }
    }
    const rest = natural.filter((c) => !used.has(c.relPath));
    return { ...vol, chapters: [...ordered, ...rest] };
  });
}

/**
 * Capture the current order of resolved volumes as a spine (for persistence),
 * carrying over the previous spine's chapter status map when given.
 */
export function spineFromVolumes(volumes: Volume[], prev?: BookSpine | null): BookSpine {
  const order: Record<string, string[]> = {};
  for (const vol of volumes) order[vol.relPath] = vol.chapters.map((c) => c.relPath);
  const spine: BookSpine = { version: 1, order };
  if (prev?.status && Object.keys(prev.status).length > 0) spine.status = { ...prev.status };
  return spine;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function spinePath(projectPath: string): string {
  return `${projectPath.replace(/\\/g, "/")}/.ai-writer/outline.json`;
}

/** Load the book spine, or null when absent / invalid. Never throws. */
export async function loadSpine(projectPath: string): Promise<BookSpine | null> {
  try {
    const p = spinePath(projectPath);
    if (!(await fileExists(p))) return null;
    const parsed = JSON.parse(await readFile(p));
    if (!parsed || typeof parsed !== "object" || typeof parsed.order !== "object") return null;
    const spine: BookSpine = { version: 1, order: parsed.order as Record<string, string[]> };
    if (parsed.status && typeof parsed.status === "object") {
      spine.status = parsed.status as Record<string, ChapterStatus>;
    }
    return spine;
  } catch {
    return null;
  }
}

export async function saveSpine(projectPath: string, spine: BookSpine): Promise<void> {
  const p = spinePath(projectPath);
  await makeDir(p.slice(0, p.lastIndexOf("/")));
  await writeFile(p, JSON.stringify(spine, null, 2) + "\n");
}

/** Group + apply the persisted spine in one step. */
export async function resolveVolumes(projectPath: string, fileTree: FileNode[]): Promise<Volume[]> {
  const volumes = groupVolumes(fileTree, projectPath);
  const spine = await loadSpine(projectPath);
  return applySpine(volumes, spine);
}

// ─── Chapter neighbourhood ───────────────────────────────────────────────────

export interface ChapterContext {
  volume: Volume;
  index: number;
  /** Chapters before the current one, in story order. */
  prior: Chapter[];
  /** Immediately preceding chapter, or null when this is the first. */
  prev: Chapter | null;
  current: Chapter;
}

/** Locate a chapter (by project-relative path) and its position in its volume. */
export function findChapterContext(volumes: Volume[], activeRelPath: string): ChapterContext | null {
  for (const vol of volumes) {
    const idx = vol.chapters.findIndex((c) => c.relPath === activeRelPath);
    if (idx >= 0) {
      return {
        volume: vol,
        index: idx,
        prior: vol.chapters.slice(0, idx),
        prev: idx > 0 ? vol.chapters[idx - 1] : null,
        current: vol.chapters[idx],
      };
    }
  }
  return null;
}
