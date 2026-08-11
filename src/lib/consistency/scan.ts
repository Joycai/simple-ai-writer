/**
 * 一致性检查 — one structured pass over a document against the knowledge base.
 *
 * Single-shot rather than an agent loop, for the same reason the lore
 * generators are: forced tool_choice (which is what makes the finding list
 * parseable) conflicts with a free tool loop on most providers. The scan
 * therefore gets its material up front — the chapter, the lore that matches it,
 * and the story memory covering everything before it — and answers in one go.
 *
 * The prompt asks for passes as well as conflicts on purpose. A checker that
 * only ever speaks up is impossible to calibrate: "no issues" and "didn't look"
 * produce the same screen. The 已通过 N 项 list is what tells them apart.
 */

import { runStructuredTask } from "../agent/structured";
import { selectLore } from "../context/loreSelect";
import type { LoreIndex } from "../lore";
import type { DocMemory } from "../context/memory";
import type { GeminiSafetySettings } from "../ai/safety";
import type { ApiStandard, ToolDefinition } from "../ai/types";
import type { ConsistencyIssue, ConsistencyReport, IssueSeverity } from "./model";

/** Lore budget for a scan, in characters. Generous: the whole point is breadth. */
const SCAN_LORE_BUDGET_CHARS = 24_000;

/**
 * Longest document sent verbatim. A chapter past this is checked on its tail —
 * the part just written, which is what a check right after writing is about.
 */
const MAX_DOC_CHARS = 40_000;

const SEVERITIES: IssueSeverity[] = ["conflict", "warning"];

function findingsTool(categoryIds: string[]): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "report_consistency",
      description:
        "Report every inconsistency found between the chapter and the knowledge base, " +
        "plus the checks that came back clean.",
      parameters: {
        type: "object",
        properties: {
          issues: {
            type: "array",
            description: "Every problem found. Empty array when the chapter is consistent.",
            items: {
              type: "object",
              properties: {
                severity: {
                  type: "string",
                  enum: SEVERITIES,
                  description:
                    "conflict = the chapter contradicts established material; " +
                    "warning = it may be deliberate but is worth a look.",
                },
                category: {
                  type: "string",
                  enum: [...categoryIds, "timeline"],
                  description: "Which kind of material this is about; 'timeline' for ordering/continuity.",
                },
                title: { type: "string", description: "Short label, ≤ 12 characters where possible." },
                quote: {
                  type: "string",
                  description:
                    "The exact span from the chapter, copied VERBATIM including punctuation. " +
                    "Keep it short (one clause) and make sure it appears exactly once.",
                },
                reference: {
                  type: "string",
                  description: "What the knowledge base or the earlier text establishes instead, with where it comes from.",
                },
                suggestion: {
                  type: "string",
                  description:
                    "A drop-in replacement for `quote` that resolves the conflict. " +
                    "Same length and register as the original. Omit when no single edit fixes it.",
                },
                entity: {
                  type: "string",
                  description: "Name of the knowledge-base entry involved, exactly as given in the material.",
                },
              },
              required: ["severity", "category", "title", "quote", "reference"],
            },
          },
          passed: {
            type: "array",
            items: { type: "string" },
            description:
              "Short labels for the facts that were checked and found consistent, e.g. '林辰阵营'. " +
              "List what you actually verified — this is how the author knows the scan had coverage.",
          },
        },
        required: ["issues", "passed"],
      },
    },
  };
}

const SYSTEM_PROMPT = [
  "You are a continuity editor for a long-form writing project.",
  "You are given one chapter, the knowledge-base entries that mention its subjects,",
  "and a recap of everything before it. Find places where the chapter contradicts",
  "that established material.",
  "",
  "Rules:",
  "- Report only what the material actually establishes. If the knowledge base is silent, it is not a conflict.",
  "- A deliberate-looking change (a character's mood, a nickname dropped once) is a warning, not a conflict.",
  "- `quote` must be copied character-for-character from the chapter and must occur exactly once in it.",
  "- Prefer short quotes: one clause is easier to locate and safer to replace than a paragraph.",
  "- Suggest a replacement only when a single local edit genuinely fixes the problem.",
  "- Style, pacing and word choice are not your business. Only facts, names, and ordering.",
  "- Answer in the language the chapter is written in.",
].join("\n");

export interface ScanArgs {
  /** Provider wiring, same shape every structured task takes. */
  baseUrl: string;
  apiKey: string;
  standard: ApiStandard;
  safetySettings?: GeminiSafetySettings;
  modelId: string;
  prefix?: string;
  contextSize?: number;
  /** Sent as `max_tokens` on the Anthropic path; planning-only elsewhere. */
  maxOutput?: number;

  /** The document under test, and where it lives. */
  documentText: string;
  filePath: string | null;
  /** Display title for the prompt — the chapter's own name. */
  documentTitle: string;

  loreIndex: LoreIndex;
  /** Entities the author pinned in the panel; always included. */
  pinnedLorePaths: string[];
  /** Lore category ids from the active profile — the `category` enum. */
  categoryIds: string[];
  /** Story memory covering the earlier chapters, when the profile keeps one. */
  memory: DocMemory | null;

  signal?: AbortSignal;
  /** Raw streamed text, for the "thinking" line while it works. */
  onText?: (accumulated: string) => void;
}

interface RawIssue {
  severity?: unknown;
  category?: unknown;
  title?: unknown;
  quote?: unknown;
  reference?: unknown;
  suggestion?: unknown;
  entity?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export async function runConsistencyScan(args: ScanArgs): Promise<ConsistencyReport> {
  const started = Date.now();

  // The tail, when the chapter is long: a check is nearly always run on what
  // was just written, and the head has usually been checked already.
  const truncated = args.documentText.length > MAX_DOC_CHARS;
  const doc = truncated ? args.documentText.slice(-MAX_DOC_CHARS) : args.documentText;

  const lore = await selectLore(doc, args.loreIndex, args.pinnedLorePaths, SCAN_LORE_BUDGET_CHARS);
  const recap = (args.memory?.segments ?? []).map((s) => s.summary).join("\n").trim();

  const userText = [
    `【${args.documentTitle}】`,
    truncated ? "(earlier part of this chapter omitted — check what follows)" : "",
    doc || "(empty)",
    "",
    "【知识库 · KNOWLEDGE BASE】",
    lore.text.trim() || "(no matching entries)",
    recap ? "\n【前情 · STORY SO FAR】\n" + recap : "",
  ].filter(Boolean).join("\n");

  const raw = await runStructuredTask({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    standard: args.standard,
    safetySettings: args.safetySettings,
    modelId: args.modelId,
    prefix: args.prefix,
    contextSize: args.contextSize,
    maxOutput: args.maxOutput,
    systemPrompt: SYSTEM_PROMPT,
    toolInstruction: "Call the report_consistency tool exactly once with everything you found.",
    jsonInstruction:
      'Respond with ONLY a JSON object — no markdown fences, no prose — shaped ' +
      '{"issues": [{"severity": "conflict"|"warning", "category": string, "title": string, ' +
      '"quote": string, "reference": string, "suggestion"?: string, "entity"?: string}], ' +
      '"passed": string[]}.',
    outputTool: findingsTool(args.categoryIds),
    userContent: userText,
    signal: args.signal,
    onText: args.onText,
  });

  const parsed = JSON.parse(raw) as { issues?: unknown; passed?: unknown };

  // Resolve entity names against the index the scan ran on, so 更新设定 lands
  // on a real folder rather than on whatever the model called it.
  const dirByName = new Map<string, string>();
  for (const entities of Object.values(args.loreIndex)) {
    for (const e of entities ?? []) {
      dirByName.set(e.name.toLowerCase(), e.dirPath);
      for (const alias of e.aliases ?? []) dirByName.set(alias.toLowerCase(), e.dirPath);
    }
  }

  const issues: ConsistencyIssue[] = (Array.isArray(parsed.issues) ? parsed.issues : [])
    .map((r, i): ConsistencyIssue | null => {
      const item = r as RawIssue;
      const quote = str(item.quote);
      const title = str(item.title);
      // A finding with nothing to point at is not actionable and not
      // verifiable — the author would have to take it on faith.
      if (!quote || !title) return null;
      const severity: IssueSeverity =
        item.severity === "warning" ? "warning" : "conflict";
      const entityName = str(item.entity) || undefined;
      const suggestion = str(item.suggestion);
      return {
        id: `${started}-${i}`,
        severity,
        category: str(item.category) || "timeline",
        title,
        quote,
        reference: str(item.reference),
        suggestion: suggestion && suggestion !== quote ? suggestion : undefined,
        entityName,
        entityDirPath: entityName ? dirByName.get(entityName.toLowerCase()) : undefined,
      };
    })
    .filter((x): x is ConsistencyIssue => x !== null);

  const passed = (Array.isArray(parsed.passed) ? parsed.passed : [])
    .map(str)
    .filter(Boolean);

  return {
    issues,
    passed,
    checkedCount: issues.length + passed.length,
    durationMs: Date.now() - started,
    filePath: args.filePath,
  };
}
