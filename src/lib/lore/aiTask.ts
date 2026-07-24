/**
 * Shared engine for lore AI-assist tasks.
 *
 * Every AI flow that touches a lore file — improve an entity's index.md, write
 * a facet, extract a new entity from text/images — is the same shape:
 *   pick model → gather @-attachments (images / text / other lore) → build a
 *   multimodal request → stream → strip fences → write the result back.
 *
 * These helpers own that mechanical middle so each surface only supplies a
 * system prompt, the context text, and where to write the output. The UI half
 * (the @-picker + chips) lives in `components/lore/ai/AttachmentTextarea`.
 */

import { readEntityFile } from "./entity";
import type { LoreEntity } from "./model";
import type { ProjectFile } from "../fs/images";
import type { Model, Provider } from "../ai/configDb";
import type { ContentPart, StreamMessage } from "../ai/types";

// ── Attachments ──────────────────────────────────────────────────────────────

export type AttachedLore  = { kind: "lore";  entity: LoreEntity };
export type AttachedImage = { kind: "image"; file: ProjectFile; dataUrl: string };
export type AttachedText  = { kind: "text";  file: ProjectFile; content: string };
export type AttachedItem  = AttachedLore | AttachedImage | AttachedText;

/** Stable identity for an attachment, used for dedupe and chip keys. */
export function attachedKey(a: AttachedItem): string {
  return a.kind === "lore" ? `lore:${a.entity.id}` : `file:${a.file.path}`;
}

// ── Model resolution ─────────────────────────────────────────────────────────

/** Resolve the active model together with its provider, or null if unavailable. */
export function resolveModel(
  models: Model[],
  providers: Provider[],
  activeModelId: string | null,
): { model: Model; provider: Provider } | null {
  const model = models.find((m) => m.id === activeModelId);
  const provider = model ? providers.find((p) => p.id === model.providerId) : null;
  if (!model || !provider) return null;
  return { model, provider };
}

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
    ...images.map((a): ContentPart => ({ type: "image_url", image_url: { url: a.dataUrl } })),
  ];
}

/** Strip a wrapping ```markdown fence some models add around whole-file output. */
export function stripCodeFence(raw: string): string {
  const content = raw.trim();
  const fence = content.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/);
  return fence ? fence[1] : content;
}

// ── Streaming ────────────────────────────────────────────────────────────────

export interface StreamLoreTaskArgs {
  model: Model;
  provider: Provider;
  apiKey: string;
  systemPrompt: string;
  userContent: string | ContentPart[];
  signal?: AbortSignal;
  /** Called on every chunk with the full accumulated text so far. */
  onText: (accumulated: string) => void;
}

/** Run one streaming completion and resolve with the full accumulated text. */
export async function streamLoreTask(args: StreamLoreTaskArgs): Promise<string> {
  const { model, provider, apiKey, systemPrompt, userContent, signal, onText } = args;
  const { streamCompletion } = await import("../ai");
  let accumulated = "";
  const messages: StreamMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
  await streamCompletion({
    baseUrl: provider.baseUrl,
    apiKey,
    standard: provider.apiStandard,
    safetySettings: provider.safetySettings,
    modelId: model.modelId,
    prefix: model.prefix,
    contextSize: model.contextSize,
    messages,
    onChunk: (chunk) => {
      if ("text" in chunk) {
        accumulated += chunk.text;
        onText(accumulated);
      }
    },
    signal,
  });
  return accumulated;
}
