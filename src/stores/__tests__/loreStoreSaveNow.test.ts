/**
 * loreStore.saveNow — settling after the async write must describe the state
 * *after* it, the same rule editorStore.saveNow follows
 * (docs/feature/html-artifact-plan.md D5): a keystroke mid-write stays dirty
 * and its newly armed timer stays tracked; the write only ever cleans what it
 * wrote, never a reload of the same file or another file's edits.
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
