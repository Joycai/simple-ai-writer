import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { StreamOptions } from "../../lib/ai/types";
import type { OutputRecovery } from "../../lib/agent/outputRecovery";

const h = vi.hoisted(() => ({
  save: vi.fn(async (_project: string, _row: OutputRecovery) => {}),
  list: vi.fn(async (_project: string): Promise<OutputRecovery[]> => []),
  remove: vi.fn(async (_project: string, _id: string) => {}),
  stream: vi.fn(async (_opts: StreamOptions) => {}),
  usage: vi.fn(),
}));
vi.mock("../../lib/agent/outputRecovery", async (original) => ({
  ...await original<typeof import("../../lib/agent/outputRecovery")>(),
  saveOutputRecovery: h.save, listOutputRecoveries: h.list, deleteOutputRecovery: h.remove,
}));
vi.mock("../../lib/ai", () => ({ streamCompletion: h.stream }));
vi.mock("../../lib/ai/conn", () => ({
  resolveConn: () => ({ ok: true, model: { id: "m" }, provider: { id: "p" } }),
  connOptions: () => ({ apiKey: "secret", baseUrl: "https://example.test", modelId: "m", standard: "openai" }),
}));
vi.mock("../../lib/ai/configDb", () => ({ conversationalModels: (models: unknown) => models }));
vi.mock("../../lib/ai/usageRow", () => ({ recordUsage: h.usage }));
vi.mock("../../lib/keyStore", () => ({ loadApiKey: async () => "secret" }));
vi.mock("../../lib/context/rag", () => ({ profileSystemPrompt: () => "Write prose" }));
vi.mock("../../lib/context/clock", () => ({ withCurrentTime: (s: string) => s }));
vi.mock("../../i18n", () => ({ default: { t: (s: string) => s } }));
vi.mock("../aiStore", () => ({ useAiStore: { getState: () => ({ models: [], providers: [] }) } }));

import { recoveryRequest, trackOutput, useOutputRecoveryStore } from "../outputRecoveryStore";
const row = (extra: Partial<OutputRecovery> = {}): OutputRecovery => ({
  v: 1, id: "r", source: "task", modelId: "m", request: "Write the report",
  text: "Saved beginning", status: "interrupted", updatedAt: 1, ...extra,
});
beforeEach(() => {
  vi.clearAllMocks();
  h.save.mockResolvedValue(undefined);
  h.list.mockResolvedValue([]);
  useOutputRecoveryStore.setState({ project: "/a", rows: [], running: null, controller: null, error: null });
});
afterEach(() => vi.useRealTimers());

describe("output recovery orchestration", () => {
  it("keeps periodic checkpoints on the original project after switching projects", async () => {
    vi.useFakeTimers();
    const tracker = trackOutput("/a", { modelId: "m", source: "chat", request: "Write" });
    tracker.update("partial");
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.save).toHaveBeenCalledWith("/a", expect.objectContaining({ text: "partial", status: "streaming" }));
    await useOutputRecoveryStore.getState().load("/b");
    tracker.update("partial ending");
    await tracker.finish("interrupted");
    expect(h.save).toHaveBeenLastCalledWith("/a", expect.objectContaining({ text: "partial ending", status: "interrupted" }));
    expect(useOutputRecoveryStore.getState().rows).toEqual([]);
  });
  it("never overwrites the saved prefix on a continuation failure or stores a credential", async () => {
    useOutputRecoveryStore.setState({ rows: [row()] });
    h.stream.mockImplementationOnce(async (opts) => {
      expect(opts.tools).toBeUndefined();
      expect(opts.serverTools).toEqual([]);
      opts.onChunk({ text: " plus more" });
      throw new Error("network lost");
    });
    await useOutputRecoveryStore.getState().resume("r");
    expect(useOutputRecoveryStore.getState().rows[0]).toMatchObject({
      text: "Saved beginning plus more", status: "interrupted",
    });
    expect(JSON.stringify(h.save.mock.calls)).not.toContain("secret");
    expect(useOutputRecoveryStore.getState().running).toBeNull();
  });
  it("resumes at the saved section cursor, saving each boundary and billing each request", async () => {
    useOutputRecoveryStore.setState({ rows: [row({ source: "long", sections: ["one", "two", "three"], nextSection: 1 })] });
    h.stream.mockImplementation(async (opts) => {
      const prompt = String(opts.messages[1].content);
      expect(prompt).not.toContain("Write only section 1:");
      opts.onChunk({ text: " next section" });
      opts.onChunk({ done: true, inputTokens: 100, outputTokens: 20 });
    });
    await useOutputRecoveryStore.getState().resume("r");
    expect(h.stream).toHaveBeenCalledTimes(2);
    expect(h.usage).toHaveBeenCalledTimes(2);
    expect(h.save.mock.calls.map(([, r]) => r.nextSection)).toContain(2);
    expect(useOutputRecoveryStore.getState().rows[0]).toMatchObject({ nextSection: 3, status: "kept" });
  });
  it("does not advance to another paid section if saving the completed section fails", async () => {
    useOutputRecoveryStore.setState({ rows: [row({ source: "long", sections: ["one", "two"], nextSection: 0 })] });
    h.save.mockRejectedValueOnce(new Error("disk full"));
    h.stream.mockImplementation(async (opts) => {
      opts.onChunk({ text: " completed first section" });
      opts.onChunk({ done: true, inputTokens: 10, outputTokens: 5 });
    });
    await useOutputRecoveryStore.getState().resume("r");
    expect(h.stream).toHaveBeenCalledTimes(1);
    expect(useOutputRecoveryStore.getState().rows[0]).toMatchObject({ nextSection: 1, status: "interrupted" });
  });
  it("retains a truncated section without advancing its cursor", async () => {
    useOutputRecoveryStore.setState({ rows: [row({ source: "long", sections: ["one", "two"], nextSection: 0 })] });
    h.stream.mockImplementation(async (opts) => {
      opts.onChunk({ text: " partial section" });
      opts.onChunk({ done: true, inputTokens: 10, outputTokens: 5, truncated: true });
    });
    await useOutputRecoveryStore.getState().resume("r");
    expect(h.stream).toHaveBeenCalledTimes(1);
    expect(useOutputRecoveryStore.getState().rows[0]).toMatchObject({ nextSection: 0, status: "truncated" });
  });
  it("aborts a background continuation on project switch without moving its output", async () => {
    useOutputRecoveryStore.setState({ rows: [row()] });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    h.stream.mockImplementationOnce(async (opts) => {
      opts.onChunk({ text: " in flight" });
      entered();
      await new Promise<void>((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const run = useOutputRecoveryStore.getState().resume("r");
    await started;
    await useOutputRecoveryStore.getState().load("/b");
    await run;
    expect(h.save).toHaveBeenLastCalledWith("/a", expect.objectContaining({ text: "Saved beginning in flight", status: "interrupted" }));
    expect(useOutputRecoveryStore.getState()).toMatchObject({ project: "/b", rows: [], running: null, error: null });
  });
  it("extracts text from multimodal requests while dropping tools, media bytes and the agent briefing", () => {
    const request = recoveryRequest([
      { role: "system", content: "tool briefing" },
      { role: "user", content: [{ type: "text", text: "Write" }, { type: "image_url", image_url: { url: "data:image/png;base64,secretPixels" } }] },
      { role: "assistant", content: null, tool_calls: [] },
      { role: "tool", tool_call_id: "call", content: "tool result" },
    ]);
    expect(request).toBe("user:\nWrite");
  });
});
