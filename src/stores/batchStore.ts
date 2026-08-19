/**
 * Batch clause runner — answer a split document's clauses one by one through
 * the existing task pipeline, appending each result to an output markdown
 * file as it lands.
 *
 * Deliberately a thin sequential loop over `aiTaskStore.runTask` rather than
 * a parallel scheduler of its own: each iteration gets the full pipeline
 * (context budget, lore injection, agent tools, per-run usage rows, the
 * panel's live stream) for free, and the store's one-task-at-a-time rule is
 * respected instead of worked around. A tender's clauses are answered in
 * minutes either way; correctness and auditability beat wall-clock here.
 *
 * Progressive file output (append per clause) is the crash contract: however
 * the run ends — abort, model failure, app quit — everything answered so far
 * is already on disk.
 */

import { create } from "zustand";
import i18n from "../i18n";
import { appendFile, writeFile } from "../lib/fs/fileio";
import type { Clause } from "../lib/batch/clauses";
import { useAiTaskStore } from "./aiTaskStore";
import { muteRunFinished, notify } from "../lib/notify";

export type BatchItemStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface BatchItem {
  /** Stable per-run id (list keys, status patching). */
  id: string;
  title: string;
  text: string;
  status: BatchItemStatus;
  /** Failure reason (failed items only). */
  error: string | null;
  /** Response length in chars (done items only) — the list's "did it work" glance. */
  chars: number;
}

interface BatchState {
  running: boolean;
  /** Task the batch runs — resolved per item, same as a manual run. */
  taskId: string | null;
  items: BatchItem[];
  outputPath: string | null;
  stopRequested: boolean;

  start: (taskId: string, clauses: Clause[], outputPath: string, sourceTitle: string) => Promise<void>;
  /** Graceful stop: abort the in-flight item, mark the rest skipped. */
  stop: () => void;
  /** Clear a finished run's list (not callable mid-run). */
  reset: () => void;
}

/** Strip markdown heading markers for display/output titles. */
function cleanTitle(title: string): string {
  return title.replace(/^#{1,6}\s*/, "").trim();
}

function patchItem(
  set: (fn: (s: BatchState) => Partial<BatchState>) => void,
  id: string,
  patch: Partial<BatchItem>,
): void {
  set((s) => ({
    items: s.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
  }));
}

let batchSeq = 0;

export const useBatchStore = create<BatchState>((set, get) => ({
  running: false,
  taskId: null,
  items: [],
  outputPath: null,
  stopRequested: false,

  start: async (taskId, clauses, outputPath, sourceTitle) => {
    const aiTask = useAiTaskStore.getState();
    if (get().running || aiTask.isRunning || clauses.length === 0) return;

    const items: BatchItem[] = clauses.map((c, i) => ({
      id: `${batchSeq++}-${i}`,
      title: cleanTitle(c.title),
      text: c.text,
      status: "pending",
      error: null,
      chars: 0,
    }));
    set({ running: true, taskId, items, outputPath, stopRequested: false });

    // One job, one notification: each clause is a full `runTask`, and 40
    // clauses must not arrive as 40 "task finished" pings. Released in the
    // finally, just before this loop sends the one that speaks for all of them.
    const unmute = muteRunFinished();
    try {
      await writeFile(
        outputPath,
        `# ${i18n.t("ai.batch.outputTitle", { source: sourceTitle })}\n\n`,
      );

      for (const item of items) {
        if (get().stopRequested) {
          patchItem(set, item.id, { status: "skipped" });
          continue;
        }
        patchItem(set, item.id, { status: "running" });

        // The clause becomes the committed selection — exactly what a manual
        // per-clause run would send, so needsSelection tasks run unchanged.
        useAiTaskStore.getState().setSelection(item.text, null, "commit");
        await useAiTaskStore.getState().runTask(taskId);

        const after = useAiTaskStore.getState();
        const draft =
          after.drafts.find((d) => d.id === after.activeDraftId) ?? after.drafts[0];
        const failure =
          after.error ??
          draft?.error ??
          (get().stopRequested
            ? i18n.t("ai.batch.aborted")
            : !draft?.text.trim()
              ? i18n.t("ai.batch.emptyResult")
              : null);

        if (failure) {
          patchItem(set, item.id, { status: "failed", error: String(failure) });
          await appendFile(
            outputPath,
            `## ${item.title}\n\n> ⚠️ ${i18n.t("ai.batch.itemFailed", { error: String(failure) })}\n\n---\n\n`,
          );
          continue;
        }
        patchItem(set, item.id, { status: "done", chars: draft.text.length });
        await appendFile(outputPath, `## ${item.title}\n\n${draft.text.trim()}\n\n---\n\n`);
      }
    } finally {
      // The batch owned the committed selection; leaving the last clause
      // committed would quietly target the next manual run at it.
      useAiTaskStore.getState().clearSelectionFrom("commit");
      unmute();
      const finished = get().items;
      notify("done", i18n.t("notify.doneTitle"), i18n.t("notify.batchDone", {
        done: String(finished.filter((it) => it.status === "done").length),
        failed: String(finished.filter((it) => it.status === "failed").length),
      }));
      set({ running: false });
    }
  },

  stop: () => {
    if (!get().running) return;
    set({ stopRequested: true });
    useAiTaskStore.getState().abort();
  },

  reset: () => {
    if (get().running) return;
    set({ items: [], outputPath: null, taskId: null, stopRequested: false });
  },
}));
