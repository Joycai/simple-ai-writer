/**
 * Turning the chat composer's `@` references into the text the model receives.
 *
 * References are **inlined**, not merely named. The assistant has read_file and
 * read_lore_entity and could fetch them itself, but an author who typed
 * `@第三章` has already decided the assistant should be looking at it — making
 * that a suggestion the model may skip turns an explicit instruction into a
 * gamble, and costs a round-trip when it doesn't.
 *
 * The cost of inlining is that chat history persists: whatever goes in stays in
 * context for the rest of the session. Hence the per-file cap — a long chapter
 * contributes its opening and a pointer to the tool that can read the rest,
 * instead of quietly eating the window.
 */

import i18n from "../../i18n";
import { readEntityFile } from "../lore/entity";
import type { AttachedItem, AttachedLore, AttachedText } from "../lore/aiTask";

/**
 * Longest slice of one referenced file that is inlined. Generous enough for a
 * normal chapter, small enough that four of them don't dominate the window.
 */
export const REF_CHAR_CAP = 6000;

/**
 * Budget across *all* of one message's references.
 *
 * The per-file cap alone bounds nothing that matters: ten `@`s is 60k
 * characters, and because chat history persists it stays in the window for the
 * rest of the session. Past this, references are named rather than inlined —
 * the assistant still knows they exist and can read them on demand.
 */
export const REF_TOTAL_CHAR_BUDGET = 18_000;

/** One reference, rendered for the prompt. `budget` is what is left for it. */
async function renderRef(item: AttachedLore | AttachedText, budget: number): Promise<string> {
  if (item.kind === "lore") {
    try {
      const body = await readEntityFile(item.entity.dirPath, "index.md");
      return clip(`## ${item.entity.name}`, body.trim(), budget, item.entity.dirPath);
    } catch {
      return `## ${item.entity.name}\n(读取失败 / unavailable)`;
    }
  }
  return clip(`--- ${item.file.name} ---`, item.content.trim(), budget, item.file.path);
}

/** Inline what fits under both caps; say where the rest is rather than truncating silently. */
function clip(header: string, content: string, budget: number, path: string): string {
  const cap = Math.min(REF_CHAR_CAP, Math.max(0, budget));
  if (cap === 0) {
    // Out of budget entirely: naming it still tells the assistant it was
    // asked for, and read_file is one round-trip away.
    return `${header}\n[not inlined — this message already carries several references. Read it from ${path} if you need it.]`;
  }
  if (content.length <= cap) return `${header}\n${content}`;
  return [
    header,
    content.slice(0, cap),
    `…[truncated — ${content.length - cap} more chars. Use read_file on ${path} for the full text.]`,
  ].join("\n");
}

/**
 * Compose the wire message: quoted selection, then references, then what the
 * author actually typed.
 *
 * The author's own words go last so they are the most recent thing the model
 * reads — everything above is material for carrying them out.
 */
export async function buildChatMessage(
  message: string,
  quote?: string,
  refs: AttachedItem[] = [],
): Promise<string> {
  const parts: string[] = [];

  const quoted = quote?.trim();
  if (quoted) {
    parts.push(`${i18n.t("ai.chat.quoteBlockLabel", { defaultValue: "【选中内容】" })}\n${quoted}`);
  }

  // Images are deliberately not carried: this message is a string, and a chat
  // turn that suddenly becomes a multimodal parts array breaks the history
  // shape every later turn is appended to. The picker offers text only.
  const referable = refs.filter(
    (r): r is AttachedLore | AttachedText => r.kind === "lore" || r.kind === "text",
  );
  if (referable.length) {
    // Sequential, not Promise.all: each reference's allowance depends on what
    // the ones before it used, so the first few arrive whole and the tail
    // degrades to pointers instead of every one being clipped to a stub.
    let spent = 0;
    const rendered: string[] = [];
    for (const item of referable) {
      const text = await renderRef(item, REF_TOTAL_CHAR_BUDGET - spent);
      spent += text.length;
      rendered.push(text);
    }
    parts.push(
      `${i18n.t("ai.chat.refBlockLabel", { defaultValue: "【引用资料】" })}\n${rendered.join("\n\n")}`,
    );
  }

  parts.push(message);
  return parts.join("\n\n");
}
