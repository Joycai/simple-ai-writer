import { create } from "zustand";
import i18n from "../i18n";

export type ThemeMode = "dark" | "light" | "system";
export type Language = "zh-CN" | "en";

const THEME_KEY = "app:theme";
const LANG_KEY = "app:language";

const storedTheme = (localStorage.getItem(THEME_KEY) as ThemeMode | null) ?? "dark";
const storedLang = (localStorage.getItem(LANG_KEY) as Language | null) ?? "zh-CN";

interface AppState {
  theme: ThemeMode;
  language: Language;
  sidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  activeSideTab: "files" | "lore" | "search";
  activeRightTab: "outline" | "ai" | "loreCards";

  setTheme: (theme: ThemeMode) => void;
  setLanguage: (lang: Language) => void;
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  setRightPanelCollapsed: (v: boolean) => void;
  setActiveSideTab: (tab: AppState["activeSideTab"]) => void;
  setActiveRightTab: (tab: AppState["activeRightTab"]) => void;
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
  activeSideTab: "files",
  activeRightTab: "outline",

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

  setActiveSideTab: (tab) => set({ activeSideTab: tab }),
  setActiveRightTab: (tab) => set({ activeRightTab: tab }),
}));

// Initialize theme on load using persisted value
applyTheme(storedTheme);
