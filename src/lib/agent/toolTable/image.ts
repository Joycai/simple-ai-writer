/**
 * Image generation and editing through the imagegen subagent.
 *
 * One fragment of the tool table (docs/feature/code-structure-plan.md P6).
 * `registry.ts` spreads the fragments back into `REGISTRY` in a fixed order,
 * which is the tools' declaration order on the wire — see
 * `toolDefinitionsSnapshot.test.ts`.
 */

import { editImageTool, generateImageTool, redrawLoreImageTool } from "../imageTools";

import { parseArgs } from "./shared";
import type { RegisteredTool, ToolId } from "../toolTypes";

export const IMAGE_TOOLS = {
  generate_image: {
    access: "write-approval",
    group: "image",
    definition: {
      type: "function",
      function: {
        name: "generate_image",
        description:
          "Draw a NEW picture and file it. This COSTS MONEY and is only for a picture that does not exist yet — to file one the project already has into an entity's gallery, use add_lore_image instead. Give either `entity` (goes into that lore entity's gallery) or `path` (a document in the project — the image is saved beside it and the markdown to place it comes back in the result, which you then position with propose_edit). The author reviews the prompt and its cost on a card before anything is generated, so write the prompt you actually want. Write prompts in concrete visual nouns — appearance, clothing, pose, setting, lighting, framing — never the subject's name, which the image model does not know. Read the entity or the passage first so the picture matches what is written. To keep a character or style consistent with existing pictures, pass their paths in `references` — the image model then sees them alongside the prompt.",
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
            references: {
              type: "array",
              items: { type: "string" },
              description:
                "Existing images to send as visual references — a project path, or a gallery filename from read_lore_entity. Use for character/style consistency. Only works if the image model accepts input images.",
            },
            desc: {
              type: "string",
              description: "One line saying what the picture shows, in the author's language. Becomes the gallery description (or a document's alt text) — this is all a text-only model will ever see of it, and update_lore_image edits the same field later.",
            },
            slot: {
              type: "string",
              description:
                "With `entity` only: which image slot of its category the picture files into, by id (read_lore_entity lists them). Omit when it fits none — update_lore_image can classify it later.",
            },
            aspect: {
              type: "string",
              enum: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "16:9", "9:16", "21:9"],
              description: "Framing. Portraits lean vertical, scenes and banners horizontal.",
            },
            resolution: {
              type: "string",
              enum: ["1K", "2K", "4K"],
              description: "Resolution tier; default 1K. Higher costs more.",
            },
            quality: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "Quality tier (GPT-Image only; big price difference). Omit for default.",
            },
            negative: {
              type: "string",
              description:
                "What must NOT appear — 'watermark, extra fingers, blurry'. Comma-separated tags, never phrased as an instruction ('avoid X' draws X). Local ComfyUI models only; dropped for every other image model.",
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
    group: "image",
    definition: {
      type: "function",
      function: {
        name: "edit_image",
        description:
          "Redraw an existing image FILE in the project with a change applied — 'silver hair', 'three-quarter view', 'remove the background'. `source` is that file's path, as list_files spells it: a document illustration, reference art the author dropped in, anything on disk. A knowledge-base entry's gallery picture is NOT a file path — it belongs to an entry, so redraw_lore_image handles that one and this tool refuses it. The result is saved as a NEW file beside the source (or beside a document, with `path`) and the original is never overwritten. Blocks on the author's approval and costs money once approved. If the image model cannot edit, the result is regenerated from the instruction instead and the author is told — so prefer generate_image when you want a genuinely new picture rather than a variation of this one.",
        parameters: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description: "Path of the image file to change, exactly as list_files spells it.",
            },
            instruction: {
              type: "string",
              description: "What to change about the picture.",
            },
            path: {
              type: "string",
              description: "File the result beside this .md document instead of beside the source — the markdown to place it comes back in the result, which you then position with propose_edit.",
            },
            references: {
              type: "array",
              items: { type: "string" },
              description:
                "Extra images to send alongside the source — 'put her in this outfit', 'match this style'. A project path, or a gallery filename from read_lore_entity.",
            },
            aspect: {
              type: "string",
              enum: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "16:9", "9:16", "21:9"],
              description: "Recompose to this framing; omit to keep the original's.",
            },
            resolution: {
              type: "string",
              enum: ["1K", "2K", "4K"],
              description: "Resolution tier; omit for default.",
            },
            quality: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "Quality tier (GPT-Image only); omit for default.",
            },
            desc: {
              type: "string",
              description: "One line describing the new picture, used as its alt text when it is placed in a document.",
            },
            reason: {
              type: "string",
              description: "One line for the approval card: why this change.",
            },
            negative: {
              type: "string",
              description:
                "What must NOT appear in the result — 'watermark, extra fingers, blurry'. Comma-separated tags, never phrased as an instruction ('avoid X' draws X). Local ComfyUI models only; dropped for every other image model.",
            },
          },
          required: ["source", "instruction"],
        },
      },
    },
    execute: async (call, ctx) =>
      editImageTool(call.id, parseArgs(call.arguments), ctx),
  },

  // Deliberately NOT in the `lore_write` group, unlike every other tool that
  // writes to an entity: that group is deferred until a lore *plan* is
  // approved, and a plan is the gate on changing what an entry SAYS. What this
  // one spends is the author's money, so its gate is the illustrate card —
  // exactly like generate_image filing a picture into the same gallery. It is
  // deferred all the same, with the other two drawing tools, in the `image`
  // group the model loads through search_tools (./toolSearch).
  redraw_lore_image: {
    access: "write-approval",
    group: "image",
    definition: {
      type: "function",
      function: {
        name: "redraw_lore_image",
        description:
          "Redraw one picture in a knowledge-base entry's gallery with a change applied — 'silver hair', 'three-quarter view'. Call read_lore_entity first for the exact filename; a gallery picture is addressed by its entry plus that filename, never by a path. The result is filed as a NEW gallery picture inheriting the original's image slot, and the original is never overwritten. This is the gallery counterpart of edit_image, which takes a file path and handles every OTHER image in the project. To change only a picture's description or slot use update_lore_image — it draws nothing and costs nothing. Blocks on the author's approval and costs money once approved.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "The entry that owns the picture, exactly as listed by list_lore_entities.",
            },
            file: {
              type: "string",
              description: "Gallery filename, exactly as listed by read_lore_entity. A bare name, never a path.",
            },
            instruction: {
              type: "string",
              description: "What to change about the picture.",
            },
            references: {
              type: "array",
              items: { type: "string" },
              description:
                "Extra images to send alongside the picture being changed — 'put her in this outfit', 'match this style'. A project path, or another gallery filename.",
            },
            aspect: {
              type: "string",
              enum: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "16:9", "9:16", "21:9"],
              description: "Recompose to this framing; omit to keep the original's.",
            },
            resolution: {
              type: "string",
              enum: ["1K", "2K", "4K"],
              description: "Resolution tier; omit for default.",
            },
            quality: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "Quality tier (GPT-Image only); omit for default.",
            },
            desc: {
              type: "string",
              description: "One line describing the new picture, for its gallery description — the same field update_lore_image edits. Defaults to the original's.",
            },
            reason: {
              type: "string",
              description: "One line for the approval card: why this change.",
            },
            negative: {
              type: "string",
              description:
                "What must NOT appear in the result — 'watermark, extra fingers, blurry'. Comma-separated tags, never phrased as an instruction ('avoid X' draws X). Local ComfyUI models only; dropped for every other image model.",
            },
          },
          required: ["entity", "file", "instruction"],
        },
      },
    },
    execute: async (call, ctx) =>
      redrawLoreImageTool(call.id, parseArgs(call.arguments), ctx),
  },
} satisfies Partial<Record<ToolId, RegisteredTool>>;
