import { describe, expect, it } from "vitest";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createViewportCache, type ViewportDocument } from "../viewport";

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
