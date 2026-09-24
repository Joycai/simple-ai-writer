/**
 * loreStore.saveNow — settling after the async write must describe the state
 * *after* it, the same rule editorStore.saveNow follows
 * (docs/feature/html-artifact-plan.md D5): a keystroke mid-write stays dirty
 * and its newly armed timer stays tracked; the write only ever cleans what it
 * wrote, never a reload of the same file or another file's edits; and a buffer
 * that ends up equal to what was written is clean with no live timer. Two
 * saves of one entry file in flight land in the order they started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readEntityFile: vi.fn(async (_dir: string, _name: string) => "content"),
  writeEntityFile: vi.fn(async (_dir: string, _name: string, _content: string) => {}),
}));
vi.mock("../../lib/lore", () => ({
  scanLore: vi.fn(async () => ({})),
  createEntity: vi.fn(),
  readEntityFile: h.readEntityFile,
  writeEntityFile: h.writeEntityFile,
  // Called at store creation (detailMode's initial value).
  parseDetailMode: () => "read",
  LORE_DETAIL_MODE_PREF: "app:loreDetailMode",
}));
vi.mock("../../lib/fs/fileio", () => ({ removeDir: vi.fn() }));

import { useLoreStore } from "../loreStore";
import type { LoreEntity } from "../../lib/lore";

const AVA = { id: "ava", name: "Ava", category: "characters", dirPath: "/p/lore/characters/ava", mdFiles: ["index.md"] } as unknown as LoreEntity;
const BEN = { id: "ben", name: "Ben", category: "characters", dirPath: "/p/lore/characters/ben", mdFiles: ["index.md"] } as unknown as LoreEntity;

/** Hold the next write open so the author can act while it is in flight. */
function holdNextWrite(): () => void {
  let finish!: () => void;
  h.writeEntityFile.mockImplementationOnce(() => new Promise<void>((r) => { finish = r; }));
  return () => finish();
}

describe("loreStore.saveNow — settles against what it wrote", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useLoreStore.setState({
      selectedEntity: AVA, selectedFile: "index.md", fileContent: "", isDirty: false, saveTimer: null,
    });
    h.writeEntityFile.mockClear();
  });
  afterEach(() => {
    const { saveTimer } = useLoreStore.getState();
    if (saveTimer) clearTimeout(saveTimer);
    vi.useRealTimers();
  });

  it("a keystroke during the write keeps the entry dirty and its new timer tracked", async () => {
    const finish = holdNextWrite();
    useLoreStore.getState().setFileContent("A");
    const saving = useLoreStore.getState().saveNow(); // writes "A"
    useLoreStore.getState().setFileContent("AB");     // typed mid-write
    const newTimer = useLoreStore.getState().saveTimer;
    expect(newTimer).not.toBeNull();

    finish();
    await saving;

    // "AB" never reached disk: still dirty, and the timer that will write it
    // is still the one on record (not orphaned as null).
    expect(useLoreStore.getState().isDirty).toBe(true);
    expect(useLoreStore.getState().saveTimer).toBe(newTimer);

    await vi.advanceTimersByTimeAsync(2500);
    expect(h.writeEntityFile).toHaveBeenLastCalledWith(AVA.dirPath, "index.md", "AB");
    expect(useLoreStore.getState().isDirty).toBe(false);
    expect(useLoreStore.getState().saveTimer).toBeNull();
  });

  it("a reload of the same file during the write stays clean (the late settle doesn't re-dirty it)", async () => {
    const finish = holdNextWrite();
    useLoreStore.getState().setFileContent("A");
    const saving = useLoreStore.getState().saveNow();
    // What a re-read of the same file leaves behind: disk text, clean, no timer.
    useLoreStore.setState({ fileContent: "reloaded", isDirty: false, saveTimer: null });
    finish();
    await saving;
    expect(useLoreStore.getState().isDirty).toBe(false);
  });

  it("another entry's edits made during the write stay dirty", async () => {
    const finish = holdNextWrite();
    useLoreStore.getState().setFileContent("A");
    const saving = useLoreStore.getState().saveNow();
    // Ben's index.md is open now, and the author typed in it — same filename,
    // different entry.
    useLoreStore.setState({ selectedEntity: BEN, fileContent: "A", isDirty: true });
    finish();
    await saving;
    expect(useLoreStore.getState().isDirty).toBe(true);
  });

  it("another file of the same entry, edited during the write, stays dirty", async () => {
    const finish = holdNextWrite();
    useLoreStore.getState().setFileContent("A");
    const saving = useLoreStore.getState().saveNow();
    useLoreStore.setState({ selectedFile: "voice.md", fileContent: "A", isDirty: true });
    finish();
    await saving;
    expect(useLoreStore.getState().isDirty).toBe(true);
  });

  it("a keystroke and its undo during the write settle clean, with that timer cancelled", async () => {
    const finish = holdNextWrite();
    useLoreStore.getState().setFileContent("C");
    const saving = useLoreStore.getState().saveNow();
    useLoreStore.getState().setFileContent("Cx");
    useLoreStore.getState().setFileContent("C"); // back to what is being written
    finish();
    await saving;
    expect(useLoreStore.getState().isDirty).toBe(false);
    expect(useLoreStore.getState().saveTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(2500);
    expect(h.writeEntityFile).toHaveBeenCalledTimes(1); // no late rewrite
  });

  it("an unchanged buffer settles clean", async () => {
    useLoreStore.getState().setFileContent("same");
    await useLoreStore.getState().saveNow();
    expect(useLoreStore.getState().isDirty).toBe(false);
    expect(useLoreStore.getState().saveTimer).toBeNull();
  });

  it("a failed write keeps the entry dirty and a mid-write timer tracked", async () => {
    let fail!: (e: Error) => void;
    h.writeEntityFile.mockImplementationOnce(() => new Promise<void>((_, rej) => { fail = rej; }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    useLoreStore.getState().setFileContent("A");
    const saving = useLoreStore.getState().saveNow();
    useLoreStore.getState().setFileContent("AB");
    const newTimer = useLoreStore.getState().saveTimer;
    fail(new Error("disk full"));
    await expect(saving).rejects.toThrow("disk full");
    expect(useLoreStore.getState().isDirty).toBe(true);
    expect(useLoreStore.getState().saveTimer).toBe(newTimer);
    spy.mockRestore();
  });
});

describe("loreStore.saveNow — overlapping writes of one entry file", () => {
  /** A disk whose writes finish only when the test says, in any order. */
  let disk: Map<string, string>;
  let pending: { path: string; content: string; land: () => void; fail: (e: Error) => void }[];

  beforeEach(() => {
    vi.useFakeTimers();
    disk = new Map();
    pending = [];
    h.writeEntityFile.mockReset();
    h.writeEntityFile.mockImplementation((dir: string, name: string, content: string) => new Promise<void>((resolve, reject) => {
      const path = `${dir}/${name}`;
      pending.push({
        path,
        content,
        land: () => { disk.set(path, content); resolve(); },
        fail: (e) => reject(e),
      });
    }));
    useLoreStore.setState({
      selectedEntity: AVA, selectedFile: "index.md", fileContent: "", isDirty: false, saveTimer: null,
    });
  });

  afterEach(() => {
    const { saveTimer } = useLoreStore.getState();
    if (saveTimer) clearTimeout(saveTimer);
    h.writeEntityFile.mockReset();
    h.writeEntityFile.mockImplementation(async () => {});
    vi.useRealTimers();
  });

  /** Land whatever write is in flight, newest first, until none is left. */
  async function landNewestFirst(): Promise<void> {
    for (;;) {
      await vi.advanceTimersByTimeAsync(0);
      const w = pending.pop();
      if (!w) return;
      w.land();
    }
  }

  it("the later-started save lands last even when its write would finish first", async () => {
    useLoreStore.getState().setFileContent("A");
    const timerSave = useLoreStore.getState().saveNow(); // e.g. the 2s timer
    useLoreStore.getState().setFileContent("AB");
    const manualSave = useLoreStore.getState().saveNow(); // e.g. selectFile's flush

    await landNewestFirst();
    await Promise.all([timerSave, manualSave]);

    expect(disk.get(`${AVA.dirPath}/index.md`)).toBe("AB");
    expect(useLoreStore.getState().isDirty).toBe(false);
    expect(useLoreStore.getState().saveTimer).toBeNull();
  });

  it("a failed earlier write doesn't hold up the one queued behind it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useLoreStore.getState().setFileContent("A");
    const first = useLoreStore.getState().saveNow();
    useLoreStore.getState().setFileContent("AB");
    const second = useLoreStore.getState().saveNow();

    await vi.advanceTimersByTimeAsync(0);
    pending.shift()!.fail(new Error("transient"));
    await expect(first).rejects.toThrow("transient");
    await landNewestFirst();
    await second;

    expect(disk.get(`${AVA.dirPath}/index.md`)).toBe("AB");
    expect(useLoreStore.getState().isDirty).toBe(false);
  });

  it("another entry's index.md is its own chain — it doesn't wait behind this one", async () => {
    useLoreStore.getState().setFileContent("A");
    const avaSave = useLoreStore.getState().saveNow();
    useLoreStore.setState({ selectedEntity: BEN });
    useLoreStore.getState().setFileContent("B");
    const benSave = useLoreStore.getState().saveNow();

    // Both writes are under way at once: same filename, different entries.
    expect(pending.map((w) => w.path)).toEqual([`${AVA.dirPath}/index.md`, `${BEN.dirPath}/index.md`]);
    await landNewestFirst();
    await Promise.all([avaSave, benSave]);
    expect(disk.get(`${AVA.dirPath}/index.md`)).toBe("A");
    expect(disk.get(`${BEN.dirPath}/index.md`)).toBe("B");
  });
});

describe("loreStore.selectEntity / selectFile — flush on isDirty, not on a live timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.writeEntityFile.mockReset();
    h.writeEntityFile.mockImplementation(async () => {});
    useLoreStore.setState({
      selectedEntity: AVA, selectedFile: "index.md", fileContent: "", isDirty: false, saveTimer: null,
    });
  });
  afterEach(() => {
    const { saveTimer } = useLoreStore.getState();
    if (saveTimer) clearTimeout(saveTimer);
    vi.useRealTimers();
  });

  it("an edit whose autosave failed is retried before switching, not dropped", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.writeEntityFile.mockRejectedValueOnce(new Error("locked"));
    useLoreStore.getState().setFileContent("A");
    await vi.advanceTimersByTimeAsync(2500); // the autosave fires and fails

    // Failed: still dirty, but no timer left to say so.
    expect(useLoreStore.getState().isDirty).toBe(true);
    expect(useLoreStore.getState().saveTimer).toBeNull();

    await useLoreStore.getState().selectEntity(BEN);

    // The failed autosave, then the retry — not just the one that failed.
    expect(h.writeEntityFile).toHaveBeenCalledTimes(2);
    expect(h.writeEntityFile).toHaveBeenLastCalledWith(AVA.dirPath, "index.md", "A");
  });

  it("selectFile retries the same way", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.writeEntityFile.mockRejectedValueOnce(new Error("locked"));
    useLoreStore.getState().setFileContent("A");
    await vi.advanceTimersByTimeAsync(2500);

    await useLoreStore.getState().selectFile("look.md");

    expect(h.writeEntityFile).toHaveBeenCalledTimes(2);
    expect(h.writeEntityFile).toHaveBeenLastCalledWith(AVA.dirPath, "index.md", "A");
  });
});
