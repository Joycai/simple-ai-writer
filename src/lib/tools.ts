/**
 * Tool definitions and executor for the agentic "continue" loop.
 * Tools let the AI read history chapters and lore before writing.
 */

import { readDir } from "@tauri-apps/plugin-fs";
import type { ToolDefinition } from "./aiClient";
import type { LoreIndex, LoreEntity } from "./lore";
import { readEntityFile } from "./lore";
import { readFile } from "./fileio";
import { imageToDataUrl } from "./loreGenerator";

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
        "List all lore entities (characters, world, factions, items, skills, custom) in the project. Returns entity names, categories, and one-line summaries. Call this first to discover available lore before reading specific entries.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_lore_entity",
      description:
        "Read the full detail of a lore entity including its index.md and all supplementary .md files. If the entity has an avatar image it is also returned. Call list_lore_entities first to get the exact entity names.",
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

export async function executeTool(
  call: ToolCall,
  projectPath: string,
  loreIndex: LoreIndex,
): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "list_lore_entities":
        return { toolCallId: call.id, content: formatLoreIndex(loreIndex) };

      case "read_lore_entity": {
        const args = JSON.parse(call.arguments || "{}") as { name?: string };
        if (!args.name) return { toolCallId: call.id, content: "Error: 'name' argument is required." };
        return await readLoreEntity(call.id, args.name, loreIndex);
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
    try {
      const content = await readEntityFile(found.dirPath, filename);
      parts.push(`=== ${filename} ===\n${content}`);
    } catch {
      // skip unreadable files silently
    }
  }

  const textContent = parts.join("\n\n") || "(no content)";

  if (found.avatarPath) {
    try {
      const { dataUrl } = await imageToDataUrl(found.avatarPath);
      return { toolCallId, content: textContent, imageDataUrls: [dataUrl] };
    } catch {
      // skip image on error, return text only
    }
  }

  return { toolCallId, content: textContent };
}

async function listWritingFiles(
  toolCallId: string,
  projectPath: string,
  folder?: string,
): Promise<ToolResult> {
  const base = `${projectPath}/writing`;
  const target = folder ? `${base}/${folder}` : base;
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
  if (!path.startsWith(projectPath)) {
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
