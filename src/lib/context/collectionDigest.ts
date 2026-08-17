/**
 * Collection digest ("集合摘要") — a per-volume AI summary shown in the library
 * view, so a whole folder of documents reads at a glance.
 *
 * File format (`.ai-writer/collections/<volume relPath>/digest.md`, the root
 * volume's living directly at `.ai-writer/collections/digest.md`):
 *   - Machine metadata in a leading `<!-- ai-writer-digest {json} -->` comment:
 *     volume relPath, the chapter relPaths + content hashes it was generated
 *     from, and the timestamp.
 *   - The summary follows as plain human-editable markdown; the comment block
 *     is regenerated on every update. Same philosophy as ./memory.
 *
 * Staleness is by *chapter set + content*: any added / removed / reordered
 * chapter, or any chapter whose content hash changed, marks the digest stale.
 * Digests are display-layer only — nothing here feeds AI task context.
 */

import { readFile, writeFile, makeDir, fileExists } from "../fs/fileio";
import { hashText, type DocMemory } from "./memory";

export interface DigestChapterMeta {
  /** Chapter project-relative path. */
  rel: string;
  /** FNV-1a hash of the chapter content at generation time. */
  hash: string;
}

export interface CollectionDigest {
  /** Volume relPath ("" for the workspace root). */
  volume: string;
  chapters: DigestChapterMeta[];
  updatedAt: string;
  summary: string;
}

export type DigestStatus = "none" | "stale" | "fresh";

/** Char floor below which a chapter's slice would be meaningless. */
const MIN_ITEM_CHARS = 400;

// ─── Paths ───────────────────────────────────────────────────────────────────

/**
 * Digest file for a volume. A directory per volume (`…/<relPath>/digest.md`)
 * rather than `<relPath>.md`, so nested volume paths can never collide with a
 * sibling volume's file; the root volume ("") lands at `collections/digest.md`.
 */
export function digestPath(projectPath: string, volumeRel: string): string {
  const base = `${projectPath.replace(/\\/g, "/")}/.ai-writer/collections`;
  return volumeRel ? `${base}/${volumeRel}/digest.md` : `${base}/digest.md`;
}

// ─── Serialization ───────────────────────────────────────────────────────────

const META_RE = /^<!--\s*ai-writer-digest\s*\n([\s\S]*?)\n-->/;

export function serializeDigest(digest: CollectionDigest): string {
  const meta = {
    volume: digest.volume,
    chapters: digest.chapters,
    updatedAt: digest.updatedAt,
  };
  return `<!-- ai-writer-digest\n${JSON.stringify(meta)}\n-->\n\n${digest.summary.trim()}\n`;
}

export function parseDigest(raw: string): CollectionDigest | null {
  const m = raw.match(META_RE);
  if (!m) return null;
  let meta: { volume?: unknown; chapters?: unknown; updatedAt?: unknown };
  try {
    meta = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!meta || !Array.isArray(meta.chapters)) return null;
  const chapters: DigestChapterMeta[] = (meta.chapters as unknown[]).map((c) => {
    const ch = c as { rel?: unknown; hash?: unknown };
    return { rel: String(ch.rel ?? ""), hash: String(ch.hash ?? "") };
  });
  return {
    volume: String(meta.volume ?? ""),
    chapters,
    updatedAt: String(meta.updatedAt ?? ""),
    summary: raw.slice(m[0].length).trim(),
  };
}

// ─── Freshness ───────────────────────────────────────────────────────────────

/**
 * Compare a digest against the volume's current chapters (in spine order).
 * Order-sensitive on purpose: the summary narrates an arc, and rearranging
 * chapters changes the arc even when no text changed.
 */
export function digestStatus(
  digest: CollectionDigest | null,
  chapters: { rel: string; content: string }[],
): DigestStatus {
  if (!digest) return "none";
  if (digest.chapters.length !== chapters.length) return "stale";
  for (let i = 0; i < chapters.length; i++) {
    if (digest.chapters[i].rel !== chapters[i].rel) return "stale";
    if (digest.chapters[i].hash !== hashText(chapters[i].content)) return "stale";
  }
  return "fresh";
}

// ─── Input assembly ──────────────────────────────────────────────────────────

export interface DigestSourceItem {
  /** Display title (chapter file name without extension). */
  title: string;
  content: string;
  /** The chapter's story memory, when one exists (regardless of freshness). */
  memory: DocMemory | null;
  /** True when every memory segment still matches the content. */
  memoryFresh: boolean;
}

/**
 * One chapter's contribution to the digest prompt: a fresh story memory is
 * already a compact summary, so it wins; otherwise the (truncated) content.
 */
function itemText(item: DigestSourceItem): string {
  if (item.memory && item.memoryFresh && item.memory.segments.length > 0) {
    return item.memory.segments.map((s) => s.summary.trim()).filter(Boolean).join("\n");
  }
  return item.content;
}

/**
 * Assemble the user-message body for a digest run, fitting `budgetChars` by
 * shrinking every over-quota item to an equal share (never below
 * MIN_ITEM_CHARS — a floor beats an empty slot, even if it overshoots the
 * budget slightly for volumes with very many chapters).
 */
export function buildDigestInput(items: DigestSourceItem[], budgetChars: number): string {
  if (items.length === 0) return "";
  const texts = items.map(itemText);
  const total = texts.reduce((s, t) => s + t.length, 0);
  const share = Math.max(MIN_ITEM_CHARS, Math.floor(budgetChars / items.length));
  const fitted =
    total <= budgetChars ? texts : texts.map((t) => (t.length <= share ? t : t.slice(0, share) + "…"));
  return items
    .map((item, i) => `## ${item.title}\n\n${fitted[i].trim()}`)
    .join("\n\n");
}

// ─── File IO ─────────────────────────────────────────────────────────────────

/** Load a volume's digest, or null when absent / invalid. Never throws. */
export async function loadDigest(
  projectPath: string,
  volumeRel: string,
): Promise<CollectionDigest | null> {
  try {
    const p = digestPath(projectPath, volumeRel);
    if (!(await fileExists(p))) return null;
    return parseDigest(await readFile(p));
  } catch {
    return null;
  }
}

export async function saveDigest(projectPath: string, digest: CollectionDigest): Promise<void> {
  const p = digestPath(projectPath, digest.volume);
  await makeDir(p.slice(0, p.lastIndexOf("/")));
  await writeFile(p, serializeDigest(digest));
}
