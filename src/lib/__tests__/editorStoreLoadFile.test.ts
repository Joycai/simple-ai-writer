/**
 * editorStore.loadFile — a failed read must not become a writable empty
 * document (Phase 4 fix). Before this, a read failure set `filePath` to the
 * path that failed alongside `content: ""`; the next keystroke would then
 * schedule a normal autosave that overwrote the real file with near-nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// editorStore -> projectStore -> appStore, which reads localStorage at
// module load; the test environment is node.
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

describe("editorStore.loadFile — failed read", () => {
  beforeEach(() => {
    useEditorStore.setState({
      content: "", filePath: null, headings: [], isDirty: false, saveTimer: null, loadError: null,
    });
    h.writeFile.mockClear();
  });

  afterEach(() => {
    const { saveTimer } = useEditorStore.getState();
    if (saveTimer) clearTimeout(saveTimer);
  });

  it("leaves filePath null and records loadError, instead of attaching the failed path to empty content", async () => {
    h.readFile.mockRejectedValueOnce(new Error("invalid utf-8"));

    await useEditorStore.getState().loadFile("/proj/writing/broken.md");

    const state = useEditorStore.getState();
    expect(state.filePath).toBeNull();
    expect(state.content).toBe("");
    expect(state.loadError).toEqual({ path: "/proj/writing/broken.md", message: "Error: invalid utf-8" });
  });

  it("never schedules an autosave after a failed load, even if setContent is called", async () => {
    h.readFile.mockRejectedValueOnce(new Error("invalid utf-8"));
    await useEditorStore.getState().loadFile("/proj/writing/broken.md");

    // Whatever UI still lets the author type — setContent must not be able
    // to arm a save timer without a real filePath to write to.
    useEditorStore.getState().setContent("whatever got typed");
    expect(useEditorStore.getState().saveTimer).toBeNull();

    await useEditorStore.getState().saveNow();
    expect(h.writeFile).not.toHaveBeenCalled();
  });

  it("clears a previous loadError on a successful load", async () => {
    h.readFile.mockRejectedValueOnce(new Error("boom"));
    await useEditorStore.getState().loadFile("/proj/writing/broken.md");
    expect(useEditorStore.getState().loadError).not.toBeNull();

    h.readFile.mockResolvedValueOnce("real text");
    await useEditorStore.getState().loadFile("/proj/writing/ok.md");

    const state = useEditorStore.getState();
    expect(state.loadError).toBeNull();
    expect(state.filePath).toBe("/proj/writing/ok.md");
    expect(state.content).toBe("real text");
  });
});
