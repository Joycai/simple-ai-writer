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
 * Today the list has exactly one entry — `web_search` — spoken by two wires:
 *
 *   - **Anthropic family**: MiniMax-M3's `/anthropic/v1/messages` serves it in
 *     beta (`docs/api/landscape.md` §7 第四个样本), as Anthropic's own
 *     versioned-tool convention (`tools[]` entries — see `anthropicServerTools`).
 *   - **OpenAI compat**: Qwen on DashScope's compatible-mode spells the same
 *     permission as a top-level body field, `enable_search: true`
 *     (`docs/api/landscape.md` §7 第六个样本 — what the SDK docs put in
 *     `extra_body` is just a top-level wire field; see `openaiServerToolsBody`).
 *     One honesty note: on that wire the search leaves **no trace** in the
 *     response — the vendor documents that Chat Completions mode returns no
 *     sources and no citations — so unlike the Anthropic wire there is nothing
 *     to show in the execution log; the answer simply absorbs what was found.
 *
 * Same id on purpose: the app-level meaning ("this model may reach the web on
 * its own, on every request") is identical, and the id is what the search
 * subagent's eligibility check reads. The *spelling* is the family's business.
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
 * Anthropic-shaped endpoints, deliberately not narrowed to the compat half:
 * the declaration is the author's, and an official endpoint that grows its own
 * server tools would take the same field. Offering the setting where the
 * adapter would drop it is the failure this guards against — the same rule
 * `supportsThinkingLevel` follows.
 *
 * The OpenAI family gets the **opposite** narrowing, and the same reasoning
 * produces it: there the spelling is `enable_search: true`, a DashScope
 * extension that api.openai.com does not know — and OpenAI's official endpoint
 * rejects unknown top-level arguments outright, so on `openai` (official) the
 * adapter must never send it and this setting must never appear. Compat is
 * exactly the half where the author typed the address and knows whether they
 * bought a DashScope-shaped endpoint.
 */
export function supportsServerTools(standard: ApiStandard): boolean {
  return familyOf(standard) === "anthropic" || standard === "openai_compat";
}

/**
 * Cap on how many searches the endpoint may run inside one request.
 *
 * There is no other brake. A server tool runs without asking, bills per search
 * (Anthropic's own rate is $10/1000, and results are billed as input tokens on
 * top), and a research-shaped question can fan out into a dozen searches — the
 * screenshot that prompted this had eight in one turn. `max_uses` turns the
 * worst case into a known one; exceeding it is a `max_uses_exceeded` error
 * *inside* a result block, which the model reads and works around, not a failed
 * request.
 *
 * Ten is chosen from the vendor's own guidance — 1–3 searches for a simple
 * factual question, "10 or more" for comparative research — so it sits at the
 * top of normal rather than in the middle of it.
 *
 * MiniMax's docs don't list the field. Sending it is a deliberate exception to
 * "only send what the relay documents" (`docs/api/landscape.md` §7): the rule
 * exists to avoid a 400 on a field the endpoint might validate, and here the
 * downside of *omitting* it is unbounded spend. It is also the same versioned
 * tool object the official endpoint defines, so a relay that parses the object
 * at all knows the field.
 */
const MAX_SEARCHES_PER_REQUEST = 10;

/** The `tools[]` entries these ids become on the Anthropic wire. */
export function anthropicServerTools(
  ids: readonly ServerToolId[] | undefined,
): { type: string; name: string; max_uses?: number }[] {
  return (ids ?? []).map((id) => ({
    type: ANTHROPIC_WIRE_TYPE[id],
    name: id,
    ...(id === "web_search" ? { max_uses: MAX_SEARCHES_PER_REQUEST } : {}),
  }));
}

/**
 * The body fields these ids become on the OpenAI-compatible wire — Qwen on
 * DashScope compatible-mode spells the permission `enable_search: true` at the
 * top level of the request.
 *
 * Gated on the standard here rather than trusting the caller, mirroring the
 * asymmetry in `supportsServerTools`: the config layer refuses to *store* the
 * permission on an official-OpenAI model, but a config row travels (import,
 * hand edits), and this field on api.openai.com is a guaranteed 400. Nothing
 * like Anthropic's `max_uses` exists to send: DashScope documents no per-request
 * search cap on this wire, and search bills per call at a rate three orders of
 * magnitude below Anthropic's, so the missing brake is not the same hazard.
 */
export function openaiServerToolsBody(
  standard: ApiStandard,
  ids: readonly ServerToolId[] | undefined,
): Record<string, unknown> {
  if (standard !== "openai_compat" || !ids?.includes("web_search")) return {};
  return { enable_search: true };
}

// ─── What comes back ─────────────────────────────────────────────────────────

/** One hit from a server-run web search. */
export interface WebSearchResult {
  title: string;
  url: string;
  /** Vendor's own freshness estimate ("3 days ago"), when it sends one. */
  pageAge?: string;
  /**
   * The page text the endpoint extracted, when it sends any.
   *
   * Kept — despite being by far the largest thing in a search response —
   * because on an endpoint that stops after delivering results, this text is
   * the *only* copy of what the model found. Re-reading it out of the model's
   * own words isn't possible: it never got to speak. See `renderSearchResults`.
   */
  content?: string;
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
      ...(typeof r.content === "string" && r.content.trim() ? { content: r.content } : {}),
    });
  }
  return out;
}

// ─── Handing the results back to a model that never got to use them ──────────

/**
 * How much of one page's extracted text survives into the transcript, and how
 * much the whole transcript may occupy.
 *
 * Both caps exist because the input side of a searching turn is already the
 * expensive part — a single observed run reached 123k input tokens across eight
 * searches — and the transcript is *re-sent* on top of that. The per-result cap
 * is the more important of the two: search extracts are long, front-loaded, and
 * a model that needs more than the first few hundred characters of ten separate
 * pages is not going to be rescued by a thousand.
 */
const RESULT_EXCERPT_CHARS = 600;
const TRANSCRIPT_CHARS = 12_000;

/**
 * The turn's searches, rendered as plain text a model can read.
 *
 * **Why text and not the blocks themselves.** The protocol's own answer is to
 * echo the assistant turn back verbatim, `server_tool_use` and
 * `web_search_tool_result` included. MiniMax's endpoint rejects exactly that
 * with `invalid params, tool result's tool id(...) not found` — its request-side
 * validator reads any `*_tool_result` as a *client* tool's result and looks for
 * a matching client `tool_use`, which a server tool by definition doesn't have.
 * So the one shape the protocol prescribes is the one shape that endpoint won't
 * take (`docs/anthropic-plan.md` §10.7).
 *
 * Plain text has no such dependency: it is a message like any other, and it
 * works on an endpoint whose validator knows nothing about server tools. What
 * it costs is the citation machinery — `encrypted_content` and the
 * `web_search_result_location` citations only mean something to the endpoint
 * that issued them — so the model sees the sources as prose with URLs rather
 * than as citable references.
 *
 * Returns null when there is nothing worth handing back, so the caller can tell
 * "no results" from "results the model already used".
 */
export function renderSearchResults(events: readonly ServerToolEvent[]): string | null {
  const queries = new Map<string, string>();
  for (const e of events) {
    if (e.phase === "call") queries.set(e.id, String(e.input?.query ?? "").trim());
  }

  const sections: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const e of events) {
    if (e.phase !== "result") continue;
    const query = queries.get(e.id);
    const head = query ? `## ${query}` : "##";
    if (e.error) {
      sections.push(`${head}\n(搜索失败：${e.error})`);
      continue;
    }
    const lines: string[] = [head];
    for (const r of e.results) {
      // Budget checked per result rather than per section: one long section
      // must not be able to crowd out every later query's hits entirely.
      if (used >= TRANSCRIPT_CHARS) { dropped++; continue; }
      const excerpt = r.content ? clipExcerpt(r.content) : "";
      const entry = [
        `- ${r.title}${r.pageAge ? ` (${r.pageAge})` : ""}`,
        r.url ? `  ${r.url}` : "",
        excerpt ? `  ${excerpt}` : "",
      ].filter(Boolean).join("\n");
      used += entry.length;
      lines.push(entry);
    }
    if (lines.length > 1) sections.push(lines.join("\n"));
  }

  if (!sections.length) return null;
  if (dropped > 0) sections.push(`(另有 ${dropped} 条结果因长度限制未列出)`);
  return sections.join("\n\n");
}

/** One result's page text, collapsed to a single clipped paragraph. */
function clipExcerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > RESULT_EXCERPT_CHARS ? `${flat.slice(0, RESULT_EXCERPT_CHARS)}…` : flat;
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
