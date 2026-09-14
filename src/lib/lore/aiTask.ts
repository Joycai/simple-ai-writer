/**
 * Shared helpers for lore AI-assist tasks: model resolution, @-attachment
 * gathering (images / text / other lore), user-content assembly, and fence
 * stripping. The UI half (the @-picker + chips) lives in
 * `components/lore/ai/AttachmentTextarea`.
 *
 * The streaming half moved to the unified agent runtime — surfaces call
 * `runLoreAgentTask` (lib/agent/run) with a task preset instead of the old
 * `streamLoreTask`, gaining tool use and execution-log events.
 */

import { imageForModel, type Downscaled } from "../image/normalize";
import { readEntityFile } from "./entity";
import type { LoreEntity } from "./model";
import { MAX_IMAGE_BYTES, readTextFileContent, type ProjectFile } from "../fs/images";
import type { ContentPart } from "../ai/types";
import { imagePart } from "../ai/imagePart";
import { MAX_VIDEO_BYTES, MIN_VIDEO_SECONDS, readVideoForModel, videoMimeOf, type ModelVideo } from "../fs/video";

// ── Attachments ──────────────────────────────────────────────────────────────

export type AttachedLore  = { kind: "lore";  entity: LoreEntity };
/**
 * `downscaled` is set when the picture was re-encoded on its way in
 * (lib/image/normalize) — carried so the composer can say so on the chip.
 * Nothing on the wire reads it: `dataUrl` is already the shrunken payload.
 */
export type AttachedImage = {
  kind: "image";
  file: ProjectFile;
  dataUrl: string;
  downscaled?: Downscaled;
};
export type AttachedText  = { kind: "text";  file: ProjectFile; content: string };
/**
 * A recording / video mentioned by path only: nothing is read here, because
 * no model API takes the bytes. The chat message names it and points at
 * `transcribe_audio` (lib/agent/chatRefs); the lore surfaces never offer it.
 */
export type AttachedMedia = { kind: "media"; file: ProjectFile };
/**
 * A video clip read for a model that declares `videoInput` (lib/fs/video).
 * Only the chat composer builds one, and only when asked to — the same file
 * picked for any other model stays an {@link AttachedMedia} pointer. Duration
 * and frame size are what the chip's ≈ token estimate is computed from;
 * absent for a WebM.
 */
export type AttachedVideo = { kind: "video"; file: ProjectFile } & ModelVideo;
export type AttachedItem  = AttachedLore | AttachedImage | AttachedText | AttachedMedia | AttachedVideo;

/** Stable identity for an attachment, used for dedupe and chip keys. */
export function attachedKey(a: AttachedItem): string {
  return a.kind === "lore" ? `lore:${a.entity.id}` : `file:${a.file.path}`;
}

/** Why a file could not become an attachment — the two ways a pick fails. */
type AttachFailure =
  | { ok: false; reason: "too-large"; sizeMb: string; maxMb: number }
  | { ok: false; reason: "too-short"; seconds: string; minSeconds: number }
  | { ok: false; reason: "unreadable" };
type AttachOutcome = { ok: true; item: AttachedItem } | AttachFailure;

/**
 * Turn a project file into the attachment the composer carries — the one
 * construction path behind every way of picking a file (the `@` mention and
 * the file tree's 发送到助手).
 *
 * Failures are values, not throws, because both matter to the author *now*:
 * an oversized picture is refused at pick time rather than silently dropped
 * from a message sent minutes later, and each caller words the refusal for
 * its own surface. A picture may come back re-encoded (`imageForModel`) — an
 * oversized one is shrunk to fit, and only one that survives even that is
 * turned away.
 */
export async function attachProjectFile(
  file: ProjectFile,
  opts: {
    /**
     * The composer's model can take a clip (`canReadVideo`). Without it a
     * video stays a path, exactly as before — the file tree's 发送到助手 does
     * not pass it.
     */
    video?: boolean;
  } = {},
): Promise<AttachOutcome> {
  if (file.kind === "media" && opts.video && videoMimeOf(file.path)) {
    try {
      const read = await readVideoForModel(file.path);
      if (read.ok) return { ok: true, item: { kind: "video", file, ...read.video } };
      if (read.reason === "too-large") {
        return {
          ok: false,
          reason: "too-large",
          sizeMb: (read.sizeBytes / 1_000_000).toFixed(1),
          maxMb: MAX_VIDEO_BYTES / 1_000_000,
        };
      }
      if (read.reason === "too-short") {
        return { ok: false, reason: "too-short", seconds: read.durationSec.toFixed(1), minSeconds: MIN_VIDEO_SECONDS };
      }
      return { ok: false, reason: "unreadable" };
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }
  // A mention, not a payload: the file stays on disk and the message carries
  // its path. Reading a 2GB recording here would only be thrown away.
  if (file.kind === "media") return { ok: true, item: { kind: "media", file } };
  if (file.kind === "image") {
    try {
      const { dataUrl, bytes, downscaled } = await imageForModel(file.path);
      if (bytes.length > MAX_IMAGE_BYTES) {
        return {
          ok: false,
          reason: "too-large",
          sizeMb: (bytes.length / 1024 / 1024).toFixed(1),
          maxMb: MAX_IMAGE_BYTES / 1024 / 1024,
        };
      }
      return { ok: true, item: { kind: "image", file, dataUrl, downscaled } };
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }
  try {
    return { ok: true, item: { kind: "text", file, content: await readTextFileContent(file.path) } };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

// Model resolution used to live here as `resolveModel`. It is now
// `resolveConn` in lib/ai/conn — one implementation, and it says *which* of the
// three failures happened instead of reporting all of them as "no model".

// ── Prompt assembly ──────────────────────────────────────────────────────────

/**
 * Read attachment payloads into prompt-ready pieces. Lore refs are pulled from
 * each entity's index.md; text files are inlined; images are included only when
 * the model is multimodal (a text model would error or silently drop them).
 */
export async function collectAttachmentContext(
  attached: AttachedItem[],
  supportsImages: boolean,
): Promise<{ loreRefs: string[]; textRefs: string[]; images: AttachedImage[] }> {
  const loreRefs = await Promise.all(
    attached
      .filter((a): a is AttachedLore => a.kind === "lore")
      .map(async (a) => {
        try {
          const c = await readEntityFile(a.entity.dirPath, "index.md");
          return `## ${a.entity.name}\n${c}`;
        } catch {
          return `## ${a.entity.name}\n(unavailable)`;
        }
      }),
  );

  const textRefs = attached
    .filter((a): a is AttachedText => a.kind === "text")
    .map((a) => `--- ${a.file.name} ---\n${a.content}`);

  const images = supportsImages
    ? attached.filter((a): a is AttachedImage => a.kind === "image")
    : [];

  return { loreRefs, textRefs, images };
}

/**
 * Build the user message content. Returns a plain string unless there are image
 * parts — a spurious single-element parts array confuses some Gemini endpoints,
 * so text-only tasks stay as strings.
 */
export function buildUserContent(textContent: string, images: AttachedImage[]): string | ContentPart[] {
  if (images.length === 0) return textContent;
  return [
    { type: "text", text: textContent },
    ...images.map((a) => imagePart(a.dataUrl)),
  ];
}

/** Strip a wrapping ```markdown fence some models add around whole-file output. */
export function stripCodeFence(raw: string): string {
  const content = raw.trim();
  const fence = content.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/);
  return fence ? fence[1] : content;
}

