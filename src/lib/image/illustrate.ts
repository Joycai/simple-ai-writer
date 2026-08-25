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
import { dataUrlToBytes } from "../fs/images";
import { imageForModel } from "./normalize";
import { loadApiKey } from "../keyStore";
import { addLoreImage } from "../lore";
import { imageMarkdown, saveDocumentAsset, saveImageInFolder } from "./assets";
import { imageRequestParams, recordImageUsage } from "./index";
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
  /**
   * The approving run's abort signal. Approval removes the card from the
   * pending queue, so `rejectAll` can no longer cancel this — without the
   * signal, pressing 停止 still leaves a paid-for request running to
   * completion.
   */
  signal?: AbortSignal,
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
    authMode: provider.authMode,
    modelId: model.modelId,
    safetySettings: provider.safetySettings,
    route: model.caps?.route,
    asyncTask: model.caps?.asyncTask,
    comfy: model.caps?.comfy,
  };
  // The model's declared dialect turns the proposal's aspect into whatever
  // fields its endpoint actually takes (Gemini ratio, GPT-Image pixel size…).
  // Edits get their own resolution: several dialects speak a narrower size
  // vocabulary there — see ImageDialectSpec.params.
  // The aspect stays absent when the proposal never named one — on an edit
  // that is the difference between "recompose" and "follow the input image".
  const sel = {
    aspect: proposal.aspect,
    resolution: proposal.resolution,
    quality: proposal.quality,
  };
  const req = { prompt: proposal.prompt, n: 1, ...imageRequestParams(model.caps, sel), signal };
  const editReq = { prompt: proposal.prompt, n: 1, ...imageRequestParams(model.caps, sel, { edit: true }), signal };

  // Input images: the picture being edited, plus any references a generation
  // leans on. Either kind makes the call image-conditioned, so both ride the
  // same field and the same capability gate.
  const inputPaths = [
    ...(proposal.sourcePath ? [proposal.sourcePath] : []),
    ...(proposal.refPaths ?? []),
  ];

  // Same two-layer fallback the interactive session uses: a model that
  // declares no edit support doesn't get a wasted call, and one that turns out
  // not to support it is retried as a plain generation rather than failing.
  let degraded = false;
  let result;
  if (inputPaths.length && model.caps?.edit !== false) {
    const images: string[] = [];
    for (const p of inputPaths) images.push((await imageForModel(p)).dataUrl);
    try {
      result = await generateImage(conn, { ...editReq, images });
    } catch (err) {
      if (!isEditUnsupportedError(err)) throw err;
      result = await generateImage(conn, req);
      degraded = true;
    }
  } else {
    result = await generateImage(conn, req);
    degraded = inputPaths.length > 0;
  }

  const image = result.images[0];
  if (!image) throw new Error("The model returned no image.");
  const { bytes, ext } = dataUrlToBytes(image.dataUrl);

  let path: string;
  let markdown = "";
  if (proposal.dest.kind === "lore") {
    const file = await addLoreImage(
      proposal.dest.entityDir,
      `ai-${Date.now()}.${ext}`,
      bytes,
      proposal.note,
      proposal.dest.slot ?? null,
    );
    path = `${proposal.dest.entityDir}/${file}`;
  } else if (proposal.dest.kind === "document") {
    const saved = await saveDocumentAsset(proposal.dest.docPath, bytes, ext);
    path = saved.absPath;
    markdown = imageMarkdown(saved.relPath, proposal.note);
  } else {
    // No document to hang an `assets/` group off, so no relative link either:
    // the picture lands beside the one it was made from and the model gets a
    // path. Where it should go in the text is the author's call, and the agent
    // can still place it with propose_edit once they say.
    path = await saveImageInFolder(proposal.dest.dir, bytes, ext);
  }

  await recordImageUsage(projectPath, model, proposal.sourcePath ? "image-edit" : "image-gen", 1, result.usage);
  // Awaited: the record file is a read-modify-write, and an agent approving two
  // illustrations in a row would otherwise lose one of the two entries.
  await recordGeneration(projectPath, {
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
