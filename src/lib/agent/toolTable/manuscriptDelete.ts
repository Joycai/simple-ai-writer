/**
 * Deleting documents and folders — declared after the image tools, which is their place in the wire order.
 *
 * One fragment of the tool table (docs/feature/code-structure-plan.md P6).
 * `registry.ts` spreads the fragments back into `REGISTRY` in a fixed order,
 * which is the tools' declaration order on the wire — see
 * `toolDefinitionsSnapshot.test.ts`.
 */

import { deleteChapterTool, deleteDirectoryTool } from "../writeTools";

import { parseArgs } from "./shared";
import type { RegisteredTool, ToolId } from "../toolTypes";

export const MANUSCRIPT_DELETE_TOOLS = {
  delete_chapter: {
    access: "write-approval",
    group: "file_ops",
    definition: {
      type: "function",
      function: {
        name: "delete_chapter",
        description:
          "Propose deleting ONE file — a chapter or any other project file. NOTHING is removed until the author approves the card, and on approval the file (with a document's illustration folder) is moved into .ai-writer/backups rather than erased, so it stays recoverable. Folders are refused — use delete_directory for those. When merging two chapters, propose_edit the surviving one FIRST, then delete the other.",
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
    group: "file_ops",
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
} satisfies Partial<Record<ToolId, RegisteredTool>>;
