/**
 * Screen switching (⌘1‥⌘5 → appStore.showScreen) and the registry behind it.
 *
 * The shortcuts are only as good as the destination they land on, so these
 * assert the *state* a switch leaves behind — a sidebar panel that arrives
 * folded, or a settings overlay still covering the view the author asked for,
 * is a shortcut that appears not to work.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// appStore is browser code: it reads preferences and stamps `<html>` at import
// time. Same minimal stand-ins navHistory.test.ts installs.
vi.hoisted(() => {
  const mem = new Map<string, string>();
  const g = globalThis as Record<string, unknown>;
  g.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  };
  const noop = () => {};
  g.window = {
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  };
  g.document = {
    documentElement: { setAttribute: noop, getAttribute: () => null },
    addEventListener: noop,
    removeEventListener: noop,
  };
});

import { useAppStore, type AppScreen } from "../../stores/appStore";
import { matchesCombo, SCREEN_COMBOS, SHORTCUTS, type Combo } from "../shortcuts";

const go = (screen: AppScreen) => useAppStore.getState().showScreen(screen);
const state = () => useAppStore.getState();

/** A keydown the global listener would see for `combo` (Ctrl form). */
function press(combo: Combo): KeyboardEvent {
  return {
    key: combo.key,
    ctrlKey: !!combo.mod,
    metaKey: false,
    shiftKey: !!combo.shift,
    altKey: !!combo.alt,
  } as KeyboardEvent;
}

beforeEach(() => {
  useAppStore.setState({
    mainView: "editor",
    activeSideTab: "files",
    sidebarCollapsed: false,
    showSettings: false,
    showCommandPalette: false,
  });
});

describe("showScreen", () => {
  it("brings the workbench back and unfolds the sidebar on the asked-for panel", () => {
    useAppStore.setState({ mainView: "lore-wall", sidebarCollapsed: true });
    go("outline");
    expect(state().mainView).toBe("editor");
    expect(state().activeSideTab).toBe("outline");
    expect(state().sidebarCollapsed).toBe(false);
  });

  it("does not toggle the panel shut when the author asks for it twice", () => {
    go("files");
    go("files");
    expect(state().activeSideTab).toBe("files");
    expect(state().sidebarCollapsed).toBe(false);
  });

  it("switches the main view for the knowledge base and the library", () => {
    go("knowledge");
    expect(state().mainView).toBe("lore-wall");
    go("library");
    expect(state().mainView).toBe("library");
  });

  it("closes the settings overlay on the way to any other screen", () => {
    for (const screen of ["files", "outline", "knowledge", "library"] as const) {
      useAppStore.setState({ showSettings: true });
      go(screen);
      expect(state().showSettings).toBe(false);
    }
  });

  it("dismisses the command palette, whichever screen it lands on", () => {
    for (const screen of ["files", "knowledge", "library", "settings"] as const) {
      useAppStore.setState({ showCommandPalette: true });
      go(screen);
      expect(state().showCommandPalette).toBe(false);
    }
  });

  it("opens settings — and leaves the view underneath alone", () => {
    useAppStore.setState({ mainView: "lore-wall" });
    go("settings");
    expect(state().showSettings).toBe(true);
    expect(state().mainView).toBe("lore-wall");
  });
});

describe("screen combos", () => {
  it("covers every screen exactly once", () => {
    expect(SCREEN_COMBOS.map((s) => s.screen)).toEqual([
      "files", "outline", "knowledge", "library", "settings",
    ]);
  });

  it("collides with no other registry entry", () => {
    // ⌘5 is settings' second binding, so its registry row carries a keysLabel
    // rather than a combo — every other listed combo must stay clear.
    const listed = SHORTCUTS.map((s) => s.combo).filter((c): c is Combo => !!c);
    for (const { combo } of SCREEN_COMBOS) {
      const e = press(combo);
      const hits = listed.filter((c) => matchesCombo(e, c));
      expect(hits.length, `${combo.key} matched ${hits.length} registry entries`)
        .toBeLessThanOrEqual(1);
    }
  });

  it("is not swallowed by a shifted or alt'd variant", () => {
    // Mod-Alt-1..3 are the editor's heading keys — exact modifier matching is
    // what keeps ⌘1 from firing on them and vice versa.
    const heading = press({ mod: true, alt: true, key: "1" });
    expect(matchesCombo(heading, { mod: true, key: "1" })).toBe(false);
  });
});
