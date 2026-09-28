/**
 * LIVE probe for docs/issues/video-capability-per-platform.md — NOT part of
 * the suite. Each platform runs only when its key is set.
 *
 * `video_url` is not a Chat Completions part type; it is the Qwen family's
 * extension, measured on 百炼 and 智谱 only. Every other ① platform is sent it
 * today because the capability table answers by family. This asks each
 * platform once, through the app's own part builder (`videoPart`) and the real
 * openai adapter, with a clip whose content cannot be guessed: two seconds of
 * red, then two of blue (`fs/__tests__/fixtures/v4s_640_red_blue.mp4`).
 *
 * Three things per platform, as the issue lists them:
 *   - the HTTP status (the error text when refused);
 *   - whether the answer names the two colours in order — a 200 that does not
 *     is the part dropped in silence, and counts as not taken;
 *   - whether `usage` grew by the video: input tokens against the same prompt
 *     with no clip.
 * Where the clip was read, once more with `fps: 1` beside it: a smaller bill
 * means the private `fps` field reaches the endpoint too.
 *
 * Results: docs/api/landscape.md §7 「视频输入补测」.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { streamCompletion } from "../index";
import { videoPart } from "../videoInput";
import type { ContentPart, StreamChunk, StreamOptions } from "../types";

const CLIP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../fs/__tests__/fixtures/v4s_640_red_blue.mp4"));
const VIDEO = `data:video/mp4;base64,${CLIP.toString("base64")}`;
const PROMPT = "这段视频先后出现了哪两种颜色？只回答两个颜色，用顿号隔开，例如「绿、黄」。";

interface Target { name: string; key: string; baseUrl: string; modelId: string; platform?: StreamOptions["platform"] }
const TARGETS: Target[] = [
  { name: "百炼（对照）", key: process.env.DASHSCOPE_API_KEY ?? "", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", modelId: "qwen3-vl-plus" },
  { name: "DeepSeek", key: process.env.DEEPSEEK_KEY ?? "", baseUrl: "https://api.deepseek.com", modelId: "deepseek-flash" },
  { name: "xAI", key: process.env.XAI_KEY ?? "", baseUrl: "https://api.x.ai/v1", modelId: "grok-4.3" },
  { name: "火山方舟 Coding Plan", key: process.env.SEEDDACE_KEY ?? "", baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3", modelId: "doubao-seed-2.0-mini" },
  { name: "OrcaRouter · Gemini", key: process.env.ORCA_KEY ?? "", baseUrl: "https://api.orcarouter.ai/v1", modelId: "google/gemini-3.8-flash", platform: "orcarouter" },
  { name: "OrcaRouter · GPT", key: process.env.ORCA_KEY ?? "", baseUrl: "https://api.orcarouter.ai/v1", modelId: "openai/gpt-5-mini", platform: "orcarouter" },
];

interface Outcome { text: string; inputTokens?: number; error?: string }

async function ask(t: Target, content: ContentPart[]): Promise<Outcome> {
  const o: Outcome = { text: "" };
  try {
    await streamCompletion({
      standard: "openai_compat", baseUrl: t.baseUrl, apiKey: t.key, modelId: t.modelId,
      ...(t.platform ? { platform: t.platform } : {}),
      messages: [{ role: "user", content }],
      onChunk: (c: StreamChunk) => {
        if ("text" in c) o.text += c.text;
        if ("done" in c) o.inputTokens = c.inputTokens;
      },
    } as StreamOptions);
  } catch (e) {
    o.error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  }
  o.text = o.text.trim();
  return o;
}

for (const t of TARGETS) {
  describe.skipIf(!t.key)(`LIVE video input · ${t.name}`, () => {
    it(t.modelId, async () => {
      const [plain, video] = await Promise.all([
        ask(t, [{ type: "text", text: PROMPT }]),
        ask(t, [{ type: "text", text: PROMPT }, videoPart(VIDEO)]),
      ]);
      const named = /红[\s\S]*蓝|red[\s\S]*blue/i.test(video.text);
      // Where the clip was read, does `fps` beside it reach the endpoint? The bill says (1 fps vs default).
      const slow = !video.error && named ? await ask(t, [{ type: "text", text: PROMPT }, videoPart(VIDEO, 1)]) : undefined;
      console.log(`[video] ${t.name} · ${t.modelId}:`, JSON.stringify({
        error: video.error,
        answer: video.text.slice(0, 120),
        namedInOrder: named,
        inputTokens: { plain: plain.inputTokens, video: video.inputTokens, videoFps1: slow?.inputTokens },
        plainError: plain.error,
      }));
      // The probe records either outcome; it only needs the text-only control to have gone through.
      expect(plain.error, `${t.name} text-only`).toBeUndefined();
    }, 180_000);
  });
}
