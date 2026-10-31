import { afterEach, describe, expect, it, vi } from "vitest";
import { generateImage } from "../image";
import { captureImageEvidence, type ImageEvidence } from "../imageEvidence";
import { buildUsageRow } from "../usageRow";
import { ZERO_FEE } from "../feeGroup";
import { PNG_B64 } from "./imageFixtures";

const conn = { baseUrl: "https://example.test/v1", apiKey: "k", modelId: "renamed-image", standard: "openai" as const };
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("image audit regression", () => {
  it("Grok aliases use JSON edits and never multipart or size", async () => {
    const fetch = vi.fn(async () => json({ data: [{ b64_json: PNG_B64 }] }));
    vi.stubGlobal("fetch", fetch);
    await generateImage({ ...conn, dialect: "grok-imagine" }, { prompt: "edit", images: ["data:image/png;base64," + PNG_B64], size: "1024x1024" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/images/edits");
    expect(JSON.parse(init.body as string)).toMatchObject({ image: { type: "image_url" } });
    expect(JSON.parse(init.body as string)).not.toHaveProperty("size");
  });

  it("cancellation during download keeps the first image and reported usage", async () => {
    const abort = new AbortController();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (++calls === 1) return json({ data: [{ url: "https://cdn/1" }, { url: "https://cdn/2" }], usage: { input_tokens: 7, output_tokens: 9 } });
      if (calls === 2) return new Response(Uint8Array.from(atob(PNG_B64), c => c.charCodeAt(0)), { headers: { "Content-Type": "image/png" } });
      abort.abort(); throw new DOMException("Stopped", "AbortError");
    }));
    const settled = vi.fn(async () => {});
    const result = await generateImage(conn, { prompt: "two", signal: abort.signal, onSettled: settled });
    expect(result.images).toHaveLength(1);
    expect(result.evidence).toMatchObject({ outcome: "cancelled", generatedImages: 2, usage: { inputTokens: 7, outputTokens: 9 } });
    expect(settled).toHaveBeenCalledOnce();
  });

  it("invalid bytes fail delivery but still settle reported usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [{ b64_json: "aGk=" }], usage: { input_tokens: 7, output_tokens: 9 } })));
    const settled = vi.fn(async () => {});
    await expect(generateImage(conn, { prompt: "x", onSettled: settled })).rejects.toThrow(/dimensions/);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ images: [], evidence: expect.objectContaining({ outcome: "failed", usage: { inputTokens: 7, outputTokens: 9 } }) }));
  });

  it("an internal size fallback reports the size actually sent", async () => {
    let count = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ++count === 1
      ? new Response(JSON.stringify({ error: { param: "size", message: "invalid size" } }), { status: 400 })
      : json({ data: [{ b64_json: PNG_B64 }] })));
    const result = await generateImage(conn, { prompt: "edit", images: ["data:image/png;base64," + PNG_B64], size: "2048x2048" });
    expect(result.evidence?.spec.size).toBe("1024x1024");
  });

  it("uses reported image count and preserves Ark pixel-proxy usage without token billing", () => {
    const e: ImageEvidence = { outcome: "complete", spec: { size: "4K" } };
    captureImageEvidence(e, { usage: { generated_images: 3, output_tokens: 999, size: "2K" } }, { ...conn, route: "ark" });
    expect(e).toMatchObject({ generatedImages: 3, spec: { size: "2K" }, rawUsage: { output_tokens: 999 } });
    expect(e.usage).toBeUndefined();
  });

  it("prices disjoint image/text buckets without charging totals again", () => {
    const row = buildUsageRow({ model: { id: "m", fee: { ...ZERO_FEE, inputPrice: 1, cachePrice: 0, outputPrice: 2,
      imageTokenPrices: { input: 10, cache: 5, output: 30 } } }, task: "image",
      usageEvidence: { outcome: "complete", source: "reported", fields: { inputTokens: 100, cachedTokens: 20, outputTokens: 50 },
        media: { outcome: "complete", spec: {}, modalities: { image: { inputTokens: 60, cachedTokens: 10, outputTokens: 40 }, text: { inputTokens: 40, cachedTokens: 10, outputTokens: 10 } } } } });
    expect(row.costUsd).toBeCloseTo((30 + 500 + 50 + 20 + 1200) / 1e6);
    expect(row.costIncomplete).toBe(false);
  });

  it("Responses stream keeps final images when the connection closes early", async () => {
    const event = { type: "response.output_item.done", item: { type: "image_generation_call", result: PNG_B64 } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "Content-Type": "text/event-stream" } })));
    const result = await generateImage({ ...conn, route: "responses", options: { responsesModel: "driver", stream: true } }, { prompt: "x" });
    expect(result.images).toHaveLength(1);
    expect(result.evidence?.outcome).toBe("failed");
  });
});

it("uses trusted zero quotes and ignores arbitrary vendor cost fields", () => {
  const trusted: ImageEvidence = { outcome: "complete", spec: {} };
  captureImageEvidence(trusted, { usage: { cost: 0 } }, { ...conn, platform: "orcarouter", baseUrl: "https://api.orcarouter.ai/v1", standard: "openai_compat" });
  expect(trusted.reportedCost).toBe(0);
  const untrusted: ImageEvidence = { outcome: "complete", spec: {} };
  captureImageEvidence(untrusted, { usage: { cost: 100 } }, conn);
  expect(untrusted.reportedCost).toBeUndefined();
});

it("rejects unsupported Seedream modes before making a billed request", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(generateImage({ ...conn, route: "ark", dialect: "seedream-5-pro", options: { seedreamMode: "group" } }, { prompt: "x" })).rejects.toThrow(/group/);
  await expect(generateImage({ ...conn, route: "ark", dialect: "seedream-5-pro", options: { seedreamMode: "layers" } }, { prompt: "x" })).rejects.toThrow(/exactly one/);
  expect(fetch).not.toHaveBeenCalled();
});

it("Seedream grouping sends one request with a bounded set size and preserves reported count", async () => {
  const fetch = vi.fn(async () => json({ data: [{ b64_json: PNG_B64 }, { b64_json: PNG_B64 }], usage: { generated_images: 2 } }));
  vi.stubGlobal("fetch", fetch);
  const result = await generateImage({ ...conn, route: "ark", dialect: "seedream-5-lite", options: { seedreamMode: "group", webSearch: true } }, { prompt: "x", n: 4 });
  expect(fetch).toHaveBeenCalledOnce();
  const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  expect(body).toMatchObject({ sequential_image_generation: "auto", sequential_image_generation_options: { max_images: 4 }, tools: [{ type: "web_search" }] });
  expect(result.evidence?.generatedImages).toBe(2);
});

it("MiniMax checks its status envelope and counts generated images", async () => {
  const fetch = vi.fn(async () => json({ base_resp: { status_code: 0 }, metadata: { success_count: "1" }, data: { image_urls: ["data:image/png;base64," + PNG_B64] } }));
  vi.stubGlobal("fetch", fetch);
  const result = await generateImage({ ...conn, route: "minimax" }, { prompt: "x" });
  expect((fetch.mock.calls[0] as unknown as [string])[0]).toContain("/image_generation");
  expect(result.evidence?.generatedImages).toBe(1);
});

it("Images edit SSE distinguishes previews from completed output", async () => {
  const events = [
    { type: "image_edit.partial_image", b64_json: PNG_B64, partial_image_index: 0 },
    { type: "image_edit.completed", b64_json: PNG_B64, size: "1024x1024", usage: { input_tokens: 5, output_tokens: 8 } },
  ];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } })));
  const preview = vi.fn();
  const result = await generateImage({ ...conn, options: { stream: true } }, { prompt: "edit", images: ["data:image/png;base64," + PNG_B64], onPreview: preview });
  expect(preview).toHaveBeenCalledOnce();
  expect(result.images).toHaveLength(1);
  expect(result.evidence).toMatchObject({ outcome: "complete", usage: { inputTokens: 5, outputTokens: 8 } });
});

it("keeps layer placement metadata and sends a legal decomposition size", async () => {
  const fetch = vi.fn(async () => json({ data: [{ b64_json: PNG_B64, z_index: 1, name: "subject", bounding_box: [0, 0, 2, 2] }] }));
  vi.stubGlobal("fetch", fetch);
  const result = await generateImage({ ...conn, route: "ark", dialect: "seedream-5-pro", options: { seedreamMode: "layers" } },
    { prompt: "layers", images: ["data:image/png;base64," + PNG_B64], size: "1536x1024" });
  expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ size: "auto", layer_decomposition: true });
  expect(result.images[0].layer).toMatchObject({ name: "subject", zIndex: 1, boundingBox: [0, 0, 2, 2] });
});

it("a settlement failure cannot hide delivered images", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ data: [{ b64_json: PNG_B64 }] })));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const result = await generateImage(conn, { prompt: "x", onSettled: async () => { throw new Error("disk full"); } });
    expect(result.images).toHaveLength(1);
    expect(result.text).toContain("disk full");
  } finally { warning.mockRestore(); }
});
