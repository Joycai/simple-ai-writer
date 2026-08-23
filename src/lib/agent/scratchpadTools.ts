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
 *   - Sandbox: every filename goes through `sanitizeSlug`, which admits only
 *     letters, digits and dashes — no separator survives, so a name can never
 *     leave the notes folder it is joined to. References the model supplies for
 *     *reading* are resolved by `noteSlugFromReference`, which refuses anything
 *     naming another task.
 *   - Only `task_plan` and `write_note` may create the workspace; everything
 *     else operates on one that already exists (see `requireTaskId`).
 *   - Size limits: single note ≤ 100,000 chars, task.md ≤ 20,000 chars
 *   - Write serialization: all writes serialize through a shared writeChain
 *   - No approval gate / No auto-backup (agent's private scratchpad)
 *
 * See docs/feature/agent/subagent-lld.md §3.3 for details.
 */

import i18n from "../../i18n";
import type { ToolCall, ToolResult } from "./tools";
import type { ToolContext } from "./registry";
import {
  appendLogToBody,
  appendStepToBody,
  listTaskNotes,
  loadTaskDoc,
  parseSteps,
  readTaskNote,
  saveTaskDoc,
  serializeTaskWrite as serializeWrite,
  updateStepInBody,
  withSteps,
  writeTaskNote,
  type StepStatus,
  type TaskDoc,
} from "./taskWorkspace";

const MAX_TASK_DOC_CHARS = 20_000;
const MAX_NOTE_CHARS = 100_000;

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

/**
 * The workspace this run already owns, or an error telling the model to plan first.
 *
 * Only `task_plan` and `write_note` may bring a workspace into being. Everything
 * else works on one that exists — `task_progress` in particular, because
 * `ensure()`ing from there used to create the task *and* satisfy the very check
 * meant to demand a plan, so the "call task_plan first" branch could never run
 * and a stray progress call left behind a workspace titled after nothing.
 */
function requireTaskId(call: ToolCall, ctx: ToolContext): string | ToolResult {
  const taskId = ctx.taskWorkspace?.taskId;
  if (!taskId) {
    return {
      toolCallId: call.id,
      content:
        "Error: no task workspace exists yet. Call task_plan first to state the goal and the steps.",
    };
  }
  return taskId;
}

/** Replace the document's H1, or add one when the body has none. */
function retitle(body: string, title: string): string {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => /^#\s/.test(l));
  if (at < 0) return `# ${title}\n\n${body.trim()}`;
  lines[at] = `# ${title}`;
  return lines.join("\n");
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
      // The one tool that may create the workspace with a real title — the
      // title IS the plan's subject. `ensure` stamps the run's model id, so
      // nothing here has to invent one.
      const { taskId } = await ctx.taskWorkspace!.ensure(title);
      const existing = await loadTaskDoc(ctx.projectPath, taskId);
      if (!existing) {
        return { toolCallId: call.id, content: "Error: could not read task.md after creating it." };
      }

      // Only the steps section is rebuilt. The progress log — and anything the
      // author added by hand — survives a re-plan; replanning is a normal move
      // mid-task, and it must not silently erase the record of what was done.
      const newBody = withSteps(retitle(existing.body, title), steps);
      if (newBody.length > MAX_TASK_DOC_CHARS) {
        return {
          toolCallId: call.id,
          content: `Error: task.md would exceed its size limit (${MAX_TASK_DOC_CHARS} chars). Use fewer or shorter steps.`,
        };
      }

      const doc: TaskDoc = {
        meta: { ...existing.meta, status: "in_progress", updatedAt: new Date().toISOString() },
        body: newBody,
      };
      await saveTaskDoc(ctx.projectPath, taskId, doc);

      return {
        toolCallId: call.id,
        content: `Task plan saved (task ${taskId}): "${title}", ${steps.length} step(s). Mark each step with task_progress as you work: 'start' when you begin it, 'check' the moment it is done — do not batch updates at the end.`,
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

  const taskIdOrError = requireTaskId(call, ctx);
  if (typeof taskIdOrError !== "string") return taskIdOrError;
  const taskId = taskIdOrError;

  return serializeWrite(async () => {
    try {
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

  // No serializeWrite wrapper of its own: `writeTaskNote` runs on the shared
  // write chain internally (it must — parallel delegations write notes too,
  // see agent/runtime), and chaining here again would deadlock, the outer
  // entry waiting on an inner one queued behind it. `ensure` needs no chain:
  // its taskId assignment is synchronous, so a double-create cannot happen.
  try {
    // A note is a legitimate first artefact — the checkpoint nudge asks for
    // one by name, and refusing it until a plan exists would make that nudge
    // a dead end. But the workspace is titled generically, NOT after this
    // note: the task's name is the plan's business, and letting whichever
    // note happened to come first name the whole task made it a lottery.
    const { taskId } = await ctx.taskWorkspace!.ensure(i18n.t("ai.taskDoc.untitled"));

    // Containment needs no check here: `writeTaskNote` runs the slug through
    // `sanitizeSlug`, which admits only letters, digits and dashes — a name
    // with no separator in it cannot leave the folder it is joined to.
    const note = await writeTaskNote(ctx.projectPath, taskId, {
      slug,
      title,
      content,
      sources,
      origin: "main",
    });

    const renamed = note.renamedFrom
      ? ` (a note called "${note.renamedFrom}" already existed, so this one was filed as "${note.slug}")`
      : "";
    return {
      toolCallId: call.id,
      content: `Note saved to '${note.path}' (${note.chars} chars)${renamed}. Read it back any time with read_note.`,
    };
  } catch (e) {
    return { toolCallId: call.id, content: `Error writing note: ${(e as Error).message}` };
  }
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

  const taskIdOrError = requireTaskId(call, ctx);
  if (typeof taskIdOrError !== "string") return taskIdOrError;

  try {
    // The reference is resolved to a slug inside this task's own notes folder
    // (see noteSlugFromReference); a path naming anywhere else comes back as
    // "not found" rather than being read.
    const res = await readTaskNote(ctx.projectPath, taskIdOrError, target, startLine);

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
