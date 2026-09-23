/**
 * LIVE probe of the `ark` image route against 火山方舟 Seedream — NOT part of
 * the suite. Runs only when SEEDREAM_IMAGE_KEY is set (a separate variable from
 * the text probe's SEEDDACE_KEY, so running that one never bills a picture).
 * Drives the real `generateImage` with the sizes the Seedream dialects compute,
 * so what is verified is the app's own body, its own size table and its own
 * parsing — against the bytes, not the endpoint's `size` claim.
 *
 *   SEEDREAM_IMAGE_KEY=… pnpm vitest run live.volcengine-image
 *
 * Three cases bill one picture each; the other three are refused before any
 * drawing. Base defaults to the plan (`/api/plan/v3`); set SEEDREAM_IMAGE_BASE
 * for a pay-as-you-go key. Findings: docs/api/landscape.md §7 第十三个样本.
 */
import { describe, expect, it } from "vitest";
import { generateImage, ImageHttpError, type GeneratedImage, type ImageConn } from "../image";
import { imageDialect } from "../imageDialects";
import { dimensions, discPng, fullyTransparentPixels } from "./liveImageBytes";

const KEY = process.env.SEEDREAM_IMAGE_KEY ?? "";
const BASE = process.env.SEEDREAM_IMAGE_BASE ?? "https://ark.cn-beijing.volces.com/api/plan/v3";

const LITE: ImageConn = { baseUrl: BASE, apiKey: KEY, standard: "openai_compat", route: "ark", modelId: "doubao-seedream-5.0-lite" };
const PRO: ImageConn = { ...LITE, modelId: "doubao-seedream-5.0-pro" };

describe.skipIf(!KEY)("LIVE 火山方舟 Seedream (ark route)", () => {
  it("refuses a size below the model's pixel floor before drawing (free probe)", async () => {
    await expect(generateImage(LITE, { prompt: "x", size: "1x1" })).rejects.toSatisfy(
      (e: unknown) => e instanceof ImageHttpError && e.status === 400,
    );
  }, 60_000);

  it("answers a model the key does not serve with 404 UnsupportedModel (free probe)", async () => {
    // The pay-as-you-go id for lite without `lite` in it — the plan rejects it.
    await expect(generateImage({ ...LITE, modelId: "doubao-seedream-5-0-260128" }, { prompt: "x", size: "1x1" })).rejects.toSatisfy(
      (e: unknown) => e instanceof ImageHttpError && e.status === 404 && e.code === "UnsupportedModel",
    );
  }, 60_000);

  let apple: GeneratedImage | undefined;

  it("5.0 lite: draws at the dialect's documented 16:9 · 2K pixels", async () => {
    const { size } = imageDialect("seedream-5-lite")!.params({ aspect: "16:9", resolution: "2K" });
    expect(size).toBe("2848x1600");
    const res = await generateImage(LITE, { prompt: "A small red apple on a white table, simple studio photo", size });
    expect(res.images).toHaveLength(1);
    const d = dimensions(res.images[0]);
    expect(res.images[0].mime).toBe(d.mime);
    expect([d.w, d.h]).toEqual([2848, 1600]);
    apple = res.images[0];
  }, 300_000);

  it("5.0 pro: edits with the picture as a JSON `image` reference at 3:2 · 1K", async () => {
    expect(apple, "the lite generation must have run first").toBeDefined();
    const { size } = imageDialect("seedream-5-pro")!.params({ aspect: "3:2", resolution: "1K" }, { edit: true });
    expect(size).toBe("1248x832");
    const res = await generateImage(PRO, { prompt: "Make the apple green, keep everything else the same", images: [apple!.dataUrl], size });
    expect(res.images).toHaveLength(1);
    const d = dimensions(res.images[0]);
    expect([d.w, d.h]).toEqual([1248, 832]);
    expect(res.usage).toBeUndefined();
  }, 300_000);

  // ── Transparency (5.0 pro / flash — `keepsTransparentBackground`) ─────────

  it("refuses transparency for a PNG with nothing transparent in it, before drawing (free probe)", async () => {
    // Straight at the endpoint, not through generateImage: the adapter retries
    // this exact 400 without the two fields, which would draw and bill. What is
    // pinned is the wording its retry keys on (image.ts isNoTransparentPixelError).
    const res = await fetch(`${BASE}/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: PRO.modelId, prompt: "x", size: "2K", image: discPng(64, false),
        background: "transparent", output_format: "png",
      }),
    });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { param?: string; message: string } };
    expect(error.param).toBe("image");
    expect(error.message).toMatch(/transparent pixel/i);
  }, 60_000);

  it("5.0 pro: keeps a transparent PNG transparent through an edit", async () => {
    const res = await generateImage(PRO, {
      prompt: "把红色圆形改成蓝色，其余保持不变",
      images: [discPng(512, true)],
      size: "1K",
      transparentBackground: true,
    });
    expect(res.images).toHaveLength(1);
    const d = dimensions(res.images[0]);
    expect(d.mime).toBe("image/png");
    expect(res.images[0].mime).toBe("image/png");
    // The field outside the disc stays see-through — most of the picture.
    expect(fullyTransparentPixels(res.images[0])).toBeGreaterThan((d.w * d.h) / 3);
  }, 300_000);
});
