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
  removeDir: vi.fn(async () => {}),
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

import { createTaskWorkspace } from "../agent/taskWorkspace";
import { executeRegisteredTool, type ToolContext } from "../agent/registry";

describe("scratchpadTools execution & sandboxing", () => {
  const projectPath = "/project";
  let ctx: ToolContext;

  beforeEach(() => {
    fs.clear();
    const handle = createTaskWorkspace(projectPath, "mdl-1");
    ctx = {
      projectPath,
      loreIndex: {},
      multimodal: false,
      taskWorkspace: handle,
    };
  });

  it("refuses scratchpad tools when taskWorkspace handle is missing", async () => {
    const noWsCtx: ToolContext = {
      projectPath,
      loreIndex: {},
      multimodal: false,
    };

    const res = await executeRegisteredTool(
      { id: "c1", name: "task_plan", arguments: JSON.stringify({ title: "T", steps: ["s1"] }) },
      ["task_plan"],
      noWsCtx,
    );

    expect(res.content).toContain("this surface has no task workspace");
  });

  it("initializes task.md via task_plan", async () => {
    const res = await executeRegisteredTool(
      {
        id: "c1",
        name: "task_plan",
        arguments: JSON.stringify({
          title: "调查魔法起源",
          steps: ["第一步：搜寻古籍", "第二步：对比文献"],
        }),
      },
      ["task_plan"],
      ctx,
    );

    expect(res.content).not.toMatch(/^Error/);

    const taskDocContent = fs.get(`/project/.ai-writer/tasks/${ctx.taskWorkspace!.taskId}/task.md`);
    expect(taskDocContent).toContain("# 调查魔法起源");
    expect(taskDocContent).toContain("- [ ] 第一步：搜寻古籍");
    expect(taskDocContent).toContain("- [ ] 第二步：对比文献");
  });

  it("updates progress via task_progress", async () => {
    // 1. Plan first
    await executeRegisteredTool(
      {
        id: "c1",
        name: "task_plan",
        arguments: JSON.stringify({
          title: "调查魔法起源",
          steps: ["第一步：搜寻古籍", "第二步：对比文献"],
        }),
      },
      ["task_plan"],
      ctx,
    );

    // 2. Mark step 1 done
    const resCheck = await executeRegisteredTool(
      {
        id: "c2",
        name: "task_progress",
        arguments: JSON.stringify({
          action: "check",
          step: 1,
        }),
      },
      ["task_progress"],
      ctx,
    );

    expect(resCheck.content).toContain("1/2 steps done");

    // 3. Add log note
    const resLog = await executeRegisteredTool(
      {
        id: "c3",
        name: "task_progress",
        arguments: JSON.stringify({
          action: "log",
          text: "已在禁书区找到残卷",
        }),
      },
      ["task_progress"],
      ctx,
    );

    expect(resLog.content).toContain("action 'log' completed");

    // 4. Out of range step check
    const resOut = await executeRegisteredTool(
      {
        id: "c4",
        name: "task_progress",
        arguments: JSON.stringify({
          action: "check",
          step: 99,
        }),
      },
      ["task_progress"],
      ctx,
    );

    expect(resOut.content).toContain("out of range");
  });

  it("writes, lists, and reads notes safely", async () => {
    // Write note
    const resWrite = await executeRegisteredTool(
      {
        id: "c1",
        name: "write_note",
        arguments: JSON.stringify({
          slug: "ancient-tome",
          title: "古籍摘要",
          content: "残卷记载了第三纪元的魔法仪式。\n仪式需要三种稀有矿石。",
          sources: ["writing/ch10.md"],
        }),
      },
      ["write_note"],
      ctx,
    );

    expect(resWrite.content).not.toMatch(/^Error/);

    // List notes
    const resList = await executeRegisteredTool(
      {
        id: "c2",
        name: "list_notes",
        arguments: "{}",
      },
      ["list_notes"],
      ctx,
    );

    expect(resList.content).toContain("ancient-tome");
    expect(resList.content).toContain("古籍摘要");

    // Read note
    const resRead = await executeRegisteredTool(
      {
        id: "c3",
        name: "read_note",
        arguments: JSON.stringify({ path: "ancient-tome", start_line: 1 }),
      },
      ["read_note"],
      ctx,
    );

    expect(resRead.content).toContain("[lines 1-");
    expect(resRead.content).toContain("残卷记载了第三纪元的魔法仪式");
  });

  it("sanitizes dangerous slugs and guards against path traversal", async () => {
    const resWrite = await executeRegisteredTool(
      {
        id: "c1",
        name: "write_note",
        arguments: JSON.stringify({
          slug: "../../evil-escape",
          title: "Bad Slug",
          content: "hacked",
        }),
      },
      ["write_note"],
      ctx,
    );

    // Slug should be sanitized so it doesn't escape
    expect(resWrite.content).not.toMatch(/^Error/);
    const taskId = ctx.taskWorkspace!.taskId;
    expect(fs.has(`/project/.ai-writer/tasks/${taskId}/notes/evil-escape.md`)).toBe(true);
    expect(fs.has("/project/evil-escape.md")).toBe(false);
  });
  // ── Regression tests for the defects found reviewing PR-A ────────────────

  it("keeps CJK slugs distinct instead of collapsing them all onto note.md", async () => {
    // The original sanitizer stripped every non-ASCII character, so "搜索结果"
    // and "第一章分析" both reduced to the fallback "note" — in a Chinese
    // project every note overwrote the previous one, which is exactly the data
    // loss the workspace exists to prevent.
    const write = (slug: string, content: string) =>
      executeRegisteredTool(
        { id: `c-${slug}`, name: "write_note", arguments: JSON.stringify({ slug, title: slug, content }) },
        ["write_note"],
        ctx,
      );

    await write("搜索结果", "第一篇");
    await write("第一章分析", "第二篇");

    const taskId = ctx.taskWorkspace!.taskId;
    const notes = [...fs.keys()].filter((k) => k.includes("/notes/"));
    expect(notes).toHaveLength(2);
    expect(fs.get(`/project/.ai-writer/tasks/${taskId}/notes/搜索结果.md`)).toContain("第一篇");
    expect(fs.get(`/project/.ai-writer/tasks/${taskId}/notes/第一章分析.md`)).toContain("第二篇");
  });

  it("never overwrites an existing note — a clashing slug gets suffixed", async () => {
    const write = (content: string) =>
      executeRegisteredTool(
        { id: "c1", name: "write_note", arguments: JSON.stringify({ slug: "findings", title: "T", content }) },
        ["write_note"],
        ctx,
      );

    await write("first finding");
    const second = await write("second finding");

    const taskId = ctx.taskWorkspace!.taskId;
    expect(fs.get(`/project/.ai-writer/tasks/${taskId}/notes/findings.md`)).toContain("first finding");
    expect(fs.get(`/project/.ai-writer/tasks/${taskId}/notes/findings-2.md`)).toContain("second finding");
    // The model has to be told, or it will cite a path that holds someone else's text.
    expect(second.content).toContain("findings-2");
  });

  it("task_progress refuses to conjure a workspace — it demands a plan first", async () => {
    // It used to call ensure() before checking, which created the task AND
    // satisfied the check, so this branch was unreachable and a stray progress
    // call left behind a workspace nobody planned.
    const res = await executeRegisteredTool(
      { id: "c1", name: "task_progress", arguments: JSON.stringify({ action: "log", text: "hi" }) },
      ["task_progress"],
      ctx,
    );

    expect(res.content).toMatch(/^Error/);
    expect(res.content).toContain("task_plan");
    expect(ctx.taskWorkspace!.taskId).toBeNull();
    expect([...fs.keys()]).toHaveLength(0);
  });

  it("write_note may create the workspace, but never names the task after itself", async () => {
    // The checkpoint nudge asks for a note by name, so refusing until a plan
    // exists would make that nudge a dead end. The title must stay generic.
    await executeRegisteredTool(
      {
        id: "c1",
        name: "write_note",
        arguments: JSON.stringify({ slug: "s", title: "某一篇笔记的标题", content: "x" }),
      },
      ["write_note"],
      ctx,
    );

    const doc = fs.get(`/project/.ai-writer/tasks/${ctx.taskWorkspace!.taskId}/task.md`)!;
    expect(doc).not.toContain("某一篇笔记的标题");
    // And no fabricated step, which would report progress on a task nobody planned.
    expect(doc).not.toMatch(/^\s*[-*]\s+\[/m);
  });

  it("read_note accepts the filename form, not only the bare slug", async () => {
    await executeRegisteredTool(
      { id: "c1", name: "write_note", arguments: JSON.stringify({ slug: "notes-a", title: "A", content: "body text" }) },
      ["write_note"],
      ctx,
    );

    for (const ref of ["notes-a", "notes-a.md", `.ai-writer/tasks/${ctx.taskWorkspace!.taskId}/notes/notes-a.md`]) {
      const res = await executeRegisteredTool(
        { id: "c2", name: "read_note", arguments: JSON.stringify({ path: ref }) },
        ["read_note"],
        ctx,
      );
      expect(res.content, `reference form: ${ref}`).toContain("body text");
    }
  });

  it("read_note will not read another task's note", async () => {
    await executeRegisteredTool(
      { id: "c1", name: "write_note", arguments: JSON.stringify({ slug: "mine", title: "M", content: "secret" }) },
      ["write_note"],
      ctx,
    );

    const res = await executeRegisteredTool(
      { id: "c2", name: "read_note", arguments: JSON.stringify({ path: ".ai-writer/tasks/other-task/notes/mine.md" }) },
      ["read_note"],
      ctx,
    );
    expect(res.content).toMatch(/^Error/);
    expect(res.content).not.toContain("secret");
  });
});
