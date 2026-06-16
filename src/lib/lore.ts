import { readFile, writeFile, makeDir, writeBinaryFile, readDir, fileExists } from "./fileio";
import { parseFrontmatter } from "./markdown";

export const LORE_CATEGORIES = [
  { id: "characters", labelZh: "人物",   labelEn: "Characters", icon: "user" },
  { id: "world",      labelZh: "世界观", labelEn: "World",      icon: "globe" },
  { id: "factions",   labelZh: "势力",   labelEn: "Factions",   icon: "shield" },
  { id: "items",      labelZh: "道具",   labelEn: "Items",      icon: "package" },
  { id: "skills",     labelZh: "技能",   labelEn: "Skills",     icon: "zap" },
  { id: "custom",     labelZh: "自定义", labelEn: "Custom",     icon: "grid" },
] as const;

export type CategoryId = (typeof LORE_CATEGORIES)[number]["id"];

export interface LoreEntity {
  id: string;          // dir name, e.g. "elden"
  category: CategoryId;
  dirPath: string;     // absolute path to entity folder
  name: string;        // from index.md frontmatter
  aliases: string[];   // from frontmatter
  summary: string;     // from frontmatter
  avatarPath: string | null;  // abs path if avatar.png/jpg exists
  mdFiles: string[];   // list of *.md filenames in the folder
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

  return { id, category, dirPath, name, aliases, summary, avatarPath, mdFiles };
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

/** Build the ai-writer-asset:// URL for a local file path. */
export function assetUrl(absolutePath: string): string {
  return `ai-writer-asset://localhost${encodeURI(absolutePath)}`;
}
