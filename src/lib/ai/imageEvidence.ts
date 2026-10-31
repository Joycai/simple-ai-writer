/** Provider evidence survives decoding, downloads and cancellation. */
import { usageSnapshot } from "./streamUsage";
import { costReportingPlatform, reportedCostOf } from "./reportedCost";
import { effectiveImageRoute } from "./imageRoute";
import type { ImageConn } from "./image";

interface ImageTokenBucket { inputTokens?: number; cachedTokens?: number; outputTokens?: number; }
export interface ImageEvidence {
  requestId?: string;
  taskKey?: string;
  pendingTask?: string;
  partial?: boolean;
  requests?: number;
  outcome: "complete" | "failed" | "cancelled";
  usage?: ImageTokenBucket;
  modalities?: { text?: ImageTokenBucket; image?: ImageTokenBucket };
  rawUsage?: unknown;
  reportedCost?: number;
  generatedImages?: number;
  spec: { size?: string; quality?: string };
}
const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const count = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

export function captureImageEvidence(target: ImageEvidence, raw: unknown, conn: ImageConn): void {
  const json = obj(raw);
  const route = effectiveImageRoute(conn.standard, conn);
  const family = route === "gemini" ? "gemini" : route === "chat" ? "openai" : "responses";
  const usage = obj(json.usageMetadata ?? json.usage);
  if (Object.keys(usage).length) {
    target.rawUsage = usage;
    // Ark output_tokens is a pixel proxy, not billable language-model tokens.
    if (route !== "ark" && route !== "dashscope") target.usage = usageSnapshot(family, usage);
    target.reportedCost = reportedCostOf(costReportingPlatform(conn), family, usage);
    const generated = count(usage.generated_images ?? usage.image_count);
    if (generated !== undefined) target.generatedImages = generated;
    if (typeof usage.size === "string") target.spec.size = usage.size;
    else if (count(usage.output_width) && count(usage.output_height)) target.spec.size = `${usage.output_width}x${usage.output_height}`;
    const input = obj(usage.input_tokens_details);
    const output = { ...obj(usage.output_tokens_details) };
    const cached = obj(input.cached_tokens_details);
    // The direct Images endpoint produces image tokens only; Responses also
    // has driver text tokens, so this fallback must never apply there.
    if (route === "images-api" && count(usage.output_tokens) !== undefined && output.image_tokens === undefined && !Object.keys(output).length) {
      output.image_tokens = usage.output_tokens; output.text_tokens = 0;
    }
    if (Object.keys(input).length || Object.keys(output).length) {
      target.modalities = {
        text: { inputTokens: count(input.text_tokens), outputTokens: count(output.text_tokens), cachedTokens: count(cached.text_tokens) },
        image: { inputTokens: count(input.image_tokens), outputTokens: count(output.image_tokens), cachedTokens: count(cached.image_tokens) },
      };
    }
    if (route === "gemini") {
      const bucket = (details: unknown, modality: string) => {
        if (!Array.isArray(details)) return undefined;
        const entry = details.find(e => obj(e).modality === modality);
        return count(obj(entry).tokenCount);
      };
      if (Array.isArray(usage.promptTokensDetails) || Array.isArray(usage.candidatesTokensDetails)) {
        target.modalities = Object.fromEntries(["TEXT", "IMAGE"].map(modality => [modality.toLowerCase(), {
          inputTokens: bucket(usage.promptTokensDetails, modality),
          cachedTokens: bucket(usage.cacheTokensDetails, modality),
          outputTokens: bucket(usage.candidatesTokensDetails, modality),
        }]));
      }
    }

  }
  if (typeof json.size === "string") target.spec.size = json.size;
  if (typeof json.quality === "string") target.spec.quality = json.quality;
  if (Array.isArray(json.data)) {
    if (json.data.some(e => obj(e).error)) target.partial = true;
    const sizes = json.data.map(e => obj(e).size).filter((v): v is string => typeof v === "string");
    if (sizes.length && sizes.every(size => size === sizes[0])) target.spec.size = sizes[0];
  }
  if (target.generatedImages === undefined && Array.isArray(json.data)) {
    target.generatedImages = json.data.filter(e => obj(e).url || obj(e).b64_json).length;
  }
}
