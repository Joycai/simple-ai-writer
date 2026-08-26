/**
 * The writer handoff, end to end through the tool loop.
 *
 * The behaviours under test are the ones that make the author's switch mean
 * something: that prose is not an accepted ending on a `handoff` preset, that a
 * silently downgraded `tool_choice` still hands off, that the work order never
 * reaches the persistent history, and that the writer's text is what lands in
 * it. See docs/feature/agent/writer-subagent-plan.md.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import type { StreamOptions, StreamMessage } from "../ai/types";
import type { AgentEvent } from "../agent/events";
import type { TaskPreset } from "../agent/presets";
import { runAgent, type AgentRuntimeOptions } from "../agent/runtime";
import { HANDOFF_TOOL_NAME } from "../agent/handoff";
import type { LoreIndex } from "../lore";

vi.mock("../ai", () => ({ streamCompletion: vi.fn() }));
import { streamCompletion } from "../ai";
const mockStream = vi.mocked(streamCompletion);

/** The usage ledger is a SQLite write; this test is about the loop. */
vi.mock("../ai/usage", () => ({ persistUsage: vi.fn(async () => {}) }));

/** The one file `deliver_to` reads, to size an append and locate a range. */
const FILE = { text: "第一行\n第二行\n第三行\n", exists: false };
vi.mock("../fs/fileio", () => ({
  readFile: vi.fn(async () => FILE.text),
  // `create` refuses a path that is already taken, so the default here is the
  // ordinary case: nothing there yet.
  fileExists: vi.fn(async () => FILE.exists),
}));

const LORE_INDEX = { characters: [], world: [] } as unknown as LoreIndex;

const PRESET: TaskPreset = {
  id: "test-handoff",
  tools: ["list_files", "read_file"],
  maxRounds: 4,
  finishPolicy: "handoff",
};

const CONN = {
  provider: { id: "p", name: "P", baseUrl: "http://localhost", apiStandard: "openai" },
  model: { id: "m-writer", modelId: "writer", name: "W", type: "text", providerId: "p" },
  apiKey: "k",
} as never;

interface Harness {
  opts: AgentRuntimeOptions;
  events: AgentEvent[];
  output: string[];
  history: StreamMessage[];
}

function makeOptions(overrides: Partial<AgentRuntimeOptions> = {}): Harness {
  const events: AgentEvent[] = [];
  const output: string[] = [];
  const history: StreamMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "写一段" },
  ];
  return {
    events,
    output,
    history,
    opts: {
      baseUrl: "http://localhost",
      apiKey: "k",
      standard: "openai" as const,
      modelId: "m",
      preset: PRESET,
      messages: history,
      writerSystem: "你是这个项目的写作搭子。",
      toolContext: {
        projectPath: "/p",
        loreIndex: LORE_INDEX,
        multimodal: false,
        resolveSubAgent: async () => CONN,
      },
      signal: new AbortController().signal,
      onEvent: (e: AgentEvent) => void events.push(e),
      onOutputText: (t: string) => void output.push(t),
      ...overrides,
    },
  };
}

/**
 * Every request the mock saw, in order — the writer's sub-run included.
 *
 * `messages` is a *copy*: the runtime mutates one array in place, retracting
 * one-round notices in its `finally` and appending the answer afterwards, so
 * the live reference answers "what does the history look like now", never
 * "what did round N ask for".
 */
const sent: Array<StreamOptions & { snapshot: StreamMessage[] }> = [];

function queueRound(chunks: Array<Record<string, unknown>>): void {
  mockStream.mockImplementationOnce(async (opts: StreamOptions) => {
    sent.push({ ...opts, snapshot: [...opts.messages] });
    for (const c of chunks) opts.onChunk(c as never);
  });
}

const done = { done: true, inputTokens: 1, outputTokens: 1 };

const handoffCall = (args: Record<string, unknown>) => ({
  toolCalls: [{ index: 0, id: "h1", name: HANDOFF_TOOL_NAME, arguments: JSON.stringify(args) }],
});

const last = (snapshots: string[]) => snapshots[snapshots.length - 1];

beforeEach(() => {
  mockStream.mockReset();
  sent.length = 0;
  FILE.exists = false;
});

describe("runAgent — writer handoff", () => {
  it("offers the handoff tool from round 1, alongside the preset's own", async () => {
    queueRound([handoffCall({ goal: "写开头", kind: "prose" }), done]);
    queueRound([{ text: "雪停了。" }, done]);
    const h = makeOptions();
    await runAgent(h.opts);

    const names = (sent[0].tools ?? []).map((t) => t.function.name);
    expect(names).toContain(HANDOFF_TOOL_NAME);
    expect(names).toContain("read_file");
    // Not pinned while it is still a choice: the model decides when it is done
    // gathering, only *whether* the writer writes is taken out of its hands.
    expect(sent[0].toolChoice).toBeUndefined();
  });

  it("streams the writer's text as the run's output, and puts only that in the history", async () => {
    queueRound([handoffCall({ goal: "写开头", kind: "prose", notes: ["notes/a.md"] }), done]);
    queueRound([{ text: "雪停了。" }, { text: "他没有回头。" }, done]);
    const h = makeOptions();
    await runAgent(h.opts);

    expect(last(h.output)).toBe("雪停了。他没有回头。");
    const assistant = h.history.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe("雪停了。他没有回头。");
    // The work order is a wire artefact of one turn, not part of the
    // conversation: left in, it becomes a standing instruction after the next
    // compaction and trains the model to answer with work orders.
    expect(JSON.stringify(h.history)).not.toContain(HANDOFF_TOOL_NAME);
    expect(JSON.stringify(h.history)).not.toContain("写开头");
  });

  it("gives the writer its own two-message context, with the inherited system layer", async () => {
    queueRound([handoffCall({ goal: "写开头", kind: "prose", constraints: ["林昭还不知道"] }), done]);
    queueRound([{ text: "好。" }, done]);
    await runAgent(makeOptions().opts);

    const sub = sent[1].snapshot;
    expect(sub).toHaveLength(2);
    expect(String(sub[0].content)).toContain("你是这个项目的写作搭子。");
    expect(String(sub[1].content)).toContain("写开头");
    expect(String(sub[1].content)).toContain("林昭还不知道");
    // It runs on the bound writer model, not the main one.
    expect(sent[1].modelId).toBe("writer");
  });

  /**
   * The core of the switch. Accepting this round's prose would put the decision
   * back where the author took it from.
   */
  it("refuses to end on prose — it retries with the tool pinned", async () => {
    queueRound([{ text: "这一段我建议这样写：……" }, done]);
    queueRound([handoffCall({ goal: "改写这一段", kind: "prose" }), done]);
    queueRound([{ text: "雪停了。" }, done]);
    const h = makeOptions();
    await runAgent(h.opts);

    expect(sent[1].toolChoice).toEqual({ type: "function", function: { name: HANDOFF_TOOL_NAME } });
    expect((sent[1].tools ?? []).map((t) => t.function.name)).toEqual([HANDOFF_TOOL_NAME]);
    expect(last(h.output)).toBe("雪停了。");
    // The rejected draft was never the answer, so it is not in the transcript
    // and it never reached the author as final text.
    expect(JSON.stringify(h.history)).not.toContain("我建议这样写");
  });

  it("retracts the pin notice after the request, like every other one-round nudge", async () => {
    queueRound([{ text: "草稿" }, done]);
    queueRound([handoffCall({ goal: "g", kind: "prose" }), done]);
    queueRound([{ text: "成品" }, done]);
    const h = makeOptions();
    await runAgent(h.opts);

    const nudge = i18n.t("ai.instructions.handoffRound");
    expect(sent[1].snapshot.some((m) => m.content === nudge)).toBe(true);
    expect(h.history.some((m) => m.content === nudge)).toBe(false);
  });

  /**
   * Several endpoints downgrade a forced tool_choice to "auto" without saying
   * so (lib/ai/openai.ts toolChoiceFor). If that silently meant "the main model
   * writes after all", the switch would do nothing and report nothing.
   */
  it("hands off anyway when the pinned round still returns prose, and says it degraded", async () => {
    queueRound([{ text: "草稿一" }, done]);
    queueRound([{ text: "把这段写得冷一点" }, done]);
    queueRound([{ text: "雪停了。" }, done]);
    const h = makeOptions();
    await runAgent(h.opts);

    const ev = h.events.find((e) => e.kind === "handoff");
    expect(ev && "degraded" in ev && ev.degraded).toBe(true);
    expect(String(sent[2].snapshot[1].content)).toContain("把这段写得冷一点");
    expect(last(h.output)).toBe("雪停了。");
  });

  /**
   * The writer runs on the author's *other* model at its own price, and this
   * result is priced with the **main** model's rate by the caller
   * (agentStore.sendChat → `costFor(model, …)` → one `chat` row). Adding the
   * two bills together here would charge the writer's tokens twice: once on
   * the `subagent:writer` row runWriterHandoff already wrote, and again at the
   * assistant's price. Settings → 用量 sums every row, so that inflation lands
   * squarely on the number the author uses to judge whether the writer is
   * worth it.
   *
   * Same rule as executeDelegate, and the separated figure is not lost — it
   * rides the nested `run-done`, which is exactly where logModel.sumTokens
   * looks for a subagent's share.
   */
  it("keeps the writer's tokens out of the run's total, on their own run-done", async () => {
    queueRound([handoffCall({ goal: "g", kind: "prose" }), { done: true, inputTokens: 100, outputTokens: 20 }]);
    queueRound([{ text: "x" }, { done: true, inputTokens: 7, outputTokens: 3 }]);
    const h = makeOptions();
    const res = await runAgent(h.opts);
    expect(res.inputTokens).toBe(100);
    expect(res.outputTokens).toBe(20);

    const nested = h.events.find((e) => e.kind === "run-done" && e.parentStep);
    expect(nested).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });

  /**
   * A misconfigured writer produces no reply — and the runtime must NOT invent
   * one. App text pushed into the turn would be the one thing the signature
   * design forbids: a paragraph in the reading column that nobody's model
   * wrote. The reason travels on the event, and the surface renders it outside
   * the prose (设计稿 12 · 屏 1a 轮 4).
   */
  it("leaves the turn empty when the writer cannot run, and reports why on the event", async () => {
    queueRound([handoffCall({ goal: "g", kind: "prose" }), done]);
    const h = makeOptions({
      toolContext: {
        projectPath: "/p",
        loreIndex: LORE_INDEX,
        multimodal: false,
        resolveSubAgent: async () => ({ error: "没有绑定模型" }),
      },
    });
    await runAgent(h.opts);

    expect(last(h.output) ?? "").toBe("");
    const ev = h.events.find((e) => e.kind === "handoff-done");
    expect(ev && "error" in ev && ev.error).toBe("没有绑定模型");
    // Nothing was said, so nothing joins the transcript — an empty assistant
    // message is also what Anthropic rejects outright.
    expect(h.history.some((m) => m.role === "assistant")).toBe(false);
  });

  it("still runs its ordinary tool rounds first", async () => {
    queueRound([{ toolCalls: [{ index: 0, id: "t1", name: "list_files", arguments: "{}" }] }, done]);
    queueRound([handoffCall({ goal: "g", kind: "prose" }), done]);
    queueRound([{ text: "成品" }, done]);
    const h = makeOptions();
    await runAgent(h.opts);
    expect(h.events.some((e) => e.kind === "tool-step" && e.step.name === "list_files")).toBe(true);
    expect(last(h.output)).toBe("成品");
  });

  // ── deliver_to: the bytes never pass through a model ──

  /**
   * The point of the whole mechanism. `create_file(path, content)` makes the
   * caller type the text out; if the main model did that it would pay for the
   * writer's output a second time and — the part that actually matters — would
   * silently reword it on the way through. Here the runtime moves the bytes and
   * the author still approves the write.
   */
  it("turns the writer's output into an approval card without any model re-typing it", async () => {
    queueRound([
      handoffCall({ goal: "g", kind: "prose", deliver_to: { path: "chapters/12.md", mode: "create" } }),
      done,
    ]);
    queueRound([{ text: "雪停了。" }, done]);
    const proposals: unknown[] = [];
    const h = makeOptions({
      toolContext: {
        projectPath: "/p",
        loreIndex: LORE_INDEX,
        multimodal: false,
        resolveSubAgent: async () => CONN,
        requestApproval: async (proposal) => {
          proposals.push(proposal);
          return { approved: true };
        },
      },
    });
    await runAgent(h.opts);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "create",
      path: "/p/chapters/12.md",
      content: "雪停了。",
    });
    const ev = h.events.find((e) => e.kind === "handoff-done");
    expect(ev && "delivered" in ev && ev.delivered).toEqual({ path: "/p/chapters/12.md", approved: true });
  });

  /**
   * `createEntry` throws on a name that is taken, so a card offered for one is
   * a card the author approves and then watches fail. Refused before it is
   * shown instead — and the writer's text still stands as the turn's reply,
   * which is what makes refusing cheap.
   */
  it("refuses a create onto an existing path instead of offering a doomed card", async () => {
    FILE.exists = true;
    queueRound([
      handoffCall({ goal: "g", kind: "prose", deliver_to: { path: "chapters/12.md", mode: "create" } }),
      done,
    ]);
    queueRound([{ text: "雪停了。" }, done]);
    const proposals: unknown[] = [];
    const h = makeOptions({
      toolContext: {
        projectPath: "/p",
        loreIndex: LORE_INDEX,
        multimodal: false,
        resolveSubAgent: async () => CONN,
        requestApproval: async (proposal) => {
          proposals.push(proposal);
          return { approved: true };
        },
      },
    });
    await runAgent(h.opts);

    expect(proposals).toHaveLength(0);
    expect(last(h.output)).toBe("雪停了。");
    const ev = h.events.find((e) => e.kind === "handoff-done");
    expect(ev && "delivered" in ev && ev.delivered).toEqual({
      path: "chapters/12.md", approved: false,
    });
  });

  /**
   * `createEntry` normalizes an extensionless name to `.md`. Doing it before
   * the proposal is what stops the card, the collision check and the file that
   * lands from naming three different paths.
   */
  it("normalizes an extensionless create path the way createEntry will", async () => {
    queueRound([
      handoffCall({ goal: "g", kind: "prose", deliver_to: { path: "chapters/第五章", mode: "create" } }),
      done,
    ]);
    queueRound([{ text: "雪停了。" }, done]);
    const proposals: unknown[] = [];
    const h = makeOptions({
      toolContext: {
        projectPath: "/p",
        loreIndex: LORE_INDEX,
        multimodal: false,
        resolveSubAgent: async () => CONN,
        requestApproval: async (proposal) => {
          proposals.push(proposal);
          return { approved: true };
        },
      },
    });
    await runAgent(h.opts);

    expect(proposals[0]).toMatchObject({ kind: "create", path: "/p/chapters/第五章.md" });
  });

  it("sizes an append from the file on disk", async () => {
    queueRound([
      handoffCall({ goal: "g", kind: "prose", deliver_to: { path: "chapters/12.md", mode: "append" } }),
      done,
    ]);
    queueRound([{ text: "第四行\n" }, done]);
    const proposals: unknown[] = [];
    await runAgent(makeOptions({
      toolContext: {
        projectPath: "/p", loreIndex: LORE_INDEX, multimodal: false,
        resolveSubAgent: async () => CONN,
        requestApproval: async (p) => { proposals.push(p); return { approved: true }; },
      },
    }).opts);
    expect(proposals[0]).toMatchObject({
      kind: "append", content: "第四行\n", originalChars: FILE.text.length,
    });
  });

  /**
   * The welding guard `rewrite_lines` carries: a line range includes its last
   * line's terminator, so a replacement without one runs the next line onto
   * this text. The writer is not asked to remember that.
   */
  it("locates a line range and keeps its terminator", async () => {
    queueRound([
      handoffCall({
        goal: "g", kind: "prose",
        deliver_to: { path: "a.md", mode: "replace_lines", range: { from: 2, to: 2 } },
      }),
      done,
    ]);
    queueRound([{ text: "改过的第二行" }, done]);
    const proposals: Record<string, unknown>[] = [];
    await runAgent(makeOptions({
      toolContext: {
        projectPath: "/p", loreIndex: LORE_INDEX, multimodal: false,
        resolveSubAgent: async () => CONN,
        requestApproval: async (p) => { proposals.push(p as never); return { approved: true }; },
      },
    }).opts);
    expect(proposals[0]).toMatchObject({
      kind: "edit", find: "第二行\n", replace: "改过的第二行\n", occurrences: 1,
    });
  });

  it("does not write outside the project, and says so", async () => {
    queueRound([
      handoffCall({ goal: "g", kind: "prose", deliver_to: { path: "../../etc/passwd", mode: "create" } }),
      done,
    ]);
    queueRound([{ text: "x" }, done]);
    const proposals: unknown[] = [];
    const h = makeOptions({
      toolContext: {
        projectPath: "/p", loreIndex: LORE_INDEX, multimodal: false,
        resolveSubAgent: async () => CONN,
        requestApproval: async (p) => { proposals.push(p); return { approved: true }; },
      },
    });
    await runAgent(h.opts);
    expect(proposals).toHaveLength(0);
    const ev = h.events.find((e) => e.kind === "handoff-done");
    expect(ev && "delivered" in ev && ev.delivered?.approved).toBe(false);
    // The text is still the turn's answer — a refused write is not a lost draft.
    expect(last(h.output)).toBe("x");
  });

  it("keeps the text in the conversation when the author rejects the write", async () => {
    queueRound([
      handoffCall({ goal: "g", kind: "prose", deliver_to: { path: "a.md", mode: "create" } }),
      done,
    ]);
    queueRound([{ text: "雪停了。" }, done]);
    const h = makeOptions({
      toolContext: {
        projectPath: "/p", loreIndex: LORE_INDEX, multimodal: false,
        resolveSubAgent: async () => CONN,
        requestApproval: async () => ({ approved: false, reason: "语气不对" }),
      },
    });
    await runAgent(h.opts);
    expect(last(h.output)).toBe("雪停了。");
    const ev = h.events.find((e) => e.kind === "handoff-done");
    expect(ev && "delivered" in ev && ev.delivered?.approved).toBe(false);
  });
});