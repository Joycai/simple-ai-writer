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
 * Trimming also *elides* by that projection: only the media kinds a message's
 * request still carries are taken out, and only their notes written — media
 * the route sends as a note frees nothing and would be gone on the switch back
 * (§4「裁剪不碰这一轮只发说明句的媒体」).
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
import { runAgent, trimHistory, type AgentRuntimeOptions } from "../runtime";
import { admitMedia } from "../../ai/mediaParts";
import { connOptions } from "../../ai/conn";
import { canReadVideo, sentVideoFps } from "../../ai/videoInput";
import { canSeeImages, type Model, type Provider } from "../../ai/configDb";
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

async function historyAttachedUnder(
  model: Model, provider: Provider, { picture = false } = {},
): Promise<StreamMessage[]> {
  const image = {
    kind: "image",
    file: { name: "a.png", path: "/proj/media/a.png", kind: "image" },
    dataUrl: "data:image/png;base64,SU1H",
  } as unknown as AttachedItem;
  const clip = {
    kind: "video",
    file: { name: "a.mp4", path: "/proj/media/a.mp4", kind: "media" },
    dataUrl: "data:video/mp4;base64,Q0xJUA",
    sizeBytes: 3, durationSec: 60, width: 1280, height: 720,
  } as unknown as AttachedItem;
  const built = await buildChatMessage("这段视频里发生了什么？", undefined, picture ? [image, clip] : [clip], {
    allowImages: canSeeImages(model), allowVideo: canReadVideo(model, provider), videoFps: sentVideoFps(model, provider),
  });
  return [
    { role: "system", content: "sys" },
    { role: "user", content: built.content },
    { role: "assistant", content: "一位旅人走进了灯塔。" },
    { role: "user", content: "然后呢？" },
  ];
}

/** One round on `model`, answering at once; what it sent and the events it logged. */
async function runOn(model: Model, provider: Provider, messages: StreamMessage[], ceiling = CEILING) {
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
    inputCeilingTokens: ceiling,
    toolContext: { projectPath: "/p", loreIndex: { characters: [], world: [] } as unknown as LoreIndex, multimodal: true },
    signal: new AbortController().signal,
    onEvent: (e) => void events.push(e),
    onOutputText: () => {},
  };
  await runAgent(opts);
  const round = events.find((e): e is Extract<AgentEvent, { kind: "round-start" }> => e.kind === "round-start")!;
  const clips = sent[0].flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === "video_url") : []));
  const toolResults = sent[0].filter((m) => m.role === "tool").map((m) => String(m.content));
  return { clips, toolResults, estInputTokens: round.estInputTokens, trimmed: events.some((e) => e.kind === "context-trimmed") };
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

/** 百炼's native route has no spelling for a clip: it goes out as a one-line note. Pictures it sends. */
const nativeRoute: Provider = { ...bailian, baseUrl: "https://maas.qianwenaiapi.com/api/v1", apiStandard: "dashscope_compat" };

/** A long tool round after the attachment: what the ceiling actually has to shed. */
function withLongToolRound(history: StreamMessage[]): StreamMessage[] {
  history.splice(3, 0,
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "x".repeat(40_000) },
    { role: "assistant", content: "读完了。" },
  );
  return history;
}

describe("the runtime never trims media its route only sends as a note", () => {

  it("over the ceiling on a route that refuses the clip, a tool result goes and the clip stays for the switch back", async () => {
    const history = withLongToolRound(await historyAttachedUnder(qwen, bailian));
    const clipTurn = structuredClone(history[1]);
    const run = await runOn(qwen, nativeRoute, history, 5_000);
    expect(run.trimmed).toBe(true);
    // Not touched at all — no elision note either: it freed nothing to drop.
    expect(history[1]).toEqual(clipTurn);
    expect(run.toolResults.some((r) => r.length >= 40_000)).toBe(false);
    // Still in the history (the runtime hands streamCompletion the history as it stands).
    expect(run.clips).toHaveLength(1);
  });

});

describe("the ceiling elides exactly the kinds a message's request carries", () => {
  // No row the app builds admits a clip but refuses pictures — `videoInput`
  // holds only for types that see images — so this is the projection itself,
  // over the admission that would say so: the trim must not lean on that rule.
  const clipsOnly = (h: readonly StreamMessage[]) => admitMedia(h, { image: false, video: true, pdf: true }, "as-built");

  it("over the ceiling on a route that sends the clip, it is elided under the clip's note alone", async () => {
    const history = await historyAttachedUnder(qwen, bailian);
    const run = await runOn(qwen, bailian, history, 500);
    expect(run.trimmed).toBe(true);
    expect(run.clips).toEqual([]);
    // The message carried only a clip: it must not be told a picture was dropped too.
    expect(history[1].content).toContain("earlier video clip dropped");
    expect(history[1].content).not.toContain("earlier image dropped");
  });

  it("on a route that refuses the clip, the picture beside it is elided and the clip stays for the switch back", async () => {
    const history = withLongToolRound(await historyAttachedUnder(qwen, bailian, { picture: true }));
    const run = await runOn(qwen, nativeRoute, history, 5_000);
    expect(run.trimmed).toBe(true);
    const parts = history[1].content as { type: string; text?: string }[];
    expect(parts.some((p) => p.type === "image_url")).toBe(false);
    expect(run.clips).toHaveLength(1);
    const note = parts.filter((p) => p.type === "text").pop()!.text;
    expect(note).toContain("earlier image dropped");
    expect(note).not.toContain("earlier video clip dropped");
  });

  it("a picture the route refuses stays beside the elided clip", () => {
    const history: StreamMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "text", text: "图和视频对得上吗？" },
          { type: "image_url", image_url: { url: "data:image/png;base64,SU1H" } },
          { type: "video_url", video_url: { url: "data:video/mp4;base64,Q0xJUA" } },
        ],
      },
      { role: "assistant", content: "对得上。" },
      { role: "user", content: "再看看。" },
    ];
    expect(trimHistory(history, 50, clipsOnly)).toBe(1);
    const parts = history[1].content as { type: string; text?: string }[];
    expect(parts.map((p) => p.type)).toEqual(["text", "image_url", "text"]);
    expect(parts[2].text).toContain("earlier video clip dropped");
    expect(parts[2].text).not.toContain("earlier image dropped");
  });
});
