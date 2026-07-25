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
  createEntityWithContent,
  parseFacetMeta,
  slugifyEntityId,
  uniqueEntityId,
  writeEntityFile,
  type CategoryId,
} from "../lore";
import {
  loadMemory,
  memoryFilePath,
  projectRelativePath,
  rewriteMemorySegment,
} from "../context/memory";
import { parseFrontmatter } from "../fs/markdown";
import { readFile } from "../fs/fileio";
import { backupFile } from "./backup";
import type { ToolContext } from "./registry";
import { allEntityNames, findEntityByName, isPathWithin, type ToolResult } from "./tools";

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

  const aliases = (args.aliases ?? []).map((a) => String(a).trim()).filter(Boolean);
  const summary = args.summary?.trim() ?? "";
  const entityId = await uniqueEntityId(ctx.projectPath, category, slugifyEntityId(name));
  const dirPath = await createEntityWithContent(
    ctx.projectPath, category, entityId, name, aliases, summary, content,
  );

  ctx.onLoreChanged?.();
  return {
    toolCallId,
    content: `Created lore entity "${name}" (category: ${category}) at ${dirPath}. The lore index has been refreshed.`,
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

  const targetPath = `${entity.dirPath}/${file}`;
  const backupPath = await backupFile(ctx.projectPath, targetPath);
  await writeEntityFile(entity.dirPath, file, content);

  ctx.onLoreChanged?.();
  const suffix = backupPath
    ? `Previous version backed up to ${backupPath}.`
    : "This is a new file (no backup needed).";
  return {
    toolCallId,
    content: `Wrote ${file} of entity "${entity.name}". ${suffix} The lore index has been refreshed.`,
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
