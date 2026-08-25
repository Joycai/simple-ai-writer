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
import { IMAGE_EXT_LIST, isImagePath } from "../fs/images";
import { dirName, resolveWorkspacePath } from "../paths";
import type { LoreEntity, LoreImage } from "../lore";
import { categoryImageSlots, findImageSlot } from "../profile/active";
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
    resolution?: string;
    quality?: string;
    sourcePath?: string;
    refPaths?: string[];
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
    resolution: spec.resolution,
    quality: spec.quality,
    sourcePath: spec.sourcePath,
    ...(spec.refPaths?.length ? { refPaths: spec.refPaths } : {}),
    reason: spec.reason,
  };

  // A model declared incapable of taking input images cannot honour a
  // reference — say so before the card, not after the money.
  if (spec.refPaths?.length && model.caps?.edit === false) {
    return {
      toolCallId,
      content: `Error: the image model "${model.name}" is declared as not accepting input images, so references cannot be used. Call generate_image without references, describing the reference's look in the prompt instead.`,
    };
  }
  const maxRefs = model.caps?.maxRefs;
  if (maxRefs && spec.refPaths && spec.refPaths.length > maxRefs) {
    return {
      toolCallId,
      content: `Error: the image model "${model.name}" takes at most ${maxRefs} reference image(s); ${spec.refPaths.length} were given. Keep the most important one(s).`,
    };
  }

  const decision = await ctx.requestApproval(proposal);
  if (!decision.approved) {
    return {
      toolCallId,
      content: `The author REJECTED this image${decision.reason ? ` — reason: ${decision.reason}` : "."} Do not retry the same prompt; adjust per the reason or move on.`,
    };
  }
  // The applied outcome rides back on backupPath — see agentStore's
  // illustrate case, which puts the report there rather than inventing a
  // second channel through ApprovalDecision.
  return {
    toolCallId,
    content: (decision.backupPath ?? "Image generated and saved.")
      // Same wording the write tools use: "approved" must not read as "the
      // author checked my work" when a counted batch grant skipped the card.
      + (decision.auto ? "\nApplied under a standing grant — nobody read it." : ""),
  };
}

/**
 * Resolve one `references` entry to an absolute image path.
 *
 * Two spellings are accepted, because they are the two ways the agent learns
 * that a picture exists: a workspace path (list_files, a document asset), or a
 * bare gallery filename (read_lore_entity lists those without paths). A bare
 * name is looked up in the destination entity's gallery first, then across
 * every gallery — refusing an ambiguous match rather than picking one, since a
 * wrong reference quietly steers the whole generation.
 */
async function resolveReference(
  ctx: ToolContext,
  raw: string,
  destEntityDir: string | undefined,
  /** Parameter being resolved, so the error names what the model actually wrote. */
  field: "references" | "source" = "references",
): Promise<{ path?: string; error?: string }> {
  const name = raw.trim();
  if (!name) return { error: `Error: '${field}' contains an empty entry.` };
  if (!isImagePath(name)) {
    return { error: `Error: ${field === "source" ? "'source'" : `reference "${name}"`} is not an image file (accepted: ${IMAGE_EXT_LIST}).` };
  }

  // A workspace path wins when it exists — it is the unambiguous spelling.
  const asPath = resolveWorkspacePath(ctx.projectPath, name);
  if (asPath && (await fileExists(asPath))) return { path: asPath };

  // Bare gallery filename. `file` fields never contain separators, so a path
  // that failed the existence check cannot accidentally match here.
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  const wanted = base.toLowerCase();
  const hits: { entityName: string; absPath: string }[] = [];
  for (const entity of Object.values(ctx.loreIndex).flat()) {
    const img = entity.images.find((i) => i.file.toLowerCase() === wanted);
    if (img) hits.push({ entityName: entity.name, absPath: img.absPath });
  }
  const inDest = destEntityDir ? hits.find((h) => h.absPath.startsWith(destEntityDir)) : undefined;
  if (inDest) return { path: inDest.absPath };
  if (hits.length === 1) return { path: hits[0].absPath };
  if (hits.length > 1) {
    return {
      error: `Error: "${name}" exists in more than one gallery (${hits.map((h) => h.entityName).join(", ")}). Give the full path instead.`,
    };
  }
  return { error: `Error: no image "${name}" found — give a project path, or a gallery filename from read_lore_entity.` };
}

/**
 * The gallery entry for a picture already resolved to an absolute path.
 *
 * A gallery picture can be named by its path as readily as by its filename,
 * and an edit addressed the long way must not lose the description and slot
 * the short way would have kept — nor land an unregistered file inside the
 * entity's folder (see `editImageTool`'s destination ladder).
 */
function galleryImageAt(
  ctx: ToolContext,
  absPath: string,
): { entity: LoreEntity; image: LoreImage } | null {
  for (const entity of Object.values(ctx.loreIndex).flat()) {
    const image = entity.images.find((i) => i.absPath === absPath);
    if (image) return { entity, image };
  }
  return null;
}

/**
 * Keep only tier values the dialects actually speak. The schema enum already
 * constrains a well-behaved model; this is the backstop for one that ad-libs
 * ("2048x2048" as a resolution), which would otherwise ride into the wire.
 */
function tierOf(value: string | undefined, allowed: readonly string[]): string | undefined {
  return value && allowed.includes(value) ? value : undefined;
}
const RESOLUTION_TIERS = ["1K", "2K", "4K"] as const;
const QUALITY_TIERS = ["low", "medium", "high"] as const;

/** Resolve the whole `references` list, or explain the first failure. */
async function resolveReferences(
  ctx: ToolContext,
  refs: string[] | undefined,
  destEntityDir?: string,
): Promise<{ paths: string[]; error?: string }> {
  const paths: string[] = [];
  for (const raw of refs ?? []) {
    const { path, error } = await resolveReference(ctx, raw, destEntityDir);
    if (error) return { paths: [], error };
    if (path && !paths.includes(path)) paths.push(path);
  }
  return { paths };
}

/** Draw a new picture for a lore entity or a manuscript document. */
export async function generateImageTool(
  toolCallId: string,
  args: {
    // `note` is the parameter's pre-1.28 spelling; `desc` is the name the
    // gallery field actually has (images.md, update_lore_image).
    prompt?: string; desc?: string; note?: string; entity?: string; path?: string; slot?: string;
    references?: string[]; aspect?: string; resolution?: string; quality?: string; reason?: string;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const prompt = args.prompt?.trim();
  if (!prompt) return { toolCallId, content: "Error: 'prompt' is required — describe what is visible in the picture." };
  const note = (args.desc ?? args.note)?.trim() || prompt.slice(0, 80);
  const tiers = {
    resolution: tierOf(args.resolution, RESOLUTION_TIERS),
    quality: tierOf(args.quality, QUALITY_TIERS),
  };

  if (args.entity) {
    const { entity, categories } = findEntity(ctx, args.entity);
    if (!entity) {
      return { toolCallId, content: entityLookupError(args.entity, categories) };
    }
    // Same contract as update_lore_image's slot: only one the entity's own
    // category declares, refused (not dropped) otherwise — a silently discarded
    // slot would file the picture as unclassified with nothing saying why.
    let slot: string | null = null;
    const wantedSlot = args.slot?.trim();
    if (wantedSlot) {
      const match = findImageSlot(entity.category, wantedSlot);
      if (!match) {
        const declared = categoryImageSlots(entity.category);
        return {
          toolCallId,
          content: declared.length === 0
            ? `Error: category "${entity.category}" declares no image slots — omit 'slot'.`
            : `Error: "${wantedSlot}" is not an image slot of category "${entity.category}". Its image slots are: ${declared.map((s) => s.id).join(", ")}. Omit 'slot' if none fits.`,
        };
      }
      slot = match.id;
    }
    const refs = await resolveReferences(ctx, args.references, entity.dirPath);
    if (refs.error) return { toolCallId, content: refs.error };
    return proposeIllustration(toolCallId, ctx, {
      prompt, note, aspect: args.aspect, ...tiers, reason: args.reason,
      refPaths: refs.paths,
      dest: { kind: "lore", entityName: entity.name, entityDir: entity.dirPath, slot },
      destination: entity.name,
      path: entity.dirPath,
    });
  }
  if (args.slot?.trim()) {
    return { toolCallId, content: "Error: 'slot' only applies with 'entity' — a document illustration has no gallery slot." };
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
  const refs = await resolveReferences(ctx, args.references);
  if (refs.error) return { toolCallId, content: refs.error };
  return proposeIllustration(toolCallId, ctx, {
    prompt, note, aspect: args.aspect, ...tiers, reason: args.reason,
    refPaths: refs.paths,
    dest: { kind: "document", docPath: path },
    destination: baseName(path) || path,
    path,
  });
}

/**
 * Redraw an existing picture with a change applied.
 *
 * The picture is named either as `source` — a project path, or a gallery
 * filename, the same two spellings `references` takes — or as the legacy
 * `entity` + `file` pair. It was *only* the pair for a long time, and that is
 * a bug the author hit rather than a design: the model sees one tool called
 * `edit_image`, labelled 修改图片, so "change this picture" lands here whatever
 * the picture is — and every project image came back refused with an error
 * about lore galleries.
 *
 * The destination is a ladder, most explicit first, and every rung is a place
 * the picture is properly *filed* rather than merely written:
 *
 *   `entity`              that entity's gallery (registered via addLoreImage)
 *   `path`                beside that .md document, with the markdown to place
 *   source is a gallery   back into the gallery it came from
 *   otherwise             the folder the source already lives in
 *
 * The third rung is what keeps the fourth safe: a gallery picture's folder is
 * inside `.ai-writer/`, and dropping an unregistered file there would leave it
 * invisible to the entity view. Every other source resolves through
 * `resolveWorkspacePath`, which refuses `.ai-writer/` outright — so the last
 * rung can only ever be an ordinary project folder.
 *
 * The source is never overwritten on any rung: it may already be referenced
 * elsewhere, and replacing it is a destructive act nobody approved.
 */
export async function editImageTool(
  toolCallId: string,
  args: {
    entity?: string; file?: string; source?: string; path?: string; instruction?: string;
    references?: string[];
    aspect?: string; resolution?: string; quality?: string; desc?: string; note?: string; reason?: string;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const instruction = args.instruction?.trim();
  if (!instruction) return { toolCallId, content: "Error: 'instruction' is required — say what to change." };

  // Resolved first, so a name that matches nothing fails on its own terms
  // rather than as a puzzling error about the source picture.
  let entity: LoreEntity | null = null;
  if (args.entity) {
    const found = findEntity(ctx, args.entity);
    if (!found.entity) return { toolCallId, content: entityLookupError(args.entity, found.categories) };
    entity = found.entity;
  }

  // ── Which picture ─────────────────────────────────────────────────────────
  let sourcePath: string;
  const rawSource = args.source?.trim();
  if (rawSource) {
    const resolved = await resolveReference(ctx, rawSource, entity?.dirPath, "source");
    if (resolved.error || !resolved.path) {
      return { toolCallId, content: resolved.error ?? `Error: no image "${rawSource}".` };
    }
    sourcePath = resolved.path;
  } else if (entity && args.file) {
    const image = entity.images.find((i) => i.file === args.file);
    if (!image) {
      return {
        toolCallId,
        content: `Error: "${entity.name}" has no gallery image named "${args.file}". Call read_lore_entity for the exact filenames.`,
      };
    }
    sourcePath = image.absPath;
  } else {
    return {
      toolCallId,
      content: "Error: say which picture to change — 'source' (a path to any image in the project, or a gallery filename), or 'entity' plus 'file' for a gallery picture. read_lore_entity lists a gallery; list_files lists the project.",
    };
  }
  const owner = galleryImageAt(ctx, sourcePath);

  // ── Where the result goes ─────────────────────────────────────────────────
  // An explicit document beats the source's own gallery: "改这张立绘，配到第三章"
  // is a real request, and only `path` can express it.
  const destEntity = entity ?? (args.path?.trim() ? null : owner?.entity ?? null);
  let dest: IllustrateProposal["dest"];
  let destination: string;
  let destPath: string;
  if (destEntity) {
    dest = {
      kind: "lore",
      entityName: destEntity.name,
      entityDir: destEntity.dirPath,
      // A redrawn portrait is still a portrait, so the new picture inherits the
      // original's slot — but only when it is filed back into the gallery it
      // came from. Slots are declared per category, so carrying one across
      // entities can only produce a value the destination's category never
      // declared. update_lore_image reclassifies either way.
      slot: owner?.entity === destEntity ? owner.image.slot : undefined,
    };
    destination = destEntity.name;
    destPath = destEntity.dirPath;
  } else if (args.path?.trim()) {
    const docPath = resolveWorkspacePath(ctx.projectPath, args.path.trim());
    if (!docPath || !/\.md$/i.test(docPath)) {
      return {
        toolCallId,
        content: "Error: 'path' must be a .md document inside the project folder — it says where the RESULT is filed, not which picture to change ('source' does that).",
      };
    }
    if (!(await fileExists(docPath))) {
      return { toolCallId, content: `Error: no document at "${docPath}". Call list_files to see the real paths.` };
    }
    dest = { kind: "document", docPath };
    destination = baseName(docPath) || docPath;
    destPath = docPath;
  } else {
    // Beside the source: the one destination that needs no guessing, and the
    // reason the author can hand over a loose reference image without first
    // deciding where the result belongs.
    const dir = dirName(sourcePath);
    dest = { kind: "file", dir };
    destination = baseName(dir) || dir;
    destPath = dir;
  }

  const refs = await resolveReferences(ctx, args.references, destEntity?.dirPath);
  if (refs.error) return { toolCallId, content: refs.error };
  // The source already rides as an input image, so listing it again as a
  // reference would send the same picture twice and spend one of the model's
  // `maxRefs` slots on it.
  const refPaths = refs.paths.filter((p) => p !== sourcePath);

  return proposeIllustration(toolCallId, ctx, {
    prompt: instruction,
    note: (args.desc ?? args.note)?.trim() || owner?.image.desc || instruction.slice(0, 80),
    aspect: args.aspect,
    resolution: tierOf(args.resolution, RESOLUTION_TIERS),
    quality: tierOf(args.quality, QUALITY_TIERS),
    reason: args.reason,
    refPaths,
    dest,
    destination,
    path: destPath,
    sourcePath,
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
