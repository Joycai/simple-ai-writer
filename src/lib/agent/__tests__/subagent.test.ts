import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model, Provider } from "../../ai/configDb";
import type { ToolContext } from "../registry";
import type { ToolCall } from "../tools";

const mockRunAgent = vi.fn();
const mockPersistUsage = vi.fn();
const mockWriteTaskNote = vi.fn();

vi.mock("../runtime", () => ({
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

vi.mock("../../ai/usage", () => ({
  persistUsage: (...args: unknown[]) => mockPersistUsage(...args),
}));

vi.mock("../taskWorkspace", () => ({
  writeTaskNote: (...args: unknown[]) => mockWriteTaskNote(...args),
}));

const mockFileExists = vi.fn();
const mockReadBinaryFile = vi.fn();

vi.mock("../../fs/fileio", () => ({
  fileExists: (...args: unknown[]) => mockFileExists(...args),
  readBinaryFile: (...args: unknown[]) => mockReadBinaryFile(...args),
}));

import {
  chainCanSeeImages,
  DELEGATE_KINDS,
  executeDelegate,
  resolveSubAgentConn,
  resolveVisionConn,
  subAgentModel,
  SUBAGENT_KINDS,
  type SubAgentConfig,
  type SubAgentKind,
} from "../subagent";

describe("subagent", () => {
  const dummyTextModel: Model = {
    id: "m-text",
    providerId: "p1",
    modelId: "m-text",
    name: "Text Model",
    type: "text",
    priceIn: 1,
    priceCachedIn: 0,
    priceOut: 2,
    enabled: true,
    contextSize: 8000,
  };

  const dummyVisionModel: Model = {
    id: "m-vision",
    providerId: "p1",
    modelId: "m-vision",
    name: "Vision Model",
    type: "multimodal",
    priceIn: 1,
    priceCachedIn: 0,
    priceOut: 2,
    enabled: true,
    contextSize: 8000,
  };

  const dummySearchModel: Model = {
    id: "m-search",
    providerId: "p1",
    modelId: "m-search",
    name: "Search Model",
    type: "text",
    priceIn: 1,
    priceCachedIn: 0,
    priceOut: 2,
    enabled: true,
    contextSize: 8000,
    serverTools: ["web_search"],
  };

  const dummyProvider: Provider = {
    id: "p1",
    name: "Provider 1",
    baseUrl: "https://api.openai.com",
    apiStandard: "openai",
    createdAt: 0,
  };

  const defaultSubs: Record<SubAgentKind, SubAgentConfig> = {
    search: { kind: "search", modelId: "m-search", enabled: true },
    vision: { kind: "vision", modelId: "m-vision", enabled: true },
    longread: { kind: "longread", modelId: "m-text", enabled: true },
    pdf: { kind: "pdf", modelId: null, enabled: false },
    imagegen: { kind: "imagegen", modelId: null, enabled: false },
    translate: { kind: "translate", modelId: null, enabled: false },
    writer: { kind: "writer", modelId: null, enabled: false },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const NO_SUBS = {
    search: { kind: "search", modelId: null, enabled: false },
    vision: { kind: "vision", modelId: null, enabled: false },
    longread: { kind: "longread", modelId: null, enabled: false },
  } as Record<SubAgentKind, SubAgentConfig>;
  const ALL_MODELS = [dummyVisionModel, dummyTextModel];


  describe("the translate kind", () => {
    const sakura: Model = {
      ...dummyTextModel,
      id: "m-sakura",
      name: "Sakura 14B",
      serverTools: undefined,
      translateFormat: "sakura",
    };
    const bound = (modelId: string | null): Record<SubAgentKind, SubAgentConfig> => ({
      ...defaultSubs,
      translate: { kind: "translate", modelId, enabled: modelId !== null },
    });

    it("is a subagent but never a delegate kind", () => {
      // 不变量 1 的守卫。Sakura holds no conversation: asked "你是什么模型" it
      // paraphrases the question back instead of answering, and a delegated
      // task description would come back as its own translation. Putting it in
      // DELEGATE_KINDS would compile and fail only at run time, quietly.
      expect(SUBAGENT_KINDS).toContain("translate");
      expect(DELEGATE_KINDS).not.toContain("translate" as never);
    });

    it("resolves only a model that declares a translation format", () => {
      expect(subAgentModel("translate", [sakura], bound("m-sakura"))).toBe(sakura);
      // The same binding pointed at an ordinary model resolves to nothing —
      // the failure it prevents is silent, not loud: a general model handed
      // Sakura's fixed template answers something plausible.
      expect(subAgentModel("translate", [dummyTextModel], bound("m-text"))).toBeNull();
    });

    it("is not resolvable while disabled or unbound", () => {
      expect(subAgentModel("translate", [sakura], bound(null))).toBeNull();
      expect(
        subAgentModel("translate", [sakura], {
          ...defaultSubs,
          translate: { kind: "translate", modelId: "m-sakura", enabled: false },
        }),
      ).toBeNull();
    });

    it("does not leak into the other kinds' resolution", () => {
      // A Sakura model is `type: "text"`, so nothing about its type stops it
      // being bound to longread — only the declaration does, and only via
      // conversationalModels in the UI. Here we assert the runtime half: the
      // kinds keep their own preconditions and translate's does not travel.
      const subs: Record<SubAgentKind, SubAgentConfig> = {
        ...defaultSubs,
        longread: { kind: "longread", modelId: "m-sakura", enabled: true },
      };
      // longread has no capability gate, so this DOES resolve — which is
      // exactly why the pickers must never offer it (01-execution-plan.md §1
      // 不变量 2). Documented here so the gap is deliberate, not forgotten.
      expect(subAgentModel("longread", [sakura], subs)).toBe(sakura);
    });
  });

  describe("chainCanSeeImages", () => {
    it("returns true if main model is multimodal", () => {
      expect(chainCanSeeImages(dummyVisionModel, NO_SUBS, ALL_MODELS)).toBe(true);
    });

    it("returns true if the vision subagent is bound to a multimodal model", () => {
      expect(chainCanSeeImages(dummyTextModel, defaultSubs, ALL_MODELS)).toBe(true);
    });

    it("returns false when the vision subagent is bound to a TEXT model", () => {
      // The settings pane warns about this binding but still allows it. Trusting
      // "enabled + bound" would light up an image control and then post a
      // picture to a model that cannot read one.
      const subs = {
        ...defaultSubs,
        vision: { kind: "vision", modelId: "m-text", enabled: true },
      } as Record<SubAgentKind, SubAgentConfig>;
      expect(chainCanSeeImages(dummyTextModel, subs, ALL_MODELS)).toBe(false);
    });

    it("returns false if main model is not multimodal and vision subagent is disabled", () => {
      const subs = {
        search: { kind: "search", modelId: "m-search", enabled: true },
        vision: { kind: "vision", modelId: "m-vision", enabled: false },
        longread: { kind: "longread", modelId: "m-text", enabled: true },
      } as Record<SubAgentKind, SubAgentConfig>;
      expect(chainCanSeeImages(dummyTextModel, subs, ALL_MODELS)).toBe(false);
    });

    it("handles no active model at all", () => {
      expect(chainCanSeeImages(undefined, NO_SUBS, ALL_MODELS)).toBe(false);
      expect(chainCanSeeImages(undefined, defaultSubs, ALL_MODELS)).toBe(true);
    });
  });

  describe("resolveSubAgentConn", () => {
    it("resolves connection when subagent is enabled and model exists", async () => {
      const loadKey = vi.fn(async () => "test-key");
      const res = await resolveSubAgentConn(
        "search",
        [dummySearchModel],
        [dummyProvider],
        defaultSubs,
        loadKey,
      );

      expect("provider" in res).toBe(true);
      if ("provider" in res) {
        expect(res.model.id).toBe("m-search");
        expect(res.apiKey).toBe("test-key");
      }
    });

    it("returns error if subagent is disabled", async () => {
      const loadKey = vi.fn(async () => "test-key");
      const res = await resolveSubAgentConn(
        "search",
        [dummySearchModel],
        [dummyProvider],
        { ...defaultSubs, search: { kind: "search", modelId: "m-search", enabled: false } },
        loadKey,
      );

      expect("error" in res).toBe(true);
    });

    it("reports a missing API key as configuration, not as a subagent failure", async () => {
      // An empty string used to be substituted here, so the request went out
      // keyless and came back 401 — which the parent model read as "the
      // subagent is broken" rather than "paste a key".
      const res = await resolveSubAgentConn(
        "search",
        [dummySearchModel],
        [dummyProvider],
        defaultSubs,
        async () => null,
      );
      expect("error" in res).toBe(true);
      expect((res as { error: string }).error).toMatch(/API key/i);

      const ok = await resolveSubAgentConn(
        "search",
        [dummySearchModel],
        [dummyProvider],
        defaultSubs,
        async () => "k",
      );
      expect("error" in ok).toBe(false);
    });
  });

  describe("resolveVisionConn", () => {
    const loadKey = () => vi.fn(async () => "key-p1");

    it("prefers the vision subagent even when the active model could do it", async () => {
      // The switch has to mean something for a multimodal author too, and the
      // agent's tool routing already strips the image tools from the main model
      // — the two must agree on what "enabled" does.
      const res = await resolveVisionConn(
        ALL_MODELS, [dummyProvider], "m-vision", defaultSubs, loadKey(),
      );
      expect("error" in res).toBe(false);
      expect((res as { model: { id: string } }).model.id).toBe("m-vision");
    });

    it("uses the active model when no usable vision subagent exists", async () => {
      const res = await resolveVisionConn(
        ALL_MODELS, [dummyProvider], "m-vision", NO_SUBS, loadKey(),
      );
      expect("error" in res).toBe(false);
      expect((res as { model: { id: string } }).model.id).toBe("m-vision");
    });

    it("ignores a vision subagent bound to a text model and falls through", async () => {
      const subs = {
        ...defaultSubs,
        vision: { kind: "vision", modelId: "m-text", enabled: true },
      } as Record<SubAgentKind, SubAgentConfig>;
      const res = await resolveVisionConn(
        ALL_MODELS, [dummyProvider], "m-vision", subs, loadKey(),
      );
      expect("error" in res).toBe(false);
      expect((res as { model: { id: string } }).model.id).toBe("m-vision");
    });

    it("explains why instead of returning null when nothing can see", async () => {
      const res = await resolveVisionConn(
        [dummyTextModel], [dummyProvider], "m-text", NO_SUBS, loadKey(),
      );
      expect("error" in res).toBe(true);
      expect((res as { error: string }).error).toBeTruthy();
    });

    it("reports a missing key as configuration, not as an empty key", async () => {
      // `?? ""` here produced a 401 the author had to reverse-engineer.
      const res = await resolveVisionConn(
        ALL_MODELS, [dummyProvider], "m-vision", NO_SUBS, vi.fn(async () => null),
      );
      expect("error" in res).toBe(true);
    });
  });

  describe("executeDelegate", () => {
    const makeCtx = (overrides?: Partial<ToolContext>): ToolContext => ({
      projectPath: "/test-project",
      loreIndex: { byCategory: {}, totalCount: 0 } as any,
      multimodal: false,
      signal: new AbortController().signal,
      onNestedEvent: vi.fn(),
      taskWorkspace: {
        taskId: "task-123",
        dir: "/test-project/.ai-writer/tasks/task-123",
        status: { state: "in-progress", currentStep: null, totalSteps: null },
        ensure: vi.fn(async () => ({ taskId: "task-123", isNew: false })),
        markStep: vi.fn(),
        updatePlan: vi.fn(),
      } as any,
      resolveSubAgent: vi.fn(async (kind: SubAgentKind) => {
        if (kind === "search") return { provider: dummyProvider, model: dummySearchModel, apiKey: "k" };
        if (kind === "vision") return { provider: dummyProvider, model: dummyVisionModel, apiKey: "k" };
        return { provider: dummyProvider, model: dummyTextModel, apiKey: "k" };
      }),
      ...overrides,
    });

    it("fails if surface cannot run subagents (missing ctx fields)", async () => {
      const call: ToolCall = { id: "c1", name: "delegate", arguments: JSON.stringify({ kind: "search", task: "find info" }) };
      const res = await executeDelegate(call, { projectPath: "/p", loreIndex: {} as any, multimodal: false });
      expect(res.content).toContain("cannot run subagents");
    });

    it("refuses kind=imagegen and points at the image tools instead", async () => {
      // The imagegen subagent is real, but its interface is generate_image /
      // edit_image (approval-carded) — an image model cannot hold the
      // conversational sub-run delegate dispatches.
      const call: ToolCall = { id: "c1", name: "delegate", arguments: JSON.stringify({ kind: "imagegen", task: "draw a cat" }) };
      const res = await executeDelegate(call, makeCtx());
      expect(res.content).toContain("generate_image");
    });

    it("fails if search subagent model has no web_search serverTools configured", async () => {
      const ctx = makeCtx({
        resolveSubAgent: vi.fn(async () => ({
          provider: dummyProvider,
          model: dummyTextModel, // no serverTools
          apiKey: "k",
        })),
      });
      const call: ToolCall = { id: "c1", name: "delegate", arguments: JSON.stringify({ kind: "search", task: "find info" }) };
      const res = await executeDelegate(call, ctx);
      expect(res.content).toContain("has no server-side web_search enabled");
    });

    it("runs child subagent, records note and returns summary with path", async () => {
      mockRunAgent.mockImplementation(async (opts) => {
        opts.onOutputText("Here is the detailed research report on topic X.");
        return { rounds: 1, inputTokens: 50, outputTokens: 100, cachedTokens: 0, outcome: "success" };
      });
      mockWriteTaskNote.mockResolvedValueOnce({
        slug: "search-find-facts",
        title: "find facts",
        path: ".ai-writer/tasks/task-123/notes/search-find-facts.md",
        size: 200,
      });

      const ctx = makeCtx();
      const call: ToolCall = {
        id: "c1",
        name: "delegate",
        arguments: JSON.stringify({ kind: "search", task: "find facts", refs: ["doc1.md"] }),
      };

      const res = await executeDelegate(call, ctx);

      expect(mockRunAgent).toHaveBeenCalledTimes(1);
      expect(mockPersistUsage).toHaveBeenCalledWith(
        "/test-project",
        "m-search",
        50,
        100,
        expect.any(Number),
        "subagent:search",
        0,
      );
      expect(mockWriteTaskNote).toHaveBeenCalledTimes(1);
      expect(res.content).toContain(".ai-writer/tasks/task-123/notes/search-find-facts.md");
      expect(res.content).toContain("Here is the detailed research report on topic X.");

      // What the specialist spent, on the record the author can actually see.
      // The DB row above is the permanent ledger but is invisible until someone
      // opens Settings → 用量, and a delegation is exactly the step whose cost
      // is being decided about now. `parentStep` keeps it out of the parent
      // run's totals, which count the parent's model only.
      expect(ctx.onNestedEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "run-done",
          inputTokens: 50,
          outputTokens: 100,
          parentStep: "c1",
        }),
      );
    });

    it("fails if the pdf subagent's model has no pdfInput declared", async () => {
      const ctx = makeCtx({
        resolveSubAgent: vi.fn(async () => ({
          provider: dummyProvider,
          model: dummyTextModel, // no pdfInput
          apiKey: "k",
        })),
      });
      const call: ToolCall = {
        id: "c1", name: "delegate",
        arguments: JSON.stringify({ kind: "pdf", task: "读这份文件", refs: ["docs/spec.pdf"] }),
      };
      const res = await executeDelegate(call, ctx);
      expect(res.content).toContain("not declared to accept PDF files");
    });

    it("fails a pdf delegation that carries no .pdf refs", async () => {
      const pdfModel: Model = { ...dummyTextModel, id: "m-pdf", name: "Qwen3.8-Max", pdfInput: true };
      const ctx = makeCtx({
        resolveSubAgent: vi.fn(async () => ({ provider: dummyProvider, model: pdfModel, apiKey: "k" })),
      });
      const call: ToolCall = {
        id: "c1", name: "delegate",
        arguments: JSON.stringify({ kind: "pdf", task: "读这份文件", refs: ["docs/spec.md"] }),
      };
      const res = await executeDelegate(call, ctx);
      expect(res.content).toContain("at least one .pdf path");
    });

    it("attaches the PDF as a file content part ahead of the instruction", async () => {
      mockFileExists.mockResolvedValue(true);
      // "ABC" — small but real bytes, so the data URL is verifiable end to end.
      mockReadBinaryFile.mockResolvedValue(new Uint8Array([65, 66, 67]));
      mockRunAgent.mockImplementation(async (opts) => {
        opts.onOutputText("文档要点如下。");
        return { rounds: 1, inputTokens: 10, outputTokens: 20, cachedTokens: 0, outcome: "success" };
      });
      mockWriteTaskNote.mockResolvedValueOnce({
        slug: "pdf-x", title: "x", path: ".ai-writer/tasks/task-123/notes/pdf-x.md", size: 10,
      });

      const pdfModel: Model = { ...dummyTextModel, id: "m-pdf", name: "Qwen3.8-Max", pdfInput: true };
      const ctx = makeCtx({
        resolveSubAgent: vi.fn(async () => ({ provider: dummyProvider, model: pdfModel, apiKey: "k" })),
      });
      const call: ToolCall = {
        id: "c1", name: "delegate",
        arguments: JSON.stringify({ kind: "pdf", task: "总结这份规格书", refs: ["docs/spec.pdf"] }),
      };

      const res = await executeDelegate(call, ctx);
      expect(res.content).toContain("pdf-x.md");

      const runOpts = mockRunAgent.mock.calls[0][0];
      const userMsg = runOpts.messages[1];
      expect(Array.isArray(userMsg.content)).toBe(true);
      expect(userMsg.content[0]).toEqual({
        type: "file",
        file: { file_data: "data:application/pdf;base64,QUJD", filename: "spec.pdf" },
      });
      // The instruction rides behind the files, matching the vendor's order.
      expect(userMsg.content[1].type).toBe("text");
      expect(userMsg.content[1].text).toContain("总结这份规格书");
    });

    it("refuses a pdf ref that escapes the project or hides in .ai-writer", async () => {
      const pdfModel: Model = { ...dummyTextModel, id: "m-pdf", name: "Qwen3.8-Max", pdfInput: true };
      const ctx = makeCtx({
        resolveSubAgent: vi.fn(async () => ({ provider: dummyProvider, model: pdfModel, apiKey: "k" })),
      });
      for (const ref of ["../outside/secret.pdf", "/test-project/.ai-writer/backups/x.pdf"]) {
        const call: ToolCall = {
          id: "c1", name: "delegate",
          arguments: JSON.stringify({ kind: "pdf", task: "读", refs: [ref] }),
        };
        const res = await executeDelegate(call, ctx);
        expect(res.content).toContain("outside the project");
      }
    });

    it("reports no cost for a subagent that failed before running", async () => {
      const ctx = makeCtx({
        resolveSubAgent: vi.fn(async () => ({ error: "no key" })),
      });
      const call: ToolCall = { id: "c1", name: "delegate", arguments: JSON.stringify({ kind: "search", task: "x" }) };
      await executeDelegate(call, ctx);
      expect(ctx.onNestedEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "run-done" }),
      );
    });
  });
});
