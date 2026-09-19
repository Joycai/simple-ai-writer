/**
 * Tools that start another run: `delegate`, `run_pack`, `translate`.
 *
 * One fragment of the tool table (docs/feature/code-structure-plan.md P6).
 * `registry.ts` spreads the fragments back into `REGISTRY` in a fixed order,
 * which is the tools' declaration order on the wire — see
 * `toolDefinitionsSnapshot.test.ts`.
 */

import { executeDelegate } from "../subagent";
import { executeRunPack } from "../packs";
import { translateTool } from "../../translate/tool";

import { parseArgs, describeDelegate } from "./shared";
import type { RegisteredTool, ToolId } from "../toolTypes";

export const SUB_RUN_TOOLS = {
  delegate: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "delegate",
        description: describeDelegate(false),
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["search", "vision", "longread", "pdf"],
              description:
                "search — look things up on the web; vision — describe or analyse images; " +
                "longread — read long text documents and presentations (.pptx) and report what matters; " +
                "pdf — read PDF files (refs must be .pdf paths; the only way to read a PDF's contents).",
            },
            task: {
              type: "string",
              description:
                "A complete, self-contained instruction. The subagent cannot see this " +
                "conversation, so state everything it needs to know.",
            },
            references: {
              type: "array",
              items: { type: "string" },
              description:
                "Paths the subagent should work on (documents, images, or PDF files). " +
                "For vision and pdf these are the payload: each image / .pdf path is read here and attached to the subagent's first message, " +
                "so pass the full path from list_files (or the path a document's link resolves to) — a bare filename that matches no file fails the call.",
            },
          },
          required: ["kind", "task"],
        },
      },
    },
    // Whether "read this web page" is on offer depends on the search
    // subagent's bound model, which nothing knows at import — see
    // describeDelegate.
    describe: ({ searchReadsPages }) => describeDelegate(searchReadsPages),
    execute: executeDelegate,
  },

  run_pack: {
    // "read" is honest here even though packs write: the dispatch itself puts
    // nothing on disk. Every write inside the sub-run still lands through its
    // own tool's tier — L2 blocks on the same approval card, L1 lore writes on
    // the same plan gate — because the child receives the parent's channel
    // objects themselves (tool-pack-plan D3). There is no write this tool can
    // reach that its caller's surface couldn't already.
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "run_pack",
        description:
          "Dispatch one self-contained WRITE job to a specialist agent carrying a focused toolset for it. " +
          "Packs: 'file_write' — create, edit or restructure project documents (md/txt/html), or convert an Office/PDF file into one; " +
          "'lore_edit' — create, update or reorganize knowledge-base entries, including their galleries (file an existing picture, retune or remove one); " +
          "'export' — convert documents to pptx/docx/xlsx. " +
          "The specialist cannot see this conversation: state the WHOLE job in 'task' — source paths, " +
          "target file or entry names, and the exact changes wanted — and list material files or note " +
          "paths in 'references'. Its writes go through the author's usual approval cards. " +
          "Reading, research and answering questions are YOUR job, never a pack's.",
        parameters: {
          type: "object",
          properties: {
            pack: {
              type: "string",
              enum: ["file_write", "lore_edit", "export"],
              description:
                "file_write — document work; lore_edit — knowledge-base work; export — file conversion.",
            },
            task: {
              type: "string",
              description:
                "A complete, self-contained brief. The pack agent cannot see this conversation, " +
                "so state everything it needs to do the whole job.",
            },
            references: {
              type: "array",
              items: { type: "string" },
              description: "Paths the pack should read: source documents and/or task note paths.",
            },
          },
          required: ["pack", "task"],
        },
      },
    },
    execute: executeRunPack,
  },

  translate: {
    // The `path` form writes a file, so it blocks on the author's approval like
    // every other L2 tool. The `text` form writes nothing — but a tool's tier is
    // its *ceiling*, and splitting one capability across two tiers to save an
    // approval on half of it is how a write tool ends up reachable without one.
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "translate",
        description:
          "Translate Japanese into Chinese with the author's dedicated translation model. " +
          "Give either `text` (a short passage — the translation comes back to you) or `path` " +
          "(a document in the project — it is translated chunk by chunk and saved as a NEW " +
          "<name>.zh.md beside it, which the author approves on a card; the original is never " +
          "touched). ONLY Japanese to Chinese — it cannot translate in any other direction or " +
          "between any other languages, and given Chinese it hands the text back barely changed " +
          "rather than failing. It reads no instructions: pass the source verbatim and nothing " +
          "else, because any wording you add comes back translated as part of the passage. Line " +
          "structure is preserved. Prefer this over translating Japanese yourself — the model is " +
          "trained on light novels and is markedly better at them.",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "A short Japanese passage, verbatim. No instructions, no preamble, no framing. " +
                "Use `path` instead for anything longer than a page.",
            },
            path: {
              type: "string",
              description:
                "Full path of a Japanese document in the project. The translation is saved " +
                "beside it as <name>.zh.md; the call fails if that file already exists.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown on the approval card (path form only).",
            },
          },
        },
      },
    },
    execute: (call, ctx) => translateTool(call.id, parseArgs(call.arguments), ctx),
  },
} satisfies Partial<Record<ToolId, RegisteredTool>>;
