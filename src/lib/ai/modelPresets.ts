import type { ModelType } from "./configDb";
import type { ReasoningEffort } from "./reasoning";
import { canonicalModelId } from "./capability/modelId";

type ImageThinkingLevel = "minimal" | "low" | "medium" | "high";
const GPT_IMAGE_COMPLEXITY = ["low", "medium", "high"] as const;

export interface ModelPreset {
  id: string;
  vendor: "OpenAI" | "Anthropic" | "Google" | "Alibaba Cloud";
  name?: string;
  type: ModelType;
  contextSize?: number;
  maxOutput?: number;
  aliases?: readonly string[];
  imageThinking?: readonly ImageThinkingLevel[];
}

const gpt = (id: string): ModelPreset =>
  ({ id, vendor: "OpenAI", type: "multimodal", contextSize: 1_050_000, maxOutput: 128_000 });
const gptImage = (id: string, ...aliases: string[]): ModelPreset =>
  ({ id, vendor: "OpenAI", type: "image", aliases, imageThinking: id.startsWith("gpt-image-2.6-") ? GPT_IMAGE_COMPLEXITY : undefined });
const claude = (id: string): ModelPreset =>
  ({ id: `claude-${id}`, vendor: "Anthropic", type: "multimodal", contextSize: 1_000_000, maxOutput: 128_000 });
const gemini = (id: string): ModelPreset =>
  ({ id, vendor: "Google", type: "multimodal", contextSize: 1_048_576, maxOutput: 65_536 });
const banana = (
  id: string, name: string, contextSize: number, imageThinking: readonly ImageThinkingLevel[], ...aliases: string[]
): ModelPreset => ({ id, name, vendor: "Google", type: "image", contextSize, maxOutput: 32_768, aliases, imageThinking });
const qwen = (id: string, type: ModelType, ...aliases: string[]): ModelPreset =>
  ({ id, vendor: "Alibaba Cloud", type, contextSize: 1_000_000, maxOutput: 131_072, aliases });

/** First-party model specifications. The route's thinking resolver supplies the wire category and effort menu. */
export const MODEL_PRESETS: readonly ModelPreset[] = [
  gpt("gpt-6.2-astra"), gpt("gpt-6.2-sol"),
  gpt("gpt-6.1-sol"), gpt("gpt-6.1-terra"),
  gpt("gpt-6-astra"), gpt("gpt-6-sol"), gpt("gpt-6-luna"),
  gptImage("gpt-image-2.6-sunburst"), gptImage("gpt-image-2.6-flare"),
  gptImage("gpt-image-2.5-sunburst", "gpt-image-2.5-sunburst-2026-09-08"),
  gptImage("gpt-image-2.5-flare", "gpt-image-2.5-flare-2026-09-08"),
  gptImage("gpt-image-2", "gpt-image-2-2026-04-21"),
  claude("opus-5-5"), claude("sonnet-5-5"), claude("haiku-5-5"),
  claude("opus-5"), claude("sonnet-5"), claude("fable-5"),
  claude("opus-4-8"), claude("opus-4-7"), claude("opus-4-6"), claude("sonnet-4-6"),
  gemini("gemini-4-carbon"), gemini("gemini-4-argon"),
  gemini("gemini-4-neon"), gemini("gemini-4-hydrogen"), gemini("gemini-3.8-flash"),
  banana("gemini-nano-banana-2.1", "Nano Banana 2.1", 131_072, ["minimal", "medium", "high"]),
  banana("gemini-3.1-flash-image", "Nano Banana 2", 131_072, ["minimal", "high"], "gemini-3.1-flash-image-preview"),
  banana("gemini-3-pro-image", "Nano Banana Pro", 65_536, [], "gemini-3-pro-image-preview"),
  qwen("qwen4-max", "multimodal"),
  qwen("qwen3.8-max", "multimodal", "qwen3.8-max-0902"),
  qwen("qwen3.8-flash", "multimodal"),
  qwen("qwen3.7-max", "text", "qwen3.7-max-2026-05-20"),
  qwen("qwen3.7-plus", "multimodal", "qwen3.7-plus-2026-05-26"),
  qwen("qwen3.7-flash", "multimodal", "qwen3.7-flash-2026-07-15"),
];

export function findModelPreset(modelId: string, relay?: Parameters<typeof canonicalModelId>[1]): ModelPreset | undefined {
  const id = canonicalModelId(modelId, relay)
    .replace(/^(claude-(?:opus|sonnet|haiku)-\d)\.(\d)$/, "$1-$2");
  return MODEL_PRESETS.find((p) => p.id === id || p.aliases?.includes(id));
}

/** The native Gemini image endpoint accepts a subset of the conversational effort enum. */
export function geminiImageThinkingLevel(modelId: string, effort: ReasoningEffort | undefined): string | undefined {
  const preset = findModelPreset(modelId);
  return preset?.vendor === "Google" ? preset.imageThinking?.find((level) => level === effort)?.toUpperCase() : undefined;
}

export function gptImageComplexity(modelId: string, effort: ReasoningEffort | undefined): string | undefined {
  const preset = findModelPreset(modelId);
  return preset?.vendor === "OpenAI" ? preset.imageThinking?.find((level) => level === effort) : undefined;
}
