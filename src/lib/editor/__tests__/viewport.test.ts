import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterViewportRestore, createViewportCache, type ViewportDocument } from "../viewport";

const doc: ViewportDocument = { filePath: "/project/a.md", content: "one\ntwo", viewportRevision: 1 };
const viewport = { selection: EditorSelection.single(4, 7), scroll: EditorView.scrollIntoView(4) as ReturnType<EditorView["scrollSnapshot"]> };

describe("open document viewport", () => {
  it("retains selection and scroll independently of the live view", () => {
    const cache = createViewportCache();
    cache.sync(doc);
    cache.saveEditor(doc, viewport);
    cache.savePreview(doc, { top: 1200, left: 30 });
    cache.sync({ ...doc });
    expect(cache.editor(doc, null)).toBe(viewport);
    expect(cache.preview(doc, null)).toEqual({ top: 1200, left: 30 });
  });

  it.each([
    { ...doc, filePath: "/project/b.md" },
    { ...doc, content: "changed" },
    { ...doc, viewportRevision: 2 },
    { ...doc, filePath: null, content: "" },
  ])("rejects old capture/restore after a document boundary: %j", (next) => {
    const cache = createViewportCache();
    cache.sync(doc);
    cache.saveEditor(doc, viewport);
    cache.savePreview(doc, { top: 1200, left: 0 });
    cache.sync(next);
    // A late cleanup must not install the old snapshot in the new session.
    cache.saveEditor(doc, viewport);
    cache.savePreview(doc, { top: 1200, left: 0 });
    expect(cache.editor(next, null)).toBeUndefined();
    expect(cache.preview(next, null)).toBeUndefined();
    expect(cache.editor(doc, null)).toBeUndefined();
    cache.sync(doc);
    expect(cache.editor(doc, null)).toBeUndefined();
  });

  it("retires preview restoration on user input without losing the editor snapshot", () => {
    const cache = createViewportCache();
    cache.sync(doc);
    cache.saveEditor(doc, viewport);
    cache.savePreview(doc, { top: 1200, left: 0 });
    cache.clearPreview();
    cache.sync({ ...doc }); // a render/theme update must not revive it
    expect(cache.preview(doc, null)).toBeUndefined();
    expect(cache.editor(doc, null)).toBe(viewport);
  });

  it("explicit jumps override both snapshots, including delayed preview layout", () => {
    const cache = createViewportCache();
    cache.sync(doc);
    cache.saveEditor(doc, viewport);
    cache.savePreview(doc, { top: 1200, left: 0 });
    expect(cache.editor(doc, 2)).toBeUndefined();
    expect(cache.preview(doc, 2)).toBeUndefined();
    cache.clear();
    // A jump may already have been consumed by the time images finish loading.
    expect(cache.editor(doc, null)).toBeUndefined();
    expect(cache.preview(doc, null)).toBeUndefined();
  });
});


describe("restoration before split synchronization", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fixture() {
    let measured: (() => void) | undefined;
    let nextFrame: (() => void) | undefined;
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => { nextFrame = callback; return 7; });
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const view = {
      requestMeasure(request: Parameters<EditorView["requestMeasure"]>[0]) {
        measured = () => request?.write?.(null, view as EditorView);
      },
    };
    const disconnect = vi.fn();
    const connect = vi.fn(() => disconnect);
    const stop = afterViewportRestore(view, connect);
    return { connect, disconnect, stop, cancel, measure: () => measured?.(), frame: () => nextFrame?.() };
  }

  it("ignores intermediate restoration positions and connects after measurement and scroll delivery", () => {
    const f = fixture();
    expect(f.connect).not.toHaveBeenCalled();
    f.measure();
    expect(f.connect).not.toHaveBeenCalled();
    f.frame();
    expect(f.connect).toHaveBeenCalledOnce();
    f.stop();
    expect(f.disconnect).toHaveBeenCalledOnce();
  });

  it("cannot reconnect after leaving before measurement", () => {
    const f = fixture();
    f.stop();
    f.measure();
    f.frame();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("cancels a measured but not yet connected restoration", () => {
    const f = fixture();
    f.measure();
    f.stop();
    expect(f.cancel).toHaveBeenCalledWith(7);
    f.frame(); // Even a callback already queued for delivery is harmless.
    expect(f.connect).not.toHaveBeenCalled();
  });
});
