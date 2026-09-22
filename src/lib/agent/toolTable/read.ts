/**
 * Read tools: the knowledge base, project files, documents, memory, workflows — plus `ask_author` and `search_tools`, the two that change nothing but the conversation.
 *
 * One fragment of the tool table (docs/feature/code-structure-plan.md P6).
 * `registry.ts` spreads the fragments back into `REGISTRY` in a fixed order,
 * which is the tools' declaration order on the wire — see
 * `toolDefinitionsSnapshot.test.ts`.
 */

import i18n from "../../../i18n";
import { formatLoreIndex, listWritingFiles, readLoreEntity, readLoreImage, readProjectImage, readSlidesFile, readWritingFile, searchWritingFiles } from "../tools";
import { readDocumentFile } from "../documentTools";
import { inspectHtmlTool } from "../htmlTools";
import { readMemoryTool } from "../writeTools";
import { activeWorkflows, findWorkflow, scanWorkflows } from "../../workflow";
import { describeSearchTools, runSearchTools } from "../toolSearch";

import { readCategoryNotes } from "../../lore/categoryNote";

import { parseArgs, cursorArg, CATEGORY_PLACEHOLDER, galleryViewer } from "./shared";
import type { RegisteredTool, ToolId } from "../toolTypes";

export const READ_TOOLS = {
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
      content: formatLoreIndex(
        ctx.loreIndex, ctx.loreScope, ctx.organize?.collections, i18n.language === "zh-CN",
        // Read here, at call time, rather than carried on the run snapshot:
        // a note written mid-run (manage_category 'describe') shows up on the
        // next listing without anyone folding it back in.
        await readCategoryNotes(ctx.projectPath, Object.keys(ctx.loreIndex)),
      ),
    }),
  },

  read_lore_entity: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_lore_entity",
        description:
          "Read a lore entity: its index.md and supplementary .md files, with per-file line numbers. A very large entry comes back as index.md plus a table of its other files — pass 'file' to read one of those (paged; 'start_line' continues). The entity may also have a gallery (avatar + images.md listing additional pictures with descriptions and image slots) — this only returns filenames and text descriptions, never the images themselves. The listing says whether anything on this run can open one, and how. Call list_lore_entities first to get the exact entity names.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "One .md filename inside the entity to read alone — for a facet of a large entry, or to continue past the page limit. Omit for the whole entity.",
            },
            start_line: {
              type: "number",
              description: "1-based line to start at, with 'file' only. Omit to read from the top.",
            },
          },
          required: ["entity"],
        },
      },
    },
    execute: async (call, ctx) => {
      // `name` accepted as a fallback — the parameter's pre-1.28 spelling.
      const args = JSON.parse(call.arguments || "{}") as {
        entity?: string; name?: string; file?: string; start_line?: number;
      };
      const entity = args.entity ?? args.name;
      if (!entity) return { toolCallId: call.id, content: "Error: 'entity' argument is required." };
      return readLoreEntity(
        call.id, entity, ctx.loreIndex, galleryViewer(ctx), args.file, cursorArg(args.start_line),
        ctx.allowedTools?.includes("rewrite_lore_lines") ?? false,
      );
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
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "The image filename exactly as listed in read_lore_entity's gallery block",
            },
          },
          required: ["entity", "file"],
        },
      },
    },
    execute: async (call, ctx) => {
      // `name` accepted as a fallback — the parameter's pre-1.28 spelling.
      const args = JSON.parse(call.arguments || "{}") as { entity?: string; name?: string; file?: string };
      const entity = args.entity ?? args.name;
      if (!entity || !args.file) {
        return { toolCallId: call.id, content: "Error: 'entity' and 'file' arguments are required." };
      }
      return readLoreImage(call.id, entity, args.file, ctx.loreIndex, ctx.multimodal);
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
          "List the project's document tree, recursively — the whole workspace folder, every subfolder included (the app's own .ai-writer data never appears). Output is grouped like `ls -R`: an absolute folder path on its own line, then that folder's filenames indented under it. A file's full path, as read_file wants it, is the folder line + \"/\" + the filename. A folder's own index.md (the author's note on it) is quoted under the folder line; a folder whose note says deprecated is only counted, not expanded. Use this to see what files exist; to find where something is written, use search_text instead.",
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
      return readWritingFile(call.id, args.path, ctx.projectPath, cursorArg(args.start_line), ctx.allowedTools);
    },
  },

  read_slides: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_slides",
        description:
          "Read a presentation in the project **by slide** — either a .pptx or an .html deck. For a .pptx: read_file cannot open one (it is a compressed archive, not text), and slides come back as markdown in running order — one `## Slide N` heading per slide, bullets nested by outline level, tables as markdown tables, pictures named, speaker notes quoted. For an .html deck: each slide comes back as its **verbatim HTML source** under the same `## Slide N` heading, which is what you quote into propose_edit to change one slide — use this instead of paging the whole page with read_file. Around 4000 characters come back per call, cut on a slide boundary; if the deck is longer the result ends with the slide range shown and the start_slide to pass next, so a long deck can be read in order. Legacy .ppt files (PowerPoint 97-2003) cannot be read at all.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path, built from a list_files folder line + \"/\" + filename",
            },
            start_slide: {
              type: "number",
              description:
                "1-based slide to start at — the start_slide the previous call handed back. Omit to read from the first slide.",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: async (call, ctx) => {
      const args = JSON.parse(call.arguments || "{}") as { path?: string; start_slide?: number };
      if (!args.path) return { toolCallId: call.id, content: "Error: 'path' argument is required." };
      return readSlidesFile(call.id, args.path, ctx.projectPath, args.start_slide);
    },
  },

  read_document: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_document",
        description:
          "Read a Word (.docx), Excel (.xlsx) or PDF file in the project as text — read_file cannot open these. It is converted to markdown (headings, tables, one `## sheet` per worksheet, `<!-- page N -->` markers in a PDF) and paged like read_file: about 4000 characters per call, with the start_line to pass next. The conversion is cached outside the workspace; nothing is written to the project and the original is untouched. Pictures inside it are extracted and named in the result, for read_image. For a .pptx use read_slides.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path, built from a list_files folder line + \"/\" + filename",
            },
            start_line: {
              type: "number",
              description: "1-based line to start at — the start_line the previous call handed back. Omit for the top.",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: async (call, ctx) => {
      const args = JSON.parse(call.arguments || "{}") as { path?: string; start_line?: number };
      if (!args.path) return { toolCallId: call.id, content: "Error: 'path' argument is required." };
      return readDocumentFile(call.id, args.path, ctx.projectPath, cursorArg(args.start_line));
    },
  },

  inspect_html: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "inspect_html",
        description:
          "Lay a project .html page out in a real browser and report what it MEASURED — the one way to check a page you cannot see. Writes nothing. Reports how the page divided into slides and on which selector, the slide size, any box that ends up outside its slide (and by how many pixels), slides that render empty, and pictures that failed to load. Call it after writing or revising a deck or a diagram, before export_pptx and before telling the author it is done: a heading that spills off slide 3 is invisible in the source and obvious here. Takes a few seconds — it waits for fonts and images.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Full path of the .html page to measure",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: (call, ctx) => inspectHtmlTool(call.id, parseArgs(call.arguments), ctx),
  },

  search_text: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "search_text",
        description:
          "Full-text search across the project's documents AND its knowledge-base entries. Scans every document file in the workspace (recursively, including subfolders) plus the body of every entry, returning each hit as a line number and the text around it. This is the way to locate a scene, a name, or a piece of foreshadowing — and the way to find which entry mentions something, instead of opening entries one by one with read_lore_entity. Knowledge-base blocks are headed \"entity · file\", the two arguments edit_lore_file takes. Matching is literal and case-insensitive; regular expressions are NOT supported. Search a distinctive name or phrase: a common word returns capped, unhelpful results.",
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
                "Subfolder to limit the search to, relative to the project root (e.g. one volume). Omit to search the whole project — passing it also skips the knowledge base, which has no folders.",
            },
          },
          required: ["query"],
        },
      },
    },
    execute: async (call, ctx) => {
      const args = JSON.parse(call.arguments || "{}") as { query?: string; folder?: string };
      return searchWritingFiles(call.id, ctx.projectPath, args.query ?? "", {
        folder: args.folder,
        loreIndex: ctx.loreIndex,
        loreScope: ctx.loreScope,
        onProgress: ctx.onProgress,
      });
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

  // Never listed in a preset: `partitionByGroup` appends it to the resident half
  // of any toolset that has a searchable group, so its presence follows the
  // groups' and cannot drift from them. The description is rendered per run
  // from those groups (`describe`), the placeholder below is never sent.
  search_tools: {
    access: "read",
    // Free of the folder fence: it reads nothing and writes nothing, it only
    // changes which schemas the next round of this run carries.
    projectFree: true,
    definition: {
      type: "function",
      function: {
        name: "search_tools",
        description: "",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "A group name from the list, or a few words such as 'rename a file' or '画一张头像'",
            },
          },
          required: ["query"],
        },
      },
    },
    describe: ({ searchable }) => describeSearchTools(searchable),
    execute: async (call, ctx) => {
      const args = parseArgs<{ query?: unknown }>(call.arguments);
      return { toolCallId: call.id, content: runSearchTools(String(args.query ?? ""), ctx.toolSearch) };
    },
  },

  read_workflow: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_workflow",
        description:
          "Read the step-by-step procedure of one workflow card from the 可用工作流 list in your instructions. When the author's request matches a card's description, call this FIRST and follow the steps. Cards are house procedure, advisory: the author's explicit instructions in chat always win over a card.",
        parameters: {
          type: "object",
          properties: {
            workflow: {
              type: "string",
              description: "The card's name exactly as it appears in the list",
            },
          },
          required: ["workflow"],
        },
      },
    },
    execute: async (call, ctx) => {
      // `name` accepted as a fallback — the parameter's pre-1.28 spelling.
      const args = parseArgs<{ workflow?: string; name?: string }>(call.arguments);
      const wanted = args.workflow ?? args.name;
      if (!wanted) return { toolCallId: call.id, content: "Error: 'workflow' argument is required." };
      const cards = await scanWorkflows(ctx.projectPath);
      const card = findWorkflow(cards, wanted);
      if (!card) {
        const names = activeWorkflows(cards).map((c) => c.name).join("、");
        return {
          toolCallId: call.id,
          content: `Error: no workflow card named "${wanted}". Available: ${names || "(none)"}. Copy a name from the 可用工作流 list.`,
        };
      }
      return { toolCallId: call.id, content: `# ${card.name}\n\n${card.body}` };
    },
  },

  // Read-tier but BLOCKING: nothing is written, yet the call awaits the author
  // the way an L2 approval does. Access tiers gate writes; blocking is
  // orthogonal (every approval tool blocks too).
  ask_author: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "ask_author",
        description:
          "Ask the author ONE question you are blocked on, with 2-4 short mutually exclusive options; the run pauses until they answer, and the card always offers a free-text field besides your options — whatever comes back is the author's decision, follow it verbatim. Use it only for a decision you cannot settle from the project or the task (a direction to take, a fact only the author knows); anything findable in the project you look up yourself. Never use it to ask permission for a write — the write tools already show an approval card, so asking first makes the author decide twice. Consecutive questions are an interruption: fold related decisions into one.",
        parameters: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The decision you need, as one clear sentence",
            },
            options: {
              type: "array",
              items: { type: "string" },
              description: "2-4 short, mutually exclusive answers the author can pick with one click",
            },
          },
          required: ["question", "options"],
        },
      },
    },
    execute: async (call, ctx) => {
      const args = parseArgs<{ question?: string; options?: unknown }>(call.arguments);
      const question = args.question?.trim();
      const options = Array.isArray(args.options)
        ? args.options
            .filter((o): o is string => typeof o === "string")
            .map((o) => o.trim())
            .filter(Boolean)
        : [];
      if (!question) {
        return { toolCallId: call.id, content: "Error: 'question' is required." };
      }
      if (options.length < 2 || options.length > 4) {
        return {
          toolCallId: call.id,
          content: "Error: 'options' must list 2-4 non-empty strings.",
        };
      }
      // Routing should keep this tool off any surface that cannot render the
      // card; this is the defensive floor, and it tells the model what to do
      // instead of leaving it to retry.
      if (!ctx.askAuthor) {
        return {
          toolCallId: call.id,
          content: "Error: no one is watching this run — decide yourself and proceed.",
        };
      }
      const answer = await ctx.askAuthor({ question, options });
      const content =
        answer.kind === "option"
          ? `作者选择：「${answer.text}」`
          : answer.kind === "other"
            ? `作者的回答：「${answer.text}」`
            : "运行已停止，问题未获回答。";
      return { toolCallId: call.id, content };
    },
  },
} satisfies Partial<Record<ToolId, RegisteredTool>>;
