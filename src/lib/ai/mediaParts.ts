/**
 * Media content parts, as the wire layer sees them: which kind a part is, how
 * to take parts of some kinds out of a message's content, and the one error an
 * adapter raises when a part it cannot spell reaches it anyway.
 *
 * Three kinds of media ride in a `role: "user"` message's parts array —
 * pictures (`image_url`), video clips (`video_url`) and documents (`file`,
 * only ever a PDF). Every place that removes them — the agent runtime trimming
 * a run that is outgrowing its window, chat persistence before a SQLite row —
 * goes through `withoutParts`, so they all follow the same rule.
 *
 * **The words stay.** An earlier version replaced the whole `content` with a
 * note, which was harmless for a tool follow-up ("Visual reference for
 * read_lore_image: …") and destructive for the author's question — that message
 * is a turn boundary the compaction pass segments on, and blanking it threw
 * away what was asked while keeping the answer. Only the payload goes.
 */

import type { ContentPart, MessageContent } from "./types";

/** The kinds of media a content part can carry. */
export type MediaKind = "image" | "video" | "pdf";

export const MEDIA_KINDS: readonly MediaKind[] = ["image", "video", "pdf"];

const KIND_OF: Readonly<Partial<Record<string, MediaKind>>> = {
  image_url: "image",
  video_url: "video",
  file: "pdf",
};

/**
 * The media kind a part carries, or `undefined` for text — and for a part of
 * a type nobody knows, which no rule here can admit or remove; an adapter
 * refuses it by name (`unsendablePart`).
 */
export function partKind(part: ContentPart): MediaKind | undefined {
  return KIND_OF[(part as { type?: unknown }).type as string];
}

/**
 * `content` with every part of the given kinds removed and `note` appended.
 *
 * Collapses to a plain string when only text is left: a single-element parts
 * array is a shape some Gemini endpoints reject (see lore/aiTask's
 * `buildUserContent`), and once the payload is gone there is nothing an array
 * expresses that the text doesn't. When other media survive (a clip removed
 * from a message that also carries a picture), the array stays and the note
 * joins it as a text part. String content is returned as it is.
 */
export function withoutParts(
  content: MessageContent,
  kinds: ReadonlySet<MediaKind>,
  note: string,
): MessageContent {
  if (!Array.isArray(content)) return content;
  const kept = content.filter((p) => {
    const kind = partKind(p);
    return kind === undefined || !kinds.has(kind);
  });
  if (kept.every((p) => p.type === "text")) {
    return [...kept.map((p) => (p.type === "text" ? p.text : "")), note].join("\n\n");
  }
  return [...kept, { type: "text", text: note }];
}

/**
 * The error an adapter throws for a content part it has no spelling for.
 *
 * A backstop, not a decision: which media a request may carry is settled
 * before any adapter runs, so reaching this means something upstream let a
 * part through that should have been held back. Named, because the silent
 * alternatives were worse — Gemini and Anthropic once died on
 * `p.image_url.url` with a TypeError that named nothing, and the Responses
 * adapter once sent an empty item that DashScope answered by streaming
 * nothing at all.
 */
export function unsendablePart(label: string, part: unknown): Error {
  const type = String((part as { type?: unknown } | null)?.type);
  return new Error(
    `${label} adapter: no spelling for a "${type}" content part — the request should have held it back`,
  );
}
