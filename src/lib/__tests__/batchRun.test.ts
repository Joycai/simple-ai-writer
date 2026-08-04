/**
 * batchStore — the sequential clause runner. What matters here is the loop's
 * contract, not the pipeline it delegates to (aiTaskStore has its own tests):
 * one runTask per clause with that clause as the committed selection, results
 * appended to the output file in order, one clause failing not aborting the
 * rest, stop() skipping the remainder, and the selection slot left clean.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  written: [] as { path: string; content: string }[],
  appended: [] as { path: string; content: string }[],
}));

vi.mock("../fs/fileio", () => ({
  writeFile: async (path: string, content: string) => {
    h.written.push({ path, content });
  },
  appendFile: async (path: string, content: string) => {
    h.appended.push({ path, content });
  },
}));

// Same arrangement as aiTaskDrafts.test: appStore touches `localStorage` and
// `document` at module load, and the test environment is node.
vi.mock("../../stores/appStore", () => ({
  useAppStore: {
    getState: () => ({ draftCount: 1, loreBudgetTokens: 600, contextUtilization: 0.8 }),
  },
}));

import { useBatchStore } from "../../stores/batchStore";
import { useAiTaskStore, type Draft } from "../../stores/aiTaskStore";
import type { Clause } from "../batch/clauses";

const CLAUSES: Clause[] = [
  { title: "## 2.1 资质要求", text: "2.1 原文" },
  { title: "## 2.2 技术要求", text: "2.2 原文" },
];

/** Install a runTask stub that reports `text` (or a failure) per call. */
function stubRunTask(results: Array<{ text?: string; error?: string; runError?: string }>) {
  let call = 0;
  const seenSelections: string[] = [];
  useAiTaskStore.setState({
    isRunning: false,
    error: null,
    drafts: [],
    activeDraftId: null,
    abort: () => {},
    runTask: async () => {
      seenSelections.push(useAiTaskStore.getState().selection);
      const r = results[Math.min(call++, results.length - 1)];
      const draft: Draft = {
        id: `d${call}`, index: 1, text: r.text ?? "", usage: null,
        error: r.error ?? null, done: true, truncated: false,
      };
      useAiTaskStore.setState({
        drafts: [draft], activeDraftId: draft.id, error: r.runError ?? null,
      });
    },
  });
  return seenSelections;
}

beforeEach(() => {
  h.written.length = 0;
  h.appended.length = 0;
  useBatchStore.setState({
    running: false, taskId: null, items: [], outputPath: null, stopRequested: false,
  });
  useAiTaskStore.setState({ selection: "", selectionRange: null, selectionSource: null });
});

describe("batch run", () => {
  it("runs once per clause with that clause as the committed selection", async () => {
    const selections = stubRunTask([{ text: "应答一" }, { text: "应答二" }]);
    await useBatchStore.getState().start("respond", CLAUSES, "out/x.md", "标书");

    expect(selections).toEqual(["2.1 原文", "2.2 原文"]);
    // Header once, then one section per clause, in order.
    expect(h.written).toHaveLength(1);
    expect(h.written[0].path).toBe("out/x.md");
    expect(h.appended.map((a) => a.content)).toEqual([
      expect.stringContaining("## 2.1 资质要求"),
      expect.stringContaining("## 2.2 技术要求"),
    ]);
    expect(h.appended[0].content).toContain("应答一");

    const items = useBatchStore.getState().items;
    expect(items.map((i) => i.status)).toEqual(["done", "done"]);
    expect(items[0].chars).toBe("应答一".length);
    // The batch's committed selection must not linger for the next manual run.
    expect(useAiTaskStore.getState().selection).toBe("");
    expect(useBatchStore.getState().running).toBe(false);
  });

  it("records a failed clause and keeps going", async () => {
    stubRunTask([{ runError: "模型超时" }, { text: "应答二" }]);
    await useBatchStore.getState().start("respond", CLAUSES, "out/x.md", "标书");

    const items = useBatchStore.getState().items;
    expect(items.map((i) => i.status)).toEqual(["failed", "done"]);
    expect(items[0].error).toContain("模型超时");
    // The failure is recorded in the output file too — a gap that looks like
    // success is exactly what a response document must not contain.
    expect(h.appended[0].content).toContain("模型超时");
    expect(h.appended[1].content).toContain("应答二");
  });

  it("treats a per-draft error like a run error", async () => {
    stubRunTask([{ error: "安全过滤" }, { text: "应答二" }]);
    await useBatchStore.getState().start("respond", CLAUSES, "out/x.md", "标书");
    expect(useBatchStore.getState().items[0].status).toBe("failed");
  });

  it("stop() skips everything after the in-flight clause", async () => {
    let call = 0;
    useAiTaskStore.setState({
      isRunning: false, error: null, drafts: [], activeDraftId: null,
      abort: () => {},
      runTask: async () => {
        call++;
        if (call === 1) useBatchStore.getState().stop();
        const draft: Draft = {
          id: `d${call}`, index: 1, text: "部分应答", usage: null,
          error: null, done: true, truncated: false,
        };
        useAiTaskStore.setState({ drafts: [draft], activeDraftId: draft.id, error: null });
      },
    });
    await useBatchStore.getState().start("respond", CLAUSES, "out/x.md", "标书");

    expect(call).toBe(1);
    expect(useBatchStore.getState().items.map((i) => i.status)).toEqual(["failed", "skipped"]);
    expect(useBatchStore.getState().running).toBe(false);
  });

  it("refuses to start over a running task or with nothing to do", async () => {
    stubRunTask([{ text: "x" }]);
    useAiTaskStore.setState({ isRunning: true });
    await useBatchStore.getState().start("respond", CLAUSES, "out/x.md", "标书");
    expect(h.written).toHaveLength(0);

    useAiTaskStore.setState({ isRunning: false });
    await useBatchStore.getState().start("respond", [], "out/x.md", "标书");
    expect(h.written).toHaveLength(0);
  });
});
