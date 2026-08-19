/**
 * 系统通知 — the OS-level ping for the two moments an author is likely to be
 * looking at another window: the run stopped and is waiting for an approval,
 * and the run finished.
 *
 * ## Why this is a module, not a store
 *
 * Same shape as `lib/ai/apiLog`'s and `lib/pptx/flag`'s switches: read from the
 * settings pane and from three stores, none of them React, so a Zustand store
 * would buy nothing and cost every caller a subscription.
 *
 * ## The three gates, in order
 *
 * 1. **The switch** (`app:notifyEnabled`, default off). Opt-in because the
 *    first notification is what registers the app with macOS's Notification
 *    Center — flipping the switch is the moment the author asked for that.
 * 2. **The kind** (`app:notifyApproval` / `app:notifyDone`, default on). An
 *    author who only wants to be summoned for approvals can drop the rest.
 * 3. **Focus.** A notification for something already on screen is noise, so a
 *    focused window is silence. `isFocused()` failing counts as focused: the
 *    failure mode of a notification framework should be quiet, not chatty.
 *
 * Plus a per-kind minimum interval, because a run that proposes six edits in a
 * row needs to summon the author once, not six times. `sendTestNotification`
 * bypasses all of it — it is the author asking "does this work on my machine",
 * and it throws rather than swallowing, so the pane can show why not.
 *
 * ## What a notification says
 *
 * Which surface, and what happened — never the model's text or the document's.
 * These land on a lock screen and in Notification Center history; the app's own
 * panels are where content belongs.
 *
 * ## Platform notes (the ones that will look like bugs)
 *
 * Permission is a mobile concept here: the desktop plugin answers `Granted` to
 * both `isPermissionGranted` and `requestPermission` unconditionally. The real
 * authorization is the OS's — macOS registers the app in 系统设置 → 通知 the
 * first time a bundled build posts one, and Windows needs the app *installed*.
 * Under `tauri dev` the plugin posts as `com.apple.Terminal` on macOS and with
 * no AppUserModelID on Windows, so a dev-mode notification wears the terminal's
 * name and icon. That is the plugin's own doing, not a misconfiguration here.
 */

import { readPref, writePref } from "./prefs";

/** The two moments worth interrupting for. */
export type NotifyKind = "approval" | "done";

const KEY_ENABLED = "app:notifyEnabled";
const KIND_KEY: Record<NotifyKind, string> = {
  approval: "app:notifyApproval",
  done: "app:notifyDone",
};

/**
 * Coalescing window per kind. Approvals arrive in bursts (one card per
 * proposed edit) and one ping is enough to bring the author back; a finished
 * run is a single event, so it never needs holding back.
 */
const MIN_INTERVAL_MS: Record<NotifyKind, number> = {
  approval: 8000,
  done: 0,
};

const lastSentAt = new Map<NotifyKind, number>();

/**
 * How many drivers are currently speaking for their sub-runs.
 *
 * The clause batch runs `aiTaskStore.runTask` once per clause and announces the
 * whole job itself; without this, a 40-clause tender would arrive as 40 "task
 * finished" notifications. Counted rather than a boolean so an early return or
 * a nested driver can never leave it stuck on, and scoped to "done" only —
 * a batch that stops for an approval still has to summon the author.
 */
let doneMuteDepth = 0;

/** Mutes "run finished" until the returned function is called. Idempotent. */
export function muteRunFinished(): () => void {
  doneMuteDepth++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    doneMuteDepth--;
  };
}

/** True while some driver is speaking for its sub-runs. */
export function runFinishedMuted(): boolean {
  return doneMuteDepth > 0;
}

// ─── The switches ────────────────────────────────────────────────────────────

export function isNotifyEnabled(): boolean {
  return readPref(KEY_ENABLED) === "1";
}

export function setNotifyEnabled(enabled: boolean): void {
  writePref(KEY_ENABLED, enabled ? "1" : "0");
}

/** Per-kind switch. Defaults to on: the master switch is the opt-in. */
export function isNotifyKindEnabled(kind: NotifyKind): boolean {
  return readPref(KIND_KEY[kind]) !== "0";
}

export function setNotifyKindEnabled(kind: NotifyKind, enabled: boolean): void {
  writePref(KIND_KEY[kind], enabled ? "1" : "0");
}

// ─── The decision, as a pure function ────────────────────────────────────────

export interface NotifyGate {
  enabled: boolean;
  kindEnabled: boolean;
  /** The app window has focus — i.e. the author is already looking at it. */
  focused: boolean;
  /** When this kind last went out, or null if never. */
  lastAt: number | null;
  now: number;
  minIntervalMs: number;
}

/**
 * All three gates plus the coalescing window, with no I/O in sight — this is
 * the part worth testing, and the async caller below is the part that isn't.
 */
export function shouldNotify(g: NotifyGate): boolean {
  if (!g.enabled || !g.kindEnabled) return false;
  if (g.focused) return false;
  if (g.lastAt !== null && g.now - g.lastAt < g.minIntervalMs) return false;
  return true;
}

// ─── The plumbing ────────────────────────────────────────────────────────────

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Foreground check. Anything that goes wrong reads as "focused" so the caller
 * stays silent — see the module note above.
 */
async function windowFocused(): Promise<boolean> {
  if (!isTauri) return true;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return await getCurrentWindow().isFocused();
  } catch {
    return true;
  }
}

/**
 * Notification bodies are a one-or-two-line medium and every OS truncates them
 * somewhere; a model error can be a page of JSON. Clipped here rather than at
 * each call site so no caller has to remember.
 */
const BODY_MAX = 180;

function clip(text: string): string {
  return text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1)}…` : text;
}

/** Posts one notification. Throws — `notify` swallows, the test button doesn't. */
async function post(title: string, body: string): Promise<void> {
  const { isPermissionGranted, requestPermission, sendNotification } = await import(
    "@tauri-apps/plugin-notification"
  );
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (!granted) throw new Error("notification-permission-denied");
  sendNotification({ title, body });
}

/**
 * Fire-and-forget: every caller is a store on a hot path, and a notification
 * that cannot be delivered must never take a run down with it.
 */
export function notify(kind: NotifyKind, title: string, body: string): void {
  if (!isTauri) return;
  if (kind === "done" && runFinishedMuted()) return;
  const enabled = isNotifyEnabled();
  const kindEnabled = isNotifyKindEnabled(kind);
  if (!enabled || !kindEnabled) return;
  void (async () => {
    try {
      const gate: NotifyGate = {
        enabled,
        kindEnabled,
        // Asked only after the cheap switches passed — it is an IPC round trip.
        focused: await windowFocused(),
        lastAt: lastSentAt.get(kind) ?? null,
        now: Date.now(),
        minIntervalMs: MIN_INTERVAL_MS[kind],
      };
      if (!shouldNotify(gate)) return;
      lastSentAt.set(kind, gate.now);
      await post(title, clip(body));
    } catch {
      // A failed notification is not worth surfacing mid-run; the settings
      // pane's test button is where a broken setup is meant to show itself.
    }
  })();
}

/**
 * The settings pane's "send a test one". Skips every gate — the author is
 * looking at the window by definition — and reports failure by throwing.
 */
export async function sendTestNotification(title: string, body: string): Promise<void> {
  await post(title, body);
}

/**
 * Ask for permission at the moment the author flips the switch on. A no-op on
 * desktop (the plugin answers Granted), kept because it is the API's contract
 * and the one call site where an OS prompt would belong.
 */
export async function requestNotifyPermission(): Promise<boolean> {
  if (!isTauri) return false;
  try {
    const { isPermissionGranted, requestPermission } = await import(
      "@tauri-apps/plugin-notification"
    );
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch {
    return false;
  }
}
