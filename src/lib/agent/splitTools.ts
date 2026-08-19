/**
 * Facet-split collector tools — how the 拆分整理 run hands its result back.
 *
 * These are the only tools in the registry that write nothing, anywhere: they
 * append to an in-memory sink the modal then renders as its review list, and
 * the author's Apply is still what touches disk. They exist for one reason —
 * **the transport**, not the destination.
 *
 * The split used to ask for the whole reorganization as one JSON object in the
 * reply text: core card plus every facet, each carrying paragraphs copied
 * verbatim from the author's entry. That makes the model hand-write a JSON
 * string thousands of characters long, escaping every quote and newline in
 * someone else's prose as it goes — and a single unescaped `"` (or an output
 * cap landing mid-string) failed the entire run with a parse error, after
 * paying for all of it. Tool arguments are decoded against the schema by the
 * endpoint instead, so the escaping is not the model's job; and one call per
 * facet means the cap can only ever cut *one* facet short, which the runtime
 * already reports back as a retryable error (see runtime.ts `argumentsUsable`).
 *
 * Same reasoning the conversational assistant already relied on: asked to split
 * an entry, it writes one `update_lore_file` per facet and never trips on this.
 */

import type { FacetSlot } from "../profile/model";
import type { ToolContext } from "./registry";
import type { ToolCall, ToolResult } from "./tools";

/** One facet as the model proposed it — pre-review, nothing on disk yet. */
export interface SplitDraftFacet {
  title: string;
  /** Slot of the category's type schema, when the model named a declared one. */
  slot: string | null;
  keys: string[];
  group: string | null;
  priority: number;
  content: string;
}

/**
 * The run's accumulating result. Handed in on ToolContext by the caller, which
 * keeps a reference and reads it once the run ends — and may re-read it live,
 * via `onChange`, to show the plan filling in facet by facet.
 */
export interface SplitSink {
  /** Core card body, from the last split_core call. */
  core?: string;
  facets: SplitDraftFacet[];
  /**
   * The facet slots the entity's category declares, so `split_facet` can check
   * the `slot` it was handed. Passed in rather than looked up here: the split
   * tools deliberately touch nothing outside the sink, which is also what keeps
   * them testable without an active workspace. Empty ⇒ the category has no
   * schema and `slot` is simply ignored.
   */
  slots?: readonly FacetSlot[];
  /** Fired after every accepted call, for live progress. */
  onChange?: (sink: SplitSink) => void;
}

/** A fresh, empty sink. */
export function createSplitSink(
  onChange?: (sink: SplitSink) => void,
  slots?: readonly FacetSlot[],
): SplitSink {
  return { facets: [], slots, onChange };
}

const NO_SINK =
  "Error: this run cannot collect a split (no sink). Do not call the split_* tools here.";

function commit(sink: SplitSink, content: string, toolCallId: string): ToolResult {
  sink.onChange?.(sink);
  return { toolCallId, content };
}

/** split_core — set (or replace) the slimmed-down core card body. */
export async function splitCoreTool(
  toolCallId: string,
  args: { content?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const sink = ctx.splitSink;
  if (!sink) return { toolCallId, content: NO_SINK };

  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (!content) {
    return {
      toolCallId,
      content:
        "Error: 'content' is required and must be the core card's full body text. " +
        "An empty core would erase the entry.",
    };
  }

  const replaced = sink.core !== undefined;
  sink.core = content;
  return commit(
    sink,
    `Core card recorded (${content.length} chars)${replaced ? ", replacing the previous one" : ""}. ` +
      "Now submit each facet with one split_facet call.",
    toolCallId,
  );
}

/**
 * split_facet — append one facet to the plan.
 *
 * Re-submitting a title that is already in the plan **replaces** it rather than
 * duplicating. That is the recovery path: when the output cap cuts a call in
 * half the runtime drops it and tells the model, and the natural next move —
 * send that facet again, shorter — has to be safe.
 */
export async function splitFacetTool(
  toolCallId: string,
  args: {
    title?: unknown;
    slot?: unknown;
    content?: unknown;
    keys?: unknown;
    group?: unknown;
    priority?: unknown;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const sink = ctx.splitSink;
  if (!sink) return { toolCallId, content: NO_SINK };

  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return { toolCallId, content: "Error: 'title' is required." };

  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (!content) {
    return {
      toolCallId,
      content: `Error: facet "${title}" has no 'content'. Send the paragraphs it takes from the entry.`,
    };
  }

  const keys = Array.isArray(args.keys)
    ? args.keys
        .filter((k): k is string => typeof k === "string")
        .map((k) => k.trim())
        .filter(Boolean)
    : [];

  const group = typeof args.group === "string" && args.group.trim() ? args.group.trim() : null;
  const priority =
    typeof args.priority === "number" && Number.isFinite(args.priority) ? args.priority : 0;

  // An unknown slot is refused rather than dropped: the model is one retry away
  // from the right id, whereas a silently discarded slot would land the facet in
  // the unclassified pile with nothing anywhere saying why.
  const declared = sink.slots ?? [];
  const wanted = typeof args.slot === "string" ? args.slot.trim() : "";
  let slot: string | null = null;
  if (wanted && declared.length > 0) {
    const match = declared.find((s) => s.id.toLowerCase() === wanted.toLowerCase());
    if (!match) {
      return {
        toolCallId,
        content:
          `Error: facet "${title}" names slot "${wanted}", which this category does not declare. ` +
          `Its slots are: ${declared.map((s) => s.id).join(", ")}. Omit 'slot' if none of them fits.`,
      };
    }
    // Normalised to the declared casing — this string goes into the file.
    slot = match.id;
  }

  const facet: SplitDraftFacet = { title, slot, keys, group, priority, content };
  const existing = sink.facets.findIndex((f) => f.title === title);
  if (existing >= 0) sink.facets[existing] = facet;
  else sink.facets.push(facet);

  const note = keys.length === 0
    ? " Warning: no trigger keys, so this facet would never be injected automatically — resend it with keys."
    : "";
  return commit(
    sink,
    `Facet ${existing >= 0 ? "replaced" : "recorded"}: "${title}" (${content.length} chars, ` +
      `${keys.length} keys${slot ? `, slot ${slot}` : ""}). ` +
      `${sink.facets.length} facet(s) in the plan so far.${note}`,
    toolCallId,
  );
}

/** Tool-call adapters, matching the registry's `execute` shape. */
export function splitCoreCall(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  return splitCoreTool(call.id, JSON.parse(call.arguments || "{}"), ctx);
}
export function splitFacetCall(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  return splitFacetTool(call.id, JSON.parse(call.arguments || "{}"), ctx);
}
