/**
 * Entity gallery: the images.md format (parse/serialize/mutate) and avatar
 * replacement. Text descriptions keep galleries useful for text-only models.
 */

import { fileExists, readFile, removeFile, writeBinaryFile, writeFile } from "../fs/fileio";

/**
 * Parse an `images.md` body where each `## <filename>` heading marks an image
 * and the following lines (until the next heading) form its description.
 * Tolerant of leading/trailing whitespace and entries without descriptions.
 */
export function parseImagesMd(raw: string): { file: string; desc: string }[] {
  const out: { file: string; desc: string }[] = [];
  let current: { file: string; desc: string[] } | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      if (current) out.push({ file: current.file, desc: current.desc.join("\n").trim() });
      current = { file: heading[1].trim(), desc: [] };
    } else if (current) {
      current.desc.push(line);
    }
  }
  if (current) out.push({ file: current.file, desc: current.desc.join("\n").trim() });
  return out;
}

/**
 * Serialize a list of image entries to the `## file` + description body format
 * consumed by parseImagesMd. Empty list → empty string (caller decides whether
 * to write or delete the file).
 */
export function serializeImagesMd(images: { file: string; desc: string }[]): string {
  if (!images.length) return "";
  const blocks = images.map(({ file, desc }) => {
    const body = desc.trim();
    return body ? `## ${file}\n${body}` : `## ${file}`;
  });
  return blocks.join("\n\n") + "\n";
}

/**
 * Persist the gallery list. Writes images.md, or removes it when the list is
 * empty so we don't leave an empty header file behind.
 */
export async function writeImagesMd(
  dirPath: string,
  images: { file: string; desc: string }[],
): Promise<void> {
  const path = `${dirPath}/images.md`;
  if (!images.length) {
    if (await fileExists(path)) await removeFile(path);
    return;
  }
  await writeFile(path, serializeImagesMd(images));
}

async function readImagesMdAsList(dirPath: string): Promise<{ file: string; desc: string }[]> {
  try {
    const raw = await readFile(`${dirPath}/images.md`);
    return parseImagesMd(raw);
  } catch {
    return [];
  }
}

/**
 * Pick a filename that doesn't collide with anything already in the entity dir.
 * Sanitizes path separators and control chars, then dedupes by appending -2/-3.
 */
async function uniqueImageName(dirPath: string, requested: string): Promise<string> {
  const safe = requested.replace(/[\\/\x00-\x1f]/g, "_").trim() || "image";
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
): Promise<string> {
  const filename = await uniqueImageName(dirPath, requestedName);
  await writeBinaryFile(`${dirPath}/${filename}`, bytes);
  const existing = await readImagesMdAsList(dirPath);
  existing.push({ file: filename, desc });
  await writeImagesMd(dirPath, existing);
  return filename;
}

/**
 * Update one image's description. No-op if the file is not listed in images.md.
 */
export async function updateLoreImageDesc(
  dirPath: string,
  file: string,
  desc: string,
): Promise<void> {
  const existing = await readImagesMdAsList(dirPath);
  const idx = existing.findIndex((i) => i.file === file);
  if (idx === -1) return;
  existing[idx] = { file, desc };
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
