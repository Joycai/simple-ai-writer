/**
 * Knowledge-base sync: the shared vocabulary.
 *
 * A project can be **bound** to one named knowledge base on a backup server
 * (`server/`, see `docs/remote-knowledge-base-feasibility.md` §13–§18). Syncing
 * is one-directional and whole-tree: push the local `.ai-writer/lore/` up, or
 * pull the remote down. There is no merge — the author picks a direction and
 * the other side becomes a mirror of it.
 *
 * Which is exactly why every operation goes through a *plan* first (`./plan`).
 * A mirror in the wrong direction destroys work, and the only thing standing
 * between the author and that is being shown, per entry, what is about to
 * happen and which of those steps discards something.
 */

/** An entry's identity on both sides: `<category>/<entity id>`. */
export type EntryPath = string;

/** Content hashes keyed by `EntryPath`. */
export type HashMap = Readonly<Record<EntryPath, string>>;

/**
 * What this project syncs to. Persisted as `.ai-writer/sync.json` — a **project**
 * property, so it travels with the project folder, exactly like `profile.json`.
 *
 * The server address and its token deliberately do NOT live here: those belong
 * to the installation (several projects share one server), so the address is an
 * app preference and the token is in the OS keyring. Putting either in this file
 * would mean re-entering credentials per project, and would put a bearer token
 * in something the author may well hand to someone else along with the project.
 */
export interface SyncBinding {
  /** Which server, so a project bound elsewhere is not silently synced here. */
  serverUrl: string;
  kbId: string;
  /** Display name as of the last time we saw it; refreshed on connect. */
  kbName: string;
  /**
   * Every entry's hash as of the **last completed sync** — the third leg of the
   * comparison in `./plan`.
   *
   * Without it, a diff can only say *that* two sides differ, never *who moved*,
   * and every overwrite becomes a coin flip. This is the whole safety rail
   * (docs §14.2); an absent or stale snapshot degrades the plan to "everything
   * that differs is a conflict", which is honest but noisy.
   */
  snapshot: HashMap;
  /** ISO timestamp of the last completed sync; null before the first one. */
  lastSyncAt: string | null;
}

/** What a sync would do to one entry on the receiving side. */
export type SyncAction = "create" | "overwrite" | "delete" | "none";

/**
 * Why a step deserves a second look. Non-null means the step **discards
 * something the receiving side gained since the last sync** — the only class of
 * outcome a one-way mirror cannot undo for you.
 */
export type SyncWarning =
  /** Both sides changed since the last sync. Whichever way you go, work is lost. */
  | "both-changed"
  /** Only the receiving side changed: this replaces newer work with older. */
  | "overwrites-newer"
  /** The receiving side deleted this; the sync puts it back. */
  | "resurrects"
  /**
   * The receiving side has this entry and the sender never did — it was created
   * there since the last sync, or the sync has never run. Deleting it is how a
   * mirror propagates a deletion, and it is also how "just pull the server
   * copy" quietly removes work that only ever existed on this machine.
   *
   * Deliberately *not* named for the receiver having edited it: that case
   * cannot reach here. An edit means the snapshot holds the entry, which makes
   * the sender's absence a change too, and the step is reported as
   * `both-changed` instead.
   */
  | "deletes-unsynced";

export type SyncDirection = "push" | "pull";

export interface SyncStep {
  path: EntryPath;
  action: SyncAction;
  /** Hash on the sending side; null when it does not exist there (a delete). */
  sourceHash: string | null;
  /** Hash on the receiving side; null when it does not exist there. */
  targetHash: string | null;
  warning: SyncWarning | null;
  /** True when the local copy differs from the last-sync snapshot. */
  localChanged: boolean;
  /** True when the remote copy differs from the last-sync snapshot. */
  remoteChanged: boolean;
}

export interface SyncPlan {
  direction: SyncDirection;
  /** Every entry either side knows about, sorted by path — including `none`
   *  steps, so the UI can show "unchanged" rather than silently omitting them. */
  steps: SyncStep[];
  /** True when there is no snapshot to compare against (first sync after
   *  binding). Every difference then reads as a conflict, which is accurate but
   *  worth saying out loud rather than alarming the author with. */
  firstSync: boolean;
  summary: {
    create: number;
    overwrite: number;
    delete: number;
    unchanged: number;
    warnings: number;
  };
}
