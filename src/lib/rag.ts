/**
 * RAG context assembly for V1 — alias-based keyword matching (no embeddings).
 * Scans lore entity aliases and names against selected text / recent content,
 * then assembles a 4-layer context string:
 *   Layer 1 – System prompt (from active prompt)
 *   Layer 2 – Matched lore entity summaries (≤3 entities, ≤600 tokens each)
 *   Layer 3 – Recent chapter context (≤800 tokens before cursor)
 *   Layer 4 – Current selection / task instruction
 */

import i18n from "../i18n";
import type { LoreIndex } from "./lore";

const MAX_LORE_CARDS = 3;
const APPROX_CHARS_PER_TOKEN = 3; // rough CJK-aware estimate
const MAX_LORE_CHARS = 600 * APPROX_CHARS_PER_TOKEN;
const MAX_CONTEXT_CHARS = 800 * APPROX_CHARS_PER_TOKEN;

export interface ContextBundle {
  systemPrompt: string;
  loreSnippets: string;
  recentContext: string;
  taskText: string;
  /** Rough estimated total token count */
  estimatedTokens: number;
}

/** Return lore entities whose name or aliases appear in the target text. */
function matchEntities(text: string, lore: LoreIndex): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];

  for (const [, entities] of Object.entries(lore)) {
    for (const entity of entities) {
      const terms = [entity.name, ...(entity.aliases ?? [])];
      if (terms.some((t) => t && lower.includes(t.toLowerCase()))) {
        matched.push(entity.dirPath);
        if (matched.length >= MAX_LORE_CARDS) return matched;
      }
    }
  }
  return matched;
}

/** Load an entity's index.md content (summary section only). */
async function loadEntitySummary(dirPath: string): Promise<string> {
  try {
    const { readFile } = await import("./fileio");
    const content = await readFile(`${dirPath}/index.md`);
    return content.slice(0, MAX_LORE_CHARS);
  } catch {
    return "";
  }
}

/**
 * Build the 4-layer context bundle for an AI task.
 *
 * @param systemPrompt  Active system prompt content
 * @param loreIndex     Full lore index from loreStore
 * @param documentText  Full current document text (for recent context extraction)
 * @param selection     Selected text or empty string (used as task subject)
 * @param taskInstruction  Human-readable instruction appended after selection
 */
export async function assembleContext(
  systemPrompt: string,
  loreIndex: LoreIndex,
  documentText: string,
  selection: string,
  taskInstruction: string
): Promise<ContextBundle> {
  // Layer 2: match entities from selection + last 500 chars of doc
  const matchTarget = selection + documentText.slice(-500);
  const entityPaths = matchEntities(matchTarget, loreIndex);
  const loreSnippets = (
    await Promise.all(entityPaths.map(loadEntitySummary))
  )
    .filter(Boolean)
    .join("\n\n---\n\n");

  // Layer 3: recent context — last N chars before selection (or end of doc)
  const selIdx = selection ? documentText.lastIndexOf(selection) : -1;
  const endIdx = selIdx >= 0 ? selIdx : documentText.length;
  const recentContext = documentText
    .slice(Math.max(0, endIdx - MAX_CONTEXT_CHARS), endIdx)
    .trim();

  // Layer 4: task text
  const taskText = selection
    ? `【选中内容】\n${selection}\n\n${taskInstruction}`
    : taskInstruction;

  // Rough token estimate
  const total =
    systemPrompt.length + loreSnippets.length + recentContext.length + taskText.length;
  const estimatedTokens = Math.ceil(total / APPROX_CHARS_PER_TOKEN);

  return { systemPrompt, loreSnippets, recentContext, taskText, estimatedTokens };
}

/** Format the assembled context into a messages array for OpenAI/Gemini APIs. */
export function bundleToMessages(
  bundle: ContextBundle
): { role: "system" | "user"; content: string }[] {
  const parts: string[] = [];
  if (bundle.loreSnippets) {
    parts.push(`【设定资料】\n${bundle.loreSnippets}`);
  }
  if (bundle.recentContext) {
    parts.push(`【近期内容】\n${bundle.recentContext}`);
  }
  parts.push(bundle.taskText);

  return [
    { role: "system", content: bundle.systemPrompt || i18n.t("ai.instructions.system") },
    { role: "user", content: parts.join("\n\n") },
  ];
}
