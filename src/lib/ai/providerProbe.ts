/**
 * Remote provider probing: list available models and test connectivity.
 * Pure HTTP — no local storage involved (that's ./configDb).
 */

import { fetch } from "../http";
import type { ApiStandard } from "./types";

/** Gemini API base used when a provider hasn't configured a custom endpoint. */
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Fetch the available model list from a provider's /models endpoint (OpenAI-style). */
export async function fetchRemoteModels(
  baseUrl: string,
  apiKey: string,
  standard: ApiStandard
): Promise<{ id: string; name: string }[]> {
  if (standard === "gemini") {
    const base = (baseUrl || GEMINI_API_BASE).replace(/\/$/, "");
    const url = `${base}/models?key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gemini models fetch failed: ${res.status}`);
    const data = await res.json();
    return (data.models ?? []).map((m: Record<string, string>) => ({
      id: m.name?.replace("models/", "") ?? m.name,
      name: m.displayName ?? m.name,
    }));
  }
  // OpenAI / compatible
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const res = await fetch(url, {
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
  standard: ApiStandard
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  try {
    if (standard === "gemini") {
      const base = (baseUrl || GEMINI_API_BASE).replace(/\/$/, "");
      const url = `${base}/models?key=${apiKey}&pageSize=1`;
      const res = await fetch(url);
      if (!res.ok) {
        const error = await res.text();
        return { ok: false, error: `Gemini API error ${res.status}: ${error}` };
      }
      return { ok: true, message: "Gemini connection successful" };
    }

    if (standard === "openai_compat" || standard === "openai") {
      const url = `${baseUrl.replace(/\/$/, "")}/models`;
      const res = await fetch(url, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      });
      if (!res.ok) {
        const error = await res.text();
        return { ok: false, error: `API error ${res.status}: ${error}` };
      }
      const data = await res.json();
      const models = (data.data ?? []) as Array<{ id?: string }>;
      return {
        ok: true,
        message: `Connection successful. Found ${models.length} model(s).`,
      };
    }

    return { ok: false, error: "Unknown API standard" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Connection failed: ${msg}` };
  }
}
