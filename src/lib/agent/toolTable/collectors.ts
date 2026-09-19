/**
 * Collectors for one-purpose runs: the facet splitter and 一致性检查's findings.
 *
 * One fragment of the tool table (docs/feature/code-structure-plan.md P6).
 * `registry.ts` spreads the fragments back into `REGISTRY` in a fixed order,
 * which is the tools' declaration order on the wire — see
 * `toolDefinitionsSnapshot.test.ts`.
 */

import { splitCoreCall, splitFacetCall } from "../splitTools";
import { reportIssueCall, reportPassCall } from "../../consistency/reviewTools";

import type { RegisteredTool, ToolId } from "../toolTypes";

export const COLLECTOR_TOOLS = {
  // ── Facet split (lib/agent/splitTools) ──
  // "read" access is accurate, oddly enough: these two write nothing anywhere.
  // They collect the reorganization into the run's sink, and the author's
  // Apply in the split modal is what reaches disk.
  split_core: {
    access: "read",
    projectFree: true,
    definition: {
      type: "function",
      function: {
        name: "split_core",
        description:
          "Submit the slimmed-down CORE CARD of the entry being split — the part that stays in index.md. Call this once, before the facets. Calling it again replaces what you sent. Send only the body text; the entry's frontmatter is preserved for you.",
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description:
                "Full body of the core card, moved verbatim from the entry. Never empty.",
            },
          },
          required: ["content"],
        },
      },
    },
    execute: splitCoreCall,
  },

  split_facet: {
    access: "read",
    projectFree: true,
    definition: {
      type: "function",
      function: {
        name: "split_facet",
        description:
          "Submit ONE facet of the entry being split — one outfit, one backstory arc, one set of relationships, one ability. Call it once per facet, never batching several into one call: each call is size-capped on its own, so a long facet can only ever cut short itself, and you can resend just that one. Re-sending a title already submitted REPLACES it, which is how you retry a call that came back truncated.",
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Facet name, e.g. \"Battle armor\". Also its identity when resending.",
            },
            slot: {
              type: "string",
              description:
                "Which slot of the category's type schema this facet fills, by id — the FACET SLOTS list in the prompt names them (a category may declare none, in which case leave this out). Omit it when the facet genuinely fits none; an id that isn't declared is refused.",
            },
            content: {
              type: "string",
              description: "The paragraphs this facet takes from the entry, moved verbatim.",
            },
            keys: {
              type: "array",
              items: { type: "string" },
              description:
                "4-8 trigger words that make this facet inject: referring terms from the text, scene triggers, common synonyms. Each must pass \"if this word appears in prose, this facet is almost certainly relevant\". Without keys the facet never fires.",
            },
            group: {
              type: "string",
              description:
                "Mutual-exclusion group. Facets only one of which can be true at a time (outfits, forms, phase states) MUST share one, e.g. \"outfit\". Omit when the facet excludes nothing.",
            },
            priority: {
              type: "number",
              description: "Higher wins within a group; default 0.",
            },
          },
          required: ["title", "content", "keys"],
        },
      },
    },
    execute: splitFacetCall,
  },

  // ── 一致性检查 collectors (lib/consistency/reviewTools) ──
  // Same shape as the split collectors: "read" access, nothing on disk, the
  // panel reads the sink live. projectFree for the same reason — the sink is
  // in memory, and the tests run the handlers with no project at all.
  report_issue: {
    access: "read",
    projectFree: true,
    definition: {
      type: "function",
      function: {
        name: "report_issue",
        description:
          "Record ONE inconsistency between the text you were given and the knowledge base (or the earlier text). Call it once per finding, as soon as you have verified it — never batch several into one call, and never list findings in prose instead. 'quote' must be copied VERBATIM from the segment and occur exactly once in it; the call is refused otherwise, so resend with a shorter or longer span. Categories in this project: {{categories}}; use 'timeline' for ordering/continuity.",
        parameters: {
          type: "object",
          properties: {
            severity: {
              type: "string",
              enum: ["conflict", "warning"],
              description:
                "conflict = the text contradicts established material; warning = it may be deliberate but is worth a look.",
            },
            category: {
              type: "string",
              description: "Which kind of material this is about — a category id from the list above, or 'timeline'.",
            },
            title: { type: "string", description: "Short label, ≤ 12 characters where possible, e.g. \"林辰惯用手\"." },
            quote: {
              type: "string",
              description:
                "The exact span from the segment, copied character-for-character including punctuation. One clause; must occur exactly once in the segment.",
            },
            reference: {
              type: "string",
              description: "What the knowledge base or the earlier text establishes instead, and where that comes from (entry · facet, or chapter).",
            },
            suggestion: {
              type: "string",
              description:
                "A drop-in replacement for 'quote' that resolves the conflict — same length and register. Omit when no single local edit fixes it.",
            },
            entity: {
              type: "string",
              description: "Name of the knowledge-base entry involved, exactly as the material gives it. Omit for a pure ordering/continuity finding.",
            },
          },
          required: ["severity", "title", "quote", "reference"],
        },
      },
    },
    execute: reportIssueCall,
  },

  report_pass: {
    access: "read",
    projectFree: true,
    definition: {
      type: "function",
      function: {
        name: "report_pass",
        description:
          "Record ONE fact you checked against the knowledge base and found consistent — e.g. a character's faction, a place name's spelling, a number that matches. This is how the author sees what the check actually covered: a check that only ever speaks up cannot be told apart from one that did not look. Call it once per verified fact.",
        parameters: {
          type: "object",
          properties: {
            label: { type: "string", description: "Short label for the fact, e.g. \"林辰阵营\"." },
            entity: { type: "string", description: "The knowledge-base entry it concerns, when there is one." },
            quote: {
              type: "string",
              description: "Optional: the span in the segment where you checked it, verbatim — gives the pass a line number.",
            },
          },
          required: ["label"],
        },
      },
    },
    execute: reportPassCall,
  },
} satisfies Partial<Record<ToolId, RegisteredTool>>;
