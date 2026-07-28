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
 * Manuscript (writing/) edits are deliberately absent: those are L2 and go
 * through the propose→diff→approve flow (PR4).
 */

import {
  LORE_CATEGORIES,
  RESERVED_ENTITY_FILES,
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
import { parseFrontmatter } from "../fs/markdown";
import { makeDir, readFile, removeFile, renamePath } from "../fs/fileio";
import { backupFile } from "./backup";
import {
  LORE_PLAN_ACTIONS,
  checkPlan,
  describeStep,
  outstandingSteps,
  type LorePlanAction,
  type LorePlanStep,
} from "./plan";
import type { ToolContext } from "./registry";
import { allEntityNames, findEntityByName, isPathWithin, type ToolResult } from "./tools";

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

  const categoryIds = LORE_CATEGORIES.map((c) => c.id);
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

  ctx.onLoreChanged?.();
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

  const file = (args.file ?? "index.md").trim();
  // Single filename inside the entity dir — the argument is model-controlled,
  // so refuse anything that could navigate ('/', '\', '..') and non-md targets.
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

  ctx.onLoreChanged?.();
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

  // Read from disk rather than trusting the run snapshot: a facet this run
  // just created through update_lore_file is on disk but not in the snapshot.
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

  ctx.onLoreChanged?.();
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

  ctx.onLoreChanged?.();
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
 * ctx.loreIndex is captured at run start (see registry.ToolContext) — the
 * app-side rescan that onLoreChanged fires never reaches it. Without this, the
 * next call in the same run resolves the entity to a directory that no longer
 * exists, and the model gets a baffling ENOENT for the move it just made
 * successfully. Pass `next: null` to drop the entity entirely.
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

  const categoryIds = LORE_CATEGORIES.map((c) => c.id);
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

  ctx.onLoreChanged?.();
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
  ctx.onLoreChanged?.();
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
  if (!p) return { toolCallId, content: "Error: 'path' argument is required (the writing file's absolute path, as returned by list_files)." };
  if (!isPathWithin(ctx.projectPath, p)) {
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

// ─── propose_edit (L2 — approval required) ───────────────────────────────────

let proposalCounter = 0;

/** Count non-overlapping occurrences of `find` in `text`. */
function countOccurrences(text: string, find: string): number {
  if (!find) return 0;
  let count = 0;
  for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + find.length)) count++;
  return count;
}

export async function proposeEditTool(
  toolCallId: string,
  args: { path?: string; find?: string; replace?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const path = args.path?.trim();
  if (!path) return { toolCallId, content: "Error: 'path' argument is required." };
  // Manuscript edits only — lore/memory have their own (L1) tools.
  if (!isPathWithin(`${ctx.projectPath}/writing`, path)) {
    return { toolCallId, content: "Error: propose_edit only works on files under the project's writing/ directory." };
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
  const occurrences = countOccurrences(content, args.find);
  if (occurrences === 0) {
    return {
      toolCallId,
      content: "Error: 'find' text not found in the file. Re-read the file and copy the target text exactly.",
    };
  }
  if (occurrences > 1) {
    return {
      toolCallId,
      content: `Error: 'find' text occurs ${occurrences} times — include more surrounding text so it is unique.`,
    };
  }

  const decision = await ctx.requestApproval({
    id: `edit-${++proposalCounter}`,
    path,
    find: args.find,
    replace: args.replace,
    reason: args.reason?.trim() || undefined,
  });

  if (!decision.approved) {
    return {
      toolCallId,
      content: `The user REJECTED this edit${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not retry the same change; adjust per the reason or move on.`,
    };
  }
  return {
    toolCallId,
    content:
      `Edit approved and applied.` +
      (decision.backupPath ? ` Previous version backed up to ${decision.backupPath}.` : ""),
  };
}
