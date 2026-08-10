/**
 * Session persistence round-trip: the meta's object-identity references
 * (turn starts, seed, summary, ledger carriers) survive JSON via indices and
 * come back pointing into the restored history. Anything malformed restores
 * as null — a fresh session beats a half-restored history that breaks the
 * tool-call protocol on the next turn.
 */
import { describe, expect, it } from "vitest";
import {
  deserializeChatSession,
  maxTurnId,
  serializeChatSession,
  sessionPreview,
  type ChatSnapshot,
  type PersistedTurn,
} from "../agent/chatSession";
import { createSessionMeta, noteTurnStart, recordInjections, segmentHistory } from "../agent/compact";
import type { LoreEntity } from "../lore";
import type { StreamMessage } from "../ai/types";

function makeSnapshot(): ChatSnapshot {
  const meta = createSessionMeta();
  const seed: StreamMessage = { role: "user", content: "【设定资料】…" };
  const summaryMsg: StreamMessage = { role: "user", content: "【历史摘要】…" };
  const q1: StreamMessage = { role: "user", content: "q1" };
  const injMsg: StreamMessage = { role: "user", content: "inj" };
  const q2: StreamMessage = { role: "user", content: "q2" };
  const history: StreamMessage[] = [
    { role: "system", content: "sys" },
    seed,
    summaryMsg,
    q1,
    {
      role: "assistant", content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c1", content: "chapter text" },
    { role: "assistant", content: "a1" },
    injMsg,
    q2,
    { role: "assistant", content: "a2" },
  ];
  meta.seedContext = seed;
  meta.summary = summaryMsg;
  meta.summaryText = "早前摘要";
  meta.lastDocPath = "/proj/writing/ch2.md";
  noteTurnStart(meta, q1);
  noteTurnStart(meta, q2);
  recordInjections(
    meta,
    [{ name: "Aria", aliases: [], dirPath: "/lore/aria", summary: "" } as unknown as LoreEntity],
    injMsg,
  );

  const turns: PersistedTurn[] = [
    { id: "t3", role: "user", text: "q1", log: [], at: 1 },
    { id: "t4", role: "assistant", text: "a1", log: [], at: 2, images: ["/p/img.png"] },
  ];
  return { turns, history, meta, usage: { inputTokens: 10, outputTokens: 5, cost: 0.01 } };
}

describe("chat session round-trip", () => {
  it("re-links every identity reference into the restored history", () => {
    const snap = makeSnapshot();
    const restored = deserializeChatSession(serializeChatSession(snap))!;
    expect(restored).not.toBeNull();

    const h = restored.history;
    expect(h).toEqual(snap.history);
    // Identity, not just equality: the restored meta points at the restored
    // array's own objects, so segmentation and compaction keep working.
    expect(restored.meta.seedContext).toBe(h[1]);
    expect(restored.meta.summary).toBe(h[2]);
    expect(restored.meta.turnStarts).toEqual([h[3], h[8]]);
    expect(restored.meta.injected.get("/lore/aria")!.carrier).toBe(h[7]);
    expect(restored.meta.summaryText).toBe("早前摘要");
    expect(restored.meta.lastDocPath).toBe("/proj/writing/ch2.md");
    expect(restored.usage).toEqual(snap.usage);
    expect(restored.turns).toEqual(snap.turns);

    // The restored session segments exactly like the live one did.
    const { prelude, turns } = segmentHistory(h, restored.meta);
    expect(prelude).toHaveLength(3);
    expect(turns).toHaveLength(2);
    expect(turns[0].messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
  });

  it("drops references that no longer resolve instead of guessing", () => {
    const snap = makeSnapshot();
    const json = serializeChatSession(snap);
    const data = JSON.parse(json);
    data.meta.turnStarts[1] = 999; // out of range
    data.meta.injected[0][2] = -5;
    const restored = deserializeChatSession(JSON.stringify(data))!;
    expect(restored.meta.turnStarts).toHaveLength(1);
    expect(restored.meta.injected.size).toBe(0);
  });

  it("returns null for garbage, wrong versions, and missing fields", () => {
    expect(deserializeChatSession("not json")).toBeNull();
    expect(deserializeChatSession("42")).toBeNull();
    expect(deserializeChatSession(JSON.stringify({ v: 2 }))).toBeNull();
    expect(deserializeChatSession(JSON.stringify({ v: 1, turns: [] }))).toBeNull();
  });
});

describe("sessionPreview", () => {
  it("uses the first question, collapsed and clipped", () => {
    const turns: PersistedTurn[] = [
      { id: "t1", role: "user", text: "  帮我\n核对   指标  ", log: [], at: 1 },
    ];
    expect(sessionPreview(turns)).toBe("帮我 核对 指标");
    expect(sessionPreview([])).toBe("");
    const long: PersistedTurn[] = [
      { id: "t1", role: "user", text: "设".repeat(80), log: [], at: 1 },
    ];
    expect(sessionPreview(long)).toHaveLength(60);
    expect(sessionPreview(long).endsWith("…")).toBe(true);
  });
});

describe("maxTurnId", () => {
  it("finds the highest numeric suffix and ignores foreign ids", () => {
    const turns: PersistedTurn[] = [
      { id: "t3", role: "user", text: "", log: [], at: 1 },
      { id: "t17", role: "assistant", text: "", log: [], at: 2 },
      { id: "x9", role: "user", text: "", log: [], at: 3 },
    ];
    expect(maxTurnId(turns)).toBe(17);
    expect(maxTurnId([])).toBe(0);
  });
});
