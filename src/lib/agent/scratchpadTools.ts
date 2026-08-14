/**
 * Scratchpad tools for the agent runtime.
 *
 * Implements:
 *   - task_plan: initialize or rewrite task.md plan and steps
 *   - task_progress: increment, check, or log task progress in task.md
 *   - write_note: write an intermediate note to notes/<slug>.md
 *   - read_note: read a note with line-based pagination
 *   - list_notes: list available notes in the active workspace
 *
 * Invariants:
 *   - Sandbox: strictly guarded by isPathWithin and slug sanitization
 *   - Size limits: single note ≤ 100,000 chars, task.md ≤ 20,000 chars
 *   - Write serialization: all writes serialize through a shared writeChain
 *   - No approval gate / No auto-backup (agent's private scratchpad)
 *
 * See docs/subagent-lld.md §3.3 for details.
 */

import { isPathWithin } from "../paths";
import type { ToolCall, ToolResult } from "./tools";
import type { ToolContext } from "./registry";
import {
  appendLogToBody,
  appendStepToBody,
  formatInitialSteps,
  listTaskNotes,
  loadTaskDoc,
  parseSteps,
  readTaskNote,
  sanitizeSlug,
  saveTaskDoc,
  taskWorkspaceDir,
  updateStepInBody,
  writeTaskNote,
  type StepStatus,
  type TaskDoc,
} from "./taskWorkspace";

const MAX_TASK_DOC_CHARS = 20_000;
const MAX_NOTE_CHARS = 100_000;

let writeChain: Promise<unknown> = Promise.resolve();

function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => {}, () => {});
  return run;
}

function parseArgs<T>(raw: string): T {
  try {
    return JSON.parse(raw);
  } catch {
    return {} as T;
  }
}

function noWorkspaceError(call: ToolCall): ToolResult {
  return {
    toolCallId: call.id,
    content: "Error: this surface has no task workspace — do not call this tool here.",
  };
}

// ─── task_plan ───────────────────────────────────────────────────────────────

export async function taskPlanTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.taskWorkspace) return noWorkspaceError(call);

  const args = parseArgs<{ title?: string; steps?: string[] }>(call.arguments);
  const title = (args.title || "").trim();
  const steps = Array.isArray(args.steps) ? args.steps.filter((s) => typeof s === "string" && s.trim()) : [];

  if (!title) {
    return { toolCallId: call.id, content: "Error: 'title' is required for task_plan." };
  }
  if (steps.length === 0) {
    return { toolCallId: call.id, content: "Error: 'steps' array must contain at least one step." };
  }

  return serializeWrite(async () => {
    try {
      const { taskId } = await ctx.taskWorkspace!.ensure(title);
      const existing = await loadTaskDoc(ctx.projectPath, taskId);

      const nowIso = new Date().toISOString();
      const existingProgress = existing?.body.includes("## 进度记录")
        ? existing.body.slice(existing.body.indexOf("## 进度记录"))
        : "## 进度记录\n";

      const newBody = `# ${title}\n\n## 步骤\n\n${formatInitialSteps(steps)}\n\n${existingProgress}\n`;

      if (newBody.length > MAX_TASK_DOC_CHARS) {
        return { toolCallId: call.id, content: `Error: task.md exceeds size limit (${MAX_TASK_DOC_CHARS} chars).` };
      }

      const doc: TaskDoc = {
        meta: {
          taskId,
          status: "in_progress",
          modelId: existing?.meta.modelId || "active",
          createdAt: existing?.meta.createdAt || nowIso,
          updatedAt: nowIso,
          sourceRefs: existing?.meta.sourceRefs,
        },
        body: newBody,
      };

      await saveTaskDoc(ctx.projectPath, taskId, doc);

      return {
        toolCallId: call.id,
        content: `Task plan established successfully for task ${taskId}:\nTitle: ${title}\nSteps: ${steps.length} steps initialized.`,
      };
    } catch (e) {
      return { toolCallId: call.id, content: `Error creating task plan: ${(e as Error).message}` };
    }
  });
}

// ─── task_progress ───────────────────────────────────────────────────────────

export async function taskProgressTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.taskWorkspace) return noWorkspaceError(call);

  const args = parseArgs<{
    action?: "check" | "start" | "skip" | "add_step" | "log";
    step?: number;
    text?: string;
  }>(call.arguments);

  const action = args.action;
  if (!action) {
    return { toolCallId: call.id, content: "Error: 'action' is required (check, start, skip, add_step, log)." };
  }

  return serializeWrite(async () => {
    try {
      const { taskId } = await ctx.taskWorkspace!.ensure("任务");
      const doc = await loadTaskDoc(ctx.projectPath, taskId);
      if (!doc) {
        return { toolCallId: call.id, content: "Error: no task.md exists yet. Call task_plan first." };
      }

      let newBody = doc.body;

      if (action === "check" || action === "start" || action === "skip") {
        const stepNum = typeof args.step === "number" ? args.step : parseInt(String(args.step), 10);
        if (isNaN(stepNum) || stepNum < 1) {
          return { toolCallId: call.id, content: "Error: 'step' (1-indexed number) is required for check/start/skip." };
        }
        const parsedSteps = parseSteps(doc.body);
        if (stepNum > parsedSteps.length) {
          return {
            toolCallId: call.id,
            content: `Error: step index ${stepNum} is out of range. Current task has ${parsedSteps.length} steps.`,
          };
        }
        const targetStatus: StepStatus = action === "check" ? "done" : action === "start" ? "in_progress" : "skipped";
        newBody = updateStepInBody(newBody, stepNum, targetStatus);
      } else if (action === "add_step") {
        const text = (args.text || "").trim();
        if (!text) {
          return { toolCallId: call.id, content: "Error: 'text' is required for add_step." };
        }
        newBody = appendStepToBody(newBody, text);
      } else if (action === "log") {
        const text = (args.text || "").trim();
        if (!text) {
          return { toolCallId: call.id, content: "Error: 'text' is required for log." };
        }
        newBody = appendLogToBody(newBody, text);
      } else {
        return { toolCallId: call.id, content: `Error: unknown action '${action}'.` };
      }

      if (newBody.length > MAX_TASK_DOC_CHARS) {
        return { toolCallId: call.id, content: `Error: task.md exceeds size limit (${MAX_TASK_DOC_CHARS} chars).` };
      }

      const allSteps = parseSteps(newBody);
      const allDone = allSteps.length > 0 && allSteps.every((s) => s.status === "done" || s.status === "skipped");

      doc.body = newBody;
      doc.meta.updatedAt = new Date().toISOString();
      if (allDone && doc.meta.status === "in_progress") {
        doc.meta.status = "completed";
      }

      await saveTaskDoc(ctx.projectPath, taskId, doc);

      const doneCount = allSteps.filter((s) => s.status === "done").length;
      return {
        toolCallId: call.id,
        content: `Progress updated: action '${action}' completed. Current progress: ${doneCount}/${allSteps.length} steps done.`,
      };
    } catch (e) {
      return { toolCallId: call.id, content: `Error updating task progress: ${(e as Error).message}` };
    }
  });
}

// ─── write_note ──────────────────────────────────────────────────────────────

export async function writeNoteTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.taskWorkspace) return noWorkspaceError(call);

  const args = parseArgs<{
    slug?: string;
    title?: string;
    content?: string;
    sources?: string[];
  }>(call.arguments);

  const slug = (args.slug || "").trim();
  const title = (args.title || "").trim();
  const content = (args.content || "").trim();
  const sources = Array.isArray(args.sources) ? args.sources.filter((s) => typeof s === "string") : undefined;

  if (!slug) return { toolCallId: call.id, content: "Error: 'slug' is required for write_note." };
  if (!title) return { toolCallId: call.id, content: "Error: 'title' is required for write_note." };
  if (!content) return { toolCallId: call.id, content: "Error: 'content' is required for write_note." };

  if (content.length > MAX_NOTE_CHARS) {
    return {
      toolCallId: call.id,
      content: `Error: note content exceeds size limit (${MAX_NOTE_CHARS} chars). Please summarize or split into smaller notes.`,
    };
  }

  return serializeWrite(async () => {
    try {
      const { taskId, dir } = await ctx.taskWorkspace!.ensure(title);

      const cleanSlug = sanitizeSlug(slug);
      // Verify path containment
      const targetNotePath = `${dir}/notes/${cleanSlug}.md`;
      if (!isPathWithin(dir, targetNotePath)) {
        return { toolCallId: call.id, content: "Error: invalid slug — path escapes task directory." };
      }

      const note = await writeTaskNote(ctx.projectPath, taskId, {
        slug: cleanSlug,
        title,
        content,
        sources,
      });

      return {
        toolCallId: call.id,
        content: `Note saved successfully to '${note.path}' (${note.chars} chars). You can re-read it anytime using read_note with this path.`,
      };
    } catch (e) {
      return { toolCallId: call.id, content: `Error writing note: ${(e as Error).message}` };
    }
  });
}

// ─── read_note ───────────────────────────────────────────────────────────────

export async function readNoteTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.taskWorkspace) return noWorkspaceError(call);

  const args = parseArgs<{ path?: string; slug?: string; start_line?: number }>(call.arguments);
  const target = (args.path || args.slug || "").trim();
  const startLine = typeof args.start_line === "number" ? args.start_line : 1;

  if (!target) {
    return { toolCallId: call.id, content: "Error: 'path' is required for read_note." };
  }

  try {
    const taskId = ctx.taskWorkspace.taskId;
    if (!taskId) {
      return { toolCallId: call.id, content: "Error: no task workspace exists yet." };
    }

    const dir = taskWorkspaceDir(ctx.projectPath, taskId);
    const resolvedPath = `${ctx.projectPath}/${target.replace(/^\/+/, "")}`;
    if (!isPathWithin(dir, resolvedPath) && !target.match(/^[a-z0-9_-]+$/i)) {
      return { toolCallId: call.id, content: "Error: access denied — path escapes the task workspace." };
    }

    const res = await readTaskNote(ctx.projectPath, taskId, target, startLine);

    let header = `[lines ${res.lines[0]}-${res.lines[1]} of ${res.totalLines}]`;
    if (res.nextStartLine) {
      header += `\n[more content available — continue reading with start_line: ${res.nextStartLine}]`;
    }

    return {
      toolCallId: call.id,
      content: `${header}\n\n${res.content}`,
    };
  } catch (e) {
    return { toolCallId: call.id, content: `Error reading note: ${(e as Error).message}` };
  }
}

// ─── list_notes ──────────────────────────────────────────────────────────────

export async function listNotesTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.taskWorkspace) return noWorkspaceError(call);

  try {
    const taskId = ctx.taskWorkspace.taskId;
    if (!taskId) {
      return { toolCallId: call.id, content: "No notes saved in this task yet." };
    }

    const notes = await listTaskNotes(ctx.projectPath, taskId);
    if (notes.length === 0) {
      return { toolCallId: call.id, content: "No notes saved in this task yet." };
    }

    const lines = notes.map((n) => `- ${n.path} — ${n.title} (${n.chars} chars)`);
    return {
      toolCallId: call.id,
      content: `Available task notes (${notes.length}):\n${lines.join("\n")}`,
    };
  } catch (e) {
    return { toolCallId: call.id, content: `Error listing notes: ${(e as Error).message}` };
  }
}
