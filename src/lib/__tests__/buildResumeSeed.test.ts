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

import { hashText } from "../context/memory";
import {
  listTaskSummaries,
  saveTaskDoc,
  writeTaskNote,
  type TaskDoc,
} from "../agent/taskWorkspace";
import { buildResumeSeed } from "../../stores/agentStore";

describe("buildResumeSeed and task listing", () => {
  const projectPath = "/test-proj";
  const taskId = "20260814-120000-res123";

  beforeEach(() => {
    fs.clear();
  });

  it("builds resume seed with steps, notes index, and fresh source refs", async () => {
    const ch1Content = "第一章正文内容";
    fs.set(`${projectPath}/writing/ch1.md`, ch1Content);

    const doc: TaskDoc = {
      meta: {
        taskId,
        status: "paused",
        modelId: "mdl-1",
        createdAt: "2026-08-14T04:00:00.000Z",
        updatedAt: "2026-08-14T04:30:00.000Z",
        sourceRefs: [{ path: "writing/ch1.md", hash: hashText(ch1Content) }],
      },
      body: `# 探索长城遗迹

## 步骤 <!-- ai-writer-task-steps -->

- [x] 搜集史料
- [/] 分析路线
- [ ] 编写报告

## 进度记录 <!-- ai-writer-task-log -->

- 12:30 史料已查明`,
    };

    await saveTaskDoc(projectPath, taskId, doc);
    await writeTaskNote(projectPath, taskId, {
      slug: "wall-history",
      title: "长城建造年代考",
      content: "长城建于第二纪元末期。",
    });

    const seed = await buildResumeSeed(projectPath, taskId);

    expect(seed.taskWorkspace.taskId).toBe(taskId);
    expect(seed.userContent).toContain("【恢复任务】");
    expect(seed.userContent).toContain("# 探索长城遗迹");
    expect(seed.userContent).toContain("长城建造年代考");
    expect(seed.userContent).toContain(".ai-writer/tasks/20260814-120000-res123/notes/wall-history.md");
    // Source ref is fresh, so no stale warning block
    expect(seed.userContent).not.toContain("已被修改或删除");
  });

  it("detects stale or deleted source references in resume seed", async () => {
    const originalCh1 = "旧正文";
    const modifiedCh1 = "新修改的正文";
    fs.set(`${projectPath}/writing/ch1.md`, modifiedCh1);

    const doc: TaskDoc = {
      meta: {
        taskId,
        status: "paused",
        modelId: "mdl-1",
        createdAt: "2026-08-14T04:00:00.000Z",
        updatedAt: "2026-08-14T04:30:00.000Z",
        sourceRefs: [
          { path: "writing/ch1.md", hash: hashText(originalCh1) },
          { path: "writing/deleted.md", hash: "somehash" },
        ],
      },
      body: `# 调查任务\n\n## 步骤\n\n- [ ] 步骤一`,
    };

    await saveTaskDoc(projectPath, taskId, doc);

    const seed = await buildResumeSeed(projectPath, taskId);

    expect(seed.userContent).toContain("已被修改或删除");
    expect(seed.userContent).toContain("writing/ch1.md（已修改）");
    expect(seed.userContent).toContain("writing/deleted.md（已删除）");
  });

  it("throws error when task does not exist", async () => {
    await expect(buildResumeSeed(projectPath, "non-existent-task")).rejects.toThrow();
  });

  it("lists task summaries correctly", async () => {
    const doc1: TaskDoc = {
      meta: {
        taskId: "task-01",
        status: "paused",
        modelId: "m",
        createdAt: "2026-08-14T01:00:00.000Z",
        updatedAt: "2026-08-14T02:00:00.000Z",
      },
      body: "# 任务一\n\n- [x] 第一步\n- [ ] 第二步",
    };
    const doc2: TaskDoc = {
      meta: {
        taskId: "task-02",
        status: "completed",
        modelId: "m",
        createdAt: "2026-08-14T03:00:00.000Z",
        updatedAt: "2026-08-14T04:00:00.000Z",
      },
      body: "# 任务二\n\n- [x] 第一步",
    };

    await saveTaskDoc(projectPath, "task-01", doc1);
    await saveTaskDoc(projectPath, "task-02", doc2);

    const summaries = await listTaskSummaries(projectPath);

    expect(summaries).toHaveLength(2);
    // Newest first
    expect(summaries[0].taskId).toBe("task-02");
    expect(summaries[0].status).toBe("completed");
    expect(summaries[0].stepsDone).toBe(1);
    expect(summaries[0].stepsTotal).toBe(1);

    expect(summaries[1].taskId).toBe("task-01");
    expect(summaries[1].status).toBe("paused");
    expect(summaries[1].stepsDone).toBe(1);
    expect(summaries[1].stepsTotal).toBe(2);
  });
});
