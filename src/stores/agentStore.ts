/**
 * Approval queue for L2 ("write-approval") agent writes.
 *
 * propose_edit blocks the tool loop on a Promise held here; the AiPanel
 * approval card renders `pending` and the user's decision resolves it. The
 * APPROVER is what applies the edit — the tool never touches the manuscript:
 *
 *   approve → backup → apply (through editorStore when the file is open in
 *             the editor, so unsaved work is respected and the change shows
 *             immediately; straight to disk otherwise) → resolve {approved}
 *   reject  → resolve {approved:false, reason} (fed back to the model verbatim)
 *
 * The apply re-locates the `find` text at decision time — if the document
 * changed while the card sat open, the proposal resolves as a rejection with
 * that explanation instead of clobbering the author's newer text.
 *
 * rejectAll() drains the queue on task abort/end so a dangling Promise can
 * never wedge a future run.
 */

import { create } from "zustand";
import { backupFile } from "../lib/agent/backup";
import type { ApprovalDecision, EditProposal } from "../lib/agent/registry";
import { readFile, writeFile } from "../lib/fs/fileio";

interface PendingApproval {
  proposal: EditProposal;
  resolve: (decision: ApprovalDecision) => void;
}

interface AgentState {
  pending: PendingApproval[];

  /** Called by the tool executor (via ToolContext.requestApproval). */
  requestApproval: (proposal: EditProposal) => Promise<ApprovalDecision>;
  /** User approved: backup, apply, resolve. */
  approve: (id: string) => Promise<void>;
  /** User rejected: resolve with their optional reason. */
  reject: (id: string, reason?: string) => void;
  /** Drain the queue (task aborted / finished) — resolves everything as rejected. */
  rejectAll: (reason: string) => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  pending: [],

  requestApproval: (proposal) =>
    new Promise<ApprovalDecision>((resolve) => {
      set((s) => ({ pending: [...s.pending, { proposal, resolve }] }));
    }),

  approve: async (id) => {
    const item = get().pending.find((p) => p.proposal.id === id);
    if (!item) return;
    set((s) => ({ pending: s.pending.filter((p) => p.proposal.id !== id) }));

    const { proposal } = item;
    try {
      const { useProjectStore } = await import("./projectStore");
      const { projectPath, activeFilePath } = useProjectStore.getState();
      const backupPath = projectPath ? await backupFile(projectPath, proposal.path) : null;

      if (activeFilePath === proposal.path) {
        // The file is open — go through the editor so unsaved edits are kept
        // and the change is visible (and autosaved) immediately.
        const { useEditorStore } = await import("./editorStore");
        const { content, setContent } = useEditorStore.getState();
        const idx = content.indexOf(proposal.find);
        if (idx < 0) throw new Error("Document changed — the target text no longer matches.");
        setContent(
          content.slice(0, idx) + proposal.replace + content.slice(idx + proposal.find.length),
        );
      } else {
        const raw = await readFile(proposal.path);
        const idx = raw.indexOf(proposal.find);
        if (idx < 0) throw new Error("Document changed — the target text no longer matches.");
        await writeFile(
          proposal.path,
          raw.slice(0, idx) + proposal.replace + raw.slice(idx + proposal.find.length),
        );
      }
      item.resolve({ approved: true, backupPath });
    } catch (e) {
      // Approval failed to apply — report as a rejection so the model knows
      // the manuscript is untouched.
      item.resolve({ approved: false, reason: `apply failed: ${String(e)}` });
    }
  },

  reject: (id, reason) => {
    const item = get().pending.find((p) => p.proposal.id === id);
    if (!item) return;
    set((s) => ({ pending: s.pending.filter((p) => p.proposal.id !== id) }));
    item.resolve({ approved: false, reason });
  },

  rejectAll: (reason) => {
    const items = get().pending;
    if (items.length === 0) return;
    set({ pending: [] });
    for (const item of items) item.resolve({ approved: false, reason });
  },
}));
