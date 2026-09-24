/**
 * editorStore.saveNow — must cancel the real pending timer, not just the
 * `saveTimer` state field that mirrors it (Phase 4 fix). projectStore's
 * moveEntry calls editor.saveNow() directly to flush before a rename,
 * without clearing the timer first; without this fix the still-armed
 * setTimeout fires later regardless, writing stale content to wherever
 * `filePath` has drifted to by then — e.g. recreating a just-moved file at
 * its old location.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../appStore", () => ({
  useAppStore: { getState: () => ({}) },
}));

const h = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string) => "content"),
  writeFile: vi.fn(async (_path: string, _content: string) => {}),
}));
vi.mock("../../lib/fs/fileio", () => ({
  readFile: h.readFile,
  writeFile: h.writeFile,
}));

import { useEditorStore } from "../editorStore";

describe("editorStore.saveNow — cancels the real timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useEditorStore.setState({
      content: "", filePath: "/proj/writing/a.md", headings: [], isDirty: false,
      saveTimer: null, loadError: null,
    });
    h.writeFile.mockClear();
  });

  afterEach(() => {
    const { saveTimer } = useEditorStore.getState();
    if (saveTimer) clearTimeout(saveTimer);
    vi.useRealTimers();
  });

  it("a manual saveNow (called without pre-clearing) stops the debounce timer from firing again later", async () => {
    useEditorStore.getState().setContent("hello"); // arms the real 2s timer
    expect(useEditorStore.getState().saveTimer).not.toBeNull();

    // Flush immediately, the way moveEntry does — no clearTimeout beforehand.
    await useEditorStore.getState().saveNow();
    expect(h.writeFile).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().saveTimer).toBeNull();

    // Advance past the original 2s debounce. If the real timer were still
    // armed, its callback would call saveNow() again here.
    await vi.advanceTimersByTimeAsync(2500);
    expect(h.writeFile).toHaveBeenCalledTimes(1);
  });

  it("a keystroke during the write keeps the buffer dirty and its new timer tracked", async () => {
    // Hold the write open so the author can type while it is in flight.
    let finish!: () => void;
    h.writeFile.mockImplementationOnce(() => new Promise<void>((r) => { finish = r; }));

    useEditorStore.getState().setContent("A");
    const saving = useEditorStore.getState().saveNow(); // writes "A"
    useEditorStore.getState().setContent("AB");         // typed mid-write
    const newTimer = useEditorStore.getState().saveTimer;
    expect(newTimer).not.toBeNull();

    finish();
    await saving;

    // "AB" never reached disk: still dirty, and the timer that will write it
    // is still the one on record (not orphaned as null).
    expect(useEditorStore.getState().isDirty).toBe(true);
    expect(useEditorStore.getState().saveTimer).toBe(newTimer);

    await vi.advanceTimersByTimeAsync(2500);
    expect(h.writeFile).toHaveBeenLastCalledWith("/proj/writing/a.md", "AB");
    expect(useEditorStore.getState().isDirty).toBe(false);
    expect(useEditorStore.getState().saveTimer).toBeNull();
  });

  it("an unchanged buffer settles clean", async () => {
    useEditorStore.getState().setContent("same");
    await useEditorStore.getState().saveNow();
    expect(useEditorStore.getState().isDirty).toBe(false);
  });
});
