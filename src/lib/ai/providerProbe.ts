/**
 * Remote provider probing: list available models and test connectivity.
 * Pure HTTP — no local storage involved (that's ./configDb).
 *
 * Both entry points lead with `/models`, because when it exists it answers both
 * questions at once (reachable, authenticated) and costs nothing. Plenty of
 * compatible relays implement only the completion endpoint, though — for them a
 * missing `/models` says nothing about whether the provider works, so on a
 * compat standard that case falls through to `probeCompletionEndpoint` rather
 * than being reported as a failure. See docs/api/provider-standards.md §5.
 */

import i18n from "../../i18n";
import { anthropicHeaders } from "./anthropic";
import { fetch } from "../http";
import { geminiAuthHeaders } from "./gemini";
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
    // Same header choice as streamGemini — a relay that wants Bearer would
    // 401 here too, leaving the author with an empty model list and no clue.
    const url = modelsUrl(standard, baseUrl);
    const res = await fetch(url, { headers: geminiAuthHeaders(apiKey, authMode) });
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
    return (data.data ?? [])
      // A relay serving several protocols off one catalogue may say which of
      // them each model answers on (OrcaRouter's `supported_endpoint_types`:
      // `["anthropic", "openai"]` on a Claude, `["openai"]` alone on a GPT).
      // A model listed without this surface would only 4xx at /messages, so it
      // is left out; no declaration, or one of another shape, keeps the row —
      // the official list carries no such field and must read as before.
      .filter((m: Record<string, unknown>) => {
        const surfaces = m.supported_endpoint_types;
        return !Array.isArray(surfaces) || surfaces.includes("anthropic");
      })
      .map((m: Record<string, string>) => ({
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

/**
 * Connectivity test for a ComfyUI instance.
 *
 * A separate entry point rather than a branch inside `testProviderConnection`,
 * because ComfyUI answers none of the questions that one asks: it has no
 * `/models`, no completion endpoint and no key. `/system_stats` is its cheapest
 * "are you there" and it names its own version, so a success can say something
 * the author can act on.
 *
 * The 403 branch is the whole reason this exists. ComfyUI runs an
 * anti-DNS-rebinding middleware by default (whenever it is started without
 * `--enable-cors-header`) that rejects any request whose Origin host differs
 * from its Host header — *before routing*, so every path answers 403 and
 * nothing about the request body can change it. `lib/http` attaches such an
 * Origin to every local request (it has to: Ollama's allowlist rejects the
 * webview's own). Without this message the author sees a reachable, healthy
 * ComfyUI refuse everything and has no way to learn why — see
 * docs/feature/comfyui-plan.md §7.1.
 */
export async function testComfyUiConnection(
  baseUrl: string,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) return { ok: false, error: i18n.t("aiConfig.providers.testMissingFields") };
  try {
    const res = await fetch(`${base}/system_stats`);
    if (res.status === 403) {
      return { ok: false, error: i18n.t("aiConfig.providers.comfyTestForbidden") };
    }
    if (!res.ok) {
      return { ok: false, error: `API error ${res.status} (${base}/system_stats)` };
    }
    const data = (await res.json()) as { system?: { comfyui_version?: string } };
    const version = data.system?.comfyui_version;
    return {
      ok: true,
      message: version
        ? i18n.t("aiConfig.providers.comfyTestOk", { version })
        : i18n.t("aiConfig.providers.testOk"),
    };
  } catch (e) {
    // A refused connection is the other half of the diagnosis: the middleware
    // answers, a stopped ComfyUI does not.
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: i18n.t("aiConfig.providers.comfyTestUnreachable", { detail: msg }) };
  }
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

    // Gemini and Anthropic answered a one-item page; only the two OpenAI-shaped
    // families (which share `/models`) return a list worth counting.
    if (family === "gemini" || family === "anthropic") {
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
      return { "Content-Type": "application/json", ...geminiAuthHeaders(apiKey, authMode) };
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
  // 402 is the relay's credit gate (OrcaRouter answers every completion call
  // on an empty account with it, before looking at the model). The key is
  // right and the endpoint spoke, but nothing will run until the author tops
  // up — reporting that as "reachable" would send them looking for a bug in
  // the model id instead. Its own message names the amount, so hand it over.
  if (res.status === 402) {
    return { ok: false, error: `HTTP 402: ${apiMessage?.slice(0, 300) || text.slice(0, 300)}` };
  }
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
    case "responses":
      // A Responses-only relay need not serve /chat/completions, so the
      // fallback has to speak this family's own shape. 16 is the documented
      // minimum for max_output_tokens; the made-up model is refused before it
      // matters. store:false for the same reason the adapter sends it.
      return {
        url: openaiUrl(baseUrl, "/responses"),
        body: { model: PROBE_MODEL, input: "hi", max_output_tokens: 16, store: false, stream: false },
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
