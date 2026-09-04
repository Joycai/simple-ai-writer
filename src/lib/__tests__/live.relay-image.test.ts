/**
 * LIVE probe of the two image routes a New API-style relay serves — NOT part of
 * the suite. Runs only when RELAY_IMAGE_KEY is set. Drives the real
 * `generateImage` so what is verified is the app's own request bodies and its
 * own response parsing, not a hand-written imitation.
 *
 *   RELAY_IMAGE_KEY=sk-… pnpm vitest run live.relay-image
 *
 * Optional: RELAY_IMAGE_BASE (host root, default hk.chenmoai.com),
 * RELAY_CHAT_IMAGE_MODEL (default `[R]gpt-image-2`),
 * RELAY_GEMINI_IMAGE_MODEL (default `[R]gemini-3.1-flash-image-preview`).
 *
 * Every case bills one picture. Findings are recorded in
 * docs/api/landscape.md → 第九个样本.
 */
import { describe, expect, it } from "vitest";
import { generateImage, type GeneratedImage, type ImageConn } from "../ai/image";
import { dimensions } from "./liveImageBytes";

const KEY = process.env.RELAY_IMAGE_KEY ?? "";
const HOST = (process.env.RELAY_IMAGE_BASE ?? "https://hk.chenmoai.com").replace(/\/+$/, "");
const CHAT_MODEL = process.env.RELAY_CHAT_IMAGE_MODEL ?? "[R]gpt-image-2";
const GEMINI_MODEL = process.env.RELAY_GEMINI_IMAGE_MODEL ?? "[R]gemini-3.1-flash-image-preview";

const CHAT: ImageConn = { baseUrl: `${HOST}/v1`, apiKey: KEY, standard: "openai_compat", route: "chat", modelId: CHAT_MODEL };
const GEMINI: ImageConn = { baseUrl: `${HOST}/v1beta`, apiKey: KEY, standard: "gemini_compat", modelId: GEMINI_MODEL };

const PROMPT = "A small red apple on a white table, simple studio photo";
const EDIT = "Make the apple green, keep everything else the same";

describe.skipIf(!KEY)("LIVE relay image routes", () => {
  describe(`chat route · ${CHAT_MODEL}`, () => {
    let apple: GeneratedImage | undefined;

    it("generates one picture and reports token usage", async () => {
      const res = await generateImage(CHAT, { prompt: PROMPT });
      expect(res.images).toHaveLength(1);
      const d = dimensions(res.images[0]);
      // The declared mime must be the bytes' own, whatever the wire said.
      expect(res.images[0].mime).toBe(d.mime);
      expect(res.images[0].dataUrl.startsWith(`data:${d.mime};base64,`)).toBe(true);
      expect(d.w).toBeGreaterThan(256);
      expect(res.usage?.outputTokens ?? 0).toBeGreaterThan(0);
      // A base64 blob mistaken for prose would land here — it must not.
      expect(res.text ?? "").not.toMatch(/^[A-Za-z0-9+/]{100,}/);
      apple = res.images[0];
    }, 240_000);

    it("edits with the source as an image_url part", async () => {
      expect(apple, "generation must have run first").toBeDefined();
      const res = await generateImage(CHAT, { prompt: EDIT, images: [apple!.dataUrl] });
      expect(res.images).toHaveLength(1);
      const d = dimensions(res.images[0]);
      expect(res.images[0].mime).toBe(d.mime);
      expect(res.text ?? "").not.toMatch(/^https?:\/\//);
    }, 240_000);

    it("takes two reference pictures as image_url parts (generate_image with references)", async () => {
      expect(apple, "generation must have run first").toBeDefined();
      const res = await generateImage(CHAT, {
        prompt: "Draw the same apple from the reference, now sitting on a blue plate",
        images: [apple!.dataUrl, apple!.dataUrl],
      });
      expect(res.images).toHaveLength(1);
      expect(res.images[0].mime).toBe(dimensions(res.images[0]).mime);
    }, 240_000);

    it("folds the framing into the prompt and still gets a picture", async () => {
      const res = await generateImage(CHAT, { prompt: "A tall lighthouse at dusk", aspect: "9:16" });
      expect(res.images).toHaveLength(1);
      const d = dimensions(res.images[0]);
      // Advisory only — the chat protocol has no size field — so record, don't assert.
      console.info(`[chat] 9:16 asked, got ${d.w}x${d.h} ${d.mime}`);
    }, 240_000);
  });

  describe(`gemini route · ${GEMINI_MODEL}`, () => {
    let apple: GeneratedImage | undefined;

    it("generates one picture with the mime read off the bytes", async () => {
      const res = await generateImage(GEMINI, { prompt: PROMPT });
      expect(res.images).toHaveLength(1);
      const d = dimensions(res.images[0]);
      expect(res.images[0].mime).toBe(d.mime);
      expect(res.images[0].dataUrl.startsWith(`data:${d.mime};base64,`)).toBe(true);
      expect(res.usage?.outputTokens ?? 0).toBeGreaterThan(0);
      apple = res.images[0];
    }, 240_000);

    it("honours aspectRatio + imageSize through imageConfig", async () => {
      const res = await generateImage(GEMINI, { prompt: "A tall lighthouse at dusk", aspect: "9:16", imageSize: "1K" });
      expect(res.images).toHaveLength(1);
      const d = dimensions(res.images[0]);
      console.info(`[gemini] 9:16 asked, got ${d.w}x${d.h} ${d.mime}`);
      expect(d.h).toBeGreaterThan(d.w);
    }, 240_000);

    it("edits with the source inline", async () => {
      expect(apple, "generation must have run first").toBeDefined();
      const res = await generateImage(GEMINI, { prompt: EDIT, images: [apple!.dataUrl] });
      expect(res.images).toHaveLength(1);
      expect(res.images[0].mime).toBe(dimensions(res.images[0]).mime);
    }, 240_000);

    it("takes two reference pictures as inline parts (generate_image with references)", async () => {
      expect(apple, "generation must have run first").toBeDefined();
      const res = await generateImage(GEMINI, {
        prompt: "Draw the same apple from the reference, now sitting on a blue plate",
        images: [apple!.dataUrl, apple!.dataUrl],
      });
      expect(res.images).toHaveLength(1);
      expect(res.images[0].mime).toBe(dimensions(res.images[0]).mime);
    }, 240_000);

    it("accepts Bearer auth as well as x-goog-api-key", async () => {
      const res = await generateImage({ ...GEMINI, authMode: "bearer" }, { prompt: PROMPT });
      expect(res.images).toHaveLength(1);
    }, 240_000);

    it("n = 2 → candidateCount is sent; the relay returns what it returns", async () => {
      const res = await generateImage(GEMINI, { prompt: PROMPT, n: 2 });
      console.info(`[gemini] candidateCount 2 → ${res.images.length} image(s)`);
      expect(res.images.length).toBeGreaterThanOrEqual(1);
    }, 240_000);
  });
});
