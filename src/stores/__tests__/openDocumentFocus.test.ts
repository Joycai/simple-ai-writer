/**
 * whenFocusSettles() —— 一个手势里既打开文件又发一轮对话时，等缓冲区追上。
 *
 * `setActiveFilePath` 是同步的，编辑器的载入是提交后的 effect；中间发出的那一轮
 * 取到的焦点是点击前的那一篇。这里钉的是它的三条：已经是那一篇就立刻回 ·
 * 缓冲区追上就回 true · 超时、载入失败、作者转头打开或关掉了别的就回 false。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../appStore", () => ({
  useAppStore: { getState: () => ({}) },
}));
vi.mock("../../lib/fs/fileio", () => ({
  readFile: vi.fn(async () => "content"),
  writeFile: vi.fn(async () => {}),
}));

import { useEditorStore } from "../editorStore";
import { whenFocusSettles } from "../openDocument";
import { useProjectStore } from "../projectStore";

const NOTE = "/proj/卷一/index.md";
const OLD = "/proj/卷一/第3章.md";

function buffer(path: string | null) {
  useEditorStore.setState({
    content: "正文", filePath: path, headings: [], isDirty: false,
    saveTimer: null, loadError: null, crumbTrace: null,
  });
}

describe("whenFocusSettles", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    buffer(OLD);
    useProjectStore.setState({ activeFilePath: NOTE });
  });
  afterEach(() => vi.useRealTimers());

  it("resolves at once when the editor already holds the file", async () => {
    buffer(NOTE);
    await expect(whenFocusSettles(NOTE)).resolves.toBe(true);
  });

  it("resolves true once the editor catches up", async () => {
    const p = whenFocusSettles(NOTE);
    buffer(NOTE);
    await expect(p).resolves.toBe(true);
  });

  it("gives up after the timeout with the old document still in the buffer", async () => {
    const p = whenFocusSettles(NOTE, 1000);
    vi.advanceTimersByTime(1000);
    await expect(p).resolves.toBe(false);
  });

  it("gives up when the author opens something else in the meantime", async () => {
    const p = whenFocusSettles(NOTE);
    useProjectStore.setState({ activeFilePath: "/proj/卷二/第1章.md" });
    await expect(p).resolves.toBe(false);
  });

  it("gives up at once when the document is closed or deleted, not after the timeout", async () => {
    const p = whenFocusSettles(NOTE);
    useProjectStore.setState({ activeFilePath: null });
    await expect(p).resolves.toBe(false);
  });

  it("gives up at once when the load of that file fails", async () => {
    const p = whenFocusSettles(NOTE);
    useEditorStore.setState({ loadError: { path: NOTE, message: "not utf-8" } });
    await expect(p).resolves.toBe(false);
  });

  it("ignores a load error left behind by an earlier attempt on the same file", async () => {
    useEditorStore.setState({ loadError: { path: NOTE, message: "earlier" } });
    const p = whenFocusSettles(NOTE);
    useEditorStore.setState({ wordCount: 3 });
    buffer(NOTE);
    await expect(p).resolves.toBe(true);
  });

  it("is over before it starts when nobody opened that file", async () => {
    useProjectStore.setState({ activeFilePath: OLD });
    await expect(whenFocusSettles(NOTE)).resolves.toBe(false);
  });
});
