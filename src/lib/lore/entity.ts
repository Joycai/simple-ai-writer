/**
 * Lore entity scanning and persistence: directory scan → LoreIndex, entity
 * creation, frontmatter serialization, and filesystem-safe id derivation.
 */

import { fileExists, makeDir, readDir, readFile, renamePath, writeBinaryFile, writeFile } from "../fs/fileio";
import { parseFrontmatter } from "../fs/markdown";
import { parseImagesMd } from "./gallery";
import { LORE_CATEGORIES, type CategoryId, type EntityMeta, type LoreEntity, type LoreImage, type LoreIndex } from "./model";

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
