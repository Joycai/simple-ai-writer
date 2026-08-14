/**
 * Regression tests for the PR-C review findings: what a delegation names, what
 * it refuses up front, and what the subagent is actually told.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = new Map<string, string>();
vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => { if (!fs.has(p)) throw new Error("ENOENT"); return fs.get(p)!; }),
  writeFile: vi.fn(async (p: string, c: string) => void fs.set(p, c)),
  fileExists: vi.fn(async (p: string) => fs.has(p) || [...fs.keys()].some((k) => k.startsWith(p + "/"))),
  makeDir: vi.fn(async () => {}),
  removeDir: vi.fn(async () => {}),
  readDir: vi.fn(async () => []),
}));
vi.mock("../../ai/usage", () => ({ persistUsage: vi.fn(async () => {}) }));

const sent: { messages: { role: string; content: unknown }[] }[] = [];
vi.mock("../../ai", () => ({
  streamCompletion: vi.fn(async (o: { messages: { role: string; content: unknown }[]; onChunk: (c: unknown) => void }) => {
    sent.push({ messages: o.messages });
    o.onChunk({ text: "结论正文" });
    o.onChunk({ done: true, inputTokens: 10, outputTokens: 5, cachedTokens: 0 });
  }),
}));

import { executeDelegate } from "../subagent";
import { createTaskWorkspace, loadTaskDoc } from "../taskWorkspace";
import type { ToolContext } from "../registry";

const MODEL = {
  id: "m2", providerId: "pv", modelId: "x", name: "N", type: "text",
  priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true,
  serverTools: ["web_search"],
} as const;

function makeCtx(overrides: Partial<ToolContext> = {}, model: object = MODEL): ToolContext {
  const handle = createTaskWorkspace("/p", "mdl-main");
  return {
    projectPath: "/p", loreIndex: {}, multimodal: false,
    taskWorkspace: handle,
    signal: new AbortController().signal,
    onNestedEvent: () => {},
    resolveSubAgent: async () => ({
      provider: { id: "pv", name: "Prov", baseUrl: "", apiStandard: "openai" },
      model, apiKey: "k",
    }),
    ...overrides,
  } as ToolContext;
}

const call = (args: object) => ({ id: "c1", name: "delegate", arguments: JSON.stringify(args) });

describe("delegate naming and preconditions", () => {
  beforeEach(() => { fs.clear(); sent.length = 0; });

  it("does not name the task workspace after the delegated instruction", async () => {
    const ctx = makeCtx();
    const instruction = "查证东境三大家族的世系与他们和禁忌魔法之间的历史关联，尽量给出可核对的来源";
    await executeDelegate(call({ kind: "search", task: instruction }), ctx);

    const doc = (await loadTaskDoc("/p", ctx.taskWorkspace!.taskId!))!;
    // The H1 must not become the paragraph-long instruction — naming the task
    // belongs to task_plan.
    expect(doc.body).not.toContain(instruction);
    expect(doc.body.split("\n")[0]).not.toMatch(/禁忌魔法/);
  });

  it("gives the note a filename, not a sentence", async () => {
    const ctx = makeCtx();
    const instruction = "查证东境三大家族的世系与他们和禁忌魔法之间的历史关联，尽量给出可核对的来源";
    const res = await executeDelegate(call({ kind: "search", task: instruction }), ctx);

    const notePath = [...fs.keys()].find((k) => k.includes("/notes/"))!;
    const stem = notePath.split("/").pop()!.replace(/\.md$/, "");
    expect(stem.startsWith("search-")).toBe(true);
    expect([...stem].length).toBeLessThanOrEqual(30);
    // The full instruction still survives, as the note's own title.
    expect(fs.get(notePath)).toContain(instruction.slice(0, 40));
    expect(res.content).toContain(stem);
  });

  it("omits the references section entirely when there are no refs", async () => {
    await executeDelegate(call({ kind: "search", task: "查一下" }), makeCtx());
    const user = String(sent[0].messages.find((m) => m.role === "user")!.content);
    // An empty 「参考资源」 heading tells the subagent to consult sources that
    // do not exist.
    expect(user).not.toMatch(/参考资源|References/);
    expect(user).toContain("查一下");
  });

  it("includes the references section when refs are given", async () => {
    await executeDelegate(
      call({ kind: "longread", task: "读一读", refs: ["writing/ch1.md"] }),
      makeCtx({}, { ...MODEL, serverTools: undefined }),
    );
    const user = String(sent[0].messages.find((m) => m.role === "user")!.content);
    expect(user).toContain("writing/ch1.md");
  });

  it("refuses a vision subagent bound to a text-only model, before spending a round", async () => {
    const ctx = makeCtx({}, { ...MODEL, type: "text" });
    const res = await executeDelegate(call({ kind: "vision", task: "看图" }), ctx);

    expect(res.content).toMatch(/^Error/);
    expect(res.content).toContain("text-only");
    expect(sent).toHaveLength(0);        // no request was made
    expect([...fs.keys()]).toHaveLength(0); // and no workspace was created
  });

  it("still refuses a search subagent whose model cannot browse", async () => {
    const ctx = makeCtx({}, { ...MODEL, serverTools: undefined });
    const res = await executeDelegate(call({ kind: "search", task: "查" }), ctx);
    expect(res.content).toMatch(/^Error/);
    expect(sent).toHaveLength(0);
  });
});
