import { create } from "zustand";
import i18n from "../i18n";

export type ThemeMode = "dark" | "light" | "system";
export type Language = "zh-CN" | "en";

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

export const useAppStore = create<AppState>((set, get) => ({
  theme: "dark",
  language: "zh-CN",
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  activeSideTab: "files",
  activeRightTab: "outline",

  setTheme: (theme) => {
    set({ theme });
    applyTheme(theme);

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyTheme(get().theme);
      mq.addEventListener("change", handler);
    }
  },

  setLanguage: (language) => {
    set({ language });
    i18n.changeLanguage(language);
  },

  toggleSidebar: () =>
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  toggleRightPanel: () =>
    set((s) => ({ rightPanelCollapsed: !s.rightPanelCollapsed })),

  setActiveSideTab: (tab) => set({ activeSideTab: tab }),
  setActiveRightTab: (tab) => set({ activeRightTab: tab }),
}));

// Initialize theme on load
applyTheme("dark");
