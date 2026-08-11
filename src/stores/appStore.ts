import { create } from "zustand";
import i18n from "../i18n";
import { deletePref, PINNED_LORE_PREFIX, prunePrefsWithPrefix, readPref, writePref } from "../lib/prefs";
import { MAX_DRAFTS } from "../lib/ai/drafts";
import {
  CONTEXT_UTILIZATION_DEFAULT,
  CONTEXT_UTILIZATION_MAX,
  CONTEXT_UTILIZATION_MIN,
} from "../lib/context/budget";
import {
  DEFAULT_MARKDOWN_THEME,
  MARKDOWN_THEME_IDS,
  MD_THEME_ATTR,
  type MarkdownThemeId,
} from "../lib/theme/markdownThemes";

export type ThemeMode = "dark" | "light" | "system";
export type Language = "zh-CN" | "en";
export type FontScheme = "manuscript" | "song" | "hei" | "kai";

const FONT_SCHEMES: FontScheme[] = ["manuscript", "song", "hei", "kai"];

const THEME_KEY = "app:theme";
const LANG_KEY = "app:language";
const FONT_KEY = "app:fontScheme";
const MD_THEME_KEY = "app:markdownTheme";
const SIDEBAR_WIDTH_KEY = "app:sidebarWidth";
const RIGHT_PANEL_WIDTH_KEY = "app:rightPanelWidth";
const RECENT_PROJECTS_KEY = "app:recentProjects";
const LORE_BUDGET_KEY = "app:loreBudgetTokens";
const CONTEXT_UTILIZATION_KEY = "app:contextUtilization";
const AI_DRAWER_MODE_KEY = "app:aiDrawerMode";
const DRAFT_COUNT_KEY = "app:draftCount";

const RECENT_PROJECTS_MAX = 10;

/**
 * Token budget bounds for the 【设定资料】 block (see lib/context/loreSelect).
 * The ceiling is sized for large-context models (128k-class) — the block still
 * has to share the window with the document, memory and the model's reply, so
 * spending the whole budget on lore is the author's call, not the default.
 */
export const LORE_BUDGET_MIN = 200;
export const LORE_BUDGET_MAX = 128_000;
export const LORE_BUDGET_DEFAULT = 600;


/**
 * Read as functions rather than computed once into consts: the same values
 * have to be re-derived when a config backup replaces the stored preferences
 * (see `reloadFromPrefs`), and a second copy of "how a font scheme is
 * validated" is how the two ends drift apart.
 */
function storedTheme(): ThemeMode {
  return (readPref(THEME_KEY) as ThemeMode | null) ?? "dark";
}
function storedLang(): Language {
  return (readPref(LANG_KEY) as Language | null) ?? "zh-CN";
}
function storedFontScheme(): FontScheme {
  const raw = readPref(FONT_KEY) as FontScheme | null;
  return raw && FONT_SCHEMES.includes(raw) ? raw : "manuscript";
}
function storedMarkdownTheme(): MarkdownThemeId {
  const raw = readPref(MD_THEME_KEY) as MarkdownThemeId | null;
  return raw && MARKDOWN_THEME_IDS.includes(raw) ? raw : DEFAULT_MARKDOWN_THEME;
}

function loadRecentProjects(): string[] {
  try {
    const raw = readPref(RECENT_PROJECTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string").slice(0, RECENT_PROJECTS_MAX);
  } catch {
    return [];
  }
}

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 500;
const RIGHT_PANEL_MIN = 160;
const RIGHT_PANEL_MAX = 500;

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

const storedSidebarWidth = () =>
  clamp(parseInt(readPref(SIDEBAR_WIDTH_KEY) ?? "240", 10), SIDEBAR_MIN, SIDEBAR_MAX);
const storedRightPanelWidth = () =>
  clamp(parseInt(readPref(RIGHT_PANEL_WIDTH_KEY) ?? "280", 10), RIGHT_PANEL_MIN, RIGHT_PANEL_MAX);
const storedLoreBudget = () =>
  clamp(
    parseInt(readPref(LORE_BUDGET_KEY) ?? String(LORE_BUDGET_DEFAULT), 10) || LORE_BUDGET_DEFAULT,
    LORE_BUDGET_MIN, LORE_BUDGET_MAX,
  );
const storedContextUtilization = () =>
  clamp(
    parseFloat(readPref(CONTEXT_UTILIZATION_KEY) ?? "") || CONTEXT_UTILIZATION_DEFAULT,
    CONTEXT_UTILIZATION_MIN, CONTEXT_UTILIZATION_MAX,
  );
const storedDraftCount = () => clamp(parseInt(readPref(DRAFT_COUNT_KEY) ?? "1", 10) || 1, 1, MAX_DRAFTS);

/** Which assistant tab the drawer reopens on — persisted like the panel widths. */
const storedAiDrawerMode = (): AiDrawerMode => {
  const raw = readPref(AI_DRAWER_MODE_KEY);
  return raw === "chat" || raw === "consistency" || raw === "generate" ? raw : "generate";
};

/** The pref-backed slice, re-derivable in one call. */
function prefBackedState() {
  return {
    theme: storedTheme(),
    language: storedLang(),
    fontScheme: storedFontScheme(),
    markdownTheme: storedMarkdownTheme(),
    sidebarWidth: storedSidebarWidth(),
    rightPanelWidth: storedRightPanelWidth(),
    recentProjects: loadRecentProjects(),
    loreBudgetTokens: storedLoreBudget(),
    contextUtilization: storedContextUtilization(),
    draftCount: storedDraftCount(),
    aiDrawerMode: storedAiDrawerMode(),
  };
}

export type MainView = "editor" | "lore-wall" | "outline-full";
export type AiDrawerMode = "generate" | "chat" | "consistency";
/** Every pane the settings page renders — `openSettings(tab)` can reach all of
 *  them, so this union and SettingsPage's nav must stay in step. */
export type SettingsTab =
  | "general"
  | "workspace"
  | "providers-models"
  | "prompts"
  | "usage"
  | "shortcuts"
  | "about";
export type SideTab = "files" | "outline" | "search";

interface AppState {
  theme: ThemeMode;
  language: Language;
  fontScheme: FontScheme;
  markdownTheme: MarkdownThemeId;
  sidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  sidebarWidth: number;
  rightPanelWidth: number;
  recentProjects: string[];
  /** Token budget for lore injection (【设定资料】 block). */
  loreBudgetTokens: number;
  /** Share of the model's context window one request may occupy (0–1). */
  contextUtilization: number;
  /**
   * How many drafts a generative task should produce (1–`MAX_DRAFTS`).
   *
   * A user preference rather than per-run state, so "always give me three
   * options" survives restarts. Tasks that can't fan out clamp it themselves —
   * see `draftCountFor` in aiTaskStore, which owns that rule.
   */
  draftCount: number;
  activeSideTab: SideTab;
  activeRightTab: "outline" | "ai";

  // Manuscript additions
  mainView: MainView;
  showCommandPalette: boolean;
  showAiDrawer: boolean;
  aiDrawerMode: AiDrawerMode;
  /**
   * Bumped to ask the assistant header's model picker to open itself.
   *
   * A nonce rather than a boolean: the picker owns its own open/closed state
   * (it also answers ⌘M and outside clicks), and this only has to carry
   * "someone asked, again" — a boolean would need a reset handshake and would
   * silently no-op on a second request.
   */
  modelPickerNonce: number;
  showOnboarding: boolean;
  /** Settings page visibility + which pane it opens on. Lives here rather than
   *  in App so any surface (e.g. the model picker's 管理供应商) can reach it.
   *  Deliberately not a `MainView`: `navStore.navigationBlocked()` reads this
   *  flag to keep settings out of the back/forward history. */
  showSettings: boolean;
  settingsTab: SettingsTab;

  setTheme: (theme: ThemeMode) => void;
  setLanguage: (lang: Language) => void;
  setFontScheme: (scheme: FontScheme) => void;
  setMarkdownTheme: (id: MarkdownThemeId) => void;
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  setRightPanelCollapsed: (v: boolean) => void;
  setSidebarWidth: (w: number | ((prev: number) => number)) => void;
  setRightPanelWidth: (w: number | ((prev: number) => number)) => void;
  setLoreBudgetTokens: (tokens: number) => void;
  setContextUtilization: (ratio: number) => void;
  setDraftCount: (n: number) => void;
  addRecentProject: (path: string) => void;
  removeRecentProject: (path: string) => void;
  clearRecentProjects: () => void;
  setActiveSideTab: (tab: SideTab) => void;
  setActiveRightTab: (tab: AppState["activeRightTab"]) => void;

  /**
   * Re-read every preference-backed field and re-apply the ones that paint
   * (theme, fonts, language). Called after a config backup replaces the stored
   * preferences — without it the values are correct in the store and the
   * screen keeps showing what it computed at startup, which reads as "the
   * import didn't work".
   */
  reloadFromPrefs: () => void;

  setMainView: (v: MainView) => void;
  setShowCommandPalette: (v: boolean) => void;
  setShowAiDrawer: (v: boolean, mode?: AiDrawerMode) => void;
  /** Open the assistant header's model picker (see `modelPickerNonce`). */
  openModelPicker: () => void;
  setShowOnboarding: (v: boolean) => void;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
}

function resolveTheme(mode: ThemeMode): "dark" | "light" {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return mode;
}

function applyTheme(mode: ThemeMode) {
  document.documentElement.setAttribute("data-theme", resolveTheme(mode));
}

/**
 * Apply the theme inside a View Transition so the whole UI cross-dissolves
 * between light/dark instead of snapping (colors come from CSS vars that flip
 * instantly, so a per-property CSS transition can't cover everything — a
 * full-page snapshot crossfade can). Falls back to an instant swap where the
 * API is unavailable (older webviews) or the user prefers reduced motion.
 * Used for user/system-driven changes only; the initial load stays instant.
 */
function applyThemeAnimated(mode: ThemeMode) {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => unknown;
  };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (typeof doc.startViewTransition === "function" && !reduced) {
    doc.startViewTransition(() => applyTheme(mode));
  } else {
    applyTheme(mode);
  }
}

function applyFontScheme(scheme: FontScheme) {
  document.documentElement.setAttribute("data-font", scheme);
}

/** Every `.md-body` container reads its look off this attribute. */
function applyMarkdownTheme(id: MarkdownThemeId) {
  document.documentElement.setAttribute(MD_THEME_ATTR, id);
}

let systemThemeListener: (() => void) | null = null;

export const useAppStore = create<AppState>((set, get) => ({
  ...prefBackedState(),
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  activeSideTab: "files",
  activeRightTab: "outline",

  mainView: "editor",
  showCommandPalette: false,
  showAiDrawer: false,
  modelPickerNonce: 0,
  showOnboarding: false,
  showSettings: false,
  settingsTab: "general",

  setTheme: (theme) => {
    writePref(THEME_KEY, theme);
    set({ theme });
    applyThemeAnimated(theme);

    if (systemThemeListener) {
      window.matchMedia("(prefers-color-scheme: dark)").removeEventListener("change", systemThemeListener);
      systemThemeListener = null;
    }
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      systemThemeListener = () => applyThemeAnimated(get().theme);
      mq.addEventListener("change", systemThemeListener);
    }
  },

  setLanguage: (language) => {
    writePref(LANG_KEY, language);
    set({ language });
    i18n.changeLanguage(language);
  },

  setFontScheme: (fontScheme) => {
    writePref(FONT_KEY, fontScheme);
    set({ fontScheme });
    applyFontScheme(fontScheme);
  },

  setMarkdownTheme: (markdownTheme) => {
    writePref(MD_THEME_KEY, markdownTheme);
    set({ markdownTheme });
    applyMarkdownTheme(markdownTheme);
  },

  toggleSidebar: () =>
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  toggleRightPanel: () =>
    set((s) => ({ rightPanelCollapsed: !s.rightPanelCollapsed })),

  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  setRightPanelCollapsed: (v) => set({ rightPanelCollapsed: v }),

  setSidebarWidth: (wOrFn) => {
    set((state) => {
      const w = typeof wOrFn === "function" ? wOrFn(state.sidebarWidth) : wOrFn;
      const clamped = clamp(w, SIDEBAR_MIN, SIDEBAR_MAX);
      writePref(SIDEBAR_WIDTH_KEY, String(clamped));
      return { sidebarWidth: clamped };
    });
  },

  setRightPanelWidth: (wOrFn) => {
    set((state) => {
      const w = typeof wOrFn === "function" ? wOrFn(state.rightPanelWidth) : wOrFn;
      const clamped = clamp(w, RIGHT_PANEL_MIN, RIGHT_PANEL_MAX);
      writePref(RIGHT_PANEL_WIDTH_KEY, String(clamped));
      return { rightPanelWidth: clamped };
    });
  },

  setLoreBudgetTokens: (tokens) => {
    const clamped = clamp(Math.round(tokens), LORE_BUDGET_MIN, LORE_BUDGET_MAX);
    writePref(LORE_BUDGET_KEY, String(clamped));
    set({ loreBudgetTokens: clamped });
  },

  setContextUtilization: (ratio) => {
    const clamped = clamp(ratio, CONTEXT_UTILIZATION_MIN, CONTEXT_UTILIZATION_MAX);
    writePref(CONTEXT_UTILIZATION_KEY, String(clamped));
    set({ contextUtilization: clamped });
  },

  setDraftCount: (n) => {
    const clamped = clamp(Math.round(n), 1, MAX_DRAFTS);
    writePref(DRAFT_COUNT_KEY, String(clamped));
    set({ draftCount: clamped });
  },

  addRecentProject: (path) => {
    set((state) => {
      const next = [path, ...state.recentProjects.filter((p) => p !== path)].slice(
        0, RECENT_PROJECTS_MAX,
      );
      writePref(RECENT_PROJECTS_KEY, JSON.stringify(next));
      return { recentProjects: next };
    });
  },

  // Dropping a project from the list also releases the preferences keyed to
  // its path. Nothing used to: `ai:pinnedLore:<path>` accumulated a row per
  // project ever opened, and even "clear the list" left every one of them
  // behind. `lib/prefs` sweeps the leftovers at startup as a backstop, but
  // collecting here is what keeps them from accruing in the first place —
  // this is the moment the app learns a project is gone.
  removeRecentProject: (path) => {
    set((state) => {
      const next = state.recentProjects.filter((p) => p !== path);
      writePref(RECENT_PROJECTS_KEY, JSON.stringify(next));
      prunePrefsWithPrefix(PINNED_LORE_PREFIX, (p) => p !== path);
      return { recentProjects: next };
    });
  },

  clearRecentProjects: () => {
    deletePref(RECENT_PROJECTS_KEY);
    prunePrefsWithPrefix(PINNED_LORE_PREFIX, () => false);
    set({ recentProjects: [] });
  },

  reloadFromPrefs: () => {
    const next = prefBackedState();
    set(next);
    applyThemeAnimated(next.theme);
    applyFontScheme(next.fontScheme);
    applyMarkdownTheme(next.markdownTheme);
    if (next.language !== i18n.language) i18n.changeLanguage(next.language);
  },

  setActiveSideTab: (tab) => set({ activeSideTab: tab }),
  setActiveRightTab: (tab) => set({ activeRightTab: tab }),

  setMainView: (v) => set({ mainView: v }),
  setShowCommandPalette: (v) => set({ showCommandPalette: v }),
  // Omitting `mode` means "just open it" — the drawer comes back on whichever
  // tab was last used. Only the mode-specific entry points (Ctrl+J/Ctrl+L, the
  // command palette, the inline bubble) name a tab, and naming one remembers it.
  setShowAiDrawer: (v, mode) =>
    set((s) => {
      if (mode && mode !== s.aiDrawerMode) writePref(AI_DRAWER_MODE_KEY, mode);
      return { showAiDrawer: v, aiDrawerMode: mode ?? s.aiDrawerMode };
    }),
  openModelPicker: () => set((s) => ({ modelPickerNonce: s.modelPickerNonce + 1 })),
  setShowOnboarding: (v) => set({ showOnboarding: v }),
  openSettings: (tab) => set({ showSettings: true, settingsTab: tab ?? "general" }),
  closeSettings: () => set({ showSettings: false }),
}));

// Initialize theme + font scheme + markdown theme on load using persisted
// values. Read off the store rather than the preferences again: the store is
// what the UI will render, so painting from anything else invites the two to
// disagree.
{
  const s = useAppStore.getState();
  applyTheme(s.theme);
  applyFontScheme(s.fontScheme);
  applyMarkdownTheme(s.markdownTheme);
}
