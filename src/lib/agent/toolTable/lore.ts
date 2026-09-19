/**
 * Knowledge-base writes behind the plan gate (`propose_lore_plan`), the organize group, and story memory.
 *
 * One fragment of the tool table (docs/feature/code-structure-plan.md P6).
 * `registry.ts` spreads the fragments back into `REGISTRY` in a fixed order,
 * which is the tools' declaration order on the wire — see
 * `toolDefinitionsSnapshot.test.ts`.
 */

import { LORE_PLAN_ACTIONS, LORE_PLAN_TARGETS } from "../plan";
import {
  manageCategoryTool,
  fileLoreEntriesTool,
  manageCollectionTool,
} from "../organizeTools";
import { addLoreImageTool, copyLoreFileTool, createLoreEntityTool, createLoreFacetTool, appendLoreFileTool, editLoreFileTool, rewriteLoreLinesTool, deleteLoreEntityTool, deleteLoreFileTool, deleteLoreImageTool, moveLoreEntityTool, setLoreAvatarTool, updateFacetMetaTool, updateLoreImageTool, proposeLorePlanTool, updateLoreFileTool, updateLoreMetaTool, updateMemoryTool } from "../writeTools";

import { parseArgs } from "./shared";
import type { RegisteredTool, ToolId } from "../toolTypes";

export const LORE_TOOLS = {
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
                    description:
                      "What this step acts on: an entity name (for 'create', the name you will give it), or — when 'target' says collection/category — that collection's or category's name",
                  },
                  target: {
                    type: "string",
                    enum: LORE_PLAN_TARGETS,
                    description:
                      "What kind of thing this step acts on. Omit for an entity (the usual case). Use 'collection' to create/rename/delete one or move entries in or out, 'category' to create one or move entries into it. A reorganisation belongs in ONE step per collection or category, not one step per entry — the author has to be able to read the card.",
                  },
                  members: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "collection/category steps: the entries this step moves. Naming them here is what authorises moving them — the write refuses any entry the step did not list.",
                  },
                  file: {
                    type: "string",
                    description:
                      "update/delete only: the target inside the entity dir — a .md filename, a gallery image filename, or `avatar`. Omit to leave the file open.",
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
    group: "lore_write",
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
              description:
                "Entity category — must be one that already exists (manage_category, plan-gated, adds one only when none fits).",
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

  create_lore_facet: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "create_lore_facet",
        description:
          "Add a NEW facet to an existing entity — one aspect of it (an outfit, a form, a stretch of backstory, one set of relationships) kept in its own file so it is injected only when the manuscript is actually about that aspect. THE tool for 'split this entry into facets' and for filling an empty facet slot: writing a new .md through update_lore_file instead produces an inert attachment that is never injected, because a facet is its frontmatter and only this tool generates it. 'content' is the body markdown alone (no frontmatter). 'keys' are the trigger words the injector matches against the manuscript — without any, a mode=auto facet never fires. Facets sharing a 'group' compete, so only the highest 'priority' one is injected. read_lore_entity lists the category's facet slots and what already covers them.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            title: {
              type: "string",
              description: "What this facet is, e.g. \"战甲形象\" — heads the author's card and names the file",
            },
            content: {
              type: "string",
              description: "The facet's body markdown, no frontmatter. Omit it only when promoting an attachment (see 'file'), to keep that text verbatim.",
            },
            keys: {
              type: "array",
              items: { type: "string" },
              description: "4-8 trigger words the injector matches against the manuscript — each specific enough that its appearance really means this facet is relevant; no pronouns or common verbs. Without any, a mode=auto facet never fires.",
            },
            slot: {
              type: "string",
              description: "The facet slot this fills, from read_lore_entity's facet-slot list. Omit when it fits none.",
            },
            group: {
              type: "string",
              description: "Mutual-exclusion group: facets that cannot both be true (all outfits, all forms) share one, e.g. \"outfit\" — only the highest 'priority' one is injected.",
            },
            priority: { type: "number", description: "Within a group, higher wins. Default 0." },
            mode: {
              type: "string",
              enum: ["auto", "always", "manual"],
              description: "auto = injected when a key matches (default), always = every time, manual = only when the author pins it",
            },
            file: {
              type: "string",
              description: "Only to promote an EXISTING attachment of this entity into a facet — the .md filename read_lore_entity showed. Omit for a new facet: the filename comes from the title.",
            },
          },
          required: ["entity", "title"],
        },
      },
    },
    execute: (call, ctx) => createLoreFacetTool(call.id, parseArgs(call.arguments), ctx),
  },

  update_lore_file: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "update_lore_file",
        description:
          "Overwrite one .md file of an existing lore entity with complete new content (send the WHOLE file, not a diff). Reach for it only when a whole file must be re-laid-out: to change metadata use update_lore_meta / update_facet_meta, to add a section use append_lore_file, to fix a sentence use edit_lore_file, and to add a facet use create_lore_facet — none of which make you re-emit the rest of the entry. NOT the tool for a new facet: a new filename here becomes an inert ATTACHMENT that is never injected, because a facet is defined by frontmatter this tool does not generate. index.md must include full frontmatter (name/aliases/category/summary) and may not change the name, the category or the dict flag (renames go through move_lore_entity). An existing facet file must keep its facet frontmatter. images.md cannot be written — the gallery has its own tools. Read the current content with read_lore_entity first. The previous version is backed up automatically before writing.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "Filename inside the entity directory (default: index.md). A filename that does not exist yet creates an inert attachment, NOT a facet — use create_lore_facet for that.",
            },
            content: { type: "string", description: "The complete new file content" },
          },
          required: ["entity", "content"],
        },
      },
    },
    execute: (call, ctx) => updateLoreFileTool(call.id, parseArgs(call.arguments), ctx),
  },

  update_lore_meta: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "update_lore_meta",
        description:
          "Change an entity's index.md metadata — summary and/or aliases — WITHOUT resending its body. The entity-level twin of update_facet_meta, and the right tool for 'fix this one-line summary' or 'she is also called X': update_lore_file would make you re-emit the whole entry, paying for the content twice and risking silently reworded prose. Name and category are deliberately NOT here — both relocate the entity's folder, so they go through move_lore_entity. Omitted fields keep their current values; `aliases` replaces the whole list, `add_aliases` appends to it. The previous index.md is backed up automatically.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            summary: {
              type: "string",
              description: "One-line summary shown in listings and used for activation",
            },
            aliases: {
              type: "array",
              items: { type: "string" },
              description:
                "Replaces the current alias list entirely — pass every alias the entity should keep, not just the new one",
            },
            add_aliases: {
              type: "array",
              items: { type: "string" },
              description: "Aliases to add to the current list, leaving the existing ones in place",
            },
          },
          required: ["entity"],
        },
      },
    },
    execute: (call, ctx) => updateLoreMetaTool(call.id, parseArgs(call.arguments), ctx),
  },

  append_lore_file: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "append_lore_file",
        description:
          "Add text to the END of one of an entity's .md files, leaving everything already in it untouched — a new section on an entry, one more event on a timeline, another note under a heading. Nothing before the addition is re-sent, so this write cannot damage it and you do not pay for the existing content twice. Send ONLY the new text: no frontmatter, no repetition of what is already there. One blank line is inserted between the existing ending and your text. Defaults to index.md; a facet's filename appends to that facet. Use edit_lore_file to change text that already exists, and update_lore_file only when the whole file must be re-laid-out. Backed up automatically.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "Filename inside the entity directory (default: index.md). The file must already exist.",
            },
            content: {
              type: "string",
              description: "The new text to add at the end — only the addition itself",
            },
          },
          required: ["entity", "content"],
        },
      },
    },
    execute: (call, ctx) => appendLoreFileTool(call.id, parseArgs(call.arguments), ctx),
  },

  edit_lore_file: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "edit_lore_file",
        description:
          "Replace an exact snippet inside an entity's .md file — correct a sentence, update a number, fix a name in the prose — without resending the rest. What propose_edit is for the manuscript, this is for the knowledge base (applied immediately with a backup, once the approved lore plan covers it). 'find' must be text that currently exists in the file's BODY. When it occurs more than once you have the same three ways to say which one you mean as propose_edit: make 'find' unique by including surrounding text, pass 'occurrence' for the Nth, or pass replace_all=true to change every one — the refusal names the lines they are on. Read the file with read_lore_entity or search_text first and copy the snippet verbatim, whitespace included. Pass an empty 'replace' to delete the found text. Frontmatter is never touched — use update_lore_meta or update_facet_meta for metadata. Defaults to index.md.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "Filename inside the entity directory (default: index.md)",
            },
            find: {
              type: "string",
              description: "Exact existing text to replace, from the file body",
            },
            replace: {
              type: "string",
              description: "The replacement text; an empty string deletes the found text",
            },
            occurrence: {
              type: "number",
              description:
                "1-based: which occurrence of 'find' to replace, when it appears more than once. Omit when 'find' is unique.",
            },
            replace_all: {
              type: "boolean",
              description: "Replace EVERY occurrence of 'find' in the file body. Cannot be combined with 'occurrence'.",
            },
          },
          required: ["entity", "find", "replace"],
        },
      },
    },
    execute: (call, ctx) => editLoreFileTool(call.id, parseArgs(call.arguments), ctx),
  },

  rewrite_lore_lines: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "rewrite_lore_lines",
        description:
          "Replace a REGION of an entity's .md file, named by line numbers, with new text — what rewrite_lines is for the manuscript, this is for the knowledge base (applied immediately with a backup, once the approved lore plan covers it). This is how a LONG facet gets restructured without re-emitting the whole file: only the replacement is sent. Line numbers are the ones read_lore_entity shows — per file, frontmatter counted — but the frontmatter itself is off-limits (use update_lore_meta / update_facet_meta for metadata). Pass an empty 'content' to delete the lines. For one exact snippet use edit_lore_file instead.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "Filename inside the entity directory (default: index.md)",
            },
            start_line: {
              type: "number",
              description: "First line to replace (1-based, as read_lore_entity numbers them)",
            },
            end_line: { type: "number", description: "Last line to replace (inclusive)" },
            content: {
              type: "string",
              description: "The new text for those lines; an empty string deletes them",
            },
          },
          required: ["entity", "start_line", "end_line", "content"],
        },
      },
    },
    execute: (call, ctx) => rewriteLoreLinesTool(call.id, parseArgs(call.arguments), ctx),
  },

  update_facet_meta: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "update_facet_meta",
        description:
          "Retune ONE facet's activation metadata — its title, slot, keys, group, priority or mode — without touching its body text. This is the right tool for 'this facet never fires' or 'these two outfits should exclude each other': update_lore_file would make you resend the whole file, risking silent edits to the prose. The file must ALREADY be a facet — create one with create_lore_facet. `keys` are the trigger words the injector matches against the manuscript; facets sharing a `group` compete so only the highest `priority` one is injected; `mode` auto = key-matched, always = every time, manual = pinned only. Read the file with read_lore_entity first — the fields you omit keep their current values.",
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
            slot: {
              type: "string",
              description:
                "Which slot of the entity's category type schema this facet fills, by id. read_lore_entity lists the category's slots and what already covers each; an id that category doesn't declare is refused. Pass an empty string to leave the facet unclassified.",
            },
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
    group: "lore_write",
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

  add_lore_image: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "add_lore_image",
        description:
          "File a picture that ALREADY EXISTS in the project into a lore entity's gallery — art the author imported, a document illustration, a reference image list_files shows. This is the tool for \"add this picture to that entry\": generate_image DRAWS a new one and costs money, so it is the wrong answer when the picture is already there. The source file is copied, not moved, and stays where it is. To bring a picture over from ANOTHER entity's gallery use copy_lore_file; to make it the entity's portrait use set_lore_avatar.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            path: {
              type: "string",
              description:
                "Full path of the image in the project — a list_files folder line + \"/\" + the filename.",
            },
            desc: {
              type: "string",
              description:
                "One line saying what the picture shows, in the author's language. This is all a text-only model will ever see of it, so write one unless you genuinely cannot tell (read_image will show you).",
            },
            slot: {
              type: "string",
              description:
                "Which image slot of the entity's category this picture fills, by id (read_lore_entity lists them). Omit when it fits none — update_lore_image can classify it later.",
            },
          },
          required: ["entity", "path"],
        },
      },
    },
    execute: (call, ctx) => addLoreImageTool(call.id, parseArgs(call.arguments), ctx),
  },

  update_lore_image: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "update_lore_image",
        description:
          "Retune ONE gallery image's metadata — its description and/or its image slot — without touching the picture itself. The gallery counterpart of update_facet_meta: the description is all a text-only model ever sees of the picture, and the slot is how it fills the category's image checklist. read_lore_entity lists the gallery and the category's image slots. To change the picture use redraw_lore_image; to remove it use delete_lore_image. The fields you omit keep their current values.",
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
            desc: {
              type: "string",
              description: "New description — one line saying what the picture shows, in the author's language",
            },
            slot: {
              type: "string",
              description:
                "Which image slot of the entity's category this picture fills, by id. An id the category doesn't declare is refused; pass an empty string to leave the picture unclassified.",
            },
          },
          required: ["entity", "file"],
        },
      },
    },
    execute: (call, ctx) => updateLoreImageTool(call.id, parseArgs(call.arguments), ctx),
  },

  // ── 重整组织结构（deferred: "lore_organize"，见 ./organizeTools） ──────────
  manage_collection: {
    access: "write-auto",
    group: "lore_organize",
    definition: {
      type: "function",
      function: {
        name: "manage_collection",
        description:
          "Create, rename or delete a knowledge-base COLLECTION — the second axis, which body of work an entry belongs to (a novel, a client's report). Not a category: a category is what an entry IS (character / location), a collection is which project it is FOR, and an entry has exactly one category but any number of collections. Requires an approved plan step with target 'collection'. Deleting never deletes entries — it only removes that membership.",
        parameters: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["create", "rename", "delete"], description: "What to do" },
            collection: { type: "string", description: "The collection to act on — for 'create', the name you are giving it" },
            new_name: { type: "string", description: "rename only: the new name" },
          },
          required: ["op", "collection"],
        },
      },
    },
    execute: (call, ctx) => manageCollectionTool(call.id, parseArgs(call.arguments), ctx),
  },

  file_lore_entries: {
    access: "write-auto",
    group: "lore_organize",
    definition: {
      type: "function",
      function: {
        name: "file_lore_entries",
        description:
          "File entries into and/or out of collections — the bulk move that reorganising a knowledge base is made of. Pass every entry that goes to the same collection in ONE call. Membership is additive: 'add' never removes the collections an entry is already in, so use 'remove' to take it out of one. Requires an approved plan step with target 'collection' whose 'members' name the entries — anything not on that list is refused. The collections in 'add' must already exist (create them with manage_collection first).",
        parameters: {
          type: "object",
          properties: {
            entities: {
              type: "array",
              items: { type: "string" },
              description: "Entity names exactly as returned by list_lore_entities",
            },
            add: { type: "array", items: { type: "string" }, description: "Collections these entries join" },
            remove: { type: "array", items: { type: "string" }, description: "Collections these entries leave" },
          },
          required: ["entities"],
        },
      },
    },
    execute: (call, ctx) => fileLoreEntriesTool(call.id, parseArgs(call.arguments), ctx),
  },

  manage_category: {
    access: "write-auto",
    group: "lore_organize",
    definition: {
      type: "function",
      function: {
        name: "manage_category",
        description:
          "Create, rename or delete a knowledge-base CATEGORY — what an entry IS (人物 / 地点 / 合同). Create one only when no existing category can hold a kind of entry; to group by project use a collection instead. A rename changes only the author-facing LABEL: the folder id never moves, so no entry, citation or pin is disturbed. A delete drops the declaration alone — it removes no folder and no entry, and it refuses a category that still holds entries (move those out with move_lore_entity first, under its own plan step). Rename and delete apply only to categories the AUTHOR created; one a pack declares goes away by turning that pack off. Requires an approved plan step with target 'category'.",
        parameters: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["create", "rename", "delete"], description: "What to do" },
            category: {
              type: "string",
              description:
                "The category to act on — its id or its author-facing label. For 'create', the label you are giving it (the folder id is derived from it).",
            },
            new_label: { type: "string", description: "rename only: the new author-facing label" },
          },
          required: ["op", "category"],
        },
      },
    },
    execute: (call, ctx) => manageCategoryTool(call.id, parseArgs(call.arguments), ctx),
  },

  delete_lore_image: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "delete_lore_image",
        description:
          "Remove ONE picture from an entity's gallery, or its avatar. The file is moved into .ai-writer/backups/ rather than erased — for a gallery picture the images.md entry is dropped too — so the author can restore it. Pass file: \"avatar\" to take the portrait off an entry entirely (its card falls back to the initial, and its gallery is untouched); set_lore_avatar only ever REPLACES one, so this is the only way back to no avatar at all.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description:
                "The image filename exactly as listed in read_lore_entity's gallery block, or the word \"avatar\" to remove the entity's portrait.",
            },
            reason: {
              type: "string",
              description: "One line on why it is being removed, shown to the author in the log",
            },
          },
          required: ["entity", "file"],
        },
      },
    },
    execute: (call, ctx) => deleteLoreImageTool(call.id, parseArgs(call.arguments), ctx),
  },

  set_lore_avatar: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "set_lore_avatar",
        description:
          "Set an entity's avatar (its card portrait) from a picture that already exists — one of its own gallery filenames, or the path of an image in the project. The source is copied, not moved, and the previous avatar goes into .ai-writer/backups/ first. To draw a brand-new portrait, generate_image into the gallery first, then promote it with this. This tool only ever replaces a portrait; taking one off is delete_lore_image(file: \"avatar\").",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description: "Entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description:
                "A gallery filename of this entity (as listed by read_lore_entity), or a project image path. Must be png/jpg/jpeg/webp.",
            },
          },
          required: ["entity", "file"],
        },
      },
    },
    execute: (call, ctx) => setLoreAvatarTool(call.id, parseArgs(call.arguments), ctx),
  },

  copy_lore_file: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "copy_lore_file",
        description:
          "Copy one file from one lore entity to another, byte for byte — a facet/attachment .md (frontmatter and all), or a gallery image (picture plus its description and slot). THE tool for merging entities and for promoting a facet into its own entry, because the content never passes through you: reading a file and re-sending it with update_lore_file risks silently reworded prose, a copy cannot. The source entity is untouched — when the copy was really a move, retire the source file with delete_lore_file / delete_lore_image under its own plan step. index.md and images.md themselves cannot be copied.",
        parameters: {
          type: "object",
          properties: {
            from_entity: {
              type: "string",
              description: "Source entity name exactly as returned by list_lore_entities",
            },
            file: {
              type: "string",
              description: "The filename to copy — a facet .md or a gallery image of the source entity",
            },
            to_entity: {
              type: "string",
              description: "Target entity name exactly as returned by list_lore_entities",
            },
            new_file: {
              type: "string",
              description: "Filename on the target (default: same as the source). Required when the name is already taken there.",
            },
          },
          required: ["from_entity", "file", "to_entity"],
        },
      },
    },
    execute: (call, ctx) => copyLoreFileTool(call.id, parseArgs(call.arguments), ctx),
  },

  move_lore_entity: {
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "move_lore_entity",
        description:
          "Rename a lore entity and/or move it to a different category. This is the ONLY way to change an entity's name or category — update_lore_file refuses both because the folder location is what the scanner trusts. On a rename the old name is kept as an alias by default so it still matches in already-written chapters (pass keep_old_name_as_alias=false when the old name was simply wrong), and the entity's folder is re-slugged to match — the result reports where it now lives. Moving many entries into one category needs only ONE plan step (target 'category', that category as `entity`, the entries in `members`) — call this once per entry against that single step, rather than proposing a step each. The previous index.md is backed up automatically.",
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
              description:
                "Category to move the entity into — must exist (manage_category adds one only when none fits). Omit to keep the current one.",
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
    group: "lore_write",
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "delete_lore_entity",
        description:
          "Remove a lore entity from the project. The entity's whole folder (including its images) is moved into .ai-writer/backups/ rather than erased, so the author can restore it. Use this for duplicates and abandoned entries. When MERGING two entities, the working order is: 1. carry everything worth keeping into the survivor (copy_lore_file for facet files and gallery images, edit/append for index.md content), 2. delete the loser, 3. only THEN add its name and aliases to the survivor with update_lore_meta add_aliases — the alias check refuses names that still resolve to a living entity, so aliases must come after the deletion.",
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
} satisfies Partial<Record<ToolId, RegisteredTool>>;
