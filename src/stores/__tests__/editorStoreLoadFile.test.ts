/**
 * editorStore.loadFile — a failed read must not become a writable empty
 * document (Phase 4 fix). Before this, a read failure set `filePath` to the
 * path that failed alongside `content: ""`; the next keystroke would then
 * schedule a normal autosave that overwrote the real file with near-nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// editorStore -> projectStore -> appStore, which reads localStorage at
// module load; the test environment is node.
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

import { editorViewport, useEditorStore } from "../editorStore";

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

/**
 * Switching files while the author is still typing into the old one. The old
 * document stays mounted and editable until loadFile's `set()`, so a keystroke
 * during the read or during the flush lands in the old buffer; it used to be
 * replaced by the new file's text without ever being written.
 */
describe("editorStore.loadFile — typing during a switch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useEditorStore.setState({
      content: "", filePath: "/proj/writing/a.md", headings: [], isDirty: false,
      saveTimer: null, loadError: null,
    });
    h.writeFile.mockClear();
    h.readFile.mockClear();
  });

  afterEach(() => {
    const { saveTimer } = useEditorStore.getState();
    if (saveTimer) clearTimeout(saveTimer);
    vi.useRealTimers();
  });

  it("writes a keystroke typed into the old document while the new one is being read", async () => {
    let finishRead!: (text: string) => void;
    h.readFile.mockImplementationOnce(() => new Promise<string>((r) => { finishRead = r; }));

    useEditorStore.getState().setContent("A");
    const switching = useEditorStore.getState().loadFile("/proj/writing/b.md");
    useEditorStore.getState().setContent("AB"); // typed into a.md mid-switch
    finishRead("b text");
    await switching;

    expect(h.writeFile).toHaveBeenLastCalledWith("/proj/writing/a.md", "AB");
    const state = useEditorStore.getState();
    expect(state.filePath).toBe("/proj/writing/b.md");
    expect(state.content).toBe("b text");
    expect(state.isDirty).toBe(false);
    expect(state.saveTimer).toBeNull();

    // Nothing left armed to write anything later.
    const writes = h.writeFile.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2500);
    expect(h.writeFile).toHaveBeenCalledTimes(writes);
  });

  it("writes a keystroke typed while the old document's flush is on its way to disk", async () => {
    let finishWrite!: () => void;
    h.writeFile.mockImplementationOnce(() => new Promise<void>((r) => { finishWrite = r; }));
    h.readFile.mockResolvedValueOnce("b text");

    useEditorStore.getState().setContent("A");
    const switching = useEditorStore.getState().loadFile("/proj/writing/b.md");
    await vi.waitFor(() => expect(h.writeFile).toHaveBeenCalledWith("/proj/writing/a.md", "A"));
    useEditorStore.getState().setContent("AB"); // typed while "A" is being written
    finishWrite();
    await switching;

    expect(h.writeFile.mock.calls).toEqual([
      ["/proj/writing/a.md", "A"],
      ["/proj/writing/a.md", "AB"],
    ]);
    expect(useEditorStore.getState().filePath).toBe("/proj/writing/b.md");
    expect(useEditorStore.getState().content).toBe("b text");
    expect(useEditorStore.getState().isDirty).toBe(false);
  });

  it("a failed flush leaves the old document open, dirty, and unswitched", async () => {
    h.writeFile.mockRejectedValueOnce(new Error("disk full"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    useEditorStore.getState().setContent("A");
    await expect(useEditorStore.getState().loadFile("/proj/writing/b.md")).rejects.toThrow("disk full");

    const state = useEditorStore.getState();
    expect(state.filePath).toBe("/proj/writing/a.md");
    expect(state.content).toBe("A");
    expect(state.isDirty).toBe(true);
  });

  it("a reload of the same path discards the buffer and cancels a timer armed during the read", async () => {
    let finishRead!: (text: string) => void;
    h.readFile.mockImplementationOnce(() => new Promise<string>((r) => { finishRead = r; }));

    const reloading = useEditorStore.getState().loadFile("/proj/writing/a.md");
    useEditorStore.getState().setContent("typed during the reload");
    finishRead("as it stands on disk");
    await reloading;

    expect(useEditorStore.getState().content).toBe("as it stands on disk");
    expect(useEditorStore.getState().saveTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(2500);
    expect(h.writeFile).not.toHaveBeenCalled();
  });

  it("the same file spelled differently is a reload too — not read, then flushed over", async () => {
    h.readFile.mockResolvedValueOnce("as it stands on disk");
    useEditorStore.getState().setContent("typed");

    // What relinkAssets passes is whatever `isSamePath` matched, not
    // necessarily the buffer's exact string.
    await useEditorStore.getState().loadFile("/proj/writing/./a.md");

    expect(h.writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().content).toBe("as it stands on disk");
    expect(useEditorStore.getState().isDirty).toBe(false);
  });
});


describe("editor viewport lifecycle", () => {
  const doc = { filePath: "/proj/a.md", content: "same", isDirty: false, saveTimer: null };
  it("invalidates even an identical reload and rejects late cleanup", async () => {
    useEditorStore.setState(doc);
    const before = useEditorStore.getState();
    editorViewport.savePreview(before, { top: 900, left: 0 });
    h.readFile.mockResolvedValueOnce("same");
    await before.loadFile(doc.filePath);
    const after = useEditorStore.getState();
    expect(after.viewportRevision).toBeGreaterThan(before.viewportRevision);
    editorViewport.savePreview(before, { top: 900, left: 0 });
    expect(editorViewport.preview(after, null)).toBeUndefined();
  });

  it("clears on the buffer reset used by close and project reset", () => {
    useEditorStore.setState(doc);
    const before = useEditorStore.getState();
    editorViewport.savePreview(before, { top: 900, left: 0 });
    useEditorStore.setState({ content: "", filePath: null });
    editorViewport.savePreview(before, { top: 900, left: 0 });
    useEditorStore.setState(doc);
    expect(editorViewport.preview(useEditorStore.getState(), null)).toBeUndefined();
  });

  it("clears both remembered positions when navigation requests a line", () => {
    useEditorStore.setState({ ...doc, scrollToLine: null });
    const before = useEditorStore.getState();
    editorViewport.savePreview(before, { top: 900, left: 0 });
    before.jumpToLine(2);
    const jump = vi.fn();
    useEditorStore.getState().setScrollToLine(jump);
    expect(jump).toHaveBeenCalledWith(1);
    expect(editorViewport.preview(useEditorStore.getState(), null)).toBeUndefined();
    useEditorStore.getState().setScrollToLine(null);
  });
});
