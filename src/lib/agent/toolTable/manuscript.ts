/**
 * Manuscript proposals (edit / rewrite / insert / append) and file operations on the project tree.
 *
 * One fragment of the tool table (docs/feature/code-structure-plan.md P6).
 * `registry.ts` spreads the fragments back into `REGISTRY` in a fixed order,
 * which is the tools' declaration order on the wire — see
 * `toolDefinitionsSnapshot.test.ts`.
 */

import { copyFileTool, createChapterTool, createDirectoryTool, createFileTool, moveChapterTool, proposeEditTool, appendFileTool, rewriteDocumentTool, rewriteLinesTool, insertLinesTool } from "../writeTools";

import { parseArgs } from "./shared";
import type { RegisteredTool, ToolId } from "../toolTypes";

export const MANUSCRIPT_TOOLS = {
  propose_edit: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "propose_edit",
        description:
          "Propose a change to a document file in the project. NOTHING is written until the author approves the proposal on a review card; the call blocks until they decide, and a rejection (with their reason) comes back so you can adjust. 'find' must be the EXACT text currently in the file. When it occurs more than once you have three ways to say which one you mean: make 'find' unique by including surrounding text, pass 'occurrence' to target the Nth (read_slides numbers an .html deck's slides for exactly this), or pass replace_all=true to change every one — that last is how a document-wide substitution is done WITHOUT rewrite_document. Propose one focused edit per call.",
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
            occurrence: {
              type: "number",
              description:
                "1-based: which occurrence of 'find' to replace, when it appears more than once. Omit when 'find' is unique.",
            },
            replace_all: {
              type: "boolean",
              description: "Replace EVERY occurrence of 'find' in the file. Cannot be combined with 'occurrence'.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
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
          "Replace the ENTIRE contents of a document file in the project. Use this for whole-document work that propose_edit cannot express — reformatting, normalising punctuation or indentation, restructuring headings — i.e. changes that touch text repeated throughout the file, and ONLY when the whole new body comfortably fits in one reply. For a long document use rewrite_lines instead, region by region: this tool carries the entire file as one argument, so on a long one the call is truncated and writes nothing. Also the way to overhaul an .html deliverable (keep it self-contained: inline CSS/JS, inline SVG, no external dependencies). For a single localised change, use propose_edit instead. You MUST read the whole file first (call read_file repeatedly until it stops reporting more lines): 'content' replaces everything, so anything you did not read is deleted. NOTHING is written until the author approves the card; the call blocks until they decide, and the previous version is backed up on approval.",
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
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["path", "content"],
        },
      },
    },
    execute: (call, ctx) => rewriteDocumentTool(call.id, parseArgs(call.arguments), ctx),
  },

  rewrite_lines: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "rewrite_lines",
        description:
          "Replace a RANGE OF LINES of a document with new text, leaving the rest of the file untouched. This is how a long file gets restructured or re-laid-out: read a region with read_file, send back only its replacement, repeat for the next region. Use it instead of rewrite_document whenever the file is long — rewrite_document carries the WHOLE new body in one call, so on a long document it runs past the output cap and a call cut off there writes nothing at all, losing everything you generated. You do NOT quote the old lines: give start_line and end_line (the numbers read_file and search_text report) and the tool reads that range itself. end_line past the last line means 'to the end of the file'; an empty 'content' deletes the range. NOTHING is written until the author approves the card; the call blocks until they decide. After each approved call the line numbers below the region have moved — re-read before naming the next range, or work from the bottom of the file upwards.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the document, as returned by list_files",
            },
            start_line: {
              type: "number",
              description: "1-based first line to replace",
            },
            end_line: {
              type: "number",
              description: "1-based last line to replace (inclusive). Past the end of the file means 'to the end'.",
            },
            content: {
              type: "string",
              description:
                "The replacement text for those lines — only this region, never the whole file. An empty string deletes them.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["path", "start_line", "end_line", "content"],
        },
      },
    },
    execute: (call, ctx) => rewriteLinesTool(call.id, parseArgs(call.arguments), ctx),
  },

  insert_lines: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "insert_lines",
        description:
          "Add lines to a document without re-sending anything already in it: headings over a wall of text, section breaks, blank lines. Send every insertion point in ONE call. They apply bottom-up, so the line numbers you read stay valid across the whole list — never compensate for your own shifts. Use this rather than rewrite_lines whenever nothing existing changes; rewrite_lines makes you re-type every line you keep. append_file adds at the very end. Nothing is written until the author approves the card; the call blocks until they decide.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the document, as returned by list_files",
            },
            insertions: {
              type: "array",
              description: "Every insertion point, any order",
              items: {
                type: "object",
                properties: {
                  line: {
                    type: "number",
                    description: "1-based line to insert BEFORE (read_file's numbers)",
                  },
                  text: {
                    type: "string",
                    description:
                      "Lines to insert. A trailing newline is added; start with one to leave a blank line above.",
                  },
                },
                required: ["line", "text"],
              },
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["path", "insertions"],
        },
      },
    },
    execute: (call, ctx) => insertLinesTool(call.id, parseArgs(call.arguments), ctx),
  },

  append_file: {
    access: "write-approval",
    definition: {
      type: "function",
      function: {
        name: "append_file",
        description:
          "Add text to the END of an existing file, leaving everything already in it untouched. This is how you write a file too large to emit in one reply: create_file the skeleton first, then append_file one section at a time — each call only has to carry its own section, so the file can grow past what a single response could ever hold. Nothing before the appended text is re-sent or re-read, so it cannot be damaged by a partial write. Use propose_edit to change text that is already there, and rewrite_document only when the whole file must be re-laid-out. NOTHING is written until the author approves the card; the call blocks until they decide. The card offers the author a per-file grant, so a long build does not mean a click per section.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path of the existing file, as returned by list_files",
            },
            content: {
              type: "string",
              description:
                "Text to add at the end. Start it with the newline(s) you want between the existing ending and this section — nothing is inserted for you.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["path", "content"],
        },
      },
    },
    execute: (call, ctx) => appendFileTool(call.id, parseArgs(call.arguments), ctx),
  },

  create_chapter: {
    access: "write-approval",
    group: "file_ops",
    definition: {
      type: "function",
      function: {
        name: "create_chapter",
        description:
          "Propose a NEW chapter file anywhere in the project, with its opening text. NOTHING is written until the author approves the card; the call blocks until they decide. Give the full destination path — a subfolder that does not exist yet is created with it, which is how a new volume comes into being. Fails if something is already at that path: use propose_edit to change an existing chapter. A chapter created here lands at the end of its volume's order, which the author can rearrange in the outline view.",
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
              description: "One-line justification shown to the author on the review card",
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
          "Propose a NEW file of any type — notes, data, config (e.g. .json, .csv, .txt), anywhere in the project. NOTHING is written until the author approves the card; the call blocks until they decide. The filename MUST carry an explicit extension: for manuscript text use create_chapter instead, which defaults to .md and enters the outline. Fails if something is already at that path. Parent folders that do not exist yet are created with the file. For a visual deliverable — a diagram, an architecture chart, a promo or landing page — write a SELF-CONTAINED .html file: all CSS and JS inline, graphics drawn as inline SVG, no external CDN or network dependencies. The approval card and the app preview render it live in a sandboxed offline frame, and the author can open it in their system browser. Relative <img> links resolve against the file's own folder.",
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
              description: "One-line justification shown to the author on the review card",
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
    group: "file_ops",
    definition: {
      type: "function",
      function: {
        name: "create_directory",
        description:
          "Propose a NEW empty folder anywhere in the project — a volume, a materials directory, any grouping. NOTHING is created until the author approves the card; the call blocks until they decide. Note that create_chapter/create_file already create missing parent folders on the way to a file — reach for this only when the folder itself is the point (e.g. preparing a structure before filling it).",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Full path of the new folder, e.g. <project folder>/素材/访谈记录",
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
    execute: (call, ctx) => createDirectoryTool(call.id, parseArgs(call.arguments), ctx),
  },

  move_chapter: {
    access: "write-approval",
    group: "file_ops",
    definition: {
      type: "function",
      function: {
        name: "move_chapter",
        description:
          "Propose renaming or moving ANY project file — a chapter, a note, a data file — or a whole folder; both are the same operation, expressed as a new full path. Renaming a folder carries everything inside it, and a document's illustration folder follows automatically. NOTHING is moved until the author approves the card. Fails if the destination already exists, so a move can never overwrite. Only manuscript files (.md/.markdown/.txt) default to .md when the destination has no extension — any other file's destination must spell out its extension. Propose one move per call.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Current full path of the file (or folder) to move",
            },
            new_path: {
              type: "string",
              description:
                "Full destination path, including the filename — not just the target folder",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
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
    group: "file_ops",
    definition: {
      type: "function",
      function: {
        name: "copy_file",
        description:
          "Propose duplicating a file (or a whole folder) into a destination directory — e.g. drafting a variant of a chapter, or snapshotting material before a heavy edit. NOTHING is copied until the author approves the card. The copy keeps the source's name unless new_name renames it in the same step; if the name is taken in the destination, it is auto-numbered (\"稿 (1).md\") and the result reports where the copy actually landed. A copied document's illustration folder is duplicated with it, so the copy's pictures are its own. The destination directory must already exist (create_directory first if not).",
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
            new_name: {
              type: "string",
              description:
                "Name for the copy (no paths). For a file it must carry the full filename including its extension; omit to keep the source's name.",
            },
            reason: {
              type: "string",
              description: "One-line justification shown to the author on the review card",
            },
          },
          required: ["path", "dest_dir"],
        },
      },
    },
    execute: (call, ctx) => copyFileTool(call.id, parseArgs(call.arguments), ctx),
  },
} satisfies Partial<Record<ToolId, RegisteredTool>>;
