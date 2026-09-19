/**
 * Helpers shared by the tool table's fragments (`lib/agent/toolTable/*`):
 * argument parsing and the description builders more than one tool uses.
 */

import { type GalleryViewer } from "../tools";

import type { ToolContext, ToolId } from "../toolTypes";

export function parseArgs<T>(raw: string): T {
  return JSON.parse(raw || "{}") as T;
}

/**
 * A paging cursor as `pageLines` wants it — a number, whatever the model sent.
 *
 * The cursor carries a fractional part now (`57.0001` continues inside line
 * 57; see `pageLines`), and a model that stringifies its arguments would
 * otherwise hand over `"57.0001"` and silently get line 1. Coercing here
 * rather than widening the schema keeps the per-round cost at zero.
 */
export function cursorArg(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Stands in for the active profile's category ids inside a tool *description*,
 * substituted by `getToolDefinitions`. Same reason the enums are patched there:
 * this registry is a module-level constant, so anything baked in freezes to
 * whichever profile happened to load first.
 */
export const CATEGORY_PLACEHOLDER = "{{categories}}";


/**
 * `delegate`'s description. The page-reading sentence appears only when the
 * search subagent's model declares `web_extractor` (`ToolContext.searchReadsPages`):
 * routing withholds the main model's own server tools while that subagent is
 * live, so a link the author pastes can only be read through it — and a
 * description that never says so leaves the main model answering "I can't
 * open links" (docs/reference/tool-presence.md, 能力静默消失). Offered only
 * when true, because a search-only model handed a URL can at best find it in
 * an index, not read it.
 */
export function describeDelegate(searchReadsPages: boolean): string {
  return (
    "Hand a context-heavy or capability-specific job to a specialist subagent " +
    "running on its own model. The subagent works in a separate context, writes " +
    "its full findings to a note file, and returns only a short summary plus the " +
    "note path — so its raw material never enters this conversation. Use it for " +
    "web research, reading images, reading PDF files, and digesting long documents." +
    (searchReadsPages
      ? " The search subagent can also open a web page and read its text: to read a URL, " +
        "delegate kind \"search\" and put the full URL and what to extract from it in 'task'."
      : "")
  );
}

/**
 * Who, on this run, can actually open one of the pictures `read_lore_entity`
 * lists — the gallery listing's trailer names it, and naming the wrong one
 * costs a round at best and a capability at worst.
 *
 * Both arms are checked against `allowedTools` rather than against the flags
 * alone, and that is the fix rather than an extra safety belt: the listing used
 * to say "call read_lore_image" whenever the model was multimodal, on presets
 * that do not carry that tool (`WRITER_PRESET` does not) and on every run where
 * a live vision subagent had just had it stripped. Same failure as the gutter
 * note that names `rewrite_lore_lines` — an unknown-tool round — which is why
 * it is answered the same way.
 */
export function galleryViewer(ctx: ToolContext): GalleryViewer {
  const has = (t: ToolId) => ctx.allowedTools?.includes(t) ?? false;
  if (ctx.multimodal && has("read_lore_image")) return "here";
  if (ctx.visionDelegate && has("delegate")) return "delegate";
  return "none";
}
