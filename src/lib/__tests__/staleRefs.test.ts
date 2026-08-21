/**
 * 清理失效数据 — the sweep behind Settings → 通用 → 数据维护.
 *
 * The whole safety claim of that button is one sentence: **only references
 * that resolve to nothing are removed**. It is offered without a confirmation
 * step on the strength of that claim, so every test here is really the same
 * test twice — the dead thing goes, the live thing beside it stays.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Files (path → content) and directories the in-memory project holds. */
const files = new Map<string, string>();
const dirs = new Set<string>();

vi.mock("../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
    return files.get(p)!;
  }),
  writeFile: vi.fn(async (p: string, c: string) => void files.set(p, c)),
  fileExists: vi.fn(async (p: string) => files.has(p)),
  readDir: vi.fn(async (dir: string) => {
    if (!dirs.has(dir)) throw new Error(`ENOENT: ${dir}`);
    const out: { name: string; path: string; isDirectory: boolean }[] = [];
    for (const d of dirs) {
      if (d.startsWith(dir + "/") && !d.slice(dir.length + 1).includes("/")) {
        out.push({ name: d.slice(dir.length + 1), path: d, isDirectory: true });
      }
    }
    for (const f of files.keys()) {
      if (f.startsWith(dir + "/") && !f.slice(dir.length + 1).includes("/")) {
        out.push({ name: f.slice(dir.length + 1), path: f, isDirectory: false });
      }
    }
    return out;
  }),
}));

/** The prefs cache, standing in for the config database. */
const prefs = new Map<string, string>();

vi.mock("../prefs", () => ({
  PINNED_LORE_PREFIX: "ai:pinnedLore:",
  prefEntries: vi.fn(() => [...prefs.entries()]),
  writePref: vi.fn((k: string, v: string) => void prefs.set(k, v)),
  deletePref: vi.fn((k: string) => void prefs.delete(k)),
}));

/** Persisted chat sessions, by row id. */
const sessions = new Map<number, string>();

vi.mock("../agent/sessionDb", () => ({
  listChatSessions: vi.fn(async () =>
    [...sessions.keys()].map((id) => ({ id, preview: "p", updatedAt: 0 })),
  ),
  loadChatSession: vi.fn(async (_p: string, id: number) => sessions.get(id) ?? null),
  upsertChatSession: vi.fn(async (_p: string, id: number | null, data: string) => {
    sessions.set(id ?? 1, data);
    return id ?? 1;
  }),
}));

import { sweepStaleRefs, sweepTotal } from "../staleRefs";

const PROJECT = "/home/me/proj";
const LORE = `${PROJECT}/.ai-writer/lore/characters`;
const ALIVE = `${LORE}/ava`;
const DEAD = `${LORE}/gone`;

/** Register `dir` and every ancestor, the way a real tree would have them. */
function mkdir(dir: string): void {
  const parts = dir.split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) dirs.add("/" + parts.slice(0, i).join("/"));
}

beforeEach(() => {
  files.clear();
  dirs.clear();
  prefs.clear();
  sessions.clear();
  mkdir(ALIVE); // `gone` is deliberately never created
});

describe("pinned lore", () => {
  it("drops the pins whose entity is gone and keeps the rest", async () => {
    prefs.set(`ai:pinnedLore:${PROJECT}`, JSON.stringify([ALIVE, DEAD, `${ALIVE}#armor.md`]));

    const swept = await sweepStaleRefs(PROJECT);

    expect(swept.pinnedEntries).toBe(1);
    expect(swept.pinnedProjects).toBe(0);
    // The facet pin survives: its entity is alive, and the `#facet` suffix is
    // not part of the path that gets checked.
    expect(JSON.parse(prefs.get(`ai:pinnedLore:${PROJECT}`)!)).toEqual([ALIVE, `${ALIVE}#armor.md`]);
  });

  it("drops the whole row when the project folder itself is gone", async () => {
    prefs.set("ai:pinnedLore:/home/me/old-project", JSON.stringify(["/home/me/old-project/.ai-writer/lore/x/y"]));

    const swept = await sweepStaleRefs(PROJECT);

    expect(swept.pinnedProjects).toBe(1);
    expect(prefs.has("ai:pinnedLore:/home/me/old-project")).toBe(false);
  });

  it("leaves a row alone when every pin still resolves", async () => {
    prefs.set(`ai:pinnedLore:${PROJECT}`, JSON.stringify([ALIVE]));

    const swept = await sweepStaleRefs(PROJECT);

    expect(sweepTotal(swept)).toBe(0);
    expect(JSON.parse(prefs.get(`ai:pinnedLore:${PROJECT}`)!)).toEqual([ALIVE]);
  });
});

describe("roleplay roster", () => {
  const rosterPath = `${PROJECT}/.ai-writer/roleplay/agents.json`;

  it("clears dead bindings, keeps live ones, and preserves unknown fields", async () => {
    files.set(rosterPath, JSON.stringify({
      v: 1,
      authorPersona: { mode: "lore", dirPath: DEAD },
      agents: [
        {
          id: "a1", kind: "character", name: "Ava",
          primaryDirPath: ALIVE, boundPaths: [ALIVE, DEAD],
          somethingNewer: "keep me",
        },
        { id: "a2", kind: "character", name: "Gone", primaryDirPath: DEAD, boundPaths: [] },
      ],
    }));

    const swept = await sweepStaleRefs(PROJECT);

    // persona.dirPath + a1's dead bound path + a2's primary = 3
    expect(swept.rosterRefs).toBe(3);
    const after = JSON.parse(files.get(rosterPath)!);
    expect(after.authorPersona.dirPath).toBeNull();
    expect(after.agents[0].primaryDirPath).toBe(ALIVE);
    expect(after.agents[0].boundPaths).toEqual([ALIVE]);
    expect(after.agents[1].primaryDirPath).toBeNull();
    // A field this build does not know about must survive the rewrite.
    expect(after.agents[0].somethingNewer).toBe("keep me");
  });

  it("does not rewrite a roster with nothing stale in it", async () => {
    const original = JSON.stringify({ v: 1, agents: [{ id: "a1", kind: "character", primaryDirPath: ALIVE }] });
    files.set(rosterPath, original);

    const swept = await sweepStaleRefs(PROJECT);

    expect(swept.rosterRefs).toBe(0);
    expect(files.get(rosterPath)).toBe(original);
  });

  it("leaves an unreadable roster where it is", async () => {
    files.set(rosterPath, "{ not json");

    const swept = await sweepStaleRefs(PROJECT);

    expect(swept.rosterRefs).toBe(0);
    expect(files.get(rosterPath)).toBe("{ not json");
  });
});

describe("persisted chat sessions", () => {
  it("prunes the injection ledger and dead pictures, keeping the live ones", async () => {
    const picture = `${PROJECT}/assets/第一章/img-1.png`;
    files.set(picture, "bytes");
    sessions.set(1, JSON.stringify({
      v: 1,
      turns: [{ id: "t1", images: [picture, `${PROJECT}/assets/第一章/deleted.png`] }],
      history: [],
      meta: { injected: [[ALIVE, "v1", 0], [DEAD, "v1", 1]] },
    }));

    const swept = await sweepStaleRefs(PROJECT);

    expect(swept.sessionInjected).toBe(1);
    expect(swept.sessionImages).toBe(1);
    const after = JSON.parse(sessions.get(1)!);
    expect(after.meta.injected).toEqual([[ALIVE, "v1", 0]]);
    expect(after.turns[0].images).toEqual([picture]);
  });

  it("leaves a session untouched when everything in it resolves", async () => {
    const original = JSON.stringify({
      v: 1, turns: [], history: [], meta: { injected: [[ALIVE, "v1", 0]] },
    });
    sessions.set(1, original);

    const swept = await sweepStaleRefs(PROJECT);

    expect(sweepTotal(swept)).toBe(0);
    expect(sessions.get(1)).toBe(original);
  });
});

describe("uncertainty is not evidence", () => {
  it("keeps a reference whose parent folder cannot be listed", async () => {
    // `/mnt/nas/书` — the share is not mounted, so its parent does not list.
    prefs.set(`ai:pinnedLore:${PROJECT}`, JSON.stringify(["/mnt/nas/书/lore/ava"]));

    const swept = await sweepStaleRefs(PROJECT);

    expect(sweepTotal(swept)).toBe(0);
    expect(JSON.parse(prefs.get(`ai:pinnedLore:${PROJECT}`)!)).toEqual(["/mnt/nas/书/lore/ava"]);
  });
});

describe("scope", () => {
  it("sweeps pinned lore even with no project open, and nothing else", async () => {
    prefs.set("ai:pinnedLore:/home/me/old-project", JSON.stringify(["/home/me/old-project/x"]));
    files.set(`${PROJECT}/.ai-writer/roleplay/agents.json`, JSON.stringify({
      v: 1, agents: [{ id: "a1", kind: "character", primaryDirPath: DEAD }],
    }));

    const swept = await sweepStaleRefs("");

    expect(swept.pinnedProjects).toBe(1);
    expect(swept.rosterRefs).toBe(0);
  });
});
