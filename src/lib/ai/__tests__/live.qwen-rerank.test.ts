/** Explicit opt-in only: AI_WRITER_LIVE_QWEN_RERANK=1 + DASHSCOPE_API_KEY.
 * Fictional text; no credentials, raw responses or author documents in output.
 * Official protocol and measurement: docs/api/retrieval.md.
 */
import { describe, expect, it } from "vitest";
import { rerank, type RetrievalConnection } from "../retrieval";
import { RETRIEVAL_PATHS } from "../retrievalConfig";

const enabled = process.env.AI_WRITER_LIVE_QWEN_RERANK === "1" && !!process.env.DASHSCOPE_API_KEY;
describe.skipIf(!enabled)("LIVE Qwen3.7 text rerank", () => {
  it("ranks the relevant fictional description first and reads prompt-token usage", async () => {
    const conn: RetrievalConnection = {
      baseUrl: "https://maas.qianwenaiapi.com/compatible-mode/v1", apiKey: process.env.DASHSCOPE_API_KEY ?? "",
      modelId: "qwen3.7-text-rerank", retrieval: { format: "dashscope-rerank", path: RETRIEVAL_PATHS["dashscope-rerank"] },
    };
    let promptTokens = 0;
    const started = Date.now();
    const result = await rerank(conn, "受伤旅人寻找能治疗蛇毒的医师。", [
      "王城金库记录税收与金银出入。", "雪山关隘由守卫轮班巡逻。", "林中药师擅长辨别毒草和配制解药。",
    ], AbortSignal.timeout(45_000), (usage) => { promptTokens = usage.promptTokens; });
    expect(result).toHaveLength(3);
    expect(new Set(result.map((row) => row.index)).size).toBe(3);
    expect(result[0].index).toBe(2);
    expect(result[0].score).toBeGreaterThan(result[1].score);
    expect(promptTokens).toBeGreaterThan(0);
    process.stdout.write(JSON.stringify({ seconds: (Date.now() - started) / 1000, result, promptTokens }) + "\n");
  }, 50_000);
});
