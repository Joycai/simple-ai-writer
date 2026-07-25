/**
 * Tool registry for the agent runtime.
 *
 * Every tool the model can call is registered here once: its wire definition
 * (OpenAI function schema), its access level, and its executor. Task presets
 * (presets.ts) pick tools by id; the runtime resolves definitions and dispatches
 * calls through this registry instead of a hardcoded switch.
 *
 * Access levels gate what a tool may do to the project:
 *   - "read"           — no writes anywhere (current four tools)
 *   - "write-auto"     — may write lore/.ai-writer state; applied automatically
 *                        with a backup (PR2)
 *   - "write-approval" — produces a proposal the user must approve before it
 *                        lands (manuscript edits, PR4)
 * The runtime itself only executes; enforcement of the write policies lives
 * with the write tools' executors + the approval queue (see
 * docs/unified-agent-plan.md §3.2).
 */

import type { ToolDefinition } from "../ai/types";
import type { LoreIndex } from "../lore";
import {
  formatLoreIndex,
  listWritingFiles,
  readLoreEntity,
  readWritingFile,
  type ToolCall,
  type ToolResult,
} from "./tools";

export type ToolAccess = "read" | "write-auto" | "write-approval";

/** Everything an executor may need about the running project. */
export interface ToolContext {
  projectPath: string;
  loreIndex: LoreIndex;
  /** Whether the active model accepts image inputs (controls lore gallery payloads). */
  multimodal: boolean;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  access: ToolAccess;
  execute: (call: ToolCall, ctx: ToolContext) => Promise<ToolResult>;
}

export type ToolId =
  | "list_lore_entities"
  | "read_lore_entity"
  | "list_files"
  | "read_file";

const REGISTRY: Record<ToolId, RegisteredTool> = {
  list_lore_entities: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "list_lore_entities",
        description:
          "List all lore entities (characters, world, factions, items, skills, style, custom) in the project. Returns entity names, categories, and one-line summaries. Call this first to discover available lore before reading specific entries.",
        parameters: { type: "object", properties: {} },
      },
    },
    execute: async (call, ctx) => ({
      toolCallId: call.id,
      content: formatLoreIndex(ctx.loreIndex),
    }),
  },

  read_lore_entity: {
    access: "read",
    definition: {
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
    execute: async (call, ctx) => {
      const args = JSON.parse(call.arguments || "{}") as { name?: string };
      if (!args.name) return { toolCallId: call.id, content: "Error: 'name' argument is required." };
      return readLoreEntity(call.id, args.name, ctx.loreIndex, ctx.multimodal);
    },
  },

  list_files: {
    access: "read",
    definition: {
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
    execute: async (call, ctx) => {
      const args = JSON.parse(call.arguments || "{}") as { folder?: string };
      return listWritingFiles(call.id, ctx.projectPath, args.folder);
    },
  },

  read_file: {
    access: "read",
    definition: {
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
    execute: async (call, ctx) => {
      const args = JSON.parse(call.arguments || "{}") as { path?: string };
      if (!args.path) return { toolCallId: call.id, content: "Error: 'path' argument is required." };
      return readWritingFile(call.id, args.path, ctx.projectPath);
    },
  },
};

/** Resolve wire definitions for a preset's toolset, preserving order. */
export function getToolDefinitions(ids: readonly ToolId[]): ToolDefinition[] {
  return ids.map((id) => REGISTRY[id].definition);
}

/**
 * Execute one model-requested tool call. Unknown tools and executor throws both
 * come back as error-text results — the model gets to read the error and retry,
 * and a single bad call never kills the run.
 */
export async function executeRegisteredTool(
  call: ToolCall,
  allowed: readonly ToolId[],
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = (allowed as readonly string[]).includes(call.name)
    ? REGISTRY[call.name as ToolId]
    : undefined;
  if (!tool) return { toolCallId: call.id, content: `Unknown tool: ${call.name}` };
  try {
    return await tool.execute(call, ctx);
  } catch (e) {
    return { toolCallId: call.id, content: `Error: ${String(e)}` };
  }
}
