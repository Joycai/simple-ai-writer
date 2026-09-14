/**
 * How pictures and video clips live in the wire history, and how to take them
 * back out.
 *
 * An image reaches the model as an `image_url` part on a `role: "user"`
 * message. Two things produce that shape: the tool loop, appending a vision
 * tool's result as a follow-up message (OpenAI's `role: "tool"` only allows
 * string content), and the chat composer, when the author attached a picture to
 * their own question. A video clip (`video_url`) comes only from the composer.
 * Both are base64 — megabytes each, up to 20 MB for a clip, in an array that
 * persists for the life of a chat session.
 *
 * So two places have to take them out again: `trimHistory` when a run is
 * outgrowing the model's window (and, unconditionally, past a count cap), and
 * session serialization before the history goes into a SQLite row. The rule
 * lives here rather than in both.
 *
 * **The words stay.** An earlier version replaced the whole `content` with a
 * note, which was harmless for a tool follow-up ("Visual reference for
 * read_lore_image: …") and destructive for the author's question — that message
 * is a turn boundary the compaction pass segments on, and blanking it threw
 * away what was asked while keeping the answer. Only the payload goes.
 */

import type { ContentPart, MessageContent, StreamMessage } from "../ai/types";

/**
 * A user message carrying pictures or clips.
 *
 * Typed with the whole `MessageContent`, not `ContentPart[]` as the runtime
 * check proves it is: eliding *writes a string back* into this same field, and
 * a type narrow enough to describe the input exactly would refuse the output.
 */
type MediaMessage = { role: "user"; content: MessageContent };

type PartType = ContentPart["type"];

function hasPart(m: StreamMessage, type: PartType): m is MediaMessage {
  return m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === type);
}

/** True for a message still carrying at least one picture. */
export function hasImageParts(m: StreamMessage): m is MediaMessage {
  return hasPart(m, "image_url");
}

/** True for a message still carrying a video clip. */
export function hasVideoParts(m: StreamMessage): m is MediaMessage {
  return hasPart(m, "video_url");
}

/** True for a message carrying either — what persistence and the ceiling pass look for. */
export function hasMediaParts(m: StreamMessage): m is MediaMessage {
  return hasImageParts(m) || hasVideoParts(m);
}

/**
 * The content with every part of the given types removed and `note` appended.
 *
 * Collapses to a plain string when only text is left: a single-element parts
 * array is a shape some Gemini endpoints reject (see lore/aiTask's
 * `buildUserContent`), and once the payload is gone there is nothing an array
 * expresses that the text doesn't. When other media survive (a clip elided from
 * a message that also carries a picture), the array stays and the note joins it
 * as a text part.
 */
function without(m: MediaMessage, types: ReadonlySet<PartType>, note: string): MessageContent {
  if (!Array.isArray(m.content)) return m.content;
  const kept = m.content.filter((p) => !types.has(p.type));
  if (kept.every((p) => p.type === "text")) {
    return [...kept.map((p) => (p.type === "text" ? p.text : "")), note].join("\n\n");
  }
  return [...kept, { type: "text", text: note }];
}

const IMAGE = new Set<PartType>(["image_url"]);
const VIDEO = new Set<PartType>(["video_url"]);
const MEDIA = new Set<PartType>(["image_url", "video_url"]);

/**
 * The message's content with every picture replaced by `note`.
 *
 * Caller-supplied `note` because the callers are saying different things —
 * one dropped a picture for this request, another for good.
 */
export function contentWithoutImages(m: MediaMessage, note: string): MessageContent {
  return without(m, IMAGE, note);
}

/** The message's content with its video clip replaced by `note`. */
export function contentWithoutVideo(m: MediaMessage, note: string): MessageContent {
  return without(m, VIDEO, note);
}

/** The message's content with every picture and clip replaced by `note`. */
export function contentWithoutMedia(m: MediaMessage, note: string): MessageContent {
  return without(m, MEDIA, note);
}
