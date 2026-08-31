import { create } from "zustand";
import i18n from "../i18n";
import { deletePref, LORE_SCOPE_PREFIX, PINNED_LORE_PREFIX, prunePrefsWithPrefix, readPref, writePref, writePrefMerged } from "../lib/prefs";
import {
  capRecentProjects,
  isProjectPinned,
  mergeOpenedAt,
  mergePinnedProjects,
  mergeRecentProjects,
  parseOpenedAt,
  parsePinnedProjects,
  parseRecentProjects,
  pruneOpenedAt,
} from "../lib/recentProjects";
import { MAX_DRAFTS } from "../lib/ai/drafts";
import { isRoleplayEnabled } from "../lib/roleplay/flag";
import { DEFAULT_MAX_OUTPUT_KEY, DEFAULT_MAX_OUTPUT_MAX } from "../lib/ai/modelLimits";
import {
  DEFAULT_IMAGE_LONG_EDGE, IMAGE_LONG_EDGE_KEY, IMAGE_LONG_EDGE_MAX, IMAGE_LONG_EDGE_MIN,
} from "../lib/image/downscalePlan";
import { isSamePath, toPosixPath } from "../lib/paths";
import { docModel } from "../lib/profile/active";
import {
  CONTEXT_UTILIZATION_DEFAULT,
  CONTEXT_UTILIZATION_MAX,
  CONTEXT_UTILIZATION_MIN,
} from "../lib/context/budget";
import {
  PREVIEW_ZOOM_DEFAULT,
  PREVIEW_ZOOM_MAX,
  PREVIEW_ZOOM_MIN,
  snapPreviewZoom,
  stepPreviewZoom,
} from "../lib/editor/previewZoom";
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
const PREVIEW_ZOOM_KEY = "app:previewZoom";
const SIDEBAR_WIDTH_KEY = "app:sidebarWidth";
const RIGHT_PANEL_WIDTH_KEY = "app:rightPanelWidth";
const RECENT_PROJECTS_KEY = "app:recentProjects";
const PINNED_PROJECTS_KEY = "app:pinnedProjects";
const OPENED_AT_KEY = "app:projectOpenedAt";
const PIN_HINT_KEY = "app:pinHintDone";
const LORE_BUDGET_KEY = "app:loreBudgetTokens";
const CONTEXT_UTILIZATION_KEY = "app:contextUtilization";
const AI_DRAWER_MODE_KEY = "app:aiDrawerMode";
const DRAFT_COUNT_KEY = "app:draftCount";

/**
 * Token budget bounds for the 【知识库】 block (see lib/context/loreSelect).
 * The ceiling is sized for large-context models (128k-class) — the block still
 * has to share the window with the document, memory and the model's reply, so
 * spending the whole budget on lore is the author's call, not the default.
 */
export const LORE_BUDGET_MIN = 200;
export const LORE_BUDGET_MAX = 128_000;
export const LORE_BUDGET_DEFAULT = 600;

/**
 * 预算的档位。**「提高预算」跨的就是这一档。**
 *
 * 住在这里而不是某个面板里：写作面板的注入报告和扮演的取材条各有一个同名的
 * 「提高预算」入口，两处点下去必须跨同样的步长——同一句话跨不同的步子，是最容易
 * 让作者对不上账的一种不一致。
 */
export const LORE_BUDGET_OPTIONS = [600, 2000, 8000, 32000] as const;


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
function storedPreviewZoom(): number {
  const raw = parseFloat(readPref(PREVIEW_ZOOM_KEY) ?? "");
  return raw ? snapPreviewZoom(raw) : PREVIEW_ZOOM_DEFAULT;
}

// Normalisation, dedup and the cap live in lib/recentProjects (pure, shared
// with the multi-instance merge that runs at persist time). The cap counts
// unpinned entries only, so the pin row has to be read first.
function loadPinnedProjects(): string[] {
  return parsePinnedProjects(readPref(PINNED_PROJECTS_KEY));
}
function loadRecentProjects(pinned: readonly string[]): string[] {
  return parseRecentProjects(readPref(RECENT_PROJECTS_KEY), pinned);
}

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 500;
const RIGHT_PANEL_MIN = 160;
const RIGHT_PANEL_MAX = 500;

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

/**
 * The sidebar bounds, for the drag preview: while the handle is being dragged
 * the width lives in a CSS variable (no store write per mousemove), but the
 * live value must still respect the same bounds the committed one will.
 */
export function clampSidebarWidth(w: number): number {
  return clamp(w, SIDEBAR_MIN, SIDEBAR_MAX);
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
/**
 * App-wide fallback for a model's per-reply output cap. 0 = no opinion, which
 * is the default and leaves each protocol's own behaviour alone.
 *
 * Stored here for the settings UI to bind to; the *authority* is
 * `lib/ai/modelLimits.defaultMaxOutput()`, which reads the same pref at call
 * time — the request path must not depend on a React store being current.
 */
const storedDefaultMaxOutput = () =>
  clamp(parseInt(readPref(DEFAULT_MAX_OUTPUT_KEY) ?? "0", 10) || 0, 0, DEFAULT_MAX_OUTPUT_MAX);

/**
 * Longest edge a picture may carry to a model. Same arrangement as the output
 * cap above: this copy exists for the settings field to bind to, and the
 * authority is `lib/image/downscalePlan.imageMaxLongEdge()`, read at the
 * moment a picture is actually sent.
 *
 * Zero is a real value here, not an empty one — an author who clears the field
 * is asking for the pre-downscaling behaviour back, and must not have the
 * default handed to them instead.
 */
const storedImageMaxLongEdge = () => {
  const raw = readPref(IMAGE_LONG_EDGE_KEY);
  if (raw === null) return DEFAULT_IMAGE_LONG_EDGE;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? clamp(n, IMAGE_LONG_EDGE_MIN, IMAGE_LONG_EDGE_MAX) : 0;
};

/**
 * Which assistant tab the drawer reopens on — persisted like the panel widths.
 *
 * `roleplay` is downgraded when its Beta switch is off: the tab is *absent*
 * in that case, so restoring it would open the drawer onto a mode with no tab
 * to leave it by. This is the one stored mode that can stop existing between
 * two launches.
 */
const storedAiDrawerMode = (): AiDrawerMode => {
  const raw = readPref(AI_DRAWER_MODE_KEY);
  if (raw === "roleplay") return isRoleplayEnabled() ? "roleplay" : "generate";
  return raw === "chat" || raw === "consistency" || raw === "generate" ? raw : "generate";
};

/** The pref-backed slice, re-derivable in one call. */
function prefBackedState() {
  const pinnedProjects = loadPinnedProjects();
  return {
    theme: storedTheme(),
    language: storedLang(),
    fontScheme: storedFontScheme(),
    markdownTheme: storedMarkdownTheme(),
    previewZoom: storedPreviewZoom(),
    sidebarWidth: storedSidebarWidth(),
    rightPanelWidth: storedRightPanelWidth(),
    pinnedProjects,
    recentProjects: loadRecentProjects(pinnedProjects),
    projectOpenedAt: parseOpenedAt(readPref(OPENED_AT_KEY)),
    pinHintDone: readPref(PIN_HINT_KEY) === "1",
    loreBudgetTokens: storedLoreBudget(),
    contextUtilization: storedContextUtilization(),
    draftCount: storedDraftCount(),
    defaultMaxOutput: storedDefaultMaxOutput(),
    imageMaxLongEdge: storedImageMaxLongEdge(),
    aiDrawerMode: storedAiDrawerMode(),
  };
}

export type MainView = "editor" | "lore-wall" | "library";
export type AiDrawerMode = "generate" | "chat" | "consistency" | "roleplay";
/** Every pane the settings page renders — `openSettings(tab)` can reach all of
 *  them, so this union and SettingsPage's nav must stay in step. */
export type SettingsTab =
  | "general"
  | "workspace"
  | "docx-format"
  | "providers-models"
  | "subagents"
  | "prompts"
  | "usage"
  | "shortcuts"
  | "about"
  | "sync";
export type SideTab = "files" | "outline" | "search";

/**
 * A *screen* — one destination of the icon rail, and what the ⌘1‥⌘5 shortcuts
 * switch between (see `showScreen`).
 *
 * Deliberately not `MainView`: two of the five are sidebar panels sharing the
 * editor view and one is the settings overlay, which is not a MainView at all.
 * The rail's own vocabulary is the one the author sees, so it is the one the
 * shortcuts speak.
 */
export type AppScreen = "files" | "outline" | "knowledge" | "library" | "settings";

/**
 * Whether a view is one an open folder is a precondition for.
 *
 * The knowledge base and the library are both *project* data — the wall reads
 * `.ai-writer/lore/`, the library the book spine — so with no folder open they
 * have nothing to show and nowhere to write. The editor is the only view that
 * stands on its own: it is where the recents list is offered.
 *
 * The rule itself is applied in three places, all of which come back here:
 * `projectStore.useMainView` (what renders and what the rail lights),
 * `IconRail` (the buttons), and `useGlobalShortcuts` (⌘3 / ⌘4).
 */
export function viewNeedsProject(view: MainView): boolean {
  return view === "lore-wall" || view === "library";
}

/** The same gate in the rail's vocabulary — see AppScreen on why there are two. */
export function screenNeedsProject(screen: AppScreen): boolean {
  return screen === "knowledge" || screen === "library";
}

interface AppState {
  theme: ThemeMode;
  language: Language;
  fontScheme: FontScheme;
  markdownTheme: MarkdownThemeId;
  /**
   * How large the rendered preview draws, as a factor on the ladder in
   * `lib/editor/previewZoom`. An appearance preference like the markdown
   * theme — one setting for every document, kept across restarts, and carried
   * in a config backup.
   */
  previewZoom: number;
  sidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  sidebarWidth: number;
  rightPanelWidth: number;
  recentProjects: string[];
  /**
   * The projects the author pinned: a set of markers over `recentProjects`,
   * not a second list. Pinned entries survive 清空, are exempt from the
   * recents cap, and sort above the rest (`splitProjects`).
   */
  pinnedProjects: string[];
  /** When each listed project was last opened (path → epoch ms). Only the
   *  widest sidebar layout prints it; a missing stamp simply shows nothing. */
  projectOpenedAt: Record<string, number>;
  /** The "you can pin a project" hint is a first-run nudge: one successful
   *  pin retires it for good. */
  pinHintDone: boolean;
  /** Token budget for lore injection (the 【知识库】 block). */
  loreBudgetTokens: number;
  /** Share of the model's context window one request may occupy (0–1). */
  contextUtilization: number;
  /**
   * Fallback per-reply output cap for models that declare none and aren't in
   * the built-in table (`lib/ai/modelLimits`). 0 = leave it to each protocol.
   */
  defaultMaxOutput: number;
  imageMaxLongEdge: number;
  /**
   * How many drafts a generative task should produce (1–`MAX_DRAFTS`).
   *
   * A user preference rather than per-run state, so "always give me three
   * options" survives restarts. Tasks that can't fan out clamp it themselves —
   * see `draftCountFor` in aiTaskStore, which owns that rule.
   */
  draftCount: number;
  activeSideTab: SideTab;

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
  /** Set the preview zoom, snapped to the ladder. */
  setPreviewZoom: (zoom: number) => void;
  /** Step one rung in (+1) or out (-1); no-op at the ends. */
  stepPreviewZoom: (dir: 1 | -1) => void;
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  setRightPanelCollapsed: (v: boolean) => void;
  setSidebarWidth: (w: number | ((prev: number) => number)) => void;
  setRightPanelWidth: (w: number | ((prev: number) => number)) => void;
  setLoreBudgetTokens: (tokens: number) => void;
  setContextUtilization: (ratio: number) => void;
  setDraftCount: (n: number) => void;
  setDefaultMaxOutput: (tokens: number) => void;
  setImageMaxLongEdge: (px: number) => void;
  addRecentProject: (path: string) => void;
  removeRecentProject: (path: string) => void;
  /**
   * Drop every unpinned entry and **return the list as it was**, so the panel
   * can offer an undo. Deliberately leaves the per-project preferences of the
   * dropped projects alone — an undo five seconds later has to put back a
   * whole project, not a name. `collectUnlistedProjectPrefs` is the other half.
   */
  clearRecentProjects: () => string[];
  /** Put a list returned by `clearRecentProjects` back, verbatim. */
  restoreRecentProjects: (previous: string[]) => void;
  /**
   * Release the preferences keyed to projects that are no longer listed
   * anywhere (`ai:pinnedLore:<path>`, `lore:scope:<path>`, the open-at stamp).
   * Called once the undo window on a clear has closed.
   */
  collectUnlistedProjectPrefs: () => void;
  pinProject: (path: string) => void;
  unpinProject: (path: string) => void;
  setActiveSideTab: (tab: SideTab) => void;

  /**
   * Re-read every preference-backed field and re-apply the ones that paint
   * (theme, fonts, language). Called after a config backup replaces the stored
   * preferences — without it the values are correct in the store and the
   * screen keeps showing what it computed at startup, which reads as "the
   * import didn't work".
   */
  reloadFromPrefs: () => void;

  setMainView: (v: MainView) => void;
  /**
   * Go to one screen — the keyboard's equivalent of clicking an icon-rail
   * button, minus the rail's click-to-collapse toggle: a shortcut that
   * sometimes lands somewhere and sometimes closes the panel is a shortcut
   * nobody trusts. Settings is an overlay over everything else, so every other
   * screen closes it on the way past.
   */
  showScreen: (screen: AppScreen) => void;
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

  setPreviewZoom: (zoom) => {
    const snapped = snapPreviewZoom(clamp(zoom, PREVIEW_ZOOM_MIN, PREVIEW_ZOOM_MAX));
    writePref(PREVIEW_ZOOM_KEY, String(snapped));
    set({ previewZoom: snapped });
  },

  stepPreviewZoom: (dir) => {
    set((state) => {
      const next = stepPreviewZoom(state.previewZoom, dir);
      if (next === state.previewZoom) return state;
      writePref(PREVIEW_ZOOM_KEY, String(next));
      return { previewZoom: next };
    });
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

  setDefaultMaxOutput: (tokens) => {
    const clamped = clamp(Math.round(tokens) || 0, 0, DEFAULT_MAX_OUTPUT_MAX);
    writePref(DEFAULT_MAX_OUTPUT_KEY, String(clamped));
    set({ defaultMaxOutput: clamped });
  },

  setImageMaxLongEdge: (px) => {
    const n = Math.round(px) || 0;
    const clamped = n > 0 ? clamp(n, IMAGE_LONG_EDGE_MIN, IMAGE_LONG_EDGE_MAX) : 0;
    writePref(IMAGE_LONG_EDGE_KEY, String(clamped));
    set({ imageMaxLongEdge: clamped });
  },

  addRecentProject: (path) => {
    set((state) => {
      const pinned = state.pinnedProjects;
      const next = capRecentProjects(
        [path, ...state.recentProjects.filter((p) => !isSamePath(p, path))],
        pinned,
      );
      // Merged, not overwritten: another instance may have opened *its*
      // project since this one hydrated, and saving our snapshot plainly
      // would evict that entry (see lib/recentProjects). The merge is given
      // our pin set for the same reason the cap above is — a union trimmed
      // without it would evict a pinned project.
      writePrefMerged(RECENT_PROJECTS_KEY, JSON.stringify(next), (db, ours) =>
        mergeRecentProjects(db, ours, pinned));
      // Merged too, and "later wins" there: the other instance may have opened
      // its own project since we hydrated, and its stamp is the newer fact.
      const projectOpenedAt = { ...state.projectOpenedAt, [toPosixPath(path)]: Date.now() };
      writePrefMerged(OPENED_AT_KEY, JSON.stringify(projectOpenedAt), mergeOpenedAt);
      return { recentProjects: next, projectOpenedAt };
    });
  },

  /**
   * Pin a project: it stops being evictable and stops being cleared.
   *
   * Merged like `addRecentProject` — a pin made in another instance must not
   * be dropped by this one saving its snapshot.
   */
  pinProject: (path) => {
    set((state) => {
      if (isProjectPinned(state.pinnedProjects, path)) return {};
      // Appended, not prepended: a new pin lands at the end of 「已固定」 so the
      // rows already there do not shift under the author's cursor (设计稿 15
      // 屏 1b: the row slides to the section's last place).
      const pinnedProjects = [...state.pinnedProjects, path];
      writePrefMerged(PINNED_PROJECTS_KEY, JSON.stringify(pinnedProjects), mergePinnedProjects);
      if (!state.pinHintDone) writePref(PIN_HINT_KEY, "1");
      return { pinnedProjects, pinHintDone: true };
    });
  },

  /**
   * Release a pin. Overwritten rather than merged, exactly like
   * `removeRecentProject`: a merge would hand the pin straight back from the
   * other instance's copy.
   *
   * Dropping the pin puts the entry back under the cap, so the list can now
   * be over it — re-cap here rather than waiting for the next open, or the
   * eleventh unpinned project would sit there until something else evicted it.
   */
  unpinProject: (path) => {
    set((state) => {
      if (!isProjectPinned(state.pinnedProjects, path)) return {};
      const pinnedProjects = state.pinnedProjects.filter((p) => !isSamePath(p, path));
      writePref(PINNED_PROJECTS_KEY, JSON.stringify(pinnedProjects));
      const recentProjects = capRecentProjects(state.recentProjects, pinnedProjects);
      if (recentProjects.length !== state.recentProjects.length) {
        writePrefMerged(RECENT_PROJECTS_KEY, JSON.stringify(recentProjects), (db, ours) =>
          mergeRecentProjects(db, ours, pinnedProjects));
      }
      return { pinnedProjects, recentProjects };
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
      const next = state.recentProjects.filter((p) => !isSamePath(p, path));
      writePref(RECENT_PROJECTS_KEY, JSON.stringify(next));
      // ✕ means "forget this project", so it releases the pin too. Leaving it
      // would keep the row on screen — the pinned group is drawn from the pin
      // row, not from the recents (see lib/recentProjects → splitProjects).
      const pinnedProjects = state.pinnedProjects.filter((p) => !isSamePath(p, path));
      if (pinnedProjects.length !== state.pinnedProjects.length) {
        writePref(PINNED_PROJECTS_KEY, JSON.stringify(pinnedProjects));
      }
      prunePrefsWithPrefix(PINNED_LORE_PREFIX, (p) => !isSamePath(p, path));
      prunePrefsWithPrefix(LORE_SCOPE_PREFIX, (p) => !isSamePath(p, path));
      const projectOpenedAt = pruneOpenedAt(state.projectOpenedAt, [...next, ...pinnedProjects]);
      writePref(OPENED_AT_KEY, JSON.stringify(projectOpenedAt));
      return { recentProjects: next, pinnedProjects, projectOpenedAt };
    });
  },

  // 清空 keeps the pinned projects — that is what the pin is for. The pin row
  // itself is untouched; only the unpinned recents go.
  clearRecentProjects: () => {
    const state = get();
    const previous = state.recentProjects;
    const next = previous.filter((p) => isProjectPinned(state.pinnedProjects, p));
    if (next.length === previous.length) return [];
    if (next.length === 0) deletePref(RECENT_PROJECTS_KEY);
    else writePref(RECENT_PROJECTS_KEY, JSON.stringify(next));
    set({ recentProjects: next });
    return previous;
  },

  restoreRecentProjects: (previous) => {
    set((state) => {
      const pinned = state.pinnedProjects;
      const recentProjects = capRecentProjects(previous, pinned);
      writePrefMerged(RECENT_PROJECTS_KEY, JSON.stringify(recentProjects), (db, ours) =>
        mergeRecentProjects(db, ours, pinned));
      return { recentProjects };
    });
  },

  collectUnlistedProjectPrefs: () => {
    const { recentProjects, pinnedProjects, projectOpenedAt } = get();
    const listed = [...recentProjects, ...pinnedProjects];
    const keep = (p: string) => listed.some((q) => isSamePath(q, p));
    prunePrefsWithPrefix(PINNED_LORE_PREFIX, keep);
    prunePrefsWithPrefix(LORE_SCOPE_PREFIX, keep);
    const next = pruneOpenedAt(projectOpenedAt, listed);
    if (Object.keys(next).length === Object.keys(projectOpenedAt).length) return;
    writePref(OPENED_AT_KEY, JSON.stringify(next));
    set({ projectOpenedAt: next });
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

  setMainView: (v) => set({ mainView: v }),

  showScreen: (screen) => {
    const s = get();
    // The palette is modal — whatever it was asked to find, the answer was
    // "go here", and leaving it up would cover the screen it just reached.
    // The AI drawer is a companion panel, not a modal: it stays.
    if (s.showCommandPalette) s.setShowCommandPalette(false);
    if (screen === "settings") {
      s.openSettings();
      return;
    }
    if (s.showSettings) s.closeSettings();
    if (screen === "knowledge") {
      s.setMainView("lore-wall");
      return;
    }
    if (screen === "library") {
      // Same gate the rail applies: without the ordered spine there is no
      // library to show, and `useMainView` would bounce it back to the editor
      // anyway — leaving a stored view no rail icon is lit for.
      if (!docModel().ordered) return;
      s.setMainView("library");
      return;
    }
    // files / outline: sidebar panels, so the workbench has to be showing and
    // the sidebar unfolded for the switch to be visible at all.
    s.setMainView("editor");
    s.setActiveSideTab(screen);
    s.setSidebarCollapsed(false);
  },
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
