/**
 * Lore writes on an entry's files: creating an entry or facet, updating / appending to / editing its files, facet surgery.
 *
 * Part of the L1/L2 write tools, split out of `writeTools.ts` by section
 * (docs/feature/code-structure-plan.md P6); `writeTools.ts` re-exports the
 * tools, so importers keep one address. The policy every handler follows is
 * in that file's header.
 */


import { categoryFacetSlots, findFacetSlot, loreCategoryIds } from "../../profile/active";
import { RESERVED_ENTITY_FILES, concreteScopeCollections, createEntityWithContent, facetFileName, isGalleryManifest, isPlainEntityFilename, normalizeCollections, sameCollection, parseFacetMeta, readEntityFile, saveEntityMetaAndBody, saveFacetFile, slugifyEntityId, uniqueEntityId, withSlotDefaults, writeEntityFile, type CategoryId, type FacetMeta, type LoreEntity, type LoreFacet } from "../../lore";
import { parseFrontmatter } from "../../fs/markdown";
import { removeFile } from "../../fs/fileio";
import { isMajorRewrite } from "../destructive";
import { backupFile, changeAfterWrite, changeOf, snapshotFile } from "../backup";
import { applyFindReplace, countLines, describeEditTarget, findOccurrences, sliceLines, type EditTarget } from "../editApply";
import { lineOfOffset } from "../lineEcho";
import type { ToolContext } from "../registry";
import { allEntityNames, findEntityByName, type ToolResult } from "../tools";

import { withAlias } from "./shared";
import { syncLore, MERGE_ALIAS_HINT, NO_CATEGORY_TOOL_HINT, gate, pauseForStep, rewritePreview, currentText } from "./planGate";
import { appliedReceipt } from "./manuscript";

// ─── create_lore_entity ──────────────────────────────────────────────────────

export async function createLoreEntityTool(
  toolCallId: string,
  args: { name?: string; category?: string; summary?: string; aliases?: string[]; content?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const name = args.name?.trim();
  if (!name) return { toolCallId, content: "Error: 'name' argument is required." };

  const categoryIds = loreCategoryIds();
  const category = args.category as CategoryId;
  if (!category || !categoryIds.includes(category)) {
    return {
      toolCallId,
      content: `Error: 'category' must be one of: ${categoryIds.join(", ")}. ${NO_CATEGORY_TOOL_HINT}`,
    };
  }

  const content = args.content?.trim();
  if (!content) {
    return {
      toolCallId,
      content:
        "Error: 'content' argument is required — the entity's body markdown (do not include frontmatter; it is generated from the other arguments).",
    };
  }

  const existing = findEntityByName(ctx.loreIndex, name);
  if (existing) {
    return {
      toolCallId,
      content: `Error: an entity named "${existing.name}" already exists (category: ${existing.category}). Use update_lore_file to modify it instead.`,
    };
  }

  const gated = gate(toolCallId, ctx, "create", name);
  if ("refusal" in gated) return gated.refusal;

  const aliases = (args.aliases ?? []).map((a) => String(a).trim()).filter(Boolean);
  const summary = args.summary?.trim() ?? "";
  const entityId = await uniqueEntityId(ctx.projectPath, category, slugifyEntityId(name));
  // Filed into every real collection in the active 取材范围: an entry created
  // inside a narrowed working set that lands 未归集 would vanish from the very
  // list the model just read (see ToolContext.loreScope). A scope of only
  // 未归集 (or none) files it nowhere — which is already in scope.
  const collections = concreteScopeCollections(ctx.loreScope ?? null);
  const dirPath = await createEntityWithContent(
    ctx.projectPath, category, entityId, name, aliases, summary, content,
    { collections },
  );

  // Insert into the run snapshot before resyncing, mirroring what
  // relocateInSnapshot does for move/delete. syncLore overwrites this with disk
  // truth a line later on any surface that can rescan — this is what keeps the
  // new entity resolvable on one that cannot, or when the rescan fails.
  (ctx.loreIndex[category] ??= []).push({
    id: entityId, category, dirPath, name, aliases, summary, collections,
    // refs stays empty even if the body the model just wrote cites something:
    // syncLore's rescan is what fills it, same as facets. Guessing here would
    // be a second parser to keep in step with `readEntity`'s.
    avatarPath: null, mdFiles: ["index.md"], images: [], facets: [], refs: [],
  });
  await syncLore(ctx);
  return {
    toolCallId,
    content:
      `Created lore entity "${name}" (category: ${category}) at ${dirPath}. ` +
      `Plan step: ${gated.step.detail}. The lore index has been refreshed.`,
    // The entry as it actually landed: the frontmatter around the model's text
    // is composed down in the lore layer, so nothing up here holds the file.
    change: await changeAfterWrite({
      projectPath: ctx.projectPath,
      path: `${dirPath}/index.md`,
      entity: name,
    }),
  };
}

// ─── update_lore_file ────────────────────────────────────────────────────────

/**
 * Validate a model-supplied filename as a writable file inside the entity dir.
 * The argument is model-controlled, so anything that could navigate ('/', '\',
 * '..') is refused, as is the app-managed gallery file. index.md IS allowed
 * here — `checkFacetFilename` is the stricter variant for the tools that may
 * only touch facets.
 */
export function checkEntityFilename(toolCallId: string, raw: unknown): ToolResult | string {
  const file = String(raw ?? "").trim();
  if (!isPlainEntityFilename(file)) {
    return {
      toolCallId,
      content: "Error: 'file' must be a plain .md filename inside the entity directory (no paths).",
    };
  }
  if (isGalleryManifest(file)) {
    return {
      toolCallId,
      content:
        "Error: images.md is app-managed and cannot be written directly — change the gallery with update_lore_image / delete_lore_image / copy_lore_file / generate_image instead.",
    };
  }
  return file;
}

/** 一行能读的归属，给拒绝信息用；未归集说成 none 而不是一对空方括号。 */
function collectionLine(names: readonly string[]): string {
  return names.length ? names.map((c) => `"${c}"`).join(", ") : "none";
}

export async function updateLoreFileTool(
  toolCallId: string,
  args: { entity?: string; file?: string; content?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const entityName = args.entity?.trim();
  if (!entityName) return { toolCallId, content: "Error: 'entity' argument is required." };
  const entity = findEntityByName(ctx.loreIndex, entityName);
  if (!entity) {
    return {
      toolCallId,
      content: `Error: entity "${entityName}" not found. Available: ${allEntityNames(ctx.loreIndex) || "none"}`,
    };
  }

  const checked = checkEntityFilename(toolCallId, args.file ?? "index.md");
  if (typeof checked !== "string") return checked;
  const file = checked;

  const content = args.content ?? "";
  if (!content.trim()) {
    return { toolCallId, content: "Error: 'content' argument is required (the complete new file content)." };
  }

  // ── Structural validation before any disk write ──
  if (file === "index.md") {
    const { data } = parseFrontmatter(content);
    // 盘上现在写着什么，是这三条纪律（改名 / 换分类 / 归属与封面）的唯一依据：
    // `ctx.loreIndex` 是运行开始时的快照，同一次运行里的 file_lore_entries、或者
    // 作者在别处的一次归集，改的都是盘上这一行。读不出来就退回快照——没有 index.md
    // 的条目照样存在（扫描器允许），不该因此拒绝一次写入。
    let onDisk: Record<string, unknown> = {};
    try {
      onDisk = parseFrontmatter(await readEntityFile(entity.dirPath, "index.md")).data;
    } catch {
      onDisk = { collections: entity.collections ?? [], cover: entity.cover ?? null };
    }
    if (typeof data.name !== "string" || !data.name.trim()) {
      return {
        toolCallId,
        content:
          "Error: index.md must start with YAML frontmatter containing at least `name` (plus `aliases`, `category`, `summary`). Send the complete file including frontmatter.",
      };
    }
    if (typeof data.category === "string" && data.category !== entity.category) {
      return {
        toolCallId,
        content: `Error: changing the category (${entity.category} → ${data.category}) is not supported by this tool — keep \`category: ${entity.category}\`.`,
      };
    }
    // A rename through a whole-file write would bypass everything
    // move_lore_entity does on purpose: the clash check against other entities'
    // names/aliases, keeping the old name as an alias, and relocating the
    // folder. Same funnel discipline as the category line above.
    if (data.name.trim() !== entity.name) {
      return {
        toolCallId,
        content: `Error: renaming (${entity.name} → ${data.name.trim()}) is not supported by this tool — keep \`name: ${entity.name}\` and use move_lore_entity to rename (it checks name clashes and keeps the old name as an alias).`,
      };
    }
    // The dict flag marks a translation dictionary — the author's own switch in
    // the entry editor, which no agent write may flip (same policy as
    // update_lore_meta, which carries it through untouched).
    const wantsDict = data.dict === true || data.dict === "true";
    if (wantsDict !== !!entity.dict) {
      return {
        toolCallId,
        content: `Error: the \`dict\` flag is set by the author in the entry editor and cannot be changed by the agent — ${entity.dict ? "keep `dict: true`" : "omit the `dict` line"}.`,
      };
    }
    // 归属和封面不是正文，agent 也没有在这里改它们的正当路子：归属走方案门下的
    // file_lore_entries，封面只有作者在 lightbox 里设。而重发整份 frontmatter 时
    // 漏掉一行是最容易发生的事——漏掉的后果是这一条静静掉出它所有的集合。所以照
    // `dict` 的老规矩拒绝，并把该照抄的那一行原样交回去。
    const diskCollections = normalizeCollections(onDisk.collections);
    const sentCollections = normalizeCollections(data.collections);
    if (
      sentCollections.length !== diskCollections.length ||
      !diskCollections.every((c, i) => sameCollection(c, sentCollections[i]))
    ) {
      return {
        toolCallId,
        content:
          `Error: this write would change the entry's collections (${collectionLine(diskCollections)} → ${collectionLine(sentCollections)}). ` +
          "Filing is the author's, and it goes through file_lore_entries — never through a whole-file write. " +
          "If you do not have that tool, it is because it loads only once the author approves a plan step whose `target` is 'collection': call propose_lore_plan again with that step, then file. " +
          (diskCollections.length
            ? `Resend the file with this line in the frontmatter, exactly: \`collections: [${diskCollections.map((c) => JSON.stringify(c)).join(", ")}]\``
            : "Resend the file with no `collections` line at all."),
      };
    }
    const diskCover = typeof onDisk.cover === "string" && onDisk.cover.trim() ? onDisk.cover.trim() : null;
    const sentCover = typeof data.cover === "string" && data.cover.trim() ? data.cover.trim() : null;
    if (diskCover !== sentCover) {
      return {
        toolCallId,
        content:
          `Error: \`cover\` names the entry's header picture and is set by the author in the gallery lightbox — this tool cannot change it. ` +
          (diskCover ? `Keep \`cover: ${JSON.stringify(diskCover)}\`.` : "Omit the `cover` line."),
      };
    }
    // Same rule as update_lore_meta: only the aliases this write introduces are
    // vetted, so a pre-existing collision never blocks an unrelated edit.
    if (Array.isArray(data.aliases)) {
      const nextAliases = data.aliases.map((a) => String(a).trim()).filter(Boolean);
      const added = nextAliases.filter(
        (a) => !(entity.aliases ?? []).some((b) => b.toLowerCase() === a.toLowerCase()),
      );
      for (const alias of added) {
        const clash = findEntityByName(ctx.loreIndex, alias);
        if (clash && clash !== entity) {
          return {
            toolCallId,
            content: `Error: the alias "${alias}" already resolves to entity "${clash.name}" (category: ${clash.category}) — both would become unresolvable by name. ${MERGE_ALIAS_HINT}`,
          };
        }
      }
    }
  } else if (entity.facets.some((f) => f.file === file)) {
    // Existing facet must remain a parseable facet.
    if (!parseFacetMeta(content, file)) {
      return {
        toolCallId,
        content:
          `Error: ${file} is a facet file — the new content must keep frontmatter with a \`facet\` title (plus \`keys\`, optional \`group\`/\`priority\`/\`mode\`), otherwise it would stop being injected.`,
      };
    }
  }

  // Gated last, so a step only counts as fulfilled once a write really happens.
  const gated = gate(toolCallId, ctx, "update", entity.name, file);
  if ("refusal" in gated) return gated.refusal;

  // A whole-file write is the one that can quietly replace an entry wholesale.
  const replacing = await currentText(entity.dirPath, file);
  if (replacing !== null && isMajorRewrite(replacing, content)) {
    const skipped = await pauseForStep(
      toolCallId, ctx, gated.step,
      rewritePreview(`${entity.dirPath}/${file}`, entity, file, replacing, content),
    );
    if (skipped) return skipped;
  }

  const targetPath = `${entity.dirPath}/${file}`;
  const snap = await snapshotFile(ctx.projectPath, targetPath);
  const backupPath = snap?.path ?? null;
  await writeEntityFile(entity.dirPath, file, content);

  await syncLore(ctx, entity);
  const suffix = backupPath
    ? `Previous version backed up to ${backupPath}.`
    : "This is a new file (no backup needed).";
  // A new .md that is not a facet is an attachment, and an attachment is never
  // injected. Reporting that plainly is the difference between the model fixing
  // it in the next round and the author finding it on the entry page weeks
  // later — which is exactly how this tool used to swallow "split into facets".
  const inert =
    !backupPath && file !== "index.md" && !parseFacetMeta(content, file)
      ? ` NOTE: ${file} has no \`facet\` frontmatter, so it is an inert ATTACHMENT and will never be injected. ` +
        `If it was meant to be a facet, call create_lore_facet(entity, title, file: "${file}") — it keeps this text and adds the frontmatter.`
      : "";
  return {
    toolCallId,
    content:
      `Wrote ${file} of entity "${entity.name}". ${suffix}` + inert + " " +
      `Plan step: ${gated.step.detail}. The lore index has been refreshed.`,
    change: changeOf({
      projectPath: ctx.projectPath,
      path: targetPath,
      entity: entity.name,
      before: snap?.text,
      after: content,
      backupPath,
    }),
  };
}

// ─── update_lore_meta / append_lore_file / edit_lore_file ────────────────────

/**
 * Surgical alternatives to `update_lore_file`.
 *
 * Whole-file replacement is the only *complete* write — every change can be
 * expressed as "send the new file" — but it is the wrong instrument for the
 * three commonest edits, and expensively so. To fix one line of `summary`, to
 * add a paragraph, or to correct one sentence, the model must first read the
 * entity back and then re-emit every character of it: the content is paid for
 * twice, and each re-emitted character is one the model can quietly paraphrase
 * on the way past. That is the failure the author never catches, because the
 * diff they would have to read is the whole file.
 *
 * So the split `update_facet_meta` already made for facet metadata is made for
 * the rest of an entity:
 *
 *   update_lore_meta  — index.md frontmatter only; the body is carried through
 *   append_lore_file  — adds at the end; nothing existing is re-sent at all
 *   edit_lore_file    — one unique find/replace inside the body
 *
 * All three read from disk and put the frontmatter block back byte-for-byte
 * (`splitFrontmatter`) or regenerate it from typed fields (update_lore_meta).
 * That is what makes the structural validation `update_lore_file` performs
 * unnecessary here rather than merely skipped: a write that cannot reach the
 * frontmatter cannot change a category, cannot drop a `name`, and cannot
 * deactivate a facet by losing its `facet:` field.
 */

/**
 * Split a lore file into its frontmatter block and everything after it, such
 * that `head + body === raw`.
 *
 * Deliberately not `parseFrontmatter`, which trimStart()s the body and hands
 * back parsed data: these tools need the head as the *original bytes*, so
 * putting it back cannot reformat YAML the author hand-wrote.
 */
function splitFrontmatter(raw: string): { head: string; body: string } {
  if (!raw.startsWith("---")) return { head: "", body: raw };
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return { head: "", body: raw };
  // Keep the remainder of the closing delimiter's line with the head, so the
  // body starts at a line boundary.
  const nl = raw.indexOf("\n", end + 4);
  const cut = nl === -1 ? raw.length : nl + 1;
  return { head: raw.slice(0, cut), body: raw.slice(cut) };
}

/** Resolve a model-supplied entity name, or the error to hand straight back. */
export function requireEntity(
  toolCallId: string,
  ctx: ToolContext,
  raw: string | undefined,
): LoreEntity | ToolResult {
  const name = raw?.trim();
  if (!name) return { toolCallId, content: "Error: 'entity' argument is required." };
  const entity = findEntityByName(ctx.loreIndex, name);
  if (!entity) {
    return {
      toolCallId,
      content: `Error: entity "${name}" not found. Available: ${allEntityNames(ctx.loreIndex) || "none"}`,
    };
  }
  return entity;
}

/** The entity's own .md files, for the "which files are there?" error text. */
export function facetFileList(entity: LoreEntity): string {
  const known = (entity.mdFiles ?? []).filter((f) => !RESERVED_ENTITY_FILES.includes(f));
  return known.join(", ") || "none";
}

/**
 * Re-derive a facet's cached body length after a body-only write, so the run
 * snapshot's token estimates don't lag the file. Re-parsing rather than
 * measuring by hand keeps `charCount` defined in exactly one place
 * (`parseFacetMeta`), which is where the UI reads it from.
 */
function refreshFacetInSnapshot(entity: LoreEntity, file: string, raw: string): void {
  const at = (entity.facets ?? []).findIndex((f) => f.file === file);
  if (at < 0) return;
  const parsed = parseFacetMeta(raw, file);
  if (parsed) entity.facets[at] = parsed;
}

export async function updateLoreMetaTool(
  toolCallId: string,
  args: { entity?: string; summary?: string; aliases?: string[]; add_aliases?: string[] },
  ctx: ToolContext,
): Promise<ToolResult> {
  const found = requireEntity(toolCallId, ctx, args.entity);
  if ("toolCallId" in found) return found;
  const entity = found;

  const touches = ["summary", "aliases", "add_aliases"].filter((k) => k in args);
  if (touches.length === 0) {
    return {
      toolCallId,
      content:
        "Error: pass at least one of summary / aliases / add_aliases. This tool edits index.md's frontmatter only — " +
        "for the body use edit_lore_file or append_lore_file, and for the name or category use move_lore_entity (both move the folder).",
    };
  }
  if ("aliases" in args && "add_aliases" in args) {
    return {
      toolCallId,
      content: "Error: pass either 'aliases' (replaces the whole list) or 'add_aliases' (appends to it), not both.",
    };
  }

  // Disk is the source of truth for what the frontmatter currently says, and
  // the body has to be carried through verbatim — same reasoning as
  // update_facet_meta, and the only thing that works on a surface with no
  // rescan. A missing index.md is not an error: the entity exists (it was
  // scanned), so this rebuilds one from the scanned metadata.
  let body = `# ${entity.name}\n`;
  let name = entity.name;
  let aliases = entity.aliases ?? [];
  let summary = entity.summary;
  // 归属与封面同样从盘上读，而不是让 `saveEntityMetaAndBody` 从手上这份 entity 补
  // 默认值：`ctx.loreIndex` 是运行开始时的快照，而同一次运行里的 `file_lore_entries`
  // （以及作者在别处的一次归集）都改的是盘上这一行。信快照的话，改一句简介就会把
  // 那次归集静静写回旧值——作者收不到任何提示。
  let collections = entity.collections ?? [];
  let cover = entity.cover ?? null;
  try {
    const parsed = parseFrontmatter(await readEntityFile(entity.dirPath, "index.md"));
    body = parsed.content;
    if (typeof parsed.data.name === "string" && parsed.data.name.trim()) name = parsed.data.name.trim();
    if (Array.isArray(parsed.data.aliases)) {
      aliases = parsed.data.aliases.map((a) => String(a).trim()).filter(Boolean);
    }
    if (typeof parsed.data.summary === "string") summary = parsed.data.summary;
    collections = normalizeCollections(parsed.data.collections);
    cover = typeof parsed.data.cover === "string" && parsed.data.cover.trim()
      ? parsed.data.cover.trim()
      : null;
  } catch {
    // no index.md — rebuilt below from the scanned metadata
  }

  const aliasesBefore = aliases;
  if ("summary" in args) {
    if (typeof args.summary !== "string") {
      return { toolCallId, content: "Error: 'summary' must be a string." };
    }
    summary = args.summary.trim();
  }
  if ("aliases" in args) {
    if (!Array.isArray(args.aliases)) {
      return { toolCallId, content: "Error: 'aliases' must be an array of strings (it replaces the current list)." };
    }
    aliases = args.aliases.map((a) => String(a).trim()).filter(Boolean);
  }
  if ("add_aliases" in args) {
    if (!Array.isArray(args.add_aliases)) {
      return { toolCallId, content: "Error: 'add_aliases' must be an array of strings." };
    }
    for (const raw of args.add_aliases) {
      const alias = String(raw).trim();
      if (alias) aliases = withAlias(aliases, alias);
    }
  }

  // An alias another entity already answers to would make both unresolvable by
  // name — the same ambiguity move_lore_entity refuses on a rename. Only the
  // aliases this call introduces are checked: a collision that predates the
  // call is not something a summary edit should be blocked on, and refusing it
  // would leave the author no way to fix the entry from here.
  const added = aliases.filter(
    (a) => !aliasesBefore.some((b) => b.toLowerCase() === a.toLowerCase()),
  );
  for (const alias of added) {
    const clash = findEntityByName(ctx.loreIndex, alias);
    if (clash && clash !== entity) {
      return {
        toolCallId,
        content: `Error: the alias "${alias}" already resolves to entity "${clash.name}" (category: ${clash.category}) — both would become unresolvable by name. ${MERGE_ALIAS_HINT}`,
      };
    }
  }

  const gated = gate(toolCallId, ctx, "update", entity.name, "index.md");
  if ("refusal" in gated) return gated.refusal;

  const indexPath = `${entity.dirPath}/index.md`;
  const snap = await snapshotFile(ctx.projectPath, indexPath);
  const backupPath = snap?.path ?? null;
  await saveEntityMetaAndBody(
    ctx.projectPath,
    entity,
    // dict is carried through, never set here: marking a dictionary is the
    // author's explicit act in the entity editor (see EntityMeta.dict).
    // collections / cover are passed **explicitly** from what disk says rather
    // than left to `saveEntityMetaAndBody`'s default: that default reads them
    // off `entity`, which is this run's snapshot and may predate a filing made
    // since it was taken.
    { name, aliases, category: entity.category, summary, dict: entity.dict, collections, cover },
    body,
  );
  entity.aliases = aliases;
  entity.summary = summary;
  entity.collections = collections;
  entity.cover = cover;

  await syncLore(ctx, entity);
  const changed = [
    "summary" in args ? `summary="${summary}"` : null,
    "aliases" in args || "add_aliases" in args ? `aliases=[${aliases.join(", ")}]` : null,
  ].filter(Boolean);
  return {
    toolCallId,
    content:
      `Updated the frontmatter of "${entity.name}": ${changed.join(", ")}. The body was left untouched.` +
      (backupPath ? ` Previous index.md backed up to ${backupPath}.` : "") +
      ` Plan step: ${gated.step.detail}. The lore index has been refreshed.`,
    // Read back rather than composed here: the frontmatter block is regenerated
    // down in the lore layer, and the record is meant to say what landed.
    change: await changeAfterWrite({
      projectPath: ctx.projectPath,
      path: indexPath,
      entity: entity.name,
      before: snap?.text,
      backupPath,
    }),
  };
}

export async function appendLoreFileTool(
  toolCallId: string,
  args: { entity?: string; file?: string; content?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const found = requireEntity(toolCallId, ctx, args.entity);
  if ("toolCallId" in found) return found;
  const entity = found;

  const checked = checkEntityFilename(toolCallId, args.file ?? "index.md");
  if (typeof checked !== "string") return checked;
  const file = checked;

  const addition = (args.content ?? "").trim();
  if (!addition) {
    return { toolCallId, content: "Error: 'content' argument is required (the text to add at the end)." };
  }
  // A whole file where a section was asked for. Appended, its frontmatter would
  // sit stranded in the middle of the body — markdown the scanner reads as
  // prose and the author reads as corruption. The model meant update_lore_file.
  if (addition.startsWith("---")) {
    return {
      toolCallId,
      content:
        "Error: 'content' starts with a frontmatter delimiter, so it looks like a complete file. Send ONLY the new text — " +
        "the existing frontmatter and body stay exactly where they are. Use update_lore_file to replace a whole file.",
    };
  }

  let raw: string;
  try {
    raw = await readEntityFile(entity.dirPath, file);
  } catch {
    return {
      toolCallId,
      content:
        `Error: "${file}" does not exist in entity "${entity.name}" (its files: ${facetFileList(entity)}). ` +
        "Create it with update_lore_file, which takes the complete content including frontmatter.",
    };
  }

  const gated = gate(toolCallId, ctx, "update", entity.name, file);
  if ("refusal" in gated) return gated.refusal;

  // One blank line between what was there and what arrives, always. The
  // manuscript-side append_file makes the model spell out its own separator,
  // which is right for prose where the join is the author's decision; here the
  // payload is structure (a new `##` section, another list item) and a missing
  // blank line silently welds it onto the last paragraph.
  const next = `${raw.replace(/\s+$/, "")}\n\n${addition}\n`;
  const backupPath = await backupFile(ctx.projectPath, `${entity.dirPath}/${file}`);
  await writeEntityFile(entity.dirPath, file, next);
  refreshFacetInSnapshot(entity, file, next);

  await syncLore(ctx, entity);
  // Where the entry now ends. Nothing above the addition moved, so one number
  // is the whole update — the same answer append_file gives on the manuscript
  // side (edit-loop-plan.md §5.3), and the coordinate search_text reports for
  // a knowledge-base hit.
  const endLine = await loreEndLine(entity.dirPath, file);
  return {
    toolCallId,
    content:
      `Appended ${addition.length} chars to the end of ${file} on entity "${entity.name}". ` +
      `Everything already in the file is unchanged.` +
      (endLine ? ` It now ends at line ${endLine}.` : "") +
      (backupPath ? ` Previous version backed up to ${backupPath}.` : "") +
      ` Plan step: ${gated.step.detail}.`,
    change: changeOf({
      projectPath: ctx.projectPath,
      path: `${entity.dirPath}/${file}`,
      entity: entity.name,
      before: raw,
      after: next,
      backupPath,
    }),
  };
}

/** An entry file's last line number, or 0 if it cannot be read back. */
async function loreEndLine(dirPath: string, file: string): Promise<number> {
  try {
    return countLines(await readEntityFile(dirPath, file));
  } catch {
    return 0;
  }
}

export async function editLoreFileTool(
  toolCallId: string,
  args: {
    entity?: string;
    file?: string;
    find?: string;
    replace?: string;
    occurrence?: number;
    replace_all?: boolean;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const found = requireEntity(toolCallId, ctx, args.entity);
  if ("toolCallId" in found) return found;
  const entity = found;

  const checked = checkEntityFilename(toolCallId, args.file ?? "index.md");
  if (typeof checked !== "string") return checked;
  const file = checked;

  const find = typeof args.find === "string" ? args.find : "";
  if (!find) {
    return { toolCallId, content: "Error: 'find' argument is required — the exact text to replace, copied from the file." };
  }
  if (typeof args.replace !== "string") {
    return { toolCallId, content: "Error: 'replace' argument is required (pass an empty string to delete the found text)." };
  }
  const replace = args.replace;
  if (replace === find) {
    return { toolCallId, content: "Error: 'replace' is identical to 'find', so nothing would change." };
  }

  let raw: string;
  try {
    raw = await readEntityFile(entity.dirPath, file);
  } catch {
    return {
      toolCallId,
      content: `Error: "${file}" does not exist in entity "${entity.name}" (its files: ${facetFileList(entity)}).`,
    };
  }

  // The match is looked for in the body alone, and the head is put back
  // untouched: metadata has its own tools precisely because find/replace over
  // YAML is how a facet silently stops being injected.
  const { head, body } = splitFrontmatter(raw);
  const positions = findOccurrences(body, find);
  if (positions.length === 0) {
    return {
      toolCallId,
      content:
        `Error: that 'find' text does not appear in the body of ${file}. ` +
        (head.includes(find)
          ? "It is in the frontmatter, which this tool never touches — use update_lore_meta (index.md) or update_facet_meta (a facet) for metadata."
          : "Read the file with read_lore_entity and copy the snippet exactly, whitespace and line breaks included."),
    };
  }

  const target = resolveEditTarget(toolCallId, args, positions.length, () =>
    // The lines are the *file's*, frontmatter counted — the same coordinates
    // search_text reports for a knowledge-base hit. Naming them turns an
    // ambiguity refusal into something the model can act on in this same
    // round, instead of a read to find out where the other matches were.
    positions.map((at) => lineOfOffset(raw, head.length + at)).join(", "),
  );
  if (typeof target === "object") return target;

  const gated = gate(toolCallId, ctx, "update", entity.name, file);
  if ("refusal" in gated) return gated.refusal;

  // Sliced rather than String.replace: a replacement containing `$&` or `$1`
  // would otherwise be expanded as a pattern reference, silently writing
  // something other than what was approved. Shared with propose_edit's apply
  // step, so "the third occurrence" means the same thing on both sides of the
  // app — `positions.length` is passed as the count because counting and
  // applying happen in the same call here, with no card in between for the
  // author to invalidate.
  const next = head + applyFindReplace(body, find, replace, positions.length, target);
  if (isMajorRewrite(raw, next)) {
    const skipped = await pauseForStep(
      toolCallId, ctx, gated.step,
      rewritePreview(`${entity.dirPath}/${file}`, entity, file, raw, next),
    );
    if (skipped) return skipped;
  }
  const backupPath = await backupFile(ctx.projectPath, `${entity.dirPath}/${file}`);
  await writeEntityFile(entity.dirPath, file, next);
  refreshFacetInSnapshot(entity, file, next);

  await syncLore(ctx, entity);
  const which = describeEditTarget(positions.length, target);
  return {
    toolCallId,
    content:
      `Replaced ${find.length} chars with ${replace.length} in ${file} on entity "${entity.name}"` +
      `${which ? ` (${which})` : ""}. The rest of the file, and its frontmatter, are unchanged.` +
      (backupPath ? ` Previous version backed up to ${backupPath}.` : "") +
      ` Plan step: ${gated.step.detail}.` +
      (await loreEditReceipt(entity.dirPath, file, raw, head.length, find, positions, target)),
    change: changeOf({
      projectPath: ctx.projectPath,
      path: `${entity.dirPath}/${file}`,
      entity: entity.name,
      before: raw,
      after: next,
      backupPath,
    }),
  };
}

/**
 * Which occurrence(s) an edit means, or the refusal to hand back.
 *
 * The three ways out of an ambiguous `find` are `propose_edit`'s, deliberately:
 * a model that has learned "make it unique, or say which one, or say all of
 * them" on the manuscript should not have to learn a different answer for the
 * knowledge base. Before this, the knowledge base had only the first of the
 * three, so repeated text — the same phrase in two facets' worth of prose, a
 * name in a timeline — was not addressable at all and the only way through was
 * `update_lore_file` re-emitting the whole entry.
 */
function resolveEditTarget(
  toolCallId: string,
  args: { occurrence?: number; replace_all?: boolean },
  hits: number,
  where: () => string,
): EditTarget | ToolResult {
  const all = args.replace_all === true;
  const nth = typeof args.occurrence === "number" ? args.occurrence : undefined;

  if (all && nth !== undefined) {
    return {
      toolCallId,
      content: "Error: pass either 'occurrence' or replace_all=true, not both.",
    };
  }
  if (nth !== undefined && (!Number.isInteger(nth) || nth < 1 || nth > hits)) {
    return {
      toolCallId,
      content:
        `Error: 'occurrence' must be a whole number between 1 and ${hits} — that text appears ${hits} time(s) ` +
        `in this file (on line(s) ${where()}).`,
    };
  }
  if (hits > 1 && !all && nth === undefined) {
    return {
      toolCallId,
      content:
        `Error: that 'find' text appears ${hits} times in this file, on line(s) ${where()}. ` +
        "Say which one you mean: include enough surrounding text to make 'find' unique, pass 'occurrence' " +
        "for the Nth, or pass replace_all=true to change every one.",
    };
  }
  return all ? "all" : nth;
}

/**
 * What the entry now says where the edit landed — the knowledge base's half of
 * §4.3.
 *
 * Until this existed a lore edit came back as "Replaced 12 chars with 15", from
 * which the model can tell that *something* was written and nothing about
 * whether the sentence it now sits in reads correctly. On the manuscript side
 * that gap was worth a whole extra round; here it was worth the same round and
 * additionally hid the failure mode that matters most in an entry — a snippet
 * that matched inside a neighbouring sentence and welded two of them together.
 *
 * Line numbers count the frontmatter, because those are the coordinates
 * everything else on this side reports (search_text's knowledge-base hits) and
 * two numbering schemes for one file is worse than none.
 */
async function loreEditReceipt(
  dirPath: string,
  file: string,
  before: string,
  headLength: number,
  find: string,
  positions: number[],
  target: EditTarget,
): Promise<string> {
  // Several places changed at once: the shifts accumulate down the file, so
  // there is no single region to show and no single number that describes what
  // moved. Saying so is the honest answer (propose_edit gives the same one).
  if (target === "all" && positions.length > 1) {
    return (
      ` ${positions.length} places changed, so line numbers below the first one have all moved —` +
      " read the entry again before relying on them."
    );
  }
  const at = positions[typeof target === "number" ? target - 1 : 0];
  if (at === undefined) return "";
  const from = lineOfOffset(before, headLength + at);
  const to = lineOfOffset(before, headLength + at + Math.max(0, find.length - 1));
  return appliedReceipt(`${dirPath}/${file}`, before, from, to);
}

/**
 * Replace a line region of an entity file — `rewrite_lines` for the knowledge
 * base (edit-loop-plan.md §14 L3). Same coordinate system as everything else
 * on this side: line numbers count the whole file, frontmatter included, and
 * come from `read_lore_entity`'s numbering. The frontmatter itself is refused
 * — a line-range rewrite over YAML is how a facet silently stops being
 * injected, which is the same reason `edit_lore_file` matches the body only.
 */
export async function rewriteLoreLinesTool(
  toolCallId: string,
  args: { entity?: string; file?: string; start_line?: number; end_line?: number; content?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const found = requireEntity(toolCallId, ctx, args.entity);
  if ("toolCallId" in found) return found;
  const entity = found;

  const checked = checkEntityFilename(toolCallId, args.file ?? "index.md");
  if (typeof checked !== "string") return checked;
  const file = checked;

  if (typeof args.content !== "string") {
    return {
      toolCallId,
      content: "Error: 'content' argument is required (the replacement text for those lines; an empty string deletes them).",
    };
  }
  const from = Math.floor(Number(args.start_line));
  const to = Math.floor(Number(args.end_line));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) {
    return {
      toolCallId,
      content: "Error: 'start_line' and 'end_line' must be whole numbers with start_line ≥ 1 and end_line ≥ start_line (read_lore_entity numbers the lines).",
    };
  }

  let raw: string;
  try {
    raw = await readEntityFile(entity.dirPath, file);
  } catch {
    return {
      toolCallId,
      content: `Error: "${file}" does not exist in entity "${entity.name}" (its files: ${facetFileList(entity)}).`,
    };
  }

  // The frontmatter's line span. `head` keeps the closing delimiter's whole
  // line, so its line count is exactly the lines a region may not touch.
  const { head } = splitFrontmatter(raw);
  const headLines = head === "" ? 0 : head.split("\n").length - (head.endsWith("\n") ? 1 : 0);
  if (from <= headLines) {
    return {
      toolCallId,
      content:
        `Error: lines 1-${headLines} of ${file} are its frontmatter, which this tool never touches — ` +
        "use update_lore_meta (index.md) or update_facet_meta (a facet) for metadata. The body starts " +
        `at line ${headLines + 1}.`,
    };
  }

  const slice = sliceLines(raw, from, to);
  if (!slice) {
    return {
      toolCallId,
      content: `Error: start_line ${from} is past the end of the file, which has ${countLines(raw)} line(s).`,
    };
  }
  // Same welding guard as the manuscript tool: the range carries its last
  // line's terminator, and a replacement without one would run the following
  // line onto this text.
  let replacement = args.content;
  if (slice.text.endsWith("\n") && replacement !== "" && !replacement.endsWith("\n")) {
    replacement += "\n";
  }
  if (replacement === slice.text) {
    return { toolCallId, content: `Lines ${from}-${slice.to} already read exactly like that — nothing to do.` };
  }

  const gated = gate(toolCallId, ctx, "update", entity.name, file);
  if ("refusal" in gated) return gated.refusal;

  const next = raw.slice(0, slice.start) + replacement + raw.slice(slice.start + slice.text.length);
  if (isMajorRewrite(raw, next)) {
    const skipped = await pauseForStep(
      toolCallId, ctx, gated.step,
      rewritePreview(`${entity.dirPath}/${file}`, entity, file, raw, next),
    );
    if (skipped) return skipped;
  }
  const backupPath = await backupFile(ctx.projectPath, `${entity.dirPath}/${file}`);
  await writeEntityFile(entity.dirPath, file, next);
  refreshFacetInSnapshot(entity, file, next);

  await syncLore(ctx, entity);
  return {
    toolCallId,
    content:
      `Rewrote lines ${from}-${slice.to} of ${file} on entity "${entity.name}".` +
      (backupPath ? ` Previous version backed up to ${backupPath}.` : "") +
      ` Plan step: ${gated.step.detail}.` +
      (await appliedReceipt(`${entity.dirPath}/${file}`, raw, from, slice.to)),
    change: changeOf({
      projectPath: ctx.projectPath,
      path: `${entity.dirPath}/${file}`,
      entity: entity.name,
      before: raw,
      after: next,
      backupPath,
    }),
  };
}

// ─── update_facet_meta / delete_lore_file (facet-level surgery) ──────────────

/**
 * Validate a model-supplied filename as a facet/attachment inside the entity
 * dir. The argument is model-controlled, so anything that could navigate out
 * ('/', '\', '..') is refused, as are the two app-managed reserved names.
 */
export function checkFacetFilename(toolCallId: string, file: string | undefined): ToolResult | string {
  const f = file?.trim();
  if (!f) {
    return { toolCallId, content: "Error: 'file' argument is required (the facet's .md filename inside the entity directory)." };
  }
  if (!isPlainEntityFilename(f)) {
    return { toolCallId, content: "Error: 'file' must be a plain .md filename inside the entity directory (no paths)." };
  }
  // Case-insensitive: the filesystems the app ships on are, so "Index.md" IS index.md.
  if (RESERVED_ENTITY_FILES.includes(f.toLowerCase())) {
    return {
      toolCallId,
      content: `Error: ${f} is app-managed and not a facet — use update_lore_file for index.md, and update_lore_image / delete_lore_image for the gallery.`,
    };
  }
  return f;
}

/** Drop a file from the run's entity snapshot (see relocateInSnapshot). */
function forgetFileInSnapshot(entity: LoreEntity, file: string): void {
  entity.mdFiles = (entity.mdFiles ?? []).filter((f) => f !== file);
  entity.facets = (entity.facets ?? []).filter((f) => f.file !== file);
}

/**
 * Resolve a model-supplied slot id against *this entity's* category schema.
 *
 * Checked per entity rather than as a global enum because a slot only means
 * anything inside the schema that declares it, and the error is where the model
 * learns which ones those are — no per-entity enum can reach the wire, since
 * tool schemas are built per preset, not per run.
 *
 * Returns the declared id (casing normalised), `null` for "no slot", or the
 * refusal to hand straight back.
 */
function resolveFacetSlotArg(
  toolCallId: string,
  entity: LoreEntity,
  raw: unknown,
): ToolResult | string | null {
  const wanted = typeof raw === "string" ? raw.trim() : "";
  if (!wanted) return null;
  const slot = findFacetSlot(entity.category, wanted);
  if (slot) return slot.id;
  const declared = categoryFacetSlots(entity.category);
  return {
    toolCallId,
    content: declared.length === 0
      ? `Error: category "${entity.category}" declares no facet slots, so 'slot' cannot be set here. Pass an empty string to clear it, or omit it.`
      : `Error: "${wanted}" is not a facet slot of category "${entity.category}". Its slots are: ${declared.map((sl) => sl.id).join(", ")}. Pass an empty string to clear the slot instead.`,
  };
}

/**
 * create_lore_facet — the only tool that brings a facet into existence.
 *
 * It exists because the alternative was silent. A facet IS its frontmatter: a
 * `facet` title is what parseFacetMeta looks for, and a file without one is an
 * inert attachment that never reaches the injector. Every other write tool
 * either refuses a new file or writes exactly the bytes the model sent, so
 * "split this entry into facets" ran through update_lore_file, arrived without
 * that frontmatter, came back as `Wrote 出征装束.md`, and injected nothing —
 * a failure the author meets on the entry page weeks later, not in the run.
 * Generating the frontmatter here is what makes the outcome match the request.
 *
 * Two shapes, decided by `file`:
 *   - omitted — a brand-new facet, named after its title (collision-safe)
 *   - given   — promote an existing attachment, the agent's counterpart to the
 *               entry page's 「转为特征」 button. Its body is carried through
 *               verbatim when `content` is omitted: the text is already the
 *               author's, and re-sending it through the model is the one way to
 *               have it quietly paraphrased.
 */
export async function createLoreFacetTool(
  toolCallId: string,
  args: {
    entity?: string;
    title?: string;
    content?: string;
    file?: string;
    slot?: string;
    keys?: string[];
    group?: string;
    priority?: number;
    mode?: string;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const entityName = args.entity?.trim();
  if (!entityName) return { toolCallId, content: "Error: 'entity' argument is required." };
  const entity = findEntityByName(ctx.loreIndex, entityName);
  if (!entity) {
    return {
      toolCallId,
      content: `Error: entity "${entityName}" not found. Available: ${allEntityNames(ctx.loreIndex) || "none"}`,
    };
  }

  const title = args.title?.trim();
  if (!title) {
    return {
      toolCallId,
      content: "Error: 'title' argument is required — what this facet is (an outfit, a form, a stretch of backstory). It names the file and heads the card the author reads.",
    };
  }

  // The filename is settled before anything is written: the plan gate below may
  // authorise exactly one file, and it has to be told which.
  let file: string;
  let existingBody: string | null = null;
  if (args.file !== undefined) {
    const checked = checkFacetFilename(toolCallId, args.file);
    if (typeof checked !== "string") return checked;
    file = checked;
    try {
      const raw = await readEntityFile(entity.dirPath, file);
      if (parseFacetMeta(raw, file)) {
        return {
          toolCallId,
          content:
            `Error: "${file}" of entity "${entity.name}" is already a facet — this tool only creates one. ` +
            `Retune its metadata with update_facet_meta, rewrite its body with update_lore_file, or omit 'file' to add a separate facet.`,
        };
      }
      existingBody = parseFrontmatter(raw).content; // an attachment: promote it
    } catch {
      // Nothing there yet — a plain create under the name the model chose.
    }
  } else {
    file = await facetFileName(entity.dirPath, title);
  }

  const body = args.content?.trim() ? args.content : existingBody;
  if (body === null || !body.trim()) {
    return {
      toolCallId,
      content: existingBody === null
        ? "Error: 'content' argument is required — the facet's body markdown (no frontmatter; it is generated from the other arguments)."
        : `Error: "${file}" has no text to promote — pass 'content' with the facet's body.`,
    };
  }

  if ("keys" in args && !Array.isArray(args.keys)) {
    return { toolCallId, content: "Error: 'keys' must be an array of strings." };
  }
  const keys = (args.keys ?? []).map((k) => String(k).trim()).filter(Boolean);

  const slot = resolveFacetSlotArg(toolCallId, entity, args.slot);
  if (slot !== null && typeof slot !== "string") return slot;

  const priority = "priority" in args ? Number(args.priority) : 0;
  if (!Number.isFinite(priority)) {
    return { toolCallId, content: "Error: 'priority' must be a number." };
  }
  const mode = args.mode ?? "auto";
  if (mode !== "auto" && mode !== "always" && mode !== "manual") {
    return { toolCallId, content: "Error: 'mode' must be one of: auto, always, manual." };
  }

  // Only what the model left neutral is filled from the slot's defaults, so a
  // decision it actually made survives (see withSlotDefaults).
  const meta: FacetMeta = withSlotDefaults(
    { title, slot, keys, group: args.group?.trim() || null, priority, mode },
    entity.category,
  );

  // Gated as "update" on the entity — the entity itself already exists — and a
  // plan that said "create the outfit facet" satisfies it too (plan.ts).
  const gated = gate(toolCallId, ctx, "update", entity.name, file);
  if ("refusal" in gated) return gated.refusal;

  // Only a promotion has a previous version to keep.
  const snap = existingBody === null
    ? null
    : await snapshotFile(ctx.projectPath, `${entity.dirPath}/${file}`);
  const backupPath = snap?.path ?? null;
  await saveFacetFile(entity.dirPath, file, meta, body);

  if (!(entity.mdFiles ?? []).includes(file)) (entity.mdFiles ??= []).push(file);
  const snapshot: LoreFacet = { file, ...meta, slot: meta.slot ?? null, charCount: body.length };
  const at = (entity.facets ?? []).findIndex((f) => f.file === file);
  if (at >= 0) entity.facets[at] = snapshot;
  else (entity.facets ??= []).push(snapshot);

  await syncLore(ctx, entity);
  const inert = meta.mode === "auto" && meta.keys.length === 0;
  return {
    toolCallId,
    content:
      `${existingBody === null ? "Created" : "Promoted the attachment"} ${file} on entity "${entity.name}" as facet "${meta.title}": ` +
      `slot=${meta.slot ?? "none"}, keys=[${meta.keys.join(", ")}], group=${meta.group ?? "none"}, priority=${meta.priority}, mode=${meta.mode}.` +
      (existingBody !== null && !args.content?.trim() ? " Its text was carried through unchanged." : "") +
      (inert ? " NOTE: with mode=auto and no keys this facet will never be injected — give it trigger words with update_facet_meta." : "") +
      (backupPath ? ` Previous version backed up to ${backupPath}.` : "") +
      ` Plan step: ${gated.step.detail}. The lore index has been refreshed.`,
    change: await changeAfterWrite({
      projectPath: ctx.projectPath,
      path: `${entity.dirPath}/${file}`,
      entity: entity.name,
      before: snap?.text,
      backupPath,
    }),
  };
}

export async function updateFacetMetaTool(
  toolCallId: string,
  args: {
    entity?: string;
    file?: string;
    title?: string;
    slot?: string | null;
    keys?: string[];
    group?: string | null;
    priority?: number;
    mode?: string;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const entityName = args.entity?.trim();
  if (!entityName) return { toolCallId, content: "Error: 'entity' argument is required." };
  const entity = findEntityByName(ctx.loreIndex, entityName);
  if (!entity) {
    return {
      toolCallId,
      content: `Error: entity "${entityName}" not found. Available: ${allEntityNames(ctx.loreIndex) || "none"}`,
    };
  }

  const checked = checkFacetFilename(toolCallId, args.file);
  if (typeof checked !== "string") return checked;
  const file = checked;

  // Read from disk rather than trusting the run snapshot. Belt and braces since
  // syncLore landed, but still the correct behaviour on its own terms: the
  // frontmatter on disk is the source of truth, and the body below has to be
  // carried through verbatim. It also remains the only thing that works on a
  // surface with no rescan.
  let raw: string;
  try {
    raw = await readEntityFile(entity.dirPath, file);
  } catch {
    const known = (entity.mdFiles ?? []).filter((f) => !RESERVED_ENTITY_FILES.includes(f));
    return {
      toolCallId,
      content: `Error: "${file}" does not exist in entity "${entity.name}". Its facet files are: ${known.join(", ") || "none"}. Create one with create_lore_facet.`,
    };
  }

  const current = parseFacetMeta(raw, file);
  if (!current) {
    return {
      toolCallId,
      content:
        `Error: "${file}" is not a facet — it has no \`facet\` field in its frontmatter, so it is an inert attachment that is never injected. ` +
        `Turn it into one with create_lore_facet(entity, title, file: "${file}"), which keeps its text; use update_lore_file to rewrite the text itself.`,
    };
  }

  const touches = ["title", "slot", "keys", "group", "priority", "mode"].filter((k) => k in args);
  if (touches.length === 0) {
    return {
      toolCallId,
      content: "Error: pass at least one of title / slot / keys / group / priority / mode — this tool only edits facet metadata, not the body (use update_lore_file for the text).",
    };
  }

  const next: FacetMeta = {
    title: args.title?.trim() || current.title,
    // Carried when untouched: dropping it would silently unclassify the facet.
    slot: current.slot,
    keys: current.keys,
    group: current.group,
    priority: current.priority,
    mode: current.mode,
  };
  if ("slot" in args) {
    // "" clears the classification; anything else is normalised to the casing
    // the entity's own category declares.
    const slot = resolveFacetSlotArg(toolCallId, entity, args.slot);
    if (slot !== null && typeof slot !== "string") return slot;
    next.slot = slot;
  }
  if ("keys" in args) {
    if (!Array.isArray(args.keys)) {
      return { toolCallId, content: "Error: 'keys' must be an array of strings." };
    }
    next.keys = args.keys.map((k) => String(k).trim()).filter(Boolean);
  }
  if ("group" in args) {
    const g = typeof args.group === "string" ? args.group.trim() : "";
    next.group = g || null;
  }
  if ("priority" in args) {
    const p = Number(args.priority);
    if (!Number.isFinite(p)) return { toolCallId, content: "Error: 'priority' must be a number." };
    next.priority = p;
  }
  if ("mode" in args) {
    if (args.mode !== "auto" && args.mode !== "always" && args.mode !== "manual") {
      return { toolCallId, content: "Error: 'mode' must be one of: auto, always, manual." };
    }
    next.mode = args.mode;
  }

  // Gated as "update" like update_lore_file — same tool-vs-plan-wording gap,
  // same fix: checkPlan also accepts a "create" step here when this is metadata
  // for a facet the plan called newly-created (plan.ts).
  const gated = gate(toolCallId, ctx, "update", entity.name, file);
  if ("refusal" in gated) return gated.refusal;

  // Only the frontmatter is rewritten — the body is carried through verbatim,
  // which is the whole point: retuning keys must not risk the model quietly
  // paraphrasing the prose on its way past.
  const body = parseFrontmatter(raw).content;
  const backupPath = await backupFile(ctx.projectPath, `${entity.dirPath}/${file}`);
  await saveFacetFile(entity.dirPath, file, next, body);

  const at = (entity.facets ?? []).findIndex((f) => f.file === file);
  // `slot` is optional on FacetMeta and definite on LoreFacet — the run's index
  // must say "unclassified", not "unknown".
  const snapshot: LoreFacet = { file, ...next, slot: next.slot ?? null, charCount: body.length };
  if (at >= 0) entity.facets[at] = snapshot;
  else (entity.facets ??= []).push(snapshot);

  await syncLore(ctx, entity);
  const inert = next.mode === "auto" && next.keys.length === 0;
  return {
    toolCallId,
    content:
      `Updated facet metadata of ${file} ("${next.title}") on entity "${entity.name}": ` +
      `slot=${next.slot ?? "none"}, keys=[${next.keys.join(", ")}], group=${next.group ?? "none"}, priority=${next.priority}, mode=${next.mode}. ` +
      `The body was left untouched.` +
      (inert ? " NOTE: with mode=auto and no keys this facet will never be injected." : "") +
      (backupPath ? ` Previous version backed up to ${backupPath}.` : "") +
      ` Plan step: ${gated.step.detail}.`,
    // Only the frontmatter moved, and that is exactly what the record shows —
    // the body being byte-identical either side is the claim worth being able
    // to check.
    change: await changeAfterWrite({
      projectPath: ctx.projectPath,
      path: `${entity.dirPath}/${file}`,
      entity: entity.name,
      before: raw,
      backupPath,
    }),
  };
}

export async function deleteLoreFileTool(
  toolCallId: string,
  args: { entity?: string; file?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const entityName = args.entity?.trim();
  if (!entityName) return { toolCallId, content: "Error: 'entity' argument is required." };
  const entity = findEntityByName(ctx.loreIndex, entityName);
  if (!entity) {
    return {
      toolCallId,
      content: `Error: entity "${entityName}" not found. Available: ${allEntityNames(ctx.loreIndex) || "none"}`,
    };
  }

  const checked = checkFacetFilename(toolCallId, args.file);
  if (typeof checked !== "string") return checked;
  const file = checked;

  // "delete" has no create/update ambiguity to paper over (unlike the write
  // tools above) — an exact match is correct here, deliberately not routed
  // through the same fallback.
  const gated = gate(toolCallId, ctx, "delete", entity.name, file);
  if ("refusal" in gated) return gated.refusal;

  // The backup IS the recovery path here, so a missing source is an error
  // rather than a no-op — silently "succeeding" would let the model report a
  // deletion the author can never inspect.
  const targetPath = `${entity.dirPath}/${file}`;
  const snap = await snapshotFile(ctx.projectPath, targetPath);
  const backupPath = snap?.path ?? null;
  if (!backupPath) {
    const known = (entity.mdFiles ?? []).filter((f) => !RESERVED_ENTITY_FILES.includes(f));
    return {
      toolCallId,
      content: `Error: "${file}" does not exist in entity "${entity.name}". Its facet files are: ${known.join(", ") || "none"}.`,
    };
  }
  await removeFile(targetPath);
  forgetFileInSnapshot(entity, file);

  await syncLore(ctx, entity);
  return {
    toolCallId,
    content:
      `Deleted ${file} from entity "${entity.name}". Backed up to ${backupPath} first, so it can be restored. ` +
      `Plan step: ${gated.step.detail}.`,
    change: changeOf({
      projectPath: ctx.projectPath,
      path: targetPath,
      entity: entity.name,
      before: snap?.text,
      backupPath,
    }),
  };
}
