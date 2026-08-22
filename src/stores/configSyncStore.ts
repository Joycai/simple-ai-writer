/**
 * Application-config backup: the slot list, a push, and a previewed restore.
 *
 * Separate from `syncStore` rather than a section of it, for one reason that
 * decides the whole shape: **this needs no open project.** `syncStore` is
 * project-scoped from its first line — `hydrate(projectPath)`, a binding, a
 * three-way plan — while a freshly installed machine with no project yet is
 * exactly when an author most wants their providers back. Merging the two would
 * put a "does this field need a project" question on every field.
 *
 * The connection is *not* duplicated: address and token stay where
 * `lib/sync/config` already keeps them, and `connectedConfigClient()` builds a
 * transport from them per action. What is duplicated would be state, and two
 * copies of "am I connected" is how one of them goes stale.
 *
 * One rule mirrors the knowledge-base side: **a restore is never applied by the
 * button that downloaded it.** `startRestore` stops at a preview; `confirmRestore`
 * merges what is already on screen and nothing else.
 */

import { create } from "zustand";
import {
  connectedConfigClient,
  type ConfigSyncClient,
  type RemoteSlot,
  type RemoteSlotVersion,
} from "../lib/configsync/client";
import { EnvelopeError, decodeMeta, type EnvelopeHeader } from "../lib/configsync/envelope";
import {
  forgetSlotPassword,
  loadSlotPassword,
  rememberSlotPassword,
} from "../lib/configsync/password";
import {
  applyPull,
  preparePull,
  pushConfig,
  pushNeedsPassword,
  readEnvelopeHeader,
  type PreparedPull,
} from "../lib/configsync/run";
import { getServerUrl } from "../lib/sync/config";
import { SyncConflictError } from "../lib/sync/client";
import { listProviders } from "../lib/ai/configDb";
import { getGlobalDb } from "../lib/project";
import { useAppStore } from "./appStore";

/** Where the restore flow is. `idle` = no modal on screen. */
export type RestorePhase = "idle" | "downloading" | "password" | "preview" | "applying" | "done";

export interface RestoreTarget {
  slot: RemoteSlot;
  version: RemoteSlotVersion | null;
  bytes: Uint8Array;
  /** Read without a password — this is what the password prompt can already show. */
  header: EnvelopeHeader;
}

interface ConfigSyncState {
  slots: RemoteSlot[];
  /** Versions for an expanded slot, keyed by slot id. Loaded on demand. */
  versions: Record<string, RemoteSlotVersion[]>;
  loading: boolean;
  busy: boolean;
  error: string | null;
  status: { ok: boolean; text: string } | null;

  /** Push form. */
  includeKeys: boolean;
  password: string;
  remember: boolean;

  /** Restore flow. */
  phase: RestorePhase;
  target: RestoreTarget | null;
  restorePassword: string;
  prepared: PreparedPull | null;

  setIncludeKeys: (on: boolean) => void;
  setPassword: (value: string) => void;
  setRemember: (on: boolean) => void;
  setRestorePassword: (value: string) => void;
  clearStatus: () => void;

  refresh: () => Promise<void>;
  loadVersions: (slotId: string) => Promise<void>;
  createSlot: (name: string) => Promise<RemoteSlot | null>;
  push: (slotId: string) => Promise<void>;
  deleteSlot: (slotId: string) => Promise<void>;

  startRestore: (slotId: string, atMs?: number) => Promise<void>;
  submitRestorePassword: () => Promise<void>;
  confirmRestore: () => Promise<void>;
  closeRestore: () => void;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Provider ids already configured — models in a backup whose provider is
 *  neither here nor in the bundle are dropped rather than left dangling. */
async function existingProviderIds(): Promise<string[]> {
  try {
    return (await listProviders(await getGlobalDb())).map((p) => p.id);
  } catch {
    return [];
  }
}

async function client(): Promise<ConfigSyncClient> {
  const c = await connectedConfigClient();
  if (!c) throw new Error("not connected to a sync server");
  return c;
}

export const useConfigSyncStore = create<ConfigSyncState>((set, get) => ({
  slots: [],
  versions: {},
  loading: false,
  busy: false,
  error: null,
  status: null,

  includeKeys: false,
  password: "",
  remember: false,

  phase: "idle",
  target: null,
  restorePassword: "",
  prepared: null,

  setIncludeKeys: (on) => set({ includeKeys: on, error: null }),
  setPassword: (value) => set({ password: value, error: null }),
  setRemember: (on) => set({ remember: on }),
  setRestorePassword: (value) => set({ restorePassword: value, error: null }),
  clearStatus: () => set({ status: null, error: null }),

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      set({ slots: await (await client()).listSlots() });
    } catch (e) {
      set({ error: message(e), slots: [] });
    } finally {
      set({ loading: false });
    }
  },

  loadVersions: async (slotId) => {
    try {
      const versions = await (await client()).listVersions(slotId);
      set((s) => ({ versions: { ...s.versions, [slotId]: versions } }));
    } catch (e) {
      set({ error: message(e) });
    }
  },

  createSlot: async (name) => {
    set({ busy: true, error: null });
    try {
      const slot = await (await client()).createSlot(name);
      set((s) => ({ slots: [...s.slots, slot] }));
      return slot;
    } catch (e) {
      set({ error: message(e) });
      return null;
    } finally {
      set({ busy: false });
    }
  },

  push: async (slotId) => {
    const { includeKeys, password, remember, slots } = get();
    set({ busy: true, error: null, status: null });
    try {
      if (includeKeys && !password && (await pushNeedsPassword(true))) {
        // Caught here as well as inside `sealBundle`, so the author reads the
        // rule rather than a thrown invariant.
        throw new EnvelopeError(
          "keys-need-password",
          "keys-need-password",
        );
      }
      // The precondition is the hash this listing was drawn from. Another
      // machine having pushed since then produces a 412 the author can act on,
      // instead of that machine's configuration disappearing.
      const known = slots.find((s) => s.id === slotId)?.current;
      const result = await pushConfig(
        await client(),
        slotId,
        { includeKeys, password: password || null },
        known ? { kind: "hash", hash: known.hash } : { kind: "absent" },
      );

      const serverUrl = getServerUrl();
      if (password && remember) await rememberSlotPassword(serverUrl, slotId, password);
      // Unticking "remember" has to actually forget: leaving a stale entry
      // behind would silently unlock a backup the author believes is now only
      // in their head.
      if (!remember) await forgetSlotPassword(serverUrl, slotId);

      set({
        password: "",
        status: {
          ok: true,
          text: `pushed:${result.counts.providers}/${result.counts.models}/${result.counts.prompts}`,
        },
      });
      await get().refresh();
      await get().loadVersions(slotId);
    } catch (e) {
      set({ error: e instanceof SyncConflictError ? "conflict" : errorKey(e) });
    } finally {
      set({ busy: false });
    }
  },

  deleteSlot: async (slotId) => {
    set({ busy: true, error: null });
    try {
      await (await client()).deleteSlot(slotId);
      await forgetSlotPassword(getServerUrl(), slotId);
      set((s) => ({ slots: s.slots.filter((slot) => slot.id !== slotId) }));
    } catch (e) {
      set({ error: message(e) });
    } finally {
      set({ busy: false });
    }
  },

  startRestore: async (slotId, atMs) => {
    const slot = get().slots.find((s) => s.id === slotId);
    if (!slot) return;
    set({ phase: "downloading", target: null, prepared: null, restorePassword: "", error: null });
    try {
      const downloaded = await (await client()).download(slotId, atMs);
      const header = readEnvelopeHeader(downloaded.bytes);
      const version =
        get().versions[slotId]?.find((v) => v.atMs === downloaded.atMs) ?? slot.current ?? null;
      const target: RestoreTarget = { slot, version, bytes: downloaded.bytes, header };
      set({ target });

      if (!header.encrypted) {
        await open(target, null, set);
        return;
      }
      // A password this machine already remembers skips the prompt — but only
      // if it actually opens the envelope. A stale remembered password must
      // land on the prompt, not on a "damaged backup" message.
      const saved = await loadSlotPassword(getServerUrl(), slotId);
      if (saved && (await open(target, saved, set, true))) return;
      set({ phase: "password" });
    } catch (e) {
      set({ phase: "idle", error: errorKey(e), target: null });
    }
  },

  submitRestorePassword: async () => {
    const { target, restorePassword } = get();
    if (!target) return;
    set({ error: null });
    if (!(await open(target, restorePassword, set, true))) {
      set({ error: "bad-password" });
    }
  },

  confirmRestore: async () => {
    const { prepared, target, restorePassword, remember } = get();
    if (!prepared) return;
    set({ phase: "applying", error: null });
    try {
      await applyPull(prepared);
      // Imported preferences are in the store but not yet on screen.
      useAppStore.getState().reloadFromPrefs();
      if (target && restorePassword && remember) {
        await rememberSlotPassword(getServerUrl(), target.slot.id, restorePassword);
      }
      set({ phase: "done" });
    } catch (e) {
      set({ phase: "preview", error: message(e) });
    }
  },

  closeRestore: () =>
    set({ phase: "idle", target: null, prepared: null, restorePassword: "", error: null }),
}));

/**
 * Open an envelope into a preview. Returns false when the password was wrong,
 * so a caller trying a remembered one can fall through to the prompt.
 *
 * Any other failure is fatal to the flow and reported: a corrupted download and
 * a bundle this build cannot read are not things a different password fixes.
 */
async function open(
  target: RestoreTarget,
  password: string | null,
  set: (partial: Partial<ConfigSyncState>) => void,
  tolerateBadPassword = false,
): Promise<boolean> {
  try {
    const prepared = await preparePull(target.bytes, password, await existingProviderIds());
    set({ prepared, phase: "preview", restorePassword: password ?? "" });
    return true;
  } catch (e) {
    if (tolerateBadPassword && e instanceof EnvelopeError && e.code === "bad-password") {
      return false;
    }
    set({ phase: "password", error: errorKey(e) });
    return false;
  }
}

/**
 * An error as something the pane can translate.
 *
 * `EnvelopeError` codes are already the vocabulary the UI needs ("wrong
 * password", "includes keys, needs one"), so they pass through as keys; anything
 * else is a message from a layer that has no translation and is shown verbatim.
 */
function errorKey(e: unknown): string {
  if (e instanceof EnvelopeError) return e.code;
  if (e instanceof SyncConflictError) return "conflict";
  return message(e);
}

/** The envelope header a slot's listing row can show without downloading. */
export function slotHeader(slot: RemoteSlot): EnvelopeHeader | null {
  return decodeMeta(slot.current?.meta ?? null);
}

/** Same, for one version row. */
export function versionHeader(version: RemoteSlotVersion): EnvelopeHeader | null {
  return decodeMeta(version.meta);
}
