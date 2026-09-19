/**
 * Lore writes on an entry's pictures and on whole entries: the gallery and avatar, copying a file between entries, moving and deleting entries.
 *
 * Part of the L1/L2 write tools, split out of `writeTools.ts` by section
 * (docs/feature/code-structure-plan.md P6); `writeTools.ts` re-exports the
 * tools, so importers keep one address. The policy every handler follows is
 * in that file's header.
 */


import { categoryImageSlots, findFacetSlot, findImageSlot, loreCategoryIds } from "../../profile/active";
import { addLoreImage, dropLoreImageEntry, normalizeCollections, parseFacetMeta, readEntityFile, saveEntityMetaAndBody, setEntityAvatar, updateLoreImageEntry, writeEntityFile, type CategoryId, type LoreEntity } from "../../lore";
import { parseFrontmatter } from "../../fs/markdown";
import { fileExists, makeDir, readBinaryFile, renamePath } from "../../fs/fileio";
import { IMAGE_EXT_LIST, isImagePath } from "../../fs/images";
import { backupFile, backupFileByMove, changeOf } from "../backup";
import { checkPlan, type LorePlanStep } from "../plan";
import type { ToolContext } from "../registry";
import { resolveWorkspacePath } from "../../paths";
import { allEntityNames, findEntityByName, type ToolResult } from "../tools";
import { baseName } from "../../paths";

import { relocateInSnapshot, withAlias } from "./shared";
import { syncLore, NO_CATEGORY_TOOL_HINT, gate, pauseForStep, entityDeletionPreview } from "./planGate";
import { requireEntity, facetFileList, checkFacetFilename } from "./loreFiles";

// ─── add_lore_image / update_lore_image / delete_lore_image / set_lore_avatar ─
//
// The gallery half of an entity, closed to the agent until these existed:
// images.md is refused as a file write (its format is app-managed), so without
// dedicated tools the agent could ADD pictures (generate_image) but never
// retitle, reclassify, retire or transfer one — which is exactly the metadata
// the type system's imageSlots are made of. Same tier and same discipline as
// the facet tools: L1, plan-gated, every removal recoverable from backups.

/**
 * Validate a model-supplied gallery filename: a plain image filename inside the
 * entity dir, no navigation. The counterpart to checkFacetFilename for the
 * gallery tools.
 */
function checkImageFilename(toolCallId: string, file: string | undefined): ToolResult | string {
  const f = file?.trim();
  if (!f) {
    return { toolCallId, content: "Error: 'file' argument is required (the image filename exactly as listed by read_lore_entity)." };
  }
  if (!/^[^/\\]+$/.test(f) || f.includes("..")) {
    return { toolCallId, content: "Error: 'file' must be a plain filename inside the entity directory (no paths)." };
  }
  if (!isImagePath(f)) {
    return { toolCallId, content: `Error: "${f}" is not an image file (accepted: ${IMAGE_EXT_LIST}).` };
  }
  return f;
}

/** The entity's gallery filenames, for "which images are there?" error text. */
function galleryFileList(entity: LoreEntity): string {
  return (entity.images ?? []).map((i) => i.file).join(", ") || "none";
}

export async function addLoreImageTool(
  toolCallId: string,
  args: { entity?: string; path?: string; desc?: string; slot?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const found = requireEntity(toolCallId, ctx, args.entity);
  if ("toolCallId" in found) return found;
  const entity = found;

  const raw = args.path?.trim();
  if (!raw) {
    return {
      toolCallId,
      content:
        "Error: 'path' argument is required — the path of an image already in the project (list_files shows them). " +
        "To draw a NEW picture instead, use generate_image.",
    };
  }
  const source = resolveWorkspacePath(ctx.projectPath, raw);
  if (!source || !isImagePath(source)) {
    return {
      toolCallId,
      content: `Error: "${raw}" is not an image file inside the project folder (accepted: ${IMAGE_EXT_LIST}).`,
    };
  }
  if (!(await fileExists(source))) {
    return { toolCallId, content: `Error: no file at "${source}". Check the path with list_files.` };
  }

  // Same slot contract as update_lore_image: only one this entity's category
  // declares, refused rather than dropped, normalised to the declared casing.
  let slot: string | null = null;
  const wanted = args.slot?.trim();
  if (wanted) {
    const match = findImageSlot(entity.category, wanted);
    if (!match) {
      const declared = categoryImageSlots(entity.category);
      return {
        toolCallId,
        content: declared.length === 0
          ? `Error: category "${entity.category}" declares no image slots, so 'slot' cannot be set here — omit it.`
          : `Error: "${wanted}" is not an image slot of category "${entity.category}". Its image slots are: ${declared.map((sl) => sl.id).join(", ")}. Omit 'slot' if none of them fits.`,
      };
    }
    slot = match.id;
  }

  const landing = baseName(source) || "image";
  const gated = gate(toolCallId, ctx, "update", entity.name, landing);
  if ("refusal" in gated) return gated.refusal;

  let bytes: Uint8Array;
  try {
    bytes = await readBinaryFile(source);
  } catch {
    return { toolCallId, content: `Error: could not read "${source}" — check the path with list_files.` };
  }

  const backupPath = await backupFile(ctx.projectPath, `${entity.dirPath}/images.md`);
  const desc = args.desc?.trim() ?? "";
  // Copied, not moved: the picture may be a document illustration or reference
  // art the author still wants where it is. addLoreImage auto-numbers a name
  // already taken in the entity dir, so the file always lands.
  const saved = await addLoreImage(entity.dirPath, landing, bytes, desc, slot);
  (entity.images ??= []).push({ file: saved, desc, slot, absPath: `${entity.dirPath}/${saved}` });

  await syncLore(ctx, entity);
  return {
    toolCallId,
    content:
      `Filed ${source} into the gallery of entity "${entity.name}" as ${saved}${slot ? ` (slot ${slot})` : ""}. ` +
      "The source file is untouched." +
      (desc
        ? ""
        : " NOTE: it has no description, so a text-only model will only ever see its filename — add one with update_lore_image.") +
      (backupPath ? ` Previous images.md backed up to ${backupPath}.` : "") +
      ` Plan step: ${gated.step.detail}.`,
  };
}

export async function updateLoreImageTool(
  toolCallId: string,
  args: { entity?: string; file?: string; desc?: string; slot?: string | null },
  ctx: ToolContext,
): Promise<ToolResult> {
  const found = requireEntity(toolCallId, ctx, args.entity);
  if ("toolCallId" in found) return found;
  const entity = found;

  const checked = checkImageFilename(toolCallId, args.file ?? undefined);
  if (typeof checked !== "string") return checked;
  const file = checked;

  const touches = ["desc", "slot"].filter((k) => k in args);
  if (touches.length === 0) {
    return {
      toolCallId,
      content:
        "Error: pass 'desc' (the caption a text-only model reads), 'slot' (the image slot it fills), or both. To replace the picture itself use redraw_lore_image; to remove it use delete_lore_image.",
    };
  }
  if ("desc" in args && typeof args.desc !== "string") {
    return { toolCallId, content: "Error: 'desc' must be a string." };
  }

  const listed = (entity.images ?? []).find((i) => i.file.toLowerCase() === file.toLowerCase());
  if (!listed) {
    return {
      toolCallId,
      content: `Error: "${file}" is not in the gallery of entity "${entity.name}". Its gallery images are: ${galleryFileList(entity)}.`,
    };
  }

  const patch: { desc?: string; slot?: string | null } = {};
  if ("desc" in args) patch.desc = (args.desc as string).trim();
  if ("slot" in args) {
    const wanted = typeof args.slot === "string" ? args.slot.trim() : "";
    if (!wanted) {
      patch.slot = null; // explicit "" clears the classification
    } else {
      // Same contract as update_facet_meta's slot: only a slot the entity's own
      // category declares, normalised to the declared casing, and the error is
      // where the model learns which ones exist.
      const slot = findImageSlot(entity.category, wanted);
      if (!slot) {
        const declared = categoryImageSlots(entity.category);
        return {
          toolCallId,
          content: declared.length === 0
            ? `Error: category "${entity.category}" declares no image slots, so 'slot' cannot be set here. Pass an empty string to clear it, or omit it.`
            : `Error: "${wanted}" is not an image slot of category "${entity.category}". Its image slots are: ${declared.map((sl) => sl.id).join(", ")}. Pass an empty string to clear the slot instead.`,
        };
      }
      patch.slot = slot.id;
    }
  }

  const gated = gate(toolCallId, ctx, "update", entity.name, listed.file);
  if ("refusal" in gated) return gated.refusal;

  const backupPath = await backupFile(ctx.projectPath, `${entity.dirPath}/images.md`);
  const updated = await updateLoreImageEntry(entity.dirPath, listed.file, patch);
  if (!updated) {
    return {
      toolCallId,
      content: `Error: "${listed.file}" is no longer listed in images.md — call read_lore_entity to see the current gallery.`,
    };
  }

  const at = (entity.images ?? []).findIndex((i) => i.file === listed.file);
  if (at >= 0) entity.images[at] = { ...entity.images[at], desc: updated.desc, slot: updated.slot };

  await syncLore(ctx, entity);
  return {
    toolCallId,
    content:
      `Updated gallery image ${listed.file} of entity "${entity.name}": ` +
      `desc="${updated.desc}", slot=${updated.slot ?? "none"}. The picture itself is unchanged.` +
      (backupPath ? ` Previous images.md backed up to ${backupPath}.` : "") +
      ` Plan step: ${gated.step.detail}.`,
  };
}

/**
 * 这个名字指的是这条的头像吗——`avatar` 这个词本身，或者扫描器记下的那个真文件名
 * （`avatar.png` / 大小写照磁盘的拼法）。图库里同名的条目已经在调用处先认过了，
 * 所以这里不会把一张恰好叫 avatar.png 的图库图误判成头像。
 */
function isAvatarTarget(raw: string, entity: LoreEntity): boolean {
  const want = raw.toLowerCase();
  if (want === "avatar") return true;
  if (!entity.avatarPath) return false;
  const name = entity.avatarPath.slice(entity.avatarPath.lastIndexOf("/") + 1).toLowerCase();
  return want === name;
}

/** delete_lore_image 的头像分支：方案门、移进 backups、回灌，和删一张图同一条路。 */
async function deleteLoreAvatar(
  toolCallId: string,
  entity: LoreEntity,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!entity.avatarPath) {
    return {
      toolCallId,
      content: `Error: entity "${entity.name}" has no avatar, so there is nothing to remove. Set one with set_lore_avatar.`,
    };
  }
  const gated = gate(toolCallId, ctx, "delete", entity.name, "avatar");
  if ("refusal" in gated) return gated.refusal;

  // 四个后缀全走一遍，理由同 clearEntityAvatar：手工建的文件夹里可能不止一张，
  // 只摘扫描器挑中的那张，下一次扫描头像又回来了。
  let moved: string | null = null;
  for (const e of AVATAR_EXTS) {
    moved ??= await backupFileByMove(ctx.projectPath, `${entity.dirPath}/avatar.${e}`);
  }
  entity.avatarPath = null;

  await syncLore(ctx, entity);
  return {
    toolCallId,
    content:
      `Removed the avatar of entity "${entity.name}"; its card falls back to the initial again.` +
      (moved ? ` The picture was moved to ${moved} and can be restored.` : "") +
      " Its gallery is untouched." +
      ` Plan step: ${gated.step.detail}.`,
  };
}

export async function deleteLoreImageTool(
  toolCallId: string,
  args: { entity?: string; file?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const found = requireEntity(toolCallId, ctx, args.entity);
  if ("toolCallId" in found) return found;
  const entity = found;

  // 头像先认，因为它连文件名都可以不给：`avatar` 就是方案卡上 `file` 字段说的那个
  // 词（见 propose_lore_plan 的 file 描述）。在这之前头像只能换不能摘——作者设错
  // 一次就再也回不到「这条没有头像」，而这条路上的每一步（方案门、移进 backups）
  // 和删一张图完全一样，所以是同一个工具多认一种目标，不是第 22 个工具。
  const raw = (args.file ?? "").trim();
  const inGallery = (entity.images ?? []).some((i) => i.file.toLowerCase() === raw.toLowerCase());
  if (!inGallery && isAvatarTarget(raw, entity)) {
    return deleteLoreAvatar(toolCallId, entity, ctx);
  }

  const checked = checkImageFilename(toolCallId, args.file ?? undefined);
  if (typeof checked !== "string") return checked;
  const file = checked;

  const listed = (entity.images ?? []).find((i) => i.file.toLowerCase() === file.toLowerCase());
  if (!listed) {
    return {
      toolCallId,
      content:
        `Error: "${file}" is not in the gallery of entity "${entity.name}". Its gallery images are: ${galleryFileList(entity)}.` +
        (entity.avatarPath ? " To remove its avatar instead, pass file: \"avatar\"." : ""),
    };
  }

  const gated = gate(toolCallId, ctx, "delete", entity.name, listed.file);
  if ("refusal" in gated) return gated.refusal;

  // The binary cannot ride the text backup, so the move IS its backup — the
  // same trick delete_lore_entity plays with the whole folder. images.md gets
  // the ordinary text snapshot before the entry is dropped.
  const mdBackup = await backupFile(ctx.projectPath, `${entity.dirPath}/images.md`);
  const binBackup = await backupFileByMove(ctx.projectPath, `${entity.dirPath}/${listed.file}`);
  await dropLoreImageEntry(entity.dirPath, listed.file);
  entity.images = (entity.images ?? []).filter((i) => i.file !== listed.file);

  await syncLore(ctx, entity);
  return {
    toolCallId,
    content:
      `Deleted gallery image ${listed.file} from entity "${entity.name}".` +
      (binBackup ? ` The picture was moved to ${binBackup} and can be restored.` : "") +
      (mdBackup ? ` Previous images.md backed up to ${mdBackup}.` : "") +
      ` Plan step: ${gated.step.detail}.`,
  };
}

/** Extensions an avatar file may carry — mirrors lib/lore/gallery's AVATAR_EXTS. */
export const AVATAR_EXTS = ["png", "jpg", "jpeg", "webp"];

export async function setLoreAvatarTool(
  toolCallId: string,
  args: { entity?: string; file?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const found = requireEntity(toolCallId, ctx, args.entity);
  if ("toolCallId" in found) return found;
  const entity = found;

  const raw = args.file?.trim();
  if (!raw) {
    return {
      toolCallId,
      content: "Error: 'file' argument is required — a gallery filename of this entity, or the path of an image in the project.",
    };
  }

  // A bare gallery filename of this entity wins; otherwise a workspace path.
  const inGallery = (entity.images ?? []).find((i) => i.file.toLowerCase() === raw.toLowerCase());
  const source = inGallery
    ? `${entity.dirPath}/${inGallery.file}`
    : resolveWorkspacePath(ctx.projectPath, raw);
  if (!source || !isImagePath(source) || !(await fileExists(source))) {
    return {
      toolCallId,
      content:
        `Error: "${raw}" is neither a gallery image of "${entity.name}" (its gallery: ${galleryFileList(entity)}) ` +
        "nor the path of an image that exists inside the project folder.",
    };
  }
  const ext = source.slice(source.lastIndexOf(".") + 1).toLowerCase();
  if (!AVATAR_EXTS.includes(ext)) {
    return { toolCallId, content: `Error: an avatar must be one of ${AVATAR_EXTS.join("/")} — "${raw}" is .${ext}.` };
  }

  const gated = gate(toolCallId, ctx, "update", entity.name, "avatar");
  if ("refusal" in gated) return gated.refusal;

  let bytes: Uint8Array;
  try {
    bytes = await readBinaryFile(source);
  } catch {
    return { toolCallId, content: `Error: could not read "${source}" — check the path with list_files or read_lore_entity.` };
  }

  // The old avatar is moved into backups before setEntityAvatar would erase it
  // — the recoverability every other L1 write already guarantees.
  let previous: string | null = null;
  for (const e of AVATAR_EXTS) {
    previous ??= await backupFileByMove(ctx.projectPath, `${entity.dirPath}/avatar.${e}`);
  }
  await setEntityAvatar(entity.dirPath, bytes, ext);
  entity.avatarPath = `${entity.dirPath}/avatar.${ext}`;

  await syncLore(ctx, entity);
  return {
    toolCallId,
    content:
      `Set the avatar of entity "${entity.name}" from ${inGallery ? `gallery image ${inGallery.file}` : source}.` +
      (previous ? ` The previous avatar was moved to ${previous} and can be restored.` : "") +
      ` Plan step: ${gated.step.detail}.`,
  };
}

// ─── copy_lore_file (verbatim transport between entities) ────────────────────

/**
 * Copy one facet/attachment .md or one gallery image from one entity to
 * another, byte for byte.
 *
 * This exists because the merge and promote flows used to force the content
 * through the model: read the source, re-emit it as update_lore_file's
 * `content` — paying for every character twice and risking the silent
 * paraphrase the surgical tools were built to avoid. A copy the model never
 * re-types cannot reword anything.
 */
export async function copyLoreFileTool(
  toolCallId: string,
  args: { from_entity?: string; file?: string; to_entity?: string; new_file?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const foundFrom = requireEntity(toolCallId, ctx, args.from_entity);
  if ("toolCallId" in foundFrom) return foundFrom;
  const source = foundFrom;
  const foundTo = requireEntity(toolCallId, ctx, args.to_entity);
  if ("toolCallId" in foundTo) return foundTo;
  const target = foundTo;
  if (source === target) {
    return { toolCallId, content: "Error: 'from_entity' and 'to_entity' are the same entity — nothing to transfer." };
  }

  const file = args.file?.trim();
  if (!file) {
    return { toolCallId, content: "Error: 'file' argument is required — a facet .md filename or a gallery image filename of the source entity." };
  }

  // ── Gallery image: binary copy + carried desc/slot ──
  const img = (source.images ?? []).find((i) => i.file.toLowerCase() === file.toLowerCase());
  if (img) {
    const requested = args.new_file?.trim() || img.file;
    const checkedName = checkImageFilename(toolCallId, requested);
    if (typeof checkedName !== "string") return checkedName;

    const gated = gate(toolCallId, ctx, "update", target.name, checkedName);
    if ("refusal" in gated) return gated.refusal;

    let bytes: Uint8Array;
    try {
      bytes = await readBinaryFile(`${source.dirPath}/${img.file}`);
    } catch {
      return { toolCallId, content: `Error: could not read "${img.file}" from entity "${source.name}" — its file may have been moved.` };
    }
    const backupPath = await backupFile(ctx.projectPath, `${target.dirPath}/images.md`);
    // addLoreImage auto-numbers a colliding name, so the copy always lands.
    const saved = await addLoreImage(target.dirPath, checkedName, bytes, img.desc, img.slot);
    (target.images ??= []).push({ file: saved, desc: img.desc, slot: img.slot, absPath: `${target.dirPath}/${saved}` });

    // The slot rides verbatim, like a facet's does across categories: it shows
    // as unclassified until a schema declares it, and comes back if one does.
    const slotNote =
      img.slot && !findImageSlot(target.category, img.slot)
        ? ` Note: its slot "${img.slot}" is not declared by category "${target.category}", so it shows as unclassified there.`
        : "";
    await syncLore(ctx, target);
    return {
      toolCallId,
      content:
        `Copied gallery image ${img.file} from "${source.name}" to "${target.name}" as ${saved}, with its description${img.slot ? " and slot" : ""} carried over.` +
        ` The source is untouched — delete it with delete_lore_image (its own plan step) if this was a move.${slotNote}` +
        (backupPath ? ` Previous images.md of the target backed up to ${backupPath}.` : "") +
        ` Plan step: ${gated.step.detail}.`,
    };
  }

  // ── Facet / attachment .md: verbatim text copy ──
  const checkedSource = checkFacetFilename(toolCallId, file);
  if (typeof checkedSource !== "string") return checkedSource;

  let raw: string;
  try {
    raw = await readEntityFile(source.dirPath, checkedSource);
  } catch {
    return {
      toolCallId,
      content:
        `Error: "${file}" does not exist in entity "${source.name}". ` +
        `Its facet files are: ${facetFileList(source)}; its gallery images are: ${galleryFileList(source)}.`,
    };
  }

  const requested = args.new_file?.trim() || checkedSource;
  const checkedTarget = checkFacetFilename(toolCallId, requested);
  if (typeof checkedTarget !== "string") return checkedTarget;

  if (await fileExists(`${target.dirPath}/${checkedTarget}`)) {
    return {
      toolCallId,
      content: `Error: "${checkedTarget}" already exists on entity "${target.name}" — pass 'new_file' to copy under another name, or edit that file instead.`,
    };
  }

  const gated = gate(toolCallId, ctx, "update", target.name, checkedTarget);
  if ("refusal" in gated) return gated.refusal;

  await writeEntityFile(target.dirPath, checkedTarget, raw);
  (target.mdFiles ??= []).push(checkedTarget);
  const facet = parseFacetMeta(raw, checkedTarget);
  if (facet) (target.facets ??= []).push(facet);

  const slotNote =
    facet?.slot && !findFacetSlot(target.category, facet.slot)
      ? ` Note: its slot "${facet.slot}" is not declared by category "${target.category}", so it shows as unclassified there.`
      : "";
  await syncLore(ctx, target);
  return {
    toolCallId,
    content:
      `Copied ${checkedSource} from "${source.name}" to "${target.name}" as ${checkedTarget}, byte for byte (${raw.length} chars).` +
      ` The source is untouched — retire it with delete_lore_file (its own plan step) if this was a move.${slotNote}` +
      ` Plan step: ${gated.step.detail}.`,
  };
}

// ─── move_lore_entity / delete_lore_entity ───────────────────────────────────


/**
 * 一次移动的方案门，**两条路都认**：
 *
 *   1. 这一条自己的 entity 步骤——「move Ava —— 挪到势力」。改名走的永远是这条。
 *   2. 目标分类的 category 步骤——「move 势力 [Ava, Kel, …] —— 把这 12 条归到势力」。
 *
 * 第二条是这个函数存在的全部理由。没有它，「把这 12 条挪到势力」在方案卡上就是
 * **12 行**，而 `organizeTools.ts` 开头讲的正是这件事：作者读不完的卡等于没有卡，
 * 门降级成橡皮图章——那比没有门更糟，因为它看上去像一道门。集合那一侧靠 target 轴
 * 躲开了，分类这一侧一直踩着。
 *
 * 顺序是先 entity 后 category，而不是反过来：entity 步骤更具体，它的 `detail` 会被
 * 回显进工具结果，作者在日志里读到的就该是他自己写下的那一行。
 *
 * 授权边界仍然逐条过：category 步骤列了谁才动得了谁（`checkPlan` 的 `member`）。
 * 批准「12 条」不是批准第 13 条。改名不吃这条路——一个分类步骤说的是「谁搬进来」，
 * 从来不是「顺便把它改个名字」。
 */
export function moveGate(
  toolCallId: string,
  ctx: ToolContext,
  entityName: string,
  newCategory?: string,
): { refusal: ToolResult } | { step: LorePlanStep } {
  const direct = checkPlan(ctx.lorePlan, ctx.loreIndex, "move", entityName);
  if (direct.ok) return { step: direct.step };
  if (!newCategory) return { refusal: { toolCallId, content: direct.message } };

  const viaCategory = checkPlan(ctx.lorePlan, ctx.loreIndex, "move", newCategory, undefined, {
    target: "category",
    member: entityName,
  });
  if (viaCategory.ok) return { step: viaCategory.step };
  // 两条都不通时回 entity 那条的报错——它列出了全部已批准步骤，是模型下一步真正
  // 要读的东西——再补一句告诉它另一条路存在，否则它只会把同一个调用重发一遍。
  return {
    refusal: {
      toolCallId,
      content:
        `${direct.message}\n` +
        `A bulk move can also be covered by ONE step with target "category", entity "${newCategory}", ` +
        "and every entry listed in `members` — propose that instead of one step per entry.",
    },
  };
}

/** Case-insensitive de-duplicating alias append. */

export async function moveLoreEntityTool(
  toolCallId: string,
  args: {
    entity?: string;
    new_name?: string;
    new_category?: string;
    keep_old_name_as_alias?: boolean;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const entityName = args.entity?.trim();
  if (!entityName) return { toolCallId, content: "Error: 'entity' argument is required." };
  const entity = findEntityByName(ctx.loreIndex, entityName);
  if (!entity) {
    return {
      toolCallId,
      content: `Error: entity "${entityName}" not found. Available: ${allEntityNames(ctx.loreIndex) || "none"}`,
    };
  }

  const newName = args.new_name?.trim();
  const newCategory = args.new_category?.trim() as CategoryId | undefined;
  if (!newName && !newCategory) {
    return {
      toolCallId,
      content: "Error: pass 'new_name', 'new_category', or both — otherwise there is nothing to move.",
    };
  }

  const categoryIds = loreCategoryIds();
  if (newCategory && !categoryIds.includes(newCategory)) {
    return {
      toolCallId,
      content: `Error: 'new_category' must be one of: ${categoryIds.join(", ")}. ${NO_CATEGORY_TOOL_HINT}`,
    };
  }
  if (newName) {
    // A rename onto a name/alias another entity already answers to would make
    // both unresolvable by name — refuse rather than create the ambiguity.
    const clash = findEntityByName(ctx.loreIndex, newName);
    if (clash && clash !== entity) {
      return {
        toolCallId,
        content: `Error: "${newName}" already resolves to entity "${clash.name}" (category: ${clash.category}). Merge them with update_lore_file instead, or pick another name.`,
      };
    }
  }

  const gated = moveGate(toolCallId, ctx, entity.name, newCategory);
  if ("refusal" in gated) return gated.refusal;

  // Frontmatter is the source of truth for summary/aliases; the scanned entity
  // is the fallback when index.md is missing or unparseable.
  let body = `# ${newName ?? entity.name}\n`;
  let summary = entity.summary;
  let aliases = entity.aliases;
  let collections = entity.collections ?? [];
  let cover = entity.cover ?? null;
  try {
    const raw = await readEntityFile(entity.dirPath, "index.md");
    const parsed = parseFrontmatter(raw);
    body = parsed.content;
    if (typeof parsed.data.summary === "string") summary = parsed.data.summary;
    collections = normalizeCollections(parsed.data.collections);
    cover = typeof parsed.data.cover === "string" && parsed.data.cover.trim()
      ? parsed.data.cover.trim()
      : null;
  } catch {
    // no index.md — the rewrite below creates one from the scanned metadata
  }

  // The old name keeps matching in already-written chapters unless the author
  // explicitly opts out (a typo fix should not preserve the typo).
  if (newName && newName !== entity.name && args.keep_old_name_as_alias !== false) {
    aliases = withAlias(aliases, entity.name);
  }

  const previousCategory = entity.category;
  const previousDir = entity.dirPath;
  const backupPath = await backupFile(ctx.projectPath, `${entity.dirPath}/index.md`);
  const moved = await saveEntityMetaAndBody(
    ctx.projectPath,
    entity,
    // collections / cover 显式从**盘上**带过来，和 body / summary / aliases 同一份
    // 读取——这是第三个整份重写 frontmatter 的写入方，前两个（update_lore_meta、
    // update_lore_file）已经守住了这条。留给 saveEntityMetaAndBody 兜底就是从
    // `entity` 上取，而那是运行开始时的快照：作者在一次长运行进行中于面板里归的
    // 集，会被这次改名静静撤销。
    {
      name: newName ?? entity.name,
      aliases,
      category: newCategory ?? entity.category,
      summary,
      dict: entity.dict,
      collections,
      cover,
    },
    body,
  );
  entity.collections = collections;
  entity.cover = cover;
  relocateInSnapshot(ctx.loreIndex, entity, moved);
  entity.name = newName ?? entity.name;
  entity.aliases = aliases;

  await syncLore(ctx);
  const changes = [
    newName && newName !== entityName ? `renamed to "${newName}"` : null,
    newCategory && newCategory !== previousCategory
      ? `moved ${previousCategory} → ${newCategory}`
      : null,
    // A rename re-slugs the folder too (saveEntityMetaAndBody), so the model
    // must learn the new location either way.
    moved.dirPath !== previousDir ? `folder now at ${moved.dirPath}` : null,
  ].filter(Boolean);
  return {
    toolCallId,
    content:
      `Entity "${entityName}" ${changes.join(" and ")}.` +
      (backupPath ? ` Previous index.md backed up to ${backupPath}.` : "") +
      ` Plan step: ${gated.step.detail}. The lore index has been refreshed.`,
  };
}

export async function deleteLoreEntityTool(
  toolCallId: string,
  args: { entity?: string; reason?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const entityName = args.entity?.trim();
  if (!entityName) return { toolCallId, content: "Error: 'entity' argument is required." };
  const entity = findEntityByName(ctx.loreIndex, entityName);
  if (!entity) {
    return {
      toolCallId,
      content: `Error: entity "${entityName}" not found. Available: ${allEntityNames(ctx.loreIndex) || "none"}`,
    };
  }

  const gated = gate(toolCallId, ctx, "delete", entity.name);
  if ("refusal" in gated) return gated.refusal;

  // 删条目 always stops (1z B): the backup keeps the folder, not the author's
  // memory of what was in it or which chapters leaned on it.
  const skippedDelete = await pauseForStep(toolCallId, ctx, gated.step, await entityDeletionPreview(ctx, entity));
  if (skippedDelete) return skippedDelete;

  // Not an unlink: the folder is *moved* into .ai-writer/backups, which keeps
  // the L1 "auto-apply, always recoverable" bargain intact even for the binary
  // gallery assets that backupFile (text-only) could never snapshot. One rename
  // also means there is no half-deleted state to land in.
  const backupRoot = `${ctx.projectPath}/.ai-writer/backups`;
  await makeDir(backupRoot);
  const trashPath = `${backupRoot}/deleted-${Date.now()}-${entity.category}-${entity.id}`;
  await renamePath(entity.dirPath, trashPath);

  relocateInSnapshot(ctx.loreIndex, entity, null);
  // Reads `entity.name`/`entity.category` below off the now-detached object on
  // purpose: the message should report what was deleted, not what remains.
  await syncLore(ctx);
  return {
    toolCallId,
    content:
      `Deleted lore entity "${entity.name}" (category: ${entity.category}). ` +
      `Its folder was moved to ${trashPath} and can be restored by moving it back. ` +
      `Plan step: ${gated.step.detail}. The lore index has been refreshed.`,
    // A folder, not a text: the record says where it went so the ledger can
    // bring it back — the whole folder was moved, so the whole folder returns.
    change: {
      ...changeOf({
        projectPath: ctx.projectPath,
        path: entity.dirPath,
        entity: entity.name,
        before: "",
        backupPath: trashPath,
      }),
      dir: true,
    },
  };
}
