/**
 * Endpoint URLs for the three wire protocols — every base-URL default and every
 * path built on it lives here.
 *
 * It exists because the three ecosystems disagree about what a "base URL" *is*,
 * and that disagreement is invisible at a `${base}/path` call site:
 *
 *   - **OpenAI and Gemini** bases carry the version segment themselves
 *     (`https://api.openai.com/v1`, `.../v1beta`). That is what `OPENAI_BASE_URL`
 *     and every compatible relay publish, so the path is appended as-is.
 *   - **Anthropic**'s `ANTHROPIC_BASE_URL` is the bare *root*. The official SDKs,
 *     Claude Code, and every third-party gateway's docs expect the client to
 *     append `/v1/messages` itself, so a base copied from those docs
 *     (`https://host/anthropic`) has no `/v1` in it at all.
 *
 * This app used to append only `/messages`, which made an Anthropic base pasted
 * from any third-party doc 404 — the app's convention was the one thing in the
 * ecosystem that differed. So Anthropic bases are normalized back to their root
 * and re-suffixed here, accepting all three shapes authors actually paste
 * (root, root + `/v1`, root + `/v1/messages`), while the other two families are
 * only trimmed.
 *
 * Do not "fix" that asymmetry by teaching the OpenAI branch to append `/v1` too:
 * its bases legitimately end in `/v1` already, and relays that route below one
 * (`https://relay/openai`) would break.
 */

import { familyOf, isCompatStandard, type ApiStandard } from "./types";

export const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";
export const DEFAULT_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
/** Displayed as-is in Settings; `anthropicRoot` strips the `/v1` back off. */
export const DEFAULT_ANTHROPIC_BASE = "https://api.anthropic.com/v1";

/**
 * The endpoint an official provider talks to when its stored `baseUrl` is empty.
 *
 * Official providers store an empty base on purpose: the address is a constant
 * of the vendor's, not a setting, and keeping it out of the database means a
 * vendor domain change is a code edit rather than a data migration.
 */
export function defaultBaseFor(standard: ApiStandard): string {
  switch (familyOf(standard)) {
    case "gemini":
      return DEFAULT_GEMINI_BASE;
    case "anthropic":
      return DEFAULT_ANTHROPIC_BASE;
    default:
      return DEFAULT_OPENAI_BASE;
  }
}

/** Trailing slashes only — the shared, protocol-neutral part of normalization. */
export function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * An Anthropic base reduced to its server root, so a version segment can be
 * appended exactly once.
 *
 * Strips a trailing `/messages` and then a trailing `/v1`, in that order, which
 * covers the three shapes authors paste: the doc-published root, that root plus
 * `/v1` (what this app's own default and its older Settings preset look like),
 * and the full endpoint URL copied out of a curl example.
 *
 * A relay serving `/messages` directly off the root — no `/v1` anywhere — is the
 * one shape this cannot reach. That layout contradicts the Messages API spec,
 * and the adapter's error text names the URL it actually called, so the failure
 * is at least self-explanatory.
 */
export function anthropicRoot(baseUrl: string): string {
  return trimBase(trimBase(baseUrl).replace(/\/messages$/i, "")).replace(/\/v1$/i, "");
}

/** `path` starts with a slash and is relative to the version segment, e.g. "/messages". */
export function anthropicUrl(baseUrl: string, path: string): string {
  return `${anthropicRoot(baseUrl || DEFAULT_ANTHROPIC_BASE)}/v1${path}`;
}

export function openaiUrl(baseUrl: string, path: string): string {
  return `${trimBase(baseUrl || DEFAULT_OPENAI_BASE)}${path}`;
}

/**
 * Gemini bases keep their own version segment (`/v1beta`), so nothing is added.
 * A trailing `/models` is dropped because every path here starts with it, and
 * pasting the model-list URL as the base is an easy mistake to make.
 */
export function geminiUrl(baseUrl: string, path: string): string {
  const base = trimBase(baseUrl || DEFAULT_GEMINI_BASE).replace(/\/models$/i, "");
  return `${base}${path}`;
}

/**
 * Canonical form of a base URL, for comparing two spellings of one endpoint.
 * Anthropic bases reduce to their root so `https://api.anthropic.com` and
 * `https://api.anthropic.com/v1` compare equal.
 */
function canonicalBase(standard: ApiStandard, baseUrl: string): string {
  const base = familyOf(standard) === "anthropic" ? anthropicRoot(baseUrl) : trimBase(baseUrl);
  return base.toLowerCase();
}

/**
 * Re-label a provider stored before the official/compat split.
 *
 * Rows written by earlier versions carry the bare family name (`anthropic`)
 * regardless of where they point, so "official" would silently claim every
 * third-party endpoint — and then lock its address to the vendor's. Anything
 * whose stored base is neither empty nor the vendor's own address is therefore
 * the compat half, and gets to keep the address the author typed.
 *
 * Read-time and idempotent rather than a one-shot DB migration: the same rule
 * has to hold for a config imported from an older export, and applying it in
 * one place means the two paths cannot drift.
 */
export function migrateLegacyStandard(standard: ApiStandard, baseUrl: string): ApiStandard {
  if (isCompatStandard(standard)) return standard;
  // Empty means "use the vendor default", which is exactly what official is.
  if (!trimBase(baseUrl)) return standard;
  if (canonicalBase(standard, baseUrl) === canonicalBase(standard, defaultBaseFor(standard))) {
    return standard;
  }
  return `${standard}_compat` as ApiStandard;
}

/** Family-dispatched model list, the one path all three protocols share. */
export function modelsUrl(standard: ApiStandard, baseUrl: string, query = ""): string {
  switch (familyOf(standard)) {
    case "gemini":
      return geminiUrl(baseUrl, `/models${query}`);
    case "anthropic":
      return anthropicUrl(baseUrl, `/models${query}`);
    default:
      return openaiUrl(baseUrl, `/models${query}`);
  }
}
