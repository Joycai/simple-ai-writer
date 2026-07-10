/**
 * RAG context assembly for V1 — alias-based keyword matching (no embeddings).
 * Scans lore entity aliases and names against selected text / recent content,
 * then assembles a 4-layer context string:
 *   Layer 1 – System prompt (from active prompt)
 *   Layer 2 – Matched lore entity summaries (auto + manually pinned)
 *   Layer 3 – Optional extras: additional knowledge, outline/direction
 *   Layer 4 – Recent chapter context (≤800 tokens before cursor)
 *   Layer 5 – Current selection / task instruction
 */

import i18n from "../i18n";
import { readFile } from "./fileio";
import type { LoreIndex } from "./lore";

const MAX_AUTO_LORE_CARDS = 3;
const APPROX_CHARS_PER_TOKEN = 3; // rough CJK-aware estimate
const MAX_LORE_CHARS = 600 * APPROX_CHARS_PER_TOKEN;
const MAX_CONTEXT_CHARS = 800 * APPROX_CHARS_PER_TOKEN;

/** Extra options available for AI tasks (continue / polish / rewrite / summary). */
export interface TaskExtras {
  /** dirPaths of manually pinned lore entities — merged with auto-matched. */
  manualLorePaths?: string[];
  /** Outline or writing direction the model should follow ("continue" only). */
  outline?: string;
  /** Free-form background knowledge not captured in the Lore system ("continue" only). */
  additionalKnowledge?: string;
  /** Extra requirement appended to the task instruction (polish/rewrite/summary). */
  requirement?: string;
}

export interface ContextBundle {
  systemPrompt: string;
  loreSnippets: string;
  recentContext: string;
  taskText: string;
  outline?: string;
  additionalKnowledge?: string;
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
        if (matched.length >= MAX_AUTO_LORE_CARDS) return matched;
      }
    }
  }
  return matched;
}

/** Load an entity's index.md content (summary section only). */
async function loadEntitySummary(dirPath: string): Promise<string> {
  try {
    const content = await readFile(`${dirPath}/index.md`);
    return content.slice(0, MAX_LORE_CHARS);
  } catch {
    return "";
  }
}

/**
 * Build the context bundle for an AI task.
 *
 * @param systemPrompt     Active system prompt content
 * @param loreIndex        Full lore index from loreStore
 * @param documentText     Full current document text
 * @param selection        Selected text or empty string
 * @param taskInstruction  Human-readable instruction appended after selection
 * @param extras           Optional "continue" task extras (lore pins, outline, knowledge)
 */
export async function assembleContext(
  systemPrompt: string,
  loreIndex: LoreIndex,
  documentText: string,
  selection: string,
  taskInstruction: string,
  extras?: TaskExtras
): Promise<ContextBundle> {
  // Layer 2: auto-match entities, then prepend any manually pinned ones (deduped)
  const matchTarget = selection + documentText.slice(-500);
  const autoEntityPaths = matchEntities(matchTarget, loreIndex);
  const manualPaths = extras?.manualLorePaths ?? [];
  const allEntityPaths = [...new Set([...manualPaths, ...autoEntityPaths])];

  const loreSnippets = (
    await Promise.all(allEntityPaths.map(loadEntitySummary))
  )
    .filter(Boolean)
    .join("\n\n---\n\n");

  // Layer 4: recent context — last N chars before selection (or end of doc)
  const selIdx = selection ? documentText.lastIndexOf(selection) : -1;
  const endIdx = selIdx >= 0 ? selIdx : documentText.length;
  const recentContext = documentText
    .slice(Math.max(0, endIdx - MAX_CONTEXT_CHARS), endIdx)
    .trim();

  // Layer 5: task text — base instruction plus any extra requirement
  const baseTask = selection
    ? `【选中内容】\n${selection}\n\n${taskInstruction}`
    : taskInstruction;
  const requirement = extras?.requirement?.trim();
  const taskText = requirement
    ? `${baseTask}\n\n【额外要求】\n${requirement}`
    : baseTask;

  const outline = extras?.outline?.trim() || undefined;
  const additionalKnowledge = extras?.additionalKnowledge?.trim() || undefined;

  // Rough token estimate
  const total =
    systemPrompt.length + loreSnippets.length + recentContext.length +
    taskText.length + (outline?.length ?? 0) + (additionalKnowledge?.length ?? 0);
  const estimatedTokens = Math.ceil(total / APPROX_CHARS_PER_TOKEN);

  return { systemPrompt, loreSnippets, recentContext, taskText, outline, additionalKnowledge, estimatedTokens };
}

/** Format the assembled context into a messages array for OpenAI/Gemini APIs. */
export function bundleToMessages(
  bundle: ContextBundle
): { role: "system" | "user"; content: string }[] {
  const parts: string[] = [];

  if (bundle.loreSnippets) {
    parts.push(`【设定资料】\n${bundle.loreSnippets}`);
  }
  if (bundle.additionalKnowledge) {
    parts.push(`【附加知识】\n${bundle.additionalKnowledge}`);
  }
  if (bundle.outline) {
    parts.push(`【大纲/写作方向】\n${bundle.outline}`);
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
