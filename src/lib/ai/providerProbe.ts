/**
 * Remote provider probing: list available models and test connectivity.
 * Pure HTTP — no local storage involved (that's ./configDb).
 */

import { anthropicHeaders } from "./anthropic";
import { fetch } from "../http";
import { familyOf, type ApiStandard, type AuthMode } from "./types";
import { modelsUrl } from "./urls";

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
    if (!res.ok) throw new Error(`Gemini models fetch failed: ${res.status}`);
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
    if (!res.ok) throw new Error(`Anthropic models fetch failed: ${res.status}`);
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
  if (!res.ok) throw new Error(`Models fetch failed: ${res.status}`);
  const data = await res.json();
  return (data.data ?? []).map((m: Record<string, string>) => ({
    id: m.id,
    name: m.id,
  }));
}

export async function testProviderConnection(
  baseUrl: string,
  apiKey: string,
  standard: ApiStandard,
  authMode?: AuthMode
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  try {
    if (familyOf(standard) === "gemini") {
      const url = modelsUrl(standard, baseUrl, "?pageSize=1");
      const res = await fetch(url, { headers: { "x-goog-api-key": apiKey } });
      if (!res.ok) {
        const error = await res.text();
        return { ok: false, error: `Gemini API error ${res.status} (${url}): ${error}` };
      }
      return { ok: true, message: "Gemini connection successful" };
    }

    if (familyOf(standard) === "anthropic") {
      const url = modelsUrl(standard, baseUrl, "?limit=1");
      const res = await fetch(url, { headers: anthropicHeaders(apiKey, authMode) });
      if (!res.ok) {
        const error = await res.text();
        return { ok: false, error: `Anthropic API error ${res.status} (${url}): ${error}` };
      }
      return { ok: true, message: "Anthropic connection successful" };
    }

    const url = modelsUrl(standard, baseUrl);
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    });
    if (!res.ok) {
      const error = await res.text();
      return { ok: false, error: `API error ${res.status} (${url}): ${error}` };
    }
    const data = await res.json();
    const models = (data.data ?? []) as Array<{ id?: string }>;
    return {
      ok: true,
      message: `Connection successful. Found ${models.length} model(s).`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Connection failed: ${msg}` };
  }
}
