import { create } from "zustand";
import i18n from "../i18n";
import { streamCompletion } from "../lib/aiClient";
import {
  type DocMemory,
  type MemoryFreshness,
  type MemorySegment,
  checkFreshness,
  coverEndFor,
  hashText,
  loadMemory,
  saveMemory,
  segmentTargetChars,
  splitRange,
  projectRelativePath,
  MEMORY_MIN_DOC_CHARS,
} from "../lib/memory";
import { loadApiKey } from "../lib/keyStore";
import { getDb } from "../lib/project";
import { useAiStore } from "./aiStore";
import { useProjectStore } from "./projectStore";
import { useEditorStore } from "./editorStore";

/** Tail of the previous summary handed to the next segment for continuity. */
const PREV_TAIL_CHARS = 400;

interface MemoryState {
  /** Absolute doc path the loaded memory belongs to. */
  docPath: string | null;
  memory: DocMemory | null;
  freshness: MemoryFreshness | null;
  isGenerating: boolean;
  progress: { done: number; total: number } | null;
  error: string | null;
  /** Transient status note (e.g. "already up to date"). */
  notice: string | null;
  abortController: AbortController | null;

  /** (Re)load the memory file for the currently active document. */
  loadForActiveFile: () => Promise<void>;
  /** Recompute staleness against the current editor content. */
  refreshFreshness: () => void;
  /** Build or incrementally update the memory for the active document. */
  generate: () => Promise<void>;
  abort: () => void;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  docPath: null,
  memory: null,
  freshness: null,
  isGenerating: false,
  progress: null,
  error: null,
  notice: null,
  abortController: null,

  loadForActiveFile: async () => {
    const { projectPath, activeFilePath } = useProjectStore.getState();
    if (!projectPath || !activeFilePath) {
      set({ docPath: null, memory: null, freshness: null, error: null, notice: null });
      return;
    }
    const memory = await loadMemory(projectPath, activeFilePath);
    const doc = useEditorStore.getState().content;
    set({
      docPath: activeFilePath,
      memory,
      freshness: memory ? checkFreshness(doc, memory) : null,
      error: null,
      notice: null,
    });
  },

  refreshFreshness: () => {
    const { memory, docPath } = get();
    const { activeFilePath } = useProjectStore.getState();
    if (!memory || !docPath || docPath !== activeFilePath) return;
    const doc = useEditorStore.getState().content;
    set({ freshness: checkFreshness(doc, memory) });
  },

  generate: async () => {
    if (get().isGenerating) return;
    const { projectPath, activeFilePath } = useProjectStore.getState();
    const { activeModelId, models, providers } = useAiStore.getState();
    if (!projectPath || !activeFilePath) return;
    if (!activeModelId) { set({ error: i18n.t("ai.errors.noModel") }); return; }
    const model = models.find((m) => m.id === activeModelId);
    if (!model) { set({ error: i18n.t("ai.errors.modelNotFound") }); return; }
    const provider = providers.find((p) => p.id === model.providerId);
    if (!provider) { set({ error: i18n.t("ai.errors.providerNotFound") }); return; }

    const rel = projectRelativePath(projectPath, activeFilePath);
    if (!rel) return;

    const doc = useEditorStore.getState().content;
    if (doc.length < MEMORY_MIN_DOC_CHARS) {
      set({ notice: i18n.t("ai.memory.docTooShort"), error: null });
      return;
    }
    const coverEnd = coverEndFor(doc);

    // Keep the fresh prefix; (re)summarize from the first stale segment (or the
    // end of existing coverage) up to the new cover end.
    const existing = get().docPath === activeFilePath ? get().memory : null;
    let keep: MemorySegment[] = [];
    if (existing) {
      const { firstStaleIndex } = checkFreshness(doc, existing);
      const fresh =
        firstStaleIndex === -1 ? existing.segments : existing.segments.slice(0, firstStaleIndex);
      keep = fresh.filter((s) => s.to <= coverEnd);
    }
    const startFrom = keep.length > 0 ? keep[keep.length - 1].to : 0;

    if (coverEnd - startFrom < 500) {
      set({ notice: i18n.t("ai.memory.upToDate"), error: null });
      return;
    }

    const ranges = splitRange(doc, startFrom, coverEnd, segmentTargetChars(model.contextSize));
    const apiKey = (await loadApiKey(provider.id)) ?? "";
    const baseUrl = provider.baseUrl || "https://api.openai.com/v1";
    const controller = new AbortController();
    set({
      isGenerating: true,
      progress: { done: 0, total: ranges.length },
      error: null,
      notice: null,
      abortController: controller,
    });

    let totalIn = 0;
    let totalOut = 0;
    const fresh: MemorySegment[] = [];
    try {
      for (let i = 0; i < ranges.length; i++) {
        const { from, to } = ranges[i];
        const slice = doc.slice(from, to);
        const prevSummary =
          fresh.length > 0
            ? fresh[fresh.length - 1].summary
            : keep.length > 0
              ? keep[keep.length - 1].summary
              : "";

        const parts: string[] = [];
        if (prevSummary.trim()) {
          parts.push(`${i18n.t("ai.memory.prevLabel")}\n${prevSummary.trim().slice(-PREV_TAIL_CHARS)}`);
        }
        parts.push(`${i18n.t("ai.memory.textLabel")}\n${slice}`);
        parts.push(i18n.t("ai.memory.instruction"));

        let summary = "";
        await streamCompletion({
          baseUrl,
          apiKey,
          standard: provider.apiStandard,
          safetySettings: provider.safetySettings,
          modelId: model.modelId,
          prefix: model.prefix,
          contextSize: model.contextSize,
          messages: [
            { role: "system", content: i18n.t("ai.memory.systemPrompt") },
            { role: "user", content: parts.join("\n\n") },
          ],
          signal: controller.signal,
          onChunk: (chunk) => {
            if ("done" in chunk) {
              totalIn += chunk.inputTokens;
              totalOut += chunk.outputTokens;
            } else if ("text" in chunk) {
              summary += chunk.text;
            }
          },
        });

        fresh.push({ from, to, hash: hashText(slice), summary: summary.trim() });
        set({ progress: { done: i + 1, total: ranges.length } });
      }

      const memory: DocMemory = {
        sourcePath: rel,
        coveredChars: coverEnd,
        updatedAt: new Date().toISOString(),
        segments: [...keep, ...fresh],
      };
      await saveMemory(projectPath, memory);
      set({
        docPath: activeFilePath,
        memory,
        freshness: checkFreshness(useEditorStore.getState().content, memory),
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") set({ error: String(e) });
    } finally {
      set({ isGenerating: false, progress: null, abortController: null });
      if (totalIn > 0 || totalOut > 0) {
        const cost = (totalIn * model.priceIn + totalOut * model.priceOut) / 1_000_000;
        void persistUsage(projectPath, model.id, totalIn, totalOut, cost);
      }
    }
  },

  abort: () => {
    get().abortController?.abort();
    set({ isGenerating: false, progress: null, abortController: null });
  },
}));

async function persistUsage(
  projectPath: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cost: number
): Promise<void> {
  try {
    const db = await getDb(projectPath);
    await db.execute(
      `INSERT INTO token_usage (model_id, task, prompt_tokens, completion_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [modelId, "memory", inputTokens, outputTokens, cost, Math.floor(Date.now() / 1000)]
    );
  } catch {
    // non-critical
  }
}
