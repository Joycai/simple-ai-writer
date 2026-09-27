/**
 * What can be asked about, and the shape of an answer — the capability ids,
 * the reason codes, and the order the generated matrix lists them in.
 *
 * Split out of `capabilities.ts` (docs/api/capability-resolution-lld.md P1);
 * `capabilities.ts` re-exports everything here, so callers import from there.
 */

import type { ServerToolId } from "../serverTools";


/** What can be asked about. A server tool's id is a capability id. */
export type CapabilityId =
  | "pdfInput"
  | "vlHighResolution"
  | "videoInput"
  | "videoFps"
  | "forcedToolChoice"
  | "effortWithTools"
  | "reasoningOff"
  | "effortMax"
  | "effortMinimal"
  | "temperature"
  | "textVerbosity"
  | "instructionsField"
  | "translateFormat"
  | "structuredOutput"
  | "jsonSchema"
  | "jsonObjectTier"
  | "promptCache"
  | ServerToolId;

/**
 * How sure the app is.
 *
 *   - `yes`: the platform lists it (measured), or the protocol itself defines
 *     it and nothing says this platform differs.
 *   - `unknown`: plausible but unmeasured — a relay that may or may not pass
 *     the field on, or a model id the platform's list neither names nor
 *     rules out. Offered and sent; the drawer says so.
 *   - `no`: nothing to send. A declaration on the model row is kept and simply
 *     not sent (channel-model-route-plan §7 invariant 4).
 */
export type CapabilityStatus = "yes" | "unknown" | "no";

/**
 * Why — a closed set so tests can assert it. The sentences live in the locale
 * files only, as `aiConfig.capReason.<reason>` in both languages (the same
 * split as `ThemeReasonCode`): a test can hold the reason, and the wording can
 * change without touching the logic. `capabilities.test.ts` holds every reason
 * to a sentence in each language.
 *
 *   - `measured`: the platform's table lists it for this family.
 *   - `protocol`: part of the protocol; no platform entry contradicts it.
 *   - `unmeasured`: the protocol defines it, but nobody measured whether this platform passes it on.
 *   - `relay`: a private field on a relay that may front the platform that owns it.
 *   - `platform-absent`: the platform's table says this wire does not take it (or takes and ignores it).
 *   - `platform-unlisted`: a private field, and this platform is not one that was measured taking it.
 *   - `family`: no spelling on this protocol family.
 *   - `model`: the platform runs it, but was measured refusing (or ignoring) it for this model id.
 *   - `model-unlisted`: the platform runs it for some model ids, and this one was never measured.
 *   - `model-type`: the model's type rules it out (a text model reads no frames).
 *   - `requires`: a capability it depends on is unavailable.
 *   - `thinking`: this family refuses it while the model thinks (Anthropic's temperature).
 *   - `upstream`: the relay's upstream behind this model was measured this way — either way,
 *     working or not (UPSTREAM_CELLS).
 *   - `condition`: this request's own condition rules it out — function tools beside it, or thinking
 *     off where it needs thinking (`rules.ts` `unless`). Only an adapter asks with the request.
 *   - `learned`: the tables allow it, but this endpoint+model answered it with a 400 earlier this
 *     session (`capability/learned.ts`); it is no longer sent until the app restarts.
 */
export const CAPABILITY_REASONS = [
  "measured", "protocol", "unmeasured", "relay", "platform-absent", "platform-unlisted",
  "family", "model", "model-unlisted", "model-type", "requires", "thinking", "upstream", "condition", "learned",
] as const;
export type CapabilityReason = (typeof CAPABILITY_REASONS)[number];

export interface CapabilityVerdict {
  status: CapabilityStatus;
  reason: CapabilityReason;
}

/**
 * Every id, in the order the generated matrix lists them. Spelled out rather
 * than read off the object's keys so that tidying the table above cannot
 * reshuffle docs/api/capability-matrix.md and bury the one cell that moved;
 * `capabilities.test.ts` holds it complete.
 */
export const CAPABILITY_IDS: readonly CapabilityId[] = [
  "pdfInput", "vlHighResolution", "videoInput", "videoFps", "forcedToolChoice", "effortWithTools", "reasoningOff", "effortMax", "effortMinimal",
  "temperature", "textVerbosity", "instructionsField", "translateFormat", "structuredOutput", "jsonSchema", "jsonObjectTier",
  "promptCache",
  "web_search", "web_extractor", "web_search_image", "image_search", "code_interpreter",
];

/**
 * The ids that are endpoint-run tools. A `Record` so that a new
 * `ServerToolId` does not compile until it is listed — {@link hasAnyServerTool}
 * walks this, and an id it skipped would fold the drawer's section shut.
 */
const SERVER_TOOL_FLAGS: Record<ServerToolId, true> = {
  web_search: true, web_extractor: true, web_search_image: true, image_search: true, code_interpreter: true,
};
export const SERVER_TOOL_CAPABILITIES = Object.keys(SERVER_TOOL_FLAGS) as ServerToolId[];
