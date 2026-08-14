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

import {
  chainCanSeeImages,
  executeDelegate,
  resolveSubAgentConn,
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("chainCanSeeImages", () => {
    it("returns true if main model is multimodal", () => {
      expect(chainCanSeeImages(dummyVisionModel, {
        search: { kind: "search", modelId: null, enabled: false },
        vision: { kind: "vision", modelId: null, enabled: false },
        longread: { kind: "longread", modelId: null, enabled: false },
      })).toBe(true);
    });

    it("returns true if vision subagent is enabled with a modelId", () => {
      expect(chainCanSeeImages(dummyTextModel, defaultSubs)).toBe(true);
    });

    it("returns false if main model is not multimodal and vision subagent is disabled", () => {
      expect(chainCanSeeImages(dummyTextModel, {
        search: { kind: "search", modelId: "m-search", enabled: true },
        vision: { kind: "vision", modelId: "m-vision", enabled: false },
        longread: { kind: "longread", modelId: "m-text", enabled: true },
      })).toBe(false);
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
    });
  });
});
