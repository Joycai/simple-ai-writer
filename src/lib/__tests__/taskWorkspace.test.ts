import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = new Map<string, string>();

vi.mock("../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    if (!fs.has(p)) throw new Error(`ENOENT: ${p}`);
    return fs.get(p)!;
  }),
  writeFile: vi.fn(async (p: string, c: string) => void fs.set(p, c)),
  fileExists: vi.fn(async (p: string) => fs.has(p) || [...fs.keys()].some((k) => k.startsWith(p.replace(/\/+$/, "") + "/"))),
  makeDir: vi.fn(async () => {}),
  removeDir: vi.fn(async (dir: string) => {
    const prefix = dir.replace(/\/+$/, "") + "/";
    for (const k of [...fs.keys()]) {
      if (k.startsWith(prefix) || k === dir) fs.delete(k);
    }
  }),
  readDir: vi.fn(async (dir: string) => {
    const prefix = dir.replace(/\/+$/, "") + "/";
    const seen = new Map<string, boolean>();
    for (const path of fs.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const cut = rest.indexOf("/");
      if (cut < 0) seen.set(rest, false);
      else seen.set(rest.slice(0, cut), true);
    }
    return [...seen].map(([name, isDirectory]) => ({
      name,
      path: prefix + name,
      isDirectory,
    }));
  }),
}));

import {
  appendLogToBody,
  appendStepToBody,
  createTaskWorkspace,
  gcTasks,
  listTaskNotes,
  loadTaskDoc,
  LOG_ANCHOR,
  parseSteps,
  parseTaskDoc,
  readTaskNote,
  sanitizeSlug,
  saveTaskDoc,
  serializeTaskDoc,
  STEPS_ANCHOR,
  updateStepInBody,
  withSteps,
  writeTaskNote,
  type TaskDoc,
  type TaskMeta,
} from "../agent/taskWorkspace";

describe("taskWorkspace protocol & parsing", () => {
  const meta: TaskMeta = {
    taskId: "20260814-163000-a1b2c3",
    status: "in_progress",
    modelId: "mdl-1",
    createdAt: "2026-08-14T08:30:00.000Z",
    updatedAt: "2026-08-14T08:35:12.000Z",
    sourceRefs: [{ path: "writing/ch1.md", hash: "3f8a9b1c" }],
  };

  const body = `# 调查任务

## 步骤

- [x] 检索设定
- [/] 分析关联
- [ ] 起草补充
- [-] 跳过项

## 进度记录

- 16:32 检索完毕
`;

  it("serializes and parses task.md roundtrip", () => {
    const serialized = serializeTaskDoc(meta, body);
    expect(serialized).toContain("<!-- ai-writer-task\n");
    expect(serialized).toContain("\n-->\n\n# 调查任务");

    const parsed = parseTaskDoc(serialized);
    expect(parsed).not.toBeNull();
    expect(parsed!.meta.taskId).toBe(meta.taskId);
    expect(parsed!.meta.status).toBe("in_progress");
    expect(parsed!.meta.sourceRefs?.[0].path).toBe("writing/ch1.md");
    expect(parsed!.body).toBe(body.trim());
  });

  it("handles malformed or corrupted task.md gracefully", () => {
    expect(parseTaskDoc("random text without comment header")).toBeNull();
    expect(parseTaskDoc("<!-- ai-writer-task\n{invalid json}\n-->\n# Test")).toBeNull();
    expect(parseTaskDoc("<!-- ai-writer-task\n{\"status\":\"in_progress\"}\n-->\n# Missing taskId")).toBeNull();
  });

  it("parses checkbox steps into 1-indexed steps", () => {
    const steps = parseSteps(body);
    expect(steps).toHaveLength(4);
    expect(steps[0]).toEqual({ index: 1, title: "检索设定", status: "done" });
    expect(steps[1]).toEqual({ index: 2, title: "分析关联", status: "in_progress" });
    expect(steps[2]).toEqual({ index: 3, title: "起草补充", status: "pending" });
    expect(steps[3]).toEqual({ index: 4, title: "跳过项", status: "skipped" });
  });

  it("updates step status in body text accurately without breaking other lines", () => {
    const updated = updateStepInBody(body, 2, "done");
    const steps = parseSteps(updated);
    expect(steps[1]).toEqual({ index: 2, title: "分析关联", status: "done" });
    expect(steps[0].status).toBe("done");
    expect(steps[2].status).toBe("pending");
  });

  it("appends new step and progress log entries", () => {
    const withNewStep = appendStepToBody(body, "新增第四步");
    const steps = parseSteps(withNewStep);
    expect(steps).toHaveLength(5);
    expect(steps[4]).toEqual({ index: 5, title: "新增第四步", status: "pending" });

    const withLog = appendLogToBody(withNewStep, "更新了阶段性进展");
    expect(withLog).toContain("更新了阶段性进展");
  });
});

describe("taskWorkspace file operations & GC", () => {
  const projectPath = "/project";

  beforeEach(() => {
    fs.clear();
  });

  it("creates workspace on demand, saves and loads task.md", async () => {
    const handle = createTaskWorkspace(projectPath, "mdl-1");
    expect(handle.taskId).toBeNull();

    const { taskId, dir } = await handle.ensure("长任务目标");
    expect(taskId).toBeTruthy();
    expect(dir).toBe(`/project/.ai-writer/tasks/${taskId}`);
    expect(handle.taskId).toBe(taskId);

    const loaded = await loadTaskDoc(projectPath, taskId);
    expect(loaded).not.toBeNull();
    expect(loaded!.body).toContain("长任务目标");
  });

  it("writes, reads, and lists notes with line-based pagination", async () => {
    const handle = createTaskWorkspace(projectPath, "mdl-1");
    const { taskId } = await handle.ensure("研究任务");

    const note1 = await writeTaskNote(projectPath, taskId, {
      slug: "search-nobles",
      title: "东境贵族世系",
      content: "林德曼家族起源于第三纪元。\n雷恩家族在边境拥有要塞。",
      sources: ["https://example.com/nobles", "writing/ch1.md"],
    });

    expect(note1.slug).toBe("search-nobles");
    expect(note1.path).toBe(`.ai-writer/tasks/${taskId}/notes/search-nobles.md`);

    const list = await listTaskNotes(projectPath, taskId);
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("东境贵族世系");

    const read = await readTaskNote(projectPath, taskId, "search-nobles", 1);
    expect(read.totalLines).toBeGreaterThan(1);
    expect(read.content).toContain("林德曼家族起源于第三纪元");
  });

  it("records who filed a note, and the list reads it back", async () => {
    const handle = createTaskWorkspace(projectPath, "mdl-1");
    const { taskId } = await handle.ensure("研究任务");

    const written = await writeTaskNote(projectPath, taskId, {
      slug: "longread-第四章通读",
      title: "第四章通读",
      content: "内容",
      sources: ["writing/ch4.md", "writing/ch5.md"],
      origin: "longread",
    });
    expect(written.origin).toBe("longread");
    expect(written.sources).toBe(2);

    const [note] = await listTaskNotes(projectPath, taskId);
    expect(note.origin).toBe("longread");
    expect(note.sources).toBe(2);
    // The machine header sits above the H1 — the title must still be the H1.
    expect(note.title).toBe("第四章通读");
  });

  it("tolerates notes from before origins were recorded, and corrupt headers", async () => {
    const handle = createTaskWorkspace(projectPath, "mdl-1");
    const { taskId } = await handle.ensure("研究任务");
    const notesDir = `/project/.ai-writer/tasks/${taskId}/notes`;
    fs.set(`${notesDir}/legacy.md`, "# 旧笔记\n\n正文\n");
    fs.set(`${notesDir}/corrupt.md`, "<!-- ai-writer-note {not json} -->\n# 坏头\n\n正文\n");

    const list = await listTaskNotes(projectPath, taskId);
    const legacy = list.find((n) => n.slug === "legacy")!;
    expect(legacy.origin).toBeUndefined();
    expect(legacy.sources).toBeUndefined();
    expect(legacy.title).toBe("旧笔记");
    expect(legacy.chars).toBeGreaterThan(0);

    const corrupt = list.find((n) => n.slug === "corrupt")!;
    expect(corrupt.origin).toBeUndefined();
    expect(corrupt.title).toBe("坏头");
  });

  it("prunes excess completed/failed tasks in gcTasks while retaining active tasks", async () => {
    // Populate 25 task directories
    for (let i = 1; i <= 25; i++) {
      const id = `task-${String(i).padStart(2, "0")}`;
      const status = i <= 5 ? "in_progress" : i <= 15 ? "completed" : "failed";
      const doc: TaskDoc = {
        meta: {
          taskId: id,
          status,
          modelId: "mdl-1",
          createdAt: new Date(2026, 0, i).toISOString(),
          updatedAt: new Date(2026, 0, i).toISOString(),
        },
        body: `# Task ${i}`,
      };
      await saveTaskDoc(projectPath, id, doc);
    }

    // GC should prune down to 20 tasks, prioritizing pruning completed and failed tasks first
    await gcTasks(projectPath, "task-01");

    const taskDirPrefix = "/project/.ai-writer/tasks/";
    const remainingTaskIds = new Set<string>();
    for (const key of fs.keys()) {
      if (key.startsWith(taskDirPrefix)) {
        const sub = key.slice(taskDirPrefix.length);
        const id = sub.split("/")[0];
        remainingTaskIds.add(id);
      }
    }

    expect(remainingTaskIds.size).toBeLessThanOrEqual(20);
    // in_progress tasks (task-01 to task-05) should all be preserved
    expect(remainingTaskIds.has("task-01")).toBe(true);
    expect(remainingTaskIds.has("task-02")).toBe(true);
    expect(remainingTaskIds.has("task-03")).toBe(true);
    expect(remainingTaskIds.has("task-04")).toBe(true);
    expect(remainingTaskIds.has("task-05")).toBe(true);
  });
  // ── Regression tests for the defects found reviewing PR-A ────────────────

  it("files a log entry inside the progress section, not at the end of the file", async () => {
    // It used to append to the end of the body, so any section the author added
    // below the log swallowed every later entry.
    const body = [
      "# T",
      "",
      `## 进度记录 ${LOG_ANCHOR}`,
      "",
      "- 10:00 first",
      "",
      "## 参考",
      "",
      "- writing/ch1.md",
    ].join("\n");

    const out = appendLogToBody(body, "second");
    const lines = out.split("\n");
    expect(lines.findIndex((l) => l.includes("second"))).toBeLessThan(
      lines.findIndex((l) => l.startsWith("## 参考")),
    );
    expect(out).toContain("- writing/ch1.md");
  });

  it("counts indented checkboxes, so step numbers match what the author sees", async () => {
    // Skipping them shifted every later number, and task_progress addresses
    // steps by position — it would have ticked the wrong line.
    const steps = parseSteps("- [ ] a\n  - [ ] a1\n- [x] b");
    expect(steps.map((s) => s.title)).toEqual(["a", "a1", "b"]);
    expect(steps[2].index).toBe(3);
  });

  it("re-planning keeps the progress log", async () => {
    const body = `# Old\n\n## 步骤 ${STEPS_ANCHOR}\n\n- [x] done one\n\n## 进度记录 ${LOG_ANCHOR}\n\n- 09:00 something happened\n`;
    const out = withSteps(body, ["fresh one", "fresh two"]);
    expect(out).toContain("- 09:00 something happened");
    expect(out).toContain("- [ ] fresh one");
    expect(out).not.toContain("done one");
  });

  it("slugs long CJK titles without splitting a character in half", async () => {
    const slug = sanitizeSlug("東".repeat(80));
    expect([...slug]).toHaveLength(60);
    expect(slug).not.toContain("\uFFFD");
  });
  it("re-planning does not grow a blank line each time", async () => {
    // withSteps used to leave the old separator blanks in place and write a new
    // one, so the gap before the next heading widened on every replan.
    let body = `# T\n\n## Steps ${STEPS_ANCHOR}\n\n## Log ${LOG_ANCHOR}\n`;
    for (let i = 0; i < 4; i++) body = withSteps(body, [`s${i}a`, `s${i}b`]);
    expect(body).not.toMatch(/\n\n\n/);
    expect(body).toContain("- [ ] s3a");
  });
});
