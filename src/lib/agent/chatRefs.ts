/**
 * Turning the chat composer's `@` references into what the model receives.
 *
 * References are **inlined**, not merely named. The assistant has read_file and
 * read_lore_entity and could fetch them itself, but an author who typed
 * `@第三章` has already decided the assistant should be looking at it — making
 * that a suggestion the model may skip turns an explicit instruction into a
 * gamble, and costs a round-trip when it doesn't. The same argument carries an
 * `@`-referenced *picture* into the message as an `image_url` part rather than
 * leaving the model to find it with read_image.
 *
 * The cost of inlining is that chat history persists: whatever goes in stays in
 * context for the rest of the session. Hence the per-file cap — a long chapter
 * contributes its opening and a pointer to the tool that can read the rest,
 * instead of quietly eating the window — and, for pictures, both a per-message
 * count cap here and the running cap `trimHistory` enforces over the session.
 */

import i18n from "../../i18n";
import type { ContentPart, MessageContent } from "../ai/types";
import { readEntityFile } from "../lore/entity";
import type { AttachedImage, AttachedItem, AttachedLore, AttachedText } from "../lore/aiTask";

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

/**
 * Most pictures one message may carry.
 *
 * Separate from the session-wide cap in `trimHistory`: that one keeps a long
 * conversation's *accumulated* images bounded, and counts a message as one
 * entry however many pictures are on it. Without a per-message cap, ten
 * attachments would be ten base64 payloads in a single request body — the
 * request that has to succeed before any trimming ever runs.
 */
export const MAX_MESSAGE_IMAGES = 4;

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

/** What one composed chat message contributes to the turn. */
export interface ChatMessagePayload {
  /**
   * The message as text.
   *
   * Not merely `content` narrowed: this is what the retrieval passes match on
   * (`assembleTurnInjection`'s matchTarget) and what the first turn's context
   * is assembled around. Those want words, and a picture has none — so the
   * text half stays a string whatever the wire form turns out to be.
   */
  text: string;
  /** What goes on the wire — the text alone, or the text plus image parts. */
  content: MessageContent;
  /** Absolute paths of the pictures actually attached, for the transcript. */
  imagePaths: string[];
}

/**
 * Compose the wire message: quoted selection, then references, then what the
 * author actually typed.
 *
 * The author's own words go last so they are the most recent thing the model
 * reads — everything above is material for carrying them out. Pictures go after
 * all of it, as parts: every provider reads a parts array in order, and an
 * image ahead of the instruction reads as the subject of a question not yet
 * asked.
 *
 * `allowImages` is the caller's answer to "is the active model multimodal" —
 * a text-only model is sent the attachment's *name* and told the picture could
 * not travel, which is the difference between the assistant saying so and the
 * assistant appearing to ignore what the author attached.
 */
export async function buildChatMessage(
  message: string,
  quote?: string,
  refs: AttachedItem[] = [],
  opts: { allowImages?: boolean } = {},
): Promise<ChatMessagePayload> {
  const parts: string[] = [];

  const quoted = quote?.trim();
  if (quoted) {
    parts.push(`${i18n.t("ai.chat.quoteBlockLabel", { defaultValue: "【选中内容】" })}\n${quoted}`);
  }

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

  const images = refs.filter((r): r is AttachedImage => r.kind === "image");
  const sent = opts.allowImages ? images.slice(0, MAX_MESSAGE_IMAGES) : [];
  const unsent = images.slice(sent.length);
  // Named, not just shown: "第二张图里的那件外套" only resolves if the model
  // knows which picture is which, and the parts array carries no filenames.
  if (sent.length) {
    parts.push(
      `${i18n.t("ai.chat.imageBlockLabel", { defaultValue: "【附图】" })}\n${
        sent.map((a, i) => `${i + 1}. ${a.file.name}`).join("\n")
      }`,
    );
  }
  if (unsent.length) {
    parts.push(
      i18n.t("ai.chat.imagesNotSent", {
        defaultValue: "（以下图片未能随本条消息发送：{{names}}）",
        names: unsent.map((a) => a.file.name).join("、"),
      }),
    );
  }

  parts.push(message);
  const text = parts.join("\n\n");

  return {
    text,
    content: sent.length
      ? [
          { type: "text", text },
          ...sent.map((a): ContentPart => ({ type: "image_url", image_url: { url: a.dataUrl } })),
        ]
      : text,
    imagePaths: sent.map((a) => a.file.path),
  };
}
