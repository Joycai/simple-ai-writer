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

vi.mock("../../stores/appStore", () => ({
  useAppStore: { getState: () => ({}) },
}));

const h = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string) => "content"),
  writeFile: vi.fn(async (_path: string, _content: string) => {}),
}));
vi.mock("../fs/fileio", () => ({
  readFile: h.readFile,
  writeFile: h.writeFile,
}));

import { useEditorStore } from "../../stores/editorStore";

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
});
