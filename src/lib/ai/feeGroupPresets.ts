import type { FeeGroup } from "./feeGroup";
import { MODEL_PRESETS, type ModelPreset } from "./modelPresets";

type FeeDraft = Omit<FeeGroup, "id" | "createdAt">;
type TokenRates = readonly [input: number, cachedInput: number | null, output: number];
type Schedule = readonly [label: string, rates: TokenRates];
type PriceEntry = TokenRates | readonly Schedule[];

const gpt = (input: number, cache: number, output: number): readonly Schedule[] => [
  ["≤272k", [input, cache, output]],
  [">272k", [input * 2, cache * 2, output * 1.5]],
];
const geminiPromo = (end: string, start: string, promo: TokenRates, list: TokenRates): readonly Schedule[] => [
  [`≤${end}`, promo], [`≥${start}`, list],
];

const PRICES: Readonly<Record<string, PriceEntry>> = {
  "gpt-6.2-astra": gpt(8, 0.4, 40),
  "gpt-6.2-sol": gpt(2, 0.1, 10),
  "gpt-6.1-sol": gpt(2, 0.1, 10),
  "gpt-6.1-terra": gpt(1, 0.05, 5),
  "gpt-6-astra": gpt(10, 1, 50),
  "gpt-6-sol": gpt(2, 0.2, 10),
  "gpt-6-luna": gpt(0.1, 0.01, 0.5),
  "claude-opus-5-5": [4, 0.2, 20],
  "claude-sonnet-5-5": [2, 0.1, 10],
  "claude-haiku-5-5": [["≤100k", [0.1, 0.01, 0.5]], [">100k", [0.5, 0.05, 2.5]]],
  "claude-opus-5": [5, 0.5, 25],
  "claude-sonnet-5": [2, 0.2, 10],
  "claude-fable-5": [10, 1, 50],
  "claude-opus-4-8": [5, 0.5, 25],
  "claude-opus-4-7": [5, 0.5, 25],
  "claude-opus-4-6": [5, 0.5, 25],
  "claude-sonnet-4-6": [3, 0.3, 15],
  "gemini-4-carbon": geminiPromo("2026-11-30", "2026-12-01", [2, 0.1, 10], [4, 0.2, 20]),
  "gemini-4-argon": geminiPromo("2026-11-30", "2026-12-01", [2, 0.1, 10], [4, 0.2, 20]),
  "gemini-4-neon": [3, 0.15, 15],
  "gemini-4-hydrogen": [1.5, 0.075, 7.5],
  "gemini-3.8-flash": geminiPromo("2026-12-31", "2027-01-01", [0.75, 0.075, 3.75], [1.5, 0.15, 7.5]),
  "qwen4-max": [1.5, 0.075, 4.5],
  "qwen3.8-max": [2, 0.25, 6],
  "qwen3.8-flash": [0.15, 0.016, 0.47],
  "qwen3.7-max": [2.5, 0.5, 7.5],
  "qwen3.7-plus": [["≤256k", [0.4, 0.08, 1.6]], [">256k", [1.2, 0.24, 4.8]]],
  "qwen3.7-flash": [["≤32k", [0.03, 0.006, 0.13]], ["32k–256k", [0.1, 0.02, 0.4]], [">256k", [0.2, 0.04, 0.8]]],
};

const IMAGE_PRICES: Readonly<Record<string, { text: TokenRates; image: TokenRates }>> = {
  "gemini-nano-banana-2.1": { text: [1.5, null, 7.5], image: [1.5, null, 30] },
  "gemini-3.1-flash-image": { text: [0.5, null, 3], image: [0.5, null, 60] },
  "gemini-3-pro-image": { text: [2, null, 12], image: [2, null, 120] },
};
const GPT_IMAGE_PRICES = { text: [5, 1.25, 0], image: [8, 2, 30] } as const;

function feeDraft(model: ModelPreset, name: string, [inputPrice, cacheInputPrice, outputPrice]: TokenRates): FeeDraft {
  return {
    name,
    vendor: model.vendor,
    billingMode: "token",
    inputPrice,
    cacheInputPrice,
    outputPrice,
    requestPrice: 0,
    outputUnit: "image",
    outputRates: [],
    inputUnitPrice: 0,
    inputFreeUnits: 0,
  };
}

function isScheduled(entry: PriceEntry): entry is readonly Schedule[] {
  return Array.isArray(entry[0]);
}

interface FeeGroupPreset {
  id: string;
  label: string;
  source: string;
  draft: FeeDraft;
}

const SOURCES = {
  OpenAI: "https://developers.openai.com/api/docs/pricing",
  Anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
  Google: "https://ai.google.dev/gemini-api/docs/pricing",
  "Alibaba Cloud": "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
} satisfies Record<ModelPreset["vendor"], string>;

/** Published standard USD token rates, checked 2026-11-23. Alibaba Cloud uses Singapore International. */
export const FEE_GROUP_PRESETS: readonly FeeGroupPreset[] = MODEL_PRESETS.flatMap((model) => {
  const name = model.name ? `${model.name} (${model.id})` : model.id;
  const region = model.vendor === "Alibaba Cloud" ? " · Singapore" : "";
  const source = SOURCES[model.vendor];
  const image = model.vendor === "OpenAI" && model.type === "image" ? GPT_IMAGE_PRICES : IMAGE_PRICES[model.id];
  if (image) {
    const [input, cache, output] = image.image;
    return [{ id: model.id, label: name, source, draft: { ...feeDraft(model, name, image.text), imageTokenPrices: { input, cache, output } } }];
  }
  const price = PRICES[model.id];
  if (!price) return [];
  const schedules: readonly Schedule[] = isScheduled(price) ? price : [["", price]];
  return schedules.map(([suffix, rates]) => {
    const label = name + region + (suffix ? ` · ${suffix}` : "");
    return { id: suffix ? `${model.id}:${suffix}` : model.id, label, source, draft: feeDraft(model, label, rates) };
  });
});
