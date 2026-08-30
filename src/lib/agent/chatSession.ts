/**
 * Chat-session persistence — the serialization half (docs/feature/agent/chat-memory-plan.md's
 * deferred last item). A session is display turns + wire history + the
 * ChatSessionMeta bookkeeping + cumulative usage, flattened to one JSON blob
 * for the project DB (lib/agent/sessionDb).
 *
 * The one non-obvious problem this module owns: ChatSessionMeta refers to
 * history *messages by object identity* (turn starts, the seed block, the
 * summary, every ledger carrier), and JSON has no identity. Serialization
 * converts each reference to its history index; deserialization re-links the
 * indices back to the freshly parsed objects, so the restored meta points into
 * the restored history exactly the way the live one did. A reference that no
 * longer resolves (corrupt row, out-of-range index) is dropped rather than
 * guessed at.
 *
 * Deserialize is deliberately paranoid: any shape surprise returns null and
 * the caller starts a fresh session. A chat that cannot be restored is an
 * inconvenience; a half-restored history is a protocol error on every later
 * turn.
 */

import type { StreamMessage } from "../ai/types";
import type { AgentEvent } from "./events";
import { createSessionMeta, type ChatSessionMeta } from "./compact";
import { contentWithoutImages, hasImageParts } from "./imageHistory";
import { toPosixPath } from "../paths";

/**
 * Replaces a picture in the *saved* history. Restoring a session brings back
 * the conversation, not the pixels — see {@link withoutImageData}.
 */
const DROPPED_IMAGE =
  "[image not kept in the saved session — read it again if it still matters]";

/**
 * The history as it goes to disk: same messages, minus the base64.
 *
 * A picture is ~1–12MB of data URL, up to three of them survive in a live
 * history at once, and this blob is a single SQLite row rewritten on every
 * turn. Keeping them would mean tens of megabytes of JSON stringified and
 * written repeatedly, for pixels a restored session cannot use anyway: the
 * author attached theirs to a question that has already been answered, and the
 * model can call read_image or read_lore_image again for anything it still
 * needs — the paths are right there in the transcript.
 *
 * Copies rather than mutates: the live session keeps its images. Order is
 * preserved 1:1 so the meta's index references, computed against the original
 * array, still land on the right messages.
 */
function withoutImageData(history: StreamMessage[]): StreamMessage[] {
  return history.map((m) =>
    hasImageParts(m) ? { ...m, content: contentWithoutImages(m, DROPPED_IMAGE) } : m,
  );
}

/** Structural mirror of agentStore's ChatTurn (lib must not import stores). */
export interface PersistedTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  log: AgentEvent[];
  at: number;
  quote?: string;
  images?: string[];
}

export interface PersistedUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface ChatSnapshot {
  turns: PersistedTurn[];
  history: StreamMessage[];
  meta: ChatSessionMeta;
  usage: PersistedUsage | null;
  /**
   * Disk task workspace this conversation writes into, if it created one. A
   * restored session must reconnect to *its own* notes: without this, reopening
   * an old conversation started a fresh workspace — and worse, switching left
   * the previous session's handle live, filing new notes under another task.
   */
  taskId: string | null;
}

/**
 * One ledger row on disk.
 *
 * The triple is what every session written before the ledger learned about
 * facets carries; it restores as "the body is in, nothing itemised", which is
 * exactly what it recorded. New rows are quadruples, and `v` deliberately does
 * **not** move for them: bumping it would throw away every existing
 * conversation to gain a field that degrades to "re-inject once".
 */
type SerializedInjection =
  | [dir: string, version: string, carrierIdx: number]
  | [dir: string, version: string, coreIdx: number, facets: [file: string, idx: number][]];

/** On-disk shape. Bump `v` on breaking changes; old versions restore as null. */
interface SerializedChat {
  v: 1;
  turns: PersistedTurn[];
  history: StreamMessage[];
  meta: {
    seedContext: number;
    summary: number;
    summaryText: string | null;
    turnStarts: number[];
    /** See {@link SerializedInjection}. `coreIdx` -1 = the body is not in. */
    injected: SerializedInjection[];
    lastDocPath: string | null;
    /** Additive since 1.18.8 — an older row restores as "body never injected". */
    bodyDocPath?: string | null;
    /**
     * Additive since 1.38 — which tier's briefing history[0] carries, so the
     * mid-session Beta-flip refresh (agentStore.sendChat) works on a restored
     * session too. An older row restores as "assist", which every pre-1.37
     * session was.
     */
    briefingTier?: "assist" | "orchestrator";
  };
  usage: PersistedUsage | null;
  /** Additive since 1.16 — older rows simply lack it, older readers ignore it. */
  taskId?: string;
}

export function serializeChatSession(snap: ChatSnapshot): string {
  const indexOf = (msg: StreamMessage | null): number =>
    msg ? snap.history.indexOf(msg) : -1;
  const data: SerializedChat = {
    v: 1,
    turns: snap.turns,
    history: withoutImageData(snap.history),
    meta: {
      seedContext: indexOf(snap.meta.seedContext),
      summary: indexOf(snap.meta.summary),
      summaryText: snap.meta.summaryText,
      turnStarts: snap.meta.turnStarts
        .map((m) => snap.history.indexOf(m))
        .filter((i) => i >= 0),
      injected: [...snap.meta.injected].flatMap(([dir, rec]) => {
        const coreIdx = rec.coreCarrier ? snap.history.indexOf(rec.coreCarrier) : -1;
        const facets: [string, number][] = [];
        for (const [file, carrier] of rec.facetCarriers) {
          const i = snap.history.indexOf(carrier);
          if (i >= 0) facets.push([file, i]);
        }
        // A record whose every carrier is off-history says nothing worth
        // restoring — and restoring it would suppress an entity that is not
        // actually in the conversation.
        if (coreIdx < 0 && facets.length === 0) return [];
        return [[dir, rec.version, coreIdx, facets] as SerializedInjection];
      }),
      lastDocPath: snap.meta.lastDocPath,
      bodyDocPath: snap.meta.bodyDocPath,
      briefingTier: snap.meta.briefingTier,
    },
    usage: snap.usage,
    ...(snap.taskId ? { taskId: snap.taskId } : {}),
  };
  return JSON.stringify(data);
}

/**
 * Bring one persisted log entry up to the current `AgentEvent` shape.
 *
 * A session blob outlives the code that wrote it, so an event's payload is
 * effectively a wire format. `round-limit` carried `granted: number` until the
 * round cap grew a third answer (存盘暂停) and became a discriminated union —
 * and a stale row reaching the renderer as `event.decision.action` took the
 * whole AI drawer down through the error boundary, on nothing worse than
 * opening an old conversation.
 *
 * Returns null for anything unrecognisable, which the caller drops: one
 * unreadable line of history is worth losing, a session is not.
 */
function migrateLogEvent(raw: unknown): AgentEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.kind !== "string") return null;

  if (e.kind === "round-limit" && e.decision === undefined) {
    // Pre-1.13: `granted` extra rounds, where 0 meant "wrap up now".
    const granted = typeof e.granted === "number" ? e.granted : 0;
    return {
      ...(e as object),
      decision: granted > 0 ? { action: "extend", rounds: granted } : { action: "finish" },
    } as AgentEvent;
  }
  return e as unknown as AgentEvent;
}

/** Every turn's log, migrated and stripped of entries that survived nothing. */
function normalizeTurns(turns: readonly PersistedTurn[]): PersistedTurn[] {
  return turns.map((t) => ({
    ...t,
    log: Array.isArray(t.log)
      ? t.log.map(migrateLogEvent).filter((e): e is AgentEvent => e !== null)
      : [],
    // A picture's path is absolute; a blob written by an older build carries
    // the host's spelling, and the transcript then cannot render it.
    images: Array.isArray(t.images) ? t.images.map(toPosixPath) : t.images,
  }));
}

export function deserializeChatSession(json: string): ChatSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const data = raw as SerializedChat;
  if (data.v !== 1) return null;
  if (!Array.isArray(data.turns) || !Array.isArray(data.history)) return null;
  if (typeof data.meta !== "object" || data.meta === null) return null;
  if (!Array.isArray(data.meta.turnStarts) || !Array.isArray(data.meta.injected)) return null;

  const at = (i: number): StreamMessage | null =>
    Number.isInteger(i) && i >= 0 && i < data.history.length ? data.history[i] : null;

  const meta = createSessionMeta();
  meta.seedContext = at(data.meta.seedContext);
  meta.summary = at(data.meta.summary);
  meta.summaryText = typeof data.meta.summaryText === "string" ? data.meta.summaryText : null;
  meta.turnStarts = data.meta.turnStarts
    .map(at)
    .filter((m): m is StreamMessage => m !== null);
  for (const entry of data.meta.injected) {
    if (!Array.isArray(entry) || entry.length < 3) continue;
    const [dir, version, coreIdx] = entry;
    if (typeof dir !== "string" || typeof version !== "string") continue;
    const coreCarrier = typeof coreIdx === "number" ? at(coreIdx) : null;
    const facetCarriers = new Map<string, StreamMessage>();
    const rawFacets: unknown = entry.length > 3 ? entry[3] : undefined;
    if (Array.isArray(rawFacets)) {
      for (const pair of rawFacets) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [file, idx] = pair as [unknown, unknown];
        const carrier = typeof idx === "number" ? at(idx) : null;
        if (typeof file === "string" && carrier) facetCarriers.set(file, carrier);
      }
    }
    // Nothing resolvable — drop it rather than guess. Suppressing an entity
    // that is not in the restored history is the one failure the model cannot
    // recover from on its own.
    if (!coreCarrier && facetCarriers.size === 0) continue;
    // Keyed by an absolute `LoreEntity.dirPath`, and looked up with
    // `Map.get` — a spelling the live index no longer uses is a miss, and a
    // miss silently re-injects every entity into the restored conversation.
    meta.injected.set(toPosixPath(dir), { version, coreCarrier, facetCarriers });
  }
  // Compared against `activeFilePath` to decide whether the open document has
  // to be described (or re-sent) again on the next turn.
  meta.lastDocPath = typeof data.meta.lastDocPath === "string" ? toPosixPath(data.meta.lastDocPath) : null;
  meta.bodyDocPath = typeof data.meta.bodyDocPath === "string" ? toPosixPath(data.meta.bodyDocPath) : null;
  meta.briefingTier = data.meta.briefingTier === "orchestrator" ? "orchestrator" : "assist";

  return {
    turns: normalizeTurns(data.turns),
    history: data.history,
    meta,
    usage: data.usage ?? null,
    taskId: typeof data.taskId === "string" ? data.taskId : null,
  };
}

/** Session list label: the first question, collapsed and clipped. */
export function sessionPreview(turns: readonly PersistedTurn[]): string {
  const first = turns.find((t) => t.role === "user");
  if (!first) return "";
  const line = first.text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? line.slice(0, 59) + "…" : line;
}

/**
 * Highest numeric suffix among restored turn ids ("t17" → 17). The store's
 * turn counter restarts at 0 with the app, so without this a restored session
 * would mint ids that collide with the turns already on screen — and React
 * keys silently reuse the wrong subtree.
 */
export function maxTurnId(turns: readonly PersistedTurn[]): number {
  let max = 0;
  for (const t of turns) {
    const m = /^t(\d+)$/.exec(t.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}
