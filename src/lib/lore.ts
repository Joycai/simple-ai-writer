import { readFile, writeFile, makeDir, writeBinaryFile, readDir, fileExists, removeFile, renamePath } from "./fileio";
import { parseFrontmatter } from "./markdown";

export const LORE_CATEGORIES = [
  { id: "characters", labelZh: "人物",   labelEn: "Characters", icon: "user" },
  { id: "world",      labelZh: "世界观", labelEn: "World",      icon: "globe" },
  { id: "factions",   labelZh: "势力",   labelEn: "Factions",   icon: "shield" },
  { id: "items",      labelZh: "道具",   labelEn: "Items",      icon: "package" },
  { id: "skills",     labelZh: "技能",   labelEn: "Skills",     icon: "zap" },
  { id: "style",      labelZh: "风格",   labelEn: "Style",      icon: "feather" },
  { id: "custom",     labelZh: "自定义", labelEn: "Custom",     icon: "grid" },
] as const;

export type CategoryId = (typeof LORE_CATEGORIES)[number]["id"];

export interface LoreImage {
  /** File name relative to the entity directory. */
  file: string;
  /** Plain-text description, shown to text-only models and rendered in the gallery. */
  desc: string;
  /** Absolute path on disk (populated by scanLore). */
  absPath: string;
}

export interface LoreEntity {
  id: string;          // dir name, e.g. "elden"
  category: CategoryId;
  dirPath: string;     // absolute path to entity folder
  name: string;        // from index.md frontmatter
  aliases: string[];   // from frontmatter
  summary: string;     // from frontmatter
  avatarPath: string | null;  // abs path if avatar.png/jpg exists
  mdFiles: string[];   // list of *.md filenames in the folder
  /** Parsed from images.md (each `## filename` heading + following paragraph). */
  images: LoreImage[];
}

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

export interface LoreIndex {
  [category: string]: LoreEntity[];
}

/** Scan the entire lore directory and return all entities grouped by category. */
export async function scanLore(projectPath: string): Promise<LoreIndex> {
  const loreRoot = `${projectPath}/.ai-writer/lore`;
  const index: LoreIndex = {};

  for (const cat of LORE_CATEGORIES) {
    const catPath = `${loreRoot}/${cat.id}`;
    index[cat.id] = [];

    try {
      const entries = await readDir(catPath);
      for (const entry of entries) {
        if (!entry.isDirectory) continue;
        const entityDir = `${catPath}/${entry.name}`;
        const entity = await readEntity(cat.id, entry.name, entityDir);
        if (entity) index[cat.id].push(entity);
      }
    } catch {
      // category dir may not exist yet
    }
  }

  return index;
}

async function readEntity(
  category: CategoryId,
  id: string,
  dirPath: string,
): Promise<LoreEntity | null> {
  const indexPath = `${dirPath}/index.md`;
  let name = id;
  let aliases: string[] = [];
  let summary = "";

  try {
    const raw = await readFile(indexPath);
    const { data } = parseFrontmatter(raw);
    if (typeof data.name === "string") name = data.name;
    if (Array.isArray(data.aliases)) aliases = data.aliases as string[];
    if (typeof data.summary === "string") summary = data.summary;
  } catch {
    // index.md missing — entity still listed with defaults
  }

  // Collect *.md files in dir
  let mdFiles: string[] = [];
  let avatarPath: string | null = null;
  try {
    const entries = await readDir(dirPath);
    mdFiles = entries
      .filter((e) => !e.isDirectory && e.name.endsWith(".md"))
      .map((e) => e.name);

    const avatarExts = ["png", "jpg", "jpeg", "webp"];
    for (const ext of avatarExts) {
      const candidate = `${dirPath}/avatar.${ext}`;
      if (await fileExists(candidate)) {
        avatarPath = candidate;
        break;
      }
    }
  } catch {}

  // Parse images.md if present. Each entry's `file` is resolved against dirPath
  // and dropped if the underlying file is missing — keeps the list trustworthy.
  const images: LoreImage[] = [];
  try {
    const raw = await readFile(`${dirPath}/images.md`);
    const entries = parseImagesMd(raw);
    for (const { file, desc } of entries) {
      const absPath = `${dirPath}/${file}`;
      if (await fileExists(absPath)) {
        images.push({ file, desc, absPath });
      }
    }
  } catch {
    // images.md missing — entity has no gallery, leave images empty
  }

  return { id, category, dirPath, name, aliases, summary, avatarPath, mdFiles, images };
}

/** Create a new entity directory with a template index.md. */
export async function createEntity(
  projectPath: string,
  category: CategoryId,
  entityId: string,
  name: string,
): Promise<string> {
  const dirPath = `${projectPath}/.ai-writer/lore/${category}/${entityId}`;
  await makeDir(dirPath);

  const indexContent = `---\nname: ${name}\naliases: []\ncategory: ${category}\nsummary: \n---\n\n# ${name}\n\n`;
  await writeFile(`${dirPath}/index.md`, indexContent);

  return dirPath;
}

/** Create an entity with full content and optional avatar image bytes. */
export async function createEntityWithContent(
  projectPath: string,
  category: CategoryId,
  entityId: string,
  name: string,
  aliases: string[],
  summary: string,
  content: string,
  avatarBytes?: { data: Uint8Array; ext: string },
): Promise<string> {
  const dirPath = `${projectPath}/.ai-writer/lore/${category}/${entityId}`;
  await makeDir(dirPath);

  const aliasLines = aliases.map((a) => `  - "${a}"`).join("\n");
  const frontmatter = [
    "---",
    `name: ${name}`,
    `aliases:`,
    aliasLines,
    `category: ${category}`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    "---",
    "",
  ].join("\n");
  await writeFile(`${dirPath}/index.md`, frontmatter + content);

  if (avatarBytes) {
    await writeBinaryFile(`${dirPath}/avatar.${avatarBytes.ext}`, avatarBytes.data);
  }

  return dirPath;
}

// ─── Entity metadata persistence ─────────────────────────────────────────────

export interface EntityMeta {
  name: string;
  aliases: string[];
  category: CategoryId;
  summary: string;
}

/** Serialize entity metadata to the index.md YAML frontmatter block. */
export function serializeEntityFrontmatter(meta: EntityMeta): string {
  const aliasBlock = meta.aliases.length
    ? `aliases:\n${meta.aliases.map((a) => `  - "${a.replace(/"/g, '\\"')}"`).join("\n")}`
    : `aliases: []`;
  const summaryQuoted = `"${meta.summary.replace(/"/g, '\\"')}"`;
  return [
    "---",
    `name: ${meta.name}`,
    aliasBlock,
    `category: ${meta.category}`,
    `summary: ${summaryQuoted}`,
    "---",
    "",
  ].join("\n");
}

/**
 * Persist metadata + body to the entity's index.md. When the category changed,
 * the whole entity folder is moved into the new category directory — the
 * scanner derives an entity's category from its folder location, so writing
 * the frontmatter alone would silently revert on the next scan.
 * Returns where the entity now lives (unchanged when the category stayed).
 */
export async function saveEntityMetaAndBody(
  projectPath: string,
  entity: LoreEntity,
  meta: EntityMeta,
  body: string,
): Promise<{ dirPath: string; category: CategoryId; id: string }> {
  const content = serializeEntityFrontmatter(meta) + "\n" + body.trimStart();
  await writeFile(`${entity.dirPath}/index.md`, content);

  if (meta.category === entity.category) {
    return { dirPath: entity.dirPath, category: entity.category, id: entity.id };
  }
  const newId = await uniqueEntityId(projectPath, meta.category, entity.id);
  const newDir = `${projectPath}/.ai-writer/lore/${meta.category}/${newId}`;
  await renamePath(entity.dirPath, newDir);
  return { dirPath: newDir, category: meta.category, id: newId };
}

/** Read a specific file inside an entity directory. */
export async function readEntityFile(dirPath: string, filename: string): Promise<string> {
  return readFile(`${dirPath}/${filename}`);
}

/** Write a specific file inside an entity directory. */
export async function writeEntityFile(
  dirPath: string,
  filename: string,
  content: string,
): Promise<void> {
  await writeFile(`${dirPath}/${filename}`, content);
}

// NOTE: image rendering used to go through the `ai-writer-asset://` custom
// protocol (see the Rust handler), but Webview2's strict URL parsing on
// Windows drive-letter paths made it unreliable. All avatar/gallery consumers
// now load images as base64 data URLs (see useImageDataUrl / imageToDataUrl).

// ─── Entity id helpers ───────────────────────────────────────────────────────

// Chars that NTFS / FAT32 / HFS+ cannot store in a path component. We strip
// rather than substitute so non-Latin names keep their natural shape.
const FS_RESERVED_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/**
 * Derive a filesystem-safe entity directory name from a user-supplied name.
 * Unicode letters and digits (CJK, Cyrillic, etc.) are preserved verbatim;
 * whitespace becomes `_`; only chars Windows refuses are removed.
 *
 * The legacy slug used `[^a-z0-9_-]` which stripped every non-ASCII codepoint,
 * so every Chinese name collapsed to the literal string `"entity"` and
 * sequential creations silently overwrote each other's `index.md`. This
 * preserves CJK names so each entity lands in its own folder.
 */
export function slugifyEntityId(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return `entity-${Date.now()}`;
  const cleaned = trimmed
    .replace(FS_RESERVED_CHARS, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return cleaned || `entity-${Date.now()}`;
}

/**
 * Resolve a non-colliding entity directory name under the given category.
 * Appends `-2`, `-3`, … if the base id already exists on disk.
 */
export async function uniqueEntityId(
  projectPath: string,
  category: CategoryId,
  baseId: string,
): Promise<string> {
  const catDir = `${projectPath}/.ai-writer/lore/${category}`;
  if (!(await fileExists(`${catDir}/${baseId}`))) return baseId;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${baseId}-${i}`;
    if (!(await fileExists(`${catDir}/${candidate}`))) return candidate;
  }
  return `${baseId}-${Date.now()}`;
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

// ─── images.md mutation helpers ──────────────────────────────────────────────

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
