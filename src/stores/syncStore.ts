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
  probeHealth,
  type RemoteKb,
  type RemoteSyncRecord,
  type SyncClient,
} from "../lib/sync/client";
import {
  getServerUrl,
  loadToken,
  normalizeServerUrl,
  saveToken,
  setServerUrl,
} from "../lib/sync/config";
import { deviceLabel, localEntryHashes } from "../lib/sync/local";
import type {
  EntryPath,
  HashMap,
  SyncAction,
  SyncBinding,
  SyncDecision,
  SyncDirection,
  SyncPlan,
} from "../lib/sync/model";
import { actionableSteps, planSync, withDecisions } from "../lib/sync/plan";
import { compareFreshness, type Freshness } from "../lib/sync/status";
import { runSync, type SyncRunResult } from "../lib/sync/run";
import { clearBinding, loadBinding, saveBinding } from "../lib/sync/store";
import { useLoreStore } from "./loreStore";
import { readPref, writePref } from "../lib/prefs";

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** Which surface the preview flow is showing. `idle` = no modal. */
type SyncPhase = "idle" | "planning" | "preview" | "running" | "done";

interface SyncProgress {
  done: number;
  total: number;
  path: string;
}

interface SyncState {
  serverUrl: string;
  token: string;
  /** This machine's own name (`deviceLabel`), for the 「本机」 tag on records. */
  device: string;
  /** Which project the last hydrate ran for — `ensureReady`'s guard. */
  hydratedFor: string | null;
  connection: ConnectionState;
  /**
   * When this machine last reached the server (ms epoch), persisted as a pref —
   * the offline strip reads 「连不上 · 上次连通 今天 09:12」 after a restart too.
   */
  lastConnectedAt: number | null;
  /** Why the last connect attempt failed; also used for pane-level errors. */
  error: string | null;
  /** Knowledge bases on the server; empty until connected. */
  kbs: RemoteKb[];

  binding: SyncBinding | null;
  /** Entry counts for the binding card. -1 = not known yet. */
  localCount: number;
  remoteCount: number;
  /** Who is newer, from the three-way hash comparison. null = not known
   *  (disconnected, or the manifest could not be fetched). */
  freshness: Freshness | null;
  comparing: boolean;
  comparisonError: string | null;
  /** Recent sync runs from the server's per-base log, newest first — every
   *  machine's, which is what a local record could never show. */
  records: RemoteSyncRecord[];
  /** Local hashing in flight for the comparison (refreshCounts / startPreview).
   *  Hashing reads every byte of every gallery image, so a picture-heavy
   *  knowledge base takes seconds — this is what keeps that from looking like
   *  a hang. null = not hashing. */
  checking: SyncProgress | null;

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
  /**
   * The wall widget's entry point: hydrate once per project, quietly connect
   * when a binding and a saved token exist, refresh the comparison. Unlike
   * `hydrate` it never knocks a live connection back to "disconnected".
   */
  ensureReady: (projectPath: string) => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => void;
  createKb: (name: string) => Promise<RemoteKb | null>;
  bind: (projectPath: string, kb: RemoteKb) => Promise<void>;
  unbind: (projectPath: string) => Promise<void>;
  refreshCounts: (projectPath: string) => Promise<void>;

  startPreview: (projectPath: string, direction: SyncDirection) => Promise<void>;
  /** Turn the named steps on or off in the plan on screen. */
  setDecision: (paths: readonly EntryPath[], decision: SyncDecision) => void;
  setAcknowledged: (on: boolean) => void;
  confirmRun: (projectPath: string) => Promise<void>;
  closeModal: () => void;
  /**
   * The preview modal put away by the author while a run is in flight. Nothing
   * about the run changes; the wall widget keeps showing progress and offers
   * 「查看」 to bring the modal back. Cleared when the run finishes or the modal
   * is really closed.
   */
  modalHidden: boolean;
  hideModal: () => void;
  showModal: () => void;
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

/** Invalidate results whenever the project, binding, or connection changes.
 * Coalesce callers only within that context; a new context must not be dropped
 * just because the previous project's hashing is still in flight. */
let comparisonEpoch = 0;
let comparisonFlight: { epoch: number; promise: Promise<void> } | null = null;
let hydrationEpoch = 0;
let connectionEpoch = 0;

const emptyComparison = {
  freshness: null,
  comparing: false,
  comparisonError: null,
  checking: null,
  localCount: -1,
  remoteCount: -1,
  records: [],
};

export const useSyncStore = create<SyncState>((set, get) => ({
  serverUrl: "",
  token: "",
  device: "",
  hydratedFor: null,
  connection: "disconnected",
  lastConnectedAt: readLastConnectedAt(),
  error: null,
  kbs: [],
  binding: null,
  localCount: -1,
  remoteCount: -1,
  freshness: null,
  comparing: false,
  comparisonError: null,
  records: [],
  checking: null,
  phase: "idle",
  modalHidden: false,
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
   *
   * It does, however, respect a connection that already exists: the module's
   * `client` outlives any one surface, and re-opening settings while the wall
   * widget is happily synced must not repaint everything as disconnected.
   */
  hydrate: async (projectPath) => {
    const hydration = ++hydrationEpoch;
    comparisonEpoch++;
    set({ hydratedFor: null, binding: null, ...emptyComparison });
    const serverUrl = getServerUrl();
    const binding = projectPath ? await loadBinding(projectPath) : null;
    let token = "";
    if (serverUrl) {
      try {
        token = (await loadToken(serverUrl)) ?? "";
      } catch (e) {
        // A locked keyring is worth saying out loud: it looks exactly like
        // "no token saved" and would otherwise read as a forgotten setup.
        if (hydration === hydrationEpoch) set({ error: e instanceof Error ? e.message : String(e) });
      }
    }
    let device = get().device;
    try {
      device = await deviceLabel();
    } catch {
      // Purely the 「本机」 tag on record rows; an unnamed machine loses nothing.
    }
    if (hydration !== hydrationEpoch) return;
    const alive = client !== null;
    set({
      serverUrl,
      token,
      device,
      binding,
      // The empty string ("no project") is a real hydrated state, not null:
      // the pane's cold-start effect keys on "has hydrate run at all".
      hydratedFor: projectPath,
      connection: alive ? "connected" : get().connection === "connecting" ? "connecting" : "disconnected",
      kbs: alive ? get().kbs : [],
      freshness: null,
      records: [],
    });
    if (binding) await get().refreshCounts(projectPath);
  },

  ensureReady: async (projectPath) => {
    if (get().hydratedFor !== projectPath) await get().hydrate(projectPath);
    if (get().hydratedFor !== projectPath) return;
    const { binding, token, connection } = get();
    if (!binding) return;
    const wantsConnect = connection === "disconnected" && Boolean(token);
    if (!wantsConnect && connection !== "connected") return;
    // Fast liveness gate for this automatic path only: a dead server becomes
    // one bounded /health probe instead of a full API call riding into the
    // OS's TCP timeout — and nothing downstream (hashing the whole local
    // tree included) runs at all. The manual 连接 button deliberately skips
    // this and makes the real attempt, whose error can tell a bad token
    // from a dead server.
    const epoch = comparisonEpoch;
    const healthy = await probeHealth(get().serverUrl);
    if (epoch !== comparisonEpoch) return;
    if (!healthy) {
      comparisonEpoch++;
      client = null;
      set({ connection: "error", error: "服务器无响应（/health 超时或不可达）", kbs: [], ...emptyComparison });
      return;
    }
    if (wantsConnect) {
      // Quiet by design: the author bound this project to this server, so a
      // bound project reaching for its server is expected — the rule that
      // opening *settings* must not dial out (see hydrate) is about surfaces
      // that merely display configuration. A failure lands in `connection:
      // "error"` and the widget shows 连不上 with a manual 重连.
      await get().connect();
    } else {
      await get().refreshCounts(projectPath);
    }
  },

  connect: async () => {
    const url = normalizeServerUrl(get().serverUrl);
    const token = get().token.trim();
    if (!url) {
      set({ error: "请先填写服务器地址", connection: "error" });
      return;
    }
    const attempt = ++connectionEpoch;
    comparisonEpoch++;
    client = null;
    set({ connection: "connecting", error: null, ...emptyComparison });
    try {
      const next = createSyncClient(url, token, await deviceLabel());
      const kbs = await next.listKbs();
      if (attempt !== connectionEpoch) return;
      setServerUrl(url);
      await saveToken(url, token);
      if (attempt !== connectionEpoch) return;
      client = next;
      const now = Date.now();
      writePref("app:kbLastConnectedAt", String(now));
      set({ connection: "connected", kbs, serverUrl: url, lastConnectedAt: now });
      const projectPath = get().hydratedFor;
      if (projectPath && get().binding) await get().refreshCounts(projectPath);
    } catch (e) {
      if (attempt !== connectionEpoch) return;
      client = null;
      set({ connection: "error", error: e instanceof Error ? e.message : String(e), kbs: [] });
    }
  },

  disconnect: () => {
    connectionEpoch++;
    comparisonEpoch++;
    client = null;
    set({ connection: "disconnected", kbs: [], error: null, ...emptyComparison });
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
    hydrationEpoch++;
    comparisonEpoch++;
    set({ binding, hydratedFor: projectPath, ...emptyComparison });
    await get().refreshCounts(projectPath);
  },

  unbind: async (projectPath) => {
    await clearBinding(projectPath);
    hydrationEpoch++;
    comparisonEpoch++;
    set({ binding: null, ...emptyComparison });
  },

  refreshCounts: async (projectPath) => {
    const { binding, hydratedFor } = get();
    const activeClient = client;
    if (!binding || !activeClient || hydratedFor !== projectPath) return;
    const epoch = comparisonEpoch;
    if (comparisonFlight?.epoch === epoch) return comparisonFlight.promise;
    const current = () => comparisonEpoch === epoch && client === activeClient;
    set({ comparing: true, comparisonError: null, freshness: null, checking: null, localCount: -1, remoteCount: -1 });
    const promise = (async () => {
      try {
        const manifest = await activeClient.manifest(binding.kbId);
        if (!current()) return;
        set({ remoteCount: manifest.entries.length, checking: { done: 0, total: 0, path: "" } });
        const local = await localEntryHashes(projectPath, undefined, (p) => {
          if (current()) set({ checking: p });
        });
        if (!current()) return;
        set({
          localCount: Object.keys(local).length,
          binding: { ...binding, kbName: manifest.kb.name },
          freshness: compareFreshness(local, manifestHashes(manifest), binding.snapshot),
          comparing: false,
          checking: null,
        });
        // History is optional: an older server may not implement this endpoint.
        try {
          const records = await activeClient.listSyncs(binding.kbId);
          if (current()) set({ records });
        } catch {
          // Keep the comparison even if history is unavailable.
        }
      } catch (e) {
        if (current()) {
          set({
            freshness: null,
            comparisonError: e instanceof Error ? e.message : String(e),
          });
        }
      } finally {
        if (current()) set({ comparing: false, checking: null });
        if (comparisonFlight?.epoch === epoch) comparisonFlight = null;
      }
    })();
    comparisonFlight = { epoch, promise };
    await promise;
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
        localEntryHashes(projectPath, undefined, (p) => set({ checking: p })),
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
    } finally {
      set({ checking: null });
    }
  },

  /**
   * Skip or re-enable steps.
   *
   * Re-summarising is `withDecisions`' job, which matters for more than the
   * counters: the acknowledgement gate is derived from the plan, so skipping
   * every two-sided conflict genuinely clears it — the author is no longer
   * confirming a loss, because the loss is no longer in the run. The tick
   * itself is cleared alongside so a re-enabled conflict has to be accepted
   * again rather than inheriting a nod given to a different plan.
   */
  setDecision: (paths, decision) => {
    const { plan } = get();
    if (!plan) return;
    set({ plan: withDecisions(plan, paths, decision), acknowledged: false });
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
    // Every step skipped is not a sync — and for a pull it would still zip the
    // whole tree "before" writing nothing. The button is disabled in that state;
    // this is the guard for the paths that do not go through the button.
    if (actionableSteps(plan).length === 0) return;
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
      // A run the author had put away comes back with its result: the backup
      // location and the failures are shown nowhere else.
      comparisonEpoch++;
      set({ phase: "done", result, binding: result.binding, progress: null, modalHidden: false });
      // Report the run to the server's per-base sync log — the record another
      // machine will read to learn this one synced. Best-effort: the sync
      // itself already landed, and an older server without the endpoint
      // answers 404; neither is worth an error over a history line.
      if (result.succeeded.length > 0) {
        const done = new Set(result.succeeded);
        const ran = actionableSteps(plan).filter((s) => done.has(s.path));
        const count = (action: SyncAction) => ran.filter((s) => s.action === action).length;
        try {
          await requireClient().reportSync(binding.kbId, {
            direction: plan.direction,
            created: count("create"),
            replaced: count("overwrite"),
            deleted: count("delete"),
          });
        } catch {
          // Recorded nowhere, shown nowhere — the next completed run reports again.
        }
      }
      // The lore tree may have changed under the app — a pull rewrites entity
      // folders the index was built from, so it has to be rebuilt before any
      // surface reads it again.
      if (plan.direction === "pull") await useLoreStore.getState().scanProject(projectPath);
      await get().refreshCounts(projectPath);
    } catch (e) {
      set({ phase: "preview", error: e instanceof Error ? e.message : String(e), progress: null });
    }
  },

  closeModal: () =>
    set({ phase: "idle", plan: null, result: null, progress: null, acknowledged: false, modalHidden: false }),
  hideModal: () => set({ modalHidden: true }),
  showModal: () => set({ modalHidden: false }),
}));

function readLastConnectedAt(): number | null {
  const raw = readPref("app:kbLastConnectedAt");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
