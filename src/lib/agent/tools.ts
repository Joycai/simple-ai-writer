/**
 * Tool implementations for the agent runtime.
 *
 * This module owns the *handlers* — reading lore, listing/reading writing
 * files — plus the path-containment helpers that keep model-controlled path
 * arguments inside the project. Wire definitions and dispatch live in
 * registry.ts; the loop that drives calls lives in runtime.ts.
 */

import { readDir } from "@tauri-apps/plugin-fs";
import { readFile } from "../fs/fileio";
import { imageToDataUrl } from "../fs/images";
import { readEntityFile, type LoreEntity, type LoreIndex } from "../lore";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  imageDataUrls?: string[];
}

// ─── Path containment ────────────────────────────────────────────────────────

/** Lexically resolve `.`/`..` segments (both `/` and `\` separators). */
export function normalizePathSegments(p: string): string {
  const isAbsolute = /^[/\\]/.test(p);
  const out: string[] = [];
  for (const part of p.split(/[/\\]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop(); // no-op at root — `..` cannot climb above it
      continue;
    }
    out.push(part);
  }
  return (isAbsolute ? "/" : "") + out.join("/");
}

/**
 * True when `target` equals `base` or lives inside it, comparing normalized
 * paths on whole component boundaries (so `/project-evil` is NOT within
 * `/project`, and `/project/../etc` is rejected).
 */
export function isPathWithin(base: string, target: string): boolean {
  const b = normalizePathSegments(base);
  const t = normalizePathSegments(target);
  return t === b || t.startsWith(b + "/");
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export function formatLoreIndex(loreIndex: LoreIndex): string {
  const lines: string[] = [];
  for (const [category, entities] of Object.entries(loreIndex)) {
    if (!entities.length) continue;
    lines.push(`[${category}]`);
    for (const e of entities) {
      lines.push(`  - ${e.name}: ${e.summary || "(no summary)"}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "No lore entities found in this project.";
}

export async function readLoreEntity(
  toolCallId: string,
  name: string,
  loreIndex: LoreIndex,
  multimodal: boolean,
): Promise<ToolResult> {
  const lower = name.toLowerCase();
  let found: LoreEntity | undefined;
  for (const entities of Object.values(loreIndex)) {
    found = entities.find(
      (e) =>
        e.name.toLowerCase() === lower ||
        e.aliases?.some((a) => a.toLowerCase() === lower),
    );
    if (found) break;
  }

  if (!found) {
    const allNames = Object.values(loreIndex)
      .flat()
      .map((e) => e.name)
      .join(", ");
    return {
      toolCallId,
      content: `Entity "${name}" not found. Available: ${allNames || "none"}`,
    };
  }

  const filenames = found.mdFiles?.length ? found.mdFiles : ["index.md"];
  const parts: string[] = [];
  for (const filename of filenames) {
    if (filename === "images.md") continue; // surfaced separately as the gallery block
    try {
      const content = await readEntityFile(found.dirPath, filename);
      parts.push(`=== ${filename} ===\n${content}`);
    } catch {
      // skip unreadable files silently
    }
  }

  // Gallery: always emit textual descriptions (incl. the avatar). Text-only
  // models still get a useful description; multimodal models additionally
  // receive the binary payload below.
  const galleryLines: string[] = [];
  if (found.avatarPath) {
    const fname = found.avatarPath.split(/[\\/]/).pop() ?? "avatar";
    galleryLines.push(`- ${fname}: (avatar)`);
  }
  for (const img of found.images) {
    galleryLines.push(`- ${img.file}: ${img.desc || "(no description)"}`);
  }
  if (galleryLines.length) {
    const header = multimodal
      ? "=== images === (descriptions; binary attached below)"
      : "=== images === (text descriptions only — current model is text-only)";
    parts.push(`${header}\n${galleryLines.join("\n")}`);
  }

  const textContent = parts.join("\n\n") || "(no content)";

  if (!multimodal) {
    return { toolCallId, content: textContent };
  }

  // Multimodal: load avatar + all gallery images as data URLs. Failures per
  // file are swallowed so one missing/corrupt image doesn't break the call.
  const imageDataUrls: string[] = [];
  const imagePaths = [
    ...(found.avatarPath ? [found.avatarPath] : []),
    ...found.images.map((i) => i.absPath),
  ];
  for (const p of imagePaths) {
    try {
      const { dataUrl } = await imageToDataUrl(p);
      imageDataUrls.push(dataUrl);
    } catch {
      // skip unreadable image
    }
  }

  return imageDataUrls.length
    ? { toolCallId, content: textContent, imageDataUrls }
    : { toolCallId, content: textContent };
}

export async function listWritingFiles(
  toolCallId: string,
  projectPath: string,
  folder?: string,
): Promise<ToolResult> {
  const base = `${projectPath}/writing`;
  const target = folder ? `${base}/${folder}` : base;
  // The folder argument is model-controlled — reject `../` escapes.
  if (!isPathWithin(base, target)) {
    return { toolCallId, content: "Error: Folder is outside the project writing directory." };
  }
  try {
    const entries = await readDir(target);
    const paths = entries
      .filter((e) => e.name && !e.name.startsWith(".") && !e.isDirectory)
      .map((e) => `${target}/${e.name}`);
    return {
      toolCallId,
      content: paths.length > 0
        ? paths.join("\n")
        : `No files found in ${folder ? `writing/${folder}` : "writing/"}.`,
    };
  } catch (e) {
    return { toolCallId, content: `Error listing files: ${String(e)}` };
  }
}

export async function readWritingFile(
  toolCallId: string,
  path: string,
  projectPath: string,
): Promise<ToolResult> {
  // The path argument is model-controlled. A plain startsWith check would
  // accept `../` traversal (`/project/../etc/x`) and prefix siblings
  // (`/project-evil/x`), so compare lexically normalized paths on whole
  // component boundaries.
  if (!isPathWithin(projectPath, path)) {
    return { toolCallId, content: "Error: Path is outside the project directory." };
  }
  try {
    const raw = await readFile(path);
    const MAX = 4000;
    const content =
      raw.length > MAX
        ? raw.slice(0, MAX) + `\n\n[... truncated at ${MAX} characters ...]`
        : raw;
    return { toolCallId, content };
  } catch (e) {
    return { toolCallId, content: `Error reading file: ${String(e)}` };
  }
}
