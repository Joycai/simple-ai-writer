/**
 * Undo from the plan ledger (设计稿 02h 1h / 1i), under the rule agreed on
 * 2026-09-10: undo only a file that is still exactly what the write left.
 *
 * Pinned: a hand edit refuses; a later write in the turn refuses and is named;
 * 撤回全部 on a file written twice works because it goes newest first; a create
 * is removed into the backups, never unlinked; a deleted file or entry comes
 * back only if nothing has taken its place; and the state an undo replaces is
 * itself backed up first.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();

vi.mock("../fs/fileio", () => ({
  readFile: vi.fn(async (p: string) => {
    if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
    return files.get(p)!;
  }),
  writeFile: vi.fn(async (p: string, content: string) => {
    files.set(p, content);
  }),
  fileExists: vi.fn(async (p: string) => files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`))),
  makeDir: vi.fn(async () => {}),
  renamePath: vi.fn(async (from: string, to: string) => {
    for (const key of [...files.keys()]) {
      if (key === from || key.startsWith(`${from}/`)) {
        const value = files.get(key)!;
        files.delete(key);
        files.set(to + key.slice(from.length), value);
      }
    }
  }),
}));

import { hashText } from "../agent/backup";
import { planUndo, undoWrites } from "../agent/undo";
import type { AgentEvent, ChangeRecord } from "../agent/events";

const P = "/proj";
const REL = ".ai-writer/lore/characters/lian/外貌.md";
const ABS = `${P}/${REL}`;
const BACKUPS = `${P}/.ai-writer/backups`;

let clock = 1_700_000_000_000;
const now = () => (clock += 1000);

function write(toolCallId: string, name: string, change: ChangeRecord): AgentEvent {
  return {
    kind: "tool-step",
    step: { round: 1, toolCallId, name, argumentSummary: "{}", status: "done", resultSummary: "ok", change },
    at: now(),
  };
}

function update(after: string, backupPath: string): ChangeRecord {
  return {
    path: REL,
    entity: "莉安",
    action: "update",
    beforeChars: 0,
    afterChars: after.length,
    afterHash: hashText(after),
    backupPath,
  };
}

const backupsHolding = (text: string) =>
  [...files.entries()].filter(([k, v]) => k.startsWith(`${BACKUPS}/`) && v === text);

beforeEach(() => files.clear());

describe("planUndo", () => {
  const record = update("银发", `${BACKUPS}/b1`);

  it("undoes a file that is still what the write left", () => {
    expect(planUndo(record, { exists: true, text: "银发" }, [])).toEqual({ ok: true, op: "restore" });
  });

  it("refuses a file edited after the write", () => {
    expect(planUndo(record, { exists: true, text: "银发，改过" }, []))
      .toEqual({ ok: false, reason: "changedAfter" });
  });

  it("names a later write in the turn that touched the same file", () => {
    const later = [{ toolCallId: "t2", toolName: "edit_lore_file", change: update("银发三", `${BACKUPS}/b2`) }];
    expect(planUndo(record, { exists: true, text: "银发三" }, later))
      .toEqual({ ok: false, reason: "changedByLaterWrite", byTool: "edit_lore_file" });
  });

  it("cannot vouch for a record with neither text nor fingerprint", () => {
    const old: ChangeRecord = { path: REL, action: "update", beforeChars: 9000, afterChars: 9100, backupPath: `${BACKUPS}/b` };
    expect(planUndo(old, { exists: true, text: "whatever" }, [])).toEqual({ ok: false, reason: "cannotVerify" });
  });

  it("brings back a deleted file only if nothing took its place", () => {
    const deleted: ChangeRecord = { path: REL, action: "delete", beforeChars: 5, afterChars: 0, backupPath: `${BACKUPS}/d` };
    expect(planUndo(deleted, { exists: false }, [])).toEqual({ ok: true, op: "restore" });
    expect(planUndo(deleted, { exists: true }, [])).toEqual({ ok: false, reason: "recreated" });
  });

  it("refuses without a backup to restore from", () => {
    const deleted: ChangeRecord = { path: REL, action: "delete", beforeChars: 5, afterChars: 0 };
    expect(planUndo(deleted, { exists: false }, [])).toEqual({ ok: false, reason: "noBackup" });
  });
});

describe("undoWrites", () => {
  it("restores the previous version, backing up what it replaces", async () => {
    files.set(ABS, "银发");
    files.set(`${BACKUPS}/b1`, "金发");
    const log = [write("t1", "update_lore_file", update("银发", `${BACKUPS}/b1`))];

    const [event] = await undoWrites(P, log, ["t1"], now);

    expect(event).toMatchObject({ kind: "undo", toolCallId: "t1", outcome: "undone" });
    expect(files.get(ABS)).toBe("金发");
    // The state the undo overwrote is recoverable too.
    expect(backupsHolding("银发").length).toBeGreaterThan(0);
  });

  it("leaves a hand-edited file alone and says why", async () => {
    files.set(ABS, "银发，我自己又改了一句");
    files.set(`${BACKUPS}/b1`, "金发");
    const log = [write("t1", "update_lore_file", update("银发", `${BACKUPS}/b1`))];

    const [event] = await undoWrites(P, log, ["t1"], now);

    expect(event).toMatchObject({ outcome: "refused", reason: "changedAfter" });
    expect(files.get(ABS)).toBe("银发，我自己又改了一句");
  });

  it("undoes a file written twice when both are undone together, newest first", async () => {
    files.set(`${BACKUPS}/b1`, "v0");
    files.set(`${BACKUPS}/b2`, "v1");
    files.set(ABS, "v2");
    const log = [
      write("t1", "update_lore_file", update("v1", `${BACKUPS}/b1`)),
      write("t2", "edit_lore_file", update("v2", `${BACKUPS}/b2`)),
    ];

    // Alone, the earlier write is blocked by the later one — and the later is named.
    const [blocked] = await undoWrites(P, log, ["t1"], now);
    expect(blocked).toMatchObject({ outcome: "refused", reason: "changedByLaterWrite", byTool: "edit_lore_file" });

    const events = await undoWrites(P, log, ["t1", "t2"], now);
    expect(events.map((e) => [e.toolCallId, e.outcome])).toEqual([["t2", "undone"], ["t1", "undone"]]);
    expect(files.get(ABS)).toBe("v0");
  });

  it("does not count a write already undone as standing in the way", async () => {
    files.set(`${BACKUPS}/b1`, "v0");
    files.set(ABS, "v1");
    const log: AgentEvent[] = [
      write("t1", "update_lore_file", update("v1", `${BACKUPS}/b1`)),
      write("t2", "edit_lore_file", update("v2", `${BACKUPS}/b2`)),
      { kind: "undo", toolCallId: "t2", outcome: "undone", at: now() },
    ];
    const [event] = await undoWrites(P, log, ["t1"], now);
    expect(event).toMatchObject({ outcome: "undone" });
    expect(files.get(ABS)).toBe("v0");
  });

  it("moves a created file into the backups rather than deleting it", async () => {
    files.set(ABS, "# 凯尔\n");
    const created: ChangeRecord = {
      path: REL, action: "create", beforeChars: 0, afterChars: 5, afterHash: hashText("# 凯尔\n"),
    };
    const [event] = await undoWrites(P, [write("t1", "create_lore_facet", created)], ["t1"], now);

    expect(event.outcome).toBe("undone");
    expect(files.has(ABS)).toBe(false);
    expect(backupsHolding("# 凯尔\n")).toHaveLength(1);
  });

  it("brings a deleted entry's folder back to where it was", async () => {
    const dir = ".ai-writer/lore/places/old-pier";
    const trash = `${BACKUPS}/deleted-1-places-old-pier`;
    files.set(`${trash}/index.md`, "# 旧码头\n");
    const deleted: ChangeRecord = { path: dir, entity: "旧码头", action: "delete", dir: true, beforeChars: 0, afterChars: 0, backupPath: trash };

    const [event] = await undoWrites(P, [write("t1", "delete_lore_entity", deleted)], ["t1"], now);

    expect(event.outcome).toBe("undone");
    expect(files.get(`${P}/${dir}/index.md`)).toBe("# 旧码头\n");
  });

  it("refuses to bring an entry back over one re-created under its name", async () => {
    const dir = ".ai-writer/lore/places/old-pier";
    const trash = `${BACKUPS}/deleted-1-places-old-pier`;
    files.set(`${trash}/index.md`, "# 旧码头\n");
    files.set(`${P}/${dir}/index.md`, "# 新的旧码头\n");
    const deleted: ChangeRecord = { path: dir, action: "delete", dir: true, beforeChars: 0, afterChars: 0, backupPath: trash };

    const [event] = await undoWrites(P, [write("t1", "delete_lore_entity", deleted)], ["t1"], now);

    expect(event).toMatchObject({ outcome: "refused", reason: "recreated" });
    expect(files.get(`${P}/${dir}/index.md`)).toBe("# 新的旧码头\n");
  });
});
