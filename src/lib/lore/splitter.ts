/**
 * AI-assisted facet splitting: takes an entity's index.md body and asks the
 * model to reorganize it into a lean core card plus independently-activatable
 * facets (outfits, backstory arcs, relations…). The model must MOVE text, not
 * rewrite it — the author's wording is the canon.
 *
 * The result comes back through **tool calls**, one per piece (see
 * `agent/splitTools.ts` for why): the endpoint decodes each call's arguments
 * against the schema, so the model never hand-escapes a page of someone else's
 * prose into a JSON string, and the output cap can only ever cut one facet
 * short instead of failing the whole run.
 *
 * `parseSplitResponse` survives as the fallback for a model that ignores the
 * tools and prints the old one-object JSON anyway — cheap to keep, and it is
 * the only thing standing between such a model and an empty review list.
 */

import i18n from "../../i18n";
import type { AgentEvent } from "../agent/events";
import { LORE_SPLIT_PRESET } from "../agent/presets";
import { runAgent } from "../agent/runtime";
import { createSplitSink, type SplitSink } from "../agent/splitTools";
import { pickConnOptions, type ConnOptions } from "../ai/conn";
import type { StreamMessage } from "../ai/types";
import { categoryFacetSlots } from "../profile/active";
import type { CategoryId, FacetMeta } from "./model";
import { withSlotDefaults } from "./slots";

export interface SplitFacetDraft {
  meta: FacetMeta;
  content: string;
}

export interface SplitResult {
  /** What remains in the core card (index.md body). */
  core: string;
  facets: SplitFacetDraft[];
  /** One-line explanation of the split, shown to the author. */
  notes: string;
}

/**
 * Turn a sink facet into the draft shape the review UI edits.
 *
 * Slot defaults are materialised **here**, before the author sees the draft, so
 * the review list shows the injection mode that will actually be written — and
 * so the write path stays a plain `createFacetFile` with no schema lookups in
 * it. `mode` is not a field `split_facet` exposes, which is what makes it safe
 * to let a slot's default raise it above the "auto" this always produces (see
 * `withSlotDefaults`).
 */
function toDraft(f: SplitSink["facets"][number], category: CategoryId): SplitFacetDraft {
  return {
    meta: withSlotDefaults(
      {
        title: f.title || "未命名特征",
        slot: f.slot,
        keys: f.keys,
        group: f.group,
        priority: f.priority,
        mode: "auto" as const,
      },
      category,
    ),
    content: f.content,
  };
}

export async function splitLore(opts: ConnOptions & {
  entityName: string;
  /**
   * The entity's category — what its facet slots are resolved from. Optional so
   * a caller with no workspace (a test, a bare script) still works: no category
   * means no schema, which means no checklist and no `slot` on any draft.
   */
  category?: CategoryId;
  /** index.md body (frontmatter stripped). */
  indexBody: string;
  /**
   * Existing facets to fold back into the reorganization. When present, the
   * model treats their text as part of the source and returns the COMPLETE
   * new facet set (the caller replaces the old files with it).
   */
  existingFacets?: { title: string; keys: string[]; body: string }[];
  /** Optional author guidance, e.g. "服装单独拆组". */
  instruction?: string;
  /**
   * The plan as it stands, re-fired after every accepted tool call — the core
   * card and each facet arrive one at a time now, so the modal can show them
   * landing instead of a spinner.
   */
  onPartial?: (partial: { core?: string; facets: SplitFacetDraft[] }) => void;
  /** Runtime progress (reasoning stream, token totals) for the progress UI. */
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  systemPrompt?: string;
}): Promise<SplitResult> {
  const existing = opts.existingFacets?.filter((f) => f.body.trim()) ?? [];
  const existingBlock = existing.length > 0
    ? [
        "",
        "EXISTING FACETS (already split out — treat their text as part of the source material;",
        "reorganize, merge, rename, or re-split them together with the core, and RESUBMIT THE COMPLETE new facet set):",
        ...existing.map((f) =>
          `### ${f.title}${f.keys.length ? ` (keys: ${f.keys.join(", ")})` : ""}\n${f.body.trim()}`,
        ),
      ].join("\n")
    : "";

  // The category's type schema, as a checklist. Empty for a category with no
  // schema — including one whose pack is disabled — and then the split behaves
  // exactly as it did before slots existed.
  const category = opts.category ?? "";
  const slots = category ? categoryFacetSlots(category) : [];
  const slotBlock = slots.length
    ? [
        "",
        `FACET SLOTS declared by this entry's category ("${category}") — prefer them when they fit,`,
        "passing the id as `slot`. They are a guide to the aspects worth separating, not a quota:",
        "do not invent a facet just to fill one, and omit `slot` for a facet none of them describes.",
        ...slots.map((s) => {
          const labels = s.labelZh === s.labelEn ? s.labelZh : `${s.labelZh} / ${s.labelEn}`;
          const hint = s.hintZh || s.hintEn ? ` — ${[s.hintZh, s.hintEn].filter(Boolean).join(" / ")}` : "";
          const group = s.defaults?.group ? ` — mutually exclusive: share group "${s.defaults.group}"` : "";
          return `- ${s.id} (${labels})${s.expected ? " [expected]" : ""}${hint}${group}`;
        }),
      ].join("\n")
    : "";

  const promptText = [
    `ENTITY NAME: ${opts.entityName}`,
    `CURRENT ENTRY (index.md body):`,
    opts.indexBody,
    existingBlock,
    slotBlock,
    opts.instruction?.trim() ? `\nAUTHOR GUIDANCE:\n${opts.instruction.trim()}` : "",
  ].filter(Boolean).join("\n");

  const sink = createSplitSink(
    (s) => opts.onPartial?.({ core: s.core, facets: s.facets.map((f) => toDraft(f, category)) }),
    slots,
  );
  const empty = () => sink.core === undefined && sink.facets.length === 0;

  // Mutated in place by the runtime, which is what makes the nudge below a
  // continuation of the same conversation rather than a second attempt from
  // scratch — the entry's text is already in it and doesn't get re-sent.
  const history: StreamMessage[] = [
    { role: "system", content: opts.systemPrompt ?? i18n.t("ai.instructions.loreSplit") },
    { role: "user", content: promptText },
  ];

  let fullText = "";
  const run = () => runAgent({
    ...pickConnOptions(opts),
    preset: LORE_SPLIT_PRESET,
    messages: history,
    // The split tools read nothing off disk, so there is no project context to
    // give them — the sink is the whole of what this run needs.
    toolContext: { projectPath: "", loreIndex: {}, multimodal: false, splitSink: sink },
    signal: opts.signal ?? new AbortController().signal,
    onEvent: opts.onEvent ?? (() => {}),
    onOutputText: (text) => { fullText = text; },
  });

  await run();

  if (empty()) {
    // Two ways to get here, and they want different handling. A model that
    // ignored the tools and printed the old one-object JSON is fine — take it.
    try {
      return parseSplitResponse(fullText);
    } catch {
      // The other way is a run that ended on its opening pleasantry: a text
      // round with no tool call ends a force-text run, so "好的，我来拆分：" and
      // nothing else finishes the run with an empty plan. One nudge, in the
      // same conversation, is much cheaper than making the author re-run the
      // whole thing — and if it doesn't take, the throw below carries the
      // model's own words so they can see why.
      history.push({ role: "user", content: i18n.t("ai.instructions.loreSplitNudge") });
      await run();
    }
    if (empty()) {
      try {
        return parseSplitResponse(fullText);
      } catch {
        // Not "invalid JSON" — nothing here asked for JSON. Saying so matters:
        // the author's next move is to retry or switch models, not to wonder
        // what was wrong with the syntax.
        const preview = fullText.trim().slice(0, 300) || "(empty response)";
        throw new Error(
          `The model never submitted anything through the split tools, so there is nothing to review.\n\nWhat it said instead:\n${preview}`,
        );
      }
    }
  }

  return {
    core: (sink.core ?? "").trim(),
    facets: sink.facets.map((f) => toDraft(f, category)).filter((f) => f.content.length > 0),
    notes: fullText.trim(),
  };
}

/** Extract + validate a whole-object JSON response (fence-tolerant, defaults applied). */
export function parseSplitResponse(fullText: string): SplitResult {
  const trimmed = fullText.trim();
  let jsonStr: string | undefined;
  const fenceMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1];
  } else {
    // Sliced to the outermost braces even when the reply already starts with
    // one: a model that appends a closing remark after the object would
    // otherwise hand JSON.parse the remark too.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) jsonStr = trimmed.slice(start, end + 1);
  }
  if (!jsonStr) {
    const preview = trimmed.slice(0, 300) || "(empty response)";
    throw new Error(`Model did not return valid JSON.\n\nResponse preview:\n${preview}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Failed to parse model response as JSON.\n\nResponse preview:\n${jsonStr.slice(0, 300)}`);
  }

  const rawFacets = Array.isArray(parsed.facets) ? parsed.facets : [];
  const facets: SplitFacetDraft[] = rawFacets
    .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
    .map((f) => ({
      meta: {
        title: typeof f.title === "string" && f.title.trim() ? f.title.trim() : "未命名特征",
        // Unvalidated here, unlike the tool path: this fallback has no category
        // to check against. An id nothing declares reads as unclassified, which
        // is the same thing a hand-written frontmatter slot does.
        slot: typeof f.slot === "string" && f.slot.trim() ? f.slot.trim() : null,
        keys: Array.isArray(f.keys)
          ? f.keys.filter((k): k is string => typeof k === "string").map((k) => k.trim()).filter(Boolean)
          : [],
        group: typeof f.group === "string" && f.group.trim() ? f.group.trim() : null,
        priority: typeof f.priority === "number" && Number.isFinite(f.priority) ? f.priority : 0,
        mode: "auto" as const,
      },
      content: typeof f.content === "string" ? f.content.trim() : "",
    }))
    .filter((f) => f.content.length > 0);

  return {
    core: typeof parsed.core === "string" ? parsed.core.trim() : "",
    facets,
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
  };
}
