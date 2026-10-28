/** GenerateContent model-specific behavior, not a promise about other protocols.
 * Google documentation checked 2026-10-27; gemini-plan.md §9 (not live-tested).
 */
import { canonicalModelId } from "../modelId";
import type { ProtocolFamily } from "../../types";

interface GeminiProfile {
  /** Total generation budget across continuation hops; the default stays one hop. */
  defaultMaxOutput: number;
  readTimeoutMs: number;
  temperature: false;
}

const ARGON: GeminiProfile = { defaultMaxOutput: 65_536, readTimeoutMs: 1_200_000, temperature: false };

const PROFILES: Partial<Record<ProtocolFamily, readonly { match: RegExp; profile: GeminiProfile }[]>> = {
  gemini: [{ match: /^gemini-4-argon(?:$|-)/, profile: ARGON }],
};

export function geminiProfile(family: ProtocolFamily, modelId: string | undefined): GeminiProfile | undefined {
  const key = canonicalModelId(modelId);
  return PROFILES[family]?.find((row) => row.match.test(key))?.profile;
}
