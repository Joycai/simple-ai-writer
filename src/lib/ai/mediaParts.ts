/**
 * Media content parts, as the wire layer sees them: which kind a part is, how
 * to take parts of some kinds out of a message's content, and the one error an
 * adapter raises when a part it cannot spell reaches it anyway.
 *
 * Three kinds of media ride in a `role: "user"` message's parts array —
 * pictures (`image_url`), video clips (`video_url`) and documents (`file`,
 * only ever a PDF). Every place that removes them — the request's own
 * projection (`admitMedia`), the agent runtime trimming a run that is
 * outgrowing its window, chat persistence before a SQLite row — goes through
 * `withoutParts`, so they all follow the same rule.
 *
 * **The words stay.** An earlier version replaced the whole `content` with a
 * note, which was harmless for a tool follow-up ("Visual reference for
 * read_lore_image: …") and destructive for the author's question — that message
 * is a turn boundary the compaction pass segments on, and blanking it threw
 * away what was asked while keeping the answer. Only the payload goes.
 */

import type { ClipFps, MediaAdmission } from "./capability/media";
import type { ContentPart, MessageContent, StreamMessage } from "./types";
import { carryVideoCost } from "./tokenEstimate";

/** The kinds of media a content part can carry. */
export type MediaKind = "image" | "video" | "pdf";

export const MEDIA_KINDS: readonly MediaKind[] = ["image", "video", "pdf"];

// A Map, not an object literal: a part's `type` is untrusted (persisted
// history, extraBody), and `type: "constructor"` must not read Object.prototype.
const KIND_OF: ReadonlyMap<unknown, MediaKind> = new Map<unknown, MediaKind>([
  ["image_url", "image"],
  ["video_url", "video"],
  ["file", "pdf"],
]);

/**
 * The media kind a part carries, or `undefined` for text — and for a part of
 * a type nobody knows, which no rule here can admit or remove; an adapter
 * refuses it by name (`unsendablePart`).
 */
export function partKind(part: ContentPart): MediaKind | undefined {
  return KIND_OF.get((part as { type?: unknown }).type);
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

/**
 * What the model reads where a part of each kind was not sent. Written to the
 * model, in English like the other elision notes, so it can tell the author
 * why it cannot see what the history says was attached.
 */
const NOT_SENT: Readonly<Record<MediaKind, string>> = {
  image: "[picture not sent: the model now answering does not read pictures — the author can switch back to one that does]",
  video: "[video clip not sent: the model now answering does not take video on this route — the author can switch back to one that does]",
  pdf: "[PDF not sent: the model now answering does not take PDF files on this route — the author can switch back to one that does]",
};

/**
 * The messages as this request may carry them: every part of a kind the plan
 * does not admit (`RequestPlan.media`) replaced by a note, the words kept; every
 * admitted clip carrying this request's `fps` (`RequestPlan.clipFps`) — the
 * plan's value written, or the field removed, whatever the clip was attached
 * with.
 *
 * A projection, not an edit. The history is the record of what the author
 * attached, and it outlives the model: switch to one that cannot take a clip
 * and the clip goes out as a note; switch back and it goes out again. Switch
 * from 智谱 to a DashScope model that declares `fps: 0.5` and the clip goes out
 * at 0.5, and back without it. So this returns a new array and never writes
 * into the one it was given — messages it leaves alone are the same objects,
 * the ones it changes are copies, and a copied clip keeps its estimated cost
 * (`carryVideoCost`).
 *
 * `streamCompletion` calls it before anything else reads the messages, so the
 * token estimate, the picture-payload gate, the API log and the adapter all
 * see the request that is actually sent.
 */
export function admitMedia(
  messages: readonly StreamMessage[], admission: MediaAdmission, fps: ClipFps,
): StreamMessage[] {
  const refused = MEDIA_KINDS.filter((k) => !admission[k]);
  return messages.map((m) => {
    // Only the plain variant carries parts; a tool-call turn's content is null.
    if (!Array.isArray(m.content)) return m;
    const kinds = new Set<MediaKind>();
    for (const p of m.content) {
      const kind = partKind(p);
      if (kind && refused.includes(kind)) kinds.add(kind);
    }
    const content = withClipFps(m.content, fps);
    if (!kinds.size) return content === m.content ? m : ({ ...m, content } as StreamMessage);
    const note = MEDIA_KINDS.filter((k) => kinds.has(k)).map((k) => NOT_SENT[k]).join("\n");
    return { ...m, content: withoutParts(content, kinds, note) } as StreamMessage;
  });
}

/**
 * `parts` with every clip carrying `fps` — the same array when none needed a
 * change (a request left `"as-built"`, or clips that already say it), so an
 * untouched message stays the same object.
 */
function withClipFps(parts: ContentPart[], fps: ClipFps): ContentPart[] {
  if (fps === "as-built") return parts;
  let changed = false;
  const out = parts.map((p) => {
    if (p.type !== "video_url") return p;
    const { fps: carried, ...rest } = p;
    if (fps === "none" ? carried === undefined : carried === fps) return p;
    changed = true;
    const copy: ContentPart = fps === "none" ? rest : { ...rest, fps };
    carryVideoCost(p, copy);
    return copy;
  });
  return changed ? out : parts;
}
