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

import i18n from "../../i18n";
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
  /**
   * Set when the requested slug was taken and a suffix was appended, so the
   * caller can tell the model the real filename instead of the one it asked
   * for. Absent on the normal path.
   */
  renamedFrom?: string;
}

export interface TaskWorkspaceHandle {
  /** The assigned or initialized taskId; null if no workspace has been created yet. */
  readonly taskId: string | null;
  /** Ensure workspace directory and initial task.md exist. */
  ensure(title: string): Promise<{ taskId: string; dir: string }>;
}

// ─── Regex & Formatting ──────────────────────────────────────────────────────

const TASK_META_RE = /^<!--\s*ai-writer-task\s*\n([\s\S]*?)\n-->/;
/**
 * A step is any markdown checkbox line, indented or not.
 *
 * Indented ones count deliberately. `task_progress` addresses steps by their
 * 1-based position, and the author reads that position off the rendered list —
 * so a nested item the parser skipped would shift every number after it and
 * silently tick the wrong line.
 */
const STEP_RE = /^\s*[-*]\s+\[([ x/\-])\]\s+(.*)$/;

/**
 * Language-independent anchors for the two sections the tools write into.
 *
 * The headings themselves are translated (the author reads this file), so
 * locating a section by its text would break the moment the app language
 * changes — or, worse, quietly append to the wrong place. Same trick the rest
 * of the project uses for machine state in markdown: an HTML comment that
 * survives rendering and hand-editing alike (see lib/context/memory.ts).
 */
export const STEPS_ANCHOR = "<!-- ai-writer-task-steps -->";
export const LOG_ANCHOR = "<!-- ai-writer-task-log -->";
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

/**
 * The task's name — its H1.
 *
 * The body is author-editable, so the heading may have been moved or removed;
 * null then, and the caller decides what to show instead (the task id reads as
 * a filename, which is right for a list and wrong for a panel header).
 */
export function taskTitle(body: string): string | null {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
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
  return `${body.trim()}\n\n${stepsHeading()}\n\n${newStepLine}\n`;
}

/**
 * Where the section opened at `anchorLine` ends — the index of the next heading,
 * or the end of the document.
 *
 * `trimBlanks` picks which of the two callers' needs it serves. Appending wants
 * the last *content* line, so a new entry sits against the previous one instead
 * of after the gap. Replacing wants the raw boundary, blank lines included:
 * leaving them behind and then writing a fresh separator is how the file grew
 * one blank line per re-plan.
 */
function sectionEnd(lines: string[], anchorLine: number, trimBlanks: boolean): number {
  let end = lines.length;
  for (let i = anchorLine + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (trimBlanks) {
    while (end > anchorLine + 1 && lines[end - 1].trim() === "") end--;
  }
  return end;
}

/**
 * Append one entry to the progress-log section.
 *
 * Inserts at the *end of that section*, not at the end of the file. The
 * distinction matters as soon as the author adds a section of their own below
 * it — appending to the document would file every later entry under whatever
 * heading happens to be last.
 */
export function appendLogToBody(body: string, text: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const logLine = `- ${pad(now.getHours())}:${pad(now.getMinutes())} ${text.trim()}`;

  const lines = body.split("\n");
  const anchorLine = lines.findIndex((l) => l.includes(LOG_ANCHOR));
  if (anchorLine < 0) {
    return `${body.trim()}\n\n${logHeading()}\n\n${logLine}\n`;
  }
  const at = sectionEnd(lines, anchorLine, true);
  // `at === anchorLine + 1` means the section is still empty; the blank line
  // keeps the heading and its first entry apart, the way the rest of the
  // document is spaced.
  lines.splice(at, 0, ...(at === anchorLine + 1 ? ["", logLine] : [logLine]));
  return lines.join("\n");
}

// ─── Section headings ────────────────────────────────────────────────────────
//
// task.md is a file the author opens and edits, so its headings are translated
// — but each carries a stable anchor comment so the tools can still find the
// section in a document written under a different app language.

function stepsHeading(): string {
  return `## ${i18n.t("ai.taskDoc.stepsHeading")} ${STEPS_ANCHOR}`;
}

function logHeading(): string {
  return `## ${i18n.t("ai.taskDoc.logHeading")} ${LOG_ANCHOR}`;
}

/** The body a brand-new workspace starts with: a title and two empty sections. */
export function initialTaskBody(title: string): string {
  const heading = title.trim() || i18n.t("ai.taskDoc.untitled");
  return `# ${heading}\n\n${stepsHeading()}\n\n${logHeading()}\n`;
}

/** Rebuild the steps section, keeping everything else in `body` intact. */
export function withSteps(body: string, steps: string[]): string {
  const lines = body.split("\n");
  const anchorLine = lines.findIndex((l) => l.includes(STEPS_ANCHOR));
  const list = formatInitialSteps(steps);
  if (anchorLine < 0) return `${body.trim()}\n\n${stepsHeading()}\n\n${list}\n`;
  // Untrimmed: the whole span up to the next heading is replaced, blank lines
  // included, and exactly one separator is written back on each side. Keeping
  // the old blanks and adding new ones is what made the gap grow per re-plan.
  const end = sectionEnd(lines, anchorLine, false);
  lines.splice(anchorLine + 1, end - anchorLine - 1, "", list, "");
  return lines.join("\n");
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

/**
 * Turn a model-supplied slug into a safe filename stem.
 *
 * Letters and digits in **any** script survive. An ASCII-only rule looks
 * harmless until you remember who writes with this app: every pure-CJK slug
 * ("搜索结果", "第一章分析") reduces to nothing and falls back to the same
 * name, so a Chinese project's notes all pile into `note.md`, each overwriting
 * the last — which is precisely the data loss the workspace exists to prevent.
 *
 * Path separators, dots and everything else structural are still stripped:
 * `\p{L}`/`\p{N}` admit no `/`, `\` or `.`, so the result can never climb out
 * of the notes directory whatever the model sends.
 */
export function sanitizeSlug(slug: string): string {
  const clean = slug
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  // Sliced by code points, not UTF-16 units: cutting at 60 units could land
  // inside a surrogate pair and leave a lone half in a filename.
  return [...clean].slice(0, 60).join("") || "note";
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

/**
 * Serializer every `task.md` write goes through.
 *
 * Lives here rather than with the tools because the tools are no longer the
 * only writer: pausing, resuming and source-ref recording all read-modify-write
 * the same file, and a chain that covered only the tools would let those race
 * with them and lose an update.
 */
let writeChain: Promise<unknown> = Promise.resolve();

export function serializeTaskWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => {}, () => {});
  return run;
}

/** Read-modify-write one task.md under the shared chain. No-op if it's gone. */
async function patchTaskDoc(
  projectPath: string,
  taskId: string,
  patch: (doc: TaskDoc) => void,
): Promise<void> {
  await serializeTaskWrite(async () => {
    const doc = await loadTaskDoc(projectPath, taskId);
    if (!doc) return;
    patch(doc);
    doc.meta.updatedAt = new Date().toISOString();
    await saveTaskDoc(projectPath, taskId, doc);
  });
}

/** Author chose 存盘暂停 at the round cap: the task keeps its place on disk. */
export async function markTaskPaused(projectPath: string, taskId: string): Promise<void> {
  await patchTaskDoc(projectPath, taskId, (doc) => {
    doc.meta.status = "paused";
    doc.body = appendLogToBody(doc.body, i18n.t("ai.taskDoc.logPaused"));
  });
}

/** Author picked 恢复并继续 — undone again if the resumed run never starts. */
export async function markTaskResumed(projectPath: string, taskId: string): Promise<void> {
  await patchTaskDoc(projectPath, taskId, (doc) => {
    doc.meta.status = "in_progress";
    doc.body = appendLogToBody(doc.body, i18n.t("ai.taskDoc.logResumed"));
  });
}

/**
 * Note that this task's work was based on `relPath` as it stood, so a resume can
 * warn that the author has edited it since.
 *
 * Recorded at pause time rather than on every read: it is the state the task was
 * suspended against that a resume needs to compare with, and hashing every file
 * the model happened to open would cost a full re-read per tool call.
 */
export async function recordSourceRef(
  projectPath: string,
  taskId: string,
  relPath: string,
  hash: string,
): Promise<void> {
  await patchTaskDoc(projectPath, taskId, (doc) => {
    const refs = (doc.meta.sourceRefs ?? []).filter((r) => r.path !== relPath);
    refs.push({ path: relPath, hash });
    doc.meta.sourceRefs = refs;
  });
}

export async function saveTaskDoc(projectPath: string, taskId: string, doc: TaskDoc): Promise<void> {
  const dir = taskWorkspaceDir(projectPath, taskId);
  await makeDir(dir);
  await makeDir(taskNotesDir(projectPath, taskId));
  const raw = serializeTaskDoc(doc.meta, doc.body);
  await writeFile(taskDocPath(projectPath, taskId), raw);
}

/** How many `-2`, `-3`… suffixes to try before giving up on a free filename. */
const MAX_SLUG_ATTEMPTS = 50;

export async function writeTaskNote(
  projectPath: string,
  taskId: string,
  opts: { slug: string; title: string; content: string; sources?: string[] },
): Promise<TaskNoteHeader> {
  const base = sanitizeSlug(opts.slug);
  const notesDir = taskNotesDir(projectPath, taskId);
  await makeDir(notesDir);

  // Never overwrite. Two findings that happen to share a slug are two
  // findings; silently replacing the first is the same data loss the notes
  // directory exists to prevent, and the model has no way to notice it
  // happened. `renamedFrom` lets the tool tell it what the file ended up called.
  let slug = base;
  for (let n = 2; n <= MAX_SLUG_ATTEMPTS; n++) {
    if (!(await fileExists(`${notesDir}/${slug}.md`))) break;
    slug = `${base}-${n}`;
  }

  let body = `# ${opts.title.trim()}\n\n`;
  if (opts.sources && opts.sources.length > 0) {
    body += `> ${i18n.t("ai.taskDoc.sources")}\n${opts.sources.map((s) => `> - ${s}`).join("\n")}\n\n`;
  }
  body += opts.content.trim() + "\n";

  await writeFile(`${notesDir}/${slug}.md`, body);

  return {
    slug,
    title: opts.title.trim(),
    path: `.ai-writer/tasks/${taskId}/notes/${slug}.md`,
    chars: body.length,
    ...(slug === base ? {} : { renamedFrom: base }),
  };
}

const NOTE_PAGE_CHARS = 4000;

/**
 * Resolve however the model referred to a note down to a slug in *this* task,
 * or null when the reference points somewhere else entirely.
 *
 * Three forms are accepted because all three are things a model will send, and
 * two of them come straight out of this app's own tool results: the relative
 * path `list_notes` prints, the bare filename, and the bare slug. Rejecting the
 * `<slug>.md` form — which the previous containment check did — meant answering
 * an obviously benign input with a security error, and a model that reads
 * "access denied" tends to retry the same thing rather than reformat it.
 *
 * A path naming a *different* task returns null instead of being coerced into
 * this one: reading a note the caller didn't ask for is worse than not finding it.
 */
export function noteSlugFromReference(reference: string, taskId: string): string | null {
  let ref = reference.trim().replace(/^\/+/, "");
  const prefix = ".ai-writer/tasks/";
  if (ref.startsWith(prefix)) {
    const rest = ref.slice(prefix.length);
    const [owner, notes, ...tail] = rest.split("/");
    if (owner !== taskId || notes !== "notes" || tail.length !== 1) return null;
    ref = tail[0];
  }
  // Anything still carrying structure is not a note in this task's folder.
  if (ref.includes("/") || ref.includes("\\")) return null;
  return sanitizeSlug(ref.replace(/\.md$/i, ""));
}

export async function readTaskNote(
  projectPath: string,
  taskId: string,
  notePathOrSlug: string,
  startLine = 1,
): Promise<{ content: string; lines: [number, number]; totalLines: number; nextStartLine?: number }> {
  const slug = noteSlugFromReference(notePathOrSlug, taskId);
  if (!slug) throw new Error(`Note not found: ${notePathOrSlug}`);
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
      });
    } catch {
      // skip unreadable note
    }
  }

  // Stable order, so the same list twice in one conversation reads the same
  // way — readDir makes no promise about the order the OS hands entries back.
  return headers.sort((a, b) => a.slug.localeCompare(b.slug));
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

export interface TaskSummary {
  taskId: string;
  status: TaskStatus;
  title: string;
  stepsTotal: number;
  stepsDone: number;
  updatedAt: string;
}

/** List all tasks in the project with summary metadata, sorted newest first. */
export async function listTaskSummaries(projectPath: string): Promise<TaskSummary[]> {
  const root = `${projectPath}/.ai-writer/tasks`;
  if (!(await fileExists(root))) return [];
  try {
    const entries = await readDir(root);
    const results: TaskSummary[] = [];
    for (const e of entries) {
      if (!e.isDirectory) continue;
      const doc = await loadTaskDoc(projectPath, e.name);
      if (!doc) continue;
      const steps = parseSteps(doc.body);
      const title = taskTitle(doc.body) ?? doc.meta.taskId;
      const stepsDone = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
      results.push({
        taskId: doc.meta.taskId,
        status: doc.meta.status,
        title,
        stepsTotal: steps.length,
        stepsDone,
        updatedAt: doc.meta.updatedAt,
      });
    }
    return results.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  } catch {
    return [];
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
        // No placeholder step. A fabricated "- [ ] 开始任务" would be counted by
        // parseSteps, so `task_progress` would report 0/1 done on a task nobody
        // planned — and the model would tick a step it never wrote.
        body: initialTaskBody(title),
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
