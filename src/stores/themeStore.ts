/**
 * The theme registry as the settings page sees it.
 *
 * A thin React face over `lib/theme/install`, which owns the state: this
 * store mirrors the registry into React (through `subscribeRegistry`, so a
 * selection change that moves a `missing` marker reaches the grids too),
 * follows the open project so its `.ai-writer/themes/` joins the registry,
 * and adds what only the settings page needs — a first-open scan of the
 * folders (boot reads only the selected files), the 重新载入 diff the trace
 * line reports, and the **folder watcher**: while Settings is open, the two
 * themes folders are watched and a change reloads them on its own, so an
 * author editing a theme file sees it land without pressing anything
 * (Typora's 「改一行重启一次」 was its most complained-about edge). Only
 * while Settings is open: nowhere else shows the result, and a watcher
 * running for the app's whole life would cost more than it shows.
 */
import { create } from "zustand";
import {
  currentRegistry, registryScanned, reloadThemes, setProjectDir, subscribeRegistry,
} from "../lib/theme/install";
import { displayThemeName, type ThemeEntry } from "../lib/theme/registry";
import { ensureThemesDir, projectThemesDir, themesDir } from "../lib/theme/scan";
import { fileExists } from "../lib/fs/fileio";
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
  /**
   * The last reload the watcher ran, for the action row's trace. `seq`
   * moves on every one; the diff is what it found. Null until a change
   * on disk has been picked up.
   */
  autoReload: { seq: number; diff: ReloadDiff } | null;
  /** First open of the section: scan the folders if boot did not. */
  load: () => Promise<void>;
  /** 重新载入: scan again and say what changed. */
  reload: (isZh: boolean) => Promise<ReloadDiff>;
  /** The installation folder's path, created if absent — for 打开主题文件夹 and the export. */
  ensureDir: () => Promise<string>;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const selected = () => {
  const s = useAppStore.getState();
  return { light: s.themeLight, dark: s.themeDark, markdown: s.markdownTheme };
};

const isZhNow = () => useAppStore.getState().language.startsWith("zh");

const usableNames = (entries: ThemeEntry[], isZh: boolean) =>
  new Map(entries.filter((e) => e.usable).map((e) => [`${e.kind}:${e.id}`, { kind: e.kind, name: displayThemeName(e, isZh) }]));

/** Scan both folders and describe what moved. Shared by the button and the watcher. */
async function scanAndDiff(before: Map<string, { kind: ThemeEntry["kind"]; name: string }>, isZh: boolean): Promise<ReloadDiff> {
  const registry = await reloadThemes(selected());
  // The selected theme's file may have been edited — repaint from it.
  useAppStore.getState().applyCurrentTheme();
  const after = usableNames([...registry.ui, ...registry.markdown], isZh);
  return {
    uiCount: registry.ui.filter((e) => e.usable).length,
    mdCount: registry.markdown.filter((e) => e.usable).length,
    added: [...after].filter(([k]) => !before.has(k)).map(([, v]) => v),
    removed: [...before].filter(([k]) => !after.has(k)).map(([, v]) => v),
  };
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  ui: currentRegistry().ui,
  markdown: currentRegistry().markdown,
  loaded: registryScanned(),
  loading: false,
  dir: null,
  autoReload: null,

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
      const diff = await scanAndDiff(before, isZh);
      set({ loaded: true });
      return diff;
    } finally {
      set({ loading: false });
    }
  },

  ensureDir: async () => {
    const dir = await ensureThemesDir();
    set({ dir });
    // The folder may have just been created: a watcher started before it
    // existed skipped it, so start over with it in the set.
    void restartWatch();
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
    void restartWatch();
  });
});

// ─── The watcher ─────────────────────────────────────────────────────────────

let unwatch: (() => void) | null = null;
let watching = false;
let watchSeq = 0;
let debounce: number | null = null;

/** The folders that exist right now — a watch on a missing folder throws. */
async function watchableDirs(): Promise<string[]> {
  const dirs = [await themesDir()];
  const project = useProjectStore.getState().projectPath;
  if (project) dirs.push(projectThemesDir(project));
  const out: string[] = [];
  for (const d of dirs) {
    try {
      if (await fileExists(d)) out.push(d);
    } catch { /* not readable — nothing to watch */ }
  }
  return out;
}

async function startWatch(): Promise<void> {
  if (!isTauri || watching) return;
  watching = true;
  const seq = ++watchSeq;
  try {
    const dirs = await watchableDirs();
    if (!dirs.length) return;
    const { watch } = await import("@tauri-apps/plugin-fs");
    // The plugin's own debounce coalesces an editor's write burst (rename +
    // write + chmod) into one event; ours coalesces the folders.
    const stop = await watch(dirs, () => scheduleAutoReload(), { recursive: true, delayMs: 300 });
    if (seq !== watchSeq || !watching) {
      stop();
      return;
    }
    unwatch = stop;
  } catch (e) {
    console.warn("[theme] folder watch unavailable; 重新载入 still works:", e);
  }
}

function stopWatch(): void {
  watching = false;
  watchSeq++;
  unwatch?.();
  unwatch = null;
  if (debounce !== null) {
    clearTimeout(debounce);
    debounce = null;
  }
}

/** The set of folders changed (a project opened, the folder was created): watch the new set. */
async function restartWatch(): Promise<void> {
  if (!watching) return;
  stopWatch();
  await startWatch();
}

function scheduleAutoReload(): void {
  if (debounce !== null) clearTimeout(debounce);
  debounce = window.setTimeout(() => {
    debounce = null;
    void autoReload();
  }, 250);
}

async function autoReload(): Promise<void> {
  const st = useThemeStore.getState();
  if (st.loading) {
    scheduleAutoReload();
    return;
  }
  const isZh = isZhNow();
  useThemeStore.setState({ loading: true });
  try {
    const before = usableNames([...st.ui, ...st.markdown], isZh);
    const diff = await scanAndDiff(before, isZh);
    useThemeStore.setState({ loaded: true, autoReload: { seq: (st.autoReload?.seq ?? 0) + 1, diff } });
  } catch (e) {
    console.warn("[theme] reload after a folder change failed:", e);
  } finally {
    useThemeStore.setState({ loading: false });
  }
}

// Watch only while Settings is open — the one place the result shows.
useAppStore.subscribe((state, prev) => {
  if (state.showSettings === prev.showSettings) return;
  if (state.showSettings) void startWatch();
  else stopWatch();
});
