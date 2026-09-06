/**
 * The appearance-theme registry as the settings page sees it.
 *
 * A thin React face over `lib/theme/install`, which owns the state: this
 * store mirrors the registry into React (through `subscribeRegistry`, so a
 * selection change that moves a `missing` marker reaches the grid too) and
 * adds the two things only the settings page needs — a first-open scan of
 * the whole folder (boot reads only the selected files) and the 重新载入 diff
 * the trace line reports.
 */
import { create } from "zustand";
import { currentRegistry, registryScanned, reloadThemes, subscribeRegistry } from "../lib/theme/install";
import { displayThemeName, type ThemeEntry } from "../lib/theme/registry";
import { ensureThemesDir, themesDir } from "../lib/theme/scan";
import { useAppStore } from "./appStore";

export interface ReloadDiff {
  /** Usable ui themes after the reload. */
  uiCount: number;
  /** Names of themes that appeared / vanished, for the trace line. */
  added: string[];
  removed: string[];
}

interface ThemeState {
  entries: ThemeEntry[];
  /** True once the folder has been scanned in full. */
  loaded: boolean;
  loading: boolean;
  dir: string | null;
  /** First open of the section: scan the folder if boot did not. */
  load: () => Promise<void>;
  /** 重新载入: scan again and say what changed. */
  reload: (isZh: boolean) => Promise<ReloadDiff>;
  /** The folder's path, created if absent — for 打开主题文件夹 and the export. */
  ensureDir: () => Promise<string>;
}

const selected = () => {
  const s = useAppStore.getState();
  return { light: s.themeLight, dark: s.themeDark };
};

const usableNames = (entries: ThemeEntry[], isZh: boolean) =>
  new Map(entries.filter((e) => e.usable).map((e) => [e.id, displayThemeName(e, isZh)]));

export const useThemeStore = create<ThemeState>((set, get) => ({
  entries: currentRegistry().entries,
  loaded: registryScanned(),
  loading: false,
  dir: null,

  load: async () => {
    if (get().loaded || get().loading) return;
    set({ loading: true });
    try {
      await reloadThemes(selected());
      // Instant, not the crossfade: nothing usually changes on a first scan,
      // and opening Settings must not dissolve the whole window.
      useAppStore.getState().applyCurrentTheme(false);
      set({ loaded: true });
    } finally {
      set({ loading: false });
    }
    try {
      set({ dir: await themesDir() });
    } catch { /* outside Tauri */ }
  },

  reload: async (isZh) => {
    set({ loading: true });
    const before = usableNames(get().entries, isZh);
    try {
      const registry = await reloadThemes(selected());
      // The selected theme's file may have been edited — repaint from it.
      useAppStore.getState().applyCurrentTheme();
      const after = usableNames(registry.entries, isZh);
      set({ loaded: true });
      return {
        uiCount: after.size,
        added: [...after].filter(([id]) => !before.has(id)).map(([, name]) => name),
        removed: [...before].filter(([id]) => !after.has(id)).map(([, name]) => name),
      };
    } finally {
      set({ loading: false });
    }
  },

  ensureDir: async () => {
    const dir = await ensureThemesDir();
    set({ dir });
    return dir;
  },
}));

// Every rebuild — a scan, or a selection change moving a `missing` marker —
// lands here from the registry itself, not from whichever store method
// happened to trigger it.
subscribeRegistry(() => useThemeStore.setState({ entries: currentRegistry().entries }));
