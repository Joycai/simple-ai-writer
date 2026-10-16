/** Explicitly opt in: AI_WRITER_LIVE_QWEN_EMBEDDING=1 + DASHSCOPE_API_KEY.
 * Uses fictional text only; never logs credentials or raw provider errors.
 * Protocol evidence: docs/api/retrieval.md, 2026-10-16.
 */
import { describe, expect, it } from "vitest";
import { cosine, embed, embeddingLimits, type RetrievalConnection } from "../retrieval";
import { RETRIEVAL_PATHS } from "../retrievalConfig";

const enabled = process.env.AI_WRITER_LIVE_QWEN_EMBEDDING === "1" && !!process.env.DASHSCOPE_API_KEY;
const texts = ["受伤旅人寻找能治疗蛇毒的医师。", "林中药师擅长辨别毒草和配制解药。",
  "王城金库记录税收与金银出入。", "雪山关隘由守卫轮班巡逻。",
  ...Array.from({ length: 16 }, (_, i) => `虚构村落${i + 1}：居民在河边种植粮食并交换工具。`)];
describe.skipIf(!enabled)("LIVE Qwen native embeddings", () => {
  it("returns one independent vector per text at the documented 20-item batch limit", async () => {
    const conn: RetrievalConnection = {
      baseUrl: "https://maas.qianwenaiapi.com/compatible-mode/v1",
      apiKey: process.env.DASHSCOPE_API_KEY ?? "", modelId: "qwen3-vl-embedding",
      retrieval: { format: "dashscope-multimodal-embedding", path: RETRIEVAL_PATHS["dashscope-multimodal-embedding"] },
    };
    const input = texts;
    const started = Date.now();
    let promptTokens = 0;
    const vectors = await embed(conn, input, AbortSignal.timeout(45_000), (usage) => { promptTokens = usage.promptTokens; });
    expect(embeddingLimits(conn).batchSize).toBe(20);
    expect(vectors).toHaveLength(20);
    expect(vectors.every((v) => v.length === 2560)).toBe(true);
    expect(promptTokens).toBeGreaterThan(0);
    const scores = vectors.slice(1, 4).map((v) => cosine(vectors[0], v));
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[0]).toBeGreaterThan(scores[2]);
    console.log(JSON.stringify({ seconds: (Date.now() - started) / 1000, count: vectors.length,
      dimensions: vectors[0].length, promptTokens, scores }));
  }, 50_000);
  it("Flash text embeddings work through the existing OpenAI-compatible adapter at batch size 20", async () => {
    const conn: RetrievalConnection = {
      baseUrl: "https://maas.qianwenaiapi.com/compatible-mode/v1",
      apiKey: process.env.DASHSCOPE_API_KEY ?? "", modelId: "qwen3.7-text-embedding-flash",
      retrieval: { format: "openai-embedding", path: RETRIEVAL_PATHS["openai-embedding"] },
    };
    let promptTokens = 0;
    const vectors = await embed(conn, texts, AbortSignal.timeout(45_000), (usage) => { promptTokens = usage.promptTokens; });
    expect(vectors).toHaveLength(20);
    expect(vectors.every((v) => v.length === 1024)).toBe(true);
    expect(promptTokens).toBeGreaterThan(0);
    const scores = vectors.slice(1, 4).map((v) => cosine(vectors[0], v));
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[0]).toBeGreaterThan(scores[2]);
  }, 50_000);

});
