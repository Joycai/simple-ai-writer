/**
 * AI-assisted Lore entity generation.
 * Takes a text description + optional reference images/text files, calls the
 * selected model, and returns a structured GeneratedLore ready to save.
 */

import { readFile as readBinaryFile } from "@tauri-apps/plugin-fs";
import { readFile as readTextFile, readDir } from "./fileio";
import i18n from "../i18n";
import type { ApiStandard, GeminiSafetySettings } from "./aiConfig";
import type { CategoryId } from "./lore";

export type ProjectFileKind = "image" | "text";

export interface ProjectFile {
  name: string;
  path: string;
  kind: ProjectFileKind;
}

/** @deprecated use ProjectFile */
export type ProjectImage = ProjectFile;

export interface GeneratedLore {
  name: string;
  category: CategoryId;
  aliases: string[];
  summary: string;
  content: string;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const TEXT_EXTS  = new Set(["md", "txt"]);

const MIME: Record<string, string> = {
  png:  "image/png",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif:  "image/gif",
};

/** Recursively scan the project folder for image and text files (max depth 5). */
export async function scanProjectFiles(projectPath: string): Promise<ProjectFile[]> {
  const results: ProjectFile[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > 5) return;
    try {
      const entries = await readDir(dir);
      for (const e of entries) {
        if (e.isDirectory && !e.name.startsWith(".")) {
          await walk(e.path, depth + 1);
        } else if (!e.isDirectory) {
          const ext = e.name.split(".").pop()?.toLowerCase() ?? "";
          if (IMAGE_EXTS.has(ext)) {
            results.push({ name: e.name, path: e.path, kind: "image" });
          } else if (TEXT_EXTS.has(ext)) {
            results.push({ name: e.name, path: e.path, kind: "text" });
          }
        }
      }
    } catch {
      // unreadable dirs are skipped
    }
  }

  await walk(projectPath, 0);
  return results;
}

/** @deprecated use scanProjectFiles */
export const scanProjectImages = scanProjectFiles;

/** Read an image file and return a base64 data URL. */
export async function imageToDataUrl(imagePath: string): Promise<{ dataUrl: string; ext: string; bytes: Uint8Array }> {
  const bytes = await readBinaryFile(imagePath);
  const u8 = new Uint8Array(bytes as ArrayBuffer);
  const ext = imagePath.split(".").pop()?.toLowerCase() ?? "png";
  const mime = MIME[ext] ?? "image/png";

  // Uint8Array → base64 in chunks to avoid call-stack overflow on large images
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);
  return { dataUrl: `data:${mime};base64,${base64}`, ext, bytes: u8 };
}

/** Read a text file (.md / .txt) and return its content string. */
export async function readTextFileContent(filePath: string): Promise<string> {
  return readTextFile(filePath);  // from fileio.ts
}

export async function generateLore(opts: {
  description: string;
  images: { dataUrl: string }[];
  textAttachments?: { name: string; content: string }[];
  baseUrl: string;
  apiKey: string;
  standard: ApiStandard;
  safetySettings?: GeminiSafetySettings;
  modelId: string;
  onProgress: (text: string) => void;
  signal?: AbortSignal;
  systemPrompt?: string;
}): Promise<GeneratedLore> {
  const { streamCompletion } = await import("./aiClient");

  // Strip @[filename] visual placeholders from the user description — they're UI labels only.
  const cleanDesc = opts.description.replace(/@\[[^\]]*\]/g, "").trim();

  // Build the text portion of the prompt.
  // 200 000 chars ≈ 50–100 k tokens — covers even large settings docs on modern
  // models (Gemini 1.5/2.0 Flash/Pro support 1 M token context windows).
  const MAX_REF_CHARS = 500_000;
  const refs = (opts.textAttachments ?? [])
    .map((ta) => {
      const body = ta.content.length > MAX_REF_CHARS
        ? ta.content.slice(0, MAX_REF_CHARS) + `\n…[truncated, ${ta.content.length - MAX_REF_CHARS} chars omitted]`
        : ta.content;
      return `--- Reference: ${ta.name} ---\n${body}\n---`;
    })
    .join("\n\n");

  let promptText: string;
  if (refs) {
    // Explicit extraction instruction so the model treats the file as reference material.
    promptText = cleanDesc
      ? `${cleanDesc}\n\nReference materials:\n${refs}`
      : `Extract a lore entity from the following reference text and output as JSON:\n\n${refs}`;
  } else {
    promptText = cleanDesc || "请根据附图创建一个设定条目。";
  }

  const userParts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
    { type: "text", text: promptText },
    ...opts.images.map((img) => ({
      type: "image_url" as const,
      image_url: { url: img.dataUrl },
    })),
  ];

  // JSON mode: use native API enforcement where available.
  // For Gemini, also append a text reminder as belt-and-suspenders (some older models
  // silently ignore responseMimeType and need the text cue too).
  const extraBody = opts.standard === "gemini"
    ? { generationConfig: { responseMimeType: "application/json" } }
    : { response_format: { type: "json_object" } };

  if (opts.standard === "gemini") {
    userParts.push({
      type: "text",
      text: "Output ONLY valid JSON matching the schema in the system instructions. No markdown fences, no explanation.",
    });
  }

  let fullText = "";
  await streamCompletion({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    standard: opts.standard,
    safetySettings: opts.safetySettings,
    modelId: opts.modelId,
    messages: [
      { role: "system", content: opts.systemPrompt ?? i18n.t("ai.instructions.lore") },
      { role: "user", content: userParts },
    ],
    extraBody,
    onChunk: (chunk) => {
      if ("text" in chunk) {
        fullText += chunk.text;
        opts.onProgress(chunk.text);
      }
    },
    signal: opts.signal,
  });

  // Extract JSON: try clean parse first, then markdown fences, then first-{-to-last-}
  const trimmed = fullText.trim();
  let jsonStr: string | undefined;
  if (trimmed.startsWith("{")) {
    jsonStr = trimmed;
  } else {
    const fenceMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1];
    } else {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start !== -1 && end > start) jsonStr = trimmed.slice(start, end + 1);
    }
  }
  if (!jsonStr) {
    const preview = trimmed.slice(0, 300) || "(empty response)";
    throw new Error(`Model did not return valid JSON.\n\nResponse preview:\n${preview}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Failed to parse model response as JSON.\n\nResponse preview:\n${jsonStr!.slice(0, 300)}`);
  }

  return {
    name:     typeof parsed.name     === "string" ? parsed.name     : "未命名",
    category: (["characters","world","factions","items","skills","custom"].includes(parsed.category as string)
               ? parsed.category as CategoryId : "custom"),
    aliases:  Array.isArray(parsed.aliases) ? parsed.aliases.filter((a): a is string => typeof a === "string") : [],
    summary:  typeof parsed.summary  === "string" ? parsed.summary  : "",
    content:  typeof parsed.content  === "string" ? parsed.content  : "",
  };
}
