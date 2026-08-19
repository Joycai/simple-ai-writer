/**
 * L1 ("write-auto") tool handlers: lore + story-memory writes.
 *
 * Policy (docs/unified-agent-plan.md §3.2): these writes apply automatically
 * but every overwrite is preceded by a backup into `.ai-writer/backups/`
 * (backup.ts), and each handler validates the model's payload against the
 * file's structural contract before touching disk — a malformed write comes
 * back as an error the model can read and correct, never a broken file:
 *
 *   - index.md must keep parseable frontmatter with a `name`, and may not
 *     change the entity's category (folder moves are an app-level operation)
 *   - a file that is currently a facet must stay a parseable facet, or the
 *     write is rejected (silently deactivating injection would be data loss)
 *   - images.md is refused outright — the gallery format is app-managed
 *   - memory updates go through rewriteMemorySegment, which preserves the
 *     segment ranges/hash protocol and only swaps summary text
 *
 * Direct manuscript edits are deliberately absent from the L1 tier: those are
 * L2 and go through the propose→diff→approve flow below.
 */

import { loreCategoryIds } from "../profile/active";
import {
  RESERVED_ENTITY_FILES,
  cloneLoreIndex,
  createEntityWithContent,
  parseFacetMeta,
  readEntityFile,
  saveEntityMetaAndBody,
  saveFacetFile,
  slugifyEntityId,
  uniqueEntityId,
  writeEntityFile,
  type CategoryId,
  type FacetMeta,
  type LoreEntity,
  type LoreIndex,
} from "../lore";
import {
  loadMemory,
  memoryFilePath,
  projectRelativePath,
  rewriteMemorySegment,
} from "../context/memory";
import { isChapterFile, normalizeChapterFileName, parentDir } from "../context/outline";
import { parseFrontmatter } from "../fs/markdown";
import { makeDir, readDir, readFile, removeFile, renamePath } from "../fs/fileio";
import { readDirRecursive, type FileNode } from "../project";
import { backupFile } from "./backup";
import { countLines, describeEditTarget, findOccurrences, occurrenceAt, sliceLines } from "./editApply";
import {
  LORE_PLAN_ACTIONS,
  checkPlan,
  describeStep,
  outstandingSteps,
  type LorePlanAction,
  type LorePlanStep,
} from "./plan";
import type { ApprovalDecision, ToolContext } from "./registry";
import { isPathWithin, isStrictDescendant, isWorkspacePath, normalizePathSegments } from "../paths";
import { allEntityNames, findEntityByName, type ToolResult } from "./tools";

// ─── propose_lore_plan (the gate every lore write goes through) ──────────────

let planCounter = 0;

export async function proposeLorePlanTool(
  toolCallId: string,
  args: { summary?: string; steps?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.requestPlanApproval || !ctx.lorePlan) {
    return {
      toolCallId,
      content: "Error: this surface cannot review lore plans — do not call propose_lore_plan here.",
    };
  }

  const raw = Array.isArray(args.steps) ? args.steps : [];
  if (raw.length === 0) {
    return {
      toolCallId,
      content: "Error: 'steps' must list at least one change (action + entity + detail).",
    };
  }

  const steps: LorePlanStep[] = [];
  for (const [i, item] of raw.entries()) {
    const s = (item ?? {}) as Record<string, unknown>;
    const action = String(s.action ?? "").trim() as LorePlanAction;
    const entity = String(s.entity ?? "").trim();
    const detail = String(s.detail ?? "").trim();
    if (!LORE_PLAN_ACTIONS.includes(action)) {
      return {
        toolCallId,
        content: `Error: step ${i + 1} has action "${s.action}" — must be one of: ${LORE_PLAN_ACTIONS.join(", ")}.`,
      };
    }
    if (!entity) return { toolCallId, content: `Error: step ${i + 1} is missing 'entity'.` };
    if (!detail) {
      return {
        toolCallId,
        content: `Error: step ${i + 1} is missing 'detail' — the author decides on this text, so say concretely what changes.`,
      };
    }
    const file = typeof s.file === "string" && s.file.trim() ? s.file.trim() : undefined;
    steps.push({ action, entity, file, detail });
  }

  ctx.lorePlan.asked = true;
  const decision = await ctx.requestPlanApproval({
    id: `plan-${++planCounter}`,
    summary: args.summary?.trim() || undefined,
    steps,
  });

  if (!decision.approved) {
    return {
      toolCallId,
      content:
        `The author REJECTED this plan${decision.reason ? ` — reason: ${decision.reason}` : "."} ` +
        "Nothing has been changed. Revise the plan per the reason and propose again, or ask what they want instead — do not write any lore in the meantime.",
    };
  }

  // Append rather than replace: a revised or additional plan mid-run must not
  // silently revoke steps the author already signed off on. Carrying the
  // earlier leftovers into the message keeps them from being forgotten now that
  // a fresh list is the most recent thing in context.
  const leftover = outstandingSteps(ctx.lorePlan);
  const offset = ctx.lorePlan.steps.length;
  ctx.lorePlan.steps.push(...steps);
  return {
    toolCallId,
    content:
      `Plan approved. Carry out exactly these steps, nothing more:\n` +
      steps.map((s, i) => `  ${offset + i + 1}. ${describeStep(s)}`).join("\n") +
      (leftover.length
        ? `\nStill outstanding from earlier:\n${leftover.map((s) => `  - ${describeStep(s)}`).join("\n")}`
        : "") +
      "\nAnything outside this list will be refused. Propose again if the plan needs to change.",
  };
}

/**
 * Fold a lore write back into this run's snapshot, and refresh the app with it.
 *
 * `ctx.loreIndex` is one object shared by every tool call in the run (the
 * runtime spreads the same context per call), so the fresh index is poured
 * *into* it rather than reassigned — a reassignment would be invisible to the
 * next call. It is cloned on the way in for the same reason the runtime clones
 * at run start: what comes back is the live store object, and the snapshot
 * patches below splice its arrays.
 *
 * Never throws. `executeRegisteredTool` turns a throw into an `"Error: …"`
 * result, so a rescan that fails *after* a successful write would tell the
 * model its create failed — and the model would create the entity a second
 * time. The hand-written snapshot patches are the fallback.
 *
 * Invariant for callers: resync **last**, and never touch disk through an
 * entity resolved before it — those objects are detached once this returns.
 */
async function syncLore(ctx: ToolContext): Promise<void> {
  try {
    const fresh = await ctx.onLoreChanged?.();
    if (!fresh) return;
    for (const key of Object.keys(ctx.loreIndex)) delete ctx.loreIndex[key];
    Object.assign(ctx.loreIndex, cloneLoreIndex(fresh));
  } catch (e) {
    console.warn("[agent] lore rescan failed; run snapshot keeps its local patches:", e);
  }
}

/**
 * Gate helper for the write tools: returns the refusal result to hand straight
 * back, or the covering step whose `detail` gets echoed into the success
 * message (so the log shows intent and outcome together).
 */
function gate(
  toolCallId: string,
  ctx: ToolContext,
  action: LorePlanAction,
  entity: string,
  file?: string,
): { refusal: ToolResult } | { step: LorePlanStep } {
  const check = checkPlan(ctx.lorePlan, ctx.loreIndex, action, entity, file);
  return check.ok ? { step: check.step } : { refusal: { toolCallId, content: check.message } };
}

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
      content: `Error: 'category' must be one of: ${categoryIds.join(", ")}.`,
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
  const dirPath = await createEntityWithContent(
    ctx.projectPath, category, entityId, name, aliases, summary, content,
  );

  // Insert into the run snapshot before resyncing, mirroring what
  // relocateInSnapshot does for move/delete. syncLore overwrites this with disk
  // truth a line later on any surface that can rescan — this is what keeps the
  // new entity resolvable on one that cannot, or when the rescan fails.
  (ctx.loreIndex[category] ??= []).push({
    id: entityId, category, dirPath, name, aliases, summary,
    avatarPath: null, mdFiles: ["index.md"], images: [], facets: [],
  });
  await syncLore(ctx);
  return {
    toolCallId,
    content:
      `Created lore entity "${name}" (category: ${category}) at ${dirPath}. ` +
      `Plan step: ${gated.step.detail}. The lore index has been refreshed.`,
  };
}

// ─── update_lore_file ────────────────────────────────────────────────────────

/** Reserved names the agent may never write through this tool. */
const REFUSED_FILES = new Set(["images.md"]);

/**
 * Validate a model-supplied filename as a writable file inside the entity dir.
 * The argument is model-controlled, so anything that could navigate ('/', '\',
 * '..') is refused, as is the app-managed gallery file. index.md IS allowed
 * here — `checkFacetFilename` is the stricter variant for the tools that may
 * only touch facets.
 */
function checkEntityFilename(toolCallId: string, raw: unknown): ToolResult | string {
  const file = String(raw ?? "").trim();
  if (!/^[^/\\]+\.md$/.test(file) || file.includes("..")) {
    return {
      toolCallId,
      content: "Error: 'file' must be a plain .md filename inside the entity directory (no paths).",
    };
  }
  if (REFUSED_FILES.has(file)) {
    return {
      toolCallId,
      content: "Error: images.md is managed by the app's gallery UI and cannot be written by the agent.",
    };
  }
  return file;
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

  const targetPath = `${entity.dirPath}/${file}`;
  const backupPath = await backupFile(ctx.projectPath, targetPath);
  await writeEntityFile(entity.dirPath, file, content);

  await syncLore(ctx);
  const suffix = backupPath
    ? `Previous version backed up to ${backupPath}.`
    : "This is a new file (no backup needed).";
  return {
    toolCallId,
    content:
      `Wrote ${file} of entity "${entity.name}". ${suffix} ` +
      `Plan step: ${gated.step.detail}. The lore index has been refreshed.`,
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
function requireEntity(
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
function facetFileList(entity: LoreEntity): string {
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
  try {
    const parsed = parseFrontmatter(await readEntityFile(entity.dirPath, "index.md"));
    body = parsed.content;
    if (typeof parsed.data.name === "string" && parsed.data.name.trim()) name = parsed.data.name.trim();
    if (Array.isArray(parsed.data.aliases)) {
      aliases = parsed.data.aliases.map((a) => String(a).trim()).filter(Boolean);
    }
    if (typeof parsed.data.summary === "string") summary = parsed.data.summary;
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
        content: `Error: the alias "${alias}" already resolves to entity "${clash.name}" (category: ${clash.category}) — both would become unresolvable by name. Drop it, or merge the two entities.`,
      };
    }
  }

  const gated = gate(toolCallId, ctx, "update", entity.name, "index.md");
  if ("refusal" in gated) return gated.refusal;

  const backupPath = await backupFile(ctx.projectPath, `${entity.dirPath}/index.md`);
  await saveEntityMetaAndBody(
    ctx.projectPath,
    entity,
    { name, aliases, category: entity.category, summary },
    body,
  );
  entity.aliases = aliases;
  entity.summary = summary;

  await syncLore(ctx);
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

  await syncLore(ctx);
  return {
    toolCallId,
    content:
      `Appended ${addition.length} chars to the end of ${file} on entity "${entity.name}". ` +
      `Everything already in the file is unchanged.` +
      (backupPath ? ` Previous version backed up to ${backupPath}.` : "") +
      ` Plan step: ${gated.step.detail}.`,
  };
}

export async function editLoreFileTool(
  toolCallId: string,
  args: { entity?: string; file?: string; find?: string; replace?: string },
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
  const hits = body.split(find).length - 1;
  if (hits === 0) {
    return {
      toolCallId,
      content:
        `Error: that 'find' text does not appear in the body of ${file}. ` +
        (head.includes(find)
          ? "It is in the frontmatter, which this tool never touches — use update_lore_meta (index.md) or update_facet_meta (a facet) for metadata."
          : "Read the file with read_lore_entity and copy the snippet exactly, whitespace and line breaks included."),
    };
  }
  if (hits > 1) {
    return {
      toolCallId,
      content: `Error: that 'find' text appears ${hits} times in ${file} — it must be unique. Include enough surrounding text to pin down the one you mean.`,
    };
  }

  const gated = gate(toolCallId, ctx, "update", entity.name, file);
  if ("refusal" in gated) return gated.refusal;

  // split/join rather than String.replace: a replacement containing `$&` or
  // `$1` would otherwise be expanded as a pattern reference, silently writing
  // something other than what the author approved. `find` is unique, so this
  // is the same single substitution, taken literally.
  const next = head + body.split(find).join(replace);
  const backupPath = await backupFile(ctx.projectPath, `${entity.dirPath}/${file}`);
  await writeEntityFile(entity.dirPath, file, next);
  refreshFacetInSnapshot(entity, file, next);

  await syncLore(ctx);
  return {
    toolCallId,
    content:
      `Replaced ${find.length} chars with ${replace.length} in ${file} on entity "${entity.name}". ` +
      `The rest of the file, and its frontmatter, are unchanged.` +
      (backupPath ? ` Previous version backed up to ${backupPath}.` : "") +
      ` Plan step: ${gated.step.detail}.`,
  };
}

// ─── update_facet_meta / delete_lore_file (facet-level surgery) ──────────────

/**
 * Validate a model-supplied filename as a facet/attachment inside the entity
 * dir. The argument is model-controlled, so anything that could navigate out
 * ('/', '\', '..') is refused, as are the two app-managed reserved names.
 */
function checkFacetFilename(toolCallId: string, file: string | undefined): ToolResult | string {
  const f = file?.trim();
  if (!f) {
    return { toolCallId, content: "Error: 'file' argument is required (the facet's .md filename inside the entity directory)." };
  }
  if (!/^[^/\\]+\.md$/.test(f) || f.includes("..")) {
    return { toolCallId, content: "Error: 'file' must be a plain .md filename inside the entity directory (no paths)." };
  }
  if (RESERVED_ENTITY_FILES.includes(f)) {
    return {
      toolCallId,
      content: `Error: ${f} is app-managed and not a facet — use update_lore_file for index.md, and the gallery UI for images.md.`,
    };
  }
  return f;
}

/** Drop a file from the run's entity snapshot (see relocateInSnapshot). */
function forgetFileInSnapshot(entity: LoreEntity, file: string): void {
  entity.mdFiles = (entity.mdFiles ?? []).filter((f) => f !== file);
  entity.facets = (entity.facets ?? []).filter((f) => f.file !== file);
}

export async function updateFacetMetaTool(
  toolCallId: string,
  args: {
    entity?: string;
    file?: string;
    title?: string;
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
      content: `Error: "${file}" does not exist in entity "${entity.name}". Its facet files are: ${known.join(", ") || "none"}. Create one with update_lore_file.`,
    };
  }

  const current = parseFacetMeta(raw, file);
  if (!current) {
    return {
      toolCallId,
      content: `Error: "${file}" is not a facet — it has no \`facet\` field in its frontmatter, so it is an inert attachment. Use update_lore_file to rewrite it wholesale.`,
    };
  }

  const touches = ["title", "keys", "group", "priority", "mode"].filter((k) => k in args);
  if (touches.length === 0) {
    return {
      toolCallId,
      content: "Error: pass at least one of title / keys / group / priority / mode — this tool only edits facet metadata, not the body (use update_lore_file for the text).",
    };
  }

  const next: FacetMeta = {
    title: args.title?.trim() || current.title,
    keys: current.keys,
    group: current.group,
    priority: current.priority,
    mode: current.mode,
  };
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

  const gated = gate(toolCallId, ctx, "update", entity.name, file);
  if ("refusal" in gated) return gated.refusal;

  // Only the frontmatter is rewritten — the body is carried through verbatim,
  // which is the whole point: retuning keys must not risk the model quietly
  // paraphrasing the prose on its way past.
  const body = parseFrontmatter(raw).content;
  const backupPath = await backupFile(ctx.projectPath, `${entity.dirPath}/${file}`);
  await saveFacetFile(entity.dirPath, file, next, body);

  const at = (entity.facets ?? []).findIndex((f) => f.file === file);
  const snapshot = { file, ...next, charCount: body.length };
  if (at >= 0) entity.facets[at] = snapshot;
  else (entity.facets ??= []).push(snapshot);

  await syncLore(ctx);
  const inert = next.mode === "auto" && next.keys.length === 0;
  return {
    toolCallId,
    content:
      `Updated facet metadata of ${file} ("${next.title}") on entity "${entity.name}": ` +
      `keys=[${next.keys.join(", ")}], group=${next.group ?? "none"}, priority=${next.priority}, mode=${next.mode}. ` +
      `The body was left untouched.` +
      (inert ? " NOTE: with mode=auto and no keys this facet will never be injected." : "") +
      (backupPath ? ` Previous version backed up to ${backupPath}.` : "") +
      ` Plan step: ${gated.step.detail}.`,
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

  const gated = gate(toolCallId, ctx, "delete", entity.name, file);
  if ("refusal" in gated) return gated.refusal;

  // The backup IS the recovery path here, so a missing source is an error
  // rather than a no-op — silently "succeeding" would let the model report a
  // deletion the author can never inspect.
  const targetPath = `${entity.dirPath}/${file}`;
  const backupPath = await backupFile(ctx.projectPath, targetPath);
  if (!backupPath) {
    const known = (entity.mdFiles ?? []).filter((f) => !RESERVED_ENTITY_FILES.includes(f));
    return {
      toolCallId,
      content: `Error: "${file}" does not exist in entity "${entity.name}". Its facet files are: ${known.join(", ") || "none"}.`,
    };
  }
  await removeFile(targetPath);
  forgetFileInSnapshot(entity, file);

  await syncLore(ctx);
  return {
    toolCallId,
    content:
      `Deleted ${file} from entity "${entity.name}". Backed up to ${backupPath} first, so it can be restored. ` +
      `Plan step: ${gated.step.detail}.`,
  };
}

// ─── move_lore_entity / delete_lore_entity ───────────────────────────────────

/**
 * Keep the run's lore snapshot honest after a folder-level change.
 *
 * ctx.loreIndex is captured at run start (see registry.ToolContext). `syncLore`
 * now folds the rescan back into it, so this is the *fallback* rather than the
 * only repair: it is what keeps the snapshot honest on a surface that supplies
 * no `onLoreChanged` (lore/generator, lore/splitter — both pass `loreIndex:
 * {}`) and when a rescan fails. Without either, the next call in the same run
 * resolves the entity to a directory that no longer exists, and the model gets
 * a baffling ENOENT for the move it just made successfully.
 *
 * Pass `next: null` to drop the entity entirely.
 */
function relocateInSnapshot(
  loreIndex: LoreIndex,
  entity: LoreEntity,
  next: { category: CategoryId; id: string; dirPath: string } | null,
): void {
  if (next && next.category === entity.category) {
    entity.id = next.id;
    entity.dirPath = next.dirPath;
    return;
  }
  const from = loreIndex[entity.category];
  const at = from ? from.indexOf(entity) : -1;
  if (at >= 0) from.splice(at, 1);
  if (!next) return;
  entity.category = next.category;
  entity.id = next.id;
  entity.dirPath = next.dirPath;
  (loreIndex[next.category] ??= []).push(entity);
}

/** Case-insensitive de-duplicating alias append. */
function withAlias(aliases: string[], extra: string): string[] {
  const lower = extra.toLowerCase();
  return aliases.some((a) => a.toLowerCase() === lower) ? aliases : [...aliases, extra];
}

export async function moveLoreEntityTool(
  toolCallId: string,
  args: {
    entity?: string;
    new_name?: string;
    new_category?: string;
    keep_old_name_as_alias?: boolean;
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

  const newName = args.new_name?.trim();
  const newCategory = args.new_category?.trim() as CategoryId | undefined;
  if (!newName && !newCategory) {
    return {
      toolCallId,
      content: "Error: pass 'new_name', 'new_category', or both — otherwise there is nothing to move.",
    };
  }

  const categoryIds = loreCategoryIds();
  if (newCategory && !categoryIds.includes(newCategory)) {
    return { toolCallId, content: `Error: 'new_category' must be one of: ${categoryIds.join(", ")}.` };
  }
  if (newName) {
    // A rename onto a name/alias another entity already answers to would make
    // both unresolvable by name — refuse rather than create the ambiguity.
    const clash = findEntityByName(ctx.loreIndex, newName);
    if (clash && clash !== entity) {
      return {
        toolCallId,
        content: `Error: "${newName}" already resolves to entity "${clash.name}" (category: ${clash.category}). Merge them with update_lore_file instead, or pick another name.`,
      };
    }
  }

  const gated = gate(toolCallId, ctx, "move", entity.name);
  if ("refusal" in gated) return gated.refusal;

  // Frontmatter is the source of truth for summary/aliases; the scanned entity
  // is the fallback when index.md is missing or unparseable.
  let body = `# ${newName ?? entity.name}\n`;
  let summary = entity.summary;
  let aliases = entity.aliases;
  try {
    const raw = await readEntityFile(entity.dirPath, "index.md");
    const parsed = parseFrontmatter(raw);
    body = parsed.content;
    if (typeof parsed.data.summary === "string") summary = parsed.data.summary;
  } catch {
    // no index.md — the rewrite below creates one from the scanned metadata
  }

  // The old name keeps matching in already-written chapters unless the author
  // explicitly opts out (a typo fix should not preserve the typo).
  if (newName && newName !== entity.name && args.keep_old_name_as_alias !== false) {
    aliases = withAlias(aliases, entity.name);
  }

  const previousCategory = entity.category;
  const backupPath = await backupFile(ctx.projectPath, `${entity.dirPath}/index.md`);
  const moved = await saveEntityMetaAndBody(
    ctx.projectPath,
    entity,
    { name: newName ?? entity.name, aliases, category: newCategory ?? entity.category, summary },
    body,
  );
  relocateInSnapshot(ctx.loreIndex, entity, moved);
  entity.name = newName ?? entity.name;
  entity.aliases = aliases;

  await syncLore(ctx);
  const changes = [
    newName && newName !== entityName ? `renamed to "${newName}"` : null,
    newCategory && newCategory !== previousCategory
      ? `moved ${previousCategory} → ${newCategory} (now at ${moved.dirPath})`
      : null,
  ].filter(Boolean);
  return {
    toolCallId,
    content:
      `Entity "${entityName}" ${changes.join(" and ")}.` +
      (backupPath ? ` Previous index.md backed up to ${backupPath}.` : "") +
      ` Plan step: ${gated.step.detail}. The lore index has been refreshed.`,
  };
}

export async function deleteLoreEntityTool(
  toolCallId: string,
  args: { entity?: string; reason?: string },
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

  const gated = gate(toolCallId, ctx, "delete", entity.name);
  if ("refusal" in gated) return gated.refusal;

  // Not an unlink: the folder is *moved* into .ai-writer/backups, which keeps
  // the L1 "auto-apply, always recoverable" bargain intact even for the binary
  // gallery assets that backupFile (text-only) could never snapshot. One rename
  // also means there is no half-deleted state to land in.
  const backupRoot = `${ctx.projectPath}/.ai-writer/backups`;
  await makeDir(backupRoot);
  const trashPath = `${backupRoot}/deleted-${Date.now()}-${entity.category}-${entity.id}`;
  await renamePath(entity.dirPath, trashPath);

  relocateInSnapshot(ctx.loreIndex, entity, null);
  // Reads `entity.name`/`entity.category` below off the now-detached object on
  // purpose: the message should report what was deleted, not what remains.
  await syncLore(ctx);
  return {
    toolCallId,
    content:
      `Deleted lore entity "${entity.name}" (category: ${entity.category}). ` +
      `Its folder was moved to ${trashPath} and can be restored by moving it back. ` +
      `Plan step: ${gated.step.detail}. The lore index has been refreshed.`,
  };
}

// ─── read_memory / update_memory ─────────────────────────────────────────────

function checkDocPath(toolCallId: string, ctx: ToolContext, path?: string): ToolResult | string {
  const p = path?.trim();
  if (!p) return { toolCallId, content: "Error: 'path' argument is required (the document's absolute path, as returned by list_files)." };
  // An empty projectPath would prefix-match every absolute path — fail closed.
  if (!ctx.projectPath || !isPathWithin(ctx.projectPath, p)) {
    return { toolCallId, content: "Error: Path is outside the project directory." };
  }
  return p;
}

export async function readMemoryTool(
  toolCallId: string,
  args: { path?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const checked = checkDocPath(toolCallId, ctx, args.path);
  if (typeof checked !== "string") return checked;

  const mem = await loadMemory(ctx.projectPath, checked);
  if (!mem || mem.segments.length === 0) {
    return { toolCallId, content: "No story memory exists for this document." };
  }
  const lines = [
    `Story memory for ${mem.sourcePath} (covers chars 0–${mem.coveredChars}, updated ${mem.updatedAt}):`,
    ...mem.segments.map(
      (s, i) => `[segment ${i}] chars ${s.from}–${s.to}:\n${s.summary.trim() || "(empty)"}`,
    ),
  ];
  return { toolCallId, content: lines.join("\n\n") };
}

export async function updateMemoryTool(
  toolCallId: string,
  args: { path?: string; segment_index?: number; summary?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const checked = checkDocPath(toolCallId, ctx, args.path);
  if (typeof checked !== "string") return checked;

  if (typeof args.segment_index !== "number") {
    return { toolCallId, content: "Error: 'segment_index' argument is required — call read_memory first to see the segments." };
  }
  if (typeof args.summary !== "string" || !args.summary.trim()) {
    return { toolCallId, content: "Error: 'summary' argument is required (the replacement summary text)." };
  }

  // Backup the memory file before the rewrite (when it exists).
  const rel = projectRelativePath(ctx.projectPath, checked);
  const backupPath = rel
    ? await backupFile(ctx.projectPath, memoryFilePath(ctx.projectPath, rel))
    : null;

  // rewriteMemorySegment throws model-readable errors (no memory / bad index);
  // the registry's catch turns them into an error result for the model.
  const updated = await rewriteMemorySegment(
    ctx.projectPath, checked, args.segment_index, args.summary,
  );

  ctx.onMemoryChanged?.();
  const seg = updated.segments[args.segment_index];
  return {
    toolCallId,
    content:
      `Updated memory segment ${args.segment_index} (chars ${seg.from}–${seg.to}).` +
      (backupPath ? ` Previous version backed up to ${backupPath}.` : ""),
  };
}

// ─── Manuscript proposals (L2 — approval required) ───────────────────────────

let proposalCounter = 0;

/**
 * Shared preamble for every manuscript proposal: a trimmed path that is really
 * inside the project (and not inside `.ai-writer/`), and a live approval
 * channel to block on. Returns the error result to hand straight back to the
 * model when either is missing.
 */
function manuscriptTarget(
  toolCallId: string,
  tool: string,
  rawPath: string | undefined,
  ctx: ToolContext,
): { path: string } | { refusal: ToolResult } {
  const path = rawPath?.trim();
  if (!path) {
    return { refusal: { toolCallId, content: "Error: 'path' argument is required." } };
  }
  // Project files only — .ai-writer is the app's data; lore/memory have their
  // own (L1) tools with their own approval protocols, and letting a document
  // tool write there would bypass the lore plan gate wholesale.
  if (!isWorkspacePath(ctx.projectPath, path)) {
    return {
      refusal: {
        toolCallId,
        content: `Error: ${tool} only works on files inside the project folder (the app's .ai-writer data is off-limits — use the lore/memory tools for that).`,
      },
    };
  }
  if (!ctx.requestApproval) {
    return {
      refusal: {
        toolCallId,
        content: `Error: this surface cannot review manuscript changes — do not call ${tool} here.`,
      },
    };
  }
  return { path };
}

/**
 * Whether `path` exists, and whether it is a directory — read from the parent's
 * listing, since fs_exists cannot tell the two apart and `delete_chapter` must
 * refuse folders.
 */
async function statEntry(path: string): Promise<{ isDir: boolean } | null> {
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const cut = clean.lastIndexOf("/");
  if (cut < 0) return null;
  try {
    const entries = await readDir(clean.slice(0, cut));
    const name = clean.slice(cut + 1);
    const hit = entries.find((e) => e.name === name);
    return hit ? { isDir: hit.isDirectory } : null;
  } catch {
    return null;
  }
}

/** Turn an approval decision into the result text the model reads. */
function reportDecision(
  toolCallId: string,
  decision: ApprovalDecision,
  done: string,
): ToolResult {
  if (!decision.approved) {
    return {
      toolCallId,
      content:
        `The user REJECTED this change${decision.reason ? ` — reason: ${decision.reason}` : "."} ` +
        "Do not retry the same change; adjust per the reason or move on.",
    };
  }
  return {
    toolCallId,
    content:
      `${done}` +
      (decision.backupPath ? ` The previous state was backed up to ${decision.backupPath}.` : "") +
      (decision.auto
        ? " NOTE: this was auto-approved under a standing grant — the author did not review it. Hold yourself to the same standard you would if they had."
        : ""),
  };
}

export async function createChapterTool(
  toolCallId: string,
  args: { path?: string; content?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "create_chapter", args.path, ctx);
  if ("refusal" in target) return target.refusal;
  if (typeof args.content !== "string") {
    return { toolCallId, content: "Error: 'content' argument is required (may be an empty string)." };
  }

  // A path the model wrote without an extension would land as a file the
  // outline does not recognise as a chapter, so normalise it up front and tell
  // the model what the file will actually be called.
  const dir = parentDir(target.path);
  const name = normalizeChapterFileName(target.path.slice(dir.length + 1));
  if (!isChapterFile(name)) {
    return {
      toolCallId,
      content: `Error: "${name}" is not a manuscript file — chapters must end in .md, .markdown or .txt.`,
    };
  }
  const path = `${dir}/${name}`;

  if (await statEntry(path)) {
    return {
      toolCallId,
      content: `Error: "${name}" already exists. Use propose_edit to change it, or pick another name.`,
    };
  }

  const decision = await ctx.requestApproval!({
    kind: "create",
    id: `create-${++proposalCounter}`,
    path,
    content: args.content,
    reason: args.reason?.trim() || undefined,
  });
  return reportDecision(toolCallId, decision, `Created ${path}.`);
}

/**
 * Create a file of any type — the general-purpose counterpart to
 * `create_chapter`, for everything the outline should NOT treat as a chapter
 * (notes, data files, config). The extension is therefore *required* rather
 * than defaulted: a bare name here means the model has not decided what kind
 * of file it is making, and silently appending `.md` would quietly turn data
 * into a chapter.
 */
export async function createFileTool(
  toolCallId: string,
  args: { path?: string; content?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "create_file", args.path, ctx);
  if ("refusal" in target) return target.refusal;
  if (typeof args.content !== "string") {
    return { toolCallId, content: "Error: 'content' argument is required (may be an empty string)." };
  }

  const dir = parentDir(target.path);
  const name = target.path.slice(dir.length + 1);
  if (!/^[^.].*\.[^./\\]+$/.test(name)) {
    return {
      toolCallId,
      content:
        `Error: "${name}" has no file extension. Give the full filename (e.g. 大纲.md, 人物表.csv, 配置.json) — ` +
        "or use create_chapter for manuscript text, which defaults to .md.",
    };
  }

  if (await statEntry(target.path)) {
    return {
      toolCallId,
      content: `Error: "${name}" already exists. Use propose_edit or rewrite_document to change it, or pick another name.`,
    };
  }

  const decision = await ctx.requestApproval!({
    kind: "create",
    id: `create-${++proposalCounter}`,
    path: target.path,
    content: args.content,
    reason: args.reason?.trim() || undefined,
  });
  return reportDecision(toolCallId, decision, `Created ${target.path}.`);
}

/** Create an empty folder — a volume, a materials directory, any grouping. */
export async function createDirectoryTool(
  toolCallId: string,
  args: { path?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "create_directory", args.path, ctx);
  if ("refusal" in target) return target.refusal;

  if (await statEntry(target.path)) {
    return { toolCallId, content: `Error: something already exists at "${target.path}".` };
  }

  const decision = await ctx.requestApproval!({
    kind: "create",
    id: `create-${++proposalCounter}`,
    path: target.path,
    content: "",
    isDir: true,
    reason: args.reason?.trim() || undefined,
  });
  return reportDecision(toolCallId, decision, `Created folder ${target.path}.`);
}

/**
 * Duplicate a file or folder into a destination directory. The copy keeps the
 * source's name — a collision is auto-numbered by the apply step, and the
 * final path comes back on the decision (`resultPath`), so the report tells
 * the model where the copy actually landed.
 */
export async function copyFileTool(
  toolCallId: string,
  args: { path?: string; dest_dir?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "copy_file", args.path, ctx);
  if ("refusal" in target) return target.refusal;

  const destDir = args.dest_dir?.trim();
  if (!destDir) {
    return { toolCallId, content: "Error: 'dest_dir' argument is required (the folder the copy lands in)." };
  }
  if (!isWorkspacePath(ctx.projectPath, destDir)) {
    return { toolCallId, content: "Error: the destination must be inside the project folder (not in .ai-writer)." };
  }

  const source = await statEntry(target.path);
  if (!source) {
    return { toolCallId, content: `Error: "${target.path}" does not exist. Check the path with list_files.` };
  }
  // The project root always exists but has no parent listing for statEntry to
  // find it in — accept it without stat. Anything else must be a real folder.
  if (normalizePathSegments(destDir) !== normalizePathSegments(ctx.projectPath)) {
    const dest = await statEntry(destDir);
    if (!dest?.isDir) {
      return { toolCallId, content: `Error: destination folder "${destDir}" does not exist (create_directory first), or is a file.` };
    }
  }
  if (source.isDir && (target.path === destDir || isStrictDescendant(target.path, destDir))) {
    return { toolCallId, content: "Error: cannot copy a folder into itself." };
  }

  const decision = await ctx.requestApproval!({
    kind: "copy",
    id: `copy-${++proposalCounter}`,
    path: target.path,
    destDir,
    isDir: source.isDir,
    reason: args.reason?.trim() || undefined,
  });
  const landed = decision.approved ? (decision.resultPath ?? destDir) : destDir;
  return reportDecision(toolCallId, decision, `Copied ${target.path} to ${landed}.`);
}

export async function moveChapterTool(
  toolCallId: string,
  args: { path?: string; new_path?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "move_chapter", args.path, ctx);
  if ("refusal" in target) return target.refusal;

  const rawDest = args.new_path?.trim();
  if (!rawDest) {
    return { toolCallId, content: "Error: 'new_path' argument is required (the full destination path)." };
  }
  if (!isWorkspacePath(ctx.projectPath, rawDest)) {
    return { toolCallId, content: "Error: the destination must also be inside the project folder (not in .ai-writer)." };
  }

  const source = await statEntry(target.path);
  if (!source) {
    return { toolCallId, content: `Error: "${target.path}" does not exist. Check the path with list_files.` };
  }

  // Files get their extension normalised; a volume folder keeps its bare name.
  const destDir = parentDir(rawDest);
  const destName = rawDest.slice(destDir.length + 1);
  const newPath = source.isDir ? rawDest : `${destDir}/${normalizeChapterFileName(destName)}`;

  if (newPath === target.path) {
    return { toolCallId, content: "Error: the destination is the same as the source." };
  }
  if (await statEntry(newPath)) {
    return { toolCallId, content: `Error: "${newPath}" already exists — moving there would overwrite it.` };
  }
  if (isStrictDescendant(target.path, newPath)) {
    return { toolCallId, content: "Error: cannot move a folder into itself." };
  }

  const decision = await ctx.requestApproval!({
    kind: "move",
    id: `move-${++proposalCounter}`,
    path: target.path,
    newPath,
    isDir: source.isDir,
    reason: args.reason?.trim() || undefined,
  });
  return reportDecision(toolCallId, decision, `Moved ${target.path} to ${newPath}.`);
}

export async function deleteChapterTool(
  toolCallId: string,
  args: { path?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "delete_chapter", args.path, ctx);
  if ("refusal" in target) return target.refusal;

  const reason = args.reason?.trim();
  if (!reason) {
    return { toolCallId, content: "Error: 'reason' argument is required — the author decides on the card, and needs to know why." };
  }

  const stat = await statEntry(target.path);
  if (!stat) {
    return { toolCallId, content: `Error: "${target.path}" does not exist. Check the path with list_files.` };
  }
  if (stat.isDir) {
    return {
      toolCallId,
      content:
        "Error: delete_chapter removes a single chapter file, not a volume folder — use delete_directory for a whole folder (it needs its own approval).",
    };
  }

  let chars = 0;
  try {
    chars = (await readFile(target.path)).length;
  } catch {
    // Unreadable but listed — still proposable; the card just cannot size it.
  }

  const decision = await ctx.requestApproval!({
    kind: "delete",
    id: `delete-${++proposalCounter}`,
    path: target.path,
    chars,
    reason,
  });
  return reportDecision(
    toolCallId,
    decision,
    `Deleted ${target.path}. It was moved to .ai-writer/backups and can be restored.`,
  );
}

/** Files inside a directory tree, recursively — the number the delete card leads with. */
function countFiles(nodes: FileNode[]): number {
  let n = 0;
  for (const node of nodes) {
    n += node.is_dir ? countFiles(node.children ?? []) : 1;
  }
  return n;
}

/**
 * Propose deleting a whole folder. The heavyweight counterpart to
 * `delete_chapter`: the blast radius is every file inside, so the proposal
 * carries a recursive file count for the card to lead with, and the kind
 * ("delete") keeps it permanently outside 本次都批准 grants — every folder
 * deletion is its own card, every time. On approval the whole directory is
 * renamed into `.ai-writer/backups`, so it stays recoverable as one piece.
 */
export async function deleteDirectoryTool(
  toolCallId: string,
  args: { path?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "delete_directory", args.path, ctx);
  if ("refusal" in target) return target.refusal;

  const reason = args.reason?.trim();
  if (!reason) {
    return { toolCallId, content: "Error: 'reason' argument is required — the author decides on the card, and needs to know why." };
  }

  // isWorkspacePath accepts the project root itself; deleting it is not a
  // proposal, it is the workspace.
  if (!isStrictDescendant(ctx.projectPath, target.path)) {
    return { toolCallId, content: "Error: cannot delete the project folder itself." };
  }

  const stat = await statEntry(target.path);
  if (!stat) {
    return { toolCallId, content: `Error: "${target.path}" does not exist. Check the path with list_files.` };
  }
  if (!stat.isDir) {
    return { toolCallId, content: "Error: delete_directory removes a folder — for a single file use delete_chapter." };
  }

  let fileCount = 0;
  try {
    fileCount = countFiles(await readDirRecursive(target.path));
  } catch {
    // Unlistable but present — still proposable; the card just cannot size it.
  }

  const decision = await ctx.requestApproval!({
    kind: "delete",
    id: `delete-${++proposalCounter}`,
    path: target.path,
    chars: 0,
    isDir: true,
    fileCount,
    reason,
  });
  return reportDecision(
    toolCallId,
    decision,
    `Deleted the folder ${target.path} (${fileCount} file(s)). It was moved to .ai-writer/backups and can be restored as a whole.`,
  );
}

// ─── propose_edit ────────────────────────────────────────────────────────────

/** Count non-overlapping occurrences of `find` in `text`. */
export async function proposeEditTool(
  toolCallId: string,
  args: {
    path?: string;
    find?: string;
    replace?: string;
    occurrence?: number;
    replace_all?: boolean;
    reason?: string;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const path = args.path?.trim();
  if (!path) return { toolCallId, content: "Error: 'path' argument is required." };
  // Project files only — .ai-writer would be a back door into lore/profile.
  if (!isWorkspacePath(ctx.projectPath, path)) {
    return { toolCallId, content: "Error: propose_edit only works on files inside the project folder (the app's .ai-writer data is off-limits — use the lore/memory tools for that)." };
  }
  if (typeof args.find !== "string" || !args.find) {
    return { toolCallId, content: "Error: 'find' argument is required (the exact text to replace)." };
  }
  if (typeof args.replace !== "string") {
    return { toolCallId, content: "Error: 'replace' argument is required." };
  }
  if (!ctx.requestApproval) {
    return { toolCallId, content: "Error: this surface cannot review manuscript edits — do not call propose_edit here." };
  }

  let content: string;
  try {
    content = await readFile(path);
  } catch (e) {
    return { toolCallId, content: `Error reading file: ${String(e)}` };
  }
  const occurrences = findOccurrences(content, args.find).length;
  if (occurrences === 0) {
    return {
      toolCallId,
      content: "Error: 'find' text not found in the file. Re-read the file and copy the target text exactly.",
    };
  }

  const all = args.replace_all === true;
  const nth = args.occurrence === undefined ? undefined : Math.floor(Number(args.occurrence));
  if (all && nth !== undefined) {
    return {
      toolCallId,
      content: "Error: pass either 'occurrence' (one of them) or replace_all=true (every one), not both.",
    };
  }
  if (nth !== undefined && (!Number.isFinite(nth) || nth < 1)) {
    return { toolCallId, content: "Error: 'occurrence' must be a whole number ≥ 1 (1 = the first match)." };
  }
  if (nth !== undefined && nth > occurrences) {
    return {
      toolCallId,
      content: `Error: 'find' occurs ${occurrences} time(s) in the file, so occurrence ${nth} does not exist.`,
    };
  }
  // Ambiguity is only an error when the call has not resolved it. Saying which
  // of the three ways out applies is the whole point — the old bare refusal
  // left rewrite_document as the model's only move on a repetitive file.
  if (occurrences > 1 && !all && nth === undefined) {
    return {
      toolCallId,
      content:
        `Error: 'find' text occurs ${occurrences} times, so this call does not say which one you mean. ` +
        "Either include more surrounding text so it is unique, or pass occurrence=N (1-based) for one of them, " +
        "or replace_all=true to change all of them.",
    };
  }

  // A file with a single match is the plain case however it was addressed —
  // normalising here keeps the card and the apply path from having to spell
  // out "occurrence 1 of 1".
  const target = occurrences === 1 ? undefined : all ? ("all" as const) : (nth ?? 1);

  const decision = await ctx.requestApproval({
    kind: "edit",
    id: `edit-${++proposalCounter}`,
    path,
    find: args.find,
    replace: args.replace,
    occurrences,
    target,
    reason: args.reason?.trim() || undefined,
  });

  if (!decision.approved) {
    return {
      toolCallId,
      content: `The user REJECTED this edit${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not retry the same change; adjust per the reason or move on.`,
    };
  }
  const scope = describeEditTarget(occurrences, target);
  return {
    toolCallId,
    content:
      `Edit approved and applied${scope ? ` (${scope})` : ""}.` +
      (decision.backupPath ? ` Previous version backed up to ${decision.backupPath}.` : ""),
  };
}

// ─── rewrite_lines ───────────────────────────────────────────────────────────

/**
 * Replace a range of lines — the chunked path `rewrite_document` never had.
 *
 * `rewrite_document` takes the whole new body as one tool argument, so the
 * file it is most needed for is the file it cannot finish: a long HTML page
 * re-laid-out in one reply runs past the model's output cap, and a tool call
 * cut off there writes NOTHING — the dozen `read_file` calls that preceded it
 * are spent for nothing too. Creation already had the answer to this
 * (`create_file` a skeleton, then `append_file` per section); revision did
 * not, and `propose_edit` cannot express "restructure this whole region"
 * without quoting every original line into `find`.
 *
 * So: the model names a line range it has already read and sends only the
 * replacement. The tool reads that range off disk and builds an ordinary
 * **edit** proposal from it — same card, same approval, same apply path,
 * including the occurrence bookkeeping that refuses a file which moved on
 * while the card was waiting. Nothing here is a new kind of write; the only
 * new thing is that the model no longer has to say the old text out loud.
 *
 * A full re-layout is then K of these, each one landing on disk, so a
 * truncation costs one chunk instead of the whole document.
 */
export async function rewriteLinesTool(
  toolCallId: string,
  args: { path?: string; start_line?: number; end_line?: number; content?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "rewrite_lines", args.path, ctx);
  if ("refusal" in target) return target.refusal;
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
      content: "Error: 'start_line' and 'end_line' must be whole numbers with start_line ≥ 1 and end_line ≥ start_line (read_file's trailer reports the numbers).",
    };
  }

  let original: string;
  try {
    original = await readFile(target.path);
  } catch (e) {
    return { toolCallId, content: `Error reading file: ${String(e)}` };
  }

  const slice = sliceLines(original, from, to);
  if (!slice) {
    return {
      toolCallId,
      content: `Error: start_line ${from} is past the end of the file, which has ${countLines(original)} line(s).`,
    };
  }
  // An empty file has one line of nothing, and an empty `find` can never be
  // located — the proposal would be unappliable. Starting a file is a
  // different tool's job.
  if (slice.text === "") {
    return {
      toolCallId,
      content: `Error: ${target.path} is empty, so there are no lines to replace. Use append_file to write into it.`,
    };
  }

  // Welding guard: the range carries the terminator of its last line, so a
  // replacement without one would run the following line onto this text. The
  // model is not asked to remember that — it is the kind of detail that goes
  // wrong once per long document and shows up as a corrupted heading.
  let replacement = args.content;
  if (slice.text.endsWith("\n") && replacement !== "" && !replacement.endsWith("\n")) {
    replacement += "\n";
  }
  if (replacement === slice.text) {
    return { toolCallId, content: `Lines ${from}-${slice.to} already read exactly like that — nothing to do.` };
  }

  const { occurrences, index } = occurrenceAt(original, slice.text, slice.start);
  const decision = await ctx.requestApproval!({
    kind: "edit",
    id: `edit-${++proposalCounter}`,
    path: target.path,
    find: slice.text,
    replace: replacement,
    occurrences,
    target: occurrences === 1 ? undefined : index,
    range: { from, to: slice.to },
    reason: args.reason?.trim() || undefined,
  });

  if (!decision.approved) {
    return {
      toolCallId,
      content: `The user REJECTED this rewrite${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not resend the same content; adjust per the reason or move on.`,
    };
  }
  const grew = replacement.length - slice.text.length;
  return {
    toolCallId,
    content:
      `Rewrote lines ${from}-${slice.to} of ${target.path} (${slice.text.length} → ${replacement.length} chars, ` +
      `${grew >= 0 ? "+" : ""}${grew}). The rest of the file is untouched — re-read around the region before ` +
      `naming another range, since the line numbers after it have shifted.` +
      (decision.auto ? " Applied under a standing grant — nobody read it." : "") +
      (decision.backupPath ? ` Previous version backed up to ${decision.backupPath}.` : ""),
  };
}

// ─── rewrite_document ────────────────────────────────────────────────────────

/**
 * Below this fraction of the original length, a rewrite is refused outright
 * rather than shown as a card.
 *
 * read_file pages at 4000 chars, so the standing hazard is a model that read
 * the first page, reformatted it, and sent that back as "the whole document" —
 * which would delete the rest. The author *could* catch that on the card, but
 * a proposal that is half the file is far more often this bug than a genuine
 * intent, and bouncing it back to the model (which can then finish reading)
 * fixes it without spending the author's attention. Deliberate large cuts
 * still have propose_edit and delete_chapter.
 */
const REWRITE_MIN_RATIO = 0.5;

/**
 * Add text to the end of an existing file.
 *
 * Deliberately the *only* write that never carries the file's existing
 * content. `create_file` and `rewrite_document` both take the whole body as
 * one tool argument, which means the whole body has to fit inside one model
 * reply — a 60k-character HTML page does not, and the failure mode is a
 * truncated tool call that writes nothing after the model spent the output
 * budget generating it. Appending decouples per-call size from file size:
 * skeleton first, then a section per call, each one landing on disk before the
 * next is generated.
 *
 * The file must already exist. Appending to a missing path would be a
 * disguised create — with none of create_file's extension check, and no way
 * for the author's card to say whether they are approving a new file or an
 * addition to one they know.
 */
export async function appendFileTool(
  toolCallId: string,
  args: { path?: string; content?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = manuscriptTarget(toolCallId, "append_file", args.path, ctx);
  if ("refusal" in target) return target.refusal;
  if (typeof args.content !== "string" || args.content === "") {
    return {
      toolCallId,
      content: "Error: 'content' argument is required — the text to add at the end of the file.",
    };
  }

  let original: string;
  try {
    original = await readFile(target.path);
  } catch {
    return {
      toolCallId,
      content:
        `Error: "${target.path}" does not exist (or cannot be read). append_file only extends a file that is ` +
        "already there — use create_file (or create_chapter) to start it.",
    };
  }

  const decision = await ctx.requestApproval!({
    kind: "append",
    id: `append-${++proposalCounter}`,
    path: target.path,
    content: args.content,
    originalChars: original.length,
    reason: args.reason?.trim() || undefined,
  });

  if (!decision.approved) {
    return {
      toolCallId,
      content: `The user REJECTED this addition${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not resend the same text; adjust per the reason or move on.`,
    };
  }
  return {
    toolCallId,
    content:
      `Appended ${args.content.length} chars to ${target.path} (now ${original.length + args.content.length}).` +
      (decision.auto ? " Applied under a standing grant — nobody read it." : "") +
      (decision.backupPath ? ` Previous version backed up to ${decision.backupPath}.` : ""),
  };
}

export async function rewriteDocumentTool(
  toolCallId: string,
  args: { path?: string; content?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const path = args.path?.trim();
  if (!path) return { toolCallId, content: "Error: 'path' argument is required." };
  if (!isWorkspacePath(ctx.projectPath, path)) {
    return { toolCallId, content: "Error: rewrite_document only works on files inside the project folder (the app's .ai-writer data is off-limits — use the lore/memory tools for that)." };
  }
  if (typeof args.content !== "string") {
    return { toolCallId, content: "Error: 'content' argument is required (the complete new file body)." };
  }
  if (!ctx.requestApproval) {
    return { toolCallId, content: "Error: this surface cannot review manuscript edits — do not call rewrite_document here." };
  }

  let original: string;
  try {
    original = await readFile(path);
  } catch (e) {
    return { toolCallId, content: `Error reading file: ${String(e)}` };
  }

  if (args.content === original) {
    return { toolCallId, content: "The proposed content is identical to the file — nothing to do." };
  }
  if (original.length > 0 && args.content.length < original.length * REWRITE_MIN_RATIO) {
    return {
      toolCallId,
      content:
        `Error: the proposed content is ${args.content.length} chars but the file is ${original.length} — ` +
        `that would delete most of it. If you only read part of the file, call read_file again with start_line ` +
        `until it reports no more lines, then resend the complete document. To remove a passage on purpose, use propose_edit.`,
    };
  }

  const decision = await ctx.requestApproval({
    kind: "rewrite",
    id: `rewrite-${++proposalCounter}`,
    path,
    content: args.content,
    originalChars: original.length,
    reason: args.reason?.trim() || undefined,
  });

  if (!decision.approved) {
    return {
      toolCallId,
      content: `The user REJECTED this rewrite${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not resend the same content; adjust per the reason or move on.`,
    };
  }
  return {
    toolCallId,
    content:
      `Rewrite approved and applied (${original.length} → ${args.content.length} chars).` +
      (decision.backupPath ? ` Previous version backed up to ${decision.backupPath}.` : ""),
  };
}
