import { create } from "zustand";
import i18n from "../i18n";

export type ThemeMode = "dark" | "light" | "system";
export type Language = "zh-CN" | "en";
export type FontScheme = "manuscript" | "song" | "hei" | "kai";

const FONT_SCHEMES: FontScheme[] = ["manuscript", "song", "hei", "kai"];

const THEME_KEY = "app:theme";
const LANG_KEY = "app:language";
const FONT_KEY = "app:fontScheme";
const SIDEBAR_WIDTH_KEY = "app:sidebarWidth";
const RIGHT_PANEL_WIDTH_KEY = "app:rightPanelWidth";
const RECENT_PROJECTS_KEY = "app:recentProjects";
const LORE_BUDGET_KEY = "app:loreBudgetTokens";

const RECENT_PROJECTS_MAX = 10;

/** Token budget bounds for the 【设定资料】 block (see lib/context/loreSelect). */
export const LORE_BUDGET_MIN = 200;
export const LORE_BUDGET_MAX = 2000;
export const LORE_BUDGET_DEFAULT = 600;

const storedTheme = (localStorage.getItem(THEME_KEY) as ThemeMode | null) ?? "dark";
const storedLang = (localStorage.getItem(LANG_KEY) as Language | null) ?? "zh-CN";
const storedFontScheme = ((): FontScheme => {
  const raw = localStorage.getItem(FONT_KEY) as FontScheme | null;
  return raw && FONT_SCHEMES.includes(raw) ? raw : "manuscript";
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

export type MainView = "editor" | "lore-wall" | "outline-full";
export type AiDrawerMode = "generate" | "consistency";
export type SideTab = "files" | "outline" | "search";

interface AppState {
  theme: ThemeMode;
  language: Language;
  fontScheme: FontScheme;
  sidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  sidebarWidth: number;
  rightPanelWidth: number;
  recentProjects: string[];
  /** Token budget for lore injection (【设定资料】 block). */
  loreBudgetTokens: number;
  activeSideTab: SideTab;
  activeRightTab: "outline" | "ai";

  // Manuscript additions
  mainView: MainView;
  showCommandPalette: boolean;
  showAiDrawer: boolean;
  aiDrawerMode: AiDrawerMode;
  showOnboarding: boolean;

  setTheme: (theme: ThemeMode) => void;
  setLanguage: (lang: Language) => void;
  setFontScheme: (scheme: FontScheme) => void;
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  setRightPanelCollapsed: (v: boolean) => void;
  setSidebarWidth: (w: number | ((prev: number) => number)) => void;
  setRightPanelWidth: (w: number | ((prev: number) => number)) => void;
  setLoreBudgetTokens: (tokens: number) => void;
  addRecentProject: (path: string) => void;
  removeRecentProject: (path: string) => void;
  clearRecentProjects: () => void;
  setActiveSideTab: (tab: SideTab) => void;
  setActiveRightTab: (tab: AppState["activeRightTab"]) => void;

  setMainView: (v: MainView) => void;
  setShowCommandPalette: (v: boolean) => void;
  setShowAiDrawer: (v: boolean, mode?: AiDrawerMode) => void;
  setShowOnboarding: (v: boolean) => void;
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

let systemThemeListener: (() => void) | null = null;

export const useAppStore = create<AppState>((set, get) => ({
  theme: storedTheme,
  language: storedLang,
  fontScheme: storedFontScheme,
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  sidebarWidth: storedSidebarWidth,
  rightPanelWidth: storedRightPanelWidth,
  recentProjects: loadRecentProjects(),
  loreBudgetTokens: storedLoreBudget,
  activeSideTab: "files",
  activeRightTab: "outline",

  mainView: "editor",
  showCommandPalette: false,
  showAiDrawer: false,
  aiDrawerMode: "generate",
  showOnboarding: false,

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
  setShowAiDrawer: (v, mode) =>
    set((s) => ({ showAiDrawer: v, aiDrawerMode: mode ?? s.aiDrawerMode })),
  setShowOnboarding: (v) => set({ showOnboarding: v }),
}));

// Initialize theme + font scheme on load using persisted values
applyTheme(storedTheme);
applyFontScheme(storedFontScheme);
