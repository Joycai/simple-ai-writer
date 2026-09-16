/**
 * LIVE probe of DashScope's synchronous ASR — NOT part of the suite.
 * Runs only when QIANWEN_KEY is set. Drives the app's own sync client
 * (`lib/asr/sync.ts`) so what is verified is the real request body, the
 * error mapping and the response parser, not a hand-written imitation.
 *
 * Fixture: `say -v Tingting "你好，世界"` → ffmpeg 16kHz mono wav (~42KB).
 * docs/feature/asr/00-research.md §1.3 补记 (2026-09-14) records the facts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transcribeSync } from "../sync";
import { parseSyncTranscript } from "../result";
import type { AsrConn } from "../client";

const KEY = process.env.QIANWEN_KEY ?? "";
const BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const WAV = readFileSync(fileURLToPath(new URL("./fixtures/hello-world.wav", import.meta.url)));
const audioBase64 = WAV.toString("base64");

const connFor = (modelId: string): AsrConn => ({ baseUrl: BASE, apiKey: KEY, modelId, format: "dashscope-sync" });

describe.skipIf(!KEY)("LIVE Qianwen synchronous ASR", () => {
  it("qwen3-asr-flash: transcribes the fixture; annotations and usage.seconds present", async () => {
    const r = await transcribeSync(connFor("qwen3-asr-flash"), { audioBase64, ext: "wav", options: { diarization: false } });
    const t = parseSyncTranscript(r.responseJson);
    expect(t.timed).toBe(false);
    expect(t.sentences).toHaveLength(1);
    expect(t.sentences[0].text).toMatch(/你好/);
    expect(t.sentences[0].text).toMatch(/世界/);
    expect(t.sentences[0].language).toBe("zh");
    expect(r.billedSeconds).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("asr_options.language from the first hint is accepted", async () => {
    const r = await transcribeSync(connFor("qwen3-asr-flash"), { audioBase64, ext: "wav", options: { diarization: false, languageHints: ["zh"] } });
    expect(parseSyncTranscript(r.responseJson).sentences[0].text).toMatch(/世界/);
  }, 120_000);

  it("dated snapshot: transcribes, but seconds come from audio tokens (no usage.seconds)", async () => {
    const r = await transcribeSync(connFor("qwen3-asr-flash-2026-02-10"), { audioBase64, ext: "wav", options: { diarization: false } });
    const json = JSON.parse(r.responseJson) as { usage?: { seconds?: number } };
    expect(json.usage?.seconds).toBeUndefined();
    expect(r.billedSeconds).toBeGreaterThanOrEqual(1);
    expect(parseSyncTranscript(r.responseJson).sentences[0].text).toMatch(/世界/);
  }, 120_000);

  it("a non-sync ASR id is refused and restated as ModelNotSync", async () => {
    await expect(
      transcribeSync(connFor("qwen-audio-3.0-asr-flash"), { audioBase64, ext: "wav", options: { diarization: false } }),
    ).rejects.toMatchObject({ code: "ModelNotSync" });
  }, 120_000);
});
