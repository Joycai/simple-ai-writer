import { create } from "zustand";
import i18n from "../i18n";
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


const storedTheme = (localStorage.getItem(THEME_KEY) as ThemeMode | null) ?? "dark";
const storedLang = (localStorage.getItem(LANG_KEY) as Language | null) ?? "zh-CN";
const storedFontScheme = ((): FontScheme => {
  const raw = localStorage.getItem(FONT_KEY) as FontScheme | null;
  return raw && FONT_SCHEMES.includes(raw) ? raw : "manuscript";
})();
const storedMarkdownTheme = ((): MarkdownThemeId => {
  const raw = localStorage.getItem(MD_THEME_KEY) as MarkdownThemeId | null;
  return raw && MARKDOWN_THEME_IDS.includes(raw) ? raw : DEFAULT_MARKDOWN_THEME;
})();

function loadRecentProjects(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_KEY);
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

const storedSidebarWidth = clamp(
  parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? "240", 10),
  SIDEBAR_MIN, SIDEBAR_MAX,
);
const storedRightPanelWidth = clamp(
  parseInt(localStorage.getItem(RIGHT_PANEL_WIDTH_KEY) ?? "280", 10),
  RIGHT_PANEL_MIN, RIGHT_PANEL_MAX,
);
const storedLoreBudget = clamp(
  parseInt(localStorage.getItem(LORE_BUDGET_KEY) ?? String(LORE_BUDGET_DEFAULT), 10) || LORE_BUDGET_DEFAULT,
  LORE_BUDGET_MIN, LORE_BUDGET_MAX,
);
const storedContextUtilization = clamp(
  parseFloat(localStorage.getItem(CONTEXT_UTILIZATION_KEY) ?? "") || CONTEXT_UTILIZATION_DEFAULT,
  CONTEXT_UTILIZATION_MIN, CONTEXT_UTILIZATION_MAX,
);
const storedDraftCount = clamp(
  parseInt(localStorage.getItem(DRAFT_COUNT_KEY) ?? "1", 10) || 1,
  1, MAX_DRAFTS,
);

/** Which assistant tab the drawer reopens on — persisted like the panel widths. */
const storedAiDrawerMode = ((): AiDrawerMode => {
  const raw = localStorage.getItem(AI_DRAWER_MODE_KEY);
  return raw === "chat" || raw === "consistency" || raw === "generate" ? raw : "generate";
})();

export type MainView = "editor" | "lore-wall" | "outline-full";
export type AiDrawerMode = "generate" | "chat" | "consistency";
export type SettingsTab = "general" | "providers" | "models" | "prompts" | "about";
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
  showOnboarding: boolean;
  /** Settings modal visibility + which pane it opens on. Lives here rather than
   *  in App so any surface (e.g. the model picker's 管理供应商) can reach it. */
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

  setMainView: (v: MainView) => void;
  setShowCommandPalette: (v: boolean) => void;
  setShowAiDrawer: (v: boolean, mode?: AiDrawerMode) => void;
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
  theme: storedTheme,
  language: storedLang,
  fontScheme: storedFontScheme,
  markdownTheme: storedMarkdownTheme,
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  sidebarWidth: storedSidebarWidth,
  rightPanelWidth: storedRightPanelWidth,
  recentProjects: loadRecentProjects(),
  loreBudgetTokens: storedLoreBudget,
  contextUtilization: storedContextUtilization,
  draftCount: storedDraftCount,
  activeSideTab: "files",
  activeRightTab: "outline",

  mainView: "editor",
  showCommandPalette: false,
  showAiDrawer: false,
  aiDrawerMode: storedAiDrawerMode,
  showOnboarding: false,
  showSettings: false,
  settingsTab: "general",

  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme);
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
    localStorage.setItem(LANG_KEY, language);
    set({ language });
    i18n.changeLanguage(language);
  },

  setFontScheme: (fontScheme) => {
    localStorage.setItem(FONT_KEY, fontScheme);
    set({ fontScheme });
    applyFontScheme(fontScheme);
  },

  setMarkdownTheme: (markdownTheme) => {
    localStorage.setItem(MD_THEME_KEY, markdownTheme);
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
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
      return { sidebarWidth: clamped };
    });
  },

  setRightPanelWidth: (wOrFn) => {
    set((state) => {
      const w = typeof wOrFn === "function" ? wOrFn(state.rightPanelWidth) : wOrFn;
      const clamped = clamp(w, RIGHT_PANEL_MIN, RIGHT_PANEL_MAX);
      localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(clamped));
      return { rightPanelWidth: clamped };
    });
  },

  setLoreBudgetTokens: (tokens) => {
    const clamped = clamp(Math.round(tokens), LORE_BUDGET_MIN, LORE_BUDGET_MAX);
    localStorage.setItem(LORE_BUDGET_KEY, String(clamped));
    set({ loreBudgetTokens: clamped });
  },

  setContextUtilization: (ratio) => {
    const clamped = clamp(ratio, CONTEXT_UTILIZATION_MIN, CONTEXT_UTILIZATION_MAX);
    localStorage.setItem(CONTEXT_UTILIZATION_KEY, String(clamped));
    set({ contextUtilization: clamped });
  },

  setDraftCount: (n) => {
    const clamped = clamp(Math.round(n), 1, MAX_DRAFTS);
    localStorage.setItem(DRAFT_COUNT_KEY, String(clamped));
    set({ draftCount: clamped });
  },

  addRecentProject: (path) => {
    set((state) => {
      const next = [path, ...state.recentProjects.filter((p) => p !== path)].slice(
        0, RECENT_PROJECTS_MAX,
      );
      localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next));
      return { recentProjects: next };
    });
  },

  removeRecentProject: (path) => {
    set((state) => {
      const next = state.recentProjects.filter((p) => p !== path);
      localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next));
      return { recentProjects: next };
    });
  },

  clearRecentProjects: () => {
    localStorage.removeItem(RECENT_PROJECTS_KEY);
    set({ recentProjects: [] });
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
      if (mode && mode !== s.aiDrawerMode) localStorage.setItem(AI_DRAWER_MODE_KEY, mode);
      return { showAiDrawer: v, aiDrawerMode: mode ?? s.aiDrawerMode };
    }),
  setShowOnboarding: (v) => set({ showOnboarding: v }),
  openSettings: (tab) => set({ showSettings: true, settingsTab: tab ?? "general" }),
  closeSettings: () => set({ showSettings: false }),
}));

// Initialize theme + font scheme + markdown theme on load using persisted values
applyTheme(storedTheme);
applyFontScheme(storedFontScheme);
applyMarkdownTheme(storedMarkdownTheme);
