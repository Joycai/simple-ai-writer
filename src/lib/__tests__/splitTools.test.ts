/**
 * The facet-split collector tools.
 *
 * These exist to move the split off "one hand-written JSON object in the reply
 * text" and onto tool arguments the endpoint decodes — so the properties worth
 * pinning are the ones that make *piecewise* submission safe: a resend under
 * the same title must replace rather than duplicate (that is the whole recovery
 * path when the output cap cuts a call in half), and a call that would erase
 * the entry must come back as a readable error instead of an empty core.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({ default: { t: (key: string) => key } }));

import {
  createSplitSink,
  splitCoreTool,
  splitFacetTool,
  type SplitSink,
} from "../agent/splitTools";
import type { ToolContext } from "../agent/registry";

function ctxWith(sink?: SplitSink): ToolContext {
  return { projectPath: "", loreIndex: {}, multimodal: false, splitSink: sink };
}

const FACET = { title: "战甲形象", content: "她换上战甲。", keys: ["战甲", "铠甲"] };

describe("split_core", () => {
  it("records the core body", async () => {
    const sink = createSplitSink();
    const res = await splitCoreTool("c1", { content: "  核心正文  " }, ctxWith(sink));
    expect(sink.core).toBe("核心正文");
    expect(res.content).toContain("Core card recorded");
  });

  it("refuses an empty core rather than letting Apply erase the entry", async () => {
    const sink = createSplitSink();
    const res = await splitCoreTool("c1", { content: "   " }, ctxWith(sink));
    expect(res.content).toMatch(/^Error:/);
    expect(sink.core).toBeUndefined();
  });

  it("replaces on a second call", async () => {
    const sink = createSplitSink();
    await splitCoreTool("c1", { content: "第一版" }, ctxWith(sink));
    const res = await splitCoreTool("c2", { content: "第二版" }, ctxWith(sink));
    expect(sink.core).toBe("第二版");
    expect(res.content).toContain("replacing");
  });
});

describe("split_facet", () => {
  it("appends one facet with defaults filled in", async () => {
    const sink = createSplitSink();
    await splitFacetTool("f1", FACET, ctxWith(sink));
    expect(sink.facets).toEqual([
      { title: "战甲形象", keys: ["战甲", "铠甲"], group: null, priority: 0, content: "她换上战甲。" },
    ]);
  });

  it("keeps group and priority when given", async () => {
    const sink = createSplitSink();
    await splitFacetTool("f1", { ...FACET, group: " outfit ", priority: 2 }, ctxWith(sink));
    expect(sink.facets[0].group).toBe("outfit");
    expect(sink.facets[0].priority).toBe(2);
  });

  it("replaces a resent title instead of duplicating it", async () => {
    // The recovery path: the cap cut the first attempt short, the runtime
    // dropped it and said so, and the model sends the facet again.
    const sink = createSplitSink();
    await splitFacetTool("f1", { ...FACET, content: "短版本" }, ctxWith(sink));
    const res = await splitFacetTool("f2", { ...FACET, content: "完整版本" }, ctxWith(sink));
    expect(sink.facets).toHaveLength(1);
    expect(sink.facets[0].content).toBe("完整版本");
    expect(res.content).toContain("replaced");
  });

  it("rejects a facet with no content or no title", async () => {
    const sink = createSplitSink();
    expect((await splitFacetTool("f1", { title: "x" }, ctxWith(sink))).content).toMatch(/^Error:/);
    expect((await splitFacetTool("f2", { content: "y" }, ctxWith(sink))).content).toMatch(/^Error:/);
    expect(sink.facets).toHaveLength(0);
  });

  it("tells the model when a facet has no trigger keys", async () => {
    // Silently accepting it would produce a facet that never injects — the one
    // failure the author cannot see on the review card.
    const sink = createSplitSink();
    const res = await splitFacetTool("f1", { ...FACET, keys: [] }, ctxWith(sink));
    expect(res.content).toContain("no trigger keys");
    expect(sink.facets).toHaveLength(1);
  });

  it("drops non-string keys and trims the rest", async () => {
    const sink = createSplitSink();
    await splitFacetTool("f1", { ...FACET, keys: [" 战甲 ", 42, "", "披挂"] }, ctxWith(sink));
    expect(sink.facets[0].keys).toEqual(["战甲", "披挂"]);
  });
});

describe("progress reporting", () => {
  it("fires onChange after every accepted call, not on a rejected one", async () => {
    const onChange = vi.fn();
    const sink = createSplitSink(onChange);
    await splitCoreTool("c1", { content: "核心" }, ctxWith(sink));
    await splitFacetTool("f1", FACET, ctxWith(sink));
    await splitFacetTool("f2", { title: "空的" }, ctxWith(sink));
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe("without a sink", () => {
  it("refuses instead of throwing away the model's work silently", async () => {
    expect((await splitCoreTool("c1", { content: "x" }, ctxWith())).content).toMatch(/^Error:/);
    expect((await splitFacetTool("f1", FACET, ctxWith())).content).toMatch(/^Error:/);
  });
});
