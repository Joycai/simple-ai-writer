/**
 * Merging two channels that are one (docs/feature/channel-model-route-plan.md §5.3).
 * The only operation that makes a model id disappear — so what it detects, what
 * it folds, and the order its statements run in are each pinned.
 */
import { describe, expect, it } from "vitest";
import type { Model, Provider } from "../configDb";
import { mergeCandidates, mergeStatements, planMerge } from "../channelMerge";
import { normalizeChannel, providerFor, routeProfileOf } from "../routes";

const channel = (id: string, baseUrl: string, apiStandard: Provider["apiStandard"], extra: Partial<Provider> = {}) =>
  normalizeChannel({ id, name: id, baseUrl, apiStandard, createdAt: 0, ...extra });

const minimaxChat = channel("mm", "https://api.minimaxi.com", "openai_compat");
const minimaxClaude = channel("mmc", "https://api.minimaxi.com/anthropic", "anthropic_compat");
const other = channel("ds", "https://api.deepseek.com", "openai_compat");

const model = (id: string, providerId: string, modelId: string, extra: Partial<Model> = {}): Model => ({
  id, providerId, modelId, name: modelId, type: "text", priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, ...extra,
});

describe("mergeCandidates", () => {
  const keys = new Map([["mm", "sk-1"], ["mmc", "sk-1"], ["ds", "sk-1"]]);

  it("pairs one platform, one host, one key, disjoint protocols", () => {
    const found = mergeCandidates([minimaxChat, minimaxClaude, other], keys);
    expect(found.map((c) => [c.keep.id, c.absorb.id])).toEqual([["mm", "mmc"]]);
  });

  it("never pairs two keys — a wrong guess moves a model to another bill", () => {
    expect(mergeCandidates([minimaxChat, minimaxClaude], new Map([["mm", "sk-1"], ["mmc", "sk-2"]]))).toEqual([]);
  });

  it("never pairs a shared protocol", () => {
    const twin = channel("mm2", "https://api.minimaxi.com", "openai_compat");
    expect(mergeCandidates([minimaxChat, twin], new Map([["mm", "k"], ["mm2", "k"]]))).toEqual([]);
  });

  it("pairs the two official OpenAI rows the old presets made", () => {
    const chat = channel("o1", "", "openai");
    const resp = channel("o2", "", "openai_responses");
    expect(mergeCandidates([chat, resp], new Map([["o1", "k"], ["o2", "k"]]))).toHaveLength(1);
  });
});

describe("planMerge", () => {
  const models = [
    model("a1", "mm", "MiniMax-M3", { temperature: 0.2, serverTools: ["web_search"] }),
    model("b1", "mmc", "MiniMax-M3", { temperature: 1, maxOutput: 8192, thinkingCategory: "minimax" }),
    model("b2", "mmc", "MiniMax-M2.7"),
  ];
  const plan = planMerge(minimaxChat, minimaxClaude, models);

  it("gives the kept channel both routes, its own primary first", () => {
    expect(plan.channel.endpoints!.map((e) => e.family)).toEqual(["openai", "anthropic"]);
    expect(plan.channel.baseUrl).toBe("https://api.minimaxi.com");
  });

  it("folds a same-id model into the kept row as its second route", () => {
    const kept = plan.upserts.find((m) => m.id === "a1")!;
    // The kept row's own fields and id survive; the absorbed row's become a route.
    expect(kept.temperature).toBe(0.2);
    expect(kept.routes?.anthropic).toEqual(routeProfileOf(models[1]));
    expect(plan.deletes).toEqual(["b1"]);
    expect(plan.remap).toEqual({ b1: "a1" });
  });

  it("moves any other model across, pinned to the protocol it spoke", () => {
    const moved = plan.upserts.find((m) => m.id === "b2")!;
    expect(moved.providerId).toBe("mm");
    expect(moved.activeRoute).toBe("anthropic");
    // Seen through its route, the moved model still talks to the Anthropic path.
    expect(providerFor(moved, [plan.channel])!.baseUrl).toBe("https://api.minimaxi.com/anthropic");
  });

  it("writes the channel, then the models, then the deletes", () => {
    const stmts = mergeStatements(plan, "mmc");
    expect(stmts[0].sql).toMatch(/INSERT INTO providers/);
    expect(stmts.slice(1, 1 + plan.upserts.length).every((x) => /INTO models/.test(x.sql))).toBe(true);
    expect(stmts[stmts.length - 1]).toEqual({ sql: "DELETE FROM providers WHERE id = ?", values: ["mmc"] });
  });

  it("换渠道的模型不动迁移标记：绑了组的盖章，没绑的沿用原来那一行的", () => {
    // 夹具里的模型都没绑组；绑上第一个，两条分支都要真的走到。
    const bound = { ...plan, upserts: plan.upserts.map((m, i) => (i === 0 ? { ...m, feeGroupId: "g1" } : m)) };
    expect(bound.upserts.some((m) => m.feeGroupId)).toBe(true);
    expect(bound.upserts.some((m) => !m.feeGroupId)).toBe(true);
    const models = mergeStatements(bound, "mmc").filter((x) => /INTO models/.test(x.sql));
    expect(models.length).toBe(bound.upserts.length);
    for (const x of models) {
      const m = bound.upserts.find((u) => u.id === x.values[0])!;
      const last = x.values[x.values.length - 1];
      if (m.feeGroupId) expect(last).toBe(1);
      else {
        expect(x.sql).toMatch(/\(SELECT fee_migrated FROM models WHERE id = \?\)\)\s*$/);
        expect(last).toBe(m.id);
      }
    }
  });
});
