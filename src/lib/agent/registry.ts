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
import { LORE_CATEGORIES, type LoreIndex } from "../lore";
import {
  formatLoreIndex,
  listWritingFiles,
  readLoreEntity,
  readWritingFile,
  type ToolCall,
  type ToolResult,
} from "./tools";
import { LORE_PLAN_ACTIONS, type LorePlan, type PlanDecision, type PlanGate } from "./plan";
import {
  createLoreEntityTool,
  deleteLoreEntityTool,
  moveLoreEntityTool,
  proposeEditTool,
  proposeLorePlanTool,
  readMemoryTool,
  updateLoreFileTool,
  updateMemoryTool,
} from "./writeTools";

export type ToolAccess = "read" | "write-auto" | "write-approval";

/** A manuscript edit the model proposed — nothing is written until approved. */
export interface EditProposal {
  id: string;
  /** Absolute path of the writing file. */
  path: string;
  /** Exact text to replace — must occur exactly once in the file. */
  find: string;
  replace: string;
  /** Model's one-line justification, shown on the approval card. */
  reason?: string;
}

export type ApprovalDecision =
  | { approved: true; backupPath?: string | null }
  | { approved: false; reason?: string };

/** Everything an executor may need about the running project. */
export interface ToolContext {
  projectPath: string;
  loreIndex: LoreIndex;
  /** Whether the active model accepts image inputs (controls lore gallery payloads). */
  multimodal: boolean;
  /**
   * Called after a write-auto tool changed lore on disk, so the caller can
   * rescan loreStore and the UI reflects the agent's edit immediately.
   * NOTE: ctx.loreIndex is a snapshot from run start — the rescan updates the
   * app, not this context.
   */
  onLoreChanged?: () => void;
  /** Same, for story-memory writes (memoryStore refresh). */
  onMemoryChanged?: () => void;
  /**
   * L2 approval channel: propose_edit blocks on this until the user approves
   * (the resolver applies the edit before resolving) or rejects. Absent when
   * the surface can't render an approval card — the tool then errors.
   */
  requestApproval?: (proposal: EditProposal) => Promise<ApprovalDecision>;
  /**
   * Plan-approval channel, same blocking contract, for propose_lore_plan.
   * Absent (or `lorePlan` absent) means the surface can't gate lore changes,
   * and the lore write tools refuse rather than write ungated.
   */
  requestPlanApproval?: (plan: LorePlan) => Promise<PlanDecision>;
  /** This run's approved-plan record — see lib/agent/plan.ts. */
  lorePlan?: PlanGate;
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
  | "read_file"
  | "read_memory"
  | "propose_lore_plan"
  | "create_lore_entity"
  | "update_lore_file"
  | "move_lore_entity"
  | "delete_lore_entity"
  | "update_memory"
  | "propose_edit";

function parseArgs<T>(raw: string): T {
  return JSON.parse(raw || "{}") as T;
}

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

  read_memory: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_memory",
        description:
          "Read the story memory (rolling plot summary) of a writing file: numbered segments, each covering a source character range. Call this before update_memory to learn the segment indices and current summaries.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the writing file, as returned by list_files",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: (call, ctx) => readMemoryTool(call.id, parseArgs(call.arguments), ctx),
  },

  propose_lore_plan: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "propose_lore_plan",
        description:
          "Submit your intended lore changes to the author for approval. REQUIRED before any create/update/move/delete of lore — those tools refuse anything this plan does not cover. Investigate first, then send ONE plan covering every entity you mean to touch; the author approves or rejects the whole card, and the call blocks until they decide. Do not write the plan out as a chat message — it only reaches the author as this tool call. If the plan needs to change later, call this again with the revised steps.",
        parameters: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description: "One line on what this pass is for, shown above the steps",
            },
            steps: {
              type: "array",
              description: "Every change you intend to make, one entry each",
              items: {
                type: "object",
                properties: {
                  action: {
                    type: "string",
                    enum: LORE_PLAN_ACTIONS,
                    description: "Which lore tool this step will use",
                  },
                  entity: {
                    type: "string",
                    description: "Entity name — for 'create', the name you will give the new entry",
                  },
                  file: {
                    type: "string",
                    description:
                      "'update' only: the .md file inside the entity dir. Omit to leave the file open.",
                  },
                  detail: {
                    type: "string",
                    description:
                      "Concretely what changes, in the author's language — this is the text they decide on",
                  },
                },
                required: ["action", "entity", "detail"],
              },
            },
          },
          required: ["steps"],
        },
      },
    },
    execute: (call, ctx) => proposeLorePlanTool(call.id, parseArgs(call.arguments), ctx),
  },

  create_lore_entity: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "create_lore_entity",
        description:
          "Create a new lore entity. Fails if an entity with the same name (or alias) already exists — use update_lore_file for changes. The 'content' is the body markdown only; frontmatter is generated from the other arguments. Applied immediately; the lore index refreshes automatically.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Entity display name" },
            category: {
              type: "string",
              enum: LORE_CATEGORIES.map((c) => c.id),
              description: "Entity category",
            },
            summary: { type: "string", description: "One-line summary shown in listings and used for activation" },
            aliases: {
              type: "array",
              items: { type: "string" },
              description: "Alternative names the text may use for this entity",
            },
            content: {
              type: "string",
              description: "Body markdown for index.md (no frontmatter)",
            },
          },
          required: ["name", "category", "summary", "content"],
        },
      },
    },
    execute: (call, ctx) => createLoreEntityTool(call.id, parseArgs(call.arguments), ctx),
  },

  update_lore_file: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "update_lore_file",
        description:
          "Overwrite one .md file of an existing lore entity with complete new content (send the WHOLE file, not a diff). index.md must include full frontmatter (name/aliases/category/summary) and may not change the category. A facet file must keep its facet frontmatter. images.md cannot be written. Read the current content with read_lore_entity first. The previous version is backed up automatically before writing.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "Filename inside the entity directory (default: index.md). A new filename creates a new facet/attachment file.",
            },
            content: { type: "string", description: "The complete new file content" },
          },
          required: ["entity", "content"],
        },
      },
    },
    execute: (call, ctx) => updateLoreFileTool(call.id, parseArgs(call.arguments), ctx),
  },

  move_lore_entity: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "move_lore_entity",
        description:
          "Rename a lore entity and/or move it to a different category. This is the ONLY way to change an entity's category — update_lore_file refuses category changes because the folder location is what the scanner trusts. On a rename the old name is kept as an alias by default so it still matches in already-written chapters; pass keep_old_name_as_alias=false when the old name was simply wrong. The previous index.md is backed up automatically.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            new_name: { type: "string", description: "New display name (omit to keep the current one)" },
            new_category: {
              type: "string",
              enum: LORE_CATEGORIES.map((c) => c.id),
              description: "Category to move the entity into (omit to keep the current one)",
            },
            keep_old_name_as_alias: {
              type: "boolean",
              description: "Default true — set false to drop the old name instead of aliasing it",
            },
          },
          required: ["entity"],
        },
      },
    },
    execute: (call, ctx) => moveLoreEntityTool(call.id, parseArgs(call.arguments), ctx),
  },

  delete_lore_entity: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "delete_lore_entity",
        description:
          "Remove a lore entity from the project. The entity's whole folder (including its images) is moved into .ai-writer/backups/ rather than erased, so the author can restore it. Use this for duplicates and abandoned entries — when merging, copy anything worth keeping into the surviving entity with update_lore_file FIRST, then delete the loser.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            reason: {
              type: "string",
              description: "One line on why it is being removed, shown to the author in the execution log",
            },
          },
          required: ["entity"],
        },
      },
    },
    execute: (call, ctx) => deleteLoreEntityTool(call.id, parseArgs(call.arguments), ctx),
  },

  update_memory: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "update_memory",
        description:
          "Replace the summary text of one story-memory segment of a writing file. Segment ranges are fixed — only the summary wording changes. Call read_memory first to see segment indices and current text. The previous memory file is backed up automatically.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the writing file, as returned by list_files",
            },
            segment_index: {
              type: "number",
              description: "Zero-based segment index from read_memory",
            },
            summary: { type: "string", description: "The replacement summary text" },
          },
          required: ["path", "segment_index", "summary"],
        },
      },
    },
    execute: (call, ctx) => updateMemoryTool(call.id, parseArgs(call.arguments), ctx),
  },

  propose_edit: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "propose_edit",
        description:
          "Propose a change to a manuscript file under writing/. NOTHING is written until the user approves the proposal on a review card; the call blocks until they decide, and a rejection (with their reason) comes back so you can adjust. 'find' must be the EXACT text currently in the file and must occur exactly once — include enough surrounding text to make it unique. Propose one focused edit per call.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the writing file, as returned by list_files",
            },
            find: {
              type: "string",
              description: "Exact existing text to replace (unique in the file)",
            },
            replace: { type: "string", description: "The replacement text" },
            reason: {
              type: "string",
              description: "One-line justification shown to the user on the review card",
            },
          },
          required: ["path", "find", "replace"],
        },
      },
    },
    execute: (call, ctx) => proposeEditTool(call.id, parseArgs(call.arguments), ctx),
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
