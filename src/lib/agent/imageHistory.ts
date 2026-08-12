/**
 * How pictures live in the wire history, and how to take them back out.
 *
 * An image reaches the model as an `image_url` part on a `role: "user"`
 * message. Two things produce that shape: the tool loop, appending a vision
 * tool's result as a follow-up message (OpenAI's `role: "tool"` only allows
 * string content), and the chat composer, when the author attached a picture to
 * their own question. Both are base64 — megabytes each, in an array that
 * persists for the life of a chat session.
 *
 * So two places have to take them out again: `trimHistory` when a run is
 * outgrowing the model's window, and session serialization before the history
 * goes into a SQLite row. The rule lives here rather than in both.
 *
 * **The words stay.** An earlier version replaced the whole `content` with a
 * note, which was harmless for a tool follow-up ("Visual reference for
 * read_lore_image: …") and destructive for the author's question — that message
 * is a turn boundary the compaction pass segments on, and blanking it threw
 * away what was asked while keeping the answer. Only the pixels go.
 */

import type { MessageContent, StreamMessage } from "../ai/types";

/**
 * A user message carrying pictures.
 *
 * Typed with the whole `MessageContent`, not `ContentPart[]` as the runtime
 * check proves it is: eliding *writes a string back* into this same field, and
 * a type narrow enough to describe the input exactly would refuse the output.
 */
export type ImageMessage = { role: "user"; content: MessageContent };

/** True for a message still carrying at least one picture. */
export function hasImageParts(m: StreamMessage): m is ImageMessage {
  return (
    m.role === "user" &&
    Array.isArray(m.content) &&
    m.content.some((p) => p.type === "image_url")
  );
}

/**
 * The message's content with every picture replaced by `note`, collapsed to a
 * plain string.
 *
 * A string rather than a parts array with the images filtered out: a
 * single-element parts array is a shape some Gemini endpoints reject (see
 * lore/aiTask's `buildUserContent`), and once the pictures are gone there is
 * nothing an array expresses that the text doesn't.
 *
 * Caller-supplied `note` because the two callers are saying different things —
 * one dropped a picture for this request, the other for good.
 */
export function contentWithoutImages(m: ImageMessage, note: string): MessageContent {
  if (!Array.isArray(m.content)) return m.content;
  const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : []));
  return [...text, note].join("\n\n");
}
