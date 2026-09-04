/**
 * 系统通知's decision layer.
 *
 * Everything worth pinning here is a *refusal*: the notification that must not
 * go out when the author is already looking at the window, when the switch is
 * off, or when the same kind fired seconds ago. Delivery itself is the Tauri
 * plugin's job and is not simulated.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  isNotifyEnabled, isNotifyKindEnabled, muteRunFinished, runFinishedMuted,
  setNotifyEnabled, setNotifyKindEnabled, shouldNotify, type NotifyGate,
} from "../notify";

// vitest runs in node, where prefs falls back to localStorage — which node
// does not have either. This is that fallback's store.
const prefStore = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => prefStore.get(k) ?? null,
    setItem: (k: string, v: string) => void prefStore.set(k, String(v)),
    removeItem: (k: string) => void prefStore.delete(k),
    clear: () => prefStore.clear(),
  },
  configurable: true,
});

const open: NotifyGate = {
  enabled: true,
  kindEnabled: true,
  focused: false,
  lastAt: null,
  now: 10_000,
  minIntervalMs: 8000,
};

describe("shouldNotify", () => {
  it("sends when the switch is on, the kind is on and the window is elsewhere", () => {
    expect(shouldNotify(open)).toBe(true);
  });

  it("stays silent while the app window has focus", () => {
    expect(shouldNotify({ ...open, focused: true })).toBe(false);
  });

  it("stays silent with the master switch off, whatever the kind says", () => {
    expect(shouldNotify({ ...open, enabled: false })).toBe(false);
  });

  it("stays silent with the kind switched off", () => {
    expect(shouldNotify({ ...open, kindEnabled: false })).toBe(false);
  });

  it("coalesces a burst: a second one inside the window is dropped", () => {
    expect(shouldNotify({ ...open, lastAt: 5_000 })).toBe(false);
    expect(shouldNotify({ ...open, lastAt: 1_000 })).toBe(true);
  });

  it("never coalesces when the kind has no interval", () => {
    expect(shouldNotify({ ...open, lastAt: 9_999, minIntervalMs: 0 })).toBe(true);
  });
});

describe("switches", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to off — the first notification is what registers the app", () => {
    expect(isNotifyEnabled()).toBe(false);
  });

  it("defaults each kind to on, since the master switch is the opt-in", () => {
    expect(isNotifyKindEnabled("approval")).toBe(true);
    expect(isNotifyKindEnabled("done")).toBe(true);
    expect(isNotifyKindEnabled("error")).toBe(true);
  });

  it("round-trips both levels, one kind at a time", () => {
    setNotifyEnabled(true);
    setNotifyKindEnabled("done", false);
    expect(isNotifyEnabled()).toBe(true);
    expect(isNotifyKindEnabled("done")).toBe(false);
    // A failure is its own switch: dropping "finished" must not silence it.
    expect(isNotifyKindEnabled("error")).toBe(true);
    expect(isNotifyKindEnabled("approval")).toBe(true);
  });
});

describe("muteRunFinished", () => {
  it("holds until every driver has released, and releases only once each", () => {
    const outer = muteRunFinished();
    const inner = muteRunFinished();
    expect(runFinishedMuted()).toBe(true);
    inner();
    inner();
    inner();
    // Still held: the extra calls must not have cancelled the outer hold —
    // that is the bug the idempotence exists to prevent.
    expect(runFinishedMuted()).toBe(true);
    outer();
    expect(runFinishedMuted()).toBe(false);
  });
});
