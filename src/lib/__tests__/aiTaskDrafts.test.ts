/**
 * `aiTaskStore.runTask` — its multi-draft output and its instruction assembly.
 *
 * A run produces one or more drafts by firing one completion per draft over a
 * shared, once-assembled context. The behaviour worth pinning is what inspection
 * can't confirm: that N really means N requests, that the drafts are isolated
 * from each other's failures, that one abort stops all of them, that the tasks
 * which must not fan out can't be made to, and that a task's prompt is built
 * from its definition (plus any prompt template overriding it).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Chunk =
  | { text: string }
  | { done: true; inputTokens: number; outputTokens: number };

interface StreamArgs {
  messages: unknown;
  signal: AbortSignal;
  onChunk: (chunk: Chunk) => void;
}

const h = vi.hoisted(() => ({
  /** The author's requested draft count, as appStore would report it. */
  draftCount: 1,
  /** Every streamCompletion call, in fire order. */
  streams: [] as { signal: AbortSignal }[],
  /** Per-call-index behaviour; default is "emit some text and finish". */
  behaviour: null as null | ((index: number, args: StreamArgs) => Promise<void>),
  persisted: [] as { inTokens: number; cachedTokens: number; outTokens: number }[],
  runAgent: vi.fn(async (_opts: unknown) => ({ inputTokens: 7, outputTokens: 3, cachedTokens: 0 })),
  agentOutput: "agent text",
}));

vi.mock("../ai", () => ({
  streamCompletion: async (args: StreamArgs) => {
    const index = h.streams.length;
    h.streams.push({ signal: args.signal });
    if (h.behaviour) return h.behaviour(index, args);
    args.onChunk({ text: `draft-${index}` });
    args.onChunk({ done: true, inputTokens: 10, outputTokens: 5 });
  },
}));

// The agentic path is only here to prove it stays single-draft.
vi.mock("../agent/runtime", () => ({
  runAgent: async (opts: { onOutputText: (t: string) => void }) => {
    // Cumulative snapshot, as the real runtime sends.
    opts.onOutputText(h.agentOutput);
    return h.runAgent(opts);
  },
}));
// presets is deliberately NOT mocked: it is pure data plus `presetForTools`'s
// switch, and the mapping from a task's declared tools to a preset is part of
// what these tests are checking.
vi.mock("../agent/plan", () => ({ createPlanGate: () => ({}) }));

// Context assembly is someone else's test; here it just has to be cheap and
// identical for every draft.
vi.mock("../context/rag", () => ({
  assembleContext: vi.fn(async () => ({ loreReport: { entries: [] } })),
  bundleToMessages: vi.fn(() => [{ role: "user", content: "prompt" }]),
  profileSystemPrompt: () => "system",
  resolveAppendAnchor: () => 0,
}));
// Partial: appStore imports this module's CONTEXT_UTILIZATION_* constants, so
// only the planning functions are stubbed out.
vi.mock("../context/budget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context/budget")>()),
  fixedContextChars: () => 0,
  measureCharsPerToken: () => 3,
  reflowMemoryBudget: () => 0,
  planContextBudget: () => ({
    loreChars: 0, memoryChars: 0, bookPriorChars: 0, recentWindowChars: 100,
    charsPerToken: 3, dynamic: false, inputCeilingTokens: 1000,
  }),
}));
// Partial: runTask also pulls projectRelativePath from here to name the current
// file for tool-using tasks, and that helper is pure.
vi.mock("../context/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context/memory")>()),
  loadMemory: vi.fn(async () => null),
}));
vi.mock("../context/bookContext", () => ({
  BOOK_PREV_TAIL_CHARS: 0,
  buildBookContext: vi.fn(async () => null),
}));

// Echoing translator, so the instruction assertions below can name the *key* a
// task resolved rather than restating a prompt's prose (which would make every
// prompt edit a test failure).
vi.mock("../../i18n", () => ({ default: { t: (key: string) => key } }));

vi.mock("../keyStore", () => ({ loadApiKey: vi.fn(async () => "key") }));
vi.mock("../ai/modelHealth", () => ({ recordRunOutcome: vi.fn() }));
vi.mock("../project", () => ({
  getDb: vi.fn(async () => ({
    execute: vi.fn(async (_sql: string, params: unknown[]) => {
      h.persisted.push({
        inTokens: params[2] as number,
        cachedTokens: params[3] as number,
        outTokens: params[4] as number,
      });
    }),
  })),
}));
vi.mock("../../stores/agentStore", () => ({
  useAgentStore: {
    getState: () => ({ rejectAll: vi.fn(), requestApproval: vi.fn(), requestPlanApproval: vi.fn() }),
  },
}));
vi.mock("../../stores/editorStore", () => ({
  getWritingFocus: () => ({ text: "document body", filePath: "/proj/writing/a.md", settled: true }),
}));
vi.mock("../../stores/loreStore", () => ({
  useLoreStore: { getState: () => ({ index: {} }) },
}));
vi.mock("../../stores/projectStore", () => ({
  useProjectStore: {
    getState: () => ({ projectPath: "/proj", fileTree: [] }),
    // aiTaskStore subscribes at module load to drop a stale selection when the
    // focused file changes; not under test here, so the unsubscribe is a no-op.
    subscribe: () => () => {},
  },
}));
// Real task definitions, since runTask now resolves the task through the profile
// and branches on its `tools`/`continuation` rather than on its id.
vi.mock("../profile/active", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../profile/active")>()),
  docModel: () => ({ ordered: true, priorContext: true, memory: true }),
}));
// Mocked wholesale rather than stubbed around: appStore reads `localStorage` and
// writes `document` at module load, and the test environment is node. Only the
// setting the run consults is needed here — MAX_DRAFTS comes from lib/ai/drafts,
// so there is no duplicated constant to drift.
vi.mock("../../stores/appStore", () => ({
  useAppStore: {
    getState: () => ({
      draftCount: h.draftCount,
      loreBudgetTokens: 600,
      contextUtilization: 0.8,
    }),
  },
}));

import { useAiTaskStore } from "../../stores/aiTaskStore";
import { MAX_DRAFTS, draftCountFor, totalUsage, type Draft } from "../ai/drafts";
import { DEFAULT_TASKS, type TaskDef } from "../profile/model";
import { useAiStore } from "../../stores/aiStore";

const MODEL = {
  id: "m1", providerId: "p1", modelId: "gpt-x", name: "GPT-X",
  contextSize: 8000, priceIn: 1, priceCachedIn: 0, priceOut: 2, type: "text", prefix: "",
};
const PROVIDER = { id: "p1", name: "P", baseUrl: "https://api.test/v1", apiStandard: "openai" };

beforeEach(() => {
  h.streams.length = 0;
  h.persisted.length = 0;
  h.behaviour = null;
  vi.clearAllMocks();
  useAiStore.setState({
    models: [MODEL as never], providers: [PROVIDER as never], prompts: [],
    activeModelId: "m1", activePromptId: null,
  });
  h.draftCount = 1;
  useAiTaskStore.setState({
    drafts: [], activeDraftId: null, error: null, isRunning: false,
    selection: "", selectionRange: null, agentLog: [], abortController: null,
  });
});

const drafts = (): Draft[] => useAiTaskStore.getState().drafts;

const taskById = (id: string): TaskDef => {
  const found = DEFAULT_TASKS.find((t) => t.id === id);
  if (!found) throw new Error(`no built-in task "${id}"`);
  return found;
};

describe("draftCountFor", () => {
  it("clamps to the supported range", () => {
    const polish = taskById("polish");
    expect(draftCountFor(polish, 1)).toBe(1);
    expect(draftCountFor(polish, 3)).toBe(3);
    expect(draftCountFor(polish, 99)).toBe(MAX_DRAFTS);
    expect(draftCountFor(polish, 0)).toBe(1);
    expect(draftCountFor(polish, -2)).toBe(1);
    expect(draftCountFor(polish, 2.7)).toBe(2);
    expect(draftCountFor(polish, NaN)).toBe(1);
  });

  it("pins any tool-using task to a single draft", () => {
    // The rule is about tools, not about which tasks happen to have them: a
    // shared execution log can't hold N interleaved runs, and a write-capable
    // toolset additionally can't have N runs touching one lore folder.
    for (const n of [1, 3, MAX_DRAFTS]) {
      expect(draftCountFor(taskById("agent"), n)).toBe(1);
      expect(draftCountFor(taskById("continue"), n)).toBe(1);
    }
    // ...and a hypothetical read-tool task nobody has written yet.
    const custom: TaskDef = { id: "encounter", tools: "read", target: "detached", instructionKey: "x" };
    expect(draftCountFor(custom, MAX_DRAFTS)).toBe(1);
  });
});

describe("totalUsage", () => {
  const withUsage = (inTokens: number, outTokens: number, cost: number): Draft => ({
    id: "x", index: 1, text: "", error: null, done: true, truncated: false,
    usage: { inputTokens: inTokens, outputTokens: outTokens, cost },
  });

  it("sums across drafts and ignores the ones with no usage yet", () => {
    expect(totalUsage([])).toBeNull();
    expect(totalUsage([{ ...withUsage(0, 0, 0), usage: null }])).toBeNull();
    const sum = totalUsage([withUsage(10, 5, 0.1), withUsage(20, 7, 0.25)])!;
    expect(sum.inputTokens).toBe(30);
    expect(sum.outputTokens).toBe(12);
    expect(sum.cost).toBeCloseTo(0.35, 10); // float addition — don't pin the bits
  });
});

describe("runTask — single draft", () => {
  it("makes one request and one draft", async () => {
    await useAiTaskStore.getState().runTask("polish");
    expect(h.streams).toHaveLength(1);
    expect(drafts()).toHaveLength(1);
    expect(drafts()[0].text).toBe("draft-0");
    expect(drafts()[0].done).toBe(true);
    expect(drafts()[0].usage).toEqual({ inputTokens: 10, outputTokens: 5, cost: 0.00002 });
    expect(useAiTaskStore.getState().activeDraftId).toBe(drafts()[0].id);
  });

  it("keeps the agentic path on one draft even when more are requested", async () => {
    h.draftCount = MAX_DRAFTS;
    await useAiTaskStore.getState().runTask("continue");
    expect(h.streams).toHaveLength(0); // agentic path, not streamCompletion
    expect(h.runAgent).toHaveBeenCalledTimes(1);
    expect(drafts()).toHaveLength(1);
    expect(drafts()[0].text).toBe("agent text");
  });
});

describe("runTask — multiple drafts", () => {
  beforeEach(() => { h.draftCount = 3; });

  it("fires one request per draft and keeps their text apart", async () => {
    await useAiTaskStore.getState().runTask("polish");
    expect(h.streams).toHaveLength(3);
    expect(drafts().map((d) => d.text)).toEqual(["draft-0", "draft-1", "draft-2"]);
    expect(drafts().map((d) => d.index)).toEqual([1, 2, 3]);
    expect(drafts().every((d) => d.done)).toBe(true);
  });

  it("gives every draft a distinct id, and new ids on a second run", async () => {
    await useAiTaskStore.getState().runTask("polish");
    const first = drafts().map((d) => d.id);
    expect(new Set(first).size).toBe(3);
    await useAiTaskStore.getState().runTask("polish");
    // Reusing a key across runs would let React treat a new draft as the old one.
    expect(drafts().map((d) => d.id).some((id) => first.includes(id))).toBe(false);
  });

  it("shares one abort signal, so one abort stops every stream", async () => {
    h.behaviour = async (_i, args) => {
      args.onChunk({ text: "partial" });
      await new Promise((resolve) => args.signal.addEventListener("abort", resolve));
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    const run = useAiTaskStore.getState().runTask("polish");
    await vi.waitFor(() => expect(h.streams).toHaveLength(3));
    const signals = h.streams.map((s) => s.signal);
    expect(new Set(signals).size).toBe(1);

    useAiTaskStore.getState().abort();
    await run;
    expect(signals.every((s) => s.aborted)).toBe(true);
    // An abort is not an error, and the partial text is kept.
    expect(useAiTaskStore.getState().error).toBeNull();
    expect(drafts().map((d) => d.text)).toEqual(["partial", "partial", "partial"]);
  });

  it("isolates one draft's failure from the others", async () => {
    h.behaviour = async (index, args) => {
      if (index === 1) throw new Error("content filtered");
      args.onChunk({ text: `draft-${index}` });
      args.onChunk({ done: true, inputTokens: 10, outputTokens: 5 });
    };
    await useAiTaskStore.getState().runTask("polish");

    expect(drafts()[0].text).toBe("draft-0");
    expect(drafts()[1].error).toContain("content filtered");
    expect(drafts()[1].done).toBe(true);
    expect(drafts()[2].text).toBe("draft-2");
    // A partial failure is not a run failure — the usable drafts still stand.
    expect(useAiTaskStore.getState().error).toBeNull();
    // ...and the pane opens on one that has something to show.
    expect(useAiTaskStore.getState().activeDraftId).toBe(drafts()[0].id);
  });

  it("fails the run only when every draft failed", async () => {
    h.behaviour = async () => { throw new Error("upstream down"); };
    await useAiTaskStore.getState().runTask("polish");
    expect(useAiTaskStore.getState().error).toContain("upstream down");
    expect(drafts().every((d) => d.error)).toBe(true);
  });

  it("records one usage row per draft", async () => {
    await useAiTaskStore.getState().runTask("polish");
    // Each draft is a separately billed call; one summed row would misreport it.
    expect(h.persisted).toHaveLength(3);
    expect(h.persisted.every((r) => r.inTokens === 10 && r.outTokens === 5)).toBe(true);
    expect(totalUsage(drafts())).toMatchObject({ inputTokens: 30, outputTokens: 15 });
  });
});

// ── Instruction assembly ─────────────────────────────────────────────────────

/** The `taskInstruction` argument the run passed to assembleContext. */
async function instructionOf(taskId: string, ask?: string): Promise<string> {
  const rag = await import("../context/rag");
  const assemble = vi.mocked(rag.assembleContext);
  assemble.mockClear();
  await useAiTaskStore.getState().runTask(taskId, ask);
  expect(assemble).toHaveBeenCalled();
  return assemble.mock.calls[0][4];
}

/** The `extras` object the run passed to assembleContext. */
async function extrasOf(taskId: string, ask?: string) {
  const rag = await import("../context/rag");
  const assemble = vi.mocked(rag.assembleContext);
  assemble.mockClear();
  await useAiTaskStore.getState().runTask(taskId, ask);
  return assemble.mock.calls[0][5];
}

describe("runTask — current file", () => {
  it("names the current file for a tool-using task", async () => {
    // Without it, a task that browses the project can't tell which of the files
    // it lists is the one it was invoked on.
    expect(await extrasOf("continue")).toMatchObject({
      currentFilePath: "writing/a.md",
    });
  });

  it("omits it for a toolless task", async () => {
    // Such a task can't look at anything else, so the block is dead weight.
    expect((await extrasOf("polish"))?.currentFilePath).toBeUndefined();
  });
});

describe("runTask — instruction", () => {
  it("uses the task's built-in instruction key", async () => {
    // i18n is mocked to echo keys, so this asserts *which* key was resolved.
    expect(await instructionOf("polish")).toBe("ai.instructions.polish");
  });

  it("treats a freeform task's built-in text as a prefix to the author's ask", async () => {
    // This is how a domain task gets its briefing without losing the request.
    expect(await instructionOf("agent", "整理设定")).toBe("ai.instructions.agent\n\n整理设定");
  });

  it("sends only the ask when a freeform task has no built-in text", async () => {
    expect(await instructionOf("custom", "写点什么")).toBe("写点什么");
  });

  it("lets a prompt template override a non-freeform task's instruction", async () => {
    useAiStore.setState({
      prompts: [{ id: "p", name: "mine", scene: "polish", content: "MY POLISH PROMPT" }] as never,
    });
    expect(await instructionOf("polish")).toBe("MY POLISH PROMPT");
  });

  it("lets a prompt template override a freeform task's briefing, keeping the ask", async () => {
    // Freeform tasks used to skip the scene lookup entirely, which made a domain
    // task's prompt the one kind an author couldn't tune.
    useAiStore.setState({
      prompts: [{ id: "p", name: "mine", scene: "agent", content: "MY BRIEFING" }] as never,
    });
    expect(await instructionOf("agent", "整理设定")).toBe("MY BRIEFING\n\n整理设定");
  });
});
