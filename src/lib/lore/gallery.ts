/**
 * Entity gallery: the images.md format (parse/serialize/mutate) and avatar
 * replacement. Text descriptions keep galleries useful for text-only models.
 */

import { fileExists, readFile, removeFile, writeBinaryFile, writeFile } from "../fs/fileio";
import { safeAssetName } from "../image/assets";

/** One images.md entry: the file, its description, and its image slot. */
export interface ImageEntry {
  file: string;
  desc: string;
  /** Image slot of the category's type schema; null when unclassified. */
  slot: string | null;
}

/** `slot: portrait` as the block's first line — see `parseImagesMd`. */
const SLOT_LINE_RE = /^slot:\s*(.+?)\s*$/i;

/**
 * Parse an `images.md` body where each `## <filename>` heading marks an image
 * and the following lines (until the next heading) form its description.
 * Tolerant of leading/trailing whitespace and entries without descriptions.
 *
 * An image's **slot** rides as a `slot: <id>` line at the very start of its
 * block, before the description. Only the first line counts, so a description
 * that happens to contain "slot:" further down is left alone.
 *
 * A key line rather than a heading level or a suffix on the filename, because
 * this file is read by builds that know nothing about slots: an older app shows
 * the line as part of the description — cosmetic, nothing lost — whereas an `#`
 * grouping heading would be swallowed into the *previous* image's description,
 * and a decorated `## file [slot]` heading would corrupt the filename itself.
 */
export function parseImagesMd(raw: string): ImageEntry[] {
  const out: ImageEntry[] = [];
  let current: { file: string; desc: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const lines = [...current.desc];
    // Leading blank lines may precede the slot line; skip them to find it.
    let at = 0;
    while (at < lines.length && lines[at].trim() === "") at++;
    let slot: string | null = null;
    const match = at < lines.length ? lines[at].match(SLOT_LINE_RE) : null;
    if (match) {
      slot = match[1].trim() || null;
      lines.splice(0, at + 1);
    }
    out.push({ file: current.file, desc: lines.join("\n").trim(), slot });
  };
  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      flush();
      current = { file: heading[1].trim(), desc: [] };
    } else if (current) {
      current.desc.push(line);
    }
  }
  flush();
  return out;
}

/**
 * Serialize a list of image entries to the `## file` + description body format
 * consumed by parseImagesMd. Empty list → empty string (caller decides whether
 * to write or delete the file).
 */
export function serializeImagesMd(
  images: { file: string; desc: string; slot?: string | null }[],
): string {
  if (!images.length) return "";
  const blocks = images.map(({ file, desc, slot }) => {
    const lines = [`## ${file}`];
    if (slot) lines.push(`slot: ${slot}`);
    const body = desc.trim();
    if (body) lines.push(body);
    return lines.join("\n");
  });
  return blocks.join("\n\n") + "\n";
}

/**
 * Persist the gallery list. Writes images.md, or removes it when the list is
 * empty so we don't leave an empty header file behind.
 */
export async function writeImagesMd(
  dirPath: string,
  images: { file: string; desc: string; slot?: string | null }[],
): Promise<void> {
  const path = `${dirPath}/images.md`;
  if (!images.length) {
    if (await fileExists(path)) await removeFile(path);
    return;
  }
  await writeFile(path, serializeImagesMd(images));
}

async function readImagesMdAsList(dirPath: string): Promise<ImageEntry[]> {
  try {
    const raw = await readFile(`${dirPath}/images.md`);
    return parseImagesMd(raw);
  } catch {
    return [];
  }
}

/**
 * Pick a filename that doesn't collide with anything already in the entity dir.
 *
 * Sanitised by the same rule as document assets rather than a local one: the
 * requested name is often the basename of a file the author picked on disk, so
 * on macOS it can legitimately contain `: * ? " < > |`. Written into the
 * project as-is, that repository cannot be checked out on Windows at all.
 */
async function uniqueImageName(dirPath: string, requested: string): Promise<string> {
  const safe = safeAssetName(requested, "image");
  if (!(await fileExists(`${dirPath}/${safe}`))) return safe;
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!(await fileExists(`${dirPath}/${candidate}`))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/**
 * Copy one image's bytes into the entity dir under a non-colliding name and
 * append the entry to images.md. Returns the saved filename.
 */
export async function addLoreImage(
  dirPath: string,
  requestedName: string,
  bytes: Uint8Array,
  desc = "",
  slot: string | null = null,
): Promise<string> {
  const filename = await uniqueImageName(dirPath, requestedName);
  await writeBinaryFile(`${dirPath}/${filename}`, bytes);
  const existing = await readImagesMdAsList(dirPath);
  existing.push({ file: filename, desc, slot });
  await writeImagesMd(dirPath, existing);
  return filename;
}

/**
 * Update one image's description. No-op if the file is not listed in images.md.
 *
 * The slot is carried through rather than rewritten — the same discipline every
 * facet write follows: an edit that only means to touch the description must not
 * silently unclassify the image.
 */
export async function updateLoreImageDesc(
  dirPath: string,
  file: string,
  desc: string,
): Promise<void> {
  const existing = await readImagesMdAsList(dirPath);
  const idx = existing.findIndex((i) => i.file === file);
  if (idx === -1) return;
  existing[idx] = { ...existing[idx], desc };
  await writeImagesMd(dirPath, existing);
}

/**
 * Move one image into an image slot of the category's schema (or out of any, on
 * null). No-op if the file is not listed in images.md.
 */
export async function updateLoreImageSlot(
  dirPath: string,
  file: string,
  slot: string | null,
): Promise<void> {
  const existing = await readImagesMdAsList(dirPath);
  const idx = existing.findIndex((i) => i.file === file);
  if (idx === -1) return;
  existing[idx] = { ...existing[idx], slot };
  await writeImagesMd(dirPath, existing);
}

/**
 * Remove an image: drop the entry from images.md and delete the file on disk.
 * Both steps are best-effort — orphan entries or orphan files won't crash.
 */
export async function removeLoreImage(dirPath: string, file: string): Promise<void> {
  const existing = await readImagesMdAsList(dirPath);
  const next = existing.filter((i) => i.file !== file);
  await writeImagesMd(dirPath, next);
  try { await removeFile(`${dirPath}/${file}`); } catch { /* file may already be gone */ }
}

// ─── Avatar mutation ─────────────────────────────────────────────────────────

const AVATAR_EXTS = ["png", "jpg", "jpeg", "webp"] as const;

/**
 * Replace the entity's avatar. Removes any existing `avatar.<ext>` (so we don't
 * accumulate stale files when the user switches formats) then writes the new
 * one. The scanner picks up the new path on the next refresh.
 */
export async function setEntityAvatar(
  dirPath: string,
  bytes: Uint8Array,
  ext: string,
): Promise<void> {
  const normalizedExt = ext.toLowerCase().replace(/^\./, "");
  for (const e of AVATAR_EXTS) {
    const path = `${dirPath}/avatar.${e}`;
    if (await fileExists(path)) {
      try { await removeFile(path); } catch { /* best-effort */ }
    }
  }
  await writeBinaryFile(`${dirPath}/avatar.${normalizedExt}`, bytes);
}
