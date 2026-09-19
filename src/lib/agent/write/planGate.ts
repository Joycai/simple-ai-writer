/**
 * The lore plan gate — `propose_lore_plan` — and the destructive steps that stop and ask before they run (设计稿 02h 1g / 1i). Every lore write goes through `gate` here.
 *
 * Part of the L1/L2 write tools, split out of `writeTools.ts` by section
 * (docs/feature/code-structure-plan.md P6); `writeTools.ts` re-exports the
 * tools, so importers keep one address. The policy every handler follows is
 * in that file's header.
 */


import { cloneLoreIndex, isGalleryManifest, readEntityFile, type LoreEntity, type LoreEntityAddress } from "../../lore";
import { parseFrontmatter } from "../../fs/markdown";
import { citingDocuments, rewriteRatio } from "../destructive";
import { CHANGE_TEXT_CHARS } from "../backup";
import { LORE_PLAN_ACTIONS, LORE_PLAN_TARGETS, checkPlan, describeStep, recordMatch, recordRefusal, recordSkip, outstandingSteps, type LorePlanAction, type LorePlanStep, type LorePlanTarget } from "../plan";
import type { LoreStepProposal, ToolContext } from "../registry";
import { type ToolResult } from "../tools";

import { nextProposalSeq } from "./shared";

// ─── propose_lore_plan (the gate every lore write goes through) ──────────────

let planCounter = 0;

export async function proposeLorePlanTool(
  toolCallId: string,
  args: { summary?: string; steps?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.requestPlanApproval || !ctx.lorePlan) {
    return {
      toolCallId,
      content: "Error: this surface cannot review lore plans — do not call propose_lore_plan here.",
    };
  }

  const raw = Array.isArray(args.steps) ? args.steps : [];
  if (raw.length === 0) {
    return {
      toolCallId,
      content: "Error: 'steps' must list at least one change (action + entity + detail).",
    };
  }

  const steps: LorePlanStep[] = [];
  for (const [i, item] of raw.entries()) {
    const s = (item ?? {}) as Record<string, unknown>;
    const action = String(s.action ?? "").trim() as LorePlanAction;
    const entity = String(s.entity ?? "").trim();
    const detail = String(s.detail ?? "").trim();
    if (!LORE_PLAN_ACTIONS.includes(action)) {
      return {
        toolCallId,
        content: `Error: step ${i + 1} has action "${s.action}" — must be one of: ${LORE_PLAN_ACTIONS.join(", ")}.`,
      };
    }
    if (!entity) return { toolCallId, content: `Error: step ${i + 1} is missing 'entity'.` };
    if (!detail) {
      return {
        toolCallId,
        content: `Error: step ${i + 1} is missing 'detail' — the author decides on this text, so say concretely what changes.`,
      };
    }
    const file = typeof s.file === "string" && s.file.trim() ? s.file.trim() : undefined;

    // 目标类型：缺省是条目（集合出现之前的每一份方案，以及之后绝大多数）。
    const rawTarget = String(s.target ?? "entity").trim() as LorePlanTarget;
    if (!LORE_PLAN_TARGETS.includes(rawTarget)) {
      return {
        toolCallId,
        content: `Error: step ${i + 1} has target "${s.target}" — must be one of: ${LORE_PLAN_TARGETS.join(", ")}.`,
      };
    }
    const members = Array.isArray(s.members)
      ? s.members.map((m) => String(m).trim()).filter(Boolean)
      : undefined;
    if (members?.length && rawTarget !== "collection") {
      return {
        toolCallId,
        content:
          `Error: step ${i + 1} lists 'members' but its target is "${rawTarget}". ` +
          "Only a collection step moves entries in or out; an entity step acts on the one entry it names.",
      };
    }
    steps.push({
      action,
      target: rawTarget === "entity" ? undefined : rawTarget,
      entity,
      members: members?.length ? members : undefined,
      file,
      detail,
    });
  }

  ctx.lorePlan.asked = true;
  const planId = `plan-${++planCounter}`;
  const decision = await ctx.requestPlanApproval({
    id: planId,
    summary: args.summary?.trim() || undefined,
    steps,
  });

  if (!decision.approved) {
    return {
      toolCallId,
      content:
        `The author REJECTED this plan${decision.reason ? ` — reason: ${decision.reason}` : "."} ` +
        "Nothing has been changed. Revise the plan per the reason and propose again, or ask what they want instead — do not write any lore in the meantime.",
    };
  }

  // Append rather than replace: a revised or additional plan mid-run must not
  // silently revoke steps the author already signed off on. Carrying the
  // earlier leftovers into the message keeps them from being forgotten now that
  // a fresh list is the most recent thing in context.
  const leftover = outstandingSteps(ctx.lorePlan);
  const offset = ctx.lorePlan.steps.length;
  ctx.lorePlan.steps.push(...steps);
  return {
    toolCallId,
    content:
      `Plan approved. Carry out exactly these steps, nothing more:\n` +
      steps.map((s, i) => `  ${offset + i + 1}. ${describeStep(s)}`).join("\n") +
      (leftover.length
        ? `\nStill outstanding from earlier:\n${leftover.map((s) => `  - ${describeStep(s)}`).join("\n")}`
        : "") +
      "\nAnything outside this list will be refused. Propose again if the plan needs to change.",
    // The ledger's head: the plan as approved, and where its steps sit among the
    // run's — never re-read from this call's arguments, which the log clips.
    plan: { id: planId, summary: args.summary?.trim() || undefined, steps, offset },
  };
}

/**
 * Fold a lore write back into this run's snapshot, and refresh the app with it.
 *
 * `ctx.loreIndex` is one object shared by every tool call in the run (the
 * runtime spreads the same context per call), so the fresh index is poured
 * *into* it rather than reassigned — a reassignment would be invisible to the
 * next call. It is cloned on the way in for the same reason the runtime clones
 * at run start: what comes back is the live store object, and the snapshot
 * patches below splice its arrays.
 *
 * Never throws. `executeRegisteredTool` turns a throw into an `"Error: …"`
 * result, so a rescan that fails *after* a successful write would tell the
 * model its create failed — and the model would create the entity a second
 * time. The hand-written snapshot patches are the fallback.
 *
 * Invariant for callers: resync **last**, and never touch disk through an
 * entity resolved before it — those objects are detached once this returns.
 *
 * Pass `changed` when the write stayed inside those entities' folders — a body
 * edit, a facet, a picture, the avatar, or the N entries one filing call
 * re-tagged. The surface then re-reads those folders alone
 * (`loreStore.refreshEntities`) instead of walking every entry, which is what
 * a rescan after *each* write call used to cost. Leave it out when the write
 * changed what exists or where: create, move, delete, a pack run. An empty
 * array is not the same as omitting it — it means "nothing changed on disk",
 * and asks for no rescan at all.
 *
 * The addresses are copied out before the await, because the entity objects
 * are exactly what the resync detaches.
 */
export async function syncLore(
  ctx: ToolContext,
  changed?: LoreEntity | LoreEntityAddress[],
): Promise<void> {
  try {
    let address: LoreEntityAddress | LoreEntityAddress[] | undefined;
    if (Array.isArray(changed)) {
      address = changed.map((a) => ({ category: a.category, id: a.id, dirPath: a.dirPath }));
    } else if (changed) {
      address = { category: changed.category, id: changed.id, dirPath: changed.dirPath };
    }
    const fresh = await ctx.onLoreChanged?.(address);
    if (!fresh) return;
    for (const key of Object.keys(ctx.loreIndex)) delete ctx.loreIndex[key];
    Object.assign(ctx.loreIndex, cloneLoreIndex(fresh));
  } catch (e) {
    console.warn("[agent] lore rescan failed; run snapshot keeps its local patches:", e);
  }
}

/**
 * How to get past an alias clash when it is a merge in progress. Every alias
 * clash refusal ends with this, because the natural merge order (copy → alias →
 * delete) hits the clash while the losing entity still resolves — the error
 * must teach the working order, not send the model in a circle.
 */
export const MERGE_ALIAS_HINT =
  'If you are merging the two, finish the merge in this order: copy what is worth keeping, delete the losing entity, and only THEN add its name as an alias — the check clears once the name no longer resolves. Otherwise drop the alias.';

/**
 * What to tell the model when it names a category that does not exist.
 *
 * This used to say "categories cannot be created by tools" full stop. That was
 * right while the only question was "may the agent invent structure on its own"
 * — the answer is still no — but it broke down the moment the author *delegates*
 * a reorganisation: reporting a list of category names in chat and asking them
 * to go create each one by hand is pushing the work back.
 *
 * So creation exists now, and it goes through the plan card
 * (`organizeTools.createLoreCategoryTool`): the agent may **propose** a new
 * category, the author approves it in the same pass they approve everything
 * else. What is still missing on purpose is rename and delete — a category is a
 * folder on disk, so either would relocate every member entry and stale its
 * `[[lore:分类/id]]` path citations.
 *
 * Every "unknown category" error ends with this, so the model reaches for the
 * plan rather than retrying invented ids.
 */
export const NO_CATEGORY_TOOL_HINT =
  "Categories are not invented on the fly — if a new one is genuinely needed, put a plan step with target 'category' in propose_lore_plan and create it with manage_category once the author approves. To group entries by which project they serve, use a collection instead (manage_collection / file_lore_entries).";

/**
 * Gate helper for the write tools: returns the refusal result to hand straight
 * back, or the covering step whose `detail` gets echoed into the success
 * message (so the log shows intent and outcome together).
 */
export function gate(
  toolCallId: string,
  ctx: ToolContext,
  action: LorePlanAction,
  entity: string,
  file?: string,
): { refusal: ToolResult } | { step: LorePlanStep } {
  const check = checkPlan(ctx.lorePlan, ctx.loreIndex, action, entity, file);
  if (!check.ok) {
    recordRefusal(ctx.lorePlan, toolCallId);
    return { refusal: { toolCallId, content: check.message } };
  }
  recordMatch(ctx.lorePlan, toolCallId, check.step);
  return { step: check.step };
}

// ─── destructive steps stop and ask (设计稿 02h 1g / 1i) ────────────────────

/** Files of an entry named on its deletion card before the rest are counted. */
const LORE_STEP_FILES_SHOWN = 8;

/** Longest opening line quoted per file on that card. */
const LORE_STEP_HEAD_CHARS = 80;

/**
 * Put an approved-but-destructive step to the author before writing it.
 *
 * Returns null to go ahead, or the result to hand back when the author skipped.
 * A skip is not a rejection of the plan: the other steps stand, and the model is
 * told so in as many words — "the author rejected" is what it would otherwise
 * generalise to, and it would stop the whole pass.
 *
 * A surface with no card to show keeps today's behaviour rather than refusing:
 * every surface that runs a plan gate can show one (the chat, the task panel,
 * and a pack dispatched from either, which inherits the parent's channel).
 */
export async function pauseForStep(
  toolCallId: string,
  ctx: ToolContext,
  step: LorePlanStep,
  preview: Omit<LoreStepProposal, "kind" | "id" | "detail" | "stepNumber" | "stepTotal">,
): Promise<ToolResult | null> {
  if (!ctx.requestApproval || !ctx.lorePlan) return null;
  const decision = await ctx.requestApproval({
    ...preview,
    kind: "loreStep",
    id: `lore-step-${nextProposalSeq()}`,
    detail: step.detail,
    stepNumber: ctx.lorePlan.steps.indexOf(step) + 1,
    stepTotal: ctx.lorePlan.steps.length,
  });
  if (decision.approved) return null;
  recordSkip(ctx.lorePlan, toolCallId);
  return {
    toolCallId,
    content:
      `The author SKIPPED this step ("${step.detail}")${decision.reason ? ` — reason: ${decision.reason}` : ""}. ` +
      "Nothing was written. The rest of the approved plan still stands: carry on with the other steps, " +
      "and do not retry this one unless the author asks for it.",
  };
}

/** What a 删条目 card shows: the entry's files, their weight, and who cites it. */
export async function entityDeletionPreview(
  ctx: ToolContext,
  entity: LoreEntity,
): Promise<Omit<LoreStepProposal, "kind" | "id" | "detail" | "stepNumber" | "stepTotal">> {
  const names = (entity.mdFiles?.length ? entity.mdFiles : ["index.md"]).filter(
    (name) => !isGalleryManifest(name),
  );
  const files: { name: string; chars: number; head: string }[] = [];
  let totalChars = 0;
  for (const name of names) {
    let raw = "";
    try {
      raw = await readEntityFile(entity.dirPath, name);
    } catch {
      // Listed but unreadable: it still goes, and the row still names it.
    }
    const body = parseFrontmatter(raw).content;
    totalChars += body.length;
    if (files.length < LORE_STEP_FILES_SHOWN) {
      files.push({ name, chars: body.length, head: openingLine(body) });
    }
  }
  const cited = await citingDocuments(ctx.projectPath, entity, ctx.loreIndex);
  return {
    path: entity.dirPath,
    trigger: "deleteEntity",
    entity: entity.name,
    category: entity.category,
    files,
    totalChars,
    fileCount: names.length,
    citedBy: cited.documents,
    ...(cited.complete ? {} : { citedPartial: true as const }),
  };
}

/** What a 替换超过六成 card shows: the two texts when they fit, and the ratio. */
export function rewritePreview(
  path: string,
  entity: LoreEntity,
  file: string,
  before: string,
  after: string,
): Omit<LoreStepProposal, "kind" | "id" | "detail" | "stepNumber" | "stepTotal"> {
  const ratio = rewriteRatio(before, after);
  const fits = before.length <= CHANGE_TEXT_CHARS && after.length <= CHANGE_TEXT_CHARS;
  return {
    path,
    trigger: "majorRewrite",
    entity: entity.name,
    category: entity.category,
    file,
    ...(fits ? { before, after } : {}),
    originalChars: ratio.original,
    removedChars: ratio.removed,
  };
}

/** The first line of prose in a body: a heading names the file, it does not quote it. */
function openingLine(body: string): string {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const prose = lines.find((l) => !l.startsWith("#")) ?? lines[0] ?? "";
  return prose.length > LORE_STEP_HEAD_CHARS ? `${prose.slice(0, LORE_STEP_HEAD_CHARS)}…` : prose;
}

/** An entry file's current text, or null when there is none yet. */
export async function currentText(dirPath: string, file: string): Promise<string | null> {
  try {
    return await readEntityFile(dirPath, file);
  } catch {
    return null;
  }
}
