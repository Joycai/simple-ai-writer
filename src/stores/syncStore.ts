/**
 * Knowledge-base sync: connection, binding, and the plan→run lifecycle.
 *
 * Everything decision-shaped already lives in `lib/sync` (the three-way plan,
 * the client, the executor). This store is the sequencing around it — which of
 * the settings pane's three states to show, and which phase of the preview
 * modal is on screen.
 *
 * One rule shapes the whole thing: **a direction is never executed without a
 * plan the author has seen.** `startPreview` computes; `confirmRun` executes
 * the plan already on screen and nothing else. There is deliberately no
 * "sync now" that does both — a one-way mirror the author did not preview is
 * the failure this feature exists to prevent (docs §14.2).
 */

import { create } from "zustand";
import {
  createSyncClient,
  manifestHashes,
  type RemoteKb,
  type SyncClient,
} from "../lib/sync/client";
import {
  getServerUrl,
  loadToken,
  normalizeServerUrl,
  saveToken,
  setServerUrl,
} from "../lib/sync/config";
import { localEntryHashes } from "../lib/sync/local";
import type { HashMap, SyncBinding, SyncDirection, SyncPlan } from "../lib/sync/model";
import { planSync } from "../lib/sync/plan";
import { runSync, type SyncRunResult } from "../lib/sync/run";
import { clearBinding, loadBinding, saveBinding } from "../lib/sync/store";
import { useLoreStore } from "./loreStore";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** Which surface the preview flow is showing. `idle` = no modal. */
export type SyncPhase = "idle" | "planning" | "preview" | "running" | "done";

export interface SyncProgress {
  done: number;
  total: number;
  path: string;
}

interface SyncState {
  serverUrl: string;
  token: string;
  connection: ConnectionState;
  /** Why the last connect attempt failed; also used for pane-level errors. */
  error: string | null;
  /** Knowledge bases on the server; empty until connected. */
  kbs: RemoteKb[];

  binding: SyncBinding | null;
  /** Entry counts for the binding card. -1 = not known yet. */
  localCount: number;
  remoteCount: number;

  phase: SyncPhase;
  direction: SyncDirection;
  plan: SyncPlan | null;
  /** Hashes the plan was computed from — reused when the run executes it. */
  planLocal: HashMap;
  planRemote: HashMap;
  progress: SyncProgress | null;
  result: SyncRunResult | null;
  /** Whether the author ticked the "I understand" box on a risky plan. */
  acknowledged: boolean;
  busy: boolean;

  setServerUrlDraft: (url: string) => void;
  setTokenDraft: (token: string) => void;
  hydrate: (projectPath: string) => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => void;
  createKb: (name: string) => Promise<RemoteKb | null>;
  bind: (projectPath: string, kb: RemoteKb) => Promise<void>;
  unbind: (projectPath: string) => Promise<void>;
  refreshCounts: (projectPath: string) => Promise<void>;

  startPreview: (projectPath: string, direction: SyncDirection) => Promise<void>;
  setAcknowledged: (on: boolean) => void;
  confirmRun: (projectPath: string) => Promise<void>;
  closeModal: () => void;
}

/**
 * The connected client. Module-level rather than in the store because it holds
 * the token: keeping a bearer secret out of zustand state means it cannot end
 * up in a devtools dump or a serialised snapshot of the store.
 */
let client: SyncClient | null = null;

function requireClient(): SyncClient {
  if (!client) throw new Error("not connected to a sync server");
  return client;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  serverUrl: "",
  token: "",
  connection: "disconnected",
  error: null,
  kbs: [],
  binding: null,
  localCount: -1,
  remoteCount: -1,
  phase: "idle",
  direction: "push",
  plan: null,
  planLocal: {},
  planRemote: {},
  progress: null,
  result: null,
  acknowledged: false,
  busy: false,

  setServerUrlDraft: (url) => set({ serverUrl: url, error: null }),
  setTokenDraft: (token) => set({ token, error: null }),

  /**
   * Load what is already known for this project: the saved address, its token,
   * and the binding. Deliberately does NOT connect — opening settings should
   * not reach out to a server on its own, and an unreachable one would make
   * the pane look broken rather than merely disconnected.
   */
  hydrate: async (projectPath) => {
    const serverUrl = getServerUrl();
    const binding = await loadBinding(projectPath);
    let token = "";
    if (serverUrl) {
      try {
        token = (await loadToken(serverUrl)) ?? "";
      } catch (e) {
        // A locked keyring is worth saying out loud: it looks exactly like
        // "no token saved" and would otherwise read as a forgotten setup.
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    }
    set({ serverUrl, token, binding, connection: "disconnected", kbs: [] });
    if (binding) await get().refreshCounts(projectPath);
  },

  connect: async () => {
    const url = normalizeServerUrl(get().serverUrl);
    const token = get().token.trim();
    if (!url) {
      set({ error: "请先填写服务器地址", connection: "error" });
      return;
    }
    set({ connection: "connecting", error: null });
    try {
      const next = createSyncClient(url, token);
      const kbs = await next.listKbs();
      client = next;
      setServerUrl(url);
      await saveToken(url, token);
      set({ connection: "connected", kbs, serverUrl: url });
    } catch (e) {
      client = null;
      set({ connection: "error", error: e instanceof Error ? e.message : String(e), kbs: [] });
    }
  },

  disconnect: () => {
    client = null;
    set({ connection: "disconnected", kbs: [], error: null });
  },

  createKb: async (name) => {
    set({ busy: true, error: null });
    try {
      const kb = await requireClient().createKb(name);
      set((s) => ({ kbs: [...s.kbs, kb] }));
      return kb;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    } finally {
      set({ busy: false });
    }
  },

  /**
   * Bind this project to a knowledge base.
   *
   * Nothing is transferred: binding only records the correspondence, so the
   * author's first sync still goes through a preview like every other one.
   * The snapshot starts empty, which is what makes that first plan report
   * every difference as two-sided — accurate, and explained in the modal.
   */
  bind: async (projectPath, kb) => {
    const binding: SyncBinding = {
      serverUrl: normalizeServerUrl(get().serverUrl),
      kbId: kb.id,
      kbName: kb.name,
      snapshot: {},
      lastSyncAt: null,
    };
    await saveBinding(projectPath, binding);
    set({ binding });
    await get().refreshCounts(projectPath);
  },

  unbind: async (projectPath) => {
    await clearBinding(projectPath);
    set({ binding: null, localCount: -1, remoteCount: -1 });
  },

  refreshCounts: async (projectPath) => {
    const { binding } = get();
    try {
      const local = await localEntryHashes(projectPath);
      set({ localCount: Object.keys(local).length });
    } catch {
      set({ localCount: -1 });
    }
    if (!binding || !client) return;
    try {
      const manifest = await client.manifest(binding.kbId);
      set({ remoteCount: manifest.entries.length, binding: { ...binding, kbName: manifest.kb.name } });
    } catch {
      set({ remoteCount: -1 });
    }
  },

  startPreview: async (projectPath, direction) => {
    const { binding } = get();
    if (!binding) return;
    set({
      phase: "planning",
      direction,
      plan: null,
      result: null,
      progress: null,
      acknowledged: false,
      error: null,
    });
    try {
      const [local, manifest] = await Promise.all([
        localEntryHashes(projectPath),
        requireClient().manifest(binding.kbId),
      ]);
      const remote = manifestHashes(manifest);
      set({
        phase: "preview",
        plan: planSync({ local, remote, snapshot: binding.snapshot, direction }),
        planLocal: local,
        planRemote: remote,
        localCount: Object.keys(local).length,
        remoteCount: manifest.entries.length,
      });
    } catch (e) {
      set({ phase: "idle", error: e instanceof Error ? e.message : String(e) });
    }
  },

  setAcknowledged: (on) => set({ acknowledged: on }),

  /**
   * Execute the plan currently on screen.
   *
   * The plan is passed through unchanged rather than recomputed: recomputing
   * here would execute something the author never saw, which is the same
   * failure as not previewing at all. Drift since the preview is caught by the
   * per-entry preconditions in `lib/sync/run`, and surfaces as the "the server
   * changed after you confirmed" group in the result.
   */
  confirmRun: async (projectPath) => {
    const { binding, plan } = get();
    if (!binding || !plan) return;
    set({ phase: "running", progress: { done: 0, total: 0, path: "" } });
    try {
      const result = await runSync({
        projectPath,
        binding,
        client: requireClient(),
        plan,
        onProgress: (done, total, path) => set({ progress: { done, total, path } }),
      });
      await saveBinding(projectPath, result.binding);
      set({ phase: "done", result, binding: result.binding, progress: null });
      // The lore tree may have changed under the app — a pull rewrites entity
      // folders the index was built from, so it has to be rebuilt before any
      // surface reads it again.
      if (plan.direction === "pull") await useLoreStore.getState().scanProject(projectPath);
      await get().refreshCounts(projectPath);
    } catch (e) {
      set({ phase: "preview", error: e instanceof Error ? e.message : String(e), progress: null });
    }
  },

  closeModal: () => set({ phase: "idle", plan: null, result: null, progress: null, acknowledged: false }),
}));

/** Test seam: drop the connected client between cases. */
export function resetSyncClientForTest(): void {
  client = null;
}
