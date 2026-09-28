/**
 * The agent runtime weighs its history as its requests carry it
 * (docs/feature/video-input.md §4「片段的 fps 也按请求决定」).
 *
 * A clip's `fps` is each request's decision, written by the request's
 * projection; the history keeps the fps it was attached with. The runtime's
 * trimming, thinking budget and checkpoint measure the history before there
 * is a request — so they measure it through the same projection
 * (`mediaProjection`), or a clip attached at 0.5 on 百炼 and sent to 智谱 at the
 * default would read ≈8.9k to the runtime and ≈35.6k to the request's own
 * pre-flight: never trimmed, every round refused.
 *
 * The history is built by the composer's real `buildChatMessage`, attached the
 * way `agentStore` attaches (`sentVideoFps` of the model it was attached under);
 * the transport is the real `connOptions()`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../fs/fileio", () => ({
  readFile: vi.fn(async () => "text body"),
  fileExists: vi.fn(async () => true),
}));
vi.mock("../../ai", () => ({ streamCompletion: vi.fn() }));

import { streamCompletion } from "../../ai";
import { buildChatMessage } from "../chatRefs";
import { runAgent, type AgentRuntimeOptions } from "../runtime";
import { connOptions } from "../../ai/conn";
import { canReadVideo, sentVideoFps } from "../../ai/videoInput";
import type { Model, Provider } from "../../ai/configDb";
import type { StreamMessage, StreamOptions } from "../../ai/types";
import type { AgentEvent } from "../events";
import type { AttachedItem } from "../../lore/aiTask";
import type { LoreIndex } from "../../lore";

const mockStream = vi.mocked(streamCompletion);

const zhipu: Provider = {
  id: "zhipu", name: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiStandard: "openai_compat", platform: "zhipu", createdAt: 0,
};
const bailian: Provider = {
  id: "bailian", name: "百炼", baseUrl: "https://maas.qianwenaiapi.com/compatible-mode/v1", apiStandard: "openai_compat",
  platform: "dashscope", createdAt: 0,
};
const row = (providerId: string, modelId: string): Model => ({
  id: providerId, providerId, modelId, name: modelId, type: "vision",
  priceIn: 0, priceCachedIn: 0, priceOut: 0, enabled: true, videoInput: true, videoFps: 0.5,
});
const glm = row("zhipu", "glm-5v");
const qwen = row("bailian", "qwen3-vl-plus");

/** A 60 s 720p clip: ≈35.6k at the default, ≈8.9k at 0.5. The ceiling sits between. */
const CEILING = 20_000;

async function historyAttachedUnder(model: Model, provider: Provider): Promise<StreamMessage[]> {
  const clip = {
    kind: "video",
    file: { name: "a.mp4", path: "/proj/media/a.mp4", kind: "media" },
    dataUrl: "data:video/mp4;base64,Q0xJUA",
    sizeBytes: 3, durationSec: 60, width: 1280, height: 720,
  } as unknown as AttachedItem;
  const built = await buildChatMessage("这段视频里发生了什么？", undefined, [clip], {
    allowVideo: canReadVideo(model, provider), videoFps: sentVideoFps(model, provider),
  });
  return [
    { role: "system", content: "sys" },
    { role: "user", content: built.content },
    { role: "assistant", content: "一位旅人走进了灯塔。" },
    { role: "user", content: "然后呢？" },
  ];
}

/** One round on `model`, answering at once; what it sent and the events it logged. */
async function runOn(model: Model, provider: Provider, messages: StreamMessage[]) {
  const sent: StreamMessage[][] = [];
  mockStream.mockImplementationOnce(async (o: StreamOptions) => {
    sent.push(structuredClone(o.messages));
    o.onChunk({ text: "好的" } as never);
    o.onChunk({ done: true, inputTokens: 0, outputTokens: 0 } as never);
    return {};
  });
  const events: AgentEvent[] = [];
  const opts: AgentRuntimeOptions = {
    ...connOptions({ model, provider, apiKey: "k" }),
    preset: { id: "test", tools: [], maxRounds: 1, finishPolicy: "force-text" },
    messages,
    inputCeilingTokens: CEILING,
    toolContext: { projectPath: "/p", loreIndex: { characters: [], world: [] } as unknown as LoreIndex, multimodal: true },
    signal: new AbortController().signal,
    onEvent: (e) => void events.push(e),
    onOutputText: () => {},
  };
  await runAgent(opts);
  const round = events.find((e): e is Extract<AgentEvent, { kind: "round-start" }> => e.kind === "round-start")!;
  const clips = sent[0].flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === "video_url") : []));
  return { clips, estInputTokens: round.estInputTokens, trimmed: events.some((e) => e.kind === "context-trimmed") };
}

beforeEach(() => mockStream.mockReset());

describe("the runtime weighs a clip at the fps its request sends", () => {
  it("attached at 0.5 on 百炼, sent to 智谱 at the default: over the ceiling, so the runtime trims it", async () => {
    const run = await runOn(glm, zhipu, await historyAttachedUnder(qwen, bailian));
    expect(run.trimmed).toBe(true);
    expect(run.clips).toEqual([]);
    expect(run.estInputTokens).toBeLessThanOrEqual(CEILING);
  });

  it("attached on 智谱 without an fps, sent to 百炼 at 0.5: under the ceiling, so the clip stays", async () => {
    const run = await runOn(qwen, bailian, await historyAttachedUnder(glm, zhipu));
    expect(run.trimmed).toBe(false);
    expect(run.clips).toHaveLength(1);
    // The round's estimate is the clip at 0.5, not at the fps it was attached with.
    expect(run.estInputTokens).toBeGreaterThan(8_900);
    expect(run.estInputTokens).toBeLessThan(10_000);
  });
});
