/**
 * 一致性检查 state.
 *
 * A store rather than component state because the drawer renders one tab at a
 * time: switching to 对话助手 and back unmounts the check, and a scan the author
 * paid for must not evaporate because they looked at something else. It is
 * still per-session — a report describes one document at one moment, and the
 * moment passes as soon as the author starts fixing things.
 *
 * What the store owns beyond the report: the **range** and **focus** the next
 * run will use (the range persists per project), the run's execution log and
 * per-window status, and the findings as they stream in — the panel shows a
 * card the moment the checker records it, not when the run ends.
 */

import { create } from "zustand";
import i18n from "../i18n";
import { resolveConn } from "../lib/ai/conn";
import { appendAgentEventTo, type AgentEvent } from "../lib/agent/events";
import { CONSISTENCY_PRESET } from "../lib/agent/presets";
import { resolveSubAgentConn, withSessionOverrides } from "../lib/agent/subagent";
import { plannedToolTokens } from "../lib/agent/toolCost";
import { createStreamThrottle } from "../lib/agent/streamThrottle";
import { expandAuthorIntent } from "../lib/context/expand";
import { measureCharsPerToken } from "../lib/context/budget";
import { planReview, splitDocument, type DocWindow, type ReviewPlan } from "../lib/consistency/budget";
import { mergeWindowResults, type WindowResult } from "../lib/consistency/merge";
import {
  applySuggestions, locateIssue, revertSuggestion,
  type ConsistencyIssue, type ConsistencyPass, type ConsistencyReport, type WindowOutcome,
} from "../lib/consistency/model";
import { runConsistencyReview } from "../lib/consistency/review";
import {
  ALL_SCOPE, REVIEW_SCOPE_PREFIX, parseReviewScope, resolveReviewScope, serializeReviewScope,
  type ReviewScope,
} from "../lib/consistency/scope";
import { loreCategoryIds } from "../lib/profile";
import { loadApiKey } from "../lib/keyStore";
import { deletePref, readPref, writePref } from "../lib/prefs";
import { baseName, isSamePath, projectRelative } from "../lib/paths";
import { useAiStore } from "./aiStore";
import { activeChat, useAgentStore } from "./agentStore";
import { useAppStore } from "./appStore";
import { useEditorStore } from "./editorStore";
import { useLoreStore } from "./loreStore";
import { useMemoryStore } from "./memoryStore";
import { useProjectStore } from "./projectStore";

/** One applied suggestion — enough to put the quote back. */
interface AppliedRecord {
  issue: ConsistencyIssue;
}

interface ConsistencyState {
  /** What the next run measures against. Persisted per project. */
  scope: ReviewScope;
  /** One line, optional. Not persisted — it is this run's question. */
  focus: string;
  /** The project the persisted scope was loaded for. */
  scopeProject: string | null;

  report: ConsistencyReport | null;
  isScanning: boolean;
  /** Execution log of the run in flight (or the last one). */
  log: AgentEvent[];
  /** Per-window status of the run in flight (or the last one), by index. */
  windows: WindowOutcome[];
  /** Findings as they stream in during a run. Becomes `report.issues` at the end. */
  liveIssues: ConsistencyIssue[];
  livePasses: ConsistencyPass[];
  startedAt: number | null;
  error: string | null;
  /** Issues the author waved off, by id — folded to the bottom, undoable. */
  ignored: Set<string>;
  /** Issues whose suggestion was written into the document — undoable. */
  applied: Map<string, AppliedRecord>;
  /** The settings block re-opened over a finished report (设计稿 22 屏 1h-C). */
  settingsOpen: boolean;
  abortController: AbortController | null;

  loadScopeFor: (projectPath: string | null) => void;
  setScope: (scope: ReviewScope) => void;
  setFocus: (focus: string) => void;
  /** From the command palette: 「核对一致性 · 关于 “q”」. */
  prefillFromSearch: (term: string) => void;
  setSettingsOpen: (open: boolean) => void;

  scan: (opts?: { windows?: number[] }) => Promise<void>;
  /** Re-run one failed window; its findings replace that window's share of the report. */
  rerunWindow: (index: number) => Promise<void>;
  /** Check the part a cap or a stop left unchecked, keeping what is already in the report. */
  resume: () => Promise<void>;
  abort: () => void;
  clear: () => void;

  ignore: (id: string) => void;
  unignore: (id: string) => void;
  ignoreAll: () => void;
  apply: (id: string) => boolean;
  undoApply: (id: string) => boolean;
  applyAll: () => number;
  /** Drop a finding whose passage is gone — the card's 移除. */
  remove: (id: string) => void;
  locate: (id: string) => void;
  /** Put the cursor where the passage used to be. */
  locateNear: (id: string) => void;
}

/**
 * Issues still awaiting a decision, in report order.
 *
 * A plain function over the fields rather than a store selector: it builds a
 * fresh array every call, and a zustand selector that does that re-renders on
 * every store notification. Callers in components memoize it.
 */
export function openIssues(
  issues: readonly ConsistencyIssue[],
  ignored: ReadonlySet<string>,
  applied: ReadonlyMap<string, unknown>,
): ConsistencyIssue[] {
  return issues.filter((i) => !ignored.has(i.id) && !applied.has(i.id));
}

/**
 * Is the document the report was made against still the one open?
 *
 * A report is about one file, and its fixes are offsets into that file's text.
 * Applying them to a different chapter would splice one document's corrections
 * into another — `locateIssue` usually returns null and saves us, but a short
 * quote ("林辰") can match anywhere. So the write paths check first, and the UI
 * says so rather than offering buttons that would quietly do the wrong thing.
 */
export function reportMatchesOpenDocument(report: ConsistencyReport | null): boolean {
  return !!report && isSamePath(report.filePath, useEditorStore.getState().filePath);
}

/** The forecast the settings block draws — a pure derivation of store + app state. */
export function forecastReview(docText: string, scope: ReviewScope): ReviewPlan {
  const { models, activeModelId, subAgents } = useAiStore.getState();
  const model = models.find((m) => m.id === activeModelId);
  const subs = withSessionOverrides(subAgents, activeChat(useAgentStore.getState()).disabledSubAgents);
  const index = useLoreStore.getState().index;
  // Entries mode: the pins' own text is the knowledge-base segment. Their size
  // is not known without reading disk, so the forecast prices each at a
  // typical entry — the run itself measures the real thing.
  const pinnedChars = scope.kind === "entries"
    ? scope.pins.reduce((n, p) => {
        const entity = Object.values(index).flat().find((e) => e.dirPath === p.dirPath);
        return n + (p.facetFile ? 900 : 1_500 + (entity?.facets.length ?? 0) * 300);
      }, 0)
    : null;
  const memory = useMemoryStore.getState().memory;
  const recapChars = memory?.segments.reduce((n, s) => n + s.summary.length, 0) ?? 0;
  return planReview({
    contextSize: model?.contextSize,
    utilization: useAppStore.getState().contextUtilization,
    toolTokens: plannedToolTokens(CONSISTENCY_PRESET, subs, models),
    fixedChars: 1_600,
    charsPerToken: measureCharsPerToken(docText),
    docChars: docText.length,
    recapChars,
    pinnedChars,
  });
}

function replaceWindow(list: WindowOutcome[], next: WindowOutcome): WindowOutcome[] {
  const out = list.slice();
  const at = out.findIndex((w) => w.index === next.index);
  if (at === -1) out.push(next);
  else out[at] = next;
  return out.sort((a, b) => a.index - b.index);
}

export const useConsistencyStore = create<ConsistencyState>((set, get) => ({
  scope: ALL_SCOPE,
  focus: "",
  scopeProject: null,
  report: null,
  isScanning: false,
  log: [],
  windows: [],
  liveIssues: [],
  livePasses: [],
  startedAt: null,
  error: null,
  ignored: new Set(),
  applied: new Map(),
  settingsOpen: false,
  abortController: null,

  loadScopeFor: (projectPath) => {
    if (get().scopeProject === projectPath) return;
    const scope = projectPath ? parseReviewScope(readPref(`${REVIEW_SCOPE_PREFIX}${projectPath}`)) : ALL_SCOPE;
    set({ scope, scopeProject: projectPath });
  },

  setScope: (scope) => {
    const projectPath = useProjectStore.getState().projectPath;
    set({ scope });
    if (!projectPath) return;
    const raw = serializeReviewScope(scope);
    if (raw) writePref(`${REVIEW_SCOPE_PREFIX}${projectPath}`, raw);
    else deletePref(`${REVIEW_SCOPE_PREFIX}${projectPath}`);
  },

  setFocus: (focus) => set({ focus }),

  prefillFromSearch: (term) => {
    const q = term.trim();
    if (!q) return;
    // A term that names an entry narrows the range to it (设计稿 22 屏 1k);
    // anything else is only a focus.
    const lower = q.toLowerCase();
    const hit = Object.values(useLoreStore.getState().index)
      .flat()
      .find((e) => e.name.toLowerCase() === lower || e.aliases?.some((a) => a.toLowerCase() === lower));
    if (hit) get().setScope({ kind: "entries", pins: [{ dirPath: hit.dirPath, facetFile: null }] });
    set({
      focus: i18n.t("ai.consistency.focusFromSearch", { defaultValue: "关于“{{q}}”的一致性", q }),
      settingsOpen: true,
    });
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  scan: async (opts) => {
    if (get().isScanning) return;
    const { models, providers, activeModelId, subAgents } = useAiStore.getState();
    const resolved = resolveConn(models, providers, activeModelId);
    if (!resolved.ok) {
      set({ error: resolved.error });
      return;
    }
    const { model, provider } = resolved;
    const projectPath = useProjectStore.getState().projectPath;
    if (!projectPath) return;

    // The tools read the file off disk, so the editor's text has to be there first.
    await useEditorStore.getState().saveNow().catch(() => {});
    const { content, filePath } = useEditorStore.getState();
    if (!content.trim()) {
      set({ error: i18n.t("ai.consistency.errorEmptyDoc", { defaultValue: "当前文档没有正文可检查" }) });
      return;
    }

    const controller = new AbortController();
    const runId = String(Date.now());
    const previous = get().report;
    // Partial runs (one window again, or the unchecked tail) keep the rest of
    // the report; a fresh run starts clean.
    const partial = !!opts?.windows && !!previous && isSamePath(previous.filePath, filePath);
    set({
      isScanning: true,
      error: null,
      startedAt: Date.now(),
      abortController: controller,
      log: [],
      windows: partial ? previous!.windows : [],
      liveIssues: partial ? previous!.issues : [],
      livePasses: partial ? previous!.passed : [],
      report: partial ? previous : null,
      ignored: partial ? get().ignored : new Set(),
      applied: partial ? get().applied : new Map(),
      settingsOpen: false,
    });

    // Events land at most once per interval; reasoning is latest-wins per
    // (parentStep, round) — the same shape aiTaskStore uses.
    let pendingReasoning: Extract<AgentEvent, { kind: "reasoning" }> | null = null;
    let pendingEvents: AgentEvent[] = [];
    const stream = createStreamThrottle(() => {
      if (get().abortController !== controller) { pendingEvents = []; pendingReasoning = null; return; }
      const batch = pendingEvents;
      pendingEvents = [];
      const reasoning = pendingReasoning;
      pendingReasoning = null;
      if (batch.length === 0 && !reasoning) return;
      set((s) => {
        let log = s.log;
        for (const e of batch) log = appendAgentEventTo(log, e);
        if (reasoning) log = appendAgentEventTo(log, reasoning);
        return { log };
      });
    });
    const onEvent = (event: AgentEvent) => {
      if (get().abortController !== controller) return;
      if (event.kind === "reasoning") {
        if (pendingReasoning && (pendingReasoning.parentStep !== event.parentStep || pendingReasoning.round !== event.round)) {
          pendingEvents.push(pendingReasoning);
        }
        pendingReasoning = event;
        stream.schedule();
        return;
      }
      if (pendingReasoning) { pendingEvents.push(pendingReasoning); pendingReasoning = null; }
      pendingEvents.push(event);
      stream.schedule();
    };

    try {
      const apiKey = (await loadApiKey(provider.id)) ?? "";
      const conn = { provider, model, apiKey };
      // The drawer renders one tab at a time, so opening straight onto this one
      // means nothing has asked for the recap yet.
      await useMemoryStore.getState().loadForActiveFile().catch(() => {});
      if (get().abortController !== controller) return;

      const loreState = useLoreStore.getState();
      const declared = useProjectStore.getState().collections;
      const { effective: scope } = resolveReviewScope(get().scope, loreState.index, declared);
      const focus = get().focus;
      const plan = forecastReview(content, scope);
      const allWindows = splitDocument(content, plan.windowChars);
      const windows: DocWindow[] = opts?.windows
        ? allWindows.filter((w) => opts.windows!.includes(w.index))
        : allWindows;
      const uncheckedFrom = plan.uncheckedChars > 0 ? allWindows[allWindows.length - 1].to : null;

      const subs = withSessionOverrides(subAgents, activeChat(useAgentStore.getState()).disabledSubAgents);
      const allModels = useAiStore.getState().models;
      const allProviders = useAiStore.getState().providers;

      const { results } = await runConsistencyReview({
        conn,
        projectPath,
        documentText: content,
        documentRelPath: filePath ? projectRelative(projectPath, filePath) : null,
        documentTitle: baseName(filePath ?? "").replace(/\.md$/i, "")
          || i18n.t("ai.consistency.untitledDoc", { defaultValue: "当前文档" }),
        loreIndex: loreState.index,
        fence: loreState.scope,
        scope,
        focus,
        categoryIds: loreCategoryIds(),
        memory: useMemoryStore.getState().memory,
        plan,
        windows,
        subAgents: subs,
        models: allModels,
        contextUtilization: useAppStore.getState().contextUtilization,
        resolveSubAgent: (k) => resolveSubAgentConn(k, allModels, allProviders, subs, loadApiKey),
        expandFocus: async (intent, signal) => {
          const rc = await resolveSubAgentConn("retrieval", allModels, allProviders, subs, loadApiKey);
          if ("error" in rc) return [];
          return expandAuthorIntent({ intent, loreIndex: loreState.index, scope: loreState.scope, conn: rc, signal });
        },
        signal: controller.signal,
        runId,
        onEvent,
        onWindow: (w) => {
          if (get().abortController !== controller) return;
          set((s) => ({ windows: replaceWindow(s.windows, w) }));
        },
        onIssue: (issue) => {
          if (get().abortController !== controller) return;
          set((s) => {
            const at = s.liveIssues.findIndex((i) => i.id === issue.id);
            const next = s.liveIssues.slice();
            if (at === -1) next.push(issue); else next[at] = issue;
            return { liveIssues: next };
          });
        },
        onPass: (pass) => {
          if (get().abortController !== controller) return;
          set((s) => ({ livePasses: [...s.livePasses, pass] }));
        },
      });
      stream.flush();
      if (get().abortController !== controller) return;

      // A partial run replaces only its own windows' share.
      const kept: WindowResult[] = partial
        ? previous!.windows
            .filter((w) => !windows.some((x) => x.index === w.index))
            .map((w) => ({
              outcome: w,
              issues: previous!.issues.filter((i) => i.window === w.index),
              passed: previous!.passed.filter((p) => p.window === w.index),
            }))
        : [];
      const merged = mergeWindowResults([...kept, ...results]);
      const aborted = controller.signal.aborted || merged.windows.some((w) => w.status === "aborted");
      const done = merged.windows.filter((w) => w.status === "done");
      const report: ConsistencyReport = {
        issues: merged.issues,
        passed: merged.passed,
        checkedCount: merged.issues.length + merged.passed.length,
        durationMs: Date.now() - (get().startedAt ?? Date.now()),
        filePath,
        docChars: content.length,
        scope,
        focus,
        windows: merged.windows,
        uncheckedFrom,
        aborted,
        emptyRun: done.length > 0 && done.every((w) => w.empty) && merged.issues.length === 0 && merged.passed.length === 0,
      };
      set({
        report,
        isScanning: false,
        abortController: null,
        liveIssues: report.issues,
        livePasses: report.passed,
        windows: report.windows,
      });
    } catch (e) {
      stream.flush();
      if (get().abortController !== controller) return;
      const isAbort = (e as Error)?.name === "AbortError";
      set({
        isScanning: false,
        abortController: null,
        error: isAbort ? null : e instanceof Error ? e.message : String(e),
      });
    }
  },

  rerunWindow: (index) => get().scan({ windows: [index] }),

  resume: async () => {
    const report = get().report;
    if (!report) return;
    const redo = report.windows.filter((w) => w.status !== "done").map((w) => w.index);
    // The cap's tail is beyond the windows the plan made; a fresh plan over the
    // same text makes the same windows, so "from where it stopped" is simply
    // every window that is not done — plus the tail, if the cap left one and
    // the redo list would otherwise be empty.
    if (redo.length === 0 && report.uncheckedFrom === null) return;
    if (redo.length > 0) await get().scan({ windows: redo });
    else await get().scan();
  },

  abort: () => {
    // The run notices the signal, marks what it did not reach as aborted, and
    // settles into a half report through the normal path.
    get().abortController?.abort();
  },

  clear: () =>
    set({
      report: null, error: null, log: [], windows: [], liveIssues: [], livePasses: [],
      ignored: new Set(), applied: new Map(), startedAt: null, settingsOpen: false,
    }),

  ignore: (id) => set((s) => ({ ignored: new Set(s.ignored).add(id) })),
  unignore: (id) =>
    set((s) => {
      const next = new Set(s.ignored);
      next.delete(id);
      return { ignored: next };
    }),
  ignoreAll: () =>
    set((s) => ({
      ignored: new Set([...s.ignored, ...openIssues(s.report?.issues ?? [], s.ignored, s.applied).map((i) => i.id)]),
    })),

  apply: (id) => {
    if (!reportMatchesOpenDocument(get().report)) return false;
    const issue = get().report?.issues.find((i) => i.id === id);
    if (!issue?.suggestion) return false;
    const { content, setContent } = useEditorStore.getState();
    const { text, applied } = applySuggestions(content, [issue]);
    if (applied.length === 0) return false;
    setContent(text);
    set((s) => ({ applied: new Map(s.applied).set(id, { issue }) }));
    return true;
  },

  undoApply: (id) => {
    if (!reportMatchesOpenDocument(get().report)) return false;
    const record = get().applied.get(id);
    if (!record) return false;
    const { content, setContent } = useEditorStore.getState();
    const text = revertSuggestion(content, record.issue);
    if (text === null) return false;
    setContent(text);
    set((s) => {
      const next = new Map(s.applied);
      next.delete(id);
      return { applied: next };
    });
    return true;
  },

  applyAll: () => {
    const { report, ignored, applied } = get();
    if (!reportMatchesOpenDocument(report)) return 0;
    const pending = openIssues(report!.issues, ignored, applied).filter((i) => i.suggestion);
    if (pending.length === 0) return 0;
    const { content, setContent } = useEditorStore.getState();
    const { text, applied: landed } = applySuggestions(content, pending);
    if (landed.length === 0) return 0;
    setContent(text);
    set((s) => {
      const next = new Map(s.applied);
      for (const id of landed) {
        const issue = pending.find((i) => i.id === id)!;
        next.set(id, { issue });
      }
      return { applied: next };
    });
    return landed.length;
  },

  remove: (id) =>
    set((s) => {
      if (!s.report) return {};
      return {
        report: { ...s.report, issues: s.report.issues.filter((i) => i.id !== id) },
        liveIssues: s.liveIssues.filter((i) => i.id !== id),
      };
    }),

  locate: (id) => {
    if (!reportMatchesOpenDocument(get().report)) return;
    const issue = get().report?.issues.find((i) => i.id === id);
    const view = useEditorStore.getState().editorView;
    if (!issue || !view) return;
    // Re-located against the live document, not the scan's snapshot: by the
    // time the author reaches issue four they have already edited around it.
    const range = locateIssue(view.state.doc.toString(), issue);
    if (!range) return;
    view.dispatch({
      selection: { anchor: range.from, head: Math.min(range.to, view.state.doc.length) },
      scrollIntoView: true,
    });
    view.focus();
  },

  locateNear: (id) => {
    if (!reportMatchesOpenDocument(get().report)) return;
    const issue = get().report?.issues.find((i) => i.id === id);
    const view = useEditorStore.getState().editorView;
    if (!issue?.anchor || !view) return;
    const at = Math.min(issue.anchor.from, view.state.doc.length);
    view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    view.focus();
  },
}));
