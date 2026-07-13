/**
 * Tool definitions and executor for the agentic "continue" loop.
 * Tools let the AI read history chapters and lore before writing.
 */

import { readDir } from "@tauri-apps/plugin-fs";
import type { ToolDefinition } from "../ai/types";
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

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_lore_entities",
      description:
        "List all lore entities (characters, world, factions, items, skills, style, custom) in the project. Returns entity names, categories, and one-line summaries. Call this first to discover available lore before reading specific entries.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_lore_entity",
      description:
        "Read the full detail of a lore entity including its index.md and all supplementary .md files. The entity may also have a gallery (avatar + images.md listing additional pictures with descriptions): for multimodal models the binary images are attached, for text-only models only the descriptions are returned. Call list_lore_entities first to get the exact entity names.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The entity name exactly as returned by list_lore_entities",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files in the project's writing directory (or a subfolder). Returns absolute file paths. Use this to discover chapter files before reading them.",
      parameters: {
        type: "object",
        properties: {
          folder: {
            type: "string",
            description:
              "Subfolder relative to the project writing/ directory. Omit to list the top-level writing/ directory.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the text content of a writing file. Use the path exactly as returned by list_files. Content is truncated to 4000 characters if the file is large.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path as returned by list_files",
          },
        },
        required: ["path"],
      },
    },
  },
];

export interface ExecuteToolOptions {
  /**
   * Whether the active model can ingest images. When false, `read_lore_entity`
   * still emits the text descriptions from `images.md` (and notes that an avatar
   * exists) but skips the base64 image payload.
   */
  multimodal: boolean;
}

export async function executeTool(
  call: ToolCall,
  projectPath: string,
  loreIndex: LoreIndex,
  opts: ExecuteToolOptions = { multimodal: false },
): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "list_lore_entities":
        return { toolCallId: call.id, content: formatLoreIndex(loreIndex) };

      case "read_lore_entity": {
        const args = JSON.parse(call.arguments || "{}") as { name?: string };
        if (!args.name) return { toolCallId: call.id, content: "Error: 'name' argument is required." };
        return await readLoreEntity(call.id, args.name, loreIndex, opts.multimodal);
      }

      case "list_files": {
        const args = JSON.parse(call.arguments || "{}") as { folder?: string };
        return await listWritingFiles(call.id, projectPath, args.folder);
      }

      case "read_file": {
        const args = JSON.parse(call.arguments || "{}") as { path?: string };
        if (!args.path) return { toolCallId: call.id, content: "Error: 'path' argument is required." };
        return await readWritingFile(call.id, args.path, projectPath);
      }

      default:
        return { toolCallId: call.id, content: `Unknown tool: ${call.name}` };
    }
  } catch (e) {
    return { toolCallId: call.id, content: `Error: ${String(e)}` };
  }
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

function formatLoreIndex(loreIndex: LoreIndex): string {
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

async function readLoreEntity(
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

async function listWritingFiles(
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

async function readWritingFile(
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
