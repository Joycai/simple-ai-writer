/**
 * Roleplay: scenes, the agent's own conversation, its memory.
 *
 * One fragment of the tool table (docs/feature/code-structure-plan.md P6).
 * `registry.ts` spreads the fragments back into `REGISTRY` in a fixed order,
 * which is the tools' declaration order on the wire — see
 * `toolDefinitionsSnapshot.test.ts`.
 */

import { listScenesTool, readSceneMemoryTool, readSceneSummaryTool, readSceneTool, searchScenesTool } from "../../roleplay/sceneTools";
import { recallTool, rememberTool, reviseMemoryTool } from "../../roleplay/memoryTools";
import { readConversationTool, searchConversationTool } from "../../roleplay/conversationTools";

import { parseArgs } from "./shared";
import type { RegisteredTool, ToolId } from "../toolTypes";

export const ROLEPLAY_TOOLS = {
  // ── Roleplay scenes (lib/roleplay/sceneTools) ──
  // Narrator-only, and read-only by construction: they reach transcript.md and
  // summary.md, never another agent's wire history. See the note on
  // ToolContext.scenes.
  list_scenes: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "list_scenes",
        description:
          "List the roleplay scenes in this project. Each character the author plays with has a *history* of scenes, not just a current one: this returns the current scene plus the archived ones, with their titles and dates. Call this first; every other scene tool takes an address from here. Addresses are <id> for the current scene or <id>#<n> for scene n. You are not in this list.",
        parameters: { type: "object", properties: {} },
      },
    },
    execute: (call, ctx) => listScenesTool(call.id, ctx),
  },

  read_scene: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_scene",
        description:
          "Read the verbatim transcript of one roleplay scene by turn range. Pass <id>#<n> to read an archived scene, or a bare <id> for the current one. Omit from/to to get the most recent turns. Prefer read_scene_summary first on a long scene, then read only the range that matters.",
        parameters: {
          type: "object",
          properties: {
            scene: { type: "string", description: "Scene address from list_scenes: <id> (current scene) or <id>#<n> (scene n)" },
            from: { type: "integer", description: "First turn number (1-based, inclusive). Omit for the latest window." },
            to: { type: "integer", description: "Last turn number (inclusive)." },
          },
          required: ["scene"],
        },
      },
    },
    execute: (call, ctx) => readSceneTool(call.id, parseArgs(call.arguments), ctx),
  },

  search_scenes: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "search_scenes",
        description:
          "Search every scene of every character — current and archived — in two layers at once. The verbatim layer searches transcript lines; the index layer searches scene recaps and the characters' memory areas, which is what finds an event the author is paraphrasing in their own words rather than quoting. Matching in both layers is literal and case-insensitive, so pass a distinctive word rather than a sentence. Both layers answer with a scene address you can hand to read_scene. This is how you find something from an earlier scene without reading everything.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Text to look for" },
            scene: { type: "string", description: "Restrict to one character (address from list_scenes; the #n part is ignored here). Omit to search all of them." },
          },
          required: ["query"],
        },
      },
    },
    execute: (call, ctx) => searchScenesTool(call.id, parseArgs(call.arguments), ctx),
  },

  read_scene_summary: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_scene_summary",
        description:
          "Read one scene's summary — the cheap way to catch up before deciding which turns to read verbatim. Works on archived scenes too: pass <id>#<n>. Start here rather than pulling a whole transcript into context.",
        parameters: {
          type: "object",
          properties: { scene: { type: "string", description: "Scene address from list_scenes: <id> or <id>#<n>" } },
          required: ["scene"],
        },
      },
    },
    execute: (call, ctx) => readSceneSummaryTool(call.id, parseArgs(call.arguments), ctx),
  },

  read_scene_memory: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_scene_memory",
        description:
          "Read what a character remembers, in two tiers: what is still binding on them right now (pacts, to-dos, events, bonds), and what has settled into their memory area from earlier scenes. Far cheaper than the transcript. Note that this is what the character *believes* — it can disagree with the manuscript, and it is not a source of fact for anything you write.",
        parameters: {
          type: "object",
          properties: {
            scene: { type: "string", description: "Address from list_scenes; memory belongs to the character, so the #n part is ignored here" },
            include_closed: {
              type: "boolean",
              description: "Include kept (done) and called-off (void) records",
            },
          },
          required: ["scene"],
        },
      },
    },
    execute: (call, ctx) => readSceneMemoryTool(call.id, parseArgs(call.arguments), ctx),
  },

  // ── This agent's own conversation (lib/roleplay/conversationTools) ──
  // Scoped by construction: no agent id to pass, so they reach only the record
  // of the run's own conversation. See the note on ToolContext.conversation.
  search_conversation: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "search_conversation",
        description:
          "Search your own record of every scene you have been through with this person — the one you are in now and the earlier ones — including the parts you no longer remember word for word. Returns matching turn numbers with the matching line; read_conversation then gives you what was actually said around them. This is how you answer \"do you remember what we said back then\" instead of guessing. Matching is literal and case-insensitive: search a distinctive word that was actually spoken.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Text to look for, as it was said" },
            scene: {
              type: "integer",
              description: "Restrict to one of your scenes. Omit to search all of them, which is usually what you want.",
            },
          },
          required: ["query"],
        },
      },
    },
    execute: (call, ctx) => searchConversationTool(call.id, parseArgs(call.arguments), ctx),
  },

  read_conversation: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "read_conversation",
        description:
          "Read your own record back, verbatim, by turn number — use it on the turns search_conversation pointed at. Omit scene to read the one you are in now; pass an earlier scene number to read a scene that has already ended. Omit from/to to re-read the most recent turns. The recent ones are usually still fresh in your mind; what this is for is the stretch that has faded. Turn numbers restart in every scene, so a turn number only means something together with its scene.",
        parameters: {
          type: "object",
          properties: {
            scene: {
              type: "integer",
              description: "Which of your scenes. Omit for the one you are in now.",
            },
            from: { type: "integer", description: "First turn number (1-based, inclusive). Omit for the latest window." },
            to: { type: "integer", description: "Last turn number (inclusive)." },
          },
        },
      },
    },
    execute: (call, ctx) => readConversationTool(call.id, parseArgs(call.arguments), ctx),
  },

  // ── Agent memory (lib/roleplay/memoryTools) ──
  // L1: applied without a card. The safety valve is that nothing can be
  // destroyed — see lib/roleplay/memory's three write rules.
  remember: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "remember",
        description:
          "Record something that will still matter many turns from now: a pact the two of you made, something you mean to do, an event that changed things, or a shift in how you feel about someone. This is your own private long-term memory and it survives context compaction, unlike the conversation itself. Do NOT record ordinary dialogue, atmosphere, or anything the knowledge base already says — a memory full of noise pushes the real commitments out.",
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["pact", "todo", "event", "bond", "note"],
              description: "pact = agreed with someone; todo = you intend to do it; event = it happened and changed things; bond = how you regard someone; note = anything else worth keeping",
            },
            title: { type: "string", description: "One line. This is what you see first when you look back." },
            body: { type: "string", description: "The detail: what exactly was agreed, what changed, why it matters." },
            subject: { type: "string", description: "Who or what this is about, if any." },
            keys: {
              type: "array",
              items: { type: "string" },
              description:
                "2-5 words that should bring this back to mind later: names, places, objects, " +
                "the promise itself. Use the words as they appear in the scene. Once this scene " +
                "ends, these are how you find this memory again.",
            },
          },
          required: ["kind", "title"],
        },
      },
    },
    execute: (call, ctx) => rememberTool(call.id, parseArgs(call.arguments), ctx),
  },

  revise_memory: {
    access: "write-auto",
    definition: {
      type: "function",
      function: {
        name: "revise_memory",
        description:
          "Update one memory record you already made — mark a pact kept (done) or called off (void), or rewrite how you now see someone. Records are never deleted; voiding one keeps its text. Call recall first if you need the ids.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Record id, e.g. m3" },
            body: { type: "string", description: "Replacement detail text" },
            status: { type: "string", enum: ["open", "done", "void"] },
          },
          required: ["id"],
        },
      },
    },
    execute: (call, ctx) => reviseMemoryTool(call.id, parseArgs(call.arguments), ctx),
  },

  recall: {
    access: "read",
    definition: {
      type: "function",
      function: {
        name: "recall",
        description:
          "Read your own memory records. The titles of the active ones are already in your context; the ones marked with an ellipsis have detail you have not been shown. Pass id to expand exactly one of them — that is the common case. Without an id it lists records, which is how you look further back: kept pacts, called-off agreements, or older ones that did not fit.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Expand one record by its id (the (m3) in your memory block). Everything else is ignored when this is given.",
            },
            kind: { type: "string", enum: ["pact", "todo", "event", "bond", "note"] },
            include_closed: { type: "boolean", description: "Include kept (done) and called-off (void) records" },
          },
        },
      },
    },
    execute: (call, ctx) => recallTool(call.id, parseArgs(call.arguments), ctx),
  },
} satisfies Partial<Record<ToolId, RegisteredTool>>;
