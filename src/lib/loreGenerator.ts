/**
 * AI-assisted Lore entity generation.
 * Takes a text description + optional reference images, calls the selected
 * multimodal model, and returns a structured GeneratedLore ready to save.
 */

import { readFile as readBinaryFile, readDir } from "@tauri-apps/plugin-fs";
import i18n from "../i18n";
import type { ApiStandard } from "./aiConfig";
import type { CategoryId } from "./lore";

export interface ProjectImage {
  name: string;
  path: string;
}

export interface GeneratedLore {
  name: string;
  category: CategoryId;
  aliases: string[];
  summary: string;
  content: string;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** Recursively scan the project folder for image files (max depth 5). */
export async function scanProjectImages(projectPath: string): Promise<ProjectImage[]> {
  const results: ProjectImage[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > 5) return;
    try {
      const entries = await readDir(dir);
      for (const e of entries) {
        if (!e.name) continue;
        if (e.isDirectory && !e.name.startsWith(".")) {
          await walk(`${dir}/${e.name}`, depth + 1);
        } else if (!e.isDirectory) {
          const ext = e.name.split(".").pop()?.toLowerCase() ?? "";
          if (IMAGE_EXTS.has(ext)) {
            results.push({ name: e.name, path: `${dir}/${e.name}` });
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


export async function generateLore(opts: {
  description: string;
  images: { dataUrl: string }[];
  baseUrl: string;
  apiKey: string;
  standard: ApiStandard;
  modelId: string;
  onProgress: (text: string) => void;
  signal?: AbortSignal;
  systemPrompt?: string;
}): Promise<GeneratedLore> {
  const { streamCompletion } = await import("./aiClient");

  const userParts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
    { type: "text", text: opts.description || "请根据附图创建一个设定条目。" },
    ...opts.images.map((img) => ({
      type: "image_url" as const,
      image_url: { url: img.dataUrl },
    })),
  ];

  // OpenAI JSON mode: pass response_format only for openai/compat standards
  const extraBody = opts.standard !== "gemini"
    ? { response_format: { type: "json_object" } }
    : {};

  let fullText = "";
  await streamCompletion({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    standard: opts.standard,
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

  const jsonMatch = fullText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("AI 未返回有效 JSON，请换个模型重试。");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error("解析 AI 响应失败，请重试。");
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
