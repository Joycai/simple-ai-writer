/**
 * Turn written material into an image prompt.
 *
 * The author never has to speak "prompt language": a lore entity's own text
 * (plus whatever direction they typed) goes in, a structured prompt spec comes
 * out, and it lands in an editable box before anything is generated.
 *
 * Runs on the shared structured-output path (forced tool call, JSON fallback)
 * rather than free prose, so the style and aspect ratio arrive as separate
 * fields the UI can bind controls to instead of a blob to regex.
 */

import i18n from "../../i18n";
import { runStructuredTask } from "../agent/structured";
import { pickConnOptions, type ConnOptions } from "../ai/conn";
import type { ToolDefinition } from "../ai/types";
import { promptParams } from "../profile/active";

/** Aspect ratios offered to the model. Kept small — every backend supports these. */
export const IMAGE_ASPECTS = ["1:1", "3:4", "4:3", "16:9", "9:16"] as const;
export type ImageAspect = (typeof IMAGE_ASPECTS)[number];

export interface ImagePromptSpec {
  /** The prompt itself, in `promptLanguage`. */
  prompt: string;
  /** Things to keep out of the frame. Empty when the model offered none. */
  negative: string;
  /** Art-direction clause, kept separate so the author can swap looks alone. */
  style: string;
  aspect: ImageAspect;
  /** One line in the UI language explaining what this picture is meant to be. */
  note: string;
}

export interface ImagePromptOptions extends ConnOptions {
  /** What the picture is of — an entity name, a scene title. */
  subject: string;
  /** Category/type label for the subject, e.g. 角色 / 场景 / 产品. */
  subjectKind?: string;
  /** Source text the prompt must be faithful to (entity body, selection…). */
  material: string;
  /** The author's own direction ("侧面半身，雨中"). May be empty. */
  instruction?: string;
  /**
   * Descriptions of images already in the subject's gallery. These are what
   * keeps a second picture of the same character recognisably the same
   * character, which is the whole reason gallery descriptions exist.
   */
  references?: string[];
  /** Language the prompt/style/negative fields are written in. */
  promptLanguage: "en" | "zh";
  /** UI language tag (e.g. "zh-CN") — controls `note` only. */
  language: string;
  signal?: AbortSignal;
  /** Raw streamed text, for a live "thinking" area. */
  onText?: (accumulated: string) => void;
}

/** Longest slice of source material sent along. Entity bodies can be huge. */
const MAX_MATERIAL_CHARS = 12_000;

const OUTPUT_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "emit_image_prompt",
    description: "Return the image prompt built from the supplied material.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "The image prompt: concrete visual nouns — subject, appearance, clothing, pose, setting, lighting, framing. No narrative, no names the model cannot see.",
        },
        negative: {
          type: "string",
          description: "What must not appear. Empty string when there is nothing to exclude.",
        },
        style: {
          type: "string",
          description: "Art direction as a short clause, e.g. 'cinematic oil painting, muted palette'.",
        },
        aspect: {
          type: "string",
          enum: [...IMAGE_ASPECTS],
          description: "Aspect ratio best suited to the framing.",
        },
        note: {
          type: "string",
          description: "One sentence, in the UI language, telling the author what this picture will show.",
        },
      },
      required: ["prompt", "note"],
    },
  },
};

/**
 * Build the system prompt. Deliberately domain-neutral: the subject's own
 * category label carries the domain ("角色" vs "产品"), so a 标书 project gets
 * a diagram brief and a novel gets a portrait brief from the same text.
 */
function systemPromptFor(opts: ImagePromptOptions): string {
  const isZh = opts.language.startsWith("zh");
  const params = promptParams(isZh);
  const promptLang = opts.promptLanguage === "zh" ? "简体中文" : "English";
  const noteLang = isZh ? "简体中文" : "English";

  return [
    i18n.t("ai.instructions.imagePrompt", {
      ...params,
      promptLang,
      noteLang,
    }),
  ].join("\n");
}

function buildUserContent(opts: ImagePromptOptions): string {
  const material =
    opts.material.length > MAX_MATERIAL_CHARS
      ? `${opts.material.slice(0, MAX_MATERIAL_CHARS)}\n…[truncated]`
      : opts.material;

  const refs = (opts.references ?? []).filter((r) => r.trim());
  return [
    `Subject: ${opts.subject}${opts.subjectKind ? ` (${opts.subjectKind})` : ""}`,
    opts.instruction?.trim() ? `Author's direction (highest priority):\n${opts.instruction.trim()}` : "",
    material.trim() ? `Source material:\n${material.trim()}` : "",
    refs.length
      ? `Existing reference images of this subject — match their look so the new picture is recognisably the same subject:\n${refs
          .map((r, i) => `${i + 1}. ${r.trim()}`)
          .join("\n")}`
      : "",
    "Produce the image prompt.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Generate one image-prompt spec. Throws on transport/model failure. */
export async function generateImagePrompt(opts: ImagePromptOptions): Promise<ImagePromptSpec> {
  const raw = await runStructuredTask({
    ...pickConnOptions(opts),
    systemPrompt: systemPromptFor(opts),
    toolInstruction: `\nCall ${OUTPUT_TOOL.function.name} exactly once with the result.`,
    jsonInstruction:
      '\nRespond with ONLY a JSON object: {"prompt": string, "negative": string, "style": string, "aspect": "1:1"|"3:4"|"4:3"|"16:9"|"9:16", "note": string}. No markdown fences, no commentary.',
    outputTool: OUTPUT_TOOL,
    userContent: buildUserContent(opts),
    signal: opts.signal,
    onText: opts.onText,
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Model did not return a valid prompt object.\n\n${raw.slice(0, 300)}`);
  }

  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const prompt = str(parsed.prompt);
  if (!prompt) throw new Error("Model returned an empty image prompt.");
  const aspect = IMAGE_ASPECTS.includes(parsed.aspect as ImageAspect)
    ? (parsed.aspect as ImageAspect)
    : "1:1";

  return { prompt, negative: str(parsed.negative), style: str(parsed.style), aspect, note: str(parsed.note) };
}

/**
 * Flatten a spec into the single string the image endpoints actually take.
 * Negative prompts have no portable wire field across OpenAI/Gemini/xAI, so
 * they ride along as an explicit clause rather than being silently dropped.
 */
export function specToPrompt(spec: ImagePromptSpec): string {
  return [
    spec.prompt,
    spec.style ? `Style: ${spec.style}` : "",
    spec.negative ? `Avoid: ${spec.negative}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
