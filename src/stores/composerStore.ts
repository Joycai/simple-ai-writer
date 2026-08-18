/**
 * What the author has typed but not yet sent.
 *
 * The AI drawer is an `AnimatePresence` child: closing it unmounts the whole
 * body, so anything the composer kept in `useState` died with it — half a
 * paragraph of instructions gone because the author collapsed the panel to
 * re-read the chapter it was about. Everything here is *unsent input*, which
 * belongs to the author rather than to the surface that happens to be showing
 * it, so it outlives the mount.
 *
 * Per-session, not persisted: a draft is a sentence in progress, not a
 * preference, and `prefs` would be writing to SQLite on every keystroke.
 * Anything that is genuinely per-mount (scroll position, transcript folding)
 * stays in the component.
 */

import { create } from "zustand";
import type { AttachedItem } from "../lib/lore/aiTask";

/** Same shape as a `useState` setter, so call sites read unchanged. */
type Update<T> = T | ((prev: T) => T);

const apply = <T,>(update: Update<T>, prev: T): T =>
  typeof update === "function" ? (update as (p: T) => T)(prev) : update;

interface ComposerState {
  // ── 对话助手 (AgentChat) ──
  chatDraft: string;
  /** `@` attachments picked for the message being written. */
  chatRefs: AttachedItem[];
  setChatDraft: (update: Update<string>) => void;
  setChatRefs: (update: Update<AttachedItem[]>) => void;
  /** Message sent — the composer starts empty again. */
  clearChatComposer: () => void;

  // ── 生成 (AiPanel) ──
  panelOutline: string;
  panelKnowledge: string;
  panelRequirement: string;
  panelInstruction: string;
  setPanelOutline: (update: Update<string>) => void;
  setPanelKnowledge: (update: Update<string>) => void;
  setPanelRequirement: (update: Update<string>) => void;
  setPanelInstruction: (update: Update<string>) => void;

  /** Project switch — an outline written for one book means nothing in the next. */
  resetAll: () => void;
}

export const useComposerStore = create<ComposerState>((set) => ({
  chatDraft: "",
  chatRefs: [],
  setChatDraft: (update) => set((s) => ({ chatDraft: apply(update, s.chatDraft) })),
  setChatRefs: (update) => set((s) => ({ chatRefs: apply(update, s.chatRefs) })),
  clearChatComposer: () => set({ chatDraft: "", chatRefs: [] }),

  panelOutline: "",
  panelKnowledge: "",
  panelRequirement: "",
  panelInstruction: "",
  setPanelOutline: (update) => set((s) => ({ panelOutline: apply(update, s.panelOutline) })),
  setPanelKnowledge: (update) => set((s) => ({ panelKnowledge: apply(update, s.panelKnowledge) })),
  setPanelRequirement: (update) => set((s) => ({ panelRequirement: apply(update, s.panelRequirement) })),
  setPanelInstruction: (update) => set((s) => ({ panelInstruction: apply(update, s.panelInstruction) })),

  resetAll: () => set({
    chatDraft: "", chatRefs: [],
    panelOutline: "", panelKnowledge: "", panelRequirement: "", panelInstruction: "",
  }),
}));
