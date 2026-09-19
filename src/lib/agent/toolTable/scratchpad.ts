/**
 * The long-task workspace: plan, progress, notes.
 *
 * One fragment of the tool table (docs/feature/code-structure-plan.md P6).
 * `registry.ts` spreads the fragments back into `REGISTRY` in a fixed order,
 * which is the tools' declaration order on the wire — see
 * `toolDefinitionsSnapshot.test.ts`.
 */

import {
  listNotesTool,
  readNoteTool,
  taskPlanTool,
  taskProgressTool,
  writeNoteTool,
} from "../scratchpadTools";

import type { RegisteredTool, ToolId } from "../toolTypes";

export const SCRATCHPAD_TOOLS = {
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
} satisfies Partial<Record<ToolId, RegisteredTool>>;
