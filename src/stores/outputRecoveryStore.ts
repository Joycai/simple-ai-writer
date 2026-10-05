import { create } from "zustand";
import i18n from "../i18n";
import {
  createOutputCheckpoint, deleteOutputRecovery, listOutputRecoveries, saveOutputRecovery,
  type OutputRecovery,
} from "../lib/agent/outputRecovery";
import { streamCompletion, type StreamMessage } from "../lib/ai";
import { conversationalModels } from "../lib/ai/configDb";
import { connOptions, resolveConn } from "../lib/ai/conn";
import { recordUsage } from "../lib/ai/usageRow";
import { createStreamThrottle } from "../lib/agent/streamThrottle";
import { loadApiKey } from "../lib/keyStore";
import { profileSystemPrompt } from "../lib/context/rag";
import { withCurrentTime } from "../lib/context/clock";
import { useAiStore } from "./aiStore";

interface RecoveryState {
  project: string | null;
  rows: OutputRecovery[];
  running: string | null;
  controller: AbortController | null;
  error: string | null;
  load: (project: string | null) => Promise<void>;
  remove: (id: string) => Promise<void>;
  keep: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  startLong: (request: string, sections: string[], modelId: string | null) => Promise<void>;
  stop: () => void;
}

const active = new Set<string>();
let loadSequence = 0;
let mutationSequence = 0;
function publish(project: string, snapshot: OutputRecovery) {
  if (useOutputRecoveryStore.getState().project !== project) return;
  mutationSequence++;
  useOutputRecoveryStore.setState((s) => ({
    rows: [snapshot, ...s.rows.filter((r) => r.id !== snapshot.id)],
  }));
}
function report(project: string, error: unknown) {
  if (useOutputRecoveryStore.getState().project !== project) return;
  useOutputRecoveryStore.setState({ error: `${i18n.t("ai.recovery.saveFailed")}: ${String(error)}` });
}

/** Bound to the original project and output identity, never the current tab. */
export function trackOutput(project: string, seed: Omit<OutputRecovery, "v" | "id" | "updatedAt" | "status" | "text">) {
  let snapshot: OutputRecovery = {
    ...seed, v: 1, id: crypto.randomUUID(), text: "", status: "streaming", updatedAt: Date.now(),
  };
  active.add(snapshot.id);
  const checkpoint = createOutputCheckpoint((value) => saveOutputRecovery(project, value), (e) => report(project, e));
  checkpoint.update(snapshot);
  return {
    update(text: string, request?: string) {
      snapshot = { ...snapshot, text, request: request ?? snapshot.request, updatedAt: Date.now() };
      checkpoint.update(snapshot);
    },
    async finish(status: "complete" | "interrupted" | "truncated") {
      snapshot = { ...snapshot, status: status === "complete" ? "kept" : status, updatedAt: Date.now() };
      checkpoint.update(snapshot);
      await checkpoint.close();
      active.delete(snapshot.id);
      publish(project, snapshot);
    },
  };
}

/** Context is prose only. No tool schema, arguments, approvals, or media bytes survive here. */
export function recoveryRequest(messages: readonly StreamMessage[]): string {
  return messages.filter((m) => m.role === "user" || m.role === "assistant")
    .filter((m) => !("tool_calls" in m))
    .map((m) => {
      const text = typeof m.content === "string" ? m.content : Array.isArray(m.content)
        ? m.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") : "";
      return text ? `${m.role}:\n${text}` : "";
    })
    .filter(Boolean).join("\n\n");
}

export const useOutputRecoveryStore = create<RecoveryState>((set, get) => ({
  project: null, rows: [], running: null, controller: null, error: null,
  load: async (project) => {
    const sequence = ++loadSequence;
    const revision = mutationSequence;
    if (get().project !== project) {
      get().controller?.abort();
      set({ project, rows: [], running: null, controller: null, error: null });
    }
    if (!project) return;
    try {
      const rows = await listOutputRecoveries(project);
      if (get().project !== project || get().running || sequence !== loadSequence) return;
      // A completed stream, keep or deletion may have landed after SELECT began.
      if (revision !== mutationSequence) { await get().load(project); return; }
      set({ rows: rows.filter((r) => !active.has(r.id)) });
    } catch (e) { if (get().project === project) report(project, e); }
  },
  remove: async (id) => {
    const { project, running } = get();
    if (!project || running === id) return;
    try {
      await deleteOutputRecovery(project, id);
      mutationSequence++;
      if (get().project === project) set((s) => ({ rows: s.rows.filter((r) => r.id !== id) }));
    } catch (e) { report(project, e); }
  },
  keep: async (id) => {
    const { project, rows, running } = get();
    const row = rows.find((r) => r.id === id);
    if (!project || !row || running === id) return;
    const kept = { ...row, status: "kept" as const };
    try { await saveOutputRecovery(project, kept); publish(project, kept); } catch (e) { report(project, e); }
  },
  startLong: async (request, sections, modelId) => {
    const { project, running } = get();
    const titles = sections.map((s) => s.trim()).filter(Boolean);
    if (!project || running || !request.trim() || !modelId || !titles.length || titles.length > 20) return;
    const row: OutputRecovery = {
      v: 1, id: crypto.randomUUID(), source: "long", modelId, request,
      text: "", status: "interrupted", updatedAt: Date.now(), sections: titles, nextSection: 0,
    };
    try {
      await saveOutputRecovery(project, row);
      if (get().project !== project) return;
      publish(project, row);
      await get().resume(row.id);
    } catch (e) { report(project, e); }
  },
  resume: async (id) => {
    const { project, rows, running } = get();
    let row = rows.find((r) => r.id === id);
    if (!project || !row || running) return;
    const { models, providers } = useAiStore.getState();
    const connection = resolveConn(conversationalModels(models), providers, row.modelId);
    if (!connection.ok) { set({ error: connection.error }); return; }
    const { model, provider } = connection;
    const controller = new AbortController();
    set({ running: id, controller, error: null });
    const checkpoint = createOutputCheckpoint((value) => saveOutputRecovery(project, value), (e) => report(project, e));
    active.add(id);
    const display = createStreamThrottle(() => publish(project, row!));
    const update = () => {
      row = { ...row!, updatedAt: Date.now() };
      checkpoint.update(row);
      display.schedule();
    };
    try {
      const apiKey = await loadApiKey(provider.id) ?? "";
      const sections = row.sections;
      do {
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const index: number = row.nextSection ?? 0;
        if (sections && index >= sections.length) break;
        const instruction = sections
          ? `Write only section ${index + 1}: ${sections[index]}. Follow this complete outline:\n${sections.join("\n")}\nContinue any unfinished text of this section. Do not start the next section.`
          : "Continue the interrupted prose exactly where it stops. Do not repeat or rewrite existing text. Complete the original writing request.";
        const messages: StreamMessage[] = [
          { role: "system", content: withCurrentTime(profileSystemPrompt()) },
          { role: "user", content: `Original request and reference context:\n${row.request}\n\nSaved text (preserve it):\n${row.text}\n\n${instruction}\nThis request generates prose only. No tools are available; do not claim to execute actions.` },
        ];
        row = { ...row, status: "streaming" };
        update();
        const before = row.text.length;
        let done = false;
        let truncated = false;
        await streamCompletion({
          ...connOptions({ model, provider, apiKey }), serverTools: [], messages, signal: controller.signal,
          onChunk: (chunk) => {
            if ("text" in chunk) {
              row = { ...row!, text: row!.text + chunk.text };
              update();
            } else if ("done" in chunk) {
              done = true;
              truncated = !!chunk.truncated;
              void recordUsage(project, {
                model, task: "output-recovery", promptTokens: chunk.inputTokens,
                completionTokens: chunk.outputTokens, cachedTokens: chunk.cachedTokens,
                reportedCost: chunk.reportedCost,
              });
            }
          },
        });
        if (!done) throw new Error(i18n.t("ai.recovery.interrupted"));
        if (!row.text.slice(before).trim()) throw new Error(i18n.t("ai.recovery.empty"));
        if (truncated) { row = { ...row, status: "truncated" }; break; }
        if (sections) {
          row = { ...row, nextSection: index + 1, text: row.text + "\n\n" };
          update();
          // Commit the boundary before paying for the next section.
          if (!await checkpoint.flush()) throw new Error(i18n.t("ai.recovery.saveFailed"));
        }
        row = { ...row, status: "kept" };
      } while (sections && row.nextSection! < sections.length);
    } catch (e) {
      row = { ...row, status: "interrupted" };
      if (get().project === project && (e as Error).name !== "AbortError") set({ error: String(e) });
    } finally {
      update();
      await checkpoint.close();
      display.flush();
      active.delete(id);
      if (get().controller === controller) set({ running: null, controller: null });
    }
  },
  stop: () => get().controller?.abort(),
}));
