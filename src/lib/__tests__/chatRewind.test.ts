import { describe, expect, it } from "vitest";
import {
  buildCompactedHistory,
  createSessionMeta,
  noteTurnStart,
  planFold,
  type ChatSessionMeta,
} from "../agent/compact";
import { applyRewindCut, planRewind, rewindableTurnIds } from "../agent/rewind";
import type { StreamMessage } from "../ai/types";

const q = (text: string): StreamMessage => ({ role: "user", content: text });
const a = (text: string): StreamMessage => ({ role: "assistant", content: text });
const toolCall = (id: string): StreamMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }],
});
const toolReply = (id: string): StreamMessage => ({ role: "tool", tool_call_id: id, content: "…" });
/** Book one entity's body as carried by `carrier` (recordInjection wants a LoreEntity). */
const book = (meta: ChatSessionMeta, dir: string, carrier: StreamMessage) =>
  meta.injected.set(dir, { version: "v1", coreCarrier: carrier, facetCarriers: new Map() });

type Turn = { id: string; role: "user" | "assistant"; text: string };

/**
 * A session of N exchanges: display turns u1/a1 … and a wire history
 * [system, seed?, q1, a1, q2, …], with per-turn injections ahead of the
 * questions where asked for.
 */
function makeSession(opts: {
  exchanges: number;
  seed?: boolean;
  injectBefore?: number[];
}): { turns: Turn[]; history: StreamMessage[]; meta: ChatSessionMeta; injections: Map<number, StreamMessage> } {
  const meta = createSessionMeta();
  const history: StreamMessage[] = [{ role: "system", content: "system" }];
  const turns: Turn[] = [];
  const injections = new Map<number, StreamMessage>();
  if (opts.seed) {
    const seed = q("【当前知识】seed");
    meta.seedContext = seed;
    history.push(seed);
    book(meta, "/kb/characters/seeded", seed);
  }
  for (let n = 1; n <= opts.exchanges; n++) {
    if (opts.injectBefore?.includes(n)) {
      const inj = q(`【补充资料】for turn ${n}`);
      injections.set(n, inj);
      history.push(inj);
      book(meta, `/kb/items/inj${n}`, inj);
    }
    const question = q(`q${n}`);
    noteTurnStart(meta, question);
    history.push(question, toolCall(`c${n}`), toolReply(`c${n}`), a(`a${n}`));
    turns.push({ id: `u${n}`, role: "user", text: `q${n}` }, { id: `a${n}`, role: "assistant", text: `a${n}` });
  }
  return { turns, history, meta, injections };
}

describe("rewindableTurnIds", () => {
  it("offers every question while nothing has been folded", () => {
    const { turns, meta } = makeSession({ exchanges: 3 });
    expect([...rewindableTurnIds(turns, meta)]).toEqual(["u1", "u2", "u3"]);
  });

  it("never offers an assistant turn", () => {
    const { turns, meta } = makeSession({ exchanges: 2 });
    const ids = rewindableTurnIds(turns, meta);
    expect(ids.has("a1")).toBe(false);
    expect(ids.has("a2")).toBe(false);
  });

  it("withholds folded questions but keeps the first one (a re-seed)", () => {
    const { turns, history, meta } = makeSession({ exchanges: 5 });
    const plan = planFold(history, meta, 100_000, { force: true });
    expect(plan).not.toBeNull();
    buildCompactedHistory(history, meta, plan!, "【历史摘要】…");
    // Forced fold keeps MIN_KEEP_TURNS (2): q4 and q5 are verbatim, q2/q3 are
    // prose inside the summary, q1 re-seeds.
    expect([...rewindableTurnIds(turns, meta)]).toEqual(["u1", "u4", "u5"]);
  });

  it("with no meta (no wire yet) only the first question qualifies", () => {
    const { turns } = makeSession({ exchanges: 2 });
    expect([...rewindableTurnIds(turns, null)]).toEqual(["u1"]);
  });
});

describe("planRewind", () => {
  it("cuts at the target's question message and keeps the display turns before it", () => {
    const { turns, history, meta } = makeSession({ exchanges: 3 });
    const plan = planRewind(turns, history, meta, "u2");
    expect(plan).toEqual({
      kind: "cut",
      turns: turns.slice(0, 2),
      cutAt: history.indexOf(meta.turnStarts[1]),
    });
  });

  it("re-seeds for the first question", () => {
    const { turns, history, meta } = makeSession({ exchanges: 3 });
    expect(planRewind(turns, history, meta, "u1")).toEqual({ kind: "reseed", turns: [] });
  });

  it("refuses unknown ids, assistant turns and folded questions", () => {
    const { turns, history, meta } = makeSession({ exchanges: 5 });
    expect(planRewind(turns, history, meta, "nope")).toBeNull();
    expect(planRewind(turns, history, meta, "a2")).toBeNull();
    const plan = planFold(history, meta, 100_000, { force: true })!;
    const folded = buildCompactedHistory(history, meta, plan, "【历史摘要】…");
    expect(planRewind(turns, folded, meta, "u2")).toBeNull();
    expect(planRewind(turns, folded, meta, "u3")).toBeNull();
    expect(planRewind(turns, folded, meta, "u4")?.kind).toBe("cut");
  });

  it("refuses when the recorded start is not in the history handed to it", () => {
    const { turns, history, meta } = makeSession({ exchanges: 2 });
    // A history that lost its turn-2 question: meta and history disagree.
    const damaged = history.filter((m) => m !== meta.turnStarts[1]);
    expect(planRewind(turns, damaged, meta, "u2")).toBeNull();
  });
});

describe("applyRewindCut", () => {
  it("truncates the history and the turn starts together, leaving the input untouched", () => {
    const { history, meta } = makeSession({ exchanges: 3, seed: true });
    const before = history.length;
    const cutAt = history.indexOf(meta.turnStarts[1]);
    const next = applyRewindCut(history, meta, cutAt);
    expect(history.length).toBe(before);
    expect(next).toEqual(history.slice(0, cutAt));
    expect(next[next.length - 1]).toEqual(a("a1"));
    expect(meta.turnStarts).toHaveLength(1);
    expect(meta.turnStarts[0]).toBe(next[2]);
    expect(meta.seedContext).toBe(next[1]);
  });

  it("evicts ledger entries carried by the removed turns and keeps the prelude's", () => {
    const { history, meta, injections } = makeSession({
      exchanges: 3, seed: true, injectBefore: [3],
    });
    // The injection that preceded q3 rides in turn 2's messages; cutting at q2
    // removes it, and its entry must go with it.
    const next = applyRewindCut(history, meta, history.indexOf(meta.turnStarts[1]));
    expect(next).not.toContain(injections.get(3));
    expect(meta.injected.has("/kb/items/inj3")).toBe(false);
    expect(meta.injected.get("/kb/characters/seeded")?.coreCarrier).toBe(meta.seedContext);
  });

  it("keeps an injection that landed right before the target's own question", () => {
    const { history, meta, injections } = makeSession({ exchanges: 3, injectBefore: [2] });
    const next = applyRewindCut(history, meta, history.indexOf(meta.turnStarts[1]));
    // The material is still in the wire, so the ledger must still say so —
    // otherwise the re-asked question re-injects what the model already has.
    expect(next[next.length - 1]).toBe(injections.get(2));
    expect(meta.injected.get("/kb/items/inj2")?.coreCarrier).toBe(injections.get(2));
  });

  it("resets the document ledger, keeps the summary and the execution state", () => {
    const { history, meta } = makeSession({ exchanges: 5 });
    const plan = planFold(history, meta, 100_000, { force: true })!;
    const folded = buildCompactedHistory(history, meta, plan, "【历史摘要】…");
    meta.lastDocPath = "/p/ch1.md";
    meta.bodyDocPath = "/p/ch1.md";
    meta.state = {
      goal: "g", decisions: [], facts: [], progress: [], files: [], open: [],
    } as unknown as ChatSessionMeta["state"];
    const summary = meta.summary;
    // Cut at the last verbatim turn: the summary stays as the whole past.
    const next = applyRewindCut(folded, meta, folded.indexOf(meta.turnStarts[1]));
    expect(meta.lastDocPath).toBeNull();
    expect(meta.bodyDocPath).toBeNull();
    expect(meta.summary).toBe(summary);
    expect(next).toContain(summary);
    expect(meta.state).not.toBeNull();
    expect(meta.turnStarts).toHaveLength(1);
  });
});
