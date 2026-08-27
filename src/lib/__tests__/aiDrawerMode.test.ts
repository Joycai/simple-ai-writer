/**
 * The AI drawer's tab memory (appStore.setShowAiDrawer + `app:aiDrawerMode`).
 *
 * ⌘J and the two panel buttons open the drawer *without naming a tab*, which
 * is the whole mechanism behind "come back on the one I was last using" — so
 * these assert both halves: naming a tab records it, and omitting one keeps
 * whatever was recorded (and does not quietly re-record it).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// appStore is browser code: it reads preferences and stamps `<html>` at import
// time. Same minimal stand-ins screenShortcuts.test.ts installs — and prefs
// itself falls back to this localStorage while unhydrated, so the pref writes
// this file asserts on land in it for real rather than through a mock.
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

import { useAppStore, type AiDrawerMode } from "../../stores/appStore";

const MODE_KEY = "app:aiDrawerMode";
const open = (mode?: AiDrawerMode) => useAppStore.getState().setShowAiDrawer(true, mode);
const close = () => useAppStore.getState().setShowAiDrawer(false);
const state = () => useAppStore.getState();
const storedMode = () => localStorage.getItem(MODE_KEY);

beforeEach(() => {
  localStorage.removeItem(MODE_KEY);
  useAppStore.setState({ showAiDrawer: false, aiDrawerMode: "generate" });
});

describe("setShowAiDrawer", () => {
  it("remembers the tab a mode-specific opener names", () => {
    open("consistency");
    expect(state().aiDrawerMode).toBe("consistency");
    expect(storedMode()).toBe("consistency");
  });

  it("comes back on the last tab when the opener names none — ⌘J's whole point", () => {
    open("chat");
    close();
    open();
    expect(state().showAiDrawer).toBe(true);
    expect(state().aiDrawerMode).toBe("chat");
  });

  it("survives a chain of mode-less opens rather than drifting back to the first tab", () => {
    open("roleplay");
    for (let i = 0; i < 3; i++) {
      close();
      open();
    }
    expect(state().aiDrawerMode).toBe("roleplay");
  });

  it("does not re-record the pref when the mode did not change", () => {
    open("chat");
    localStorage.removeItem(MODE_KEY);
    open("chat");
    expect(storedMode()).toBe(null);
  });

  it("closing leaves the tab where it was, so reopening lands there", () => {
    open("consistency");
    close();
    expect(state().aiDrawerMode).toBe("consistency");
  });
});
