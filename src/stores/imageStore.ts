/**
 * One conversational image session: an initial generation, then edits on top,
 * each producing candidates the author picks between.
 *
 * The chain is a **tree, not a line** — authors routinely go back two rounds
 * and branch off in another direction — so every turn records the turn it came
 * from and the candidate it started from.
 *
 * Provider differences are flattened here rather than in the client: Gemini
 * carries the input image natively, the OpenAI protocol needs a different
 * endpoint, and an endpoint that cannot edit at all is served by regenerating
 * from the accumulated instructions. Which of those happened is recorded on
 * the turn, because an author who asked to change the hair and silently got a
 * brand-new picture deserves to be told why.
 */

import { create } from "zustand";
import { nanoid } from "nanoid";

import { generateImage, isEditUnsupportedError, type ImageResult } from "../lib/ai/image";
import type { Model, Provider } from "../lib/ai/configDb";
import { imageToDataUrl } from "../lib/fs/images";
import { recordImageUsage } from "../lib/image";
import { discardSession, sweepScratch, writeCandidates } from "../lib/image/session";

export interface ImageTurn {
  id: string;
  /** The turn this one edits. Null for the opening generation. */
  parentId: string | null;
  /** Root: the full prompt sent. Child: the author's edit instruction. */
  instruction: string;
  /** Scratch-file paths of this turn's candidates, in the order returned. */
  candidates: string[];
  /** Which candidate the author is looking at, and which an edit builds on. */
  chosen: number;
  /**
   * True when this turn asked for an edit but got a regeneration, because the
   * endpoint has no edit support. The picture will not resemble its parent.
   */
  degraded: boolean;
  /** Model commentary, when the provider returned any. */
  text?: string;
}

/** Everything a run needs that lives outside this store. */
export interface RunContext {
  projectPath: string;
  model: Model;
  provider: Provider;
  apiKey: string;
  size?: string;
  aspect?: string;
  n?: number;
  signal?: AbortSignal;
}

interface ImageSessionState {
  sessionId: string | null;
  turns: ImageTurn[];
  /** The turn on screen; edits branch from it. */
  currentId: string | null;
  running: boolean;
  error: string | null;
  /**
   * Identity of the run that owns the current state.
   *
   * Closing the modal is `abort(); void end(...)` — neither awaited — so a
   * request that resolves in that window used to write its candidates back
   * into the scratch directory `end` had just deleted (recreating it), then
   * `set` a turn belonging to a destroyed session into state. Every write-back
   * below is gated on this still matching.
   */
  runToken: number;

  /** Start a fresh session, discarding whatever the last one left behind. */
  begin: (projectPath: string) => Promise<string>;
  /** The opening generation. Replaces any existing chain. */
  generate: (ctx: RunContext, prompt: string) => Promise<void>;
  /** Edit the current turn's chosen candidate. */
  edit: (ctx: RunContext, instruction: string) => Promise<void>;
  /** Look at another turn — this is what branching off an earlier round is. */
  goTo: (turnId: string) => void;
  /** Pick a different candidate within a turn. */
  choose: (turnId: string, index: number) => void;
  /** Drop the scratch files and clear the chain. */
  end: (projectPath: string) => Promise<void>;

  /** The turn currently on screen, or null. */
  currentTurn: () => ImageTurn | null;
  /** Path of the candidate an edit would start from. */
  currentImagePath: () => string | null;
  /** Root prompt plus every edit instruction down to `turnId`, oldest first. */
  instructionChain: (turnId: string | null) => { prompt: string; edits: string[] };
}

/** Monotonic run identity — see ImageSessionState.runToken. */
let runSeq = 0;

export const useImageStore = create<ImageSessionState>((set, get) => ({
  sessionId: null,
  turns: [],
  currentId: null,
  running: false,
  error: null,
  runToken: 0,

  begin: async (projectPath) => {
    const existing = get().sessionId;
    if (existing && projectPath) await discardSession(projectPath, existing);
    const sessionId = nanoid(8);
    // Bumping the token orphans anything still in flight from the old session:
    // there is no controller to abort here, so this is what stops its result
    // from landing in the new one.
    set({ sessionId, turns: [], currentId: null, error: null, running: false, runToken: ++runSeq });
    // Clear anything a crashed or force-closed run left in the scratch root.
    if (projectPath) void sweepScratch(projectPath, sessionId);
    return sessionId;
  },

  generate: async (ctx, prompt) => {
    const sessionId = get().sessionId ?? (await get().begin(ctx.projectPath));
    const token = ++runSeq;
    set({ runToken: token, running: true, error: null });
    try {
      const result = await callModel(ctx, prompt, []);
      if (get().runToken !== token) return void bill(ctx, "image-gen", result);
      const turn = await materialize(ctx, sessionId, {
        parentId: null,
        instruction: prompt,
        degraded: false,
      }, result);
      if (get().runToken !== token) return;
      set({ turns: [turn], currentId: turn.id });
    } catch (e) {
      if ((e as Error).name !== "AbortError" && get().runToken === token) set({ error: messageOf(e) });
    } finally {
      if (get().runToken === token) set({ running: false });
    }
  },

  edit: async (ctx, instruction) => {
    const { sessionId, currentId } = get();
    const parent = get().currentTurn();
    if (!sessionId || !parent) return;
    const token = ++runSeq;
    set({ runToken: token, running: true, error: null });
    try {
      const sourcePath = get().currentImagePath();
      const source = sourcePath ? (await imageToDataUrl(sourcePath)).dataUrl : null;
      const chain = get().instructionChain(currentId);
      // The prompt a regeneration would need: the original brief with every
      // instruction since folded in, so a fallback still lands near the
      // picture the author has been steering toward.
      const accumulated = [chain.prompt, ...chain.edits, instruction].join("\n");

      let result: ImageResult;
      let degraded = false;
      if (!source || ctx.model.caps?.edit === false) {
        // Declared incapable — don't spend a call proving it.
        result = await callModel(ctx, accumulated, []);
        degraded = true;
      } else {
        try {
          result = await callModel(ctx, instruction, [source]);
        } catch (err) {
          if (!isEditUnsupportedError(err)) throw err;
          result = await callModel(ctx, accumulated, []);
          degraded = true;
        }
      }

      if (get().runToken !== token) return void bill(ctx, "image-edit", result);
      const turn = await materialize(ctx, sessionId, {
        parentId: parent.id,
        instruction,
        degraded,
      }, result);
      if (get().runToken !== token) return;
      set((s) => ({ turns: [...s.turns, turn], currentId: turn.id }));
    } catch (e) {
      if ((e as Error).name !== "AbortError" && get().runToken === token) set({ error: messageOf(e) });
    } finally {
      if (get().runToken === token) set({ running: false });
    }
  },

  goTo: (turnId) => set({ currentId: turnId }),

  choose: (turnId, index) =>
    set((s) => ({
      turns: s.turns.map((t) => (t.id === turnId ? { ...t, chosen: index } : t)),
    })),

  end: async (projectPath) => {
    const { sessionId } = get();
    // Retire the token *first*: `end` is called without being awaited while a
    // request may still be in flight, and the discard below is what that
    // request would otherwise undo by recreating the directory.
    set({ sessionId: null, turns: [], currentId: null, error: null, running: false, runToken: ++runSeq });
    if (sessionId && projectPath) await discardSession(projectPath, sessionId);
  },

  currentTurn: () => {
    const { turns, currentId } = get();
    return turns.find((t) => t.id === currentId) ?? null;
  },

  currentImagePath: () => {
    const turn = get().currentTurn();
    return turn?.candidates[turn.chosen] ?? null;
  },

  instructionChain: (turnId) => {
    const { turns } = get();
    const path: ImageTurn[] = [];
    let cursor = turns.find((t) => t.id === turnId) ?? null;
    while (cursor) {
      path.unshift(cursor);
      cursor = cursor.parentId ? turns.find((t) => t.id === cursor!.parentId) ?? null : null;
    }
    const [root, ...rest] = path;
    return { prompt: root?.instruction ?? "", edits: rest.map((t) => t.instruction) };
  },
}));

// ─── helpers ─────────────────────────────────────────────────────────────────

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function callModel(ctx: RunContext, prompt: string, images: string[]): Promise<ImageResult> {
  return generateImage(
    {
      baseUrl: ctx.provider.baseUrl,
      apiKey: ctx.apiKey,
      standard: ctx.provider.apiStandard,
      authMode: ctx.provider.authMode,
      modelId: ctx.model.modelId,
      safetySettings: ctx.provider.safetySettings,
      route: ctx.model.caps?.route,
    },
    {
      prompt,
      ...(images.length ? { images } : {}),
      n: ctx.n ?? 1,
      size: ctx.size,
      aspect: ctx.aspect,
      signal: ctx.signal,
    },
  );
}

/**
 * Record what a run cost when its result arrives too late to keep.
 *
 * The provider has already charged for it, so dropping the result must not
 * also drop the accounting — the spend report would otherwise understate what
 * the author actually paid.
 */
function bill(ctx: RunContext, task: "image-gen" | "image-edit", result: ImageResult): void {
  void recordImageUsage(ctx.projectPath, ctx.model, task, result.images.length, result.usage);
}

/** Write a result's candidates to scratch and bill the run. */
async function materialize(
  ctx: RunContext,
  sessionId: string,
  turn: Pick<ImageTurn, "parentId" | "instruction" | "degraded">,
  result: ImageResult,
): Promise<ImageTurn> {
  const id = nanoid(6);
  const candidates = await writeCandidates(ctx.projectPath, sessionId, id, result.images);
  await recordImageUsage(
    ctx.projectPath,
    ctx.model,
    turn.parentId ? "image-edit" : "image-gen",
    result.images.length,
    result.usage,
  );
  return { id, ...turn, candidates, chosen: 0, text: result.text };
}
