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

    expect(res.content).toContain("Task plan established successfully");

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

    expect(resWrite.content).toContain("Note saved successfully");

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
    expect(resWrite.content).toContain("Note saved successfully");
    const taskId = ctx.taskWorkspace!.taskId;
    expect(fs.has(`/project/.ai-writer/tasks/${taskId}/notes/evil-escape.md`)).toBe(true);
    expect(fs.has("/project/evil-escape.md")).toBe(false);
  });
});
