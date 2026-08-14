/**
 * markTaskPaused / markTaskResumed / recordSourceRef — the disk side of pause.
 *
 * sourceRefs had no writer at all before this: the resume staleness check read
 * a field nothing ever set, so the warning could never fire.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = new Map<string, string>();
vi.mock("../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => { if (!fs.has(p)) throw new Error("ENOENT"); return fs.get(p)!; }),
  writeFile: vi.fn(async (p: string, c: string) => void fs.set(p, c)),
  fileExists: vi.fn(async (p: string) => fs.has(p) || [...fs.keys()].some((k) => k.startsWith(p + "/"))),
  makeDir: vi.fn(async () => {}),
  removeDir: vi.fn(async () => {}),
  readDir: vi.fn(async () => []),
}));

import {
  createTaskWorkspace, loadTaskDoc, markTaskPaused, markTaskResumed, recordSourceRef,
} from "../agent/taskWorkspace";

const projectPath = "/p";

describe("task pause/resume disk state", () => {
  beforeEach(() => fs.clear());

  const newTask = async () => {
    const handle = createTaskWorkspace(projectPath, "mdl-1");
    const { taskId } = await handle.ensure("目标");
    return taskId;
  };

  it("marks paused then resumed, logging each without losing the other's entry", async () => {
    const taskId = await newTask();

    await markTaskPaused(projectPath, taskId);
    let doc = (await loadTaskDoc(projectPath, taskId))!;
    expect(doc.meta.status).toBe("paused");
    const pausedLog = doc.body;

    await markTaskResumed(projectPath, taskId);
    doc = (await loadTaskDoc(projectPath, taskId))!;
    expect(doc.meta.status).toBe("in_progress");
    // Both entries survive: the log is a history, not a status field.
    expect(doc.body.split("\n").filter((l) => /^- \d\d:\d\d /.test(l))).toHaveLength(2);
    expect(doc.body.length).toBeGreaterThan(pausedLog.length);
  });

  it("records a source ref and replaces it rather than duplicating on re-pause", async () => {
    const taskId = await newTask();

    await recordSourceRef(projectPath, taskId, "writing/ch1.md", "hash-a");
    await recordSourceRef(projectPath, taskId, "writing/ch2.md", "hash-b");
    await recordSourceRef(projectPath, taskId, "writing/ch1.md", "hash-c");

    const doc = (await loadTaskDoc(projectPath, taskId))!;
    expect(doc.meta.sourceRefs).toEqual([
      { path: "writing/ch2.md", hash: "hash-b" },
      { path: "writing/ch1.md", hash: "hash-c" },
    ]);
  });

  it("serializes concurrent task.md writes instead of losing updates", async () => {
    const taskId = await newTask();

    // Two writers racing on the same read-modify-write, which is what a model
    // emitting several tool calls in one round produces.
    await Promise.all([
      recordSourceRef(projectPath, taskId, "a.md", "h1"),
      recordSourceRef(projectPath, taskId, "b.md", "h2"),
      markTaskPaused(projectPath, taskId),
    ]);

    const doc = (await loadTaskDoc(projectPath, taskId))!;
    expect(doc.meta.sourceRefs?.map((r) => r.path).sort()).toEqual(["a.md", "b.md"]);
    expect(doc.meta.status).toBe("paused");
  });

  it("is a no-op on a task that is gone, rather than throwing", async () => {
    await expect(markTaskPaused(projectPath, "does-not-exist")).resolves.toBeUndefined();
  });
});
