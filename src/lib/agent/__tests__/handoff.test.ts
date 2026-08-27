import { describe, expect, it } from "vitest";

import { fallbackBrief, parseHandoffBrief, renderBrief, writerSystemPrompt } from "../handoff";
import { subAgentModel, type SubAgentConfig, type SubAgentKind } from "../subagent";
import type { Model } from "../../ai/configDb";

/** A work order the way a well-behaved model sends one. */
const GOOD = JSON.stringify({
  goal: "写第 12 章的开头",
  kind: "prose",
  constraints: ["林昭还不知道父亲已经死了"],
  style_anchors: ["雪停了。\n他没有回头。"],
  notes: [".ai-writer/tasks/t1/notes/search-东境.md"],
  length: "800-1200 字",
  forbid: ["剧透结局"],
  deliver_to: { path: "chapters/12.md", mode: "append" },
});

describe("parseHandoffBrief", () => {
  it("reads a well-formed order, snake_case included", () => {
    const b = parseHandoffBrief(GOOD);
    expect(b.goal).toBe("写第 12 章的开头");
    expect(b.kind).toBe("prose");
    expect(b.styleAnchors).toHaveLength(1);
    expect(b.notes).toEqual([".ai-writer/tasks/t1/notes/search-东境.md"]);
    expect(b.length).toBe("800-1200 字");
    expect(b.deliverTo).toEqual({ path: "chapters/12.md", mode: "append" });
  });

  it("accepts the camelCase spellings too", () => {
    const b = parseHandoffBrief(
      JSON.stringify({ goal: "g", kind: "answer", styleAnchors: ["x"], deliverTo: { path: "a.md", mode: "create" } }),
    );
    expect(b.styleAnchors).toEqual(["x"]);
    expect(b.deliverTo?.mode).toBe("create");
  });

  /**
   * The author has already paid for the whole main run by the time this parses.
   * Throwing away that work over a malformed field would be the most expensive
   * possible response to the cheapest possible defect.
   */
  it("never throws on garbage — an unparseable order still hands off", () => {
    const b = parseHandoffBrief('{"goal": "写到一半就被截断了');
    expect(b.goal).toBe("");
    expect(b.kind).toBe("prose");
    expect(b.constraints).toEqual([]);
  });

  it("falls back to prose for an unknown kind", () => {
    expect(parseHandoffBrief('{"kind":"poem"}').kind).toBe("prose");
  });

  it("drops non-string entries rather than passing null down as a constraint", () => {
    const b = parseHandoffBrief(JSON.stringify({ goal: "g", kind: "prose", constraints: ["a", null, 3, "  "] }));
    expect(b.constraints).toEqual(["a"]);
  });

  /**
   * A replace_lines with no usable range is not a narrower write — it is an
   * unlocatable one. Dropping the whole intent degrades to "just answer", which
   * the author can act on; keeping it would make the runtime guess at a region
   * of their manuscript.
   */
  it("drops a replace_lines that carries no usable range", () => {
    expect(parseHandoffBrief(JSON.stringify({
      goal: "g", kind: "prose", deliver_to: { path: "a.md", mode: "replace_lines" },
    })).deliverTo).toBeUndefined();
    expect(parseHandoffBrief(JSON.stringify({
      goal: "g", kind: "prose", deliver_to: { path: "a.md", mode: "replace_lines", range: { from: 9, to: 3 } },
    })).deliverTo).toBeUndefined();
    expect(parseHandoffBrief(JSON.stringify({
      goal: "g", kind: "prose", deliver_to: { path: "a.md", mode: "replace_lines", range: { from: 3, to: 9 } },
    })).deliverTo).toEqual({ path: "a.md", mode: "replace_lines", range: { from: 3, to: 9 } });
  });

  it("drops a deliver_to with no path or an unknown mode", () => {
    expect(parseHandoffBrief('{"deliver_to":{"mode":"append"}}').deliverTo).toBeUndefined();
    expect(parseHandoffBrief('{"deliver_to":{"path":"a.md","mode":"delete"}}').deliverTo).toBeUndefined();
  });
});

describe("fallbackBrief", () => {
  /**
   * The degraded path exists because some endpoints downgrade a forced
   * tool_choice to "auto" without saying so. If that silently meant "the main
   * model writes after all", the author's switch would do nothing and report
   * nothing — the one failure this feature must not have.
   */
  it("turns the main model's own prose into a work order", () => {
    const b = fallbackBrief("  把这一段改写得冷一点  ", ["notes/a.md"]);
    expect(b.goal).toBe("把这一段改写得冷一点");
    expect(b.notes).toEqual(["notes/a.md"]);
    expect(b.kind).toBe("prose");
  });
});

describe("renderBrief", () => {
  it("keeps a style anchor's line breaks — they are part of what it shows", () => {
    const out = renderBrief(parseHandoffBrief(GOOD));
    expect(out).toContain("> 雪停了。");
    expect(out).toContain("> 他没有回头。");
  });

  it("omits sections it has nothing for, rather than printing empty headings", () => {
    const out = renderBrief(parseHandoffBrief('{"goal":"g","kind":"answer"}'));
    expect(out).toContain("g");
    // An empty 【材料】 heading is an instruction to consult sources that are
    // not there — the same defect subagentTaskWithRefs was split in two over.
    expect(out.match(/【/g) ?? []).toHaveLength(1);
  });
});

describe("writerSystemPrompt", () => {
  it("appends the inherited layer, and leaves it out when there is none", () => {
    const brief = parseHandoffBrief(GOOD);
    expect(writerSystemPrompt(brief, "你是这个项目的写作搭子。")).toContain("你是这个项目的写作搭子。");
    const bare = writerSystemPrompt(brief, "   ");
    expect(bare).not.toContain("##");
  });
});

// ─── The binding ─────────────────────────────────────────────────────────────

const model = (id: string, patch: Partial<Model>): Model => ({
  id, providerId: "p", modelId: id, name: id, type: "text",
  priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, ...patch,
} as Model);

const subs = (modelId: string | null): Record<SubAgentKind, SubAgentConfig> => ({
  search: { kind: "search", modelId: null, enabled: false },
  vision: { kind: "vision", modelId: null, enabled: false },
  longread: { kind: "longread", modelId: null, enabled: false },
  pdf: { kind: "pdf", modelId: null, enabled: false },
  imagegen: { kind: "imagegen", modelId: null, enabled: false },
  translate: { kind: "translate", modelId: null, enabled: false },
  writer: { kind: "writer", modelId, enabled: modelId !== null },
  retrieval: { kind: "retrieval", modelId: null, enabled: false },
});

describe("subAgentModel(writer)", () => {
  const MODELS = [
    model("m-text", {}),
    model("m-mm", { type: "multimodal" }),
    model("m-image", { type: "image" }),
    model("m-video", { type: "video" }),
    model("m-sakura", { translateFormat: "sakura" } as Partial<Model>),
  ];

  it("accepts any text or multimodal model — there is no capability to require", () => {
    expect(subAgentModel("writer", MODELS, subs("m-text"))?.id).toBe("m-text");
    expect(subAgentModel("writer", MODELS, subs("m-mm"))?.id).toBe("m-mm");
  });

  it("refuses a model that cannot produce prose", () => {
    expect(subAgentModel("writer", MODELS, subs("m-image"))).toBeNull();
    expect(subAgentModel("writer", MODELS, subs("m-video"))).toBeNull();
  });

  /**
   * The one binding that fails silently: a translation model handed a work
   * order does not error, it returns the order back in Chinese — which reads
   * to the author as the writer producing a bad draft rather than as a
   * misconfiguration.
   */
  it("refuses a translation-only model", () => {
    expect(subAgentModel("writer", MODELS, subs("m-sakura"))).toBeNull();
  });

  it("is null while the switch is off, however good the binding", () => {
    const off = { ...subs("m-text"), writer: { kind: "writer" as const, modelId: "m-text", enabled: false } };
    expect(subAgentModel("writer", MODELS, off)).toBeNull();
  });
});
