/**
 * Navigation history — the app's Back / Forward, the way the OS trains people
 * to expect it (⌘[ ⌘] / Alt+←→, and the two side buttons on a mouse).
 *
 * A *location* is the trio the author actually moves between: which main view
 * is showing, which file the editor has open, and which lore entry the wall is
 * detailing. Everything else (drawers, modals, sidebar tabs, scroll position)
 * is chrome, not a place.
 *
 * The history is **recorded by observation, not by interception**: the store
 * subscribes to the three stores that own those fields and notices when the
 * location changed. Every existing navigation path — the file tree, the
 * command palette, library rows, citation clicks, "open in editor" buttons —
 * therefore lands in the history without a single call site knowing this file
 * exists, and one added later can't forget to register itself.
 *
 * The `applying` flag is what separates a *user* navigation from replaying
 * one: zustand notifies subscribers synchronously inside `set`, so a step
 * taken by back()/forward() is fully observed before the flag clears.
 */
import { create } from "zustand";
import { useAppStore } from "./appStore";
import { useProjectStore } from "./projectStore";
import { useLoreStore } from "./loreStore";

export type NavLocation =
  | { kind: "editor"; filePath: string | null }
  | { kind: "lore"; entityDir: string | null }
  | { kind: "library" };

/** Deep enough to cover a session's wandering, bounded so it can't grow forever. */
const MAX_HISTORY = 100;

interface NavState {
  /** Where we are now — the anchor both stacks are relative to. */
  current: NavLocation;
  past: NavLocation[];
  future: NavLocation[];
  back: () => void;
  forward: () => void;
}

function readLocation(): NavLocation {
  // The raw stored view, not useMainView()'s profile-aware fallback: history
  // records what the author did, and the fallback re-applies itself on render.
  const view = useAppStore.getState().mainView;
  if (view === "lore-wall") return { kind: "lore", entityDir: useLoreStore.getState().detailPath };
  if (view === "library") return { kind: "library" };
  return { kind: "editor", filePath: useProjectStore.getState().activeFilePath };
}

function sameLocation(a: NavLocation, b: NavLocation): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "editor" && b.kind === "editor") return a.filePath === b.filePath;
  if (a.kind === "lore" && b.kind === "lore") return a.entityDir === b.entityDir;
  return true;
}

/** True while a location is being restored, so the recorder stays quiet. */
let applying = false;

function applyLocation(loc: NavLocation): void {
  applying = true;
  try {
    const { setMainView } = useAppStore.getState();
    if (loc.kind === "editor") {
      setMainView("editor");
      useProjectStore.getState().setActiveFilePath(loc.filePath);
    } else if (loc.kind === "lore") {
      setMainView("lore-wall");
      // An entry deleted since it was visited simply resolves to the grid.
      useLoreStore.getState().openDetail(loc.entityDir);
    } else {
      setMainView("library");
    }
  } finally {
    applying = false;
  }
}

export const useNavStore = create<NavState>((set, get) => ({
  current: { kind: "editor", filePath: null },
  past: [],
  future: [],

  back: () => {
    const { past, current, future } = get();
    if (past.length === 0) return;
    set({
      past: past.slice(0, -1),
      future: [current, ...future].slice(0, MAX_HISTORY),
    });
    applyLocation(past[past.length - 1]);
  },

  forward: () => {
    const { past, current, future } = get();
    if (future.length === 0) return;
    set({
      past: [...past, current].slice(-MAX_HISTORY),
      future: future.slice(1),
    });
    applyLocation(future[0]);
  },
}));

/**
 * Overlays own their own dismissal (Esc, backdrop click). Stepping the history
 * out from under an open modal would move the page the author can't even see,
 * so the input layer checks this first.
 */
export function navigationBlocked(): boolean {
  const { showSettings, showCommandPalette, showOnboarding } = useAppStore.getState();
  return showSettings || showCommandPalette || showOnboarding;
}

/**
 * Same place, new address — `history.replaceState`, not a navigation. Used
 * when a location's identity changes under the author (moving a lore entry to
 * another category renames its folder), which should update where "here" is
 * without dropping a step into the history.
 */
export function replaceLocation(navigate: () => void): void {
  applying = true;
  try {
    navigate();
  } finally {
    applying = false;
  }
}

export function navBack(): void {
  if (!navigationBlocked()) useNavStore.getState().back();
}

export function navForward(): void {
  if (!navigationBlocked()) useNavStore.getState().forward();
}

/**
 * Start recording, and wire the mouse's back/forward buttons. Called once from
 * App; returns the uninstaller.
 */
export function installNavigationHistory(): () => void {
  useNavStore.setState({ current: readLocation(), past: [], future: [] });
  let lastProjectPath = useProjectStore.getState().projectPath;

  const record = () => {
    const next = readLocation();
    if (applying) {
      // Replaying a step: adopt the location without touching the stacks.
      useNavStore.setState({ current: next });
      return;
    }
    const { current, past } = useNavStore.getState();
    if (sameLocation(current, next)) return;
    useNavStore.setState({
      current: next,
      past: [...past, current].slice(-MAX_HISTORY),
      // A fresh navigation abandons the forward branch, exactly like a browser.
      future: [],
    });
  };

  const onProjectChange = () => {
    const projectPath = useProjectStore.getState().projectPath;
    if (projectPath !== lastProjectPath) {
      // Another project's files aren't places in this one — start over.
      lastProjectPath = projectPath;
      useNavStore.setState({ current: readLocation(), past: [], future: [] });
      return;
    }
    record();
  };

  // Plain (unselected) subscriptions: these stores fire for unrelated fields
  // too, but record() short-circuits on an unchanged location, which is a
  // couple of string compares.
  const unsubs = [
    useAppStore.subscribe(record),
    useLoreStore.subscribe(record),
    useProjectStore.subscribe(onProjectChange),
  ];

  // Mouse buttons 3/4 are the OS's back/forward. preventDefault on the press
  // keeps the webview from trying a page-history navigation of its own.
  const onPointerDown = (e: MouseEvent) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  };
  const onPointerUp = (e: MouseEvent) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    if (e.button === 3) navBack();
    else navForward();
  };
  window.addEventListener("mousedown", onPointerDown);
  window.addEventListener("mouseup", onPointerUp);

  return () => {
    unsubs.forEach((u) => u());
    window.removeEventListener("mousedown", onPointerDown);
    window.removeEventListener("mouseup", onPointerUp);
  };
}
