/**
 * Remote provider probing: list available models and test connectivity.
 * Pure HTTP — no local storage involved (that's ./configDb).
 *
 * Both entry points lead with `/models`, because when it exists it answers both
 * questions at once (reachable, authenticated) and costs nothing. Plenty of
 * compatible relays implement only the completion endpoint, though — for them a
 * missing `/models` says nothing about whether the provider works, so on a
 * compat standard that case falls through to `probeCompletionEndpoint` rather
 * than being reported as a failure. See docs/provider-standards.md §5.
 */

import i18n from "../../i18n";
import { anthropicHeaders } from "./anthropic";
import { fetch } from "../http";
import { familyOf, isCompatStandard, type ApiStandard, type AuthMode } from "./types";
import { anthropicUrl, geminiUrl, modelsUrl, openaiUrl } from "./urls";

/**
 * Statuses that mean "this server does not serve this path", as opposed to a
 * server that served it and refused. Anything else — 401, 429, 500 — is about
 * the request or the server itself and is reported as-is.
 */
const ENDPOINT_ABSENT = new Set([404, 405, 501]);

/**
 * Model id used by the fallback probe.
 *
 * Deliberately one that cannot exist: connection tests run before the author
 * has chosen a model, and a name the endpoint recognises would bill a real
 * (if tiny) generation. What the probe reads is the *shape* of the rejection,
 * not the result — see `judgeCompletionProbe`.
 */
const PROBE_MODEL = "__connection_probe__";

/** Fetch the available model list from a provider's /models endpoint (OpenAI-style). */
export async function fetchRemoteModels(
  baseUrl: string,
  apiKey: string,
  standard: ApiStandard,
  authMode?: AuthMode
): Promise<{ id: string; name: string }[]> {
  const family = familyOf(standard);
  if (family === "gemini") {
    // Key goes in the x-goog-api-key header, never the URL — query strings
    // leak into proxy/server logs and error messages. Matches streamGemini.
    const url = modelsUrl(standard, baseUrl);
    const res = await fetch(url, { headers: { "x-goog-api-key": apiKey } });
    if (!res.ok) throw modelsFetchError(res.status, standard, "Gemini");
    const data = await res.json();
    return (data.models ?? []).map((m: Record<string, string>) => ({
      id: m.name?.replace("models/", "") ?? m.name,
      name: m.displayName ?? m.name,
    }));
  }
  if (family === "anthropic") {
    // Same `{ data: [...] }` envelope as OpenAI, but keyed auth headers and a
    // human label of its own (`display_name` — "Claude Sonnet 5" rather than
    // the bare id).
    const res = await fetch(modelsUrl(standard, baseUrl), {
      headers: anthropicHeaders(apiKey, authMode),
    });
    if (!res.ok) throw modelsFetchError(res.status, standard, "Anthropic");
    const data = await res.json();
    return (data.data ?? []).map((m: Record<string, string>) => ({
      id: m.id,
      name: m.display_name ?? m.id,
    }));
  }
  // OpenAI / compatible
  const res = await fetch(modelsUrl(standard, baseUrl), {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!res.ok) throw modelsFetchError(res.status, standard, "");
  const data = await res.json();
  return (data.data ?? []).map((m: Record<string, string>) => ({
    id: m.id,
    name: m.id,
  }));
}

/**
 * Why the model list is missing, phrased for whoever has to act on it.
 *
 * A relay with no `/models` is a normal configuration, not a broken one — the
 * model id field takes typing — so that case says so instead of reporting a
 * bare status the author would reasonably read as "my key is wrong".
 */
function modelsFetchError(status: number, standard: ApiStandard, label: string): Error {
  if (isCompatStandard(standard) && ENDPOINT_ABSENT.has(status)) {
    return new Error(i18n.t("aiConfig.providers.modelsUnavailable", { status }));
  }
  return new Error(`${label ? `${label} ` : ""}models fetch failed: ${status}`);
}

export async function testProviderConnection(
  baseUrl: string,
  apiKey: string,
  standard: ApiStandard,
  authMode?: AuthMode
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  try {
    const family = familyOf(standard);
    const query = family === "gemini" ? "?pageSize=1" : family === "anthropic" ? "?limit=1" : "";
    const url = modelsUrl(standard, baseUrl, query);
    const res = await fetch(url, { headers: probeHeaders(standard, apiKey, authMode) });

    if (!res.ok) {
      if (isCompatStandard(standard) && ENDPOINT_ABSENT.has(res.status)) {
        return probeCompletionEndpoint(baseUrl, apiKey, standard, authMode);
      }
      const error = await res.text();
      return { ok: false, error: `API error ${res.status} (${url}): ${error}` };
    }

    if (family !== "openai") {
      return { ok: true, message: i18n.t("aiConfig.providers.testOk") };
    }
    const data = await res.json();
    const models = (data.data ?? []) as Array<{ id?: string }>;
    return { ok: true, message: i18n.t("aiConfig.providers.testOkModels", { count: models.length }) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Connection failed: ${msg}` };
  }
}

function probeHeaders(
  standard: ApiStandard,
  apiKey: string,
  authMode?: AuthMode,
): Record<string, string> {
  switch (familyOf(standard)) {
    case "gemini":
      return { "Content-Type": "application/json", "x-goog-api-key": apiKey };
    case "anthropic":
      return anthropicHeaders(apiKey, authMode);
    default:
      return {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      };
  }
}

/**
 * Second opinion for a compat endpoint with no `/models`: post the smallest
 * possible completion and read the rejection.
 *
 * The connection test runs before a model is chosen, so this can't ask a
 * question the endpoint would answer successfully. It doesn't need to — the
 * three outcomes that matter are all distinguishable from a rejection:
 * unreachable (no response, or one that isn't the API), unauthenticated
 * (401/403), and reachable-and-authenticated (the API rejects the made-up model
 * in its own error format, which only something speaking this protocol does).
 */
async function probeCompletionEndpoint(
  baseUrl: string,
  apiKey: string,
  standard: ApiStandard,
  authMode?: AuthMode,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const { url, body } = completionProbeRequest(standard, baseUrl);
  const res = await fetch(url, {
    method: "POST",
    headers: probeHeaders(standard, apiKey, authMode),
    body: JSON.stringify(body),
  });

  // A made-up model answered successfully means the endpoint ignores the field
  // — unusual, but it is still reachable and it still took the key.
  if (res.ok) return { ok: true, message: i18n.t("aiConfig.providers.testOkNoModels") };

  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: i18n.t("aiConfig.providers.testAuthFailed", { status: res.status }) };
  }
  const apiMessage = apiErrorMessage(text);
  if (apiMessage !== null) {
    return {
      ok: true,
      message: i18n.t("aiConfig.providers.testOkModelRejected", {
        detail: apiMessage.slice(0, 200) || `HTTP ${res.status}`,
      }),
    };
  }
  return { ok: false, error: `API error ${res.status} (${url}): ${text.slice(0, 300)}` };
}

function completionProbeRequest(
  standard: ApiStandard,
  baseUrl: string,
): { url: string; body: Record<string, unknown> } {
  const messages = [{ role: "user", content: "hi" }];
  switch (familyOf(standard)) {
    case "gemini":
      return {
        url: geminiUrl(baseUrl, `/models/${PROBE_MODEL}:generateContent`),
        body: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: 1 },
        },
      };
    case "anthropic":
      return {
        url: anthropicUrl(baseUrl, "/messages"),
        body: { model: PROBE_MODEL, max_tokens: 1, messages },
      };
    default:
      return {
        url: openaiUrl(baseUrl, "/chat/completions"),
        body: { model: PROBE_MODEL, max_tokens: 1, messages, stream: false },
      };
  }
}

/**
 * The human-readable message out of an API error body, or null when the body
 * isn't one.
 *
 * This is the whole "is it really the API?" test: all three protocols reject a
 * bad request with a JSON object carrying an `error`, and a proxy, a login
 * page, or a CDN 404 does not. Getting HTML back is exactly the case where a
 * base URL points somewhere that isn't the endpoint, so it must not read as
 * success.
 */
function apiErrorMessage(body: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const error = (json as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }
  // Gemini nests differently on some paths, and a few relays answer with a bare
  // `{"message": "..."}`; treat any of them as the API having spoken.
  const message = (json as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}
