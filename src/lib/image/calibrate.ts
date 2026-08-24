/**
 * 人设校准循环：生成 → vision 评审 → 修正 → 重试，直到达标或到轮数上限。
 *
 * 三个部件，职责分开：
 * - `buildImageChecklist` 把实体资料提炼成**看图即可判定**的视觉标准清单
 *   （「银白色长发」是标准，「气质出众」不是）——清单一次生成、全程复用；
 * - `reviewImageAgainstChecklist` 让 vision 模型对照清单逐条判定，并区分
 *   两种失败：提示词写得不到位（给出修订后的完整提示词）和这次抽卡不好
 *   （seedOnly——同一提示词换 seed 再来，正好是 comfy 路由的默认行为）；
 * - `runCalibration` 是纯循环逻辑：不碰网络、不碰 store，生成与评审都是
 *   注入的回调，所以上限、提前达标、最佳轮兜底这些行为可以直接单测。
 *
 * 评审员有噪声，所以两条兜底是设计而不是装饰：**硬轮数上限**（评审员永不
 * 满意也不会空转）和**历史最佳**（到上限时选通过项最多的一轮，而不是最后
 * 一轮）。设计：docs/feature/comfyui-plan.md §5 PR3。
 */

import i18n from "../../i18n";
import { runStructuredTask } from "../agent/structured";
import { pickConnOptions, type ConnOptions } from "../ai/conn";
import type { ContentPart, ToolDefinition } from "../ai/types";

/** Longest slice of entity material the checklist builder reads. */
const MAX_MATERIAL_CHARS = 12_000;
/** Checklist size bounds — fewer is undiagnostic, more is judge fatigue. */
const MAX_CHECKLIST_ITEMS = 10;

// ─── 清单生成 ────────────────────────────────────────────────────────────────

const CHECKLIST_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "emit_image_checklist",
    description: "Return the visual checklist distilled from the material.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "string" },
          description:
            "3–8 short criteria, each decidable by looking at one image (hair color, eye color, a garment, a mark). No personality, no history, no vague qualities.",
        },
      },
      required: ["items"],
    },
  },
};

/** Parse + validate the checklist JSON. Exported for tests. */
export function parseChecklistJson(raw: string): string[] {
  let parsed: { items?: unknown };
  try {
    parsed = JSON.parse(raw) as { items?: unknown };
  } catch {
    throw new Error(`The checklist model did not return valid JSON.\n\n${raw.slice(0, 200)}`);
  }
  const items = (Array.isArray(parsed.items) ? parsed.items : [])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, MAX_CHECKLIST_ITEMS);
  if (!items.length) throw new Error("The checklist model returned no usable criteria.");
  return items;
}

export interface ChecklistOptions extends ConnOptions {
  /** What the picture is of — an entity name. */
  subject: string;
  subjectKind?: string;
  /** The entity's own text — where the visual facts live. */
  material: string;
  /** UI language tag; the checklist is written in it. */
  language: string;
  signal?: AbortSignal;
}

/** Distill the subject's material into decidable visual criteria. */
export async function buildImageChecklist(opts: ChecklistOptions): Promise<string[]> {
  const material =
    opts.material.length > MAX_MATERIAL_CHARS
      ? `${opts.material.slice(0, MAX_MATERIAL_CHARS)}\n…[truncated]`
      : opts.material;
  const lang = opts.language.startsWith("zh") ? "简体中文" : "English";
  const raw = await runStructuredTask({
    ...pickConnOptions(opts),
    systemPrompt: i18n.t("ai.instructions.imageChecklist", { lang }),
    toolInstruction: `\nCall ${CHECKLIST_TOOL.function.name} exactly once with the result.`,
    jsonInstruction:
      '\nRespond with ONLY a JSON object: {"items": string[]}. No markdown fences, no commentary.',
    outputTool: CHECKLIST_TOOL,
    userContent: [
      `Subject: ${opts.subject}${opts.subjectKind ? ` (${opts.subjectKind})` : ""}`,
      material.trim() ? `Material:\n${material.trim()}` : "",
      "Produce the checklist.",
    ].filter(Boolean).join("\n\n"),
    signal: opts.signal,
  });
  return parseChecklistJson(raw);
}

// ─── 评审 ────────────────────────────────────────────────────────────────────

export interface ReviewVerdict {
  criterion: string;
  pass: boolean;
  note?: string;
}

export interface CalibrationReview {
  results: ReviewVerdict[];
  /** Full revised positive prompt, when the wording is what failed. */
  revisedPrompt?: string;
  /** True when the prompt is fine and only this draw went wrong. */
  seedOnly?: boolean;
}

const REVIEW_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "emit_image_review",
    description: "Return the verdict for each checklist item.",
    parameters: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              criterion: { type: "string", description: "The checklist item, verbatim." },
              pass: { type: "boolean" },
              note: { type: "string", description: "Why it failed, one short clause. Omit when it passed." },
            },
            required: ["criterion", "pass"],
          },
        },
        revisedPrompt: {
          type: "string",
          description:
            "The COMPLETE revised positive prompt, only when failures come from the prompt's wording. Keep the original language and style terms; change only what must change.",
        },
        seedOnly: {
          type: "boolean",
          description:
            "True when the prompt is adequate and the failures are this particular draw (broken anatomy, collapsed composition) — retry with a new seed, no prompt change.",
        },
      },
      required: ["results"],
    },
  },
};

/**
 * Parse + validate a review. Exported for tests.
 *
 * The verdicts are re-aligned to the checklist when the counts match: the
 * criteria the author reads must stay the ones the app asked about, not the
 * reviewer's paraphrase of them.
 */
export function parseReviewJson(raw: string, checklist: string[]): CalibrationReview {
  let parsed: { results?: unknown; revisedPrompt?: unknown; seedOnly?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error(`The reviewer did not return valid JSON.\n\n${raw.slice(0, 200)}`);
  }
  const rows = (Array.isArray(parsed.results) ? parsed.results : [])
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((r) => ({
      criterion: typeof r.criterion === "string" ? r.criterion.trim() : "",
      pass: r.pass === true,
      ...(typeof r.note === "string" && r.note.trim() ? { note: r.note.trim() } : {}),
    }))
    .filter((r) => r.criterion);
  if (!rows.length) throw new Error("The reviewer returned no verdicts.");
  const results =
    rows.length === checklist.length
      ? rows.map((r, i) => ({ ...r, criterion: checklist[i] }))
      : rows;
  const revised = typeof parsed.revisedPrompt === "string" ? parsed.revisedPrompt.trim() : "";
  return {
    results,
    ...(revised ? { revisedPrompt: revised } : {}),
    ...(parsed.seedOnly === true ? { seedOnly: true } : {}),
  };
}

export interface ReviewOptions extends ConnOptions {
  /** The candidate, as a data URL. */
  dataUrl: string;
  checklist: string[];
  /** The positive prompt this round used — what a revision starts from. */
  prompt: string;
  language: string;
  signal?: AbortSignal;
}

/** Judge one image against the checklist, on a vision-capable model. */
export async function reviewImageAgainstChecklist(opts: ReviewOptions): Promise<CalibrationReview> {
  const lang = opts.language.startsWith("zh") ? "简体中文" : "English";
  const userContent: ContentPart[] = [
    {
      type: "text",
      text: [
        `Checklist:\n${opts.checklist.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
        `The prompt this image was generated from:\n${opts.prompt}`,
        "Judge the image against every checklist item.",
      ].join("\n\n"),
    },
    { type: "image_url", image_url: { url: opts.dataUrl } },
  ];
  const raw = await runStructuredTask({
    ...pickConnOptions(opts),
    systemPrompt: i18n.t("ai.instructions.imageReview", { lang }),
    toolInstruction: `\nCall ${REVIEW_TOOL.function.name} exactly once with the result.`,
    jsonInstruction:
      '\nRespond with ONLY a JSON object: {"results": [{"criterion": string, "pass": boolean, "note"?: string}], "revisedPrompt"?: string, "seedOnly"?: boolean}. No markdown fences, no commentary.',
    outputTool: REVIEW_TOOL,
    userContent,
    signal: opts.signal,
  });
  return parseReviewJson(raw, opts.checklist);
}

// ─── 循环 ────────────────────────────────────────────────────────────────────

export interface CalibrationRound {
  /** 0-based. */
  round: number;
  /** The positive prompt this round generated with. */
  prompt: string;
  /** Whatever handle `generate` returned — a scratch path in the app. */
  image: string;
  review: CalibrationReview;
  passCount: number;
  total: number;
}

export interface CalibrationRun {
  rounds: CalibrationRound[];
  /** Index into `rounds` of the best round, or -1 when none completed. */
  bestIndex: number;
  /** True when some round passed every criterion. */
  passed: boolean;
}

export interface CalibrationLoopOptions {
  basePrompt: string;
  maxRounds: number;
  /**
   * Generate one round; resolve with an image handle, or null to end the
   * loop (generation failed or the author stopped it).
   */
  generate: (prompt: string, round: number) => Promise<string | null>;
  review: (image: string, prompt: string) => Promise<CalibrationReview>;
  /** Fired after each round's review lands — where the UI annotates the turn. */
  onRound?: (round: CalibrationRound) => void;
  signal?: AbortSignal;
}

/**
 * Drive the loop. Prompt evolution: a `revisedPrompt` from a non-seedOnly
 * review replaces the working prompt for the next round; a seedOnly verdict
 * keeps it (the caller's generator re-rolls the seed anyway — on the comfy
 * route that is its default behaviour).
 */
export async function runCalibration(opts: CalibrationLoopOptions): Promise<CalibrationRun> {
  const rounds: CalibrationRound[] = [];
  let prompt = opts.basePrompt;
  let passed = false;

  for (let i = 0; i < Math.max(1, opts.maxRounds); i++) {
    if (opts.signal?.aborted) break;
    const image = await opts.generate(prompt, i);
    if (image === null) break;
    const review = await opts.review(image, prompt);
    const passCount = review.results.filter((r) => r.pass).length;
    const round: CalibrationRound = {
      round: i,
      prompt,
      image,
      review,
      passCount,
      total: review.results.length,
    };
    rounds.push(round);
    opts.onRound?.(round);

    if (passCount === round.total) {
      passed = true;
      break;
    }
    if (review.revisedPrompt && !review.seedOnly) prompt = review.revisedPrompt;
  }

  // Best = most criteria passed; ties go to the *later* round, which sits
  // after more prompt fixes and is the one the author was steering toward.
  let bestIndex = -1;
  for (let i = 0; i < rounds.length; i++) {
    if (bestIndex === -1 || rounds[i].passCount >= rounds[bestIndex].passCount) bestIndex = i;
  }
  return { rounds, bestIndex, passed };
}
