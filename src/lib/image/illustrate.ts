/**
 * Carrying out an approved illustration proposal.
 *
 * This is the "apply" half of the agent's image tools: the author has seen the
 * prompt and the price and said yes, so here the picture is actually drawn and
 * filed. It runs at approval time rather than at proposal time on purpose — a
 * rejected proposal must cost nothing.
 */

import { generateImage, isEditUnsupportedError } from "../ai/image";
import { imageCostFor } from "../ai/configDb";
import type { IllustrateProposal } from "../agent/registry";
import { imageToDataUrl } from "../fs/images";
import { loadApiKey } from "../keyStore";
import { addLoreImage } from "../lore";
import { imageMarkdown, saveDocumentAsset } from "./assets";
import { recordImageUsage, sizeForAspect } from "./index";
import { recordGeneration } from "./session";

/** What an applied illustration reports back to the model. */
export interface IllustrationOutcome {
  /** Absolute path of the saved image. */
  path: string;
  /** For a document target, the markdown to place. Empty for lore. */
  markdown: string;
  /** True when an edit had to be served by regenerating (see the client). */
  degraded: boolean;
}

/**
 * Draw and file one approved illustration.
 *
 * Throws on any failure, which is what turns an approval into a reported
 * rejection upstream (see agentStore.approve) — the model must never be told a
 * picture exists when it doesn't.
 */
export async function runIllustration(
  proposal: IllustrateProposal,
  projectPath: string,
): Promise<IllustrationOutcome> {
  const { useAiStore } = await import("../../stores/aiStore");
  const { models, providers } = useAiStore.getState();
  const model = models.find((m) => m.id === proposal.modelId);
  const provider = model ? providers.find((p) => p.id === model.providerId) : null;
  if (!model || !provider) {
    throw new Error("The image model this proposal was made with is no longer configured.");
  }

  const apiKey = (await loadApiKey(provider.id)) ?? "";
  const conn = {
    baseUrl: provider.baseUrl,
    apiKey,
    standard: provider.apiStandard,
    modelId: model.modelId,
    safetySettings: provider.safetySettings,
    route: model.caps?.route,
  };
  const req = {
    prompt: proposal.prompt,
    n: 1,
    size: proposal.size || sizeForAspect(proposal.aspect ?? "1:1", model.caps?.sizes),
    aspect: proposal.aspect,
  };

  // Same two-layer fallback the interactive session uses: a model that
  // declares no edit support doesn't get a wasted call, and one that turns out
  // not to support it is retried as a plain generation rather than failing.
  let degraded = false;
  let result;
  if (proposal.sourcePath && model.caps?.edit !== false) {
    const source = (await imageToDataUrl(proposal.sourcePath)).dataUrl;
    try {
      result = await generateImage(conn, { ...req, images: [source] });
    } catch (err) {
      if (!isEditUnsupportedError(err)) throw err;
      result = await generateImage(conn, req);
      degraded = true;
    }
  } else {
    result = await generateImage(conn, req);
    degraded = !!proposal.sourcePath;
  }

  const image = result.images[0];
  if (!image) throw new Error("The model returned no image.");
  const { bytes, ext } = decode(image.dataUrl);

  let path: string;
  let markdown = "";
  if (proposal.dest.kind === "lore") {
    const file = await addLoreImage(proposal.dest.entityDir, `ai-${Date.now()}.${ext}`, bytes, proposal.note);
    path = `${proposal.dest.entityDir}/${file}`;
  } else {
    const saved = await saveDocumentAsset(proposal.dest.docPath, bytes, ext);
    path = saved.absPath;
    markdown = imageMarkdown(saved.relPath, proposal.note);
  }

  await recordImageUsage(projectPath, model, proposal.sourcePath ? "image-edit" : "image-gen", 1, result.usage);
  void recordGeneration(projectPath, {
    path,
    prompt: proposal.prompt,
    edits: [],
    model: model.modelId,
    size: req.size,
    aspect: proposal.aspect,
    ...(degraded ? { degraded: true } : {}),
    createdAt: Date.now(),
    costUsd: imageCostFor(model, 1, result.usage),
  });

  return { path, markdown, degraded };
}

/**
 * Local data-URL decode, for the same reason lib/ai/image.ts has one: this
 * module is reached from the agent layer, and pulling the fs helpers'
 * plugin-fs import along would widen that dependency for four lines of base64.
 */
function decode(dataUrl: string): { bytes: Uint8Array; ext: string } {
  const comma = dataUrl.indexOf(",");
  const mime = dataUrl.slice(5, comma).replace(";base64", "").trim();
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const ext = mime.includes("webp") ? "webp" : mime.includes("jpeg") ? "jpg" : "png";
  return { bytes, ext };
}
