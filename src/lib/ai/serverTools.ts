/**
 * Server-side tools — the ones the *endpoint* runs, not this app.
 *
 * Every other tool in this codebase is ours: the model asks, the agent runtime
 * executes it locally, and the result goes back as another message (see
 * `lib/agent/registry.ts`). A server-side tool never reaches us. The model calls
 * it, the provider runs it inside the same request, and the transcript comes
 * back as extra content blocks in one response — there is no round trip to
 * answer, and no way to refuse a call after the fact.
 *
 * That difference is why they live here rather than in the agent registry:
 *
 *   - **Declared, not registered.** They are request-body fields, so the choice
 *     is per *model* (a capability of the endpoint the author bought) rather
 *     than per task preset.
 *   - **Nothing to execute.** The runtime's tool loop must not see these as
 *     calls it owes a result for — a `server_tool_use` block that got answered
 *     with a `tool_result` would be a protocol error against a call the server
 *     already completed.
 *   - **Read-only reporting.** All this app does with one is show what the model
 *     searched and what came back, in the execution log.
 *
 * Today the list has exactly one entry, because exactly one endpoint offers one:
 * MiniMax-M3's `/anthropic/v1/messages` serves `web_search`, in beta, and only
 * on the Anthropic wire (`docs/api/landscape.md` §7 第四个样本). The shape is
 * Anthropic's own versioned-tool convention, so if the official endpoint's
 * server tools are ever wired up they land in the same table rather than beside
 * it.
 */

import { familyOf, type ApiStandard } from "./types";

/** This app's own name for a server-side tool. Never a wire type — see below. */
export type ServerToolId = "web_search";

/** Selectable values, in the order the settings drawer shows them. */
export const SERVER_TOOL_IDS: readonly ServerToolId[] = ["web_search"];

/**
 * The wire `type` each id becomes on the Anthropic protocol.
 *
 * Versioned by date, which is the point of keeping the two apart: the vendor
 * bumps `web_search_20250305` to a later stamp when the tool's behaviour
 * changes, and that must be one edit here rather than a value stored in every
 * model row (where it would silently keep an old version alive forever).
 */
const ANTHROPIC_WIRE_TYPE: Record<ServerToolId, string> = {
  web_search: "web_search_20250305",
};

/** Narrow stored strings to the union — the DB column is free text (JSON). */
export function parseServerTools(v: unknown): ServerToolId[] | undefined {
  const raw = typeof v === "string" ? safeParse(v) : v;
  if (!Array.isArray(raw)) return undefined;
  const ids = raw.filter((x): x is ServerToolId =>
    typeof x === "string" && (SERVER_TOOL_IDS as readonly string[]).includes(x),
  );
  // Empty is stored as absent — one representation for "none", so a row never
  // distinguishes never-set from set-to-empty.
  return ids.length ? [...new Set(ids)] : undefined;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Whether this endpoint can be told about server tools at all.
 *
 * Anthropic-shaped endpoints only, and deliberately not narrowed to the compat
 * half: the declaration is the author's, and an official endpoint that grows
 * its own server tools would take the same field. Offering the setting where
 * the adapter would drop it is the failure this guards against — the same rule
 * `supportsThinkingLevel` follows.
 */
export function supportsServerTools(standard: ApiStandard): boolean {
  return familyOf(standard) === "anthropic";
}

/** The `tools[]` entries these ids become on the Anthropic wire. */
export function anthropicServerTools(
  ids: readonly ServerToolId[] | undefined,
): { type: string; name: string }[] {
  return (ids ?? []).map((id) => ({ type: ANTHROPIC_WIRE_TYPE[id], name: id }));
}

// ─── What comes back ─────────────────────────────────────────────────────────

/** One hit from a server-run web search. */
export interface WebSearchResult {
  title: string;
  url: string;
  /** Vendor's own freshness estimate ("3 days ago"), when it sends one. */
  pageAge?: string;
}

/**
 * A server tool's activity, reported to the caller as it streams.
 *
 * Two phases rather than one event at the end: the search and its results
 * arrive as separate content blocks, sometimes seconds apart, and the whole
 * point of surfacing this is to show the author *why* the answer is taking a
 * while. `id` ties the two together — it is the `server_tool_use` block's id,
 * which the result block quotes back as `tool_use_id`.
 */
export type ServerToolEvent =
  | { phase: "call"; id: string; name: string; input: Record<string, unknown> }
  | { phase: "result"; id: string; name: string; results: WebSearchResult[]; error?: string };

/**
 * Pull the hits out of a `web_search_tool_result` block.
 *
 * Defensive about the container because the docs draw the block's `content` as
 * an array of results while the official protocol also uses that slot for an
 * error object — and a compat layer in beta is exactly where the two get
 * confused. Anything unrecognised yields no hits rather than throwing: a
 * malformed report must not take down a response the model already finished.
 */
export function readWebSearchResults(content: unknown): WebSearchResult[] {
  if (!Array.isArray(content)) return [];
  const out: WebSearchResult[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const url = typeof r.url === "string" ? r.url : "";
    const title = typeof r.title === "string" ? r.title : "";
    if (!url && !title) continue;
    out.push({
      title: title || url,
      url,
      ...(typeof r.page_age === "string" && r.page_age ? { pageAge: r.page_age } : {}),
    });
  }
  return out;
}

/** The error text on a failed `*_tool_result` block, if it carries one. */
export function readServerToolError(content: unknown): string | undefined {
  if (!content || typeof content !== "object" || Array.isArray(content)) return undefined;
  const c = content as Record<string, unknown>;
  if (c.type !== "web_search_tool_result_error" && !("error_code" in c)) return undefined;
  return typeof c.error_code === "string" ? c.error_code : "error";
}

/** One-line summary of a search's hits, for the execution log's result column. */
export function summarizeSearchResults(results: WebSearchResult[]): string {
  if (!results.length) return "";
  const head = results.slice(0, 3).map((r) => r.title).join(" / ");
  return results.length > 3 ? `${head} …(${results.length})` : head;
}
