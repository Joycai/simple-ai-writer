/**
 * 收集器工具（lib/consistency/reviewTools）：引文在工具里校验、条目解析、
 * entries 档的拒收、重发替换。
 */
import { describe, expect, it } from "vitest";
import type { LoreEntity, LoreIndex } from "../lore";
import type { ToolContext } from "../agent/registry";
import { createReviewSink, reportIssueTool, reportPassTool, type ReviewSink } from "../consistency/reviewTools";

const entity = (dirPath: string, name: string, aliases: string[] = []): LoreEntity => ({
  id: name, category: "characters", dirPath, name, aliases, summary: "", avatarPath: null,
  collections: [], mdFiles: [], images: [], facets: [],
});

const index: LoreIndex = {
  characters: [entity("/l/lin", "林辰", ["辰公子"]), entity("/l/su", "苏婉")],
};

const doc = "第一行。\n他以左手按住剑柄，指节抵着雪。\n她抬头。她抬头。\n";

function makeSink(over: Partial<ReviewSink> = {}): { sink: ReviewSink; ctx: ToolContext } {
  const sink = createReviewSink({
    windowIndex: 0, windowFrom: 0, windowText: doc, docText: doc,
    loreIndex: index, categoryIds: ["characters", "world"], allowedDirs: null, runId: "r",
    ...over,
  });
  const ctx = { projectPath: "", loreIndex: index, multimodal: false, reviewSink: sink } as ToolContext;
  return { sink, ctx };
}

const good = {
  severity: "conflict", category: "characters", title: "林辰惯用手",
  quote: "以左手按住剑柄", reference: "林辰 · 惯用手：右手", suggestion: "以右手按住剑柄", entity: "辰公子",
};

describe("report_issue", () => {
  it("records a verified finding with an absolute anchor and a line number", async () => {
    // The window starts 100 chars into a document whose head has no line breaks.
    const { sink, ctx } = makeSink({ windowFrom: 100, docText: "x".repeat(100) + doc });
    const r = await reportIssueTool("c1", good, ctx);
    expect(r.content).toMatch(/^Recorded #1/);
    expect(sink.issues).toHaveLength(1);
    const issue = sink.issues[0];
    expect(issue.entityDirPath).toBe("/l/lin");
    expect(issue.entityName).toBe("林辰");
    expect(issue.anchor).toEqual({ from: 100 + doc.indexOf("以左手"), to: 100 + doc.indexOf("以左手") + 7 });
    expect(issue.line).toBe(2);
    expect(issue.window).toBe(0);
  });

  it("refuses a quote that is not verbatim, and one that is ambiguous", async () => {
    const { sink, ctx } = makeSink();
    const missing = await reportIssueTool("c1", { ...good, quote: "以左手握住剑柄" }, ctx);
    expect(missing.content).toMatch(/not found verbatim/);
    const twice = await reportIssueTool("c2", { ...good, quote: "她抬头。" }, ctx);
    expect(twice.content).toMatch(/occurs 2 times/);
    expect(sink.issues).toHaveLength(0);
  });

  it("refuses an unknown entity and, in entries mode, one outside the pins", async () => {
    const { ctx } = makeSink();
    const unknown = await reportIssueTool("c1", { ...good, entity: "路人" }, ctx);
    expect(unknown.content).toMatch(/no knowledge-base entry is called "路人"/);

    const { sink, ctx: fenced } = makeSink({ allowedDirs: new Set(["/l/su"]) });
    const outside = await reportIssueTool("c2", good, fenced);
    expect(outside.content).toMatch(/outside this check's scope/);
    expect(outside.content).toMatch(/苏婉/);
    expect(sink.issues).toHaveLength(0);
  });

  it("replaces on resend and files unknown categories under timeline", async () => {
    const { sink, ctx } = makeSink();
    await reportIssueTool("c1", good, ctx);
    const r = await reportIssueTool("c2", { ...good, category: "spaceships", title: "改了" }, ctx);
    expect(r.content).toMatch(/replacing the earlier record/);
    expect(r.content).toMatch(/filed under timeline/);
    expect(sink.issues).toHaveLength(1);
    expect(sink.issues[0].title).toBe("改了");
    expect(sink.issues[0].category).toBe("timeline");
  });

  it("fires onChange with the accepted issue", async () => {
    const seen: string[] = [];
    const { ctx } = makeSink({ onChange: (_s, c) => seen.push(c.kind) });
    await reportIssueTool("c1", good, ctx);
    await reportIssueTool("c2", { ...good, quote: "nope" }, ctx);
    expect(seen).toEqual(["issue"]);
  });

  it("says so without a sink", async () => {
    const r = await reportIssueTool("c1", good, { projectPath: "", loreIndex: index, multimodal: false } as ToolContext);
    expect(r.content).toMatch(/^Error: this run cannot record/);
  });
});

describe("report_pass", () => {
  it("records a pass, anchoring the optional quote", async () => {
    const { sink, ctx } = makeSink();
    const r = await reportPassTool("p1", { label: "苏婉武学", entity: "苏婉", quote: "第一行。" }, ctx);
    expect(r.content).toMatch(/^Recorded pass #1/);
    expect(sink.passed[0]).toMatchObject({ label: "苏婉武学", entityDirPath: "/l/su", line: 1 });
  });

  it("keeps the pass when its quote cannot be anchored, and dedupes by label + entity", async () => {
    const { sink, ctx } = makeSink();
    await reportPassTool("p1", { label: "x", quote: "她抬头。" }, ctx);
    await reportPassTool("p2", { label: "x" }, ctx);
    expect(sink.passed).toHaveLength(1);
    expect(sink.passed[0].line).toBeUndefined();
  });
});
