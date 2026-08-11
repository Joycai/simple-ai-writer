/**
 * 一致性检查 state.
 *
 * A store rather than component state because the drawer renders one tab at a
 * time: switching to 对话助手 and back unmounts the check, and a scan the author
 * paid for must not evaporate because they looked at something else. It is
 * still per-session — a report describes one document at one moment, and the
 * moment passes as soon as the author starts fixing things.
 */

import { create } from "zustand";
import i18n from "../i18n";
import { runConsistencyScan } from "../lib/consistency/scan";
import {
  applySuggestions, locateQuote, type ConsistencyIssue, type ConsistencyReport,
} from "../lib/consistency/model";
import { loreCategoryIds } from "../lib/profile";
import { loadApiKey } from "../lib/keyStore";
import { useAiStore } from "./aiStore";
import { useEditorStore } from "./editorStore";
import { useLoreStore } from "./loreStore";
import { useMemoryStore } from "./memoryStore";

interface ConsistencyState {
  report: ConsistencyReport | null;
  isScanning: boolean;
  /** Streamed text while the model works — the only sign of life on a long scan. */
  progress: string;
  error: string | null;
  /** Issues the author has dealt with or waved off, by id. */
  resolved: Set<string>;
  abortController: AbortController | null;

  scan: () => Promise<void>;
  abort: () => void;
  clear: () => void;
  /** Wave one off without changing the manuscript. */
  ignore: (id: string) => void;
  ignoreAll: () => void;
  /** Write one issue's suggestion into the document. Returns whether it landed. */
  apply: (id: string) => boolean;
  /** Write every remaining suggestion in one edit. Returns how many landed. */
  applyAll: () => number;
  /** Put the cursor on an issue's passage in the editor. */
  locate: (id: string) => void;
}

/**
 * Issues still awaiting a decision, in report order.
 *
 * A plain function over the two fields rather than a store selector: it builds
 * a fresh array every call, and a zustand selector that does that re-renders on
 * every store notification. Callers in components memoize it on
 * `[report, resolved]`.
 */
export function openIssues(
  report: ConsistencyReport | null,
  resolved: ReadonlySet<string>,
): ConsistencyIssue[] {
  return report?.issues.filter((i) => !resolved.has(i.id)) ?? [];
}

/**
 * Is the document the report was made against still the one open?
 *
 * A report is about one file, and its fixes are offsets into that file's text.
 * Applying them to a different chapter would splice one document's corrections
 * into another — `locateQuote` usually returns null and saves us, but a short
 * quote ("林辰") can match anywhere. So the write paths check first, and the UI
 * says so rather than offering buttons that would quietly do the wrong thing.
 */
export function reportMatchesOpenDocument(report: ConsistencyReport | null): boolean {
  return !!report && report.filePath === useEditorStore.getState().filePath;
}

export const useConsistencyStore = create<ConsistencyState>((set, get) => ({
  report: null,
  isScanning: false,
  progress: "",
  error: null,
  resolved: new Set(),
  abortController: null,

  scan: async () => {
    const { models, providers, activeModelId } = useAiStore.getState();
    const model = models.find((m) => m.id === activeModelId);
    const provider = model ? providers.find((p) => p.id === model.providerId) : null;
    if (!model || !provider) {
      set({ error: i18n.t("ai.errors.noModel") });
      return;
    }

    const { content, filePath } = useEditorStore.getState();
    if (!content.trim()) {
      set({ error: i18n.t("ai.consistency.errorEmptyDoc", { defaultValue: "当前文档没有正文可检查" }) });
      return;
    }

    const controller = new AbortController();
    set({
      isScanning: true, error: null, progress: "",
      report: null, resolved: new Set(), abortController: controller,
    });

    try {
      const apiKey = (await loadApiKey(provider.id)) ?? "";
      // The drawer renders one tab at a time, so opening straight onto this one
      // means nothing has asked for the recap yet. Failing to load it costs the
      // scan its 时序 material, so ask before reading rather than after.
      await useMemoryStore.getState().loadForActiveFile().catch(() => {});
      if (get().abortController !== controller) return;
      const report = await runConsistencyScan({
        baseUrl: provider.baseUrl,
        apiKey,
        standard: provider.apiStandard,
        safetySettings: provider.safetySettings,
        authMode: provider.authMode,
        modelId: model.modelId,
        prefix: model.prefix,
        contextSize: model.contextSize,
        maxOutput: model.maxOutput,
        documentText: content,
        filePath,
        documentTitle: (filePath?.split(/[\\/]/).pop() ?? "").replace(/\.md$/i, "")
          || i18n.t("ai.consistency.untitledDoc", { defaultValue: "当前文档" }),
        loreIndex: useLoreStore.getState().index,
        pinnedLorePaths: [],
        categoryIds: loreCategoryIds(),
        memory: useMemoryStore.getState().memory,
        signal: controller.signal,
        onText: (text) => {
          // Guarded like every other streaming callback in the app: an aborted
          // scan's stream can still deliver a chunk after a new one started.
          if (get().abortController === controller) set({ progress: text });
        },
      });
      if (get().abortController !== controller) return;
      set({ report, isScanning: false, abortController: null, progress: "" });
    } catch (e) {
      if (get().abortController !== controller) return;
      const aborted = (e as Error)?.name === "AbortError";
      set({
        isScanning: false,
        abortController: null,
        progress: "",
        error: aborted ? null : e instanceof Error ? e.message : String(e),
      });
    }
  },

  abort: () => {
    get().abortController?.abort();
    set({ isScanning: false, abortController: null, progress: "" });
  },

  clear: () => set({ report: null, error: null, resolved: new Set(), progress: "" }),

  ignore: (id) => set((s) => ({ resolved: new Set(s.resolved).add(id) })),

  ignoreAll: () =>
    set((s) => ({ resolved: new Set((s.report?.issues ?? []).map((i) => i.id)) })),

  apply: (id) => {
    if (!reportMatchesOpenDocument(get().report)) return false;
    const issue = get().report?.issues.find((i) => i.id === id);
    if (!issue?.suggestion) return false;
    const { content, setContent } = useEditorStore.getState();
    const { text, applied } = applySuggestions(content, [issue]);
    if (applied.length === 0) return false;
    setContent(text);
    set((s) => ({ resolved: new Set(s.resolved).add(id) }));
    return true;
  },

  applyAll: () => {
    const { report, resolved } = get();
    if (!reportMatchesOpenDocument(report)) return 0;
    const pending = openIssues(report, resolved).filter((i) => i.suggestion);
    if (pending.length === 0) return 0;
    const { content, setContent } = useEditorStore.getState();
    const { text, applied } = applySuggestions(content, pending);
    if (applied.length === 0) return 0;
    setContent(text);
    set((s) => {
      const next = new Set(s.resolved);
      for (const id of applied) next.add(id);
      return { resolved: next };
    });
    return applied.length;
  },

  locate: (id) => {
    if (!reportMatchesOpenDocument(get().report)) return;
    const issue = get().report?.issues.find((i) => i.id === id);
    const view = useEditorStore.getState().editorView;
    if (!issue || !view) return;
    // Re-located against the live document, not the scan's snapshot: by the
    // time the author reaches issue four they have already edited around it.
    const range = locateQuote(view.state.doc.toString(), issue.quote);
    if (!range) return;
    view.dispatch({
      selection: { anchor: range.from, head: Math.min(range.to, view.state.doc.length) },
      scrollIntoView: true,
    });
    view.focus();
  },
}));
