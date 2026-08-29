/**
 * Lore entity scanning and persistence: directory scan → LoreIndex, entity
 * creation, frontmatter serialization, and filesystem-safe id derivation.
 */

import { fileExists, makeDir, readDir, readFile, renamePath, writeBinaryFile, writeFile } from "../fs/fileio";
import { parseFrontmatter } from "../fs/markdown";
import { collectCiteTargets } from "./citations";
import { parseImagesMd } from "./gallery";
import { loreCategories } from "../profile/active";
import { addCollection, normalizeCollections, removeCollection, renameCollection, sameCollection } from "./collections";
import {
  RESERVED_ENTITY_FILES,
  type CategoryId,
  type EntityMeta,
  type FacetMeta,
  type LoreEntity,
  type LoreFacet,
  type LoreImage,
  type LoreIndex,
} from "./model";

/**
 * Scan the entire lore directory and return all entities grouped by category.
 *
 * Two passes, because a category directory can outlive the pack that named it:
 *
 *   1. every category of the merged workspace, seeded even when empty — that is
 *      the app's own list, and an empty one is a filter the author can still see;
 *   2. every *other* directory that holds at least one entry — an **orphan
 *      category** (see `indexCategories`).
 *
 * The second pass is what makes disabling a pack a **degradation** instead of a
 * disappearance. Scanning only the merged list used to drop those entries out of
 * the wall, the palette and the pickers in one go, while the injection path —
 * which walks the index itself, not the category list — never saw them either,
 * because they were never in the index. Now they are listed, editable and
 * injectable; what they lose is the type schema and being a creation target
 * (`isKnownCategory` still says no, deliberately).
 *
 * Nothing is moved or rewritten to achieve that: the folders stay where they
 * are, so re-enabling the pack restores the categories exactly.
 */
export async function scanLore(projectPath: string): Promise<LoreIndex> {
  const loreRoot = `${projectPath}/.ai-writer/lore`;
  const index: LoreIndex = {};

  const known = loreCategories();
  for (const cat of known) {
    index[cat.id] = await readCategoryEntities(`${loreRoot}/${cat.id}`, cat.id);
  }

  // Only a folder that actually holds an entry becomes an orphan category: an
  // empty leftover directory would otherwise show up as a phantom category
  // nothing can fill (new entries can't be created in an orphan).
  const seen = new Set(known.map((c) => c.id.toLowerCase()));
  try {
    for (const entry of await readDir(loreRoot)) {
      // Compared lowercased: a case-insensitive filesystem reports the folder
      // under whatever casing it was created with, and that is the *same*
      // directory the first pass already read.
      if (!entry.isDirectory || seen.has(entry.name.toLowerCase())) continue;
      const entities = await readCategoryEntities(`${loreRoot}/${entry.name}`, entry.name);
      if (entities.length > 0) index[entry.name] = entities;
    }
  } catch {
    // no lore directory yet — a project with no knowledge base at all
  }

  return index;
}

/**
 * Every entity directory under one folder, read as `category`.
 *
 * Exported because the roleplay memory area (`lib/roleplay/area`) is stored in
 * the *same format* somewhere else entirely — that is the whole trick behind
 * "reuse the code, not the index": one flat folder scanned by this function
 * yields a `LoreIndex` that `selectLore` can consume, without a single one of
 * its entries ever entering the project's own index.
 */
export async function scanEntityFolder(
  dirPath: string,
  category: CategoryId,
): Promise<LoreEntity[]> {
  return readCategoryEntities(dirPath, category);
}

/**
 * Every entity directory under one category folder. A missing or unreadable
 * folder yields nothing rather than throwing: category directories are created
 * lazily, on the first entry.
 */
async function readCategoryEntities(
  catPath: string,
  category: CategoryId,
): Promise<LoreEntity[]> {
  const out: LoreEntity[] = [];
  try {
    for (const entry of await readDir(catPath)) {
      if (!entry.isDirectory) continue;
      const entity = await readEntity(category, entry.name, `${catPath}/${entry.name}`);
      if (entity) out.push(entity);
    }
  } catch {
    // category dir may not exist yet
  }
  return out;
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
  let dict = false;
  let collections: string[] = [];

  const citeTargets: string[] = [];
  try {
    const raw = await readFile(indexPath);
    const { data, content } = parseFrontmatter(raw);
    // The `[[lore:…]]` targets this entry declares. Harvested here rather than
    // in a pass of its own because the bytes are already in hand — the scan
    // reads index.md and every facet file anyway, so the reference graph costs
    // one string scan and no extra IO (docs/feature/lore/lore-retrieval-plan.md §4.1).
    citeTargets.push(...collectCiteTargets(content));
    if (typeof data.name === "string") name = data.name;
    if (Array.isArray(data.aliases)) aliases = data.aliases as string[];
    if (typeof data.summary === "string") summary = data.summary;
    // The line-based frontmatter parser yields the string "true"; a real
    // boolean would mean the parser grew types, so accept both.
    dict = data.dict === true || data.dict === "true";
    // Absent = 未归集, which is every entry that predates collections. The value
    // is kept verbatim (only trimmed/deduped): a collection nothing declares is
    // still a real collection — see lib/lore/collections.
    collections = normalizeCollections(data.collections);
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
    for (const { file, desc, slot } of entries) {
      const absPath = `${dirPath}/${file}`;
      if (await fileExists(absPath)) {
        images.push({ file, desc, slot, absPath });
      }
    }
  } catch {
    // images.md missing — entity has no gallery, leave images empty
  }

  // Parse facet metadata from every non-reserved md. Files whose frontmatter
  // lacks a `facet` field are inert attachments and simply yield null here.
  // Content is NOT kept in memory — the injection engine re-reads facet files
  // at assembly time so hand edits are never served stale (see loreSelect.ts).
  const facets: LoreFacet[] = [];
  for (const file of mdFiles) {
    if (RESERVED_ENTITY_FILES.includes(file)) continue;
    try {
      const raw = await readFile(`${dirPath}/${file}`);
      const facet = parseFacetMeta(raw, file);
      if (facet) facets.push(facet);
      // Facet prose cites too — an outfit naming the weapon it is worn with is
      // the same declaration as one in index.md, and the expansion is
      // entity-level either way.
      citeTargets.push(...collectCiteTargets(parseFrontmatter(raw).content));
    } catch {
      // unreadable file — treat as inert attachment
    }
  }

  // Deduplicated across index.md and every facet: the same target cited twice
  // is one edge, and `refs` is read once per selection.
  const seen = new Set<string>();
  const refs = citeTargets.filter((t) => {
    const key = t.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { id, category, dirPath, name, aliases, summary, dict, collections, avatarPath, mdFiles, images, facets, refs };
}

/**
 * Parse a facet definition from a raw md file (frontmatter + body).
 * Returns null when the file is not a facet (no `facet` frontmatter field).
 * Tolerant of partial frontmatter: missing keys/group/priority/mode fall back
 * to safe defaults so a half-written facet never breaks the scan.
 */
export function parseFacetMeta(raw: string, file: string): LoreFacet | null {
  const { data, content } = parseFrontmatter(raw);
  if (typeof data.facet !== "string" || !data.facet.trim()) return null;

  const keys = coerceStringList(data.keys);
  // Kept verbatim, never validated against the active schema: a slot whose pack
  // is disabled must still be there when the pack comes back (see LoreFacet.slot).
  const slot = typeof data.slot === "string" && data.slot.trim() ? data.slot.trim() : null;
  const group =
    typeof data.group === "string" && data.group.trim() ? data.group.trim() : null;
  const priority = Number(data.priority);
  const mode =
    data.mode === "always" || data.mode === "manual" ? data.mode : "auto";

  return {
    file,
    title: data.facet.trim(),
    slot,
    keys,
    group,
    priority: Number.isFinite(priority) ? priority : 0,
    mode,
    charCount: content.length,
  };
}

/**
 * Serialize facet metadata to a YAML frontmatter block. Keys are written as
 * a JSON-quoted inline array so the lightweight parser round-trips them
 * exactly (including CJK and items containing commas).
 */
export function serializeFacetFrontmatter(meta: FacetMeta): string {
  // Title/group are quoted so values that would otherwise parse as JSON
  // (e.g. a title of "[1]") still round-trip as strings.
  const lines = ["---", `facet: ${JSON.stringify(meta.title)}`];
  // Right after the title because that is how the file reads: what this is,
  // then which slot it fills. Omitted when unclassified rather than written as
  // an empty value — the absence is the state.
  if (meta.slot) lines.push(`slot: ${JSON.stringify(meta.slot)}`);
  lines.push(`keys: [${meta.keys.map((k) => JSON.stringify(k)).join(", ")}]`);
  if (meta.group) lines.push(`group: ${JSON.stringify(meta.group)}`);
  if (meta.priority !== 0) lines.push(`priority: ${meta.priority}`);
  if (meta.mode !== "auto") lines.push(`mode: ${meta.mode}`);
  lines.push("---", "");
  return lines.join("\n");
}

/**
 * Write facet metadata + body to an existing file in the entity dir.
 * Any previous frontmatter is replaced wholesale (facet files own their
 * frontmatter — there is nothing else to preserve).
 */
export async function saveFacetFile(
  dirPath: string,
  file: string,
  meta: FacetMeta,
  body: string,
): Promise<void> {
  await writeFile(`${dirPath}/${file}`, serializeFacetFrontmatter(meta) + "\n" + body.trimStart());
}

/**
 * The filename a facet with this title gets: slugified, collision-safe, never
 * a reserved name. Split out from {@link createFacetFile} because a caller that
 * must know the name *before* the write exists — the agent's create_lore_facet
 * gates on the approved plan, and a plan step may name the file it authorises.
 */
export async function facetFileName(dirPath: string, title: string): Promise<string> {
  // '#' is stripped because facet pins are stored as "dirPath#file" strings.
  let base = slugifyEntityId(title).replace(/#/g, "");
  if (!base || RESERVED_ENTITY_FILES.includes(`${base}.md`)) base = `facet-${base}`;
  let file = `${base}.md`;
  for (let i = 2; await fileExists(`${dirPath}/${file}`); i++) {
    file = `${base}-${i}.md`;
  }
  return file;
}

/**
 * Create a new facet file named after the title (slugified, collision-safe,
 * never a reserved name). Returns the filename actually used.
 */
export async function createFacetFile(
  dirPath: string,
  meta: FacetMeta,
  body: string,
): Promise<string> {
  const file = await facetFileName(dirPath, meta.title);
  await saveFacetFile(dirPath, file, meta, body);
  return file;
}

/**
 * Coerce a frontmatter value into a string list. Handles proper YAML arrays,
 * but also the hand-written inline form with unquoted CJK items
 * (`keys: [战甲, 板甲]`) which the lightweight frontmatter parser can't
 * JSON.parse and therefore hands back as a raw string.
 */
function coerceStringList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof v === "string") {
    return v
      .trim()
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(/[,，]/)
      .map((s) => s.trim().replace(/^["']|["']$/g, "").trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Create a new entity directory with a template index.md.
 *
 * `collections` is what a **scoped** knowledge base needs: creating an entry
 * while the author has narrowed the working set to one collection must file it
 * there, or the new entry lands 未归集 and is invisible from the very view it
 * was created in (see lib/lore/collections).
 */
export async function createEntity(
  projectPath: string,
  category: CategoryId,
  entityId: string,
  name: string,
  collections: string[] = [],
): Promise<string> {
  const dirPath = `${projectPath}/.ai-writer/lore/${category}/${entityId}`;
  await makeDir(dirPath);

  // Built by the one serializer rather than by hand: it is the only place that
  // knows which optional lines (dict, collections) exist and how author input
  // gets quoted — a newline or a leading "[" written bare would corrupt the
  // line-based frontmatter parser.
  const frontmatter = serializeEntityFrontmatter({
    name, aliases: [], category, summary: "", collections,
  });
  await writeFile(`${dirPath}/index.md`, `${frontmatter}\n# ${name}\n\n`);

  return dirPath;
}

/**
 * Escape a string for a YAML double-quoted scalar. Backslash first, so the
 * backslashes this introduces for the other two escapes aren't themselves
 * re-escaped; newline last. The newline escape is what actually matters here:
 * `summary` comes from a multi-line textarea, and parseFrontmatter's parser
 * is line-based — a raw newline inside the quotes would end up read as a
 * separate, unrelated frontmatter line instead of part of the value, both
 * truncating the summary and corrupting whatever line followed it.
 */
function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/**
 * Create an entity with full content, optionally an avatar and a collection
 * filing (see `createEntity` for why the latter matters).
 *
 * Shares `serializeEntityFrontmatter` with every other writer — the hand-rolled
 * block this replaced also emitted a blank line inside the frontmatter whenever
 * `aliases` was empty.
 */
export async function createEntityWithContent(
  projectPath: string,
  category: CategoryId,
  entityId: string,
  name: string,
  aliases: string[],
  summary: string,
  content: string,
  opts?: { avatarBytes?: { data: Uint8Array; ext: string }; collections?: string[] },
): Promise<string> {
  const dirPath = `${projectPath}/.ai-writer/lore/${category}/${entityId}`;
  await makeDir(dirPath);

  const frontmatter = serializeEntityFrontmatter({
    name, aliases, category, summary, collections: opts?.collections,
  });
  await writeFile(`${dirPath}/index.md`, frontmatter + content);

  const avatarBytes = opts?.avatarBytes;
  if (avatarBytes) {
    await writeBinaryFile(`${dirPath}/avatar.${avatarBytes.ext}`, avatarBytes.data);
  }

  return dirPath;
}

// ─── Collections ─────────────────────────────────────────────────────────────

/**
 * 把索引里所有归入 `from` 的条目改归 `to`（`to` 为 null ＝ 取消归属），返回改写了
 * 几条。
 *
 * 集合的 id 就是它的名字（见 ./collections 的说明），所以重命名和删除是**改写成员
 * 条目的 frontmatter**，不是改一行声明。这是那个取舍的代价，而它买到的是作者手改
 * 的文件里写着 `collections: ["小说A"]` 而不是 `["kb-2"]`。
 *
 * 只碰 frontmatter：正文原样读进来再写回去（`saveEntityMetaAndBody` 走的是同一条
 * 路，所以引号转义、dict 标记、分类不变时不搬家这些行为都自动一致）。单条失败不
 * 中断整批——批量改写中途抛出会留下一半改完一半没改，而这里每一条都是独立且可重跑
 * 的，跑第二遍只会跳过已经改好的。
 */
export async function refileCollection(
  projectPath: string,
  index: LoreIndex,
  from: string,
  to: string | null,
): Promise<number> {
  let touched = 0;
  for (const entities of Object.values(index)) {
    for (const entity of entities ?? []) {
      const current = entity.collections ?? [];
      if (!current.some((c) => sameCollection(c, from))) continue;
      const next = to ? renameCollection(current, from, to) : removeCollection(current, from);
      try {
        const raw = await readFile(`${entity.dirPath}/index.md`);
        const { content } = parseFrontmatter(raw);
        await saveEntityMetaAndBody(
          projectPath,
          entity,
          {
            name: entity.name,
            aliases: entity.aliases ?? [],
            category: entity.category,
            summary: entity.summary,
            // 显式带上——`dict` 的那条纪律在这里同样适用。
            dict: entity.dict,
            collections: next,
          },
          content,
        );
        touched++;
      } catch (e) {
        console.warn(`[lore] could not refile ${entity.dirPath}:`, e);
      }
    }
  }
  return touched;
}

/**
 * 改一批条目的集合归属：加入 `add`、移出 `remove`，正文原样保留。
 *
 * 加与减是两个独立的列表而不是「设成这一份」，因为批量归集的语义是**只加不减**
 * ——勾一个集合的意思是「这批都进去」，不是「这批的归属变成这一个」。后者会在作者
 * 只想补一个标签时静静抹掉别的归属，而那种丢失既没有提示也不容易发现。
 *
 * 返回真的改动过的条目数（已经是那个状态的会被跳过，所以重复点不会白写一遍磁盘）。
 */
export async function fileEntities(
  projectPath: string,
  entities: readonly LoreEntity[],
  add: readonly string[],
  remove: readonly string[],
): Promise<number> {
  let touched = 0;
  for (const entity of entities) {
    let next = entity.collections ?? [];
    for (const name of add) next = addCollection(next, name);
    for (const name of remove) next = removeCollection(next, name);
    const before = entity.collections ?? [];
    if (next.length === before.length && next.every((c, i) => c === before[i])) continue;
    try {
      const raw = await readFile(`${entity.dirPath}/index.md`);
      const { content } = parseFrontmatter(raw);
      await saveEntityMetaAndBody(
        projectPath,
        entity,
        {
          name: entity.name,
          aliases: entity.aliases ?? [],
          category: entity.category,
          summary: entity.summary,
          dict: entity.dict,
          collections: next,
        },
        content,
      );
      touched++;
    } catch (e) {
      console.warn(`[lore] could not file ${entity.dirPath}:`, e);
    }
  }
  return touched;
}

/** 一次搬家的落点：置顶重指要用旧新两个 dirPath。 */
export type CategoryMove = { from: string; to: string };

/**
 * 把一批条目搬进另一个分类——知识库墙上多选之后的那一下。
 *
 * 和 `fileEntities` 是同一个形状（逐条独立、单条失败不中断整批、正文原样带走），但
 * 语义相反：集合是**只加不减**的多值标签，分类是**替换**，而且是磁盘上的文件夹，所以
 * 每一条都会搬家。两处的差别只有这一段注释和返回值，剩下的都刻意长得一样。
 *
 * 三件事在返回值里，因为界面必须能分开说：
 *   moves   真的搬了的（旧 → 新 dirPath）。调用方拿它重指置顶——置顶按绝对路径存，
 *           不重指的话批量移动就等于静默取消这一批的置顶（见 `repointPins`）。
 *   skipped 本来就在目标分类里的。算进「已移动 N 条」会给作者一个含水的数字。
 *   failed  读不出或写不进的条目名。报出来，而不是让一次「20 条」实际只搬了 18 条。
 *
 * 没有 index.md 的条目也照搬：扫描器允许这种条目存在（列出来、用默认值），这里就照
 * `move_lore_entity` 的老办法用扫描到的元数据重建一份，而不是把它留在原地。
 */
export async function moveEntitiesToCategory(
  projectPath: string,
  entities: readonly LoreEntity[],
  category: CategoryId,
): Promise<{ moves: CategoryMove[]; skipped: number; failed: string[] }> {
  const moves: CategoryMove[] = [];
  const failed: string[] = [];
  let skipped = 0;

  for (const entity of entities) {
    if (entity.category === category) {
      skipped++;
      continue;
    }
    try {
      // index.md 缺失不是错：扫描器允许，重建一份最小正文即可。summary/aliases 用
      // 扫描到的值——它们本来就是从这个文件读出来的。
      let body = `# ${entity.name}\n`;
      try {
        body = parseFrontmatter(await readFile(`${entity.dirPath}/index.md`)).content;
      } catch {
        // no index.md — the write below creates one from the scanned metadata
      }
      const from = entity.dirPath;
      const moved = await saveEntityMetaAndBody(
        projectPath,
        entity,
        {
          name: entity.name,
          aliases: entity.aliases ?? [],
          category,
          summary: entity.summary,
          // 显式带上——`dict` 的那条纪律在这里同样适用。
          dict: entity.dict,
        },
        body,
      );
      moves.push({ from, to: moved.dirPath });
    } catch (e) {
      console.warn(`[lore] could not move ${entity.dirPath} to ${category}:`, e);
      failed.push(entity.name);
    }
  }
  return { moves, skipped, failed };
}

// ─── Entity metadata persistence ─────────────────────────────────────────────

/** Serialize entity metadata to the index.md YAML frontmatter block. */
export function serializeEntityFrontmatter(meta: EntityMeta): string {
  const collections = normalizeCollections(meta.collections);
  const aliasBlock = meta.aliases.length
    ? `aliases:\n${meta.aliases.map((a) => `  - ${yamlQuote(a)}`).join("\n")}`
    : `aliases: []`;
  return [
    "---",
    `name: ${yamlQuote(meta.name)}`,
    aliasBlock,
    `category: ${meta.category}`,
    `summary: ${yamlQuote(meta.summary)}`,
    // Only marked dictionaries carry the line — every other entity's
    // frontmatter stays exactly what it was before the field existed.
    ...(meta.dict ? ["dict: true"] : []),
    // Same rule for collections: 未归集 writes no line at all, so an existing
    // knowledge base is byte-identical until the author actually files an entry.
    // Written as a JSON-quoted inline array so names with commas or brackets
    // round-trip through the line-based parser.
    ...(collections.length
      ? [`collections: [${collections.map((c) => JSON.stringify(c)).join(", ")}]`]
      : []),
    "---",
    "",
  ].join("\n");
}

/**
 * Persist metadata + body to the entity's index.md. When the category changed,
 * the whole entity folder is moved into the new category directory — the
 * scanner derives an entity's category from its folder location, so writing
 * the frontmatter alone would silently revert on the next scan. A **rename**
 * relocates too: the folder is re-slugged from the new name, so the directory
 * an author (or a backup listing) reads keeps saying what is inside it. Same
 * blast radius as a category move — `[[lore:category/id]]` path citations and
 * facet pins to the old folder go stale (both already tolerate that: citations
 * fall back to name matching, stale pins are skipped).
 * Returns where the entity now lives (unchanged when neither moved it).
 */
export async function saveEntityMetaAndBody(
  projectPath: string,
  entity: LoreEntity,
  meta: EntityMeta,
  body: string,
): Promise<{ dirPath: string; category: CategoryId; id: string }> {
  // `collections` defaults to what the entity already has, rather than being a
  // field every caller must remember to carry (the trap `dict` documents, with
  // six write sites to get wrong). Omitting it means "leave the filing alone";
  // clearing it is an explicit `[]`, which is distinguishable from undefined.
  const filed: EntityMeta = { ...meta, collections: meta.collections ?? entity.collections };
  const content = serializeEntityFrontmatter(filed) + "\n" + body.trimStart();
  await writeFile(`${entity.dirPath}/index.md`, content);

  // Re-slug only when the *name* changed: slugifyEntityId(name) rarely equals
  // the stored id even for an unchanged name (collision suffixes, legacy ids),
  // and re-slugging on every save would shuffle folders under saves that never
  // touched the name.
  const desiredId =
    meta.name !== entity.name ? slugifyEntityId(meta.name) : entity.id;
  if (meta.category === entity.category && desiredId === entity.id) {
    return { dirPath: entity.dirPath, category: entity.category, id: entity.id };
  }
  const newId = await uniqueEntityId(projectPath, meta.category, desiredId);
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
