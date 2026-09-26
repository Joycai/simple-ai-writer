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
 *
 * A third wire and a second id arrived together (2026-09-14, measured —
 * `docs/api/landscape.md` §7 第六个样本「联网搜索与网页抓取」):
 *
 *   - **Responses compat**: DashScope's `/responses` takes `web_search` as a
 *     built-in `tools[]` entry (`{type:"web_search"}`), and — unlike Chat
 *     Completions — reports it back as `web_search_call` output items with the
 *     queries and source URLs, so the log can show it again.
 *   - **`web_extractor`** (网页抓取): the endpoint opens a URL and reads the page.
 *     It is **not a separate permission** on DashScope: every wire refuses it
 *     without `web_search` (`The web_extractor tool must be executed with
 *     web_search tool`), so it is stored as an *upgrade* of search, never alone
 *     (`normalizeServerTools`). On Responses it is one more `tools[]` entry; on
 *     Chat Completions it is the `agent_max` search strategy, which some models
 *     refuse with a 400 (qwen3.8-flash does, qwen3-max / qwen3.5-plus take it).
 *     Only the two OpenAI-compat wires have a spelling for it here — the
 *     Anthropic surface's `web_fetch_*` version stamp is unmeasured.
 *
 * And two image searches, **Responses compat only** (measured the same day):
 *
 *   - **`web_search_image`** (以文搜图): text query → image hits.
 *   - **`image_search`** (以图搜图): an image already in the input → visually
 *     similar images. Declaring it on a text-only request is harmless (the
 *     model simply doesn't call it), which is what lets it be a standing
 *     per-model permission like the rest.
 *
 * The official Responses endpoint joined last (2026-09-14, GPT-5.6 through a
 * relay — docs/api/responses.md §10): OpenAI's own `{type:"web_search"}`
 * streams back the same `web_search_call` item, with two more action kinds
 * (`open_page`, `find_in_page`) that carry a URL instead of queries. Only
 * `web_search` reaches that wire; the other three ids are DashScope's names.
 *
 * Neither needs `web_search` beside it, and Chat Completions has no spelling
 * for either (a guessed `search_options.enable_image_search` was silently
 * ignored). Both bill per call at several times search's rate (¥24 / ¥48 per
 * thousand vs ¥4), which is why they are separate switches rather than riding
 * on search the way extraction does.
 *
 * The fifth id is not a web tool at all (2026-09-17, measured —
 * `docs/api/landscape.md` §7 第六个样本「代码解释器」):
 *
 *   - **`code_interpreter`** (代码解释器): the endpoint writes Python, runs it in
 *     its own sandbox, and answers from the output. Two wires spell it —
 *     Chat Completions compat as the top-level `enable_code_interpreter: true`,
 *     Responses compat as `{type:"code_interpreter"}` — and each attaches a
 *     condition the other doesn't: Chat Completions refuses it beside function
 *     tools (400 `Agent mode does not support tools`) and without streaming,
 *     Responses refuses it with thinking off (`Normal mode does not support
 *     Code interpreter`) but takes function tools beside it. Both conditions
 *     are the adapter's to honour per request (`openaiServerToolsBody`,
 *     `responsesServerTools`) — dropping the interpreter for that request
 *     rather than sending a guaranteed failure.
 *   - **Gated by model id**, unlike every id above. Support is per model and
 *     differs per wire (qwen3.8-* runs it on Responses only), an unsupported
 *     model answers 400 on some and *silently ignores* it on others
 *     (qwen-max, qwen3-max-preview on Chat Completions), and the vendor's list
 *     follows model families that an id pattern can name — see
 *     the `code_interpreter` cells in `capabilities.ts`. The official OpenAI endpoint's
 *     `code_interpreter` wants a `container` and is not this tool.
 *
 * The Gemini wire joined last (2026-09-26, OrcaRouter's verbatim Vertex route —
 * `docs/api/landscape.md` §7 第十八个样本「再补测」), speaking three of the ids
 * as bare `tools[]` entries beside `functionDeclarations` (`geminiServerTools`):
 * `web_search` → `googleSearch`, `web_extractor` → `urlContext`,
 * `code_interpreter` → `codeExecution`. Every combination with function tools
 * answered 200 — forcing a function (`mode: ANY`) and a response schema too —
 * so, unlike the DashScope wires, nothing is dropped per request. `urlContext`
 * works alone there, but it stays an upgrade of search here like everywhere
 * else (`normalizeServerTools`): one meaning per id. Search bills per query
 * (about $0.014 each) and the wire has no `max_uses` to send; the model chose
 * six queries for one question once.
 */

import { familyOf } from "./types";
import { providerWire, type ServerToolWire } from "./platforms";
import { hasCapability } from "./capabilities";
import { capabilityModelOf, relayUpstreamFor, type RelayUpstreamChoice } from "./relayUpstream";
import type { Model, Provider } from "./configDb";
import { providerFor } from "./routes";

export type { ServerToolWire } from "./platforms";

/** This app's own name for a server-side tool. Never a wire type — see below. */
export type ServerToolId = "web_search" | "web_extractor" | "web_search_image" | "image_search" | "code_interpreter";

/** Selectable values, in the order the settings drawer shows them. */
export const SERVER_TOOL_IDS: readonly ServerToolId[] = ["web_search", "web_extractor", "web_search_image", "image_search", "code_interpreter"];

/**
 * Whether an id reaches the web. The search subagent takes these — and only
 * these — away from the main model (`lib/agent/routing.ts`); a sandbox that
 * computes is not something the search subagent can do for it.
 */
function isWebServerTool(id: ServerToolId): boolean {
  return id !== "code_interpreter";
}

/** A declaration without its web ids — absent when nothing is left. */
export function nonWebServerTools(ids: readonly ServerToolId[] | undefined): ServerToolId[] | undefined {
  const rest = (ids ?? []).filter((id) => !isWebServerTool(id));
  return rest.length ? rest : undefined;
}

/**
 * The wire `type` each id becomes on the Anthropic protocol.
 *
 * Versioned by date, which is the point of keeping the two apart: the vendor
 * bumps `web_search_20250305` to a later stamp when the tool's behaviour
 * changes, and that must be one edit here rather than a value stored in every
 * model row (where it would silently keep an old version alive forever).
 */
const ANTHROPIC_WIRE_TYPE: Partial<Record<ServerToolId, string>> = {
  web_search: "web_search_20250305",
};

/** Narrow stored strings to the union — the DB column is free text (JSON). */
export function parseServerTools(v: unknown): ServerToolId[] | undefined {
  const raw = typeof v === "string" ? safeParse(v) : v;
  if (!Array.isArray(raw)) return undefined;
  return normalizeServerTools(raw.filter((x): x is ServerToolId =>
    typeof x === "string" && (SERVER_TOOL_IDS as readonly string[]).includes(x),
  ));
}

/**
 * The one canonical form of a declaration: deduplicated, in `SERVER_TOOL_IDS`
 * order, `web_extractor` only beside `web_search`, empty as absent.
 *
 * Extraction without search is dropped rather than search added: a row that
 * says "extract" alone was hand-edited or imported, and silently granting the
 * *billed* half of the pair is the wrong direction to guess in. Empty stays
 * absent — one representation for "none", so a row never distinguishes
 * never-set from set-to-empty.
 */
export function normalizeServerTools(ids: readonly ServerToolId[]): ServerToolId[] | undefined {
  const has = new Set(ids);
  if (!has.has("web_search")) has.delete("web_extractor");
  const out = SERVER_TOOL_IDS.filter((id) => has.has(id));
  return out.length ? out : undefined;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * The part of a declaration this wire can actually say, in canonical form —
 * absent when nothing is left.
 *
 * The declaration is the author's grant and stays on the model row untouched;
 * this is what reaches the request. A declaration can outlive its wire (the
 * row's provider moved platform, or was re-imported), and the difference is
 * *not sent*, never *sent anyway* (plan §7 invariant 4).
 */
export function effectiveServerTools(
  wire: ServerToolWire,
  ids: readonly ServerToolId[] | undefined,
  modelId: string,
  relayUpstream?: RelayUpstreamChoice,
): ServerToolId[] | undefined {
  const model = capabilityModelOf({ modelId, relayUpstream });
  return normalizeServerTools((ids ?? []).filter((id) => hasCapability(id, wire, model)));
}

/**
 * The server tools this model's requests actually carry: its declaration, cut
 * to what its provider's platform can spell ({@link effectiveServerTools}).
 *
 * The row alone is not the answer. A declaration is the author's grant and is
 * kept when the wire can't say it (plan §7 invariant 4) — a provider moved to
 * another platform or standard, a row imported — and the adapters then drop
 * the id on every request. Anything that *promises* a capability (a search
 * subagent, page reading, a mark on the model list) must ask this instead of
 * the row.
 *
 * Without a provider list the declaration is returned as-is; with one, a
 * missing provider answers `undefined` — don't promise what can't be checked.
 */
export function serverToolsSent(
  model: Pick<Model, "providerId" | "modelId" | "serverTools" | "activeRoute" | "relayUpstream">,
  providers?: readonly Provider[],
): ServerToolId[] | undefined {
  if (!providers) return model.serverTools;
  const provider = providerFor(model, providers);
  if (!provider) return undefined;
  const wire = providerWire(provider);
  return effectiveServerTools(wire, model.serverTools, model.modelId, relayUpstreamFor(wire.platform, model, provider));
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
  wire: ServerToolWire,
  ids: readonly ServerToolId[] | undefined,
  modelId?: string,
  relayUpstream?: RelayUpstreamChoice,
): { type: string; name: string; max_uses?: number }[] {
  if (familyOf(wire.standard) !== "anthropic") return [];
  const model = capabilityModelOf({ modelId, relayUpstream });
  return (ids ?? []).filter((id) => hasCapability(id, wire, model)).flatMap((id) => {
    const type = ANTHROPIC_WIRE_TYPE[id];
    if (!type) return [];
    return [{
      type,
      name: id,
      ...(id === "web_search" ? { max_uses: MAX_SEARCHES_PER_REQUEST } : {}),
    }];
  });
}

/**
 * The body fields these ids become on the Chat Completions wire — DashScope's
 * compatible-mode spells the permission `enable_search: true` at the top level
 * of the request. No other platform has a Chat Completions spelling, so on
 * every other platform this is `{}`.
 *
 * Gated on the wire here rather than trusting the caller: the drawer stops
 * offering a switch the wire can't say, but a config row travels (import, hand
 * edits, a provider moved to another platform), and these fields on
 * api.openai.com are a guaranteed 400 — on a relay, a silent no-op the author
 * reads as "the model searched". Nothing like Anthropic's `max_uses` exists to
 * send: DashScope documents no per-request search cap on this wire, and search
 * bills per call at a rate three orders of magnitude below Anthropic's, so the
 * missing brake is not the same hazard.
 */
export function openaiServerToolsBody(
  wire: ServerToolWire,
  ids: readonly ServerToolId[] | undefined,
  modelId: string,
  request: { functionTools: boolean },
  relayUpstream?: RelayUpstreamChoice,
): Record<string, unknown> {
  if (familyOf(wire.standard) !== "openai") return {};
  const granted = effectiveServerTools(wire, ids, modelId, relayUpstream);
  if (!granted) return {};
  const out: Record<string, unknown> = {};
  if (granted.includes("web_search")) {
    // Extraction has no field of its own on this wire: it is the `agent_max`
    // search strategy. Measured 2026-09-14 on a page-summary prompt — plain
    // `enable_search` on qwen3-max answered from memory (29 input tokens, no
    // search at all), `agent_max` read the page (1.2k–1.6k). A model that
    // doesn't offer the strategy answers 400 (qwen3.8-flash: `does not support
    // the "agent" search strategy`) — loud, and the author's declaration to fix.
    //
    // And never beside function tools: the strategy is DashScope's "agent
    // mode", which refuses them with the same 400 as the interpreter below
    // (`Agent mode does not support tools`, measured 2026-09-17). Such a
    // request keeps plain search — measured fine beside tools — and gives up
    // page reading for that request only. The search subagent, the one caller
    // whose job is reading pages, sends no function tools, so it keeps it.
    out.enable_search = true;
    if (granted.includes("web_extractor") && !request.functionTools) {
      out.search_options = { search_strategy: "agent_max" };
    }
  }
  // Only on a request without function tools: this wire refuses the pair
  // outright (400 `Agent mode does not support tools`, measured 2026-09-17),
  // and an agent round's own tools are not the thing to give up. So on Chat
  // Completions the interpreter reaches tool-less requests only — the drawer's
  // hint says so, and points agent runs at the Responses wire, which takes
  // both. Streaming is the wire's other condition; this adapter always streams.
  if (granted.includes("code_interpreter") && !request.functionTools) {
    out.enable_code_interpreter = true;
  }
  return out;
}

/**
 * The built-in `tools[]` entries these ids become on the Responses wire —
 * bare `{type}` objects, on DashScope's `/responses` and on OpenAI's own.
 *
 * Filtered per id through the platform rather than trusting the row: a row on
 * the official endpoint or on xAI must carry only `web_search` there —
 * `web_extractor` and the image searches are DashScope's names, and xAI
 * refuses them (landscape.md §7 第十一个样本). Re-normalised too, because
 * DashScope answers a lone extractor with `response.failed` rather than
 * ignoring it.
 */
export function responsesServerTools(
  wire: ServerToolWire,
  ids: readonly ServerToolId[] | undefined,
  modelId: string,
  request: { thinkingOff: boolean },
  relayUpstream?: RelayUpstreamChoice,
): { type: ServerToolId }[] {
  if (familyOf(wire.standard) !== "responses") return [];
  return (effectiveServerTools(wire, ids, modelId, relayUpstream) ?? [])
    // The interpreter needs the model thinking on this wire: with
    // `reasoning.effort: "none"` DashScope fails the whole response
    // (`Normal mode does not support Code interpreter`, measured 2026-09-17).
    // The author turned thinking off on purpose; the interpreter yields.
    .filter((id) => id !== "code_interpreter" || !request.thinkingOff)
    .map((type) => ({ type }));
}

/** The `tools[]` entry each id becomes on the Gemini wire. */
const GEMINI_WIRE_TOOL: Partial<Record<ServerToolId, string>> = {
  web_search: "googleSearch",
  web_extractor: "urlContext",
  code_interpreter: "codeExecution",
};

/**
 * The built-in `tools[]` entries these ids become on the Gemini wire — each a
 * one-key object with an empty config (`{googleSearch: {}}`), listed beside the
 * `functionDeclarations` entry, never inside it. Gated and normalised like the
 * other wires: only what the platform's cell grants reaches the request.
 */
export function geminiServerTools(
  wire: ServerToolWire,
  ids: readonly ServerToolId[] | undefined,
  modelId: string,
  relayUpstream?: RelayUpstreamChoice,
): Record<string, Record<string, never>>[] {
  if (familyOf(wire.standard) !== "gemini") return [];
  return (effectiveServerTools(wire, ids, modelId, relayUpstream) ?? []).flatMap((id) => {
    const key = GEMINI_WIRE_TOOL[id];
    return key ? [{ [key]: {} }] : [];
  });
}

// ─── What comes back ─────────────────────────────────────────────────────────

/** One hit from a server-run web search. */
interface WebSearchResult {
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
  | {
    phase: "result"; id: string; name: string; results: WebSearchResult[]; error?: string;
    /** What a code interpreter run printed — its only result; searches leave it unset. */
    output?: string;
  };

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
 * take (`docs/api/anthropic-plan.md` §10.7).
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

/**
 * A Responses output item as a server-tool report, or null for any other item.
 *
 * Measured shapes (DashScope, 2026-09-14):
 *
 *   - `web_search_call` — `action.queries[]` on `output_item.added`,
 *     `action.sources[{type:"url", url}]` on `output_item.done`. No titles
 *     come back, so a hit's title is its URL.
 *   - `web_extractor_call` — `urls[]` + `goal` on both; `output` (the page
 *     text the endpoint distilled for that goal) only on `done`. A page that
 *     could not be read is not an error on this wire: it completes with
 *     little or no `output`, and the model answers from what it has.
 *
 *   - `web_search_image_call` / `image_search_call` — shaped like a function
 *     call rather than like the two above: `name` + `arguments` (a JSON
 *     *string*: `{queries}` for text→image, `{img_idx, bbox}` for image→image)
 *     on `added`, plus `output` — another JSON string, an array of
 *     `{title, url, index}` — on `done`. No match is `"[]"`, not an error.
 *
 * `phase` is the caller's to say, because the two events carry the same item
 * type and differ only in which event delivered them. `fallbackId` covers an
 * item without an `id` — the two halves must still meet in the log.
 */
export function responsesServerToolEvent(
  item: unknown,
  phase: "call" | "result",
  fallbackId: string,
): ServerToolEvent | null {
  if (!item || typeof item !== "object") return null;
  const it = item as Record<string, unknown>;
  const name = it.type === "web_search_call" ? "web_search"
    : it.type === "web_extractor_call" ? "web_extractor"
    : it.type === "web_search_image_call" ? "web_search_image"
    : it.type === "image_search_call" ? "image_search"
    : it.type === "code_interpreter_call" ? "code_interpreter"
    : null;
  if (!name) return null;
  const id = typeof it.id === "string" && it.id ? it.id : fallbackId;
  const action = (it.action && typeof it.action === "object" ? it.action : {}) as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

  // OpenAI's own search also opens pages and searches within them; those
  // actions carry a `url` and no queries or sources (responses.md §10).
  const pageUrl = typeof action.url === "string" && action.url ? action.url : undefined;

  if (name === "code_interpreter") return codeInterpreterEvent(it, phase, id);

  if (phase === "call") {
    const queries = strings(action.queries);
    const input: Record<string, unknown> = name === "web_search"
      ? pageUrl
        ? { url: pageUrl, ...(typeof action.pattern === "string" ? { pattern: action.pattern } : {}) }
        // `queries` is DashScope's and OpenAI's plural; OpenAI also sends the
        // singular `query`, alone on some items.
        : { queries: queries.length || typeof action.query !== "string" ? queries : [action.query] }
      : name === "web_extractor"
        ? { urls: strings(it.urls), ...(typeof it.goal === "string" ? { goal: it.goal } : {}) }
        : parseJsonObject(it.arguments);
    return { phase, id, name, input };
  }

  const error = it.status === "failed" ? "failed" : undefined;
  if (name === "web_search_image" || name === "image_search") {
    return { phase, id, name, results: readImageHits(it.output), ...(error ? { error } : {}) };
  }
  if (name === "web_search") {
    if (pageUrl) return { phase, id, name, results: [{ title: pageUrl, url: pageUrl }], ...(error ? { error } : {}) };
    const urls = Array.isArray(action.sources)
      ? action.sources.map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>).url : undefined))
      : [];
    const results = [...new Set(strings(urls))].map((url) => ({ title: url, url }));
    return { phase, id, name, results, ...(error ? { error } : {}) };
  }
  const output = typeof it.output === "string" && it.output.trim() ? it.output : undefined;
  // One `output` for the whole call — kept on the first URL only, so it is
  // not duplicated per page.
  const results = strings(it.urls).map((url, i) => ({
    title: url, url, ...(i === 0 && output ? { content: output } : {}),
  }));
  return { phase, id, name, results, ...(error ? { error } : {}) };
}

/**
 * A `code_interpreter_call` item as a report. Measured shape (DashScope,
 * 2026-09-17): `code` is already whole on `output_item.added`; `outputs` —
 * `[{type:"logs", logs}]`, the text fenced in a markdown code block — arrives
 * on `done`. A Python exception is not a failed call: it completes with the
 * traceback in `logs`, and the model answers from it. A plot comes back as a
 * markdown image *inside* `logs`, pointing at a signed OSS URL that expires
 * about twelve hours later — kept as text, never fetched or stored. OpenAI's
 * own `{type:"image", url}` output is read too, as a hit.
 */
function codeInterpreterEvent(it: Record<string, unknown>, phase: "call" | "result", id: string): ServerToolEvent {
  const name = "code_interpreter";
  if (phase === "call") {
    return { phase, id, name, input: typeof it.code === "string" ? { code: it.code } : {} };
  }
  const logs: string[] = [];
  const images: WebSearchResult[] = [];
  for (const raw of Array.isArray(it.outputs) ? it.outputs : []) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (o.type === "logs" && typeof o.logs === "string") logs.push(o.logs);
    else if (o.type === "image" && typeof o.url === "string" && o.url) images.push({ title: o.url, url: o.url });
  }
  const output = stripFence(logs.join("\n"));
  return {
    phase, id, name, results: images,
    ...(output ? { output } : {}),
    ...(it.status === "failed" ? { error: "failed" } : {}),
  };
}

/** Logs without the markdown fence DashScope wraps them in. */
function stripFence(text: string): string {
  return text.replace(/^\s*```[\w-]*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

/** A JSON-string `arguments` as an object; anything unreadable is `{}`. */
function parseJsonObject(v: unknown): Record<string, unknown> {
  const parsed = typeof v === "string" ? safeParse(v) : v;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

/**
 * The hits in an image search's `output` — a JSON string holding
 * `[{title, url, index}]`. Same leniency as `readWebSearchResults`: a
 * malformed report yields no hits rather than failing a finished answer.
 */
function readImageHits(output: unknown): WebSearchResult[] {
  const parsed = typeof output === "string" ? safeParse(output) : output;
  return readWebSearchResults(parsed);
}

/** The error text on a failed `*_tool_result` block, if it carries one. */
export function readServerToolError(content: unknown): string | undefined {
  if (!content || typeof content !== "object" || Array.isArray(content)) return undefined;
  const c = content as Record<string, unknown>;
  if (c.type !== "web_search_tool_result_error" && !("error_code" in c)) return undefined;
  return typeof c.error_code === "string" ? c.error_code : "error";
}

/**
 * One-line summary of a finished server tool, for the execution log's result
 * column: a search's hits, or the last line a code run printed — the value,
 * or the exception's own line after a traceback.
 */
export function summarizeServerToolResult(event: Extract<ServerToolEvent, { phase: "result" }>): string {
  if (event.output === undefined) return summarizeSearchResults(event.results);
  const last = event.output.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return last.length > CODE_SUMMARY_CHARS ? `${last.slice(0, CODE_SUMMARY_CHARS)}…` : last;
}

const CODE_SUMMARY_CHARS = 160;

/** One-line summary of a search's hits, for the execution log's result column. */
function summarizeSearchResults(results: WebSearchResult[]): string {
  if (!results.length) return "";
  const head = results.slice(0, 3).map((r) => r.title).join(" / ");
  return results.length > 3 ? `${head} …(${results.length})` : head;
}
