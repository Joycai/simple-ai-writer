/**
 * The author’s unsent input and persisted Generate settings.
 *
 * The AI drawer is an `AnimatePresence` child: closing it unmounts the whole
 * body, so anything the composer kept in `useState` died with it — half a
 * paragraph of instructions gone because the author collapsed the panel to
 * re-read the chapter it was about. Everything here is *unsent input*, which
 * belongs to the author rather than to the surface that happens to be showing
 * it, so it outlives the mount.
 *
 * Drafts are session-only: a draft is a sentence in progress, not a
 * preference, and `prefs` would be writing to SQLite on every keystroke.
 * Generate task/options are preferences, restored from config.db at startup.
 * Anything that is genuinely per-mount (scroll position, transcript folding)
 * stays in the component.
 */

import { create } from "zustand";
import { readPref, writePref, writePrefMerged } from "../lib/prefs";
import type { AttachedItem } from "../lib/lore/aiTask";
import { clearMentionReadFailures } from "../lib/agent/mentionReads";

/** Same shape as a `useState` setter, so call sites read unchanged. */
type Update<T> = T | ((prev: T) => T);

const apply = <T,>(update: Update<T>, prev: T): T =>
  typeof update === "function" ? (update as (p: T) => T)(prev) : update;

export type ContinueMode = "opening" | "end" | "expand";

interface PanelSettings {
  continueLength: number;
  contextChars: number;
  agentMode: boolean;
}

interface PanelDocumentSettings {
  pickedMode: ContinueMode | null;
  openingMode: "bridge" | "standalone";
  bridgePath: string | null;
}

const DEFAULT_PANEL_SETTINGS: PanelSettings = {
  continueLength: 500, contextChars: 1000, agentMode: false,
};
const DEFAULT_PANEL_DOCUMENT: PanelDocumentSettings = {
  pickedMode: null, openingMode: "bridge", bridgePath: null,
};

function objectFromJson(raw: string | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function storedDocuments(raw: string | null): Record<string, PanelDocumentSettings> {
  return Object.fromEntries(Object.entries(objectFromJson(raw)).flatMap(([path, value]) => {
    if (!path || !value || typeof value !== "object" || Array.isArray(value)) return [];
    const doc = value as Record<string, unknown>;
    return [[path, {
      pickedMode: doc.pickedMode === "opening" || doc.pickedMode === "end" || doc.pickedMode === "expand"
        ? doc.pickedMode : null,
      openingMode: doc.openingMode === "standalone" ? "standalone" : "bridge",
      bridgePath: typeof doc.bridgePath === "string" && doc.bridgePath ? doc.bridgePath : null,
    } as PanelDocumentSettings]];
  }));
}

function prefBackedState() {
  const saved = objectFromJson(readPref("app:generateSettings"));
  return {
    panelTask: typeof saved.task === "string" && saved.task ? saved.task : null,
    panelSettings: {
      continueLength: typeof saved.continueLength === "number" && [200, 500, 1000, 2000].includes(saved.continueLength)
        ? saved.continueLength : DEFAULT_PANEL_SETTINGS.continueLength,
      contextChars: typeof saved.contextChars === "number" && [0, 500, 1000, 2000].includes(saved.contextChars)
        ? saved.contextChars : DEFAULT_PANEL_SETTINGS.contextChars,
      agentMode: saved.agentMode === true,
    },
    panelDocuments: storedDocuments(readPref("app:generateDocuments")),
  };
}

interface ComposerState {
  // ── 对话助手 (AgentChat) ──
  /**
   * Keyed by chat key, exactly like `roleplay` below: with several
   * conversations open (agentStore.chats) the panel remounts its chat per tab,
   * and a half-written question for one conversation must not appear under the
   * next. Absent = nothing typed.
   */
  chat: Record<string, ChatComposer>;
  setChatDraft: (key: string, update: Update<string>) => void;
  setChatRefs: (key: string, update: Update<AttachedItem[]>) => void;
  /** Message sent, or the tab closed — that composer starts empty again. */
  clearChatComposer: (key: string) => void;

  // ── 生成 (AiPanel) ──
  /** Request options survive app restarts through the preferences registry. */
  panelSettings: PanelSettings;
  setPanelSettings: (patch: Partial<PanelSettings>) => void;
  /** Continuation choices belong to a document, never to the panel mount. */
  panelDocuments: Record<string, PanelDocumentSettings>;
  setPanelDocument: (path: string | null, patch: Partial<PanelDocumentSettings>) => void;
  /** Saved task choice; null follows the active pack default. */
  panelTask: string | null;
  reloadFromPrefs: () => void;
  setPanelTask: (task: string) => void;
  panelOutline: string;
  panelKnowledge: string;
  panelRequirement: string;
  panelInstruction: string;
  setPanelOutline: (update: Update<string>) => void;
  setPanelKnowledge: (update: Update<string>) => void;
  setPanelRequirement: (update: Update<string>) => void;
  setPanelInstruction: (update: Update<string>) => void;

  // ── 角色扮演 (RoleplayChat) ──
  /**
   * Keyed by agent id: the roleplay panel remounts its chat per agent (`key`),
   * and a line written to one character must not appear under the next one.
   * Absent = nothing typed, which is what a fresh mount reads as `""` / `[]`.
   */
  roleplay: Record<string, RoleplayComposer>;
  setRoleplayDraft: (agentId: string, update: Update<string>) => void;
  setRoleplayRefs: (agentId: string, update: Update<AttachedItem[]>) => void;
  /** Message sent, or the agent removed — that composer starts empty again. */
  clearRoleplayComposer: (agentId: string) => void;

  /** Project switch — an outline written for one book means nothing in the next. */
  resetAll: () => void;
}

interface RoleplayComposer {
  draft: string;
  refs: AttachedItem[];
}
type ChatComposer = RoleplayComposer;

const EMPTY_ROLEPLAY: RoleplayComposer = { draft: "", refs: [] };

/** Read side for a component: a stable empty value when the conversation has nothing pending. */
export const chatComposerOf = (s: ComposerState, key: string): ChatComposer =>
  s.chat[key] ?? EMPTY_ROLEPLAY;

/** Read side for a component: a stable empty value when the agent has nothing pending. */
export const roleplayComposerOf = (s: ComposerState, agentId: string): RoleplayComposer =>
  s.roleplay[agentId] ?? EMPTY_ROLEPLAY;

/** Stable defaults while no document is focused or this document has no choices yet. */
export const panelDocumentOf = (s: ComposerState, path: string | null): PanelDocumentSettings =>
  (path ? s.panelDocuments[path] : undefined) ?? DEFAULT_PANEL_DOCUMENT;

export const useComposerStore = create<ComposerState>((set) => ({
  chat: {},
  setChatDraft: (key, update) => set((s) => {
    const prev = chatComposerOf(s, key);
    return { chat: { ...s.chat, [key]: { ...prev, draft: apply(update, prev.draft) } } };
  }),
  setChatRefs: (key, update) => set((s) => {
    const prev = chatComposerOf(s, key);
    return { chat: { ...s.chat, [key]: { ...prev, refs: apply(update, prev.refs) } } };
  }),
  clearChatComposer: (key) => set((s) => {
    if (!(key in s.chat)) return {};
    const { [key]: _gone, ...rest } = s.chat;
    return { chat: rest };
  }),

  ...prefBackedState(),
  reloadFromPrefs: () => set(prefBackedState()),
  setPanelSettings: (patch) => set((s) => {
    const panelSettings = { ...s.panelSettings, ...patch };
    writePref("app:generateSettings", JSON.stringify({ ...panelSettings, task: s.panelTask }));
    return { panelSettings };
  }),
  setPanelDocument: (path, patch) => {
    if (!path) return;
    set((s) => {
      const document = { ...panelDocumentOf(s, path), ...patch };
      // Persist only this document's update, merging other windows' documents
      // on the prefs write queue rather than overwriting their startup snapshot.
      writePrefMerged("app:generateDocuments",
        JSON.stringify({ ...storedDocuments(readPref("app:generateDocuments")), [path]: document }),
        (previous) => JSON.stringify({ ...storedDocuments(previous), [path]: document }));
      return { panelDocuments: { ...s.panelDocuments, [path]: document } };
    });
  },
  setPanelTask: (panelTask) => set((s) => {
    writePref("app:generateSettings", JSON.stringify({ ...s.panelSettings, task: panelTask }));
    return { panelTask };
  }),
  panelOutline: "",
  panelKnowledge: "",
  panelRequirement: "",
  panelInstruction: "",
  setPanelOutline: (update) => set((s) => ({ panelOutline: apply(update, s.panelOutline) })),
  setPanelKnowledge: (update) => set((s) => ({ panelKnowledge: apply(update, s.panelKnowledge) })),
  setPanelRequirement: (update) => set((s) => ({ panelRequirement: apply(update, s.panelRequirement) })),
  setPanelInstruction: (update) => set((s) => ({ panelInstruction: apply(update, s.panelInstruction) })),

  roleplay: {},
  setRoleplayDraft: (agentId, update) => set((s) => {
    const prev = roleplayComposerOf(s, agentId);
    return { roleplay: { ...s.roleplay, [agentId]: { ...prev, draft: apply(update, prev.draft) } } };
  }),
  setRoleplayRefs: (agentId, update) => set((s) => {
    const prev = roleplayComposerOf(s, agentId);
    return { roleplay: { ...s.roleplay, [agentId]: { ...prev, refs: apply(update, prev.refs) } } };
  }),
  clearRoleplayComposer: (agentId) => set((s) => {
    if (!(agentId in s.roleplay)) return {};
    const { [agentId]: _gone, ...rest } = s.roleplay;
    return { roleplay: rest };
  }),

  resetAll: () => {
    // A read that failed is kept to explain the `@潮` left in its draft;
    // every draft going, so does that — or a roleplay character (its slot
    // outlives a project reopen) would show it beside an emptied composer.
    clearMentionReadFailures();
    set({
      chat: {},
      panelOutline: "", panelKnowledge: "", panelRequirement: "", panelInstruction: "",
      roleplay: {},
    });
  },
}));
