/**
 * The theme registry as the settings page sees it.
 *
 * A thin React face over `lib/theme/install`, which owns the state: this
 * store mirrors the registry into React (through `subscribeRegistry`, so a
 * selection change that moves a `missing` marker reaches the grids too),
 * follows the open project so its `.ai-writer/themes/` joins the registry,
 * and adds the two things only the settings page needs — a first-open scan
 * of the folders (boot reads only the selected files) and the 重新载入 diff
 * the trace line reports.
 */
import { create } from "zustand";
import {
  currentRegistry, registryScanned, reloadThemes, setProjectDir, subscribeRegistry,
} from "../lib/theme/install";
import { displayThemeName, type ThemeEntry } from "../lib/theme/registry";
import { ensureThemesDir, themesDir } from "../lib/theme/scan";
import { useAppStore } from "./appStore";
import { useProjectStore } from "./projectStore";

export interface ReloadDiff {
  /** Usable themes after the reload, by kind. */
  uiCount: number;
  mdCount: number;
  /** Themes that appeared / vanished, for the trace line. */
  added: { kind: ThemeEntry["kind"]; name: string }[];
  removed: { kind: ThemeEntry["kind"]; name: string }[];
}

interface ThemeState {
  ui: ThemeEntry[];
  markdown: ThemeEntry[];
  /** True once the folders have been scanned in full. */
  loaded: boolean;
  loading: boolean;
  dir: string | null;
  /** First open of the section: scan the folders if boot did not. */
  load: () => Promise<void>;
  /** 重新载入: scan again and say what changed. */
  reload: (isZh: boolean) => Promise<ReloadDiff>;
  /** The installation folder's path, created if absent — for 打开主题文件夹 and the export. */
  ensureDir: () => Promise<string>;
}

const selected = () => {
  const s = useAppStore.getState();
  return { light: s.themeLight, dark: s.themeDark, markdown: s.markdownTheme };
};

const usableNames = (entries: ThemeEntry[], isZh: boolean) =>
  new Map(entries.filter((e) => e.usable).map((e) => [`${e.kind}:${e.id}`, { kind: e.kind, name: displayThemeName(e, isZh) }]));

export const useThemeStore = create<ThemeState>((set, get) => ({
  ui: currentRegistry().ui,
  markdown: currentRegistry().markdown,
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
    const before = usableNames([...get().ui, ...get().markdown], isZh);
    try {
      const registry = await reloadThemes(selected());
      // The selected theme's file may have been edited — repaint from it.
      useAppStore.getState().applyCurrentTheme();
      const after = usableNames([...registry.ui, ...registry.markdown], isZh);
      set({ loaded: true });
      return {
        uiCount: registry.ui.filter((e) => e.usable).length,
        mdCount: registry.markdown.filter((e) => e.usable).length,
        added: [...after].filter(([k]) => !before.has(k)).map(([, v]) => v),
        removed: [...before].filter(([k]) => !after.has(k)).map(([, v]) => v),
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

// Every rebuild — a scan, a project change, or a selection change moving a
// `missing` marker — lands here from the registry itself, not from whichever
// store method happened to trigger it.
subscribeRegistry(() => {
  const r = currentRegistry();
  useThemeStore.setState({ ui: r.ui, markdown: r.markdown });
});

// The project's `.ai-writer/themes/` follows the open project. Also runs for
// the project restored at startup, which is the moment a project typography
// theme the preference names can first be installed.
useProjectStore.subscribe((state, prev) => {
  if (state.projectPath === prev.projectPath) return;
  void setProjectDir(state.projectPath, selected()).then(() => {
    useAppStore.getState().applyCurrentTheme(false);
  });
});
