/**
 * Task Workspace (.ai-writer/tasks/<taskId>/) — disk-backed memory and notes
 * for long-running agent tasks.
 *
 * File layout:
 *   .ai-writer/tasks/<taskId>/
 *     ├── task.md        ← Machine status in 3-line comment header + author-editable Markdown
 *     └── notes/         ← Intermediate scratchpad notes (search findings, vision, digests)
 *
 * See docs/subagent-lld.md §3 for full design specification.
 */

import {
  fileExists,
  makeDir,
  readDir,
  readFile,
  removeDir,
  writeFile,
} from "../fs/fileio";

export type TaskStatus = "in_progress" | "paused" | "completed" | "failed";
export type StepStatus = "pending" | "in_progress" | "done" | "skipped";

export const MAX_SAVED_TASKS = 20;

/** Machine-only metadata in task.md header. Steps are stored in body text only. */
export interface TaskMeta {
  taskId: string;
  status: TaskStatus;
  /** Active Model row ID (Model.id). */
  modelId: string;
  createdAt: string;
  updatedAt: string;
  /** Used on resume to check if referenced files were edited while paused. */
  sourceRefs?: { path: string; hash: string }[];
}

/** Step parsed from Markdown checkboxes in task.md body. 1-indexed. */
export interface TaskStep {
  index: number;
  title: string;
  status: StepStatus;
}

export interface TaskDoc {
  meta: TaskMeta;
  /** Human-editable Markdown body. */
  body: string;
}

export interface TaskNoteHeader {
  slug: string;
  title: string;
  /** Project-relative path, e.g. .ai-writer/tasks/<taskId>/notes/<slug>.md */
  path: string;
  chars: number;
  updatedAt: string;
}

export interface TaskWorkspaceHandle {
  /** The assigned or initialized taskId; null if no workspace has been created yet. */
  readonly taskId: string | null;
  /** Ensure workspace directory and initial task.md exist. */
  ensure(title: string): Promise<{ taskId: string; dir: string }>;
}

// ─── Regex & Formatting ──────────────────────────────────────────────────────

const TASK_META_RE = /^<!--\s*ai-writer-task\s*\n([\s\S]*?)\n-->/;
const STEP_RE = /^[-*]\s+\[([ x/\-])\]\s+(.*)$/;
const GLYPH: Record<string, StepStatus> = {
  " ": "pending",
  "/": "in_progress",
  x: "done",
  "-": "skipped",
};
const STATUS_GLYPH: Record<StepStatus, string> = {
  pending: " ",
  in_progress: "/",
  done: "x",
  skipped: "-",
};

export function serializeTaskDoc(meta: TaskMeta, body: string): string {
  return `<!-- ai-writer-task\n${JSON.stringify(meta)}\n-->\n\n${body.trim()}\n`;
}

export function parseTaskDoc(raw: string): TaskDoc | null {
  const m = raw.match(TASK_META_RE);
  if (!m) return null;
  let meta: unknown;
  try {
    meta = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!meta || typeof meta !== "object" || typeof (meta as TaskMeta).taskId !== "string") {
    return null;
  }
  return { meta: meta as TaskMeta, body: raw.slice(m[0].length).trim() };
}

/** Parse markdown checkbox lines into a 1-indexed steps array. */
export function parseSteps(body: string): TaskStep[] {
  const out: TaskStep[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(STEP_RE);
    if (m) {
      out.push({
        index: out.length + 1,
        title: m[2].trim(),
        status: GLYPH[m[1]] ?? "pending",
      });
    }
  }
  return out;
}

/** Format a list of step titles into Markdown checkbox list. */
export function formatInitialSteps(steps: string[]): string {
  return steps.map((s) => `- [ ] ${s.trim()}`).join("\n");
}

/** Update status of a specific 1-indexed step in body text. */
export function updateStepInBody(body: string, stepIndex: number, newStatus: StepStatus): string {
  const lines = body.split("\n");
  let currentStep = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(STEP_RE);
    if (m) {
      currentStep++;
      if (currentStep === stepIndex) {
        const glyph = STATUS_GLYPH[newStatus];
        lines[i] = lines[i].replace(/\[[ x/\-]\]/, `[${glyph}]`);
        break;
      }
    }
  }
  return lines.join("\n");
}

/** Append a new step to the steps list section. */
export function appendStepToBody(body: string, stepTitle: string): string {
  const lines = body.split("\n");
  let lastStepIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (STEP_RE.test(lines[i])) {
      lastStepIndex = i;
    }
  }
  const newStepLine = `- [ ] ${stepTitle.trim()}`;
  if (lastStepIndex >= 0) {
    lines.splice(lastStepIndex + 1, 0, newStepLine);
    return lines.join("\n");
  }
  // If no steps section exists, add one
  return `${body.trim()}\n\n## 步骤\n\n${newStepLine}\n`;
}

/** Append a log entry to ## 进度记录 section. */
export function appendLogToBody(body: string, text: string): string {
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const logLine = `- ${timeStr} ${text.trim()}`;

  const progressHeaderIndex = body.indexOf("## 进度记录");
  if (progressHeaderIndex >= 0) {
    return `${body.trim()}\n${logLine}\n`;
  }
  return `${body.trim()}\n\n## 进度记录\n\n${logLine}\n`;
}

// ─── Paths & ID ──────────────────────────────────────────────────────────────

export function generateTaskId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

export function taskWorkspaceDir(projectPath: string, taskId: string): string {
  return `${projectPath}/.ai-writer/tasks/${taskId}`;
}

export function taskDocPath(projectPath: string, taskId: string): string {
  return `${taskWorkspaceDir(projectPath, taskId)}/task.md`;
}

export function taskNotesDir(projectPath: string, taskId: string): string {
  return `${taskWorkspaceDir(projectPath, taskId)}/notes`;
}

export function sanitizeSlug(slug: string): string {
  const clean = slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return clean.slice(0, 60) || "note";
}

// ─── File Operations ─────────────────────────────────────────────────────────

export async function loadTaskDoc(projectPath: string, taskId: string): Promise<TaskDoc | null> {
  const path = taskDocPath(projectPath, taskId);
  if (!(await fileExists(path))) return null;
  try {
    const raw = await readFile(path);
    return parseTaskDoc(raw);
  } catch {
    return null;
  }
}

export async function saveTaskDoc(projectPath: string, taskId: string, doc: TaskDoc): Promise<void> {
  const dir = taskWorkspaceDir(projectPath, taskId);
  await makeDir(dir);
  await makeDir(taskNotesDir(projectPath, taskId));
  const raw = serializeTaskDoc(doc.meta, doc.body);
  await writeFile(taskDocPath(projectPath, taskId), raw);
}

export async function writeTaskNote(
  projectPath: string,
  taskId: string,
  opts: { slug: string; title: string; content: string; sources?: string[] },
): Promise<TaskNoteHeader> {
  const slug = sanitizeSlug(opts.slug);
  const notesDir = taskNotesDir(projectPath, taskId);
  await makeDir(notesDir);

  const fullPath = `${notesDir}/${slug}.md`;
  const relPath = `.ai-writer/tasks/${taskId}/notes/${slug}.md`;
  const nowIso = new Date().toISOString();

  let body = `# ${opts.title.trim()}\n\n`;
  if (opts.sources && opts.sources.length > 0) {
    body += `> **来源**：\n${opts.sources.map((s) => `> - ${s}`).join("\n")}\n\n`;
  }
  body += opts.content.trim() + "\n";

  await writeFile(fullPath, body);

  return {
    slug,
    title: opts.title.trim(),
    path: relPath,
    chars: body.length,
    updatedAt: nowIso,
  };
}

const NOTE_PAGE_CHARS = 4000;

export async function readTaskNote(
  projectPath: string,
  taskId: string,
  notePathOrSlug: string,
  startLine = 1,
): Promise<{ content: string; lines: [number, number]; totalLines: number; nextStartLine?: number }> {
  const cleanSlug = notePathOrSlug.replace(/^\.ai-writer\/tasks\/[^/]+\/notes\//, "").replace(/\.md$/, "");
  const slug = sanitizeSlug(cleanSlug);
  const fullPath = `${taskNotesDir(projectPath, taskId)}/${slug}.md`;

  if (!(await fileExists(fullPath))) {
    throw new Error(`Note not found: ${notePathOrSlug}`);
  }

  const raw = await readFile(fullPath);
  const lines = raw.split("\n");
  const totalLines = lines.length;

  const start = Math.max(1, Math.min(startLine, totalLines));
  let end = start;
  let charCount = 0;

  while (end <= totalLines) {
    const lineLen = lines[end - 1].length + 1;
    if (charCount + lineLen > NOTE_PAGE_CHARS && end > start) {
      break;
    }
    charCount += lineLen;
    end++;
  }

  const contentSlice = lines.slice(start - 1, end - 1).join("\n");
  const nextStartLine = end <= totalLines ? end : undefined;

  return {
    content: contentSlice,
    lines: [start, end - 1],
    totalLines,
    nextStartLine,
  };
}

export async function listTaskNotes(projectPath: string, taskId: string): Promise<TaskNoteHeader[]> {
  const notesDir = taskNotesDir(projectPath, taskId);
  if (!(await fileExists(notesDir))) return [];

  const entries = await readDir(notesDir);
  const headers: TaskNoteHeader[] = [];

  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith(".md")) continue;
    try {
      const content = await readFile(entry.path);
      const firstLine = content.split("\n")[0] || "";
      const title = firstLine.replace(/^#+\s*/, "").trim() || entry.name.replace(/\.md$/, "");
      const slug = entry.name.replace(/\.md$/, "");
      headers.push({
        slug,
        title,
        path: `.ai-writer/tasks/${taskId}/notes/${entry.name}`,
        chars: content.length,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // skip unreadable note
    }
  }

  return headers;
}

// ─── GC & Retention ─────────────────────────────────────────────────────────

export async function gcTasks(projectPath: string, keepTaskId?: string | null): Promise<void> {
  const root = `${projectPath}/.ai-writer/tasks`;
  if (!(await fileExists(root))) return;

  try {
    const entries = await readDir(root);
    const dirs = entries.filter((e) => e.isDirectory);
    if (dirs.length <= MAX_SAVED_TASKS) return;

    interface TaskSummary {
      taskId: string;
      path: string;
      status: TaskStatus;
      updatedAt: number;
    }

    const tasks: TaskSummary[] = [];

    for (const dir of dirs) {
      const doc = await loadTaskDoc(projectPath, dir.name);
      if (doc) {
        tasks.push({
          taskId: dir.name,
          path: dir.path,
          status: doc.meta.status,
          updatedAt: Date.parse(doc.meta.updatedAt) || 0,
        });
      } else {
        // Corrupted or empty task dir
        tasks.push({
          taskId: dir.name,
          path: dir.path,
          status: "failed",
          updatedAt: 0,
        });
      }
    }

    // Sort order:
    // 1. Completed / failed tasks come first (pruned first)
    // 2. Older updatedAt comes first
    tasks.sort((a, b) => {
      const aDone = a.status === "completed" || a.status === "failed";
      const bDone = b.status === "completed" || b.status === "failed";
      if (aDone !== bDone) return aDone ? -1 : 1;
      return a.updatedAt - b.updatedAt;
    });

    const excessCount = tasks.length - MAX_SAVED_TASKS;
    let pruned = 0;

    for (const t of tasks) {
      if (pruned >= excessCount) break;
      if (keepTaskId && t.taskId === keepTaskId) continue;
      try {
        await removeDir(t.path);
        pruned++;
      } catch (e) {
        console.warn(`[taskWorkspace] failed to prune task ${t.taskId}:`, e);
      }
    }
  } catch (e) {
    console.warn("[taskWorkspace] gcTasks failed:", e);
  }
}

// ─── Workspace Handles ───────────────────────────────────────────────────────

/** Create a lazy TaskWorkspaceHandle. Creates directory only on first ensure(). */
export function createTaskWorkspace(
  projectPath: string,
  modelId: string,
  initialTaskId?: string,
): TaskWorkspaceHandle {
  let activeId = initialTaskId ?? null;

  return {
    get taskId() {
      return activeId;
    },
    async ensure(title: string) {
      if (activeId) {
        const dir = taskWorkspaceDir(projectPath, activeId);
        return { taskId: activeId, dir };
      }
      activeId = generateTaskId();
      const nowIso = new Date().toISOString();
      const dir = taskWorkspaceDir(projectPath, activeId);
      await makeDir(dir);
      await makeDir(taskNotesDir(projectPath, activeId));

      const doc: TaskDoc = {
        meta: {
          taskId: activeId,
          status: "in_progress",
          modelId,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        body: `# ${title.trim() || "未命名任务"}\n\n## 步骤\n\n- [ ] 开始任务\n\n## 进度记录\n`,
      };

      await writeFile(taskDocPath(projectPath, activeId), serializeTaskDoc(doc.meta, doc.body));

      // Asynchronous background GC (non-blocking)
      void gcTasks(projectPath, activeId);

      return { taskId: activeId, dir };
    },
  };
}

/** Return a handle for an existing task workspace (e.g. for resume). */
export function existingWorkspace(projectPath: string, taskId: string): TaskWorkspaceHandle {
  return {
    get taskId() {
      return taskId;
    },
    async ensure() {
      const dir = taskWorkspaceDir(projectPath, taskId);
      await makeDir(dir);
      return { taskId, dir };
    },
  };
}
