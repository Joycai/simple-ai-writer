/**
 * LIVE probe of the `dashscope` image route against 阿里云 千问AI平台 — NOT part
 * of the suite. Runs only when DASHSCOPE_IMAGE_KEY is set. Drives the real
 * `generateImage` so what is verified is the app's own bodies (sync call, async
 * task submit + poll, image parts for edits and references) and its own parsing.
 *
 *   DASHSCOPE_IMAGE_KEY=sk-… pnpm vitest run live.dashscope-image
 *
 * Every case bills one picture (qwen 1K ¥0.25, wan ¥0.5). Findings are recorded
 * in docs/api/landscape.md → DashScope 的图片模型.
 */
import { describe, expect, it } from "vitest";
import { generateImage, ImageHttpError, type GeneratedImage, type ImageConn, type ImageProgress } from "../ai/image";
import { dimensions } from "./liveImageBytes";

const KEY = process.env.DASHSCOPE_IMAGE_KEY ?? "";
// The provider preset's base — the native /api/v1 is derived from it.
const BASE = process.env.DASHSCOPE_IMAGE_BASE ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";

const QWEN: ImageConn = { baseUrl: BASE, apiKey: KEY, standard: "openai_compat", route: "dashscope", modelId: "qwen-image-3.0-pro" };
const WAN: ImageConn = { ...QWEN, modelId: "wan2.7-image-pro" };
const WAN_ASYNC: ImageConn = { ...WAN, asyncTask: true };

const PROMPT = "A small red apple on a white table, simple studio photo";
const EDIT = "Make the apple green, keep everything else the same";
const REFS = "Draw the same apple from the references, now sitting on a blue plate";

describe.skipIf(!KEY)("LIVE DashScope image route", () => {
  describe("qwen-image-3.0-pro (sync)", () => {
    let apple: GeneratedImage | undefined;

    it("generates at the size the app spells (1024x1024 → 1024*1024)", async () => {
      const res = await generateImage(QWEN, { prompt: PROMPT, size: "1024x1024" });
      expect(res.images).toHaveLength(1);
      const d = dimensions(res.images[0]);
      expect(res.images[0].mime).toBe(d.mime);
      expect([d.w, d.h]).toEqual([1024, 1024]);
      apple = res.images[0];
    }, 240_000);

    it("edits with the source as an image part before the instruction", async () => {
      expect(apple, "generation must have run first").toBeDefined();
      const res = await generateImage(QWEN, { prompt: EDIT, images: [apple!.dataUrl], size: "1024x1024" });
      expect(res.images).toHaveLength(1);
      expect(res.images[0].mime).toBe(dimensions(res.images[0]).mime);
    }, 240_000);

    it("refuses the tier shorthand — qwen wants 宽*高, wan takes both", async () => {
      // No picture is billed: the 400 comes back in 0.2 s.
      await expect(generateImage(QWEN, { prompt: PROMPT, size: "1K" })).rejects.toSatisfy(
        (e: unknown) => e instanceof ImageHttpError && e.status === 400 && e.code === "InvalidParameter",
      );
    }, 60_000);
  });

  describe("wan2.7-image-pro", () => {
    let apple: GeneratedImage | undefined;

    it("sync: generates on multimodal-generation with n=1 and the tier shorthand", async () => {
      const res = await generateImage(WAN, { prompt: PROMPT, size: "1K" });
      expect(res.images).toHaveLength(1);
      const d = dimensions(res.images[0]);
      expect(res.images[0].mime).toBe(d.mime);
      expect([d.w, d.h]).toEqual([1024, 1024]);
      apple = res.images[0];
    }, 240_000);

    it("async: submits with X-DashScope-Async, polls to SUCCEEDED, reports progress", async () => {
      const ticks: ImageProgress[] = [];
      const res = await generateImage(WAN_ASYNC, { prompt: "A tall lighthouse at dusk", size: "768*1376", onProgress: (p) => ticks.push(p) });
      expect(res.images).toHaveLength(1);
      const d = dimensions(res.images[0]);
      expect([d.w, d.h]).toEqual([768, 1376]);
      expect(ticks.length).toBeGreaterThan(0);
      expect(ticks[ticks.length - 1]?.phase).toBe("running");
      console.info(`[wan async] ${ticks.length} polls, ${ticks[ticks.length - 1]?.elapsedMs} ms`);
    }, 600_000);

    it("takes two reference pictures as image parts (generate_image with references)", async () => {
      expect(apple, "generation must have run first").toBeDefined();
      const res = await generateImage(WAN, { prompt: REFS, images: [apple!.dataUrl, apple!.dataUrl], size: "1K" });
      expect(res.images).toHaveLength(1);
      expect(res.images[0].mime).toBe(dimensions(res.images[0]).mime);
    }, 240_000);
  });
});
