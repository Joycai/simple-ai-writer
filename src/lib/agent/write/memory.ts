/**
 * Story memory: `read_memory` / `update_memory`.
 *
 * Part of the L1/L2 write tools, split out of `writeTools.ts` by section
 * (docs/feature/code-structure-plan.md P6); `writeTools.ts` re-exports the
 * tools, so importers keep one address. The policy every handler follows is
 * in that file's header.
 */


import {
  loadMemory,
  memoryFilePath,
  projectRelativePath,
  rewriteMemorySegment,
} from "../../context/memory";
import { changeAfterWrite, snapshotFile } from "../backup";
import type { ToolContext } from "../registry";
import { isPathWithin, resolveRelativePath } from "../../paths";
import { type ToolResult } from "../tools";


// ─── read_memory / update_memory ─────────────────────────────────────────────

function checkDocPath(toolCallId: string, ctx: ToolContext, path?: string): ToolResult | string {
  const raw = path?.trim();
  if (!raw) return { toolCallId, content: "Error: 'path' argument is required (the document's path, as returned by list_files)." };
  // An empty projectPath would prefix-match every absolute path — fail closed.
  if (!ctx.projectPath) {
    return { toolCallId, content: "Error: Path is outside the project directory." };
  }
  const p = resolveRelativePath(ctx.projectPath, raw);
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
  const memPath = rel ? memoryFilePath(ctx.projectPath, rel) : null;
  const snap = memPath ? await snapshotFile(ctx.projectPath, memPath) : null;
  const backupPath = snap?.path ?? null;

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
    // No entity: the memory file belongs to a document, and `path` names it.
    ...(memPath
      ? {
          change: await changeAfterWrite({
            projectPath: ctx.projectPath,
            path: memPath,
            before: snap?.text,
            backupPath,
          }),
        }
      : {}),
  };
}
