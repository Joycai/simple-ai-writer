import { create } from "zustand";
import i18n from "../i18n";

export type ThemeMode = "dark" | "light" | "system";
export type Language = "zh-CN" | "en";

const THEME_KEY = "app:theme";
const LANG_KEY = "app:language";
const SIDEBAR_WIDTH_KEY = "app:sidebarWidth";
const RIGHT_PANEL_WIDTH_KEY = "app:rightPanelWidth";

const storedTheme = (localStorage.getItem(THEME_KEY) as ThemeMode | null) ?? "dark";
const storedLang = (localStorage.getItem(LANG_KEY) as Language | null) ?? "zh-CN";

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

export type MainView = "editor" | "lore-wall" | "outline-full";
export type AiDrawerMode = "generate" | "consistency";
export type SideTab = "files" | "lore" | "outline" | "search";

interface AppState {
  theme: ThemeMode;
  language: Language;
  sidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  sidebarWidth: number;
  rightPanelWidth: number;
  activeSideTab: SideTab;
  activeRightTab: "outline" | "ai";

  // Manuscript additions
  mainView: MainView;
  showCommandPalette: boolean;
  showAiDrawer: boolean;
  aiDrawerMode: AiDrawerMode;
  showOnboarding: boolean;

  /**
   * Cross-component navigation request to the lore detail page.
   * Set when something outside LoreWall (e.g. the sidebar's "manage images"
   * button) wants to deep-link into a specific entity and optionally scroll
   * to a named section. LoreWall consumes `entityId`/`category` to open the
   * detail, then LoreDetail consumes `anchor` and clears it.
   */
  pendingLoreNav: { entityId: string; category: string; anchor?: "gallery" } | null;

  setTheme: (theme: ThemeMode) => void;
  setLanguage: (lang: Language) => void;
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  setRightPanelCollapsed: (v: boolean) => void;
  setSidebarWidth: (w: number | ((prev: number) => number)) => void;
  setRightPanelWidth: (w: number | ((prev: number) => number)) => void;
  setActiveSideTab: (tab: SideTab) => void;
  setActiveRightTab: (tab: AppState["activeRightTab"]) => void;

  setMainView: (v: MainView) => void;
  setShowCommandPalette: (v: boolean) => void;
  setShowAiDrawer: (v: boolean, mode?: AiDrawerMode) => void;
  setShowOnboarding: (v: boolean) => void;
  setPendingLoreNav: (v: AppState["pendingLoreNav"]) => void;
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

let systemThemeListener: (() => void) | null = null;

export const useAppStore = create<AppState>((set, get) => ({
  theme: storedTheme,
  language: storedLang,
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  sidebarWidth: storedSidebarWidth,
  rightPanelWidth: storedRightPanelWidth,
  activeSideTab: "files",
  activeRightTab: "outline",

  mainView: "editor",
  showCommandPalette: false,
  showAiDrawer: false,
  aiDrawerMode: "generate",
  showOnboarding: false,
  pendingLoreNav: null,

  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme);
    set({ theme });
    applyTheme(theme);

    if (systemThemeListener) {
      window.matchMedia("(prefers-color-scheme: dark)").removeEventListener("change", systemThemeListener);
      systemThemeListener = null;
    }
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      systemThemeListener = () => applyTheme(get().theme);
      mq.addEventListener("change", systemThemeListener);
    }
  },

  setLanguage: (language) => {
    localStorage.setItem(LANG_KEY, language);
    set({ language });
    i18n.changeLanguage(language);
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

  setActiveSideTab: (tab) => set({ activeSideTab: tab }),
  setActiveRightTab: (tab) => set({ activeRightTab: tab }),

  setMainView: (v) => set({ mainView: v }),
  setShowCommandPalette: (v) => set({ showCommandPalette: v }),
  setShowAiDrawer: (v, mode) =>
    set((s) => ({ showAiDrawer: v, aiDrawerMode: mode ?? s.aiDrawerMode })),
  setShowOnboarding: (v) => set({ showOnboarding: v }),
  setPendingLoreNav: (v) => set({ pendingLoreNav: v }),
}));

// Initialize theme on load using persisted value
applyTheme(storedTheme);
