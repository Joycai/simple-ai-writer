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
import { readFile } from "../lib/fileio";
import type { Model, Provider } from "../lib/aiConfig";
import { loadApiKey } from "../lib/keyStore";
import { getDb } from "../lib/project";
import { useAiStore } from "./aiStore";
import { useProjectStore } from "./projectStore";
import { useEditorStore } from "./editorStore";

/** Tail of the previous summary handed to the next segment for continuity. */
const PREV_TAIL_CHARS = 400;

/** Progress reported while summarizing segments. */
type Progress = { done: number; total: number };

type GenOutcome =
  | { memory: DocMemory; usage: { in: number; out: number } }
  | { skipped: "short" | "upToDate" };

/**
 * Core memory (re)generation for a single document, independent of which store
 * fields are being driven — used both for the active document and for arbitrary
 * chapters triggered from the outline. Keeps the fresh prefix, re-summarizes
 * from the first stale segment (or end of coverage) up to the new cover end.
 */
async function runMemoryGeneration(opts: {
  projectPath: string;
  rel: string;
  content: string;
  existing: DocMemory | null;
  model: Model;
  provider: Provider;
  apiKey: string;
  signal: AbortSignal;
  onProgress: (p: Progress) => void;
  /** Summarize even a below-threshold doc, covering the whole chapter (no tail). */
  force?: boolean;
}): Promise<GenOutcome> {
  const { projectPath, rel, content, existing, model, provider, apiKey, signal, onProgress, force } = opts;

  if (!force && content.length < MEMORY_MIN_DOC_CHARS) return { skipped: "short" };
  // Forced (e.g. a short chapter summarized from the outline) covers everything;
  // otherwise leave the verbatim tail for the doc's own continuation window.
  const coverEnd = force ? content.length : coverEndFor(content);

  let keep: MemorySegment[] = [];
  if (existing) {
    const { firstStaleIndex } = checkFreshness(content, existing);
    const fresh =
      firstStaleIndex === -1 ? existing.segments : existing.segments.slice(0, firstStaleIndex);
    keep = fresh.filter((s) => s.to <= coverEnd);
  }
  const startFrom = keep.length > 0 ? keep[keep.length - 1].to : 0;
  if (coverEnd - startFrom < (force ? 1 : 500)) return { skipped: "upToDate" };

  const ranges = splitRange(content, startFrom, coverEnd, segmentTargetChars(model.contextSize));
  const baseUrl = provider.baseUrl || "https://api.openai.com/v1";
  onProgress({ done: 0, total: ranges.length });

  let totalIn = 0;
  let totalOut = 0;
  const fresh: MemorySegment[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const { from, to } = ranges[i];
    const slice = content.slice(from, to);
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
      signal,
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
    onProgress({ done: i + 1, total: ranges.length });
  }

  const memory: DocMemory = {
    sourcePath: rel,
    coveredChars: coverEnd,
    updatedAt: new Date().toISOString(),
    segments: [...keep, ...fresh],
  };
  await saveMemory(projectPath, memory);
  return { memory, usage: { in: totalIn, out: totalOut } };
}

/**
 * Resolve the model for summarization + its provider, or an error message.
 * Prefers the dedicated memory model, falling back to the active model.
 */
function resolveModel():
  | { model: Model; provider: Provider }
  | { error: string } {
  const { activeModelId, memoryModelId, models, providers } = useAiStore.getState();
  const modelId = memoryModelId ?? activeModelId;
  if (!modelId) return { error: i18n.t("ai.errors.noModel") };
  const model = models.find((m) => m.id === modelId);
  if (!model) return { error: i18n.t("ai.errors.modelNotFound") };
  const provider = providers.find((p) => p.id === model.providerId);
  if (!provider) return { error: i18n.t("ai.errors.providerNotFound") };
  return { model, provider };
}

interface MemoryState {
  /** Absolute doc path the loaded memory belongs to. */
  docPath: string | null;
  memory: DocMemory | null;
  freshness: MemoryFreshness | null;
  isGenerating: boolean;
  progress: Progress | null;
  error: string | null;
  /** Transient status note (e.g. "already up to date"). */
  notice: string | null;
  abortController: AbortController | null;
  /** Outline-triggered generation for a specific chapter (by absolute path). */
  chapterGen: { path: string; done: number; total: number } | null;
  chapterGenController: AbortController | null;

  /** (Re)load the memory file for the currently active document. */
  loadForActiveFile: () => Promise<void>;
  /** Recompute staleness against the current editor content. */
  refreshFreshness: () => void;
  /** Build or incrementally update the memory for the active document. */
  generate: () => Promise<void>;
  abort: () => void;
  /** Generate memory for an arbitrary chapter (from the outline view).
   *  `force` summarizes even a below-threshold (too-short) chapter. */
  generateForFile: (absFilePath: string, force?: boolean) => Promise<void>;
  abortChapterGen: () => void;
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
  chapterGen: null,
  chapterGenController: null,

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
    if (!projectPath || !activeFilePath) return;
    const resolved = resolveModel();
    if ("error" in resolved) { set({ error: resolved.error }); return; }
    const { model, provider } = resolved;

    const rel = projectRelativePath(projectPath, activeFilePath);
    if (!rel) return;

    const content = useEditorStore.getState().content;
    if (content.length < MEMORY_MIN_DOC_CHARS) {
      set({ notice: i18n.t("ai.memory.docTooShort"), error: null });
      return;
    }

    const existing = get().docPath === activeFilePath ? get().memory : null;
    const apiKey = (await loadApiKey(provider.id)) ?? "";
    const controller = new AbortController();
    set({ isGenerating: true, progress: { done: 0, total: 0 }, error: null, notice: null, abortController: controller });

    try {
      const outcome = await runMemoryGeneration({
        projectPath, rel, content, existing, model, provider, apiKey,
        signal: controller.signal,
        onProgress: (p) => set({ progress: p }),
      });
      if ("skipped" in outcome) {
        set({ notice: i18n.t(outcome.skipped === "short" ? "ai.memory.docTooShort" : "ai.memory.upToDate") });
      } else {
        recordUsage(projectPath, model, outcome.usage);
        set({
          docPath: activeFilePath,
          memory: outcome.memory,
          freshness: checkFreshness(useEditorStore.getState().content, outcome.memory),
        });
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") set({ error: String(e) });
    } finally {
      set({ isGenerating: false, progress: null, abortController: null });
    }
  },

  abort: () => {
    get().abortController?.abort();
    set({ isGenerating: false, progress: null, abortController: null });
  },

  generateForFile: async (absFilePath, force = false) => {
    if (get().isGenerating || get().chapterGen) return;
    const { projectPath, activeFilePath } = useProjectStore.getState();
    if (!projectPath) return;
    const resolved = resolveModel();
    if ("error" in resolved) { set({ error: resolved.error }); return; }
    const { model, provider } = resolved;

    const rel = projectRelativePath(projectPath, absFilePath);
    if (!rel) return;

    // Prefer live editor content for the open file (picks up unsaved edits).
    let content: string;
    try {
      content = absFilePath === activeFilePath
        ? useEditorStore.getState().content
        : await readFile(absFilePath);
    } catch (e) {
      set({ error: String(e) });
      return;
    }
    if (!force && content.length < MEMORY_MIN_DOC_CHARS) {
      set({ notice: i18n.t("ai.memory.docTooShort"), error: null });
      return;
    }

    const existing = await loadMemory(projectPath, absFilePath);
    const apiKey = (await loadApiKey(provider.id)) ?? "";
    const controller = new AbortController();
    set({ chapterGen: { path: absFilePath, done: 0, total: 0 }, chapterGenController: controller, error: null, notice: null });

    try {
      const outcome = await runMemoryGeneration({
        projectPath, rel, content, existing, model, provider, apiKey, force,
        signal: controller.signal,
        onProgress: (p) => set({ chapterGen: { path: absFilePath, done: p.done, total: p.total } }),
      });
      if ("skipped" in outcome) {
        set({ notice: i18n.t(outcome.skipped === "short" ? "ai.memory.docTooShort" : "ai.memory.upToDate") });
      } else {
        recordUsage(projectPath, model, outcome.usage);
        // Keep the active-doc memory view in sync when we just regenerated it.
        if (absFilePath === activeFilePath || get().docPath === absFilePath) {
          set({
            docPath: absFilePath,
            memory: outcome.memory,
            freshness: checkFreshness(useEditorStore.getState().content, outcome.memory),
          });
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") set({ error: String(e) });
    } finally {
      set({ chapterGen: null, chapterGenController: null });
    }
  },

  abortChapterGen: () => {
    get().chapterGenController?.abort();
    set({ chapterGen: null, chapterGenController: null });
  },
}));

/** Persist summarization token usage (best-effort). */
function recordUsage(projectPath: string, model: Model, usage: { in: number; out: number }): void {
  if (usage.in <= 0 && usage.out <= 0) return;
  const cost = (usage.in * model.priceIn + usage.out * model.priceOut) / 1_000_000;
  void persistUsage(projectPath, model.id, usage.in, usage.out, cost);
}

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
