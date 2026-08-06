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

/** One reference, rendered for the prompt. */
async function renderRef(item: AttachedLore | AttachedText): Promise<string> {
  if (item.kind === "lore") {
    try {
      const body = await readEntityFile(item.entity.dirPath, "index.md");
      return `## ${item.entity.name}\n${body.trim()}`;
    } catch {
      return `## ${item.entity.name}\n(读取失败 / unavailable)`;
    }
  }

  const content = item.content.trim();
  if (content.length <= REF_CHAR_CAP) return `--- ${item.file.name} ---\n${content}`;
  // Say where the rest is rather than truncating silently: the assistant can
  // read the whole file, but only if it knows this one was clipped.
  return [
    `--- ${item.file.name} ---`,
    content.slice(0, REF_CHAR_CAP),
    `…[truncated — ${content.length - REF_CHAR_CAP} more chars. Use read_file on ${item.file.path} for the full text.]`,
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
    const rendered = await Promise.all(referable.map(renderRef));
    parts.push(
      `${i18n.t("ai.chat.refBlockLabel", { defaultValue: "【引用资料】" })}\n${rendered.join("\n\n")}`,
    );
  }

  parts.push(message);
  return parts.join("\n\n");
}
