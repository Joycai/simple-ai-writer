/**
 * The composer's context bar. What is pinned here is that the bar can't lie
 * about the two things it exists to answer: what the context is made of, and
 * how close it is to compaction.
 */
import { describe, expect, it } from "vitest";
import { createSessionMeta, noteTurnStart, recordInjections, COMPACT_TRIGGER } from "../agent/compact";
import { computeContextBreakdown } from "../agent/contextBreakdown";
import { estimateMessagesTokens } from "../ai/tokenEstimate";
import type { StreamMessage } from "../ai/types";
import type { LoreEntity } from "../lore/model";

function entity(dirPath: string): LoreEntity {
  return {
    dirPath,
    name: dirPath,
    category: "characters",
    aliases: [],
    summary: "",
    facets: [],
  } as unknown as LoreEntity;
}

function session() {
  const meta = createSessionMeta();
  const system: StreamMessage = { role: "system", content: "系统提示".repeat(20) };
  const seed: StreamMessage = { role: "user", content: "【设定资料】".repeat(40) };
  const question: StreamMessage = { role: "user", content: "接着写" };
  const answer: StreamMessage = { role: "assistant", content: "好的".repeat(30) };
  meta.seedContext = seed;
  recordInjections(meta, [entity("lore/characters/a")], seed);
  noteTurnStart(meta, question);
  return { meta, system, seed, question, answer, history: [system, seed, question, answer] };
}

describe("computeContextBreakdown", () => {
  it("splits the history by the identities chatMeta records", () => {
    const { meta, history, seed, system } = session();
    const b = computeContextBreakdown(history, meta, 0, 100_000, 128_000);
    const by = Object.fromEntries(b.segments.map((s) => [s.key, s.tokens]));

    expect(by.system).toBe(estimateMessagesTokens([system]));
    expect(by.seed).toBe(estimateMessagesTokens([seed]));
    // The seed carries the injections, so its tokens must not be counted twice.
    expect(by.injected).toBe(0);
    expect(by.conversation).toBeGreaterThan(0);
  });

  it("counts a later turn's injection block separately from the conversation", () => {
    const { meta, history } = session();
    const inj: StreamMessage = { role: "user", content: "【设定资料】".repeat(50) };
    history.push(inj);
    recordInjections(meta, [entity("lore/characters/b")], inj);

    const b = computeContextBreakdown(history, meta, 0, 100_000, 128_000);
    const by = Object.fromEntries(b.segments.map((s) => [s.key, s.tokens]));
    expect(by.injected).toBe(estimateMessagesTokens([inj]));
  });

  it("adds the tool schemas to the fixed cost — the pre-flight gate counts them too", () => {
    const { meta, history } = session();
    const without = computeContextBreakdown(history, meta, 0, 100_000, 128_000);
    const with_ = computeContextBreakdown(history, meta, 3_000, 100_000, 128_000);
    expect(with_.usedTokens - without.usedTokens).toBe(3_000);
  });

  it("accounts for every token: the used segments sum to usedTokens, and the bar to the ceiling", () => {
    const { meta, history } = session();
    const b = computeContextBreakdown(history, meta, 1_200, 100_000, 128_000);
    const used = b.segments.filter((s) => s.key !== "free").reduce((n, s) => n + s.tokens, 0);
    const free = b.segments.find((s) => s.key === "free")!.tokens;
    expect(used).toBe(b.usedTokens);
    expect(used + free).toBe(100_000);
  });

  it("puts the compaction mark where compaction actually fires", () => {
    const { meta, history } = session();
    const b = computeContextBreakdown(history, meta, 0, 100_000, 128_000);
    // Under the ceiling the bar spans the ceiling, so the mark sits at the raw
    // trigger share — not at some fraction of the model's whole window.
    expect(b.compactMarkerPct).toBeCloseTo(COMPACT_TRIGGER * 100, 5);
    expect(b.over).toBe(false);
  });

  it("packs full and slides the mark left once the history outgrows the ceiling", () => {
    const { meta, history } = session();
    const ceiling = 10;
    const b = computeContextBreakdown(history, meta, 0, ceiling, 128_000);
    expect(b.usedTokens).toBeGreaterThan(ceiling);
    expect(b.over).toBe(true);
    expect(b.segments.find((s) => s.key === "free")!.tokens).toBe(0);
    expect(b.compactMarkerPct).toBeCloseTo((ceiling * COMPACT_TRIGGER * 100) / b.usedTokens, 5);
  });

  it("reports the tool cost on a session that has not run yet", () => {
    const b = computeContextBreakdown(null, null, 4_000, 64_000, 128_000);
    expect(b.usedTokens).toBe(4_000);
    expect(b.segments.find((s) => s.key === "free")!.tokens).toBe(60_000);
  });
});
