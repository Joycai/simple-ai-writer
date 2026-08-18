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
import { type LoreIndex } from "../lore";
import { loreCategoryIds } from "../profile/active";
import {
  formatLoreIndex,
  listWritingFiles,
  readLoreEntity,
  readLoreImage,
  readProjectImage,
  readWritingFile,
  searchWritingFiles,
  type ToolCall,
  type ToolResult,
} from "./tools";
import { LORE_PLAN_ACTIONS, type LorePlan, type PlanDecision, type PlanGate } from "./plan";
import { editImageTool, generateImageTool } from "./imageTools";
import {
  copyFileTool,
  createChapterTool,
  createDirectoryTool,
  createFileTool,
  createLoreEntityTool,
  deleteChapterTool,
  deleteDirectoryTool,
  deleteLoreEntityTool,
  deleteLoreFileTool,
  moveChapterTool,
  moveLoreEntityTool,
  updateFacetMetaTool,
  proposeEditTool,
  rewriteDocumentTool,
  proposeLorePlanTool,
  readMemoryTool,
  updateLoreFileTool,
  updateMemoryTool,
} from "./writeTools";
import type { TaskWorkspaceHandle } from "./taskWorkspace";
import {
  listNotesTool,
  readNoteTool,
  taskPlanTool,
  taskProgressTool,
  writeNoteTool,
} from "./scratchpadTools";
import { executeDelegate, type DelegateKind } from "./subagent";
import type { AgentEvent } from "./events";
import type { AiConn } from "../ai/conn";

export type ToolAccess = "read" | "write-auto" | "write-approval";

/** What every proposal carries, whatever it wants done. */
interface ProposalBase {
  id: string;
  /**
   * Absolute path the proposal acts on — a project file for the manuscript
   * kinds (never inside .ai-writer/), the destination folder or file for an
   * illustration.
   */
  path: string;
  /** Model's one-line justification, shown on the approval card. */
  reason?: string;
}

/** Rewrite a passage in place. */
export interface EditProposal extends ProposalBase {
  kind: "edit";
  /** Exact text to replace — must occur exactly once in the file. */
  find: string;
  replace: string;
}

/**
 * Replace a whole manuscript file's contents.
 *
 * The counterpart to `edit`, and it exists because formatting work is not
 * expressible as find/replace: normalising blank lines, indents or quote marks
 * targets precisely the text that *repeats*, so every such edit bounces off
 * `edit`'s uniqueness rule, and a document-wide pass would be dozens of cards
 * besides. One card for the whole file is the honest unit of review here.
 *
 * `originalChars` rides along so the card can lead with the size delta — the
 * one number that catches the failure mode this kind introduces, a rewrite
 * composed from a partial read that would silently truncate the document.
 */
export interface RewriteProposal extends ProposalBase {
  kind: "rewrite";
  /** Full new file body, replacing everything currently there. */
  content: string;
  /** Length of the file at proposal time. */
  originalChars: number;
}

/** Add a file (or folder) that does not exist yet, with its opening text. */
export interface CreateProposal extends ProposalBase {
  kind: "create";
  /** Body the new file starts with; may be empty. Always empty for a folder. */
  content: string;
  /** True when `path` is a new empty folder rather than a file. */
  isDir?: true;
}

/** Rename a chapter, or move it into another volume. */
export interface MoveProposal extends ProposalBase {
  kind: "move";
  newPath: string;
  /** True when `path` is a volume folder — the move carries every chapter in it. */
  isDir: boolean;
}

/**
 * Remove a chapter file, or (isDir) a whole folder. Sharing the "delete" kind
 * is what keeps the folder variant permanently outside 本次都批准 grants —
 * the exclusion is by kind (see autoApprove), so it cannot be forgotten per
 * tool. On approval the target moves into `.ai-writer/backups`, never unlink.
 */
export interface DeleteProposal extends ProposalBase {
  kind: "delete";
  /** Size at proposal time, so the card can say what is at stake. 0 for a folder. */
  chars: number;
  /** True when `path` is a folder — the deletion takes everything inside. */
  isDir?: true;
  /** Recursive file count, the folder card's headline number. */
  fileCount?: number;
}

/**
 * Duplicate a file (or folder) into a destination directory. The copy keeps
 * the source's name; a collision is auto-numbered ("稿 (1).md") by the apply
 * step, and the actual landing path travels back on the decision so the model
 * can refer to the file it just made.
 */
export interface CopyProposal extends ProposalBase {
  kind: "copy";
  /** Directory the copy lands in. */
  destDir: string;
  /** True when `path` is a folder — the copy carries everything in it. */
  isDir: boolean;
}

/**
 * Draw a picture and file it.
 *
 * The odd one out: approving this **spends money**, where the other kinds only
 * move text around. That is precisely why generation happens on approval
 * rather than before it — the author reviews the prompt and the price, and a
 * rejected proposal costs nothing. Everything the run needs is carried here so
 * the card can show it and `applyProposal` can act on it without re-deriving.
 */
export interface IllustrateProposal extends ProposalBase {
  kind: "illustrate";
  /** The prompt exactly as it will be sent. The thing being approved. */
  prompt: string;
  /** Where the picture lands, in words the author recognises. */
  destination: string;
  dest:
    | { kind: "lore"; entityName: string; entityDir: string }
    | { kind: "document"; docPath: string };
  /** One line describing the picture — alt text / gallery description. */
  note: string;
  /** Config-row id of the image model, resolved at apply time. */
  modelId: string;
  /** Display name, so the card can say what is about to be paid for. */
  modelName: string;
  /** Estimated USD for this run. Zero when the model has no price configured. */
  costUsd: number;
  aspect?: string;
  /**
   * Existing picture this one edits, as an absolute path. Present makes the
   * run an edit; the card shows it, since "change this picture" is only
   * reviewable when you can see the picture.
   */
  sourcePath?: string;
}

/**
 * Something the agent wants done that only the author may authorise. Nothing
 * happens until the card is approved, and the tool call stays blocked until it
 * is decided either way.
 *
 * A discriminated union rather than one wide shape: each kind carries only the
 * fields it needs, so the approval card and the apply step both narrow instead
 * of guessing which optional fields are meaningful.
 */
export type Proposal =
  | EditProposal
  | RewriteProposal
  | CreateProposal
  | MoveProposal
  | DeleteProposal
  | CopyProposal
  | IllustrateProposal;

export type ApprovalDecision =
  | {
      approved: true;
      backupPath?: string | null;
      /**
       * Where the applied change actually landed, when that differs from what
       * was proposed — today only a copy, whose collision auto-numbering picks
       * the final name at apply time. Not `backupPath`: that field's wording
       * is backup-specific in every report that includes it.
       */
      resultPath?: string;
      /**
       * Applied under a standing 本次都批准 grant, so no human read this one.
       * Reported to the model (see writeTools.reportDecision) precisely so it
       * cannot mistake "approved" for "the author checked my work".
       */
      auto?: true;
    }
  | { approved: false; reason?: string };

/** Everything an executor may need about the running project. */
export interface ToolContext {
  projectPath: string;
  loreIndex: LoreIndex;
  /** Whether the active model accepts image inputs (controls lore gallery payloads). */
  multimodal: boolean;
  /**
   * Called after a write-auto tool changed lore on disk: rescan loreStore so
   * the UI reflects the agent's edit immediately, and **return the fresh
   * index** so the run's snapshot can be brought back in line with it (see
   * `writeTools.syncLore`).
   *
   * The return value is the whole point. `ctx.loreIndex` is captured once at
   * run start, so without it a tool that creates an entity leaves every later
   * call in the same run unable to resolve it — while the result text tells
   * the model the index was refreshed, and the model goes and creates it twice.
   *
   * Optional only because the read-only presets legitimately have no lore to
   * write (see `presets.ts`). Any context whose preset carries a lore *write*
   * tool must supply it.
   */
  onLoreChanged?: () => LoreIndex | void | Promise<LoreIndex | void>;
  /** Same, for story-memory writes (memoryStore refresh). */
  onMemoryChanged?: () => void;
  /**
   * L2 approval channel: propose_edit blocks on this until the user approves
   * (the resolver applies the edit before resolving) or rejects. Absent when
   * the surface can't render an approval card — the tool then errors.
   */
  requestApproval?: (proposal: Proposal) => Promise<ApprovalDecision>;
  /**
   * Plan-approval channel, same blocking contract, for propose_lore_plan.
   * Absent (or `lorePlan` absent) means the surface can't gate lore changes,
   * and the lore write tools refuse rather than write ungated.
   */
  requestPlanApproval?: (plan: LorePlan) => Promise<PlanDecision>;
  /** This run's approved-plan record — see lib/agent/plan.ts. */
  lorePlan?: PlanGate;
  /** Active on-disk task workspace (.ai-writer/tasks/<taskId>/). */
  taskWorkspace?: TaskWorkspaceHandle;
  /**
   * Abort signal for this run. Tools that launch nested runs (delegate) must
   * share it so cancelling the parent run cancels all child work.
   */
  signal?: AbortSignal;
  /**
   * Forward events from nested child agents into the parent's execution log.
   */
  onNestedEvent?: (event: AgentEvent) => void;
  /**
   * Resolver for child agent connections. Injected by the caller from aiStore,
   * avoiding reverse dependencies from lib/agent into stores.
   */
  resolveSubAgent?: (kind: DelegateKind) => Promise<AiConn | { error: string }>;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  access: ToolAccess;
  execute: (call: ToolCall, ctx: ToolContext) => Promise<ToolResult>;
  /**
   * Parameter names whose `enum` must be filled in from the *active profile's*
   * lore categories when the definition is handed to the model.
   *
   * The categories are profile-defined (lib/profile), but this registry is a
   * module-level constant evaluated once at import — baking the list in here
   * would freeze it to whichever profile loaded first and then offer a TTRPG
   * author "characters"/"world". `getToolDefinitions` patches it per call
   * instead. See `withProfileCategories`.
   */
  profileCategoryParams?: readonly string[];
}

export type ToolId =
  | "list_lore_entities"
  | "read_lore_entity"
  | "read_lore_image"
  | "read_image"
  | "list_files"
  | "read_file"
  | "search_text"
  | "read_memory"
  | "propose_lore_plan"
  | "create_lore_entity"
  | "update_lore_file"
  | "update_facet_meta"
  | "delete_lore_file"
  | "move_lore_entity"
  | "delete_lore_entity"
  | "update_memory"
  | "propose_edit"
  | "rewrite_document"
  | "create_chapter"
  | "create_file"
  | "create_directory"
  | "move_chapter"
  | "copy_file"
  | "delete_chapter"
  | "delete_directory"
  | "generate_image"
  | "edit_image"
  | "task_plan"
  | "task_progress"
  | "write_note"
  | "read_note"
  | "list_notes"
  | "delegate";

function parseArgs<T>(raw: string): T {
  return JSON.parse(raw || "{}") as T;
}

/**
 * Stands in for the active profile's category ids inside a tool *description*,
 * substituted by `getToolDefinitions`. Same reason the enums are patched there:
 * this registry is a module-level constant, so anything baked in freezes to
 * whichever profile happened to load first.
 */
const CATEGORY_PLACEHOLDER = "{{categories}}";

const REGISTRY: Record<ToolId, RegisteredTool> = {
  list_lore_entities: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "list_lore_entities",
        description:
          `List all lore entities (${CATEGORY_PLACEHOLDER}) in the project. Returns entity names, categories, and one-line summaries. Call this first to discover available lore before reading specific entries.`,
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
          "Read the full detail of a lore entity including its index.md and all supplementary .md files. The entity may also have a gallery (avatar + images.md listing additional pictures with descriptions) — this only returns filenames and text descriptions, never the images themselves. Call read_lore_image afterwards for any specific picture you actually need to see. Call list_lore_entities first to get the exact entity names.",
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

  read_lore_image: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_lore_image",
        description:
          "Fetch ONE specific image from a lore entity's gallery (or its avatar) as visual input. Call read_lore_entity first to see which filenames and descriptions are available, then call this only for the picture(s) actually relevant to the current task — not the whole gallery.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "The image filename exactly as listed in read_lore_entity's gallery block",
            },
          },
          required: ["name", "file"],
        },
      },
    },
    execute: async (call, ctx) => {
      const args = JSON.parse(call.arguments || "{}") as { name?: string; file?: string };
      if (!args.name || !args.file) {
        return { toolCallId: call.id, content: "Error: 'name' and 'file' arguments are required." };
      }
      return readLoreImage(call.id, args.name, args.file, ctx.loreIndex, ctx.multimodal);
    },
  },

  read_image: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_image",
        description:
          "View an image file from the project as visual input: a document's illustrations (they live in an `assets/` folder beside it, which list_files shows), or any reference picture the author keeps in the project. For a lore entity's avatar or gallery picture use read_lore_image instead — it takes the entity and filename read_lore_entity lists. Call this only for a picture the current task actually needs; each one is expensive to send.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Absolute path to the image — a list_files folder line + \"/\" + the filename. A link written inside a document, ![](assets/…/x.png), is relative to that document's own folder: join the document's folder with it.",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: async (call, ctx) => {
      const args = parseArgs<{ path?: string }>(call.arguments);
      if (!args.path) return { toolCallId: call.id, content: "Error: 'path' argument is required." };
      return readProjectImage(call.id, args.path, ctx.projectPath, ctx.multimodal);
    },
  },

  list_files: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "list_files",
        description:
          "List the project's document tree, recursively — the whole workspace folder, every subfolder included (the app's own .ai-writer data never appears). Output is grouped like `ls -R`: an absolute folder path on its own line, then that folder's filenames indented under it. A file's full path, as read_file wants it, is the folder line + \"/\" + the filename. Use this to see what files exist; to find where something is written, use search_text instead.",
        parameters: {
          type: "object",
          properties: {
            folder: {
              type: "string",
              description:
                "Subfolder to list, relative to the project root (e.g. one volume). Omit to list the whole project.",
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
          "Read the text content of a project file (anywhere in the workspace except the app's .ai-writer data). Up to 4000 characters come back per call, cut on a line boundary; if the file is longer the result ends with the line range shown and the start_line to pass next, so a long chapter can be read in order. To jump straight to a passage search_text found, pass its line number as start_line.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path, built from a list_files folder line + \"/\" + filename",
            },
            start_line: {
              type: "number",
              description:
                "1-based line to start reading at — a search_text hit's line number, or the start_line the previous call handed back. Omit to read from the top.",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: async (call, ctx) => {
      const args = JSON.parse(call.arguments || "{}") as { path?: string; start_line?: number };
      if (!args.path) return { toolCallId: call.id, content: "Error: 'path' argument is required." };
      return readWritingFile(call.id, args.path, ctx.projectPath, args.start_line);
    },
  },

  search_text: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "search_text",
        description:
          "Full-text search across the project's documents. Scans every document file in the workspace (recursively, including subfolders) and returns each hit as file path + line number + a snippet of the surrounding line. This is the way to locate a scene, a name, or a piece of foreshadowing — use it instead of reading chapters one by one with read_file, then read_file only the chapter the hits point at. Matching is literal and case-insensitive; regular expressions are NOT supported. Search a distinctive name or phrase: a common word returns capped, unhelpful results.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "The exact text to look for. Distinctive proper nouns or phrases work; common words get truncated away.",
            },
            folder: {
              type: "string",
              description:
                "Subfolder to limit the search to, relative to the project root (e.g. one volume). Omit to search the whole project.",
            },
          },
          required: ["query"],
        },
      },
    },
    execute: async (call, ctx) => {
      const args = JSON.parse(call.arguments || "{}") as { query?: string; folder?: string };
      return searchWritingFiles(call.id, ctx.projectPath, args.query ?? "", args.folder);
    },
  },

  read_memory: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_memory",
        description:
          "Read the story memory (rolling plot summary) of a document: numbered segments, each covering a source character range. Call this before update_memory to learn the segment indices and current summaries.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the document, as returned by list_files",
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
              // Filled from the active profile — see profileCategoryParams below.
              enum: [],
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
    profileCategoryParams: ["category"],
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

  update_facet_meta: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "update_facet_meta",
        description:
          "Retune ONE facet's activation metadata — its title, keys, group, priority or mode — without touching its body text. This is the right tool for 'this facet never fires' or 'these two outfits should exclude each other': update_lore_file would make you resend the whole file, risking silent edits to the prose. `keys` are the trigger words the injector matches against the manuscript; facets sharing a `group` compete so only the highest `priority` one is injected; `mode` auto = key-matched, always = every time, manual = pinned only. Read the file with read_lore_entity first — the fields you omit keep their current values.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "The facet's .md filename inside the entity directory (not index.md)",
            },
            title: { type: "string", description: "Facet display title" },
            keys: {
              type: "array",
              items: { type: "string" },
              description:
                "Trigger words, replacing the current list entirely — distinctive nouns the text would actually use, not generic words",
            },
            group: {
              type: "string",
              description:
                "Mutual-exclusion group (e.g. \"outfit\"); pass an empty string to clear it",
            },
            priority: {
              type: "number",
              description: "Higher wins within a group; default 0",
            },
            mode: {
              type: "string",
              enum: ["auto", "always", "manual"],
              description: "auto = key-matched, always = always injected, manual = pin-only",
            },
          },
          required: ["entity", "file"],
        },
      },
    },
    execute: (call, ctx) => updateFacetMetaTool(call.id, parseArgs(call.arguments), ctx),
  },

  delete_lore_file: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "delete_lore_file",
        description:
          "Delete ONE facet or attachment .md file from an entity, backing it up first. Use this to retire a facet that has been merged elsewhere or is no longer canon — delete_lore_entity would remove the entire character. index.md and images.md cannot be deleted this way.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: { type: "string", description: "The .md filename inside the entity directory" },
            reason: {
              type: "string",
              description: "One line on why it is being removed, shown to the author in the log",
            },
          },
          required: ["entity", "file"],
        },
      },
    },
    execute: (call, ctx) => deleteLoreFileTool(call.id, parseArgs(call.arguments), ctx),
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
              // Filled from the active profile — see profileCategoryParams below.
              enum: [],
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
    profileCategoryParams: ["new_category"],
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
          "Replace the summary text of one story-memory segment of a document. Segment ranges are fixed — only the summary wording changes. Call read_memory first to see segment indices and current text. The previous memory file is backed up automatically.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the document, as returned by list_files",
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
          "Propose a change to a document file in the project. NOTHING is written until the user approves the proposal on a review card; the call blocks until they decide, and a rejection (with their reason) comes back so you can adjust. 'find' must be the EXACT text currently in the file and must occur exactly once — include enough surrounding text to make it unique. Propose one focused edit per call.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the document, as returned by list_files",
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

  rewrite_document: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "rewrite_document",
        description:
          "Replace the ENTIRE contents of a document file in the project. Use this for whole-document work that propose_edit cannot express — reformatting, normalising punctuation or indentation, restructuring headings — i.e. changes that touch text repeated throughout the file. Also the way to overhaul an .html deliverable (keep it self-contained: inline CSS/JS, inline SVG, no external dependencies). For a single localised change, use propose_edit instead. You MUST read the whole file first (call read_file repeatedly until it stops reporting more lines): 'content' replaces everything, so anything you did not read is deleted. NOTHING is written until the user approves the card; the call blocks until they decide, and the previous version is backed up on approval.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the document, as returned by list_files",
            },
            content: {
              type: "string",
              description: "The complete new file body — everything currently in the file is replaced by this",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the user on the review card",
            },
          },
          required: ["path", "content"],
        },
      },
    },
    execute: (call, ctx) => rewriteDocumentTool(call.id, parseArgs(call.arguments), ctx),
  },

  create_chapter: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "create_chapter",
        description:
          "Propose a NEW chapter file anywhere in the project, with its opening text. NOTHING is written until the user approves the card; the call blocks until they decide. Give the full destination path — a subfolder that does not exist yet is created with it, which is how a new volume comes into being. Fails if something is already at that path: use propose_edit to change an existing chapter. A chapter created here lands at the end of its volume's order, which the author can rearrange in the outline view.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Full path of the new file, e.g. <project folder>/卷二/第31章.md. A missing extension becomes .md.",
            },
            content: {
              type: "string",
              description: "The chapter's starting text. Pass an empty string for a blank chapter.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the user on the review card",
            },
          },
          required: ["path", "content"],
        },
      },
    },
    execute: (call, ctx) => createChapterTool(call.id, parseArgs(call.arguments), ctx),
  },

  create_file: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "create_file",
        description:
          "Propose a NEW file of any type — notes, data, config (e.g. .json, .csv, .txt), anywhere in the project. NOTHING is written until the user approves the card; the call blocks until they decide. The filename MUST carry an explicit extension: for manuscript text use create_chapter instead, which defaults to .md and enters the outline. Fails if something is already at that path. Parent folders that do not exist yet are created with the file. For a visual deliverable — a diagram, an architecture chart, a promo or landing page — write a SELF-CONTAINED .html file: all CSS and JS inline, graphics drawn as inline SVG, no external CDN or network dependencies. The approval card and the app preview render it live in a sandboxed offline frame, and the author can open it in their system browser. Relative <img> links resolve against the file's own folder.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Full path of the new file, extension included, e.g. <project folder>/资料/人物表.csv",
            },
            content: {
              type: "string",
              description: "The file's starting content. Pass an empty string for an empty file.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the user on the review card",
            },
          },
          required: ["path", "content"],
        },
      },
    },
    execute: (call, ctx) => createFileTool(call.id, parseArgs(call.arguments), ctx),
  },

  create_directory: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "create_directory",
        description:
          "Propose a NEW empty folder anywhere in the project — a volume, a materials directory, any grouping. NOTHING is created until the user approves the card; the call blocks until they decide. Note that create_chapter/create_file already create missing parent folders on the way to a file — reach for this only when the folder itself is the point (e.g. preparing a structure before filling it).",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Full path of the new folder, e.g. <project folder>/素材/访谈记录",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the user on the review card",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: (call, ctx) => createDirectoryTool(call.id, parseArgs(call.arguments), ctx),
  },

  move_chapter: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "move_chapter",
        description:
          "Propose renaming a chapter, or moving it into a different volume folder — both are the same operation, expressed as a new full path. Works on a volume folder too, which renames the volume and carries its chapters along. NOTHING is moved until the user approves the card. Fails if the destination already exists, so a rename can never overwrite another chapter. Propose one move per call.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Current full path of the chapter (or volume folder) to move",
            },
            new_path: {
              type: "string",
              description:
                "Full destination path, including the filename — not just the target folder",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the user on the review card",
            },
          },
          required: ["path", "new_path"],
        },
      },
    },
    execute: (call, ctx) => moveChapterTool(call.id, parseArgs(call.arguments), ctx),
  },

  copy_file: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "copy_file",
        description:
          "Propose duplicating a file (or a whole folder) into a destination directory — e.g. drafting a variant of a chapter, or snapshotting material before a heavy edit. NOTHING is copied until the user approves the card. The copy keeps the source's name; if that name is taken in the destination, it is auto-numbered (\"稿 (1).md\") and the result reports where the copy actually landed. The destination directory must already exist (create_directory first if not).",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Full path of the file or folder to copy",
            },
            dest_dir: {
              type: "string",
              description: "Full path of the existing destination folder the copy lands in (the project folder itself is allowed)",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the user on the review card",
            },
          },
          required: ["path", "dest_dir"],
        },
      },
    },
    execute: (call, ctx) => copyFileTool(call.id, parseArgs(call.arguments), ctx),
  },

  generate_image: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "generate_image",
        description:
          "Draw a NEW picture and file it. Give either `entity` (goes into that lore entity's gallery) or `path` (a document in the project — the image is saved beside it and the markdown to place it comes back in the result, which you then position with propose_edit). The author reviews the prompt and its cost on a card before anything is generated, so write the prompt you actually want. Write prompts in concrete visual nouns — appearance, clothing, pose, setting, lighting, framing — never the subject's name, which the image model does not know. Read the entity or the passage first so the picture matches what is written.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The image prompt: what is visible. No names, no narrative.",
            },
            entity: {
              type: "string",
              description: "Lore entity whose gallery this belongs in, exactly as listed by list_lore_entities.",
            },
            path: {
              type: "string",
              description: "Full path of a .md document in the project, when the picture illustrates the text rather than an entity.",
            },
            note: {
              type: "string",
              description: "One line saying what the picture shows, in the author's language. Becomes the alt text / gallery description — this is all a text-only model will ever see of it.",
            },
            aspect: {
              type: "string",
              enum: ["1:1", "3:4", "4:3", "16:9", "9:16"],
              description: "Framing. Portraits lean vertical, scenes and banners horizontal.",
            },
            reason: {
              type: "string",
              description: "One line for the approval card: why this picture, now.",
            },
          },
          required: ["prompt"],
        },
      },
    },
    execute: async (call, ctx) =>
      generateImageTool(call.id, parseArgs(call.arguments), ctx),
  },

  edit_image: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "edit_image",
        description:
          "Redraw one of a lore entity's existing gallery pictures with a change applied — 'silver hair', 'three-quarter view'. Call read_lore_entity first for the exact filename. The result is saved as a NEW gallery image; the original is never overwritten. Blocks on the author's approval, and costs money once approved. If the image model cannot edit, the result is regenerated from the instruction instead and the author is told — so prefer generate_image when you want a genuinely new picture rather than a variation.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "The entity that owns the picture, exactly as listed by list_lore_entities.",
            },
            file: {
              type: "string",
              description: "Gallery filename, exactly as listed by read_lore_entity.",
            },
            instruction: {
              type: "string",
              description: "What to change about the picture.",
            },
            note: {
              type: "string",
              description: "One line describing the new picture, for its gallery description.",
            },
            reason: {
              type: "string",
              description: "One line for the approval card: why this change.",
            },
          },
          required: ["entity", "file", "instruction"],
        },
      },
    },
    execute: async (call, ctx) =>
      editImageTool(call.id, parseArgs(call.arguments), ctx),
  },

  delete_chapter: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "delete_chapter",
        description:
          "Propose deleting ONE chapter file. NOTHING is removed until the user approves the card, and on approval the file is moved into .ai-writer/backups rather than erased, so it stays recoverable. Folders are refused — use delete_directory for those. When merging two chapters, propose_edit the surviving one FIRST, then delete the other.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Full path of the chapter file to delete" },
            reason: {
              type: "string",
              description:
                "Why it should go, in the author's language — they decide from this line alone",
            },
          },
          required: ["path", "reason"],
        },
      },
    },
    execute: (call, ctx) => deleteChapterTool(call.id, parseArgs(call.arguments), ctx),
  },

  delete_directory: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "delete_directory",
        description:
          "Propose deleting a whole folder and EVERYTHING inside it. The heavyweight deletion: the card leads with the file count, the author must approve it individually EVERY time (a standing 本次都批准 grant never covers deletions), and on approval the entire folder is moved into .ai-writer/backups in one piece, so it stays recoverable. The project folder itself cannot be deleted. For a single file use delete_chapter.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Full path of the folder to delete" },
            reason: {
              type: "string",
              description:
                "Why the whole folder should go, in the author's language — they decide from this line alone",
            },
          },
          required: ["path", "reason"],
        },
      },
    },
    execute: (call, ctx) => deleteDirectoryTool(call.id, parseArgs(call.arguments), ctx),
  },

  task_plan: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "task_plan",
        description:
          "Initialize or rewrite the task goal and step checklist in the on-disk task workspace (task.md). Use this at the start of a multi-step task to establish a clear roadmap, then keep it updated with task_progress as you execute.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Clear title summarizing the task goal" },
            steps: {
              type: "array",
              items: { type: "string" },
              description: "List of actionable steps to execute",
            },
          },
          required: ["title", "steps"],
        },
      },
    },
    execute: taskPlanTool,
  },

  task_progress: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "task_progress",
        description:
          "Update the task checklist in task.md. Use 'check' to mark a step done, 'start' to mark in-progress, 'skip' to skip, 'add_step' to append a new step, or 'log' to record a progress note. Call it the moment a step's state changes: 'start' right before you begin a step, 'check' as soon as it is finished. Never batch all the updates at the end of the task.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["check", "start", "skip", "add_step", "log"],
              description: "The progress action to perform",
            },
            step: {
              type: "integer",
              description: "1-indexed step number (required for check, start, skip)",
            },
            text: {
              type: "string",
              description: "Text content for add_step or log",
            },
          },
          required: ["action"],
        },
      },
    },
    execute: taskProgressTool,
  },

  write_note: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "write_note",
        description:
          "Save an intermediate finding, research note, or analysis to notes/<slug>.md in the task workspace. Returns the relative path. Use this before context is trimmed to keep crucial conclusions on disk.",
        parameters: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              description: "Short alphanumeric identifier for the note filename, e.g. search-nobles",
            },
            title: {
              type: "string",
              description: "Human-readable title for the note",
            },
            content: {
              type: "string",
              description: "Markdown content to save in the note",
            },
            sources: {
              type: "array",
              items: { type: "string" },
              description: "Optional list of source URLs or file paths referenced",
            },
          },
          required: ["slug", "title", "content"],
        },
      },
    },
    execute: writeNoteTool,
  },

  read_note: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_note",
        description:
          "Read a saved note from the task workspace. Supports line-based pagination (up to 4000 chars per call).",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative note path (e.g. .ai-writer/tasks/<taskId>/notes/foo.md) or slug",
            },
            start_line: {
              type: "integer",
              description: "1-indexed line to start reading from (defaults to 1)",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: readNoteTool,
  },

  list_notes: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "list_notes",
        description:
          "List all saved notes in the active task workspace, including their slug, title, path, and size.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    execute: listNotesTool,
  },

  delegate: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "delegate",
        description:
          "Hand a context-heavy or capability-specific job to a specialist subagent " +
          "running on its own model. The subagent works in a separate context, writes " +
          "its full findings to a note file, and returns only a short summary plus the " +
          "note path — so its raw material never enters this conversation. Use it for " +
          "web research, reading images, reading PDF files, and digesting long documents.",
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["search", "vision", "longread", "pdf"],
              description:
                "search — look things up on the web; vision — describe or analyse images; " +
                "longread — read long text documents and report what matters; " +
                "pdf — read PDF files (refs must be .pdf paths; the only way to read a PDF's contents).",
            },
            task: {
              type: "string",
              description:
                "A complete, self-contained instruction. The subagent cannot see this " +
                "conversation, so state everything it needs to know.",
            },
            refs: {
              type: "array",
              items: { type: "string" },
              description: "Paths the subagent should work on (documents, images, or PDF files).",
            },
          },
          required: ["kind", "task"],
        },
      },
    },
    execute: executeDelegate,
  },
};

/**
 * Copy a tool definition with everything category-dependent resolved from the
 * active profile: the `enum` of each parameter named in `profileCategoryParams`,
 * and any `{{categories}}` placeholder in the description.
 *
 * Copies rather than mutates: REGISTRY is shared across every run, and writing
 * into it would leave one project's categories in place after the author
 * switched profiles. Only the objects on the path being changed are cloned —
 * the untouched parameter schemas are shared, which is safe because nothing
 * else writes to them.
 */
function withProfileCategories(
  definition: ToolDefinition,
  params: readonly string[] | undefined,
): ToolDefinition {
  const describesCategories = definition.function.description.includes(CATEGORY_PLACEHOLDER);
  if (!describesCategories && !params?.length) return definition;

  const ids = loreCategoryIds();
  const fn = { ...definition.function };

  // A tool that names the categories in prose is as misleading as a wrong enum:
  // told "characters, world, …", a model asks for lore that doesn't exist here.
  if (describesCategories) {
    // split/join rather than replaceAll — the project's TS target predates it.
    fn.description = fn.description.split(CATEGORY_PLACEHOLDER).join(ids.join(", "));
  }

  const properties = definition.function.parameters.properties;
  if (params?.length && properties && typeof properties === "object") {
    const nextProperties: Record<string, unknown> = { ...(properties as Record<string, unknown>) };
    for (const name of params) {
      const schema = nextProperties[name];
      if (!schema || typeof schema !== "object") continue;
      nextProperties[name] = { ...(schema as Record<string, unknown>), enum: ids };
    }
    fn.parameters = { ...definition.function.parameters, properties: nextProperties };
  }

  return { ...definition, function: fn };
}

/** Resolve wire definitions for a preset's toolset, preserving order. */
export function getToolDefinitions(ids: readonly ToolId[]): ToolDefinition[] {
  return ids.map((id) => {
    const tool = REGISTRY[id];
    return withProfileCategories(tool.definition, tool.profileCategoryParams);
  });
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
  // Narrowed rather than asserted: `call.name` is whatever the model emitted,
  // so a double cast here would hand a `RegisteredTool` shape to something
  // that may be undefined.
  const isAllowed = (name: string): name is ToolId =>
    (allowed as readonly string[]).includes(name);
  const tool = isAllowed(call.name) ? REGISTRY[call.name] : undefined;
  if (!tool) return { toolCallId: call.id, content: `Unknown tool: ${call.name}` };
  try {
    return await tool.execute(call, ctx);
  } catch (e) {
    return { toolCallId: call.id, content: `Error: ${String(e)}` };
  }
}
