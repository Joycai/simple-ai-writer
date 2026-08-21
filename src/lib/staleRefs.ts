/**
 * 清理失效数据 — the app's stored references to files that are no longer there.
 *
 * Most of what the app persists is project-relative (the book spine, story
 * memory, task workspaces, the sync snapshot) and survives anything the author
 * does to their folders. Four things are not: they hold an **absolute** path
 * and match it by identity, so the reference dies the moment the target is
 * renamed, moved, deleted, or restored from a backup somewhere else.
 *
 *   - `ai:pinnedLore:<project>` — the key is a project path, the value a list
 *     of entity `dirPath`s (or `dirPath#facet` pins).
 *   - `.ai-writer/roleplay/agents.json` — each agent's primary entity and its
 *     bound entries; the author persona's entry.
 *   - a persisted chat session's `meta.injected` ledger — keyed by `dirPath`.
 *   - a persisted chat session's `turns[].images` — pictures a turn produced.
 *
 * None of these failures announce themselves. A dead pin simply stops
 * injecting; a dead injection ledger entry silently re-sends an entity the
 * conversation already had; a dead image renders as nothing. Hence a button
 * rather than an automatic sweep — the author asks, and gets told what went.
 *
 * **Only dead references are removed.** Every path is checked against disk
 * first, so a live pin, a live binding and a live picture are never touched.
 * That is what makes this safe to offer as one click: it cannot lose anything
 * that still points at something.
 */

import { fileExists, readDir, readFile, writeFile } from "./fs/fileio";
import { deletePref, PINNED_LORE_PREFIX, prefEntries, writePref } from "./prefs";
import {
  listChatSessions,
  loadChatSession,
  upsertChatSession,
} from "./agent/sessionDb";
import { toPosixPath } from "./paths";

/** What a sweep removed, by kind. All zeroes means nothing was stale. */
export interface StaleSweep {
  /** Whole `ai:pinnedLore:` rows whose project folder is gone. */
  pinnedProjects: number;
  /** Individual pinned entities/facets whose folder is gone. */
  pinnedEntries: number;
  /** Roleplay primary/bound/persona references whose entity is gone. */
  rosterRefs: number;
  /** Injection-ledger entries whose entity is gone. */
  sessionInjected: number;
  /** Turn pictures whose file is gone. */
  sessionImages: number;
}

export const NOTHING_STALE: StaleSweep = {
  pinnedProjects: 0,
  pinnedEntries: 0,
  rosterRefs: 0,
  sessionInjected: 0,
  sessionImages: 0,
};

export function sweepTotal(s: StaleSweep): number {
  return s.pinnedProjects + s.pinnedEntries + s.rosterRefs
    + s.sessionInjected + s.sessionImages;
}

/**
 * Whether a directory is definitely gone.
 *
 * Three answers, not two, and the distinction is load-bearing: this module
 * **deletes** on the strength of it. `fs_exists` cannot tell a file from a
 * folder and every reference here names one, so the question goes to the
 * parent's listing — the same trick the agent's `statEntry` uses. A parent
 * that cannot be listed (a disconnected network drive, a permission the app
 * lost) is not evidence of anything, so it answers "not gone" and the caller
 * keeps the reference. Erring toward a stale pin is free; erring the other way
 * deletes an author's live bindings the first time a drive is slow to mount.
 */
async function isGone(path: string): Promise<boolean> {
  const clean = toPosixPath(path).replace(/\/+$/, "");
  const cut = clean.lastIndexOf("/");
  if (cut < 0) return false; // not a path we can reason about — leave it alone
  const parent = cut === 0 ? "/" : clean.slice(0, cut);
  try {
    const entries = await readDir(parent);
    const name = clean.slice(cut + 1);
    return !entries.some((e) => e.name === name && e.isDirectory);
  } catch {
    return false; // could not tell — not grounds for deleting anything
  }
}

/** {@link isGone} for a file rather than a directory, with the same caution. */
async function fileGone(path: string): Promise<boolean> {
  try {
    return !(await fileExists(path));
  } catch {
    return false;
  }
}

/** A pin is `<dirPath>` or `<dirPath>#<facet file>` — the entity is the part before `#`. */
function pinnedDir(pin: string): string {
  const hash = pin.lastIndexOf("#");
  return hash < 0 ? pin : pin.slice(0, hash);
}

// ─── Pinned lore (every project, not just the open one) ──────────────────────

async function sweepPinnedLore(into: StaleSweep): Promise<void> {
  const rows = prefEntries().filter(([k]) => k.startsWith(PINNED_LORE_PREFIX));
  for (const [key, value] of rows) {
    const project = key.slice(PINNED_LORE_PREFIX.length);
    // A whole row for a project that no longer exists: drop it outright rather
    // than checking each pin inside it against a folder that is gone.
    if (await isGone(project)) {
      deletePref(key);
      into.pinnedProjects++;
      continue;
    }
    let pins: unknown;
    try {
      pins = JSON.parse(value);
    } catch {
      deletePref(key); // unreadable — it can only ever fail to apply
      into.pinnedProjects++;
      continue;
    }
    if (!Array.isArray(pins)) continue;

    const live: string[] = [];
    for (const pin of pins) {
      if (typeof pin !== "string") continue;
      if (await isGone(pinnedDir(pin))) into.pinnedEntries++;
      else live.push(pin);
    }
    if (live.length !== pins.length) writePref(key, JSON.stringify(live));
  }
}

// ─── Roleplay roster ─────────────────────────────────────────────────────────

/**
 * Prune dead entity references from `agents.json`, in place.
 *
 * Parsed and rewritten as raw JSON rather than through `lib/roleplay/store`'s
 * roster types: this must not drop a field a newer build added and this one
 * does not know about. Only the four path-valued keys are touched.
 */
async function sweepRoster(projectPath: string, into: StaleSweep): Promise<void> {
  const path = `${projectPath}/.ai-writer/roleplay/agents.json`;
  if (!(await fileExists(path))) return;

  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(path));
    if (!parsed || typeof parsed !== "object") return;
    data = parsed as Record<string, unknown>;
  } catch {
    return; // an unreadable roster is not ours to delete
  }

  const before = into.rosterRefs;
  const gone = async (p: unknown): Promise<boolean> =>
    typeof p === "string" && (await isGone(p));

  const persona = data.authorPersona as Record<string, unknown> | undefined;
  if (persona && typeof persona.dirPath === "string" && (await gone(persona.dirPath))) {
    persona.dirPath = null;
    into.rosterRefs++;
  }

  const agents = Array.isArray(data.agents) ? data.agents : [];
  for (const raw of agents) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    if (typeof a.primaryDirPath === "string" && (await gone(a.primaryDirPath))) {
      a.primaryDirPath = null;
      into.rosterRefs++;
    }
    if (Array.isArray(a.boundPaths)) {
      const live: string[] = [];
      for (const p of a.boundPaths) {
        if (await gone(p)) into.rosterRefs++;
        else live.push(p as string);
      }
      a.boundPaths = live;
    }
    const ap = a.authorPersona as Record<string, unknown> | undefined;
    if (ap && typeof ap.dirPath === "string" && (await gone(ap.dirPath))) {
      ap.dirPath = null;
      into.rosterRefs++;
    }
  }

  if (into.rosterRefs !== before) {
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  }
}

// ─── Persisted chat sessions ─────────────────────────────────────────────────

/**
 * Prune the injection ledger and dead pictures from each stored session.
 *
 * Edited as raw JSON for the same reason as the roster, and with one extra:
 * `deserializeChatSession` rebuilds a live snapshot (resolving message indices
 * into object references), so round-tripping through it would rewrite parts of
 * the blob this sweep has no business touching.
 */
async function sweepSessions(projectPath: string, into: StaleSweep): Promise<void> {
  let rows: Awaited<ReturnType<typeof listChatSessions>>;
  try {
    rows = await listChatSessions(projectPath);
  } catch {
    return; // no project database yet
  }

  for (const row of rows) {
    const json = await loadChatSession(projectPath, row.id);
    if (!json) continue;

    let data: Record<string, unknown>;
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== "object") continue;
      data = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    let touched = false;

    const meta = data.meta as Record<string, unknown> | undefined;
    if (meta && Array.isArray(meta.injected)) {
      const live: unknown[] = [];
      for (const entry of meta.injected) {
        const dir = Array.isArray(entry) ? entry[0] : null;
        if (typeof dir === "string" && (await isGone(dir))) {
          into.sessionInjected++;
          touched = true;
        } else {
          live.push(entry);
        }
      }
      meta.injected = live;
    }

    if (Array.isArray(data.turns)) {
      for (const raw of data.turns) {
        if (!raw || typeof raw !== "object") continue;
        const turn = raw as Record<string, unknown>;
        if (!Array.isArray(turn.images)) continue;
        const live: string[] = [];
        for (const img of turn.images) {
          if (typeof img === "string" && (await fileGone(img))) {
            into.sessionImages++;
            touched = true;
          } else {
            live.push(img as string);
          }
        }
        turn.images = live;
      }
    }

    if (touched) {
      await upsertChatSession(projectPath, row.id, JSON.stringify(data), row.preview);
    }
  }
}

/**
 * Remove every stored reference that no longer points at anything, and report
 * what went. `projectPath` scopes the roster and session passes; pinned lore is
 * swept across all projects, since a row for a folder the author deleted years
 * ago is exactly the kind of thing this button exists to collect.
 */
export async function sweepStaleRefs(projectPath: string): Promise<StaleSweep> {
  const result: StaleSweep = { ...NOTHING_STALE };
  await sweepPinnedLore(result);
  if (projectPath) {
    await sweepRoster(projectPath, result);
    await sweepSessions(projectPath, result);
  }
  return result;
}
