/**
 * The agent's image tools (L2 — every call blocks on the author's approval).
 *
 * Both tools stop at a *proposal*: they resolve the destination, price the
 * run, and hand the author a card. Nothing is drawn and nothing is paid for
 * until that card is approved — see lib/image/illustrate.ts for the other
 * half.
 *
 * Approval is not optional here the way it is for lore writes. A bad lore edit
 * is recoverable from a backup; a picture the author didn't want has already
 * cost them money by the time they see it.
 */

import { imageCostFor } from "../ai/configDb";
import { fileExists } from "../fs/fileio";
import { resolveWorkspacePath } from "../paths";
import type { IllustrateProposal, ToolContext } from "./registry";
import { subAgentModel } from "./subagent";
import type { ToolResult } from "./tools";
import { baseName } from "../paths";

let proposalCounter = 0;

/**
 * Resolve the model the imagegen subagent is bound to, with a usable error if
 * absent.
 *
 * The subagent binding (Settings → 子代理) and nothing else — no fallback to
 * "whatever image model exists", which is what this replaced. `routeTools`
 * strips these tools whenever the binding is unusable, so under normal flow
 * this cannot return null; the error path survives for a surface that skips
 * routing, and it must name the actual switch rather than send the author
 * hunting through model settings.
 */
async function activeImageModel() {
  const { useAiStore } = await import("../../stores/aiStore");
  const { models, subAgents } = useAiStore.getState();
  return subAgentModel("imagegen", models, subAgents);
}

/**
 * Shared body: everything both tools do once they know what to draw and where
 * to put it.
 */
async function proposeIllustration(
  toolCallId: string,
  ctx: ToolContext,
  spec: {
    prompt: string;
    note: string;
    dest: IllustrateProposal["dest"];
    destination: string;
    path: string;
    aspect?: string;
    sourcePath?: string;
    reason?: string;
  },
): Promise<ToolResult> {
  if (!ctx.requestApproval) {
    return {
      toolCallId,
      content: "Error: this surface cannot review image generation — do not call this tool here.",
    };
  }
  const model = await activeImageModel();
  if (!model) {
    return {
      toolCallId,
      content: "Error: the image-generation subagent is not usable. Tell the author to enable it and bind an image model in Settings → 子代理.",
    };
  }

  const proposal: IllustrateProposal = {
    kind: "illustrate",
    id: `illustrate-${++proposalCounter}`,
    path: spec.path,
    prompt: spec.prompt,
    destination: spec.destination,
    dest: spec.dest,
    note: spec.note,
    modelId: model.id,
    modelName: model.name,
    costUsd: imageCostFor(model, 1),
    aspect: spec.aspect,
    sourcePath: spec.sourcePath,
    reason: spec.reason,
  };

  const decision = await ctx.requestApproval(proposal);
  if (!decision.approved) {
    return {
      toolCallId,
      content: `The user REJECTED this image${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not retry the same prompt; adjust per the reason or move on.`,
    };
  }
  // The applied outcome rides back on backupPath — see agentStore's
  // illustrate case, which puts the report there rather than inventing a
  // second channel through ApprovalDecision.
  return { toolCallId, content: decision.backupPath ?? "Image generated and saved." };
}

/** Draw a new picture for a lore entity or a manuscript document. */
export async function generateImageTool(
  toolCallId: string,
  args: { prompt?: string; note?: string; entity?: string; path?: string; aspect?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const prompt = args.prompt?.trim();
  if (!prompt) return { toolCallId, content: "Error: 'prompt' is required — describe what is visible in the picture." };
  const note = args.note?.trim() || prompt.slice(0, 80);

  if (args.entity) {
    const { entity, categories } = findEntity(ctx, args.entity);
    if (!entity) {
      return { toolCallId, content: entityLookupError(args.entity, categories) };
    }
    return proposeIllustration(toolCallId, ctx, {
      prompt, note, aspect: args.aspect, reason: args.reason,
      dest: { kind: "lore", entityName: entity.name, entityDir: entity.dirPath },
      destination: entity.name,
      path: entity.dirPath,
    });
  }

  const rawPath = args.path?.trim();
  if (!rawPath) {
    return { toolCallId, content: "Error: give either 'entity' (file it in that entity's gallery) or 'path' (a document in the project)." };
  }
  // `resolveWorkspacePath` accepts the project root itself — and
  // `saveDocumentAsset` would then compute a group from its name and write the
  // picture to `<proj>/../assets/…`, outside the project entirely. The `.md`
  // requirement is what refuses directories, so keep it.
  const path = resolveWorkspacePath(ctx.projectPath, rawPath);
  if (!path || !/\.md$/i.test(path)) {
    return { toolCallId, content: "Error: 'path' must be a .md document inside the project folder." };
  }
  if (!(await fileExists(path))) {
    return { toolCallId, content: `Error: no document at "${path}". Call list_files to see the real paths.` };
  }
  return proposeIllustration(toolCallId, ctx, {
    prompt, note, aspect: args.aspect, reason: args.reason,
    dest: { kind: "document", docPath: path },
    destination: baseName(path) || path,
    path,
  });
}

/** Redraw one of an entity's existing pictures with a change applied. */
export async function editImageTool(
  toolCallId: string,
  args: { entity?: string; file?: string; instruction?: string; note?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const instruction = args.instruction?.trim();
  if (!instruction) return { toolCallId, content: "Error: 'instruction' is required — say what to change." };
  if (!args.entity || !args.file) {
    return { toolCallId, content: "Error: 'entity' and 'file' are required. Call read_lore_entity to see the gallery." };
  }
  const { entity, categories } = findEntity(ctx, args.entity);
  if (!entity) {
    return { toolCallId, content: entityLookupError(args.entity, categories) };
  }
  const image = entity.images.find((i) => i.file === args.file);
  if (!image) {
    return {
      toolCallId,
      content: `Error: "${args.entity}" has no gallery image named "${args.file}". Call read_lore_entity for the exact filenames.`,
    };
  }

  return proposeIllustration(toolCallId, ctx, {
    prompt: instruction,
    note: args.note?.trim() || image.desc || instruction.slice(0, 80),
    reason: args.reason,
    // The result is a NEW gallery entry: the original may already be referenced
    // elsewhere, and overwriting it would be a destructive act nobody approved.
    dest: { kind: "lore", entityName: entity.name, entityDir: entity.dirPath },
    destination: entity.name,
    path: entity.dirPath,
    sourcePath: image.absPath,
  });
}

/**
 * Look one entity up by name across every category.
 *
 * Returns the ambiguity rather than resolving it: two entities can share a
 * name across categories (a character and the place named after them is the
 * everyday case), and taking whichever came first files the picture in the
 * wrong gallery with nothing to indicate it happened.
 */
function findEntity(ctx: ToolContext, name: string) {
  const wanted = name.trim().toLowerCase();
  const hits = Object.values(ctx.loreIndex)
    .flat()
    .filter((e) => e.name.toLowerCase() === wanted);
  return { entity: hits.length === 1 ? hits[0] : null, categories: hits.map((e) => e.category) };
}

/** The error text for a name that matched nothing, or matched too much. */
function entityLookupError(name: string, categories: string[]): string {
  if (categories.length > 1) {
    return `Error: "${name}" exists in more than one category (${categories.join(", ")}). Say which one you mean.`;
  }
  return `Error: no lore entity named "${name}". Call list_lore_entities first.`;
}
