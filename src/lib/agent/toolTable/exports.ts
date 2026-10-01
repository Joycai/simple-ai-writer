/**
 * Deliverables and conversions: pptx / docx / xlsx export, document conversion, transcription, shell commands, the docx format reader.
 *
 * One fragment of the tool table (docs/feature/code-structure-plan.md P6).
 * `registry.ts` spreads the fragments back into `REGISTRY` in a fixed order,
 * which is the tools' declaration order on the wire — see
 * `toolDefinitionsSnapshot.test.ts`.
 */

import { exportPptxTool } from "../pptxTools";
import { convertDocumentTool } from "../convertTools";
import { transcribeAudioTool } from "../../asr/tool";
import { describeRunCommand, runCommandTool } from "../cliTools";
import { exportDocxTool, readDocFormatTool } from "../docxTools";
import { exportXlsxTool } from "../xlsxTools";

import { parseArgs } from "./shared";
import type { RegisteredTool, ToolId } from "../toolTypes";

export const EXPORT_TOOLS = {
  export_pptx: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "export_pptx",
        description:
          "Export a project .slides.json deck or legacy .html page to editable PowerPoint, after author approval. Read workflow pptx-native for the six-layout JSON contract and examples; create_file writes the source. Native preflight returns slide ids and field paths: fix errors and retry. Approval binds the prepared output; changed inputs/destination or a lost cache need a new review. For HTML, read pptx-deck and run inspect_html first: SYSTEM fonts, real elements instead of ::before/::after, no entrance opacity 0, words outside SVG. Pass font requirements and export limitations to the author.",
        parameters: {
          type: "object",
          properties: {
            source_path: {
              type: "string",
              description: "Project .slides.json or .html source path",
            },
            html_path: {
              type: "string",
              description: "Legacy alias for source_path; omit when source_path is given",
            },
            out_path: {
              type: "string",
              description:
                "Full path for the .pptx. Omit to write it beside the page under the same name.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: [],
        },
      },
    },
    execute: (call, ctx) => exportPptxTool(call.id, parseArgs(call.arguments), ctx),
  },

  export_docx: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "export_docx",
        description:
          "Turn a project markdown document into a Word file (.docx). NOTHING is written until the author approves the card. Write the document with create_file first, then call this: the conversion runs no model — headings, lists, quotes, tables and pictures are laid out by Word from a named format preset. NEVER put formatting in the markdown (no inline HTML, no '设成三号仿宋' notes, no manual page breaks): structure comes from the markdown, appearance from the preset. Omit `format_id` for the author's default — right unless they named a format. Maths, mermaid, lore citations and .webp/.svg pictures fall back to simpler forms; the result lists what did, so pass it on.",
        parameters: {
          type: "object",
          properties: {
            source_path: {
              type: "string",
              description: "Full path of the .md document to convert",
            },
            out_path: {
              type: "string",
              description:
                "Full path for the .docx. Omit to write it beside the document under the same name.",
            },
            format_id: {
              type: "string",
              description:
                "Id of a format preset. Omit for the author's default, which is almost always right.",
            },
            overrides: {
              type: "object",
              description:
                "ONLY for a change the author named for this one export; anything larger belongs in a preset. bodySize takes 三号 or 16; lineSpacing takes 固定值28磅 / 最小值20磅 / 1.5倍; firstLineChars is CHARACTERS (2 is the Chinese norm); marginsMm is [top, right, bottom, left].",
              properties: {
                bodyFontEastAsia: { type: "string" },
                bodyFontAscii: { type: "string" },
                bodySize: { type: "string" },
                lineSpacing: { type: "string" },
                firstLineChars: { type: "number" },
                marginsMm: { type: "array", items: { type: "number" } },
              },
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["source_path"],
        },
      },
    },
    execute: (call, ctx) => exportDocxTool(call.id, parseArgs(call.arguments), ctx),
  },

  export_xlsx: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "export_xlsx",
        description:
          "Turn a project markdown document's tables into an Excel workbook (.xlsx). NOTHING is written until the author approves the card. Write the tables with create_file first: each table becomes one sheet named by the heading above it. Cells are typed by deterministic rules — a bare number, a percentage, an ISO date and a cell starting with = become a real number, percentage, date and formula; a value carrying a unit ('12000元') or a leading zero stays text. So write bare values, and real =SUM(...) formulas where a total belongs. Text outside tables is left behind; the result lists the sheets and what was skipped.",
        parameters: {
          type: "object",
          properties: {
            source_path: {
              type: "string",
              description: "Full path of the .md document whose tables to convert",
            },
            out_path: {
              type: "string",
              description:
                "Full path for the .xlsx. Omit to write it beside the document under the same name.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["source_path"],
        },
      },
    },
    execute: (call, ctx) => exportXlsxTool(call.id, parseArgs(call.arguments), ctx),
  },

  convert_document: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "convert_document",
        description:
          "Turn a Word (.docx), Excel (.xlsx), PDF or PowerPoint (.pptx) file in the project into a markdown document beside it, as a NEW file. Only for when the author wants an editable copy in the project — to read one, use read_document, which writes nothing. NOTHING is written until the author approves the card. The original is kept untouched, a name collision numbers the new file, and pictures inside it land in assets/ next to the document.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Full path of the file to convert" },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: (call, ctx) => convertDocumentTool(call.id, parseArgs(call.arguments), ctx),
  },

  transcribe_audio: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "transcribe_audio",
        description:
          "Transcribe an audio or video file in the project (mp3, wav, m4a, flac, ogg, mp4, mkv, mov…) into a timestamped markdown transcript written as a NEW .md file beside it. This is the ONLY way to read a recording — read_file cannot open audio. It uploads the file to the transcription service and is billed per second of audio, so the author reviews a card FIRST and nothing runs until they approve; after approval the transcript lands on disk and you read it with read_file. Do not call it for a file that already has a transcript beside it.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Full path of the audio or video file" },
            diarization: {
              type: "boolean",
              description: "Label speakers (说话人 1 / 2 …). Only useful for a conversation; omit to use the author's default",
            },
            speaker_count: { type: "integer", description: "Expected number of speakers (2–100), only with diarization" },
            language_hints: {
              type: "array",
              items: { type: "string" },
              description: "Language codes the audio is in, e.g. [\"zh\"] or [\"zh\", \"en\"]; omit to auto-detect",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: (call, ctx) => transcribeAudioTool(call.id, parseArgs(call.arguments), ctx),
  },

  run_command: {
    // Access metadata is per tool, not per invocation. Keep the strict tier:
    // commandAccess may fast-path a particular line as read-only, while an
    // adjacent call can still be a write and must remain serialized/gated.
    access: "write-approval",
    // The description is `describe` (cliTools.describeRunCommand): it names
    // the shell this computer runs, which decides the syntax the model must
    // write. This literal is the import-time placeholder the ratchet measures.
    describe: describeRunCommand,
    definition: {
      type: "function",
      function: {
        name: "run_command",
        description: "Run ONE shell command on the author's computer. (Replaced at run time by a description naming the machine's shell.)",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command line, exactly as it will be typed into the shell" },
            cwd: { type: "string", description: "Project-relative working directory; omit for the project root" },
            timeout_seconds: { type: "integer", description: "Kill after this many seconds (default 60, max 600)" },
            reason: { type: "string", description: "One line for the approval card: what this is for" },
          },
          required: ["command", "reason"],
        },
      },
    },
    execute: (call, ctx) => runCommandTool(call.id, parseArgs(call.arguments), ctx),
  },

  read_doc_format: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_doc_format",
        description:
          "Look up one layout format in full — margins, per-level headings, document grid — beyond the one-line summary in your briefing. Pass a preset id to inspect it, or the path of a .docx/.dotx the author wants copied: reading a Word file registers its layout as a format id you hand straight to export_docx. Use it when they name a template ('照这份来') or when a requirement the summary omits has to be checked. Only .docx/.dotx — a PDF or screenshot would be a guess.",
        parameters: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "A format preset id, or the full path of a .docx/.dotx in the project",
            },
          },
          required: ["target"],
        },
      },
    },
    execute: (call, ctx) => readDocFormatTool(call.id, parseArgs(call.arguments), ctx),
  },
} satisfies Partial<Record<ToolId, RegisteredTool>>;
